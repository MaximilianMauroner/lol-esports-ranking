import type { TeamStanding } from '../types'
import { normalizedDecisiveBestOf } from './matchFormat'
import {
  winProbabilityEloScale,
  winProbabilityUncertaintyFloor,
  winProbabilityUncertaintyScale,
} from './modelConfig'

export type ProbabilityTeam = Pick<TeamStanding, 'team' | 'rating' | 'uncertainty'>

export type NeutralWinProbability = {
  teamA: string
  teamB: string
  bestOf: number
  teamAGameWinProbability: number
  teamBGameWinProbability: number
  teamASeriesWinProbability: number
  teamBSeriesWinProbability: number
  uncertaintyPenalty: number
}

export function neutralWinProbability(teamA: ProbabilityTeam, teamB: ProbabilityTeam, bestOf = 1): NeutralWinProbability {
  const rawGameProbability = expectedScore(teamA.rating, teamB.rating)
  const uncertaintyPenalty = uncertaintyPenaltyFor(teamA.uncertainty, teamB.uncertainty)
  const gameProbability = 0.5 + (rawGameProbability - 0.5) * uncertaintyPenalty
  const seriesProbability = seriesWinProbability(gameProbability, bestOf)

  return {
    teamA: teamA.team,
    teamB: teamB.team,
    bestOf: normalizedDecisiveBestOf(bestOf),
    teamAGameWinProbability: roundProbability(gameProbability),
    teamBGameWinProbability: roundProbability(1 - gameProbability),
    teamASeriesWinProbability: roundProbability(seriesProbability),
    teamBSeriesWinProbability: roundProbability(1 - seriesProbability),
    uncertaintyPenalty: roundProbability(uncertaintyPenalty),
  }
}

export function seriesWinProbability(gameWinProbability: number, bestOf = 1) {
  const games = normalizedDecisiveBestOf(bestOf)
  const winsNeeded = Math.floor(games / 2) + 1
  let probability = 0

  for (let wins = winsNeeded; wins <= games; wins += 1) {
    probability += binomial(games, wins) * gameWinProbability ** wins * (1 - gameWinProbability) ** (games - wins)
  }

  return probability
}

function expectedScore(ratingA: number, ratingB: number) {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / winProbabilityEloScale))
}

function uncertaintyPenaltyFor(uncertaintyA: number, uncertaintyB: number) {
  const combined = Math.sqrt(uncertaintyA ** 2 + uncertaintyB ** 2)
  return clamp(1 - combined / winProbabilityUncertaintyScale, winProbabilityUncertaintyFloor, 1)
}

function binomial(n: number, k: number) {
  let coefficient = 1
  for (let index = 1; index <= k; index += 1) {
    coefficient = (coefficient * (n + 1 - index)) / index
  }
  return coefficient
}

function roundProbability(value: number) {
  return Number(clamp(value, 0, 1).toFixed(4))
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
