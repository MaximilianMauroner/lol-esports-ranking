import { normalizedDecisiveBestOf, type DecisiveBestOf } from './matchFormat'
import { estimateMatchupProbability, type MatchupProbabilityOptions } from './matchupMath'
import type { ProbabilityTeam } from './winProbability'

export type WorldsSimTeamInput = ProbabilityTeam & {
  seed?: number
  region?: string
  league?: string
}

export type WorldsSimOptions = {
  iterations?: number
  seed?: number
  swissWinsToAdvance?: number
  swissLossesToEliminate?: number
  swissBestOf?: DecisiveBestOf | number
  swissQualificationBestOf?: DecisiveBestOf | number
  bracketBestOf?: DecisiveBestOf | number
  bracketSize?: number
  sideAssumption?: MatchupProbabilityOptions['sideAssumption']
  blueSideRatingEdge?: number
}

export type WorldsSimFormatSummary = {
  swissWinsToAdvance: number
  swissLossesToEliminate: number
  swissBestOf: DecisiveBestOf
  swissQualificationBestOf: DecisiveBestOf
  bracketBestOf: DecisiveBestOf
  bracketSize: number
}

export type WorldsSimTeamSummary = {
  team: string
  seed: number
  rating: number
  uncertainty: number
  region?: string
  league?: string
  averageSwissWins: number
  averageSwissLosses: number
  swissAdvanceProbability: number
  bracketEntryProbability: number
  quarterfinalProbability: number
  semifinalProbability: number
  finalProbability: number
  championshipProbability: number
}

export type WorldsSimResultSummary = {
  iterations: number
  seed: number
  format: WorldsSimFormatSummary
  teams: WorldsSimTeamSummary[]
}

type SwissTeamState = Required<Pick<WorldsSimTeamInput, 'team' | 'rating' | 'uncertainty'>> & {
  seed: number
  region?: string
  league?: string
  wins: number
  losses: number
  opponents: Set<string>
}

type WorldsSimAggregate = {
  team: string
  seed: number
  rating: number
  uncertainty: number
  region?: string
  league?: string
  swissWins: number
  swissLosses: number
  swissAdvances: number
  bracketEntries: number
  quarterfinals: number
  semifinals: number
  finals: number
  championships: number
}

type WorldsSimFormat = WorldsSimFormatSummary & {
  sideAssumption?: MatchupProbabilityOptions['sideAssumption']
  blueSideRatingEdge?: number
}

export function simulateWorldsStyleTournament(
  teams: WorldsSimTeamInput[],
  options: WorldsSimOptions = {},
): WorldsSimResultSummary {
  const seededTeams = normalizedTeams(teams)
  const iterations = Math.max(1, Math.floor(options.iterations ?? 1000))
  const seed = Math.trunc(options.seed ?? 1)
  const format = normalizedFormat(seededTeams.length, options)
  const random = seededRandom(seed)
  const aggregates = new Map(seededTeams.map((team) => [team.team, aggregateFor(team)]))

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const states = seededTeams.map((team) => stateFor(team))
    runSwissStage(states, format, random)
    recordSwissResults(states, aggregates)
    const bracketTeams = bracketEntrants(states, format.bracketSize)
    runBracket(bracketTeams, format, random, aggregates)
  }

  return {
    iterations,
    seed,
    format: {
      swissWinsToAdvance: format.swissWinsToAdvance,
      swissLossesToEliminate: format.swissLossesToEliminate,
      swissBestOf: format.swissBestOf,
      swissQualificationBestOf: format.swissQualificationBestOf,
      bracketBestOf: format.bracketBestOf,
      bracketSize: format.bracketSize,
    },
    teams: seededTeams.map((team) => teamSummary(aggregateForTeam(aggregates, team.team), iterations)),
  }
}

function runSwissStage(states: SwissTeamState[], format: WorldsSimFormat, random: () => number) {
  while (states.some((team) => swissActive(team, format))) {
    const pairings = swissPairings(states.filter((team) => swissActive(team, format)))
    for (const [teamA, teamB] of pairings) {
      const winner = playMatch(teamA, teamB, swissBestOfFor(teamA, teamB, format), format, random)
      const loser = winner === teamA ? teamB : teamA
      winner.wins += 1
      loser.losses += 1
      teamA.opponents.add(teamB.team)
      teamB.opponents.add(teamA.team)
    }
  }
}

