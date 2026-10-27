import type { MatchRecord, PregamePrediction, PublicReplayForecastSource } from '../../types.ts'
import { resolveCanonicalSeries } from '../evidence/seriesResolver.ts'
import { canonicalTeamNameFor } from '../evidence/teamIdentity.ts'

export type RecordedSeriesForecastLookup = ReturnType<typeof recordedSeriesForecastLookup>

export function recordedSeriesForecastLookup(matches: readonly MatchRecord[], predictions: readonly PregamePrediction[]) {
  const byId = new Map<string, PregamePrediction | null>()
  for (const prediction of predictions) {
    byId.set(prediction.id, byId.has(prediction.id) ? null : prediction)
  }
  const bySeries = new Map<string, PregamePrediction>()
  for (const series of resolveCanonicalSeries(matches)) {
    const first = series.games[0]!
    const prediction = byId.get(first.id)
    if (!prediction || prediction.seriesId !== series.id) continue
    const teamA = canonicalTeamNameFor(prediction.teamA)
    const teamB = canonicalTeamNameFor(prediction.teamB)
    if (teamA === teamB || ![series.teamA, series.teamB].includes(teamA) || ![series.teamA, series.teamB].includes(teamB)) continue
    bySeries.set(series.id, prediction)
  }
  return (seriesId: string | undefined, team: string, opponent: string): { probability: number; source: PublicReplayForecastSource } | undefined => {
    const prediction = seriesId ? bySeries.get(seriesId) : undefined
    if (!prediction) return undefined
    const teamA = canonicalTeamNameFor(prediction.teamA)
    const teamB = canonicalTeamNameFor(prediction.teamB)
    const identity = canonicalTeamNameFor(team)
    const other = canonicalTeamNameFor(opponent)
    const probability = identity === teamA && other === teamB ? prediction.teamASeriesWinProbability
      : identity === teamB && other === teamA ? prediction.teamBSeriesWinProbability : undefined
    if (probability === undefined || !Number.isFinite(probability) || probability < 0 || probability > 1) return undefined
    return { probability, source: { basis: 'latest-corrected-prior-replay', predictionId: prediction.id } }
  }
}
