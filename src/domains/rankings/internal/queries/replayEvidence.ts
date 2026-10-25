import type { MatchRecord, PregamePrediction } from '../../types.ts'
import { canonicalTeamNameFor } from '../evidence/teamIdentity.ts'
import { walkForwardSegmentKeys } from '../projections/predictionContext.ts'
import { pregameWinRateProbabilityFor } from './pregameWinRate.ts'

export type ReplaySourceGame = {
  id: string
  seriesId: string
  date: string
  event: string
  eventId: string
  eventLeague: string
  leagueA: string
  leagueB: string
  teamA: string
  teamB: string
  winner: string
}

export const replayInformationAvailability = {
  status: 'unknown',
  reason: 'source-observation-archives-not-supplied',
  publishedForecastEvidence: false,
  temporalPolicy: 'latest-corrected-prior-replay',
  predictionOrdering: 'team-results-before-UTC-date-updates',
  playerSignalOrdering: 'prior-canonical-series;within-date-availability-unverified',
} as const

export type ReplayEvidence = {
  artifactKind: 'replay-predictions'
  contractVersion: 1
  model: { version: string; configHash: string }
  dataMode: 'no-data' | 'seeded-sample' | 'scheduled-public-data'
  informationAvailability: typeof replayInformationAvailability
  coverage: {
    status: 'complete-relative-to-replay-inputs'
    sourceGames: number
    predictedGames: number
    eligibleGames: number
    unresolvedOutcomeGames: number
    independentSourceCompleteness: 'unknown'
  }
  sourceGames: ReplaySourceGame[]
  predictions: PregamePrediction[]
}

export function evaluationEventId(match: MatchRecord) {
  return `${match.season}:${match.league}:${match.event}`
}

export function evaluationHomeLeague(match: MatchRecord, side: 'A' | 'B') {
  return (side === 'A' ? match.teamAHomeLeague : match.teamBHomeLeague) ?? 'Unknown'
}

