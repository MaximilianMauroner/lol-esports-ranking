import { compareCodeUnits } from './codeUnitOrder.mjs'
import type { ObservationEvidence, SwissTeamStanding } from './worldsObservedRules'

export const WORLDS_2026_SWISS_RULES = {
  id: 'worlds-2026-swiss-observed-v1',
  source: 'https://cdn.sanity.io/files/dsfx7636/news_live/faa5ce974e58615911fbee931c6123e2785a8b46.pdf',
  sourceVersion: '1.0', checkedAt: '2026-10-09',
  sourceSha256: '3907cf8389be3a06ff895ce863fb02346d5c9eac9a025595a77793222aa35eab',
  clauses: ['4.1.2', '4.2.2', '4.3.2', '4.3.3'],
  pools: [
    ['LCK1', 'LPL1', 'LCS1', 'LEC1'],
    ['LCP1', 'CBLOL1', 'LCK2', 'LPL2'],
    ['LCS2', 'LEC2', 'LCK3', 'LPL3'],
    ['LCP2', 'LPL4', 'LCK4', 'PLAYIN'],
  ],
  drawUnavailable: 'Riot v1.0 §§4.3.2.3/4.3.3.2 do not specify slot displacement, look-ahead order or officials’ rematch-waiver choices. Future Swiss draw probabilities are unavailable; uniform legal matchings are not substituted.',
} as const

export type SwissSeed = typeof WORLDS_2026_SWISS_RULES.pools[number][number]
export type Worlds2026SwissEntrant = { id: string; seed: SwissSeed; region: string }
export type SwissResult = { slot: number; matchId: string; teamIds: [string, string]; gameWins: [number, number]; observedAt: string }
export type SwissRound = {
  round: number
  pairs: [string, string][]
  drawnAt: string
  drawEvidence: ObservationEvidence
  /** An observed official decision, never a simulated fallback. */
  rematchWaivers: Array<{ teamIds: [string, string]; evidence: ObservationEvidence }>
  results: SwissResult[]
}
export type Worlds2026SwissInput = {
  rulesId: string; eventId: string; stateVersion: string; asOf: string
  entrants: Worlds2026SwissEntrant[]
  evidence: { entrants: ObservationEvidence; results?: ObservationEvidence }
  rounds: SwissRound[]
}
export type WorldsUnavailable = { status: 'unsupported'; reason: 'rules-unavailable' | 'invalid-state' | 'evidence-missing' | 'model-unavailable' | 'draw-probabilities-unavailable'; detail: string }
export type SwissReplay = {
  status: 'supported'; rulesId: string; standings: SwissTeamStanding[]; completedRounds: number
  currentRound: number; readyMatches: Array<{ slot: number; teamIds: [string, string]; bestOf: 1 | 3 }>
  matches: Array<{ round: number; slot: number; teamIds: [string, string]; bestOf: 1 | 3; winnerId: string | null }>
}

export function worldsUnavailable(reason: WorldsUnavailable['reason'], detail: string): WorldsUnavailable {
  return { status: 'unsupported', reason, detail }
}
export function validWorldsTime(value: string) { return Boolean(value?.trim()) && Number.isFinite(Date.parse(value)) }
export function validWorldsEvidence(value: ObservationEvidence | undefined) {
  return Boolean(value && ['synthetic-fixture', 'source-observation'].includes(value.kind) && value.reference?.trim())
}
export function swissBestOf(standing: Pick<SwissTeamStanding, 'wins' | 'losses'>): 1 | 3 {
  return standing.wins === 2 || standing.losses === 2 ? 3 : 1
}
export function applySwissWinner(standings: SwissTeamStanding[], pair: [string, string], winnerId: string) {
  for (const id of pair) {
    const row = standings.find((team) => team.id === id)!
    if (id === winnerId) row.wins++
    else row.losses++
    row.opponents.push(pair.find((other) => other !== id)!)
    row.status = row.wins === 3 ? 'advanced' : row.losses === 3 ? 'eliminated' : 'active'
  }
}

