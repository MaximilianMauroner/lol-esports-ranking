import {
  tournamentBoundaryLabel
} from '../../domains/rankings/evidence'
import type { RankingMovementPick } from '../../domains/rankings/read'
import {
  type BoardMovement
} from '../../domains/rankings/read'
import type { PublicTournamentMovementTeam, RankingSummaryStanding, TeamHistorySeries } from '../../domains/rankings/types'
import { formatRankValue, formatRatingMovement } from './boardFormat'
import { deriveTrajectoryInsight } from './trajectory'
import { type MovementSpotlight, type UpsetSpotlight } from './WhatChanged'

type BoardChanges = { riser?: MovementSpotlight; faller?: MovementSpotlight; upset?: UpsetSpotlight }

export function boardChanges(movement: BoardMovement): BoardChanges {
  if (movement.kind === 'tournament') {
    const spotlight = (team?: PublicTournamentMovementTeam): MovementSpotlight | undefined => team ? {
      team: team.team,
      code: team.code,
      places: team.rankMovement,
      ratingDelta: team.ratingDelta,
      detail: `${team.team}: ${formatRankValue(team.startRank)} to ${formatRankValue(team.endRank)} through ${tournamentBoundaryLabel(movement.status).toLowerCase()}, ${formatRatingMovement(team.ratingDelta)} Power.`,
    } : undefined
    return { riser: spotlight(movement.riser), faller: spotlight(movement.faller) }
  }
  const { upset } = movement
  return {
    riser: movementSpotlight(movement.riser),
    faller: movementSpotlight(movement.faller),
    upset: upset ? { winner: upset.winnerCode || upset.winner, loser: upset.opponentCode ?? upset.opponent, event: upset.event, chance: upset.expectedWinProbability } : undefined,
  }
}

function movementSpotlight(pick: RankingMovementPick | null): MovementSpotlight | undefined {
  if (!pick) return undefined
  return {
    team: pick.team,
    code: pick.code,
    places: pick.movement,
    ratingDelta: pick.ratingDelta,
    detail: `${pick.team}: match-history rank #${pick.previousRank} to #${pick.rank}, ${formatRatingMovement(pick.ratingDelta)} Power.`,
  }
}

export function tournamentTrajectoryInsight(
  team: RankingSummaryStanding,
  series: TeamHistorySeries | undefined,
  exactTournament: boolean,
) {
  const insight = deriveTrajectoryInsight(team, series)
  return insight && exactTournament ? { ...insight, driver: undefined } : insight
}
