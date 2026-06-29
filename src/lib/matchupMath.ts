import type { Side } from '../types'
import { normalizedDecisiveBestOf, type DecisiveBestOf } from './matchFormat'
import { neutralWinProbability, type ProbabilityTeam } from './winProbability'

export const DEFAULT_BLUE_SIDE_RATING_EDGE = 24

export type MatchupSideAssumption = 'neutral' | 'team-a-blue' | 'team-a-red'

export type UncertaintyBandOptions = {
  sigma?: number
}

export type ProbabilityBand = {
  lower: number
  estimate: number
  upper: number
  sigma: number
}

export type MatchupUncertaintyBand = {
  teamAGameWinProbability: ProbabilityBand
  teamBGameWinProbability: ProbabilityBand
  teamASeriesWinProbability: ProbabilityBand
  teamBSeriesWinProbability: ProbabilityBand
}

export type MatchupProbabilityOptions = {
  bestOf?: DecisiveBestOf | number
  sideAssumption?: MatchupSideAssumption
  blueSideRatingEdge?: number
  uncertaintyBands?: boolean | UncertaintyBandOptions
}

export type MatchupProbabilityEstimate = {
  teamA: string
  teamB: string
  bestOf: DecisiveBestOf
  sideAssumption: MatchupSideAssumption
  teamASide?: Side
  teamBSide?: Side
  ratingEdge: number
  sideRatingEdge: number
  adjustedRatingEdge: number
  teamAGameWinProbability: number
  teamBGameWinProbability: number
  teamASeriesWinProbability: number
  teamBSeriesWinProbability: number
  uncertaintyPenalty: number
  uncertaintyBand?: MatchupUncertaintyBand
}

export type SeriesScoreState = {
  bestOf: 3 | 5
  teamAWins: number
  teamBWins: number
  teamAGameWinProbability: number
}

export type SeriesSwingStateProbability = {
  bestOf: 3 | 5
  winsNeeded: number
  teamAWins: number
  teamBWins: number
  gamesPlayed: number
  gamesRemaining: number
  terminal: boolean
  teamAGameWinProbability: number
  teamBGameWinProbability: number
  teamASeriesWinProbability: number
  teamBSeriesWinProbability: number
}

export function estimateMatchupProbability(
  teamA: ProbabilityTeam,
  teamB: ProbabilityTeam,
  options: MatchupProbabilityOptions = {},
): MatchupProbabilityEstimate {
  const bestOf = normalizedDecisiveBestOf(options.bestOf ?? 1)
  const sideAssumption = options.sideAssumption ?? 'neutral'
  const blueSideRatingEdge = options.blueSideRatingEdge ?? DEFAULT_BLUE_SIDE_RATING_EDGE
  const teamASideOffset = sideRatingOffsetForTeamA(sideAssumption, blueSideRatingEdge)
  const teamBSideOffset = -teamASideOffset
  const adjustedTeamA = { ...teamA, rating: teamA.rating + teamASideOffset }
  const adjustedTeamB = { ...teamB, rating: teamB.rating + teamBSideOffset }
  const prediction = neutralWinProbability(adjustedTeamA, adjustedTeamB, bestOf)
  const ratingEdge = teamA.rating - teamB.rating
  const sideRatingEdge = teamASideOffset - teamBSideOffset

  return {
    teamA: teamA.team,
    teamB: teamB.team,
    bestOf,
    sideAssumption,
    ...sidesFor(sideAssumption),
    ratingEdge,
    sideRatingEdge,
    adjustedRatingEdge: ratingEdge + sideRatingEdge,
    teamAGameWinProbability: prediction.teamAGameWinProbability,
    teamBGameWinProbability: prediction.teamBGameWinProbability,
    teamASeriesWinProbability: prediction.teamASeriesWinProbability,
    teamBSeriesWinProbability: prediction.teamBSeriesWinProbability,
    uncertaintyPenalty: prediction.uncertaintyPenalty,
    uncertaintyBand: uncertaintyBandFor(
      adjustedTeamA,
      adjustedTeamB,
      bestOf,
      prediction.teamAGameWinProbability,
      prediction.teamASeriesWinProbability,
      options.uncertaintyBands,
    ),
  }
}

export function seriesSwingStateProbability(state: SeriesScoreState): SeriesSwingStateProbability {
  const bestOf = normalizedSwingBestOf(state.bestOf)
  const winsNeeded = Math.floor(bestOf / 2) + 1
  assertValidSeriesScore(bestOf, winsNeeded, state.teamAWins, state.teamBWins)

  const gameWinProbability = roundProbability(state.teamAGameWinProbability)
  const teamASeriesWinProbability = roundProbability(
    seriesProbabilityFromState(gameWinProbability, winsNeeded, state.teamAWins, state.teamBWins),
  )
  const terminal = state.teamAWins >= winsNeeded || state.teamBWins >= winsNeeded

  return {
    bestOf,
    winsNeeded,
    teamAWins: state.teamAWins,
    teamBWins: state.teamBWins,
    gamesPlayed: state.teamAWins + state.teamBWins,
    gamesRemaining: terminal ? 0 : bestOf - state.teamAWins - state.teamBWins,
    terminal,
    teamAGameWinProbability: gameWinProbability,
    teamBGameWinProbability: roundProbability(1 - gameWinProbability),
    teamASeriesWinProbability,
    teamBSeriesWinProbability: roundProbability(1 - teamASeriesWinProbability),
  }
}

