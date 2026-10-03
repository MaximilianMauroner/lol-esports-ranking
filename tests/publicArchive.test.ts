import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalJsonFor, prepareSemanticArtifact } from '../scripts/public-artifact-storage.mjs'
import { ARCHIVE_PAGE_BYTES, archiveReferences, hydrateArchive, projectArchiveView, type ArchiveReference } from '../src/lib/publicArtifacts/archive.mjs'

function corpus(years: number) {
  return { artifactKind: 'synthetic-history', sample: true, rows: Array.from({ length: years * 600 }, (_, index) => ({
    id: index, date: `${2020 + Math.floor(index / 600)}-06-01`, value: 'é'.repeat(500),
  })) }
}

function preparedStore(value: unknown) {
  const prepared = prepareSemanticArtifact(value)
  const children = new Map(prepared.children?.map((child) => [child.digest, child.semantic.content]))
  const load = async (reference: ArchiveReference) => {
    const child = children.get(reference.sha256)
    assert.ok(child, `Missing node ${reference.sha256}`)
    return child
  }
  return { prepared, children, load }
}

for (const years of [2, 5, 10]) test(`synthetic ${years}-year archive has bounded nodes and lossless chronological reconstruction`, async () => {
  const source = corpus(years)
  const { prepared, load } = preparedStore(source)
  assert.ok(prepared.children?.length)
  assert.ok(prepared.bytes <= ARCHIVE_PAGE_BYTES)
  for (const node of prepared.children ?? []) assert.ok(node.bytes <= ARCHIVE_PAGE_BYTES)
  assert.equal(canonicalJsonFor(await hydrateArchive(prepared.semantic.content, load)), canonicalJsonFor(source))
})

test('year selection skips prior-year objects and an append reuses their content identities', async () => {
  const source = corpus(3)
  const first = preparedStore(source)
  const visited: ArchiveReference[] = []
  const view = await hydrateArchive(first.prepared.semantic.content, first.load, { years: ['2022'], onReference: (reference) => visited.push(reference) })
  assert.ok(view && typeof view === 'object' && 'rows' in view && Array.isArray(view.rows))
  assert.equal(view.rows.length, 600)
  assert.ok(view.rows.every((row) => row.date.startsWith('2022')))
  assert.ok(visited.every((reference) => !reference.year || reference.year === '2022'))
  const second = preparedStore({ ...source, rows: [...source.rows, { id: 9999, date: '2023-01-01', value: 'new' }] })
  const priorYear = [...first.children.keys()].filter((digest) => {
    const content = first.children.get(digest)
    return archiveReferences(content).length === 0 && JSON.stringify(content).includes('2020-06-01')
  })
  assert.ok(priorYear.length)
  for (const digest of priorYear) assert.ok(second.children.has(digest))
})

test('map lookup retrieves only a bounded part of a large artifact directory', async () => {
  const artifacts = Object.fromEntries(Array.from({ length: 7000 }, (_, index) => [`/data/years/2025/${String(index).padStart(5, '0')}.json`, { sha256: 'a'.repeat(64), detail: 'x'.repeat(100) }]))
  const { prepared, load } = preparedStore({ artifactKind: 'public-artifact-directory', formatVersion: 1, artifacts })
  let requests = 0
  const key = '/data/years/2025/04500.json'
  const value = await hydrateArchive(prepared.semantic.content, async (reference) => { requests++; return load(reference) }, { records: { '/artifacts': [key] } })
  assert.ok(value && typeof value === 'object' && 'artifacts' in value && value.artifacts && typeof value.artifacts === 'object')
  assert.ok(Object.hasOwn(value.artifacts, key))
  assert.ok(requests < (prepared.children?.length ?? 0))
})

test('counts, unknown versions, duplicate map keys, missing nodes and cycles fail closed', async () => {
  const { prepared, children, load } = preparedStore(corpus(2))
  const root = structuredClone(prepared.semantic.content)
  const refs = archiveReferences(root)
  assert.ok(refs.length)
  const ref = refs[0]
  const countMismatch = structuredClone(root)
  const changed = archiveReferences(countMismatch)[0]
  changed.count++
  await assert.rejects(hydrateArchive(countMismatch, load), /count mismatch/)
  await assert.rejects(hydrateArchive(Object.assign({}, root, { formatVersion: 999 }), load), /format/)
  await assert.rejects(hydrateArchive(countMismatch, load, { years: ['2020'] }), /count mismatch/)
  const duplicated = { artifactKind: 'public-archive-node', formatVersion: 1, tree: { kind: 'record', entries: [['x', { kind: 'inline', value: 1 }], ['x', { kind: 'inline', value: 2 }]] } }
  await assert.rejects(hydrateArchive(duplicated, load), /record/)
  children.delete(ref.sha256)
  await assert.rejects(hydrateArchive(root, load), /Missing node/)
  const cyclic = { artifactKind: 'public-artifact-archive', formatVersion: 1, originalKind: 'test', tree: { kind: 'map', parts: [{ sha256: 'a'.repeat(64), bytes: 100, count: 1, encoding: 'gzip' }] } }
  await assert.rejects(hydrateArchive(cyclic, async () => ({ artifactKind: 'public-archive-node', formatVersion: 1, tree: cyclic.tree })), /cycle/)
})

