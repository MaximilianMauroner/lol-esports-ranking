import { defaultProbabilityCalibration } from '../queries/winProbability.ts'
import type { PregameForecastInput, PregameForecastReceipt } from './pregameForecastTypes.ts'
import { seriesWinnerProbability, temperatureProbability } from './seriesForecastMath.ts'

export function predictPregameSeries({ state, metadata, transform, probabilityCalibration = defaultProbabilityCalibration }: PregameForecastInput): PregameForecastReceipt {
  const { bestOf, asOf, generatedAt, scheduledStartAt, validUntil, calibrationFit } = metadata
  if (![1, 3, 5].includes(bestOf)) throw new Error('Unsupported series format')
  if (state.precision !== 'full' || state.policy !== 'prior-date' || !/^\d{4}-\d{2}-\d{2}$/.test(state.throughDate)
    || !Number.isFinite(Date.parse(state.throughDate)) || new Date(state.throughDate).toISOString().slice(0, 10) !== state.throughDate
    || Date.parse(state.throughDate) >= Math.floor(asOf / 86_400_000) * 86_400_000) throw new Error('Expected exact prior-date causal state')
  for (const team of [state.home, state.away]) {
    if (!team?.team || !Number.isFinite(team.rating) || !Number.isFinite(team.uncertainty) || team.uncertainty < 0
      || !Number.isInteger(team.games) || team.games <= 0) throw new Error('Missing, seeded or invalid team state')
  }
  if (state.home.team === state.away.team || metadata.homeTeamId === metadata.awayTeamId) throw new Error('Teams must differ')
  for (const field of ['candidateId', 'modelCommit', 'seriesId', 'eventId', 'homeTeamId', 'awayTeamId', 'scheduleRevision', 'modelStateId'] as const) {
    if (typeof metadata[field] !== 'string' || !metadata[field].trim()) throw new Error(`Missing forecast identity ${field}`)
  }
  if (metadata.parentCandidateId !== null && !metadata.parentCandidateId?.trim()) throw new Error('Invalid parent candidate')
  for (const value of [metadata.sourceHash, metadata.configurationHash, metadata.dependencyLockHash, metadata.modelStateHash, metadata.inputManifestHash]) {
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid provenance hash')
  }
  if (!metadata.inputDigests.length || metadata.inputDigests.some(input => !input.path || !/^[a-f0-9]{64}$/.test(input.sha256))) throw new Error('Missing input digests')
  if (![asOf, generatedAt, scheduledStartAt, validUntil, ...metadata.sourceObservedAt].every(t => Number.isSafeInteger(t) && t >= 0)
    || !metadata.sourceObservedAt.length || asOf > generatedAt || validUntil <= asOf || validUntil > scheduledStartAt
    || metadata.sourceObservedAt.some(t => t > generatedAt)) throw new Error('Invalid forecast chronology')
  if (!['synthetic', 'retrospective', 'prospective'].includes(metadata.evidenceMode)
    || !['verified', 'historical-limited', 'missing'].includes(metadata.availability)
    || metadata.sideAssumption !== 'neutral' || metadata.lineupAssumption !== 'prior-observed-roster') throw new Error('Unsupported forecast evidence or assumptions')
  if (metadata.evidenceMode === 'prospective' && (metadata.availability !== 'verified' || generatedAt >= validUntil)) throw new Error('Prospective forecast is unavailable or expired')
  if (metadata.availability === 'verified' && metadata.sourceObservedAt.some(t => t > asOf)) throw new Error('Source observed after decision')
  if (calibrationFit && (!Number.isSafeInteger(calibrationFit.startsAt) || !Number.isSafeInteger(calibrationFit.endsAt)
    || calibrationFit.startsAt < 0 || !calibrationFit.seriesIds.every(id => typeof id === 'string' && id.length > 0)
    || calibrationFit.startsAt > calibrationFit.endsAt || calibrationFit.endsAt >= asOf || !calibrationFit.seriesIds.length
    || calibrationFit.seriesIds.includes(metadata.seriesId) || new Set(calibrationFit.seriesIds).size !== calibrationFit.seriesIds.length)) throw new Error('Calibration overlaps evaluation')
  if ((transform.temperature !== 1 || transform.dependence !== 0) && !calibrationFit) throw new Error('Learned transforms require earlier fit provenance')
  if (!['game-before-series', 'series-after-conversion'].includes(transform.calibrationOrder)) throw new Error('Invalid calibration composition')
  const { eloScale, uncertaintyScale, uncertaintyFloor } = probabilityCalibration
  if (!(eloScale > 0) || !Number.isFinite(eloScale) || !(uncertaintyScale > 0) || !Number.isFinite(uncertaintyScale)
    || !Number.isFinite(uncertaintyFloor) || uncertaintyFloor < 0 || uncertaintyFloor > 1) throw new Error('Invalid probability calibration')
  const raw = 1 / (1 + 10 ** ((state.away.rating - state.home.rating) / eloScale))
  const shrinkage = Math.max(uncertaintyFloor, Math.min(1, 1 - Math.hypot(state.home.uncertainty, state.away.uncertainty) / uncertaintyScale))
  const game = 0.5 + (raw - 0.5) * shrinkage
  const calibratedGame = transform.calibrationOrder === 'game-before-series' ? temperatureProbability(game, transform.temperature) : game
  const componentGameProbabilities = Array<number>(bestOf).fill(calibratedGame)
  const series = seriesWinnerProbability(componentGameProbabilities, bestOf, transform.dependence)
  const homeSeriesWinProbability = transform.calibrationOrder === 'series-after-conversion' ? temperatureProbability(series, transform.temperature) : series
  const exclusions = metadata.availability === 'verified' ? [] : [metadata.availability === 'missing' ? 'missing-availability-evidence' : 'historical-availability-not-proven']
  return { ...metadata, schemaVersion: 'lol-forecast-v1', target: 'series-winner',
    calibratorVersion: `temperature-v1:${transform.calibrationOrder}:T=${transform.temperature}`,
    seriesConversionVersion: `latent-logit-mixture-v1:dependence=${transform.dependence}`,
    homeSeriesWinProbability, awaySeriesWinProbability: 1 - homeSeriesWinProbability,
    componentGameProbabilities, eligible: exclusions.length === 0, exclusions }
}
