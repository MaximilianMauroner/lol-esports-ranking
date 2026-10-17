import { conditionalOutcomeProblem, unavailablePowerPreview, type ConditionalSeriesOutcome, type PowerPreviewUnavailable } from '../../rankings/evidence.ts'
import type { TournamentSeries } from './tournamentFeed.ts'
import type { TournamentForecast } from './tournamentForecast.ts'
export { conditionalOutcomeProblem, legalConditionalScores, unavailablePowerPreview, type ConditionalSeriesOutcome, type PowerPreviewUnavailable } from '../../rankings/evidence.ts'

/** Public forecasts do not contain a replayable rating state. Never infer it from odds. */
export function publicConditionalPowerPreview(series: TournamentSeries, outcome: ConditionalSeriesOutcome, forecast: TournamentForecast | null, now: number): PowerPreviewUnavailable {
  const problem = conditionalOutcomeProblem(series, outcome, now)
  if (problem) return problem
  if (!forecast || forecast.status === 'unavailable') {
    return unavailablePowerPreview('missing-public-basis', forecast?.detail ?? 'The current Power snapshot is unavailable.')
  }
  return unavailablePowerPreview('missing-replay-inputs', 'Public forecast inputs do not include the internal pre-series state or verified event weighting. Future lineups, patch, game order and performance inputs are also unavailable. No result component can be isolated from these inputs without assumptions.')
}