function runBracket(
  entrants: SwissTeamState[],
  format: WorldsSimFormat,
  random: () => number,
  aggregates: Map<string, WorldsSimAggregate>,
) {
  for (const team of entrants) {
    const aggregate = aggregateForTeam(aggregates, team.team)
    aggregate.bracketEntries += 1
    if (format.bracketSize >= 8) aggregate.quarterfinals += 1
  }

  let field = entrants
  while (field.length > 1) {
    if (field.length === 4) recordRoundAppearance(field, aggregates, 'semifinals')
    if (field.length === 2) recordRoundAppearance(field, aggregates, 'finals')

    field = bracketPairings(field).map(([teamA, teamB]) =>
      playMatch(teamA, teamB, format.bracketBestOf, format, random))
  }

  const champion = field[0]
  if (champion) aggregateForTeam(aggregates, champion.team).championships += 1
}

function swissPairings(activeTeams: SwissTeamState[]): Array<[SwissTeamState, SwissTeamState]> {
  const groups = new Map<string, SwissTeamState[]>()
  for (const team of activeTeams) {
    const key = `${team.wins}-${team.losses}`
    groups.set(key, [...(groups.get(key) ?? []), team])
  }

  const pairings: Array<[SwissTeamState, SwissTeamState]> = []
  const leftovers: SwissTeamState[] = []
  const orderedGroups = Array.from(groups.values())
    .sort((a, b) => b[0].wins - a[0].wins || a[0].losses - b[0].losses)

  for (const group of orderedGroups) {
    const pool = [...group, ...leftovers.splice(0)].sort(compareSeed)
    while (pool.length > 1) {
      const teamA = pool.shift()
      if (!teamA) continue
      const opponentIndex = preferredOpponentIndex(teamA, pool)
      const teamB = pool.splice(opponentIndex, 1)[0]
      if (teamB) pairings.push([teamA, teamB])
    }
    leftovers.push(...pool)
  }

  while (leftovers.length > 1) {
    const teamA = leftovers.shift()
    const teamB = leftovers.pop()
    if (teamA && teamB) pairings.push([teamA, teamB])
  }
  if (leftovers.length > 0) {
    throw new Error('Worlds Swiss simulation requires an even number of active teams each round')
  }

  return pairings
}

function bracketPairings(field: SwissTeamState[]): Array<[SwissTeamState, SwissTeamState]> {
  const pool = [...field].sort(compareSwissFinish)
  const pairings: Array<[SwissTeamState, SwissTeamState]> = []
  while (pool.length > 1) {
    const highSeed = pool.shift()
    const lowSeed = pool.pop()
    if (highSeed && lowSeed) pairings.push([highSeed, lowSeed])
  }
  return pairings
}

function playMatch(
  teamA: SwissTeamState,
  teamB: SwissTeamState,
  bestOf: DecisiveBestOf,
  format: WorldsSimFormat,
  random: () => number,
) {
  const prediction = estimateMatchupProbability(teamA, teamB, {
    bestOf,
    sideAssumption: format.sideAssumption ?? 'neutral',
    blueSideRatingEdge: format.blueSideRatingEdge,
  })
  return random() < prediction.teamASeriesWinProbability ? teamA : teamB
}

function recordSwissResults(states: SwissTeamState[], aggregates: Map<string, WorldsSimAggregate>) {
  for (const state of states) {
    const aggregate = aggregateForTeam(aggregates, state.team)
    aggregate.swissWins += state.wins
    aggregate.swissLosses += state.losses
    if (state.wins > state.losses) aggregate.swissAdvances += 1
  }
}

function bracketEntrants(states: SwissTeamState[], bracketSize: number) {
  const qualified = states.filter((team) => team.wins > team.losses)
  const fill = states.filter((team) => team.wins <= team.losses)
  return [...qualified, ...fill].sort(compareSwissFinish).slice(0, bracketSize)
}

function recordRoundAppearance(
  field: SwissTeamState[],
  aggregates: Map<string, WorldsSimAggregate>,
  key: 'semifinals' | 'finals',
) {
  for (const team of field) {
    aggregateForTeam(aggregates, team.team)[key] += 1
  }
}

function swissBestOfFor(teamA: SwissTeamState, teamB: SwissTeamState, format: WorldsSimFormat) {
  const teamAQualifying = teamA.wins === format.swissWinsToAdvance - 1 || teamA.losses === format.swissLossesToEliminate - 1
  const teamBQualifying = teamB.wins === format.swissWinsToAdvance - 1 || teamB.losses === format.swissLossesToEliminate - 1
  return teamAQualifying || teamBQualifying ? format.swissQualificationBestOf : format.swissBestOf
}

function swissActive(team: SwissTeamState, format: WorldsSimFormat) {
  return team.wins < format.swissWinsToAdvance && team.losses < format.swissLossesToEliminate
}

function preferredOpponentIndex(team: SwissTeamState, pool: SwissTeamState[]) {
  for (let index = pool.length - 1; index >= 0; index -= 1) {
    if (!team.opponents.has(pool[index].team)) return index
  }
  return pool.length - 1
}

