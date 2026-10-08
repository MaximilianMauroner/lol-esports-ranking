import { WORLDS_2025_SWISS_RULES, type ObservationEvidence, type ObservedSwissMatch, type SwissReplayResult } from './worldsObservedRules'
import { compareCodeUnits } from './codeUnitOrder.mjs'

export const WORLDS_2025_KNOCKOUT_RULES = {
  id: 'worlds-2025-knockout-observed-v1',
  source: 'https://lolesports.com/en-US/news/worlds-2025-primer',
  sourceSection: 'The Knockout Draw',
  slots: 8,
  bestOf: 5,
} as const

export type KnockoutTeamState = {
  id: string
  reached: 'quarterfinal' | 'semifinal' | 'final' | 'champion'
  eliminatedAt: 'quarterfinal' | 'semifinal' | 'final' | null
}

export type KnockoutReplayResult =
  | {
    status: 'supported'
    rulesId: typeof WORLDS_2025_KNOCKOUT_RULES.id
    source: typeof WORLDS_2025_KNOCKOUT_RULES.source
    observationEvidence: {
      swiss: { entrants: ObservationEvidence; matches: ObservationEvidence }
      draw: ObservationEvidence
      matches: ObservationEvidence | null
    }
    /** Ordered quarterfinal slot IDs. Winners keep these bracket links. */
    slots: string[]
    completedRounds: number
    teams: KnockoutTeamState[]
    championId: string | null
    forecast: { status: 'unsupported'; reason: 'draw-procedure-or-model-unavailable' }
  }
  | {
    status: 'unsupported'
    reason: 'swiss-unavailable' | 'draw-evidence-missing' | 'match-evidence-missing' | 'invalid-draw' | 'incomplete-round' | 'invalid-observation'
    detail: string
  }

type BracketRound = 'quarterfinals' | 'semifinals' | 'final'

