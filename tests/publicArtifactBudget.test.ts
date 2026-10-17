import assert from 'node:assert/strict'
import test from 'node:test'
import { createStaticRankingData, createStaticRankingSummaryData } from '../src/lib/snapshot.ts'
import { parsePublicRankingManifest } from '../src/lib/publicArtifacts/schema.ts'
import { assertPublicArtifactBudgets, createPublicArtifactWritePlan, PUBLIC_ARTIFACT_BUDGETS, PUBLIC_ARTIFACT_PATHS, publicScopeArtifactPath, type PublicArtifactWrite } from '../src/lib/publicArtifacts/writePlan.ts'

test('publication accepts a valid ranking manifest at the observed refresh failure size', () => {
  const data = dataWithManifestBytes(254_261)
  const plan = createPublicArtifactWritePlan(data)
  const manifest = plan.writes.find((entry) => entry.relativePath === PUBLIC_ARTIFACT_PATHS.manifest)
  assert.ok(manifest)
  assert.equal(Buffer.byteLength(manifest.contents), 254_261)
  assert.doesNotThrow(() => manifest.validate(JSON.parse(manifest.contents)))
})

test('publication rejects a valid ranking manifest above 500 KB', () => {
  const data = dataWithManifestBytes(500_001)
  assert.throws(() => createPublicArtifactWritePlan(data), /Public manifest budget exceeded/)
})

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

function dataWithManifestBytes(bytes: number) {
  const data = createStaticRankingData({
    matches: [],
    teams: {},
    rosters: {},
    generatedAt: '2026-10-17T12:14:00.000Z',
    source: 'Synthetic manifest budget fixture.',
  })
  const manifest = createPublicArtifactWritePlan(data).writes.find((entry) => entry.relativePath === PUBLIC_ARTIFACT_PATHS.manifest)
  assert.ok(manifest)
  data.source += 'x'.repeat(bytes - Buffer.byteLength(manifest.contents))
  parsePublicRankingManifest(createStaticRankingSummaryData(data).manifest)
  return data
}
