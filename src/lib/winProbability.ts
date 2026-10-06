import type { TeamStanding } from '../types'
import { normalizedBestOf } from './matchFormat'
import {
  winProbabilityEloScale,
  winProbabilityUncertaintyFloor,
  winProbabilityUncertaintyScale,
} from './modelConfig'

export type ProbabilityTeam = Pick<TeamStanding, 'team' | 'rating' | 'uncertainty'>

export type ProbabilityCalibration = {
  eloScale: number
  uncertaintyScale: number
  uncertaintyFloor: number
}

export const defaultProbabilityCalibration: ProbabilityCalibration = {
  eloScale: winProbabilityEloScale,
  uncertaintyScale: winProbabilityUncertaintyScale,
  uncertaintyFloor: winProbabilityUncertaintyFloor,
}

export type NeutralWinProbability = {
  teamA: string
  teamB: string
  bestOf: number
  teamAGameWinProbability: number
  teamBGameWinProbability: number
  teamASeriesWinProbability: number
  teamBSeriesWinProbability: number
  teamAExpectedSeriesPoints: number
  teamBExpectedSeriesPoints: number
  uncertaintyPenalty: number
}

export function neutralWinProbability(teamA: ProbabilityTeam, teamB: ProbabilityTeam, bestOf = 1, calibration: ProbabilityCalibration = defaultProbabilityCalibration): NeutralWinProbability {
  const rawGameProbability = expectedScore(teamA.rating, teamB.rating, calibration.eloScale)
  const uncertaintyPenalty = uncertaintyPenaltyFor(teamA.uncertainty, teamB.uncertainty, calibration)
  const gameProbability = 0.5 + (rawGameProbability - 0.5) * uncertaintyPenalty
  const normalizedFormat = normalizedBestOf(bestOf)
  const teamASeriesWinProbability = seriesWinProbability(gameProbability, normalizedFormat)
  const teamBSeriesWinProbability = seriesWinProbability(1 - gameProbability, normalizedFormat)
  const teamAExpectedSeriesPoints = expectedSeriesPoints(gameProbability, normalizedFormat)

  return {
    teamA: teamA.team,
    teamB: teamB.team,
    bestOf: normalizedFormat,
    teamAGameWinProbability: clampProbability(gameProbability),
    teamBGameWinProbability: clampProbability(1 - gameProbability),
    teamASeriesWinProbability: clampProbability(teamASeriesWinProbability),
    teamBSeriesWinProbability: clampProbability(teamBSeriesWinProbability),
    teamAExpectedSeriesPoints: clampProbability(teamAExpectedSeriesPoints),
    teamBExpectedSeriesPoints: clampProbability(1 - teamAExpectedSeriesPoints),
    uncertaintyPenalty: clampProbability(uncertaintyPenalty),
  }
}

export function seriesWinProbability(gameWinProbability: number, bestOf = 1) {
  const games = normalizedBestOf(bestOf)
  const winsNeeded = Math.floor(games / 2) + 1
  let probability = 0

  for (let wins = winsNeeded; wins <= games; wins += 1) {
    probability += binomial(games, wins) * gameWinProbability ** wins * (1 - gameWinProbability) ** (games - wins)
  }

  return probability
}

export function expectedSeriesPoints(gameWinProbability: number, bestOf = 1) {
  const games = normalizedBestOf(bestOf)
  if (games === 2) return gameWinProbability
  return seriesWinProbability(gameWinProbability, games)
}

function expectedScore(ratingA: number, ratingB: number, eloScale: number) {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / eloScale))
}

function uncertaintyPenaltyFor(uncertaintyA: number, uncertaintyB: number, calibration: ProbabilityCalibration) {
  const combined = Math.sqrt(uncertaintyA ** 2 + uncertaintyB ** 2)
  return clamp(1 - combined / calibration.uncertaintyScale, calibration.uncertaintyFloor, 1)
}

function binomial(n: number, k: number) {
  let coefficient = 1
  for (let index = 1; index <= k; index += 1) {
    coefficient = (coefficient * (n + 1 - index)) / index
  }
  return coefficient
}

function clampProbability(value: number) {
  return clamp(value, 0, 1)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