/** Replays observed, complete knockout rounds on an observed immutable bracket. */
export function replayWorlds2025Knockout(input: {
  swiss: SwissReplayResult
  drawEvidence?: ObservationEvidence
  matchEvidence?: ObservationEvidence
  slots: string[]
  rounds: Partial<Record<BracketRound, ObservedSwissMatch[]>>
}): KnockoutReplayResult {
  if (input.swiss.status !== 'supported' || input.swiss.rulesId !== WORLDS_2025_SWISS_RULES.id || input.swiss.completedRounds !== 5) {
    return unsupported('swiss-unavailable', 'A complete supported Worlds 2025 Swiss replay is required')
  }
  if (!validEvidence(input.swiss.observationEvidence?.entrants) || !validEvidence(input.swiss.observationEvidence?.matches)) {
    return unsupported('swiss-unavailable', 'Swiss entrant and match provenance is required')
  }
  if (!validEvidence(input.drawEvidence)) return unsupported('draw-evidence-missing', 'Observed quarterfinal slots need a draw evidence reference')
  const hasResults = input.rounds.quarterfinals !== undefined || input.rounds.semifinals !== undefined || input.rounds.final !== undefined
  if ((hasResults || input.matchEvidence !== undefined) && !validEvidence(input.matchEvidence)) {
    return unsupported('match-evidence-missing', 'Observed knockout winners need an evidence reference')
  }
  if (input.swiss.standings.length !== 16 || new Set(input.swiss.standings.map((team) => team.id)).size !== 16
    || input.swiss.standings.some((team) => !team.id?.trim() || team.status === 'active'
      || team.status === 'eliminated' && team.losses !== 3)) {
    return unsupported('swiss-unavailable', 'Swiss handoff needs 16 distinct terminal team states')
  }
  const qualifierRows = input.swiss.standings.filter((team) => team.status === 'advanced')
  const records = [0, 0, 0]
  for (const team of qualifierRows) {
    if (team.wins !== 3 || team.losses < 0 || team.losses > 2) return unsupported('swiss-unavailable', 'Invalid qualifier record')
    records[team.losses] += 1
  }
  if (qualifierRows.length !== 8 || records.join(',') !== '2,3,3') {
    return unsupported('swiss-unavailable', 'Swiss must have 2/3/3 qualifiers and 16 entrants')
  }
  if (input.slots.length !== 8 || new Set(input.slots).size !== 8 || input.slots.some((id) => !id?.trim())) {
    return unsupported('invalid-draw', 'A fixed bracket needs eight distinct slot IDs')
  }
  const qualifierById = new Map(qualifierRows.map((team) => [team.id, team]))
  if (input.slots.some((id) => !qualifierById.has(id))) return unsupported('invalid-draw', 'A slot is not a Swiss qualifier')
  const undefeatedQuarterfinals: number[] = []
  for (let matchIndex = 0; matchIndex < 4; matchIndex += 1) {
    const a = qualifierById.get(input.slots[matchIndex * 2])!
    const b = qualifierById.get(input.slots[matchIndex * 2 + 1])!
    if (a.losses === 0 || b.losses === 0) {
      if (a.losses === 0 && b.losses === 0) return unsupported('invalid-draw', 'The 3-0 teams must draw 3-2 opponents')
      if (a.losses !== 2 && b.losses !== 2) return unsupported('invalid-draw', 'A 3-0 team must draw a 3-2 opponent')
      undefeatedQuarterfinals.push(matchIndex)
    }
  }
  if (undefeatedQuarterfinals.length !== 2 || Math.floor(undefeatedQuarterfinals[0] / 2) === Math.floor(undefeatedQuarterfinals[1] / 2)) {
    return unsupported('invalid-draw', 'The two 3-0 teams belong on opposite bracket halves')
  }

  const stage = new Map(input.slots.map((id) => [id, {
    id, reached: 'quarterfinal' as KnockoutTeamState['reached'], eliminatedAt: null as KnockoutTeamState['eliminatedAt'],
  }]))
  const usedMatchIds = new Set<string>()
  let field = [...input.slots]
  let completedRounds = 0
  for (const [roundName, nextReach] of [
    ['quarterfinals', 'semifinal'], ['semifinals', 'final'], ['final', 'champion'],
  ] as const) {
    const observations = input.rounds[roundName]
    if (observations === undefined) {
      if (roundName === 'quarterfinals' && (input.rounds.semifinals || input.rounds.final)
        || roundName === 'semifinals' && input.rounds.final) {
        return unsupported('incomplete-round', 'A later round requires all earlier rounds')
      }
      break
    }
    if (observations.length !== field.length / 2) {
      return unsupported('incomplete-round', `${roundName} needs ${field.length / 2} completed matches`)
    }
    const expected = Array.from({ length: field.length / 2 }, (_, index) => [field[index * 2], field[index * 2 + 1]] as const)
    const byPair = new Map<string, ObservedSwissMatch>()
    for (const match of observations) {
      if (!match.id?.trim() || usedMatchIds.has(match.id)) return unsupported('invalid-observation', 'Duplicate or blank match ID')
      const key = pairKey(match.teamAId, match.teamBId)
      if (match.teamAId === match.teamBId || byPair.has(key) || !expected.some(([a, b]) => pairKey(a, b) === key)) {
        return unsupported('invalid-observation', `Match is outside the fixed ${roundName} bracket links`)
      }
      if (match.winnerId !== match.teamAId && match.winnerId !== match.teamBId) {
        return unsupported('invalid-observation', 'Winner is not a bracket participant')
      }
      byPair.set(key, match)
      usedMatchIds.add(match.id)
    }
    field = expected.map(([a, b]) => {
      const match = byPair.get(pairKey(a, b))!
      const loserId = match.winnerId === a ? b : a
      stage.get(loserId)!.eliminatedAt = nextReach === 'semifinal' ? 'quarterfinal' : nextReach === 'final' ? 'semifinal' : 'final'
      stage.get(match.winnerId)!.reached = nextReach
      return match.winnerId
    })
    completedRounds += 1
  }
  return {
    status: 'supported',
    rulesId: WORLDS_2025_KNOCKOUT_RULES.id,
    source: WORLDS_2025_KNOCKOUT_RULES.source,
    observationEvidence: {
      swiss: {
        entrants: copyEvidence(input.swiss.observationEvidence.entrants),
        matches: copyEvidence(input.swiss.observationEvidence.matches),
      },
      draw: copyEvidence(input.drawEvidence),
      matches: input.matchEvidence ? copyEvidence(input.matchEvidence) : null,
    },
    slots: [...input.slots],
    completedRounds,
    teams: [...stage.values()].sort((a, b) => compareCodeUnits(a.id, b.id)),
    championId: completedRounds === 3 ? field[0] : null,
    forecast: { status: 'unsupported', reason: 'draw-procedure-or-model-unavailable' },
  }
}

function pairKey(a: string, b: string) {
  return [a, b].sort().join('\0')
}

function validEvidence(evidence: ObservationEvidence | null | undefined): evidence is ObservationEvidence {
  return !!evidence && (evidence.kind === 'synthetic-fixture' || evidence.kind === 'source-observation')
    && typeof evidence.reference === 'string' && evidence.reference.trim().length > 0
}

function copyEvidence(evidence: ObservationEvidence): ObservationEvidence {
  return { kind: evidence.kind, reference: evidence.reference.trim() }
}

function unsupported(reason: Extract<KnockoutReplayResult, { status: 'unsupported' }>['reason'], detail: string): KnockoutReplayResult {
  return { status: 'unsupported', reason, detail }
}
