import assert from 'node:assert/strict'
import test from 'node:test'
import { runIdentityBootstrapScenario } from '../scripts/benchmark-incremental-durable.ts'

test('explicit shadow cold-bootstraps an exact new identity and resets activation history', async () => {
  const result = await runIdentityBootstrapScenario()
  assert.equal(result.identityChanged, true)
  assert.equal(result.firstBSuccesses, 1)
  assert.ok(result.restoredBBytes > 0)
  assert.equal(result.activatedPromotion, 'no-change')
})
