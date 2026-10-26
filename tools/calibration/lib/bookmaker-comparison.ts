import type { PregameForecastReceipt } from '../../../src/domains/rankings/forecast.ts'

type EvidenceMode = PregameForecastReceipt['evidenceMode']
type Series = {
  seriesId: string; eventId: string; homeTeamId: string; awayTeamId: string
  bestOf: 1 | 3 | 5; scheduleRevision: string; scheduledStartAt: number; decisionCutoff: number
}
export type BookmakerComparisonConfig = {
  schemaVersion: 'lol-bookmaker-comparison-config-v1'
  comparisonId: string; frozenAt: number; scoringAsOf: number; evidenceMode: EvidenceMode
  candidateId: string; sourceHash: string; configurationHash: string
  bookmaker: string; maxQuoteAgeMs: number; calibrationBinEdges: number[]; series: Series[]
}
export type CanonicalSeriesResult = {
  seriesId: string; eventId: string; homeTeamId: string; awayTeamId: string
  bestOf: 1 | 3 | 5; winnerTeamId: string; completedAt: number; resultAvailableAt: number
  evidenceMode: EvidenceMode
}
export type RetainedBookmakerQuote = {
  quoteId: string; bookmaker: string; seriesId: string; eventId: string
  bestOf: 1 | 3 | 5; scheduleRevision: string; scheduledStartAt: number
  market: 'series-winner'; quotedAt: number; observedAt: number; evidenceMode: EvidenceMode
  outcomes: Array<{ teamId: string; decimalOdds: number | null }>
}
type Inputs = {
  config: BookmakerComparisonConfig; forecasts: PregameForecastReceipt[]
  results: CanonicalSeriesResult[]; quotes: RetainedBookmakerQuote[]
}
type Loss = { brier: number; logLoss: number }
type Pair = {
  seriesId: string; eventId: string; homeTeamId: string; awayTeamId: string; decisionCutoff: number
  winnerTeamId: string; homeWon: boolean; evidenceMode: EvidenceMode; quoteId: string
  quoteObservedAt: number; quoteQuotedAt: number; quoteAgeMs: number; overround: number
  modelProbability: number; bookmakerProbability: number
  model: Loss; bookmaker: Loss; modelMinusBookmaker: Loss
}
const evidenceModes = ['synthetic', 'retrospective', 'prospective']
const hashPattern = /^[a-f0-9]{64}$/
const epsilon = 1e-15

