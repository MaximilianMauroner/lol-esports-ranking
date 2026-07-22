import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyBucketObjectKey,
  classifyRetainedObjectKey,
  productionMonthlyProjectionAssumptions,
  runDurableBenchmark,
  runParityMismatchRolloutScenario,
  runSuccessiveAppendColdRestoreScenario,
} from '../scripts/benchmark-incremental-durable.ts'

test('cost benchmark attributes complete private, raw, public, and metadata key families', () => {
  assert.equal(productionMonthlyProjectionAssumptions.attemptsPerMonth, 120)
  assert.equal(classifyBucketObjectKey('bucket/rankings/durable/generations/manifest.json'), 'private-content')
  assert.equal(classifyBucketObjectKey('bucket/rankings/durable/audits/audit.json'), 'private-content')
  assert.equal(classifyBucketObjectKey('bucket/rankings/raw/generations/manifest.json'), 'raw-content')
  assert.equal(classifyBucketObjectKey('bucket/rankings/generations/g1/public-manifest.json'), 'public-content')
  assert.equal(classifyBucketObjectKey('bucket/rankings/generations/g1/data/ranking.json'), 'public-content')
  assert.equal(classifyBucketObjectKey('bucket/rankings/active-generation.json'), 'metadata-pointers')
  assert.equal(classifyRetainedObjectKey('bucket/rankings/durable/generations/manifest.json'), 'bucketPrivate')
  assert.equal(classifyRetainedObjectKey('bucket/rankings/raw/objects/hash'), 'bucketAuthoritative')
})

test('production mismatch rollout alerts, preserves private authority, is retry-idempotent, and forces full', async () => {
  const result = await runParityMismatchRolloutScenario()
  assert.equal(result.alertKind, 'incremental-parity-mismatch')
  assert.notEqual(result.mismatchGeneration, result.priorGeneration)
  assert.equal(result.privateStatePreserved, true)
  assert.equal(result.retryAuditAtPreserved, true)
  assert.equal(result.nextExecutedMode, 'full')
})

test('durable benchmark covers every Phase 5 change class with public parity', async () => {
  const result = await runDurableBenchmark()
  assert.deepEqual(result.scenarios.map((scenario) => scenario.scenario), [
    'no-change',
    'append',
    'old-correction',
    'context-only',
    'static-player-change',
    'cold-restore',
  ])
  const noChange = result.scenarios.find((scenario) => scenario.scenario === 'no-change')
  assert.ok(noChange)
  assert.equal(noChange.publicUploads, 0)
  assert.equal(noChange.privateUploadedObjects, 0)
  assert.equal(noChange.artifactWrites, 0)
  assert.equal(noChange.promotion, 'no-change')
  const append = result.scenarios.find((scenario) => scenario.scenario === 'append')
  const staticPlayer = result.scenarios.find((scenario) => scenario.scenario === 'static-player-change')
  const coldRestore = result.scenarios.find((scenario) => scenario.scenario === 'cold-restore')
  assert.ok(append && staticPlayer && coldRestore)
  assert.equal(append.rankingRows, 2)
  assert.equal(staticPlayer.rankingRuns, 0)
  assert.ok(staticPlayer.playerRows > 0)
  assert.equal(coldRestore.promotion, 'no-change')
  assert.equal(coldRestore.publicUploads, 0)
  assert.equal(coldRestore.privateUploadedObjects, 0)
  assert.ok(coldRestore.restoredBytes > 0)
  assert.equal(noChange.cacheHits, 0)
  assert.equal(coldRestore.cacheHits, 0)
  assert.ok(result.scenarios
    .filter((scenario) => scenario.scenario !== 'no-change' && scenario.scenario !== 'cold-restore')
    .every((scenario) => scenario.cacheHits > 0))
})

test('cold-restored successive appends advance checkpoints and replay only the newest delta', async () => {
  const rows = await runSuccessiveAppendColdRestoreScenario()
  assert.equal(rows.length, 3)
  assert.ok(rows[0]!.checkpoint < rows[1]!.checkpoint)
  assert.ok(rows[1]!.checkpoint < rows[2]!.checkpoint)
  assert.ok(rows.every((row) => row.rankingRows <= rows[0]!.rankingRows))
})
