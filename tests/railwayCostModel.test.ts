import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calculateAttemptCost,
  classifyAttemptOutcome,
  decideIncrementalCostGate,
  modelVolumeLedgerFromBucket,
  projectMonthlyCost,
  railwayRates,
  type AttemptLedger,
} from '../scripts/railway-cost-model.ts'

function ledger(overrides: Partial<AttemptLedger> = {}): AttemptLedger {
  return {
    workflow: 'incremental-bucket',
    evidence: 'measured',
    outcome: 'changed',
    provenance: 'unit-test',
    phases: {
      crunch: {
        durationSeconds: 60,
        vcpuSeconds: 60,
        rssByteSeconds: 60_000_000_000,
        peakRssBytes: 9_000_000_000,
        serviceUploadBytes: { privateCache: 1_000_000_000, publicPayload: 0, rawAuthority: 0, metadata: 0 },
        bucketDownloadBytes: 99_000_000_000,
      },
    },
    retainedBytes: { bucketAuthoritative: 1_000_000_000, bucketPrivate: 1_000_000_000, volumePrivate: 0 },
    ...overrides,
  }
}

test('Railway cost uses integrated CPU/RAM, paid uploads, and retained storage only', () => {
  const cost = calculateAttemptCost(ledger())
  assert.equal(cost.cpuUsd, railwayRates.cpuUsdPerVcpuMinute)
  assert.equal(cost.ramUsd, railwayRates.ramUsdPerGbMinute)
  assert.equal(cost.serviceEgressUsd, railwayRates.serviceEgressUsdPerGb)
  assert.equal(cost.objectStorageUsdPerMonth, railwayRates.objectStorageUsdPerGbMonth * 2)
  assert.equal(cost.volumeUsdPerMonth, 0)
  assert.equal(cost.variableUsd, cost.cpuUsd + cost.ramUsd + cost.serviceEgressUsd)
})

test('monthly projection handles zero publishes without division by zero', () => {
  const projection = projectMonthlyCost(calculateAttemptCost(ledger()), { attemptsPerMonth: 30, outcomeProbability: 1, publishProbability: 0 })
  assert.equal(projection.projectedPublishes, 0)
  assert.equal(projection.costPerPublishUsd, null)
  assert.equal(projection.monthlyVariableUsd, projection.variableUsd * 30)
})

test('dollar gate keeps only at both exact savings boundaries and lower monthly total', () => {
  const full = projectMonthlyCost({ ...calculateAttemptCost(ledger()), variableUsd: 0.0075 }, { attemptsPerMonth: 30, outcomeProbability: 1, publishProbability: 1 })
  const incremental = { ...projectMonthlyCost({ ...calculateAttemptCost(ledger()), variableUsd: 0.006 }, { attemptsPerMonth: 30, outcomeProbability: 1, publishProbability: 1 }), monthlyTotalUsd: full.monthlyTotalUsd - 0.001 }
  const decision = decideIncrementalCostGate({ full, incremental, measuredPairs: 5, nodeMajor: 22, fullProductionCorpus: true })
  assert.equal(decision.decision, 'keep-incremental')
  assert.ok(Math.abs(decision.changedRunSavingsFraction - 0.2) < 1e-12)
  assert.ok(Math.abs(decision.changedRunSavingsUsd - 0.0015) < 1e-12)
})

test('dollar gate removes when any economic condition misses', () => {
  const full = projectMonthlyCost({ ...calculateAttemptCost(ledger()), variableUsd: 0.0075 }, { attemptsPerMonth: 30, outcomeProbability: 1, publishProbability: 1 })
  const incremental = { ...projectMonthlyCost({ ...calculateAttemptCost(ledger()), variableUsd: 0.006 }, { attemptsPerMonth: 30, outcomeProbability: 1, publishProbability: 1 }), monthlyTotalUsd: full.monthlyTotalUsd }
  assert.equal(decideIncrementalCostGate({ full, incremental, measuredPairs: 5, nodeMajor: 22, fullProductionCorpus: true }).decision, 'remove-incremental')
})

test('production decision requires five pairs, Node 22, and the full corpus', () => {
  const full = projectMonthlyCost({ ...calculateAttemptCost(ledger()), variableUsd: 1 }, { attemptsPerMonth: 1, outcomeProbability: 1, publishProbability: 1 })
  const incremental = projectMonthlyCost({ ...calculateAttemptCost(ledger()), variableUsd: 0 }, { attemptsPerMonth: 1, outcomeProbability: 1, publishProbability: 1 })
  assert.equal(decideIncrementalCostGate({ full, incremental, measuredPairs: 4, nodeMajor: 22, fullProductionCorpus: true }).decision, 'insufficient-evidence')
  assert.equal(decideIncrementalCostGate({ full, incremental, measuredPairs: 5, nodeMajor: 24, fullProductionCorpus: true }).decision, 'insufficient-evidence')
  assert.equal(decideIncrementalCostGate({ full, incremental, measuredPairs: 5, nodeMajor: 22, fullProductionCorpus: false }).decision, 'insufficient-evidence')
})

test('a missing publish is unknown without explicit no-change evidence', () => {
  assert.equal(classifyAttemptOutcome({ published: false, explicitNoChange: false, failed: false }), 'unknown')
  assert.equal(classifyAttemptOutcome({ published: false, explicitNoChange: true, failed: false }), 'no-change')
  assert.equal(classifyAttemptOutcome({ published: false, explicitNoChange: true, failed: true }), 'failed')
})

test('modeled volume ledger is explicitly modeled and moves every private byte', () => {
  const volume = modelVolumeLedgerFromBucket(ledger({
    retainedBytes: { bucketAuthoritative: 10, bucketPrivate: 20, volumePrivate: 5 },
  }))
  assert.equal(volume.workflow, 'incremental-volume')
  assert.equal(volume.evidence, 'modeled')
  assert.deepEqual(volume.retainedBytes, { bucketAuthoritative: 10, bucketPrivate: 0, volumePrivate: 25 })
  assert.equal(volume.phases.crunch?.serviceUploadBytes.privateCache, 0)
  assert.match(volume.provenance, /modeled/)
})
