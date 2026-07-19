import assert from 'node:assert/strict'
import test from 'node:test'
import { runDurableBenchmark, runParityMismatchRolloutScenario } from '../scripts/benchmark-incremental-durable.ts'

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
