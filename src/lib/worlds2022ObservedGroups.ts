/** Offline replay of complete, observed Worlds 2022 group results. No draw or match is generated. */
export const WORLDS_2022_GROUP_RULES = {
  id: 'worlds-2022-groups-observed-v1',
  source: 'https://lolesports.com/en-US/news/worlds-2022-primer',
  sourceSections: ['How are these teams split into their Groups?', 'Group Stage: October 7-10; October 13-16'],
  groups: 4,
  entrantsPerGroup: 4,
  gamesPerPair: 2,
  knockoutSlotsPerGroup: 2,
} as const

export type GroupObservationEvidence = {
  /** A caller's tag is provenance, not certification of an official feed. */
  kind: 'synthetic-fixture' | 'source-observation'
  reference: string
}

export type Worlds2022GroupEntrant = {
  id: string
  region: string
  pool: 'A' | 'B' | 'C' | 'play-in'
}

export type ObservedGroupGame = {
  id: string
  teamAId: string
  teamBId: string
  winnerId: string
}

export type GroupStanding = { id: string; wins: number; losses: number }

export type GroupReplayResult =
  | {
    status: 'supported'
    rulesId: typeof WORLDS_2022_GROUP_RULES.id
    source: typeof WORLDS_2022_GROUP_RULES.source
    groupId: 'A' | 'B' | 'C' | 'D'
    observationEvidence: { entrants: GroupObservationEvidence; games: GroupObservationEvidence }
    /** Sorted by wins, then ID solely for stable display. No tied placing is inferred. */
    standings: GroupStanding[]
    knockoutQualifierIds: string[]
    forecast: { status: 'unsupported'; reason: 'historical-model-inputs-unavailable' }
  }
  | {
    status: 'unsupported'
    reason: 'rules-unavailable' | 'entrant-evidence-missing' | 'game-evidence-missing'
      | 'invalid-entrants' | 'invalid-observation' | 'incomplete-group' | 'tiebreaker-rules-unavailable'
    detail: string
  }

/** Requires all 12 scheduled games before asserting either qualifier. */
export function replayWorlds2022Group(input: {
  season: number
  groupId: string
  entrants: Worlds2022GroupEntrant[]
  entrantEvidence?: GroupObservationEvidence
  gameEvidence?: GroupObservationEvidence
  games: ObservedGroupGame[]
}): GroupReplayResult {
  if (input.season !== 2022) return unsupported('rules-unavailable', `No certified group replay rules for Worlds ${input.season}`)
  if (!['A', 'B', 'C', 'D'].includes(input.groupId)) return unsupported('invalid-entrants', 'Group must be A, B, C, or D')
  if (!validEvidence(input.entrantEvidence)) return unsupported('entrant-evidence-missing', 'Observed group entrants need an evidence reference')
  if (!validEvidence(input.gameEvidence)) return unsupported('game-evidence-missing', 'Observed group games need an evidence reference')
  if (input.entrants.length !== 4) return unsupported('invalid-entrants', 'A group needs four identified entrants')
  const entrantIds = new Set<string>()
  const regions = new Set<string>()
  const pools = new Set<string>()
  for (const entrant of input.entrants) {
    if (typeof entrant.id !== 'string' || !entrant.id.trim() || entrantIds.has(entrant.id)) {
      return unsupported('invalid-entrants', 'Blank or duplicate entrant ID')
    }
    if (typeof entrant.region !== 'string' || !entrant.region.trim()) return unsupported('invalid-entrants', 'Blank region')
    const region = entrant.region.trim().toUpperCase()
    if (regions.has(region)) return unsupported('invalid-entrants', 'A group cannot contain two teams from the same region')
    if (!['A', 'B', 'C', 'play-in'].includes(entrant.pool) || pools.has(entrant.pool)) {
      return unsupported('invalid-entrants', 'A group needs one entrant from each direct pool and one Play-In qualifier')
    }
    entrantIds.add(entrant.id)
    regions.add(region)
    pools.add(entrant.pool)
  }
  if (input.games.length !== 12) return unsupported('incomplete-group', 'A four-team double round robin needs 12 observed games')

  const standings = new Map(input.entrants.map(({ id }) => [id, { id, wins: 0, losses: 0 }]))
  const gameIds = new Set<string>()
  const pairCounts = new Map<string, number>()
  for (const game of input.games) {
    if (typeof game.id !== 'string' || !game.id.trim() || gameIds.has(game.id)) {
      return unsupported('invalid-observation', 'Blank or duplicate game ID')
    }
    if (!entrantIds.has(game.teamAId) || !entrantIds.has(game.teamBId) || game.teamAId === game.teamBId) {
      return unsupported('invalid-observation', 'Game participants must be distinct group entrants')
    }
    if (game.winnerId !== game.teamAId && game.winnerId !== game.teamBId) {
      return unsupported('invalid-observation', 'Winner must be a game participant')
    }
    const pair = [game.teamAId, game.teamBId].sort().join('\u0000')
    const count = (pairCounts.get(pair) ?? 0) + 1
    if (count > 2) return unsupported('invalid-observation', 'A group pairing has more than two games')
    pairCounts.set(pair, count)
    gameIds.add(game.id)
    standings.get(game.winnerId)!.wins += 1
    standings.get(game.winnerId === game.teamAId ? game.teamBId : game.teamAId)!.losses += 1
  }
  if (pairCounts.size !== 6 || [...pairCounts.values()].some((count) => count !== 2)) {
    return unsupported('incomplete-group', 'Every pair must have exactly two observed games')
  }
  const ranked = [...standings.values()].sort((a, b) => b.wins - a.wins || a.id.localeCompare(b.id))
  if (ranked[1].wins === ranked[2].wins) {
    return unsupported('tiebreaker-rules-unavailable', 'A tie crosses the knockout qualification line; the cited primer does not specify its resolution')
  }
  return {
    status: 'supported',
    rulesId: WORLDS_2022_GROUP_RULES.id,
    source: WORLDS_2022_GROUP_RULES.source,
    groupId: input.groupId as 'A' | 'B' | 'C' | 'D',
    observationEvidence: { entrants: copyEvidence(input.entrantEvidence), games: copyEvidence(input.gameEvidence) },
    standings: ranked,
    knockoutQualifierIds: ranked.slice(0, 2).map(({ id }) => id),
    forecast: { status: 'unsupported', reason: 'historical-model-inputs-unavailable' },
  }
}

function validEvidence(evidence: GroupObservationEvidence | undefined): evidence is GroupObservationEvidence {
  return !!evidence && (evidence.kind === 'synthetic-fixture' || evidence.kind === 'source-observation')
    && typeof evidence.reference === 'string' && evidence.reference.trim().length > 0
}

function copyEvidence(evidence: GroupObservationEvidence): GroupObservationEvidence {
  return { kind: evidence.kind, reference: evidence.reference.trim() }
}

function unsupported(reason: Extract<GroupReplayResult, { status: 'unsupported' }>['reason'], detail: string): GroupReplayResult {
  return { status: 'unsupported', reason, detail }
}
