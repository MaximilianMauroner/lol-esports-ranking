import { compareCodeUnits } from './codeUnitOrder.mjs'
/** Offline replay of observed Worlds Swiss results. No draw or match is generated here. */
export const WORLDS_2025_SWISS_RULES = {
  id: 'worlds-2025-swiss-observed-v1',
  source: 'https://lolesports.com/en-US/news/worlds-2025-primer',
  sourceSections: ['SWISS STAGE DRAWS', 'Round 1', 'Swiss Rounds 2–5', 'The Knockout Draw'],
  entrants: 16,
  winsToAdvance: 3,
  lossesToEliminate: 3,
  knockoutSlots: 8,
} as const

export type SwissEntrant = {
  id: string
  region: string
  /** Observed 2025 draw tier, from a separately verified entrant/seed source. */
  tier: 1 | 2 | 3
}

export type ObservedSwissMatch = {
  id: string
  teamAId: string
  teamBId: string
  winnerId: string
}

/** Caller supplied provenance; `source-observation` does not imply official verification. */
export type ObservationEvidence = {
  kind: 'synthetic-fixture' | 'source-observation'
  reference: string
}

export type SwissTeamStanding = {
  id: string
  wins: number
  losses: number
  status: 'active' | 'advanced' | 'eliminated'
  opponents: string[]
}

export type SwissReplayResult =
  | {
    status: 'supported'
    rulesId: typeof WORLDS_2025_SWISS_RULES.id
    source: typeof WORLDS_2025_SWISS_RULES.source
    observationEvidence: { entrants: ObservationEvidence; matches: ObservationEvidence | null }
    completedRounds: number
    standings: SwissTeamStanding[]
    /** A forecast still requires certified draw probabilities and model inputs. */
    forecast: { status: 'unsupported'; reason: 'draw-procedure-or-model-unavailable' }
  }
  | {
    status: 'unsupported'
    reason: 'rules-unavailable' | 'entrant-evidence-missing' | 'match-evidence-missing' | 'invalid-entrants' | 'invalid-observation' | 'incomplete-round'
    detail: string
  }

type MutableStanding = SwissTeamStanding & { opponentsSet: Set<string> }

/**
 * Replays complete, observed rounds only. Input identities and tiers are supplied by
 * the caller; the function makes no claim that they came from the official feed.
 * Unsupported or contradictory inputs never produce a partial official-looking state.
 */
