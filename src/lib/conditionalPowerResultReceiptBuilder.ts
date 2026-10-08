import { legalConditionalScores, unavailablePowerPreview } from './conditionalPowerPreview'
import type { ConditionalPowerReplayBasis } from './conditionalPowerReplay'
import { evaluateConditionalPowerResultComponent } from './conditionalPowerResultComponent'
import { isConditionalPowerResultLedger, stableResultPolicy, type ConditionalPowerResultReceipt } from './conditionalPowerResultReceipts'
import { forecastTournamentSeries, type ForecastBasis } from './tournamentForecast'
import type { TournamentSeries } from './tournamentFeed'

/** Builds a compact outcome table from exact producer inputs. It has no fetch or write API. */
export function createConditionalPowerResultReceipt(input: {
  series: TournamentSeries
  forecastBasis: ForecastBasis
  replayBasis: ConditionalPowerReplayBasis | null
  generatedAt: string
}) {
  const { series, forecastBasis, replayBasis, generatedAt } = input
  const now = Date.parse(generatedAt)
  const forecast = forecastTournamentSeries(series, forecastBasis)
  if (forecast.status !== 'ready') return unavailablePowerPreview('missing-public-basis', forecast.detail)
  if (!Number.isFinite(now) || now < Date.parse(forecast.ratingPublishedAt) || now >= Date.parse(series.startTime ?? '')) {
    return unavailablePowerPreview('invalid-publication-time', 'A valid generation time after snapshot publication and before series start is required.')
  }
  if (!replayBasis || replayBasis.state.processedThroughUtcDate !== forecast.ratingDataAsOf.slice(0, 10)
    || replayBasis.modelVersion !== forecast.modelVersion || replayBasis.modelConfigHash !== forecast.modelConfigHash) {
    return unavailablePowerPreview('stale-pre-state', 'The exact producer state must match the current forecast snapshot date and model.')
  }
  const outputs: ConditionalPowerResultReceipt['outputs'] = []
  let provenance
  for (const winner of ['home', 'away'] as const) for (const loserWins of legalConditionalScores(series.bestOf)) {
    const result = evaluateConditionalPowerResultComponent({ series, outcome: { winner, loserWins }, now, basis: replayBasis })
    if (result.status !== 'partial') return result
    if (result.teams.some((team, index) => team.sourceTeamId !== forecast.teams[index]?.sourceTeamId || team.before !== forecast.teams[index]?.rating)) {
      return unavailablePowerPreview('projection-mismatch', 'Exact producer pre-state projection must equal both current public Power endpoints.')
    }
    provenance = result.provenance
    outputs.push({ outcome: result.outcome, teams: result.teams })
  }
  if (!provenance || (series.bestOf !== 1 && series.bestOf !== 3 && series.bestOf !== 5)) {
    return unavailablePowerPreview('unsupported-format', 'Only decisive verified formats can produce result receipts.')
  }
  const receipt: ConditionalPowerResultReceipt = {
    version: 1, policy: stableResultPolicy, ...provenance, bestOf: series.bestOf,
    snapshotId: forecast.snapshotId, identityRevision: forecast.identityRevision,
    ratingDataAsOf: forecast.ratingDataAsOf, ratingPublishedAt: forecast.ratingPublishedAt, generatedAt, outputs,
  }
  if (!isConditionalPowerResultLedger({ version: 1, receipts: [receipt] })) {
    return unavailablePowerPreview('invalid-result-receipt', 'The producer result receipt failed its public schema validation.')
  }
  return { status: 'ready' as const, receipt }
}
