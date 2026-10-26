import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { transparentGprModelMetadata } from '../src/domains/rankings/policy.ts'

test('native contracts embed the current model parameters', () => {
  const embedded = JSON.parse(readFileSync(new URL('../worker/ranking-contracts/src/model-config.json', import.meta.url), 'utf8'))
  assert.deepEqual(embedded, transparentGprModelMetadata.parameters)
})
