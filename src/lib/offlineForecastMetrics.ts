import { binaryMetricContract, binaryPredictionLoss } from './binaryPredictionMetrics'
import type { OfflineCohortResult } from './offlineForecastCohort'

type Cohort = Extract<OfflineCohortResult, { status: 'replayed' }>
type Row = Cohort['rows'][number]

/** Already computed synthetic series baselines; never reconstruct them from outcomes. */
export type SyntheticBaselineFixture = {
  key: string
  modelVersion: string
  modelConfigHash: string
  evidence: { kind: 'synthetic-fixture'; reference: string }
  rows: Array<{ receiptKey: string; homeWinProbability: number; informationAsOf: string }>
}

/** Offline numerical references only. This does not certify published calibration. */
export function summarizeOfflineForecastMetrics(cohort: OfflineCohortResult, baselines: SyntheticBaselineFixture[] = []) {
  if (cohort.status !== 'replayed') return cohort
  // A replay has one home-oriented row per series. Reject accidental duplicated sides/revisions.
  if (new Set(cohort.rows.map((row) => row.matchId)).size !== cohort.rows.length
    || new Set(cohort.rows.map((row) => row.receiptKey)).size !== cohort.rows.length
    || cohort.rows.some((row) => !validProbability(row.homeWinProbability))) {
    return { status: 'unsupported', reason: 'invalid-series-cohort' } as const
  }
  if (new Set(baselines.map((baseline) => baseline.key)).size !== baselines.length
    || baselines.some((baseline) => !baseline.key.trim() || baseline.key === 'coin-flip'
      || !baseline.modelVersion.trim() || !baseline.modelConfigHash.trim()
      || baseline.evidence?.kind !== 'synthetic-fixture' || !baseline.evidence.reference.trim())) {
    return { status: 'unsupported', reason: 'invalid-baseline-fixtures' } as const
  }
  const comparisons = baselines.map((baseline) => {
    const paired: Row[] = []
    const probabilities: number[] = []
    const exclusions: Array<{ receiptKey: string; reason: 'missing' | 'conflicting' | 'invalid-probability' | 'after-information-cutoff' }> = []
    for (const row of cohort.rows) {
      const candidates = baseline.rows.filter((candidate) => candidate.receiptKey === row.receiptKey)
      let reason: (typeof exclusions)[number]['reason'] | undefined
      const candidate = candidates[0]
      if (!candidate) reason = 'missing'
      else if (candidates.slice(1).some((other) => !Object.is(other.homeWinProbability, candidate.homeWinProbability)
        || other.informationAsOf !== candidate.informationAsOf)) reason = 'conflicting'
      else if (!validProbability(candidate.homeWinProbability)) reason = 'invalid-probability'
      else if (!Number.isFinite(Date.parse(candidate.informationAsOf))
        || Date.parse(candidate.informationAsOf) > Date.parse(row.publishedAt)) reason = 'after-information-cutoff'
      if (reason) exclusions.push({ receiptKey: row.receiptKey, reason })
      else { paired.push(row); probabilities.push(candidate.homeWinProbability) }
    }
    return { key: baseline.key, modelVersion: baseline.modelVersion, modelConfigHash: baseline.modelConfigHash,
      evidenceReference: baseline.evidence.reference,
      ...comparison(paired, probabilities), exclusions,
      unmatchedBaselineRows: baseline.rows.filter((row) => !cohort.rows.some((candidate) => candidate.receiptKey === row.receiptKey)).length }
  })
  const bins = Array.from({ length: 10 }, (_, index) => {
    const rows = cohort.rows.filter((row) => Math.min(9, Math.floor(row.homeWinProbability * 10)) === index)
    return { lowerInclusive: index / 10, upper: (index + 1) / 10, upperInclusive: index === 9,
      count: rows.length, meanPredicted: mean(rows.map((row) => row.homeWinProbability)),
      observedWinRate: mean(rows.map((row) => Number(row.homeWon))) }
  })
  return {
    status: 'summarized', target: 'series', sourceType: cohort.sourceType, evaluationEligible: false,
    evidenceReference: cohort.evidenceReference, policy: cohort.policy, metricContract: binaryMetricContract,
    calibration: cohort.calibration,
    uncertainty: { status: 'unsupported', reason: 'event-aware-intervals-deferred' },
    cohortExclusions: cohort.exclusions, duplicateOutcomeRows: cohort.duplicateOutcomeRows,
    afterCutoffOutcomeRows: cohort.afterCutoffOutcomeRows,
    seriesCount: cohort.rows.length, eventCount: new Set(cohort.rows.map((row) => row.eventId)).size,
    receiptKeys: cohort.rows.map((row) => row.receiptKey), metrics: summary(cohort.rows), bins,
    baselineComparisons: [{ key: 'coin-flip', ...comparison(cohort.rows, cohort.rows.map(() => 0.5)), exclusions: [], unmatchedBaselineRows: 0 }, ...comparisons],
  } as const
}

function comparison(rows: Row[], probabilities: number[]) {
  const forecast = summary(rows)
  const baseline = summary(rows, probabilities)
  return { pairedCount: rows.length, receiptKeys: rows.map((row) => row.receiptKey), forecast, baseline,
    // Existing walk-forward convention: positive means forecast has lower loss.
    forecastBrierImprovement: difference(baseline.brierScore, forecast.brierScore),
    forecastLogLossImprovement: difference(baseline.logLoss, forecast.logLoss) }
}

function summary(rows: Row[], probabilities = rows.map((row) => row.homeWinProbability)) {
  const losses = rows.map((row, index) => binaryPredictionLoss(probabilities[index], row.homeWon))
  return { count: rows.length, brierScore: mean(losses.map((loss) => loss.brierScore)),
    logLoss: mean(losses.map((loss) => loss.logLoss)),
    impossibleOutcomeCount: rows.filter((row, index) => row.homeWon ? probabilities[index] === 0 : probabilities[index] === 1).length }
}

function validProbability(value: number) { return Number.isFinite(value) && value >= 0 && value <= 1 }
function mean(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null }
function difference(a: number | null, b: number | null) { return a === null || b === null ? null : a - b }
