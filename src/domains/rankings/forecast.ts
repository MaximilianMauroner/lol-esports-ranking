export { predictPregameSeries } from './internal/projections/pregameForecast.ts'
export { temperatureProbability, seriesWinnerProbability } from './internal/projections/seriesForecastMath.ts'
export { replayPregameSeriesState, replayPregameSeriesBatch } from './internal/replay/pregameForecastReplay.ts'
export type { AvailableRankingGame, AvailableTournamentLifecycle, PregameSeriesRequest } from './internal/replay/pregameForecastReplay.ts'
export type {
  CalibrationFit, ExactPregameProbabilityState, ForecastTransform,
  PregameForecastInput, PregameForecastMetadata, PregameForecastReceipt,
} from './internal/projections/pregameForecastTypes.ts'

export { replaySimpleElo, replaySimpleEloSeries, replaySimpleEloSeriesBatch, predictSimpleEloSeries, simpleEloPolicy } from './internal/replay/simpleEloReplay.ts'
export type { SimpleEloState } from './internal/replay/simpleEloReplay.ts'
