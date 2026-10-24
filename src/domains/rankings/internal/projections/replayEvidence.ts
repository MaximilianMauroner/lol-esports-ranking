import type { MatchRecord, PregamePrediction } from '../../types.ts'
import { canonicalTeamNameFor } from '../evidence/teamIdentity.ts'
import { canonicalSeriesForMatches } from '../evidence/seriesResolver.ts'
import { evaluationEventId, evaluationHomeLeague, readReplayEvidence, replayInformationAvailability, type ReplayEvidence } from '../queries/replayEvidence.ts'

export function createReplayEvidence({ matches, predictions, model, dataMode }: {
  matches: MatchRecord[]
  predictions: PregamePrediction[]
  model: ReplayEvidence['model']
  dataMode: ReplayEvidence['dataMode']
}): ReplayEvidence {
  const canonical = matches.map((match) => ({ ...match, teamA: canonicalTeamNameFor(match.teamA),
    teamB: canonicalTeamNameFor(match.teamB), winner: canonicalTeamNameFor(match.winner) }))
  const series = canonicalSeriesForMatches(canonical)
  const sourceGames = canonical.map((match) => ({ id: match.id, seriesId: series.get(match.id)?.id ?? match.id,
    date: match.date, event: match.event, eventId: evaluationEventId(match), eventLeague: match.league,
    leagueA: evaluationHomeLeague(match, 'A'), leagueB: evaluationHomeLeague(match, 'B'),
    teamA: match.teamA, teamB: match.teamB, winner: match.winner }))
  const eligibleGames = canonical.filter((match) => match.winner === match.teamA || match.winner === match.teamB).length
  return readReplayEvidence({ artifactKind: 'replay-predictions', contractVersion: 1, model, dataMode,
    informationAvailability: replayInformationAvailability,
    coverage: { status: 'complete-relative-to-replay-inputs', sourceGames: matches.length, predictedGames: predictions.length,
      eligibleGames, unresolvedOutcomeGames: matches.length - eligibleGames, independentSourceCompleteness: 'unknown' },
    sourceGames, predictions })
}
