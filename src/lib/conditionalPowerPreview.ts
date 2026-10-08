import { normalizeStatus, type TournamentSeries } from './tournamentFeed'
import type { TournamentForecast } from './tournamentForecast'

export type ConditionalSeriesOutcome = { winner: 'home' | 'away'; loserWins: number }
export type PowerPreviewUnavailable = { status: 'unavailable'; reason: string; detail: string }

export function legalConditionalScores(bestOf: number | null): number[] {
  return bestOf === 1 || bestOf === 3 || bestOf === 5
    ? Array.from({ length: (bestOf + 1) / 2 }, (_, index) => index) : []
}

export function conditionalOutcomeProblem(series: TournamentSeries, outcome: ConditionalSeriesOutcome, now: number): PowerPreviewUnavailable | null {
  if (series.status !== 'upcoming' || normalizeStatus(series.sourceState) !== 'upcoming') {
    return unavailablePowerPreview('not-upcoming', 'Pre-series Power previews close when the source reports play. Actual rating impact belongs to the rating evidence ledger.')
  }
  if (!series.startTime || !Number.isFinite(Date.parse(series.startTime)) || !Number.isFinite(now) || now >= Date.parse(series.startTime)) {
    return unavailablePowerPreview('already-started', 'A valid future start time is required for a pre-series preview.')
  }
  if (series.teams.length !== 2 || series.teams.some((team) => !team.id) || series.teams[0]?.id === series.teams[1]?.id) {
    return unavailablePowerPreview('missing-team', 'Two distinct source team identities are required.')
  }
  if (series.teams.some((team) => (team.gameWins !== null && team.gameWins !== 0) || team.outcome !== null)) {
    return unavailablePowerPreview('already-started', 'The source already contains played-game or result evidence.')
  }
  const scores = legalConditionalScores(series.bestOf)
  if (!scores.length) return unavailablePowerPreview('unsupported-format', 'Only verified decisive Bo1, Bo3 and Bo5 outcomes are supported.')
  if ((outcome.winner !== 'home' && outcome.winner !== 'away') || !scores.includes(outcome.loserWins)) {
    return unavailablePowerPreview('invalid-score', 'Select a legal winner and losing-team score for this format.')
  }
  return null
}

/** Public forecasts do not contain a replayable rating state. Never infer it from odds. */
export function publicConditionalPowerPreview(series: TournamentSeries, outcome: ConditionalSeriesOutcome, forecast: TournamentForecast | null, now: number): PowerPreviewUnavailable {
  const problem = conditionalOutcomeProblem(series, outcome, now)
  if (problem) return problem
  if (!forecast || forecast.status === 'unavailable') {
    return unavailablePowerPreview('missing-public-basis', forecast?.detail ?? 'The current Power snapshot is unavailable.')
  }
  return unavailablePowerPreview('missing-replay-inputs', 'Public forecast inputs do not include the internal pre-series state or verified event weighting. Future lineups, patch, game order and performance inputs are also unavailable. No result component can be isolated from these inputs without assumptions.')
}

export function unavailablePowerPreview(reason: string, detail: string): PowerPreviewUnavailable {
  return { status: 'unavailable', reason, detail }
}