function normalizedTeams(teams: WorldsSimTeamInput[]) {
  if (teams.length < 4 || teams.length % 2 !== 0) {
    throw new Error('Worlds simulation requires an even field of at least four teams')
  }

  const seen = new Set<string>()
  return teams.map((team, index) => {
    if (seen.has(team.team)) throw new Error(`Duplicate Worlds simulation team: ${team.team}`)
    seen.add(team.team)
    return {
      ...team,
      seed: team.seed ?? index + 1,
    }
  })
}

function normalizedFormat(teamCount: number, options: WorldsSimOptions): WorldsSimFormat {
  const bracketSize = options.bracketSize ?? largestPowerOfTwoAtMost(teamCount / 2)
  if (!Number.isInteger(bracketSize) || bracketSize < 2 || bracketSize > teamCount || !isPowerOfTwo(bracketSize)) {
    throw new Error(`Invalid Worlds bracket size: ${bracketSize}`)
  }

  return {
    swissWinsToAdvance: Math.max(1, Math.floor(options.swissWinsToAdvance ?? 3)),
    swissLossesToEliminate: Math.max(1, Math.floor(options.swissLossesToEliminate ?? 3)),
    swissBestOf: normalizedDecisiveBestOf(options.swissBestOf ?? 1),
    swissQualificationBestOf: normalizedDecisiveBestOf(options.swissQualificationBestOf ?? 3),
    bracketBestOf: normalizedDecisiveBestOf(options.bracketBestOf ?? 5),
    bracketSize,
    sideAssumption: options.sideAssumption,
    blueSideRatingEdge: options.blueSideRatingEdge,
  }
}

function stateFor(team: ReturnType<typeof normalizedTeams>[number]): SwissTeamState {
  return {
    team: team.team,
    seed: team.seed,
    rating: team.rating,
    uncertainty: team.uncertainty,
    region: team.region,
    league: team.league,
    wins: 0,
    losses: 0,
    opponents: new Set(),
  }
}

function aggregateFor(team: ReturnType<typeof normalizedTeams>[number]): WorldsSimAggregate {
  return {
    team: team.team,
    seed: team.seed,
    rating: team.rating,
    uncertainty: team.uncertainty,
    region: team.region,
    league: team.league,
    swissWins: 0,
    swissLosses: 0,
    swissAdvances: 0,
    bracketEntries: 0,
    quarterfinals: 0,
    semifinals: 0,
    finals: 0,
    championships: 0,
  }
}

function teamSummary(aggregate: WorldsSimAggregate, iterations: number): WorldsSimTeamSummary {
  return {
    team: aggregate.team,
    seed: aggregate.seed,
    rating: aggregate.rating,
    uncertainty: aggregate.uncertainty,
    region: aggregate.region,
    league: aggregate.league,
    averageSwissWins: roundMetric(aggregate.swissWins / iterations),
    averageSwissLosses: roundMetric(aggregate.swissLosses / iterations),
    swissAdvanceProbability: roundMetric(aggregate.swissAdvances / iterations),
    bracketEntryProbability: roundMetric(aggregate.bracketEntries / iterations),
    quarterfinalProbability: roundMetric(aggregate.quarterfinals / iterations),
    semifinalProbability: roundMetric(aggregate.semifinals / iterations),
    finalProbability: roundMetric(aggregate.finals / iterations),
    championshipProbability: roundMetric(aggregate.championships / iterations),
  }
}

function aggregateForTeam(aggregates: Map<string, WorldsSimAggregate>, team: string) {
  const aggregate = aggregates.get(team)
  if (!aggregate) throw new Error(`Missing Worlds simulation aggregate for ${team}`)
  return aggregate
}

function compareSeed(teamA: SwissTeamState, teamB: SwissTeamState) {
  return teamA.seed - teamB.seed || teamB.rating - teamA.rating || teamA.team.localeCompare(teamB.team)
}

function compareSwissFinish(teamA: SwissTeamState, teamB: SwissTeamState) {
  return teamB.wins - teamA.wins || teamA.losses - teamB.losses || compareSeed(teamA, teamB)
}

function seededRandom(seed: number) {
  let state = seed >>> 0
  if (state === 0) state = 1
  return () => {
    state = (1664525 * state + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function largestPowerOfTwoAtMost(value: number) {
  let power = 1
  while (power * 2 <= value) power *= 2
  return power
}

function isPowerOfTwo(value: number) {
  return value > 0 && (value & (value - 1)) === 0
}

function roundMetric(value: number) {
  return Number(value.toFixed(4))
}