function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`)
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) throw new Error(`Unexpected or missing ${label} fields`)
  return row
}
function strings(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) if (typeof row[key] !== 'string' || !(row[key] as string).trim()) throw new Error(`Invalid ${key}`)
}
function times(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) if (!Number.isSafeInteger(row[key]) || (row[key] as number) < 0) throw new Error(`Invalid ${key}`)
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`)
  return value
}
function enumValue(value: unknown, choices: unknown[], label: string) {
  if (!choices.includes(value)) throw new Error(`Invalid ${label}`)
}
function probability(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 }
function identity(row: Record<string, unknown>) {
  strings(row, ['seriesId', 'eventId', 'homeTeamId', 'awayTeamId'])
  if (row.homeTeamId === row.awayTeamId) throw new Error('Teams must differ')
  enumValue(row.bestOf, [1, 3, 5], 'bestOf')
}
function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`)
}

function readConfig(value: unknown): BookmakerComparisonConfig {
  const row = object(value, ['schemaVersion', 'comparisonId', 'frozenAt', 'scoringAsOf', 'evidenceMode', 'candidateId', 'sourceHash', 'configurationHash', 'bookmaker', 'maxQuoteAgeMs', 'calibrationBinEdges', 'series'], 'config')
  enumValue(row.schemaVersion, ['lol-bookmaker-comparison-config-v1'], 'config version')
  strings(row, ['comparisonId', 'candidateId', 'bookmaker', 'sourceHash', 'configurationHash'])
  if (![row.sourceHash, row.configurationHash].every(hash => hashPattern.test(hash as string))) throw new Error('Invalid config hashes')
  times(row, ['frozenAt', 'scoringAsOf', 'maxQuoteAgeMs'])
  enumValue(row.evidenceMode, evidenceModes, 'evidenceMode')
  const edges = array(row.calibrationBinEdges, 'calibrationBinEdges')
  if (edges.length < 2 || edges.length > 101 || edges[0] !== 0 || edges.at(-1) !== 1 || edges.some((edge, i) => !probability(edge) || (i > 0 && edge <= (edges[i - 1] as number)))) throw new Error('Invalid calibration bins')
  const series = array(row.series, 'series').map(value => {
    const item = object(value, ['seriesId', 'eventId', 'homeTeamId', 'awayTeamId', 'bestOf', 'scheduleRevision', 'scheduledStartAt', 'decisionCutoff'], 'series')
    identity(item)
    strings(item, ['scheduleRevision'])
    times(item, ['scheduledStartAt', 'decisionCutoff'])
    if ((row.frozenAt as number) >= (item.decisionCutoff as number) || (item.decisionCutoff as number) >= (item.scheduledStartAt as number) || (row.scoringAsOf as number) <= (item.decisionCutoff as number)) throw new Error('Invalid frozen comparison chronology')
    return item as Series
  })
  if (!series.length) throw new Error('Empty comparison universe')
  unique(series.map(s => s.seriesId), 'config series')
  return { ...row, series } as BookmakerComparisonConfig
}

function readForecast(value: unknown): PregameForecastReceipt {
  const modelFields = value && typeof value === 'object' && Object.hasOwn(value, 'modelKind') ? ['modelKind'] : []
  const row = object(value, [...modelFields, 'candidateId', 'parentCandidateId', 'modelCommit', 'sourceHash', 'configurationHash', 'dependencyLockHash', 'seriesId', 'eventId', 'homeTeamId', 'awayTeamId', 'bestOf', 'scheduleRevision', 'scheduledStartAt', 'sideAssumption', 'lineupAssumption', 'modelStateId', 'modelStateHash', 'inputManifestHash', 'inputDigests', 'generatedAt', 'asOf', 'validUntil', 'sourceObservedAt', 'calibrationFit', 'evidenceMode', 'availability', 'schemaVersion', 'target', 'calibratorVersion', 'seriesConversionVersion', 'homeSeriesWinProbability', 'awaySeriesWinProbability', 'componentGameProbabilities', 'eligible', 'exclusions'], 'forecast')
  identity(row)
  strings(row, ['candidateId', 'modelCommit', 'scheduleRevision', 'modelStateId', 'calibratorVersion', 'seriesConversionVersion'])
  if (row.parentCandidateId !== null && (typeof row.parentCandidateId !== 'string' || !row.parentCandidateId.trim())) throw new Error('Invalid parent candidate')
  for (const key of ['sourceHash', 'configurationHash', 'dependencyLockHash', 'modelStateHash', 'inputManifestHash']) if (typeof row[key] !== 'string' || !hashPattern.test(row[key] as string)) throw new Error(`Invalid ${key}`)
  const digests = array(row.inputDigests, 'inputDigests')
  if (!digests.length) throw new Error('Missing input digests')
  for (const value of digests) {
    const digest = object(value, ['path', 'sha256'], 'input digest')
    strings(digest, ['path', 'sha256'])
    if (!hashPattern.test(digest.sha256 as string)) throw new Error('Invalid input digest')
  }
  times(row, ['scheduledStartAt', 'generatedAt', 'asOf', 'validUntil'])
  const observed = array(row.sourceObservedAt, 'sourceObservedAt')
  if (!observed.length || observed.some(t => !Number.isSafeInteger(t) || (t as number) < 0)) throw new Error('Invalid source observations')
  enumValue(row.schemaVersion, ['lol-forecast-v1'], 'forecast version')
  enumValue(row.target, ['series-winner'], 'forecast target')
  enumValue(row.evidenceMode, evidenceModes, 'evidenceMode')
  enumValue(row.availability, ['verified', 'historical-limited', 'missing'], 'availability')
  enumValue(row.sideAssumption, ['neutral'], 'sideAssumption')
  enumValue(row.lineupAssumption, ['prior-observed-roster'], 'lineupAssumption')
  if (!probability(row.homeSeriesWinProbability) || !probability(row.awaySeriesWinProbability) || Math.abs(row.homeSeriesWinProbability + row.awaySeriesWinProbability - 1) > 1e-12) throw new Error('Invalid forecast probabilities')
  const components = array(row.componentGameProbabilities, 'componentGameProbabilities')
  if (components.length !== row.bestOf || !components.every(probability)) throw new Error('Invalid component probabilities')
  const exclusions = array(row.exclusions, 'exclusions')
  if (typeof row.eligible !== 'boolean' || exclusions.some(s => typeof s !== 'string' || !s.trim()) || row.eligible !== (exclusions.length === 0)) throw new Error('Invalid forecast eligibility')
  if (row.calibrationFit !== null) {
    const fit = object(row.calibrationFit, ['startsAt', 'endsAt', 'seriesIds'], 'calibrationFit')
    times(fit, ['startsAt', 'endsAt'])
    const ids = array(fit.seriesIds, 'fit series')
    if (!ids.length || ids.some(id => typeof id !== 'string' || !id.trim()) || (fit.startsAt as number) > (fit.endsAt as number)) throw new Error('Invalid calibration fit')
    unique(ids as string[], 'fit series')
  }
  if (row.modelKind !== undefined) enumValue(row.modelKind, ['ranking', 'simple-elo'], 'modelKind')
  if (row.modelKind === 'simple-elo') {
    if (row.candidateId !== 'simple-elo-v1' || row.parentCandidateId !== null || row.calibrationFit !== null || row.calibratorVersion !== 'simple-elo-identity-v1' || row.seriesConversionVersion !== 'simple-elo-independent-series-v1') throw new Error('Invalid simple Elo identity')
    return row as PregameForecastReceipt
  }
  if (row.candidateId === 'simple-elo-v1') throw new Error('Reserved simple Elo candidate ID')
  const temperature = /^temperature-v1:(game-before-series|series-after-conversion):T=(.+)$/.exec(row.calibratorVersion as string)
  const dependence = /^latent-logit-mixture-v1:dependence=(.+)$/.exec(row.seriesConversionVersion as string)
  if (!temperature || !dependence || !Number.isFinite(Number(temperature[2])) || Number(temperature[2]) <= 0 || !Number.isFinite(Number(dependence[1])) || Number(dependence[1]) < 0) throw new Error('Unsupported forecast transform')
  if ((Number(temperature[2]) !== 1 || Number(dependence[1]) !== 0) && row.calibrationFit === null) throw new Error('Learned transform has no fit provenance')
  return row as PregameForecastReceipt
}

function readResult(value: unknown): CanonicalSeriesResult {
  const row = object(value, ['seriesId', 'eventId', 'homeTeamId', 'awayTeamId', 'bestOf', 'winnerTeamId', 'completedAt', 'resultAvailableAt', 'evidenceMode'], 'result')
  identity(row)
  strings(row, ['winnerTeamId'])
  times(row, ['completedAt', 'resultAvailableAt'])
  enumValue(row.evidenceMode, evidenceModes, 'evidenceMode')
  if (![row.homeTeamId, row.awayTeamId].includes(row.winnerTeamId) || (row.resultAvailableAt as number) < (row.completedAt as number)) throw new Error('Invalid result')
  return row as CanonicalSeriesResult
}
function readQuote(value: unknown): RetainedBookmakerQuote {
  const row = object(value, ['quoteId', 'bookmaker', 'seriesId', 'eventId', 'bestOf', 'scheduleRevision', 'scheduledStartAt', 'market', 'quotedAt', 'observedAt', 'evidenceMode', 'outcomes'], 'quote')
  strings(row, ['quoteId', 'bookmaker', 'seriesId', 'eventId', 'scheduleRevision'])
  times(row, ['scheduledStartAt', 'quotedAt', 'observedAt'])
  enumValue(row.bestOf, [1, 3, 5], 'bestOf')
  enumValue(row.market, ['series-winner'], 'quote market')
  enumValue(row.evidenceMode, evidenceModes, 'evidenceMode')
  if ((row.observedAt as number) < (row.quotedAt as number)) throw new Error('Quote observed before publication')
  for (const value of array(row.outcomes, 'outcomes')) {
    const outcome = object(value, ['teamId', 'decimalOdds'], 'outcome')
    strings(outcome, ['teamId'])
    if (outcome.decimalOdds !== null && (typeof outcome.decimalOdds !== 'number' || !Number.isFinite(outcome.decimalOdds))) throw new Error('Invalid decimal odds')
  }
  return row as RetainedBookmakerQuote
}

export function parseBookmakerComparison(config: unknown, forecasts: unknown, results: unknown, quotes: unknown): Inputs {
  const parsed = { config: readConfig(config), forecasts: array(forecasts, 'forecasts').map(readForecast), results: array(results, 'results').map(readResult), quotes: array(quotes, 'quotes').map(readQuote) }
  unique(parsed.quotes.map(q => q.quoteId), 'quote ID')
  return parsed
}

function matchesIdentity(row: { eventId: string; homeTeamId: string; awayTeamId: string; bestOf: number }, series: Series) {
  return row.eventId === series.eventId && row.homeTeamId === series.homeTeamId && row.awayTeamId === series.awayTeamId && row.bestOf === series.bestOf
}
function losses(p: number, won: boolean): Loss {
  const bounded = Math.max(epsilon, Math.min(1 - epsilon, p))
  return { brier: (p - Number(won)) ** 2, logLoss: -Math.log(won ? bounded : 1 - bounded) }
}
function mean(values: number[]) { return values.length ? values.reduce((sum, x) => sum + x, 0) / values.length : null }
function metrics(rows: Pair[], key: 'model' | 'bookmaker' | 'modelMinusBookmaker') {
  return { count: rows.length, brier: mean(rows.map(row => row[key].brier)), logLoss: mean(rows.map(row => row[key].logLoss)) }
}
function bins(rows: Pair[], key: 'modelProbability' | 'bookmakerProbability', edges: number[]) {
  return edges.slice(0, -1).map((lower, i) => {
    const upper = edges[i + 1]
    const members = rows.filter(row => row[key] >= lower && (row[key] < upper || i === edges.length - 2 && row[key] === upper))
    return { lowerInclusive: lower, upper, upperInclusive: i === edges.length - 2, count: members.length, meanProbability: mean(members.map(row => row[key])), observedHomeWinRate: mean(members.map(row => Number(row.homeWon))) }
  })
}

export function compareBookmakerForecasts({ config, forecasts, results, quotes }: Inputs) {
  const seriesIds = new Set(config.series.map(s => s.seriesId))
  const paired: Pair[] = []
  const denominator: Array<{ seriesId: string; eventId: string; included: boolean; reasons: string[] }> = []
  const quoteAudit: Array<{ seriesId: string; quoteId: string; reasons: string[] }> = []
  const orderedSeries = [...config.series].sort((a, b) => a.seriesId < b.seriesId ? -1 : a.seriesId > b.seriesId ? 1 : 0)
  for (const series of orderedSeries) {
    const reasons: string[] = []
    const receipts = forecasts.filter(f => f.seriesId === series.seriesId && f.candidateId === config.candidateId)
    const resultRows = results.filter(r => r.seriesId === series.seriesId)
    const forecast = receipts[0]
    const result = resultRows[0]
    if (receipts.length !== 1) reasons.push(receipts.length ? 'duplicate-series-forecast' : 'missing-forecast')
    if (forecast) {
      if (!matchesIdentity(forecast, series) || forecast.scheduleRevision !== series.scheduleRevision || forecast.scheduledStartAt !== series.scheduledStartAt) reasons.push('forecast-identity-mismatch')
      if (forecast.sourceHash !== config.sourceHash || forecast.configurationHash !== config.configurationHash) reasons.push('forecast-candidate-mismatch')
      if (forecast.evidenceMode !== config.evidenceMode) reasons.push('forecast-evidence-mode-mismatch')
      if (!forecast.eligible || forecast.availability !== 'verified') reasons.push('forecast-ineligible', ...forecast.exclusions.map(reason => `forecast:${reason}`))
      if (forecast.asOf > series.decisionCutoff || forecast.asOf > forecast.generatedAt || forecast.validUntil <= series.decisionCutoff || forecast.validUntil > series.scheduledStartAt || forecast.sourceObservedAt.some(t => t > forecast.asOf)) reasons.push('forecast-chronology-invalid')
      if (forecast.evidenceMode === 'prospective' && forecast.generatedAt > series.decisionCutoff) reasons.push('forecast-not-available-at-cutoff')
      if (forecast.calibrationFit && (forecast.calibrationFit.endsAt >= forecast.asOf || forecast.calibrationFit.endsAt >= config.frozenAt || forecast.calibrationFit.seriesIds.some(id => seriesIds.has(id)))) reasons.push('calibration-overlaps-evaluation')
    }
    if (resultRows.length !== 1) reasons.push(resultRows.length ? 'duplicate-series-result' : 'missing-result')
    if (result) {
      if (!matchesIdentity(result, series)) reasons.push('result-identity-mismatch')
      if (result.evidenceMode !== config.evidenceMode) reasons.push('result-evidence-mode-mismatch')
      if (result.completedAt < series.scheduledStartAt || result.completedAt <= series.decisionCutoff) reasons.push('result-chronology-invalid')
      if (result.resultAvailableAt > config.scoringAsOf) reasons.push('result-not-available-for-scoring')
    }
    const candidates = quotes.filter(q => q.seriesId === series.seriesId && q.bookmaker === config.bookmaker)
    const known = candidates.filter(q => q.eventId === series.eventId && q.evidenceMode === config.evidenceMode && q.observedAt < series.decisionCutoff)
    const latestObservation = known.reduce((latest, q) => Math.max(latest, q.observedAt), -1)
    if (known.some(q => q.observedAt === latestObservation && (q.scheduleRevision !== series.scheduleRevision || q.scheduledStartAt !== series.scheduledStartAt || q.bestOf !== series.bestOf))) reasons.push('schedule-changed-before-cutoff')
    const available: RetainedBookmakerQuote[] = []
    for (const quote of candidates) {
      const rejected: string[] = []
      if (quote.eventId !== series.eventId || quote.bestOf !== series.bestOf || quote.scheduleRevision !== series.scheduleRevision || quote.scheduledStartAt !== series.scheduledStartAt) rejected.push('quote-identity-mismatch')
      if (quote.quotedAt >= series.decisionCutoff || quote.observedAt >= series.decisionCutoff) rejected.push('quote-after-cutoff')
      if (series.decisionCutoff - quote.quotedAt > config.maxQuoteAgeMs) rejected.push('quote-stale')
      if (quote.evidenceMode !== config.evidenceMode) rejected.push('quote-evidence-mode-mismatch')
      quoteAudit.push({ seriesId: series.seriesId, quoteId: quote.quoteId, reasons: rejected })
      if (!rejected.length) available.push(quote)
    }
    available.sort((a, b) => b.observedAt - a.observedAt)
    const quote = available[0]
    if (!quote) reasons.push(candidates.length ? 'no-eligible-quote' : 'missing-quote')
    else {
      if (available.filter(q => q.observedAt === quote.observedAt).length > 1) reasons.push('ambiguous-simultaneous-quotes')
      const teams = quote.outcomes.map(o => o.teamId)
      if (teams.length !== 2 || new Set(teams).size !== 2 || !teams.includes(series.homeTeamId) || !teams.includes(series.awayTeamId)) reasons.push('quote-outcome-identity-mismatch')
      if (quote.outcomes.length !== 2 || quote.outcomes.some(o => o.decimalOdds === null || o.decimalOdds <= 1)) reasons.push('quote-incomplete-odds')
    }
    denominator.push({ seriesId: series.seriesId, eventId: series.eventId, included: reasons.length === 0, reasons: [...new Set(reasons)].sort() })
    if (reasons.length || !forecast || !result || !quote) continue
    const homeOdds = quote.outcomes.find(o => o.teamId === series.homeTeamId)!.decimalOdds!
    const awayOdds = quote.outcomes.find(o => o.teamId === series.awayTeamId)!.decimalOdds!
    const impliedSum = 1 / homeOdds + 1 / awayOdds
    const bookmakerProbability = (1 / homeOdds) / impliedSum
    const homeWon = result.winnerTeamId === series.homeTeamId
    const model = losses(forecast.homeSeriesWinProbability, homeWon)
    const bookmaker = losses(bookmakerProbability, homeWon)
    paired.push({ seriesId: series.seriesId, eventId: series.eventId, homeTeamId: series.homeTeamId, awayTeamId: series.awayTeamId, decisionCutoff: series.decisionCutoff, winnerTeamId: result.winnerTeamId, homeWon, evidenceMode: config.evidenceMode, quoteId: quote.quoteId, quoteObservedAt: quote.observedAt, quoteQuotedAt: quote.quotedAt, quoteAgeMs: series.decisionCutoff - quote.quotedAt, overround: impliedSum - 1, modelProbability: forecast.homeSeriesWinProbability, bookmakerProbability, model, bookmaker, modelMinusBookmaker: { brier: model.brier - bookmaker.brier, logLoss: model.logLoss - bookmaker.logLoss } })
  }
  const clusters = [...new Set(paired.map(row => row.eventId))].sort().map(eventId => {
    const rows = paired.filter(row => row.eventId === eventId)
    return { eventId, seriesIds: rows.map(row => row.seriesId), model: metrics(rows, 'model'), bookmaker: metrics(rows, 'bookmaker'), modelMinusBookmaker: metrics(rows, 'modelMinusBookmaker') }
  })
  return {
    schemaVersion: 'lol-bookmaker-comparison-v1', comparisonId: config.comparisonId, evidenceMode: config.evidenceMode,
    status: 'descriptive-predictive-comparison', freshEvidenceClaim: false, portfolioProfitClaim: false,
    policy: { normalization: 'multiplicative-no-vig', quoteSelection: 'latest-observed-strictly-before-cutoff', maxQuoteAgeMs: config.maxQuoteAgeMs, logLossClippingEpsilon: epsilon, brier: 'binary-home-outcome', delta: 'model-minus-bookmaker; negative favors model', uncertainty: 'event-cluster-descriptive-only; no confidence or significance claim', quoteUse: 'predictive-reference; not executable-fill-evidence', frozenAt: config.frozenAt, scoringAsOf: config.scoringAsOf },
    counts: { universe: denominator.length, paired: paired.length, excluded: denominator.length - paired.length, eventClusters: clusters.length, inputForecasts: forecasts.length, inputResults: results.length, inputQuotes: quotes.length },
    denominator, paired,
    model: metrics(paired, 'model'), bookmaker: metrics(paired, 'bookmaker'), modelMinusBookmaker: metrics(paired, 'modelMinusBookmaker'),
    calibration: { model: bins(paired, 'modelProbability', config.calibrationBinEdges), bookmaker: bins(paired, 'bookmakerProbability', config.calibrationBinEdges) },
    eventClusters: clusters,
    equalEventMeanDelta: { brier: mean(clusters.map(c => c.modelMinusBookmaker.brier!)), logLoss: mean(clusters.map(c => c.modelMinusBookmaker.logLoss!)) },
    quoteAudit: quoteAudit.sort((a, b) => a.quoteId < b.quoteId ? -1 : a.quoteId > b.quoteId ? 1 : 0),
    outsideUniverse: { forecastSeriesIds: [...new Set(forecasts.filter(f => !seriesIds.has(f.seriesId)).map(f => f.seriesId))].sort(), resultSeriesIds: [...new Set(results.filter(r => !seriesIds.has(r.seriesId)).map(r => r.seriesId))].sort(), quoteIds: quotes.filter(q => !seriesIds.has(q.seriesId) || q.bookmaker !== config.bookmaker).map(q => q.quoteId).sort() },
  }
}
