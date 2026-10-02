import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertPublicArtifactBudgets,
  PUBLIC_ARTIFACT_BUDGETS,
  PUBLIC_ARTIFACT_PATHS,
  publicScopeArtifactPath,
  type PublicArtifactWrite,
} from '../src/lib/publicArtifacts/writePlan.ts'

test('public artifact budget accepts the exact boundary and rejects one byte over', () => {
  assert.doesNotThrow(() => assertPublicArtifactBudgets([sizedWrite(PUBLIC_ARTIFACT_BUDGETS.totalPublicDataBytes)], 'unused'))
  assert.throws(
    () => assertPublicArtifactBudgets([sizedWrite(PUBLIC_ARTIFACT_BUDGETS.totalPublicDataBytes + 1)], 'unused'),
    /Public data budget exceeded: 40000001 bytes > 40000000 bytes/,
  )
})

test('observed production sizes fit the generation budget for ledger recovery', () => {
  // Synthetic byte-sized inputs reproduce the measured size gate only.
  // They do not establish schema validity or successful production publication.
  for (const bytes of [30_055_925, 30_170_537, 30_168_783, 30_236_720]) {
    assert.doesNotThrow(() => assertPublicArtifactBudgets([sizedWrite(bytes)], 'unused'))
  }
})

test('generation budget sums all lazy-loaded artifacts', () => {
  assert.throws(
    () => assertPublicArtifactBudgets([sizedWrite(20_000_000), sizedWrite(20_000_001)], 'unused'),
    /Public data budget exceeded: 40000001 bytes > 40000000 bytes/,
  )
})

test('recovery headroom does not relax individual browser payload limits', () => {
  for (const [relativePath, limit, error] of [
    [PUBLIC_ARTIFACT_PATHS.manifest, PUBLIC_ARTIFACT_BUDGETS.manifestBytes, /Public manifest budget exceeded/],
    [PUBLIC_ARTIFACT_PATHS.players, PUBLIC_ARTIFACT_BUDGETS.playersBytes, /Public players budget exceeded/],
    [publicScopeArtifactPath('all-time'), PUBLIC_ARTIFACT_BUDGETS.defaultScopeBytes, /Default ranking scope budget exceeded/],
  ] as const) {
    const atLimit = { ...sizedWrite(limit), relativePath }
    assert.doesNotThrow(() => assertPublicArtifactBudgets([atLimit], 'all-time'))
    assert.throws(() => assertPublicArtifactBudgets([{ ...atLimit, contents: `${atLimit.contents}x` }], 'all-time'), error)
  }
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
