import { leagueTierFor } from '../data/leagueTiers'
import type { SeriesFormat } from '../types'
import { rosterVolatilityMultiplier, uncertaintyKMultiplier } from './ratingCalculations'
import { domesticStableTransferWeightsByTier, latentStrengthResultBudgetShares, ratingUpdateRecencyWeight } from './modelConfig'
import { neutralWinProbability } from './winProbability'

type ResultTeam = {
  team: string
  league: string
  currentPowerRating: number
  uncertainty: number
  rosterContinuity: number | undefined
}

/** The production series-result calculation. It does not read game-performance statistics. */
export function calculateSeriesResultUpdate(input: {
  teams: readonly [ResultTeam, ResultTeam]
  bestOf: SeriesFormat
  observedOutcomeA: number
  observedOutcomeB: number
  strengthSignal: number
  eventK: number
  international: boolean
}) {
  const [teamA, teamB] = input.teams
  const seriesExpected = neutralWinProbability(
    { team: teamA.team, rating: teamA.currentPowerRating, uncertainty: teamA.uncertainty },
    { team: teamB.team, rating: teamB.currentPowerRating, uncertainty: teamB.uncertainty },
    input.bestOf,
  )
  const expectedOutcomeA = seriesExpected.teamAExpectedSeriesPoints
  const expectedOutcomeB = seriesExpected.teamBExpectedSeriesPoints
  const hasLeagueSignal = teamA.league !== teamB.league
    && teamA.league !== 'Unknown'
    && teamB.league !== 'Unknown'
    && input.international
  const leagueSignalShare = hasLeagueSignal ? latentStrengthResultBudgetShares.leagueAnchor : 0
  const teamStableShare = (1 - leagueSignalShare) * latentStrengthResultBudgetShares.teamStable
  const teamFormShare = (1 - leagueSignalShare) * latentStrengthResultBudgetShares.teamForm
  const seriesResidualA = input.observedOutcomeA - expectedOutcomeA
  const seriesResidualB = input.observedOutcomeB - expectedOutcomeB
  const seriesResultEvidenceA = input.eventK * input.strengthSignal * ratingUpdateRecencyWeight * seriesResidualA
  const seriesResultEvidenceB = -seriesResultEvidenceA
  const uncertaintyMultiplierA = uncertaintyKMultiplier(teamA.uncertainty)
  const uncertaintyMultiplierB = uncertaintyKMultiplier(teamB.uncertainty)
  const rosterMultiplierA = rosterVolatilityMultiplier(teamA.rosterContinuity)
  const rosterMultiplierB = rosterVolatilityMultiplier(teamB.rosterContinuity)
  const stableTransferWeightA = stableTransferWeight(input.international, teamA.league, teamB.league)
  const stableTransferWeightB = stableTransferWeight(input.international, teamB.league, teamA.league)
  const appliedTeamStableShareA = teamStableShare
  const appliedTeamStableShareB = teamStableShare
  const baseStableDeltaA = seriesResultEvidenceA * teamStableShare
  const baseStableDeltaB = seriesResultEvidenceB * teamStableShare
  const baseFormDeltaA = seriesResultEvidenceA * teamFormShare
  const baseFormDeltaB = seriesResultEvidenceB * teamFormShare
  const baseLeagueDeltaA = seriesResultEvidenceA * leagueSignalShare
  const baseLeagueDeltaB = seriesResultEvidenceB * leagueSignalShare
  const seriesDeltaA = Math.round(baseStableDeltaA * uncertaintyMultiplierA * rosterMultiplierA * stableTransferWeightA)
  const seriesDeltaB = Math.round(baseStableDeltaB * uncertaintyMultiplierB * rosterMultiplierB * stableTransferWeightB)
  return {
    expectedOutcomeA, expectedOutcomeB, leagueSignalShare, teamFormShare,
    seriesResidualA, seriesResidualB, seriesResultEvidenceA, seriesResultEvidenceB,
    uncertaintyMultiplierA, uncertaintyMultiplierB, rosterMultiplierA, rosterMultiplierB,
    stableTransferWeightA, stableTransferWeightB, appliedTeamStableShareA, appliedTeamStableShareB,
    baseStableDeltaA, baseStableDeltaB, baseFormDeltaA, baseFormDeltaB, baseLeagueDeltaA, baseLeagueDeltaB,
    seriesDeltaA, seriesDeltaB,
  }
}

export function seriesStrengthSignal(games: number, bestOf: SeriesFormat, winsA: number, winsB: number) {
  const requiredWins = Math.max(winsA, winsB)
  const winsNeeded = Math.floor(bestOf / 2) + 1
  if (requiredWins < winsNeeded) return 1
  const unusedGames = Math.max(0, bestOf - games)
  const decisivenessBonus = bestOf > 1 ? Math.min(0.18, unusedGames * 0.06) : 0
  return 1 + decisivenessBonus
}

function stableTransferWeight(international: boolean, league: string, opponentLeague: string) {
  if (league !== opponentLeague && international) return 1
  const tier = leagueTierFor(league).tier
  if (league === opponentLeague) return domesticStableTransferWeightsByTier[tier]
  const opponentTier = leagueTierFor(opponentLeague).tier
  return Math.min(domesticStableTransferWeightsByTier[tier], domesticStableTransferWeightsByTier[opponentTier])
}
