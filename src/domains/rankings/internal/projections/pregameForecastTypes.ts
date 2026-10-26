import type { ProbabilityCalibration } from '../queries/winProbability.ts'

export type ExactPregameProbabilityState = {
  precision: 'full'
  policy: 'prior-date'
  throughDate: string
  home: { team: string; rating: number; uncertainty: number; games: number }
  away: { team: string; rating: number; uncertainty: number; games: number }
}

export type ForecastTransform = {
  temperature: number
  calibrationOrder: 'game-before-series' | 'series-after-conversion'
  dependence: number
}

export type CalibrationFit = { startsAt: number; endsAt: number; seriesIds: string[] }

export type PregameForecastMetadata = {
  candidateId: string
  parentCandidateId: string | null
  modelCommit: string
  sourceHash: string
  configurationHash: string
  dependencyLockHash: string
  seriesId: string
  eventId: string
  homeTeamId: string
  awayTeamId: string
  bestOf: 1 | 3 | 5
  scheduleRevision: string
  scheduledStartAt: number
  sideAssumption: 'neutral'
  lineupAssumption: 'prior-observed-roster'
  modelStateId: string
  modelStateHash: string
  inputManifestHash: string
  inputDigests: Array<{ path: string; sha256: string }>
  generatedAt: number
  asOf: number
  validUntil: number
  sourceObservedAt: number[]
  calibrationFit: CalibrationFit | null
  evidenceMode: 'synthetic' | 'retrospective' | 'prospective'
  availability: 'verified' | 'historical-limited' | 'missing'
}

export type PregameForecastReceipt = PregameForecastMetadata & {
  schemaVersion: 'lol-forecast-v1'
  calibratorVersion: string
  seriesConversionVersion: string
  target: 'series-winner'
  homeSeriesWinProbability: number
  awaySeriesWinProbability: number
  componentGameProbabilities: number[]
  eligible: boolean
  exclusions: string[]
}

export type PregameForecastInput = {
  state: ExactPregameProbabilityState
  metadata: PregameForecastMetadata
  transform: ForecastTransform
  probabilityCalibration?: ProbabilityCalibration
}
