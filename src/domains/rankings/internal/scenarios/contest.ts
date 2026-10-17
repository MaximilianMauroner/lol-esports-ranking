export type RatingContestStatus = 'upcoming' | 'live' | 'completed' | 'postponed' | 'cancelled' | 'unknown'

export type RatingContest = {
  id: string
  eventId: string
  startTime: string | null
  stage: string | null
  status: RatingContestStatus
  sourceState: string
  bestOf: number | null
  teams: Array<{ id: string | null; name: string | null; code: string | null; gameWins: number | null; outcome: string | null }>
  vodUrls: string[]
}


export function ratingContestStatus(source: string): RatingContestStatus {
  switch (source.toLowerCase()) {
    case 'unstarted': case 'scheduled': return 'upcoming'
    case 'inprogress': case 'started': return 'live'
    case 'completed': case 'complete': return 'completed'
    case 'postponed': case 'delayed': return 'postponed'
    case 'cancelled': case 'canceled': case 'nullified': return 'cancelled'
    default: return 'unknown'
  }
}

export type ConditionalSeriesOutcome = { winner: 'home' | 'away'; loserWins: number }
export type PowerPreviewUnavailable = { status: 'unavailable'; reason: string; detail: string }

export function legalConditionalScores(bestOf: number | null): number[] {
  return bestOf === 1 || bestOf === 3 || bestOf === 5
    ? Array.from({ length: (bestOf + 1) / 2 }, (_, index) => index) : []
}

export function conditionalOutcomeProblem(series: RatingContest, outcome: ConditionalSeriesOutcome, now: number): PowerPreviewUnavailable | null {
  if (series.status !== 'upcoming' || ratingContestStatus(series.sourceState) !== 'upcoming') {
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


export function ratingContestStateVersion(series: RatingContest): string {
  return JSON.stringify([series.id, series.eventId, series.startTime, series.status, series.sourceState,
    series.bestOf, series.teams.map((team) => [team.id, team.gameWins, team.outcome])])
}

export const stableResultPolicy = 'snapshot-stable-only-v1'
export const stableResultAssumptions = [
  'Only the stable-team series-result update is applied. This is a component, not the full future Power delta.',
  'Snapshot lineups, player priors and roster continuity are held fixed; future lineup confirmation is unavailable.',
  'League scores, momentum, uncertainty, records and historical evidence are held fixed. The production standing projection is recomputed.',
  'The scheduled UTC date selects event weighting. Future time decay, patch changes, placements and other series are excluded.',
  'Future game statistics and execution updates are unavailable and are not invented. Tournament simulations keep frozen strength.',
]


export function unavailablePowerPreview(reason: string, detail: string): PowerPreviewUnavailable {
  return { status: 'unavailable', reason, detail }
}