/** Validates supplied draws; it deliberately does not generate an uncertified Swiss draw. */
export function replayWorlds2026Swiss(input: Worlds2026SwissInput): SwissReplay | WorldsUnavailable {
  if (input.rulesId !== WORLDS_2026_SWISS_RULES.id) return worldsUnavailable('rules-unavailable', 'Only the sourced 2026 Swiss descriptor is supported.')
  if (!input.eventId.trim() || !input.stateVersion.trim() || !validWorldsTime(input.asOf)) return worldsUnavailable('invalid-state', 'Dated event and state identities are required.')
  const expectedSeeds: readonly string[] = WORLDS_2026_SWISS_RULES.pools.flat()
  if (input.entrants.length !== 16 || new Set(input.entrants.map((team) => team.id)).size !== 16
    || new Set(input.entrants.map((team) => team.seed)).size !== 16
    || input.entrants.some((team) => !team.id.trim() || !expectedSeeds.includes(team.seed)
      || !team.region.trim() || (team.seed !== 'PLAYIN' && team.region !== team.seed.replace(/\d+$/, '')))) {
    return worldsUnavailable('invalid-state', 'All sixteen 2026 seeds, including the identified Play-In winner, are required with their regions.')
  }
  if (!validWorldsEvidence(input.evidence?.entrants)
    || (input.rounds.some((round) => round.results.length) && !validWorldsEvidence(input.evidence.results))) {
    return worldsUnavailable('evidence-missing', 'Entrant and result evidence are required.')
  }
  const standings: SwissTeamStanding[] = [...input.entrants].sort((a, b) => compareCodeUnits(a.id, b.id))
    .map(({ id }) => ({ id, wins: 0, losses: 0, status: 'active', opponents: [] }))
  const rounds = [...input.rounds].sort((a, b) => a.round - b.round)
  if (rounds.length > 5) return worldsUnavailable('invalid-state', 'Swiss has at most five rounds.')
  const matchIds = new Set<string>()
  let lastResultAt = -Infinity
  let completedRounds = 0
  let readyMatches: SwissReplay['readyMatches'] = []
  const matches: SwissReplay['matches'] = []
  for (const [index, round] of rounds.entries()) {
    if (round.round !== index + 1 || completedRounds !== index) return worldsUnavailable('invalid-state', 'Rounds must be consecutive and prior rounds complete.')
    const drawError = validateDraw(input, standings, round, lastResultAt)
    if (drawError) return drawError
    const results = new Map(round.results.map((result) => [result.slot, result]))
    if (results.size !== round.results.length || round.results.some((result) => !Number.isInteger(result.slot) || result.slot < 0 || result.slot >= round.pairs.length)) {
      return worldsUnavailable('invalid-state', 'Result slots must be unique members of the observed draw.')
    }
    readyMatches = []
    for (const [slot, pair] of round.pairs.entries()) {
      const bestOf = swissBestOf(standings.find((row) => row.id === pair[0])!)
      const result = results.get(slot)
      const match = { round: round.round, slot, teamIds: pair, bestOf, winnerId: null as string | null }
      matches.push(match)
      if (!result) { readyMatches.push({ slot, teamIds: [...pair], bestOf }); continue }
      const target = (bestOf + 1) / 2
      const [a, b] = result.gameWins
      if (!result.matchId.trim() || matchIds.has(result.matchId) || result.teamIds.length !== 2
        || new Set(result.teamIds).size !== 2 || !result.teamIds.every((id) => pair.includes(id))
        || result.gameWins.length !== 2 || ![a, b].every(Number.isInteger)
        || !((a === target && b >= 0 && b < target) || (b === target && a >= 0 && a < target))
        || !validWorldsTime(result.observedAt) || Date.parse(result.observedAt) < Date.parse(round.drawnAt)
        || Date.parse(result.observedAt) > Date.parse(input.asOf)) {
        return worldsUnavailable('invalid-state', `Invalid, future or nonterminal result for Swiss round ${round.round}, slot ${slot}. Live partial series are unavailable.`)
      }
      matchIds.add(result.matchId)
      lastResultAt = Math.max(lastResultAt, Date.parse(result.observedAt))
      applySwissWinner(standings, pair, result.teamIds[a === target ? 0 : 1])
      match.winnerId = result.teamIds[a === target ? 0 : 1]
    }
    if (!readyMatches.length) completedRounds++
  }
  return { status: 'supported', rulesId: input.rulesId, standings, completedRounds, currentRound: rounds.at(-1)?.round ?? 0, readyMatches, matches }
}

