import assert from 'node:assert/strict'
import test from 'node:test'
import { costForUsage, createRailwayCostReport, parseRailwayCostReport, RAILWAY_PRICING_VERIFIED_AT, RAILWAY_RATES } from '../scripts/railway-cost-report.mjs'
import { rolloutEvidence } from './rolloutTestFixtures.ts'

test('Railway report uses the verified exact rates and never changes unknown measurement to zero', () => {
  assert.equal(RAILWAY_PRICING_VERIFIED_AT, '2026-07-23')
  assert.deepEqual(RAILWAY_RATES, {
    memoryGbSecond: 0.00000386,
    cpuVcpuSecond: 0.00000772,
    volumeGbSecond: 0.00000006,
    serviceEgressGb: 0.05,
    bucketGbMonth: 0.015,
    bucketOperations: 0,
    bucketEgressGb: 0,
    hobbyMinimum: 5,
    hobbyIncludedUsage: 5,
  })
  const recorded = createRailwayCostReport({ recordedAt: '2026-07-23T00:00:00.000Z' })
  assert.equal(recorded.recordedAt, '2026-07-23T00:00:00.000Z')
  assert.throws(() => createRailwayCostReport({ recordedAt: 'not-a-date' }), /recordedAt/)
  const unknown = costForUsage({ cpuSeconds: 1 })
  assert.equal(unknown.usage.memoryGbSeconds, null)
  assert.equal(unknown.totalUsage, null)
  assert.equal(unknown.hobbyBilled, null)
})

test('authoritative native cost report has a strict timestamped evidence schema', () => {
  const report = createRailwayCostReport({
    commit: 'abc123',
    deploymentId: 'deployment-1',
    runId: 'cost-1',
    evidenceClass: 'live',
    recordedAt: '2026-07-23T00:00:00.000Z',
    expiresAt: '2026-08-01T00:00:00.000Z',
    measured: { cpuSeconds: 1, memoryGbSeconds: 2, serviceEgressGb: 3, bucketGbMonths: 4 },
  })
  assert.equal(parseRailwayCostReport(report), report)
  assert.throws(() => parseRailwayCostReport({ ...report, recordedAt: '2026-07-23T00:00:00Z' }), /recordedAt/)
  assert.throws(() => parseRailwayCostReport({ ...report, measured: { totalUsage: 1 } }), /measured Railway cost/)
})

test('cost report separates resources and usage, applies Hobby minimum and warnings, and marks service uploads as egress', () => {
  const low = costForUsage({ cpuSeconds: 0, memoryGbSeconds: 0, serviceEgressGb: 0, bucketGbMonths: 0 })
  assert.equal(low.resourceCost, 0)
  assert.equal(low.usageCost, 0)
  assert.equal(low.hobbyBilled, 5)
  const near = costForUsage({ cpuSeconds: 0, memoryGbSeconds: 0, serviceEgressGb: 80, bucketGbMonths: 0 })
  assert.equal(near.warning, 'approaching-hobby-included-usage')
  const over = costForUsage({ cpuSeconds: 0, memoryGbSeconds: 0, serviceEgressGb: 101, bucketGbMonths: 0 })
  assert.equal(over.warning, 'over-hobby-included-usage')
  assert.equal(costForUsage({ cpuSeconds: 0, memoryGbSeconds: 0, serviceEgressGb: 0, bucketGbMonths: 0.01 }).usage.bucketGbMonths, 1)
})

test('monthly projections scale run resources with corpus growth and reject fixture/arbitrary marginals', () => {
  const report = createRailwayCostReport({
    model: {
      current: { corpusGb: 10, runsPerMonth: 100, storageGb: 20, perRun: { cpuSeconds: 1, memoryGbSeconds: 2, serviceEgressGb: 0 } },
      annualGrowth: { corpus: 0.1, runs: 0.2, storage: 0.3 },
    },
    evidence: [rolloutEvidence()],
    marginals: { oneMatch: { cpuSeconds: 999, memoryGbSeconds: 999, serviceEgressGb: 999, bucketGbMonths: 999 } },
  })
  assert.deepEqual(report.monthly.map((entry) => entry.year), [2026, 2027, 2028])
  assert.deepEqual(report.monthly.map((entry) => entry.period), ['current', '2027', '2028'])
  assert.equal(report.monthly[1].assumptions.corpusGb, 11)
  assert.equal(report.monthly[1].assumptions.runsPerMonth, 120)
  assert.equal(report.monthly[1].assumptions.storageGb, 26)
  assert.equal(report.monthly[1].usage.cpuSeconds, 132)
  assert.equal(report.marginals.oneMatch.status, 'unknown')
  assert.equal(report.marginals.unchangedProbe.status, 'unknown')
  assert.match(report.pricing.notes.serviceUploads, /egress/)
})

test('live run marginals keep unmeasured bucket storage explicitly partial', () => {
  const report = createRailwayCostReport({
    evidence: [
      rolloutEvidence({ evidenceClass: 'live' }),
      rolloutEvidence({ evidenceClass: 'live', scenario: 'unchanged', runId: 'unchanged-live' }),
    ],
  })
  assert.equal(report.marginals.oneMatch.status, 'partial')
  assert.equal(report.marginals.oneMatch.reason, 'bucket-storage-attribution-missing')
  assert.equal(report.marginals.oneMatch.usage.bucketGbMonths, null)
  assert.equal(report.marginals.unchangedProbe.status, 'partial')
  assert.equal(report.marginals.unchangedProbe.usage.bucketGbMonths, null)
})
