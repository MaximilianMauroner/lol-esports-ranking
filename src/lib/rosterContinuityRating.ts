import type { MatchRecord, MatchRosterSnapshot } from '../types'
import {
  initialTeamRating,
  maximumUncertainty,
  minimumUncertainty,
  rosterChangeUncertaintyPenalty,
  rosterContinuityFloor,
} from './modelConfig'
import { clamp } from './ratingCalculations'
import { rosterContinuity } from './rosters'

export function applyRosterContinuityForDate(
  matches: MatchRecord[],
  ratings: Map<string, number>,
  executionRatings: Map<string, number>,
  uncertainties: Map<string, number>,
  lastRosterByTeam: Map<string, MatchRosterSnapshot>,
  currentRosterContinuity: Map<string, number>,
) {
  const processedTeams = new Set<string>()

  for (const match of matches) {
    applyRosterContinuityForTeam({
      team: match.teamA,
      observedRoster: match.teamARoster,
      processedTeams,
      ratings,
      executionRatings,
      uncertainties,
      lastRosterByTeam,
      currentRosterContinuity,
    })
    applyRosterContinuityForTeam({
      team: match.teamB,
      observedRoster: match.teamBRoster,
      processedTeams,
      ratings,
      executionRatings,
      uncertainties,
      lastRosterByTeam,
      currentRosterContinuity,
    })
  }
}

export function roundedContinuity(value?: number) {
  return value === undefined ? undefined : Number(value.toFixed(3))
}

function applyRosterContinuityForTeam({
  team,
  observedRoster,
  processedTeams,
  ratings,
  executionRatings,
  uncertainties,
  lastRosterByTeam,
  currentRosterContinuity,
}: {
  team: string
  observedRoster?: MatchRosterSnapshot
  processedTeams: Set<string>
  ratings: Map<string, number>
  executionRatings: Map<string, number>
  uncertainties: Map<string, number>
  lastRosterByTeam: Map<string, MatchRosterSnapshot>
  currentRosterContinuity: Map<string, number>
}) {
  if (processedTeams.has(team)) return
  processedTeams.add(team)

  const continuity = rosterContinuity(lastRosterByTeam.get(team), observedRoster)
  if (continuity === undefined) return

  currentRosterContinuity.set(team, continuity)
  const retention = rosterContinuityFloor + (1 - rosterContinuityFloor) * continuity
  const rating = ratings.get(team) ?? initialTeamRating
  const executionRating = executionRatings.get(team) ?? initialTeamRating
  ratings.set(team, initialTeamRating + retention * (rating - initialTeamRating))
  executionRatings.set(team, initialTeamRating + retention * (executionRating - initialTeamRating))

  if (continuity < 1) {
    const uncertainty = uncertainties.get(team) ?? maximumUncertainty
    uncertainties.set(team, clamp(uncertainty + rosterChangeUncertaintyPenalty * (1 - continuity), minimumUncertainty, maximumUncertainty))
  }
}