export function replayWorldsSwiss(input: {
  season: number
  entrants: SwissEntrant[]
  entrantEvidence?: ObservationEvidence
  matchEvidence?: ObservationEvidence
  rounds: ObservedSwissMatch[][]
}): SwissReplayResult {
  if (input.season !== 2025) {
    return unsupported('rules-unavailable', `No certified observed Swiss replay rules for Worlds ${input.season}`)
  }
  if (!validEvidence(input.entrantEvidence)) {
    return unsupported('entrant-evidence-missing', 'Entrant identities and draw tiers need an evidence reference')
  }
  if ((input.rounds.length > 0 || input.matchEvidence !== undefined) && !validEvidence(input.matchEvidence)) {
    return unsupported('match-evidence-missing', 'Observed matches and winners need an evidence reference')
  }
  const entrantError = validateEntrants(input.entrants)
  if (entrantError) return unsupported('invalid-entrants', entrantError)
  if (input.rounds.length > 5) return unsupported('invalid-observation', 'Swiss has at most five rounds')

  const entrants = new Map(input.entrants.map((entrant) => [entrant.id, { ...entrant, region: canonicalRegion(entrant.region) }]))
  const standings = new Map<string, MutableStanding>(input.entrants.map((entrant) => [entrant.id, {
    id: entrant.id,
    wins: 0,
    losses: 0,
    status: 'active',
    opponents: [],
    opponentsSet: new Set<string>(),
  }]))
  const matchIds = new Set<string>()

  for (const [roundIndex, round] of input.rounds.entries()) {
    const active = [...standings.values()].filter((team) => team.status === 'active')
    if (active.length === 0) return unsupported('invalid-observation', 'Matches follow a completed Swiss stage')
    if (round.length !== active.length / 2) {
      return unsupported('incomplete-round', `Round ${roundIndex + 1} requires ${active.length / 2} matches`)
    }
    const seen = new Set<string>()
    // Validate the entire round against its starting state before applying results.
    for (const match of round) {
      const a = standings.get(match.teamAId)
      const b = standings.get(match.teamBId)
      if (!match.id?.trim() || matchIds.has(match.id)) return unsupported('invalid-observation', 'Duplicate or blank match ID')
      if (!a || !b || a === b || a.status !== 'active' || b.status !== 'active') {
        return unsupported('invalid-observation', `Invalid participants in round ${roundIndex + 1}`)
      }
      if (seen.has(a.id) || seen.has(b.id)) return unsupported('invalid-observation', 'A team appears twice in one round')
      if (match.winnerId !== a.id && match.winnerId !== b.id) return unsupported('invalid-observation', 'Winner is not a participant')
      if (roundIndex === 0) {
        const tiers = [entrants.get(a.id)?.tier, entrants.get(b.id)?.tier].sort().join('-')
        if (tiers !== '1-3' && tiers !== '2-2') return unsupported('invalid-observation', 'Round 1 must pair tier 1–3 or tier 2–2')
        if (entrants.get(a.id)?.region === entrants.get(b.id)?.region) {
          return unsupported('invalid-observation', 'Round 1 same-region pairing')
        }
      } else {
        if (a.wins !== b.wins || a.losses !== b.losses) {
          return unsupported('invalid-observation', 'Later Swiss rounds pair equal records')
        }
        if (a.opponentsSet.has(b.id)) return unsupported('invalid-observation', 'Swiss rematch')
      }
      seen.add(a.id)
      seen.add(b.id)
      matchIds.add(match.id)
    }
    if (seen.size !== active.length) return unsupported('incomplete-round', 'A Swiss round must include every active team once')
    for (const match of round) {
      const a = standings.get(match.teamAId)!
      const b = standings.get(match.teamBId)!
      const winner = match.winnerId === a.id ? a : b
      const loser = winner === a ? b : a
      winner.wins += 1
      loser.losses += 1
      a.opponentsSet.add(b.id)
      b.opponentsSet.add(a.id)
      if (winner.wins === 3) winner.status = 'advanced'
      if (loser.losses === 3) loser.status = 'eliminated'
    }
  }

  const values = [...standings.values()]
  if (input.rounds.length === 5 && values.some((team) => team.status === 'active')) {
    return unsupported('invalid-observation', 'Active teams remain after five rounds')
  }
  if (values.filter((team) => team.status === 'advanced').length > 8) {
    return unsupported('invalid-observation', 'More than eight Swiss teams advanced')
  }
  return {
    status: 'supported',
    rulesId: WORLDS_2025_SWISS_RULES.id,
    source: WORLDS_2025_SWISS_RULES.source,
    observationEvidence: {
      entrants: copyEvidence(input.entrantEvidence),
      matches: input.matchEvidence ? copyEvidence(input.matchEvidence) : null,
    },
    completedRounds: input.rounds.length,
    standings: values.map(({ opponentsSet, ...team }) => ({
      ...team,
      opponents: [...opponentsSet].sort(),
    })).sort((a, b) => compareCodeUnits(a.id, b.id)),
    forecast: { status: 'unsupported', reason: 'draw-procedure-or-model-unavailable' },
  }
}

function validateEntrants(entrants: SwissEntrant[]): string | undefined {
  if (entrants.length !== 16) return 'Worlds 2025 Swiss needs 16 identified entrants'
  const ids = new Set<string>()
  const tiers = [0, 0, 0, 0]
  for (const entrant of entrants) {
    if (!entrant.id?.trim() || !entrant.region?.trim() || ids.has(entrant.id)) return 'Blank or duplicate entrant identity/region'
    if (!['LCK', 'LPL', 'LEC', 'LTA', 'LCP'].includes(canonicalRegion(entrant.region))) return 'Unknown 2025 region'
    if (entrant.tier !== 1 && entrant.tier !== 2 && entrant.tier !== 3) return 'Unknown draw tier'
    ids.add(entrant.id)
    tiers[entrant.tier] += 1
  }
  if (tiers[1] !== 5 || tiers[2] !== 6 || tiers[3] !== 5) return 'Worlds 2025 round 1 requires tier sizes 5/6/5'
}

function canonicalRegion(region: string) {
  return region.trim().toUpperCase()
}

function validEvidence(evidence: ObservationEvidence | undefined): evidence is ObservationEvidence {
  return !!evidence && (evidence.kind === 'synthetic-fixture' || evidence.kind === 'source-observation')
    && typeof evidence.reference === 'string' && evidence.reference.trim().length > 0
}

function copyEvidence(evidence: ObservationEvidence): ObservationEvidence {
  return { kind: evidence.kind, reference: evidence.reference.trim() }
}

function unsupported(reason: Extract<SwissReplayResult, { status: 'unsupported' }>['reason'], detail: string): SwissReplayResult {
  return { status: 'unsupported', reason, detail }
}