export function requireReplayDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid replay UTC date: ${String(value)}`)
  }
  return value
}

export function replayPregameWinRate(prediction: PregamePrediction): number | null {
  const counts = [prediction.teamAPregameWins, prediction.teamAPregameLosses,
    prediction.teamBPregameWins, prediction.teamBPregameLosses]
  return counts.every((value) => value !== undefined) ? pregameWinRateProbabilityFor(prediction) : null
}

export function readReplayEvidence(input: unknown): ReplayEvidence {
  if (input === undefined || input === null) throw new Error('prediction-evidence-unavailable: regenerate a complete replay evidence artifact')
  const value = record(input)
  if (value.artifactKind !== 'replay-predictions' || value.contractVersion !== 1) {
    throw new Error('prediction-evidence-unavailable: regenerate a complete replay evidence artifact')
  }
  const model = record(value.model)
  const version = text(model.version); const configHash = text(model.configHash)
  const dataMode = value.dataMode
  if (dataMode !== 'no-data' && dataMode !== 'seeded-sample' && dataMode !== 'scheduled-public-data') throw new Error('Invalid replay data mode')
  const availability = record(value.informationAvailability)
  if (Object.entries(replayInformationAvailability).some(([key, expected]) => availability[key] !== expected)) throw new Error('Invalid replay information availability')
  if (!Array.isArray(value.sourceGames) || !Array.isArray(value.predictions)) throw new Error('Invalid replay evidence arrays')
  const sourceGames = value.sourceGames.map((item): ReplaySourceGame => {
    const source = record(item)
    for (const key of ['id', 'seriesId', 'event', 'eventId', 'eventLeague', 'leagueA', 'leagueB', 'teamA', 'teamB']) text(source[key])
    if (typeof source.winner !== 'string') throw new Error('Invalid replay source winner')
    requireReplayDate(source.date)
    if (canonicalTeamNameFor(String(source.teamA)) === canonicalTeamNameFor(String(source.teamB))) throw new Error('Invalid replay teams')
    return source as ReplaySourceGame
  })
  if (new Set(sourceGames.map((source) => source.id)).size !== sourceGames.length) throw new Error('Duplicate source match identities')
  const predictions = value.predictions.map(readPrediction)
  if (new Set(predictions.map((prediction) => prediction.id)).size !== predictions.length) throw new Error('Duplicate prediction identities')
  const sourceById = new Map(sourceGames.map((source) => [source.id, source]))
  const predictionById = new Map(predictions.map((prediction) => [prediction.id, prediction]))
  const missing = sourceGames.filter((source) => !predictionById.has(source.id)).map((source) => source.id)
  const extra = predictions.filter((prediction) => !sourceById.has(prediction.id)).map((prediction) => prediction.id)
  if (missing.length || extra.length) throw new Error(`Replay prediction coverage differs; missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}`)
  for (const prediction of predictions) {
    const source = sourceById.get(prediction.id)!
    if (prediction.modelVersion !== model.version || prediction.modelConfigHash !== model.configHash) throw new Error('Mixed prediction model identities')
    if (canonicalTeamNameFor(prediction.teamA) !== canonicalTeamNameFor(source.teamA)
      || canonicalTeamNameFor(prediction.teamB) !== canonicalTeamNameFor(source.teamB)
      || canonicalTeamNameFor(prediction.actualWinner) !== canonicalTeamNameFor(source.winner)
      || prediction.date !== source.date || prediction.event !== source.event
      || (prediction.seriesId !== undefined && prediction.seriesId !== source.seriesId)) {
      throw new Error(`Prediction source or orientation differs for ${source.id}`)
    }
  }
  const eligibleGames = sourceGames.filter((source) => [canonicalTeamNameFor(source.teamA), canonicalTeamNameFor(source.teamB)].includes(canonicalTeamNameFor(source.winner))).length
  const coverage: ReplayEvidence['coverage'] = {
    status: 'complete-relative-to-replay-inputs', sourceGames: sourceGames.length, predictedGames: predictions.length,
    eligibleGames, unresolvedOutcomeGames: sourceGames.length - eligibleGames, independentSourceCompleteness: 'unknown',
  }
  const supplied = record(value.coverage)
  if (Object.entries(coverage).some(([key, expected]) => supplied[key] !== expected)) throw new Error('Replay coverage ledger differs')
  return { artifactKind: 'replay-predictions', contractVersion: 1,
    model: { version, configHash },
    dataMode, informationAvailability: replayInformationAvailability,
    coverage, sourceGames, predictions }
}

function readPrediction(input: unknown): PregamePrediction {
  const row = record(input)
  for (const key of ['id', 'event', 'teamA', 'teamB', 'modelVersion', 'modelConfigHash', 'predictedWinner']) text(row[key])
  if (typeof row.actualWinner !== 'string' || typeof row.patch !== 'string') throw new Error('Invalid prediction outcome or patch')
  requireReplayDate(row.date)
  if (row.seriesId !== undefined) text(row.seriesId)
  if (typeof row.bestOf !== 'number' || ![1, 2, 3, 5].includes(row.bestOf)) throw new Error('Invalid prediction format')
  for (const key of ['trainingMatchCount', 'teamAPregameWins', 'teamAPregameLosses', 'teamBPregameWins', 'teamBPregameLosses']) {
    const count = row[key]
    if (count === undefined && key !== 'trainingMatchCount') continue
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid prediction ${key}`)
  }
  for (const key of ['uncertaintyPenalty', 'teamARating', 'teamBRating', 'teamAUncertainty', 'teamBUncertainty']) finite(row[key], key)
  if (row.dataCutoff !== undefined && requireReplayDate(row.dataCutoff) >= String(row.date)) throw new Error('Replay data cutoff must precede prediction date')
  probabilityPair(row, 'Game'); probabilityPair(row, 'Series', row.bestOf === 2)
  const variants = record(row.variants)
  for (const [key, suffix] of [['published', ''], ['team-only', 'TeamOnly'], ['player-adjusted', 'PlayerAdjusted'],
    ['execution-baseline', 'ExecutionBaseline'], ['execution-adjusted', 'ExecutionAdjusted']] as const) {
    const variant = record(variants[key])
    probabilityPair(variant, 'Game'); probabilityPair(variant, 'Series', row.bestOf === 2)
    for (const side of ['A', 'B']) for (const target of ['Game', 'Series']) {
      const field = `team${side}${target}WinProbability`
      const scalar = row[`${field}${suffix}`]
      if (scalar !== undefined && scalar !== variant[field]) throw new Error(`Contradictory prediction variant ${key}`)
    }
  }
  if (!Array.isArray(row.segments) || row.segments.some((key) => !walkForwardSegmentKeys.includes(key as typeof walkForwardSegmentKeys[number]))
    || new Set(row.segments).size !== row.segments.length) throw new Error('Invalid prediction segments')
  for (const side of ['A', 'B']) {
    const basis = row[`team${side}LineupEvidenceBasis`]
    if (basis !== undefined && basis !== 'prior-observed' && basis !== 'pregame-confirmed' && basis !== 'unavailable') throw new Error('Invalid lineup evidence basis')
    const observedAt = row[`team${side}LineupObservedAt`]
    if (observedAt !== undefined) {
      const observedTime = observationTime(observedAt)
      if (basis === 'prior-observed' && observedTime >= Date.parse(String(row.date)) + 86_400_000) throw new Error('Prior lineup observation cannot follow prediction UTC date')
      if (basis === 'unavailable') throw new Error('Unavailable lineup cannot have an observation date')
    }
    for (const key of [`team${side}LineupFreshnessWeight`, `team${side}PlayerRatingCoverage`]) if (row[key] !== undefined) probability(row[key])
  }
  if (row.teamALineupEvidenceBasis !== undefined && row.teamBLineupEvidenceBasis !== undefined
    && row.segments.includes('unknown-lineup') !== (row.teamALineupEvidenceBasis === 'unavailable' || row.teamBLineupEvidenceBasis === 'unavailable')) {
    throw new Error('Unknown-lineup segment contradicts recorded evidence basis')
  }
  const expectedWinner = Number(row.teamAGameWinProbability) >= .5 ? String(row.teamA) : String(row.teamB)
  if (canonicalTeamNameFor(String(row.predictedWinner)) !== canonicalTeamNameFor(expectedWinner)) throw new Error('Prediction winner contradicts probability')
  const source = record(row.source)
  for (const key of ['provider', 'gameId', 'matchId', 'officialEventId', 'officialMatchId', 'officialGameId', 'url', 'fileName', 'completeness', 'event', 'seriesId']) {
    if (source[key] !== undefined) text(source[key])
  }
  if (source.date !== undefined) requireReplayDate(source.date)
  for (const [key, item] of Object.entries(row)) {
    if (typeof item === 'number') finite(item, key)
    if (/WinProbability/.test(key) && item !== undefined) probability(item)
  }
  return row as PregamePrediction
}

function probabilityPair(row: Record<string, unknown>, target: 'Game' | 'Series', allowsDraw = false) {
  const a = probability(row[`teamA${target}WinProbability`])
  const b = probability(row[`teamB${target}WinProbability`])
  if (allowsDraw ? a + b > 1 + 1e-9 : Math.abs(a + b - 1) > 1e-9) throw new Error('Invalid prediction probability mass')
}
function probability(value: unknown) {
  const result = finite(value, 'probability')
  if (result < 0 || result > 1) throw new Error('Invalid prediction probability')
  return result
}
function finite(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid prediction ${label}`)
  return value
}
function text(value: unknown) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Invalid replay identity')
  return value
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid replay evidence object')
  return value as Record<string, unknown>
}

function observationTime(value: unknown) {
  if (typeof value !== 'string') throw new Error('Invalid lineup observation date')
  requireReplayDate(value.slice(0, 10))
  if (value.length !== 10 && (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || !Number.isFinite(Date.parse(value)))) throw new Error('Invalid lineup observation date')
  return Date.parse(value)
}
