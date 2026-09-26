import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertPublicArtifactBudgets,
  PUBLIC_ARTIFACT_BUDGETS,
  type PublicArtifactWrite,
} from '../src/lib/publicArtifacts/writePlan.ts'

test('public artifact budget accepts the exact boundary and rejects one byte over', () => {
  assert.doesNotThrow(() => assertPublicArtifactBudgets([sizedWrite(PUBLIC_ARTIFACT_BUDGETS.totalPublicDataBytes)], 'unused'))
  assert.throws(
    () => assertPublicArtifactBudgets([sizedWrite(PUBLIC_ARTIFACT_BUDGETS.totalPublicDataBytes + 1)], 'unused'),
    /Public data budget exceeded: 30000001 bytes > 30000000 bytes/,
  )
})

test('production failure size remains fail-closed without publication inputs', () => {
  assert.throws(
    () => assertPublicArtifactBudgets([sizedWrite(30_055_925)], 'unused'),
    /Public data budget exceeded: 30055925 bytes > 30000000 bytes/,
  )
})

function sizedWrite(bytes: number): PublicArtifactWrite {
  return {
    family: 'history',
    relativePath: 'fabricated/production-shaped.json',
    url: '/data/fabricated/production-shaped.json',
    value: {},
    contents: 'x'.repeat(bytes),
    validate: (value) => value,
  }
}