export function seriesSwingStates(
  bestOf: 3 | 5,
  teamAGameWinProbability: number,
): SeriesSwingStateProbability[] {
  const normalizedBestOf = normalizedSwingBestOf(bestOf)
  const winsNeeded = Math.floor(normalizedBestOf / 2) + 1
  const states: SeriesSwingStateProbability[] = []

  for (let teamAWins = 0; teamAWins <= winsNeeded; teamAWins += 1) {
    for (let teamBWins = 0; teamBWins <= winsNeeded; teamBWins += 1) {
      if (!isValidSeriesScore(normalizedBestOf, winsNeeded, teamAWins, teamBWins)) continue
      states.push(seriesSwingStateProbability({
        bestOf: normalizedBestOf,
        teamAWins,
        teamBWins,
        teamAGameWinProbability,
      }))
    }
  }

  return states.sort((a, b) => a.gamesPlayed - b.gamesPlayed || a.teamBWins - b.teamBWins || a.teamAWins - b.teamAWins)
}

function uncertaintyBandFor(
  teamA: ProbabilityTeam,
  teamB: ProbabilityTeam,
  bestOf: DecisiveBestOf,
  gameEstimate: number,
  seriesEstimate: number,
  requested?: boolean | UncertaintyBandOptions,
): MatchupUncertaintyBand | undefined {
  if (!requested) return undefined

  const sigma = typeof requested === 'object' ? Math.max(0, requested.sigma ?? 1) : 1
  const edgeDeviation = Math.sqrt(teamA.uncertainty ** 2 + teamB.uncertainty ** 2) * sigma
  const lower = neutralWinProbability(
    { ...teamA, rating: teamA.rating - edgeDeviation / 2 },
    { ...teamB, rating: teamB.rating + edgeDeviation / 2 },
    bestOf,
  )
  const upper = neutralWinProbability(
    { ...teamA, rating: teamA.rating + edgeDeviation / 2 },
    { ...teamB, rating: teamB.rating - edgeDeviation / 2 },
    bestOf,
  )
  const gameBand = probabilityBand(lower.teamAGameWinProbability, gameEstimate, upper.teamAGameWinProbability, sigma)
  const seriesBand = probabilityBand(lower.teamASeriesWinProbability, seriesEstimate, upper.teamASeriesWinProbability, sigma)

  return {
    teamAGameWinProbability: gameBand,
    teamBGameWinProbability: invertBand(gameBand),
    teamASeriesWinProbability: seriesBand,
    teamBSeriesWinProbability: invertBand(seriesBand),
  }
}

function sideRatingOffsetForTeamA(sideAssumption: MatchupSideAssumption, blueSideRatingEdge: number) {
  if (sideAssumption === 'team-a-blue') return blueSideRatingEdge / 2
  if (sideAssumption === 'team-a-red') return -blueSideRatingEdge / 2
  return 0
}

function sidesFor(sideAssumption: MatchupSideAssumption): Pick<MatchupProbabilityEstimate, 'teamASide' | 'teamBSide'> {
  if (sideAssumption === 'team-a-blue') return { teamASide: 'blue', teamBSide: 'red' }
  if (sideAssumption === 'team-a-red') return { teamASide: 'red', teamBSide: 'blue' }
  return {}
}

function seriesProbabilityFromState(
  gameWinProbability: number,
  winsNeeded: number,
  teamAWins: number,
  teamBWins: number,
): number {
  if (teamAWins >= winsNeeded) return 1
  if (teamBWins >= winsNeeded) return 0
  return gameWinProbability * seriesProbabilityFromState(gameWinProbability, winsNeeded, teamAWins + 1, teamBWins)
    + (1 - gameWinProbability) * seriesProbabilityFromState(gameWinProbability, winsNeeded, teamAWins, teamBWins + 1)
}

function normalizedSwingBestOf(bestOf: 3 | 5): 3 | 5 {
  if (bestOf !== 3 && bestOf !== 5) {
    throw new Error(`Series swing states require Bo3 or Bo5, received Bo${bestOf}`)
  }
  return bestOf
}

function assertValidSeriesScore(bestOf: 3 | 5, winsNeeded: number, teamAWins: number, teamBWins: number) {
  if (!isValidSeriesScore(bestOf, winsNeeded, teamAWins, teamBWins)) {
    throw new Error(`Invalid Bo${bestOf} score state: ${teamAWins}-${teamBWins}`)
  }
}

function isValidSeriesScore(bestOf: 3 | 5, winsNeeded: number, teamAWins: number, teamBWins: number) {
  if (!Number.isInteger(teamAWins) || !Number.isInteger(teamBWins)) return false
  if (teamAWins < 0 || teamBWins < 0) return false
  if (teamAWins > winsNeeded || teamBWins > winsNeeded) return false
  if (teamAWins >= winsNeeded && teamBWins >= winsNeeded) return false
  if (teamAWins + teamBWins > bestOf) return false
  if (teamAWins >= winsNeeded && teamAWins + teamBWins > winsNeeded + teamBWins) return false
  if (teamBWins >= winsNeeded && teamAWins + teamBWins > winsNeeded + teamAWins) return false
  return true
}

function probabilityBand(lower: number, estimate: number, upper: number, sigma: number): ProbabilityBand {
  return {
    lower: roundProbability(Math.min(lower, upper)),
    estimate: roundProbability(estimate),
    upper: roundProbability(Math.max(lower, upper)),
    sigma,
  }
}

function invertBand(band: ProbabilityBand): ProbabilityBand {
  return {
    lower: roundProbability(1 - band.upper),
    estimate: roundProbability(1 - band.estimate),
    upper: roundProbability(1 - band.lower),
    sigma: band.sigma,
  }
}

function roundProbability(value: number) {
  return Number(Math.min(1, Math.max(0, value)).toFixed(4))
}
