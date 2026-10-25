import { createHash } from 'node:crypto'
import { createReplayEvidence } from '../../../src/domains/rankings/build.ts'
import { evaluationEventId, evaluationHomeLeague, requireReplayDate } from '../../../src/domains/rankings/published-read.ts'
import type { createRatingReplayContext } from '../../../src/domains/rankings/build.ts'
import { compareCodeUnits } from '../../../src/shared/codeUnitOrder.mjs'
import { canonicalTeamNameFor } from '../../../src/domains/rankings/evidence.ts'
import type { MatchRecord, PregamePrediction, TeamProfile } from '../../../src/domains/rankings/types.ts'
import { binaryMetricContract } from '../../../src/domains/rankings/read.ts'
import { evaluationBaselineProbabilities } from './evaluationBaselines.ts'
import { canonicalSeriesForMatches, canonicalSeriesOutcomeForTeam, resolveCanonicalSeries } from '../../../src/domains/rankings/evidence.ts'
import { seriesWinProbability } from '../../../src/domains/rankings/read.ts'
import { groupEvaluationBy, summarizeEvaluation, type EvaluationExport, type EvaluationRow, type ReplayInputDigest } from './rankingEvaluation.ts'

export type ReplayInputs = {
  matches: MatchRecord[]
  teams: Record<string, TeamProfile>
  tournamentLifecycles: {
    generatedAt: string
    byId: ReturnType<typeof createRatingReplayContext>['tournamentLifecycles']
  } | null
}

export function requireEvaluationGeneratedAt(input: unknown): string {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input)
    || !Number.isFinite(Date.parse(input))
    || new Date(`${input.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== input.slice(0, 10)) {
    throw new Error('Accuracy export requires valid explicit manifest generatedAt')
  }
  return input
}

export function replayInputDigest(replays: readonly ReplayInputs[]): ReplayInputDigest {
  const payload = replays.map((replay) => ({
    matches: replay.matches,
    teams: Object.entries(replay.teams),
    tournamentLifecycles: replay.tournamentLifecycles === null ? null : {
      generatedAt: requireEvaluationGeneratedAt(replay.tournamentLifecycles.generatedAt),
      byId: [...replay.tournamentLifecycles.byId].sort(([a], [b]) => compareCodeUnits(a, b)),
    },
  }))
  const active = new Set<object>()
  function encode(value: unknown): string {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
    if (typeof value !== 'object' || !value || active.has(value)) throw new Error('Invalid replay-input encoding')
    active.add(value)
    let encoded: string
    if (Array.isArray(value)) encoded = `[${Array.from(value, (item) => encode(item)).join(',')}]`
    else {
      if ((Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
        || Object.getOwnPropertySymbols(value).length) throw new Error('Invalid replay-input object')
      encoded = `{${Object.entries(value).sort(([a], [b]) => compareCodeUnits(a, b)).filter(([, item]) => item !== undefined)
        .map(([key, item]) => `${JSON.stringify(key)}:${encode(item)}`).join(',')}}`
    }
    active.delete(value)
    return encoded
  }
  return `replay-inputs/v1:${createHash('sha256').update('lol-replay-inputs/v1\n').update(encode(payload)).digest('hex')}`
}

export { evaluationEventId, evaluationHomeLeague } from '../../../src/domains/rankings/published-read.ts'

export function buildEvaluationData(replay: ReplayInputs, predictions: PregamePrediction[], {
  sourceIdentity, scoreStart = '0000-01-01',
}: { sourceIdentity: string; scoreStart?: string }) {
  requireReplayDate(scoreStart)
  const { matches } = replay
  const replayEvidence = createReplayEvidence({ matches, predictions,
    model: { version: predictions[0]?.modelVersion ?? 'unavailable', configHash: predictions[0]?.modelConfigHash ?? 'unavailable' },
    dataMode: matches.some((match) => match.sourceProvider === 'seed') ? 'seeded-sample' : 'scheduled-public-data' })
  const replayInputs = replayInputDigest([replay])
  const canonicalMatches = matches.map((match) => ({ ...match,
    teamA: canonicalTeamNameFor(match.teamA), teamB: canonicalTeamNameFor(match.teamB), winner: canonicalTeamNameFor(match.winner) }))
  const matchById = new Map(canonicalMatches.map((match) => [match.id, match]))
  const series = canonicalSeriesForMatches(canonicalMatches)
  const controls = evaluationBaselineProbabilities(canonicalMatches)
  const rows: EvaluationRow[] = []
  const variants = new Map<string, EvaluationRow[]>()
  const missing: string[] = []
  for (const prediction of predictions) {
    const match = matchById.get(prediction.id)!
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
  if (rows.length === 0) throw new Error('Replay score window has no binary outcomes')
  const identity = { schemaVersion: 2, replayInputs, target: 'game',
    modelVersion: predictions[0]?.modelVersion ?? 'unavailable', modelConfigHash: predictions[0]?.modelConfigHash ?? 'unavailable',
    sourceIdentity, temporalPolicy: 'latest-corrected-prior-replay', metricContract: binaryMetricContract } as const
  const exportData: EvaluationExport = { ...identity, rows }
  const seriesRows: EvaluationRow[] = []
  const seriesExclusions: Array<{ id: string; reason: string }> = []
  const predictionById = new Map(predictions.map((prediction) => [prediction.id, prediction]))
  for (const item of resolveCanonicalSeries(canonicalMatches)) {
    if (item.date < scoreStart) continue
    const first = item.games[0]
    const prediction = predictionById.get(first.id)
    if (item.state !== 'completed' || item.format === 2 || !prediction) {
      seriesExclusions.push({ id: item.id, reason: item.format === 2 ? 'bo2-is-not-binary-series-target' : 'incomplete-or-missing-prediction' }); continue
    }
    const row = rows.find((candidate) => candidate.id === first.id)
    if (!row) continue
    const actual = canonicalSeriesOutcomeForTeam(item, row.teamA)
    if (actual !== 0 && actual !== 1) throw new Error(`Non-binary series outcome for ${item.id}`)
    seriesRows.push({ ...row, id: item.id, seriesId: item.id,
      actual,
      probability: seriesWinProbability(prediction.teamAGameWinProbability, item.format) })
  }
  return { ...exportData, scoreStart, seriesExport: { ...identity, target: 'series' as const, rows: seriesRows },
    variants: Object.fromEntries([...variants].map(([key, variantRows]) => [key, { ...identity, modelVersion: key, rows: variantRows }])),
    summaries: { current: summarizeEvaluation(rows), ...Object.fromEntries([...variants].map(([key, variantRows]) => [key, summarizeEvaluation(variantRows)])) },
    exclusions: { missingOutcome: missing, series: seriesExclusions }, audit: auditEvaluationMatches(matches, scoreStart),
    replayEvidence,
    informationAvailability: replayEvidence.informationAvailability }
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
