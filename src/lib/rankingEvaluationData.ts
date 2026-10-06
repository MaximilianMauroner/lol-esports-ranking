import type { MatchRecord, PregamePrediction } from '../types'
import { binaryMetricContract } from './binaryPredictionMetrics'
import { evaluationBaselineProbabilities } from './evaluationBaselines'
import { canonicalSeriesForMatches, resolveCanonicalSeries } from './seriesResolver'
import { seriesWinProbability } from './winProbability'
import { groupEvaluationBy, summarizeEvaluation, type EvaluationExport, type EvaluationRow } from './rankingEvaluation'

export function evaluationEventId(match: MatchRecord) {
  return `${match.season}:${match.league}:${match.event}`
}

/** Explicit match-time membership only. Latest team profiles are not temporal evidence. */
export function evaluationHomeLeague(match: MatchRecord, side: 'A' | 'B') {
  return (side === 'A' ? match.teamAHomeLeague : match.teamBHomeLeague) ?? 'Unknown'
}

export function buildEvaluationData(matches: MatchRecord[], predictions: PregamePrediction[], {
  sourceIdentity, scoreStart = '0000-01-01',
}: { sourceIdentity: string; scoreStart?: string }) {
  const matchById = new Map(matches.map((match) => [match.id, match]))
  const series = canonicalSeriesForMatches(matches)
  const controls = evaluationBaselineProbabilities(matches)
  const rows: EvaluationRow[] = []
  const variants = new Map<string, EvaluationRow[]>()
  const missing: string[] = []
  for (const prediction of predictions) {
    const match = matchById.get(prediction.id)
    if (!match) throw new Error('Prediction has no source match')
    if (match.date < scoreStart) continue
    if (match.winner !== match.teamA && match.winner !== match.teamB) { missing.push(match.id); continue }
    const actual = match.winner === match.teamA ? 1 : 0
    const row: EvaluationRow = { id: match.id, seriesId: series.get(match.id)?.id ?? match.id,
      eventId: evaluationEventId(match), date: match.date, teamA: match.teamA, teamB: match.teamB,
      leagueA: evaluationHomeLeague(match, 'A'), leagueB: evaluationHomeLeague(match, 'B'), actual,
      probability: prediction.teamAGameWinProbability, segments: [...prediction.segments].sort() }
    rows.push(row)
    for (const [key, probability] of Object.entries({ ...controls.get(match.id),
      teamOnly: prediction.teamAGameWinProbabilityTeamOnly, playerAdjusted: prediction.teamAGameWinProbabilityPlayerAdjusted })) {
      if (probability !== undefined) {
        const values = variants.get(key) ?? []
        values.push({ ...row, probability }); variants.set(key, values)
      }
    }
  }
  const identity = { schemaVersion: 1, target: 'game',
    modelVersion: predictions[0]?.modelVersion ?? 'unavailable', modelConfigHash: predictions[0]?.modelConfigHash ?? 'unavailable',
    sourceIdentity, temporalPolicy: 'latest-corrected-prior-replay', metricContract: binaryMetricContract } as const
  const exportData: EvaluationExport = { ...identity, rows }
  const seriesRows: EvaluationRow[] = []
  const seriesExclusions: Array<{ id: string; reason: string }> = []
  const predictionById = new Map(predictions.map((prediction) => [prediction.id, prediction]))
  for (const item of resolveCanonicalSeries(matches)) {
    if (item.date < scoreStart) continue
    const first = item.games[0]
    const prediction = predictionById.get(first.id)
    if (item.state !== 'completed' || item.format === 2 || !prediction) {
      seriesExclusions.push({ id: item.id, reason: item.format === 2 ? 'bo2-is-not-binary-series-target' : 'incomplete-or-missing-prediction' }); continue
    }
    const row = rows.find((candidate) => candidate.id === first.id)
    if (!row) continue
    seriesRows.push({ ...row, id: item.id, seriesId: item.id,
      actual: (item.outcomeA === 1) === (first.teamA === item.teamA) ? 1 : 0,
      probability: seriesWinProbability(prediction.teamAGameWinProbability, item.format) })
  }
  return { ...exportData, scoreStart, seriesExport: { ...identity, target: 'series' as const, rows: seriesRows },
    variants: Object.fromEntries([...variants].map(([key, variantRows]) => [key, { ...identity, modelVersion: key, rows: variantRows }])),
    summaries: { current: summarizeEvaluation(rows), ...Object.fromEntries([...variants].map(([key, variantRows]) => [key, summarizeEvaluation(variantRows)])) },
    exclusions: { missingOutcome: missing, series: seriesExclusions }, audit: auditEvaluationMatches(matches, scoreStart),
    informationAvailability: { status: 'unknown', reason: 'source-observation-archives-not-supplied',
      sameDayPolicy: 'current-engine-causal-series-batching; controls-freeze-whole-UTC-date', publishedForecastEvidence: false } }
}

export function auditEvaluationMatches(matches: MatchRecord[], scoreStart: string) {
  const scored = matches.filter((match) => match.date >= scoreStart)
  const series = resolveCanonicalSeries(scored)
  return { normalizedGames: scored.length, warmupGames: matches.length - scored.length,
    duplicateNormalizedIds: scored.length - new Set(scored.map((match) => match.id)).size,
    unresolvedSeries: series.filter((item) => item.state !== 'completed').length,
    lowConfidenceFormats: series.filter((item) => item.formatConfidence === 'low').length,
    leagues: [...groupEvaluationBy(scored, (match) => `${match.season}:${match.league}`)].map(([leagueSeason, games]) => ({
      leagueSeason, games: games.length,
      unknownHomeMembership: games.filter((match) => !match.teamAHomeLeague || !match.teamBHomeLeague).length,
      unknownPatch: games.filter((match) => !match.patch).length,
      missingLineups: games.filter((match) => !match.teamARoster || !match.teamBRoster).length,
      sourceProviders: [...new Set(games.map((match) => match.sourceProvider ?? 'unknown'))].sort() })),
    coverageCompleteness: { status: 'unknown', reason: 'no-complete-independent-game-ledger-supplied' },
    historicalAvailability: { status: 'unknown', reason: 'latest-corrected-downloads-do-not-prove-as-published-inputs' } }
}
