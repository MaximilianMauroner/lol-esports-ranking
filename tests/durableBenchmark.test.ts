import assert from 'node:assert/strict'
import test from 'node:test'
import { runDurableBenchmark } from '../scripts/benchmark-incremental-durable.ts'

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
  assert.ok(result.scenarios.every((scenario) => scenario.publicBytes > 0))
  assert.ok(result.scenarios.some((scenario) => scenario.uploadedBytes < scenario.publicBytes))
  assert.ok(result.scenarios.find((scenario) => scenario.scenario === 'no-change')?.skippedObjects)
})
