import assert from 'node:assert/strict'
import test from 'node:test'
import { assertPublicArtifactBudgets, PUBLIC_ARTIFACT_BUDGETS, PUBLIC_ARTIFACT_PATHS, publicScopeArtifactPath, type PublicArtifactWrite } from '../src/lib/publicArtifacts/writePlan.ts'

test('archive growth beyond 40 MB does not block a bounded ranking bootstrap', () => {
  // Synthetic byte input checks only the aggregate gate, not schema validity.
  assert.doesNotThrow(() => assertPublicArtifactBudgets([sizedWrite(40_000_001)], 'unused'))
})

test('ranking bootstrap retains exact UTF-8 byte boundaries', () => {
  for (const [relativePath, limit, error] of [
    [PUBLIC_ARTIFACT_PATHS.manifest, PUBLIC_ARTIFACT_BUDGETS.manifestBytes, /Public manifest budget exceeded/],
    [publicScopeArtifactPath('all'), PUBLIC_ARTIFACT_BUDGETS.defaultScopeBytes, /Default ranking scope budget exceeded/],
  ] as const) {
    const entry = { ...sizedWrite(limit), relativePath }
    assert.doesNotThrow(() => assertPublicArtifactBudgets([entry], 'all'))
    assert.throws(() => assertPublicArtifactBudgets([{ ...entry, contents: entry.contents + 'é' }], 'all'), error)
  }
})

function sizedWrite(bytes: number): PublicArtifactWrite {
  return { family: 'history', relativePath: 'fabricated/growth.json', url: '/data/fabricated/growth.json', value: {}, contents: 'x'.repeat(bytes), validate: (value) => value }
}
