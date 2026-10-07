export const INCREMENTAL_SAFETY_PEAK_RSS_BYTES = 700 * 1024 * 1024

/**
 * Incremental refresh time in runner-calibration units: computeMs divided by the
 * median calibration workload duration on the same runner. A wall-clock limit
 * cannot gate GitHub-hosted runners, whose speed for this workload varies about
 * 1.9x for identical code. The limit is 1.4x measured main; see
 * docs/incremental-gate-runner-calibration.md before changing it.
 */
export const INCREMENTAL_NORMALIZED_COMPUTE_LIMIT = 6.5

/**
 * Normalizes each repetition's computeMs by the median calibration duration and
 * applies the strict limit to every repetition. Empty, zero, negative, or
 * non-finite durations fail closed.
 */
export function evaluateIncrementalCompute(repetitions: readonly { computeMs: number; calibrationMs: number }[]) {
  const calibrations = repetitions.map(({ calibrationMs }) => calibrationMs).sort((left, right) => left - right)
  // Odd counts read the same middle value twice; even counts average the two middle values.
  const calibrationMedianMs = calibrations.length === 0
    ? Number.NaN
    : (calibrations[Math.floor((calibrations.length - 1) / 2)]! + calibrations[Math.floor(calibrations.length / 2)]!) / 2
  const normalized = repetitions.map(({ computeMs }) => computeMs / calibrationMedianMs)
  const validInput = repetitions.length > 0 && repetitions.every(({ computeMs, calibrationMs }) =>
    Number.isFinite(computeMs) && computeMs > 0 && Number.isFinite(calibrationMs) && calibrationMs > 0)
  return {
    calibrationMedianMs,
    normalized,
    pass: validInput && normalized.every((value) => value < INCREMENTAL_NORMALIZED_COMPUTE_LIMIT),
  }
}

export type BenchmarkNumericMetrics = {
  computeMs: number
  restoreDurationMs: number
  sampledPeakRssBytes: number
  mainMaxRssBytes: number
  rawChildMaxRssBytes: number
  uploadedBytes: number
}

export function passesIncrementalSafetyPeak(peakRssBytes: number) {
  return peakRssBytes < INCREMENTAL_SAFETY_PEAK_RSS_BYTES
}

export function oracleBaselineRewriteEvidence({
  priorBaselineKeys,
  activeBaselineKeys,
  uploadedObjectKeys,
}: {
  priorBaselineKeys: readonly string[]
  activeBaselineKeys: readonly string[]
  uploadedObjectKeys: readonly string[]
}) {
  const prior = [...priorBaselineKeys].sort()
  const active = [...activeBaselineKeys].sort()
  const activeSet = new Set(active)
  const baselineKeysUnchanged = prior.length === active.length
    && prior.every((key, index) => key === active[index])
  const uploadedOracleBaselineKeys = [...new Set(uploadedObjectKeys.filter((key) => activeSet.has(key)))].sort()
  return {
    priorBaselineKeys: prior,
    activeBaselineKeys: active,
    baselineKeysUnchanged,
    uploadedOracleBaselineKeys,
    fullRawRewrite: !baselineKeysUnchanged || uploadedOracleBaselineKeys.length > 0,
  }
}

export function aggregateBenchmarkMetrics(entries: readonly BenchmarkNumericMetrics[]) {
  if (entries.length === 0) throw new Error('Benchmark aggregation requires at least one repetition')
  const metrics: Array<keyof BenchmarkNumericMetrics> = [
    'computeMs',
    'restoreDurationMs',
    'sampledPeakRssBytes',
    'mainMaxRssBytes',
    'rawChildMaxRssBytes',
    'uploadedBytes',
  ]
  const median = {} as BenchmarkNumericMetrics
  const max = {} as BenchmarkNumericMetrics
  for (const metric of metrics) {
    const values = entries.map((entry) => entry[metric]).sort((left, right) => left - right)
    median[metric] = values[Math.floor(values.length / 2)]!
    max[metric] = values.at(-1)!
  }
  return { median, max }
}
