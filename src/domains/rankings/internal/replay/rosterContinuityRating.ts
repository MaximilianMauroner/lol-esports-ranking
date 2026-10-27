import type { MatchRecord, MatchRosterSnapshot } from '../../types.ts'
import {
  initialTeamRating,
  maximumUncertainty,
  minimumUncertainty,
  rosterChangeUncertaintyPenalty,
  rosterContinuityFloor,
} from '../policy/modelConfig.ts'
import type { ContinuityRetention, FinalSideRetention } from '../players/playerModel.ts'
import { clamp } from './ratingCalculations.ts'
import { rosterContinuity } from '../players/rosters.ts'

export function applyRosterContinuityForSeries(
  match: MatchRecord,
  ratings: Map<string, number>,
  executionRatings: Map<string, number>,
  uncertainties: Map<string, number>,
  lastRosterByTeam: Map<string, MatchRosterSnapshot>,
  currentRosterContinuity: Map<string, number>,
  retention: FinalSideRetention | undefined,
) {
  const processedTeams = new Set<string>()
  applyRosterContinuityForTeam({
    team: match.teamA,
    observedRoster: match.teamARoster,
    retention: retention?.teamA ?? 'baseline-contraction',
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
    retention: retention?.teamB ?? 'baseline-contraction',
    processedTeams,
    ratings,
    executionRatings,
    uncertainties,
    lastRosterByTeam,
    currentRosterContinuity,
  })
}

export function roundedContinuity(value?: number) {
  return value === undefined ? undefined : Number(value.toFixed(3))
}

function applyRosterContinuityForTeam({
  team,
  observedRoster,
  retention,
  processedTeams,
  ratings,
  executionRatings,
  uncertainties,
  lastRosterByTeam,
  currentRosterContinuity,
}: {
  team: string
  observedRoster?: MatchRosterSnapshot
  retention: ContinuityRetention
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
  const share = rosterContinuityFloor + (1 - rosterContinuityFloor) * continuity
  const retained = (value: number) => {
    const contracted = initialTeamRating + share * (value - initialTeamRating)
    return retention === 'proven-stronger-lineup' ? Math.max(value, contracted) : contracted
  }
  ratings.set(team, retained(ratings.get(team) ?? initialTeamRating))
  executionRatings.set(team, retained(executionRatings.get(team) ?? initialTeamRating))

  if (continuity < 1) {
    const uncertainty = uncertainties.get(team) ?? maximumUncertainty
    uncertainties.set(team, clamp(uncertainty + rosterChangeUncertaintyPenalty * (1 - continuity), minimumUncertainty, maximumUncertainty))
  }
}
