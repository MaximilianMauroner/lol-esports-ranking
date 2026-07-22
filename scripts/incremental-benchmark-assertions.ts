export const INCREMENTAL_SAFETY_PEAK_RSS_BYTES = 700 * 1024 * 1024

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