function validateDraw(input: Worlds2026SwissInput, standings: SwissTeamStanding[], round: SwissRound, lastResultAt: number): WorldsUnavailable | null {
  if (!validWorldsEvidence(round.drawEvidence) || round.rematchWaivers.some((waiver) => !validWorldsEvidence(waiver.evidence))) return worldsUnavailable('evidence-missing', 'Each draw and any official rematch waiver require evidence.')
  if (!validWorldsTime(round.drawnAt) || Date.parse(round.drawnAt) < lastResultAt || Date.parse(round.drawnAt) > Date.parse(input.asOf)) return worldsUnavailable('invalid-state', 'Draw timestamps must follow prior results and precede the cutoff.')
  const activeIds = standings.filter((team) => team.status === 'active').map((team) => team.id)
  const drawnIds = round.pairs.flat()
  if (drawnIds.length !== activeIds.length || new Set(drawnIds).size !== activeIds.length || drawnIds.some((id) => !activeIds.includes(id))
    || round.pairs.some((pair) => pair.length !== 2)) return worldsUnavailable('invalid-state', 'A draw must contain every active team exactly once.')
  const waiverKeys = round.rematchWaivers.map((waiver) => pairKey(waiver.teamIds))
  const rematchKeys: string[] = []
  for (const pair of round.pairs) {
    const [a, b] = pair.map((id) => standings.find((row) => row.id === id)!)
    if (a.wins !== b.wins || a.losses !== b.losses) return worldsUnavailable('invalid-state', 'Swiss opponents must have identical records before the round.')
    if (round.round === 1) {
      const [home, away] = pair.map((id) => input.entrants.find((team) => team.id === id)!)
      const pools = [home, away].map((team) => WORLDS_2026_SWISS_RULES.pools.findIndex((pool) => (pool as readonly string[]).includes(team.seed)))
      if (home.region === away.region || pools[0] + pools[1] !== 3) return worldsUnavailable('invalid-state', 'Round one requires Pool 1 vs 4 / Pool 2 vs 3 and distinct regions.')
    }
    if (a.opponents.includes(b.id)) rematchKeys.push(pairKey(pair))
  }
  if (new Set(waiverKeys).size !== waiverKeys.length || waiverKeys.some((key) => !rematchKeys.includes(key))
    || rematchKeys.some((key) => !waiverKeys.includes(key))) return worldsUnavailable('invalid-state', 'Repeated opponents need the exact observed official waiver; a simulator cannot choose it.')
  for (const pair of round.pairs.filter((pair) => rematchKeys.includes(pairKey(pair)))) {
    const team = standings.find((row) => row.id === pair[0])!
    const bucket = standings.filter((row) => row.status === 'active' && row.wins === team.wins && row.losses === team.losses)
    if (hasNonRematchPairing(bucket)) return worldsUnavailable('invalid-state', 'The cited rematch waiver applies only when no eligible draw exists in that record bucket.')
  }
  return null
}
function pairKey(pair: string[]) { return JSON.stringify([...pair].sort(compareCodeUnits)) }

/** Existence check only. Its paths are never used as a random draw distribution. */
function hasNonRematchPairing(teams: SwissTeamStanding[]): boolean {
  if (!teams.length) return true
  const [first, ...rest] = teams
  return rest.some((other, index) => !first.opponents.includes(other.id) && hasNonRematchPairing(rest.filter((_, otherIndex) => otherIndex !== index)))
}