test('an oversized atomic series fails rather than discarding games', () => {
  assert.throws(() => prepareSemanticArtifact({ artifactKind: 'synthetic-games', matches: [
    { date: '2025-12-31', seriesId: 'cross-year', details: 'x'.repeat(300_000) },
    { date: '2026-01-01', seriesId: 'cross-year', details: 'x'.repeat(300_000) },
  ] }), /series cross-year exceeds page budget/)
})

test('catalog projection retains all games in a series assigned to its opening year', () => {
  const catalog = { artifactKind: 'match-history-catalog', pages: [{ page: 2025000001, storageYear: '2025' }, { page: 2026000001, storageYear: '2026' }],
    series: [{ id: 'new-year', date: '2026-01-01', storageYear: '2025', page: 2025000001, gameCount: 3 }, { id: 'next', page: 2026000001, gameCount: 1 }], gameCount: 4, seriesCount: 2 }
  const value = projectArchiveView(catalog, { years: ['2025'] })
  assert.ok(value && typeof value === 'object' && 'seriesCount' in value)
  assert.equal(value.seriesCount, 1)
  assert.ok('gameCount' in value)
  assert.equal(value.gameCount, 3)
})


test('a series spanning New Year is discoverable from both year views', async () => {
  const catalog = { artifactKind: 'match-history-catalog', pages: [{ page: 2025000001, storageYear: '2025', startUtcDate: '2025-12-31', endUtcDate: '2026-01-01' }],
    series: [{ id: 'cross-year', page: 2025000001, storageYear: '2025', startUtcDate: '2025-12-31', endUtcDate: '2026-01-01', gameCount: 3, detail: 'x'.repeat(1000) }], seriesCount: 1, gameCount: 3 }
  for (const year of ['2025', '2026']) {
    const view = projectArchiveView(catalog, { years: [year] })
    assert.ok(view && typeof view === 'object' && 'seriesCount' in view)
    assert.equal(view.seriesCount, 1)
  }
  const source = { artifactKind: 'synthetic-history', rows: Array.from({ length: 600 }, (_, index) => ({ id: index, storageYear: '2025', startUtcDate: '2025-12-31', endUtcDate: '2026-01-01', detail: 'x'.repeat(1000) })) }
  const store = preparedStore(source)
  const view = await hydrateArchive(store.prepared.semantic.content, store.load, { years: ['2026'] })
  assert.equal(canonicalJsonFor(view), canonicalJsonFor(source))
})


test('year projection preserves the year directory and ranking season metadata', async () => {
  const source = { ...corpus(2), years: ['2021', '2020'], filter: { season: '2021' } }
  const store = preparedStore(source)
  const view = await hydrateArchive(store.prepared.semantic.content, store.load, { years: ['2020'] })
  assert.ok(view && typeof view === 'object' && 'years' in view && 'filter' in view && 'rows' in view)
  assert.deepEqual(view.years, source.years)
  assert.deepEqual(view.filter, source.filter)
  assert.ok(Array.isArray(view.rows) && view.rows.length === 600)
})

test('hash-only preparation preserves storage identity without retaining compressed buffers', () => {
  const source = corpus(2)
  const encoded = prepareSemanticArtifact(source)
  const identity = prepareSemanticArtifact(source, { compress: false })
  assert.equal(identity.digest, encoded.digest)
  assert.equal(identity.bytes, encoded.bytes)
  assert.equal(identity.compressed.length, 0)
  assert.ok(identity.children?.every((node) => node.compressed.length === 0))
})

test('reader-first release can keep the legacy writer and rejects unknown writer versions', () => {
  const original = process.env.RANKING_PUBLIC_ARCHIVE_WRITE_VERSION
  try {
    process.env.RANKING_PUBLIC_ARCHIVE_WRITE_VERSION = '0'
    const legacy = prepareSemanticArtifact(corpus(2), { compress: false })
    assert.equal(legacy.children?.length, 0)
    assert.equal(legacy.semantic.content && typeof legacy.semantic.content === 'object' && 'artifactKind' in legacy.semantic.content ? legacy.semantic.content.artifactKind : undefined, 'synthetic-history')
    process.env.RANKING_PUBLIC_ARCHIVE_WRITE_VERSION = '2'
    assert.throws(() => prepareSemanticArtifact(corpus(2)), /Unsupported public archive writer version/)
  } finally {
    if (original === undefined) delete process.env.RANKING_PUBLIC_ARCHIVE_WRITE_VERSION
    else process.env.RANKING_PUBLIC_ARCHIVE_WRITE_VERSION = original
  }
})
