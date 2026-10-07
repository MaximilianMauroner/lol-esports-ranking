import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { importRankingSourceData } from '../scripts/ranking-source-import'

test('source coverage counts retained tournament games after home-league resolution and deduplication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-source-import-'))
  try {
    const domestic = join(root, 'domestic.json')
    const cup = join(root, 'cup.json')
    const duplicate = join(root, 'duplicate.json')
    const game = { teamA: 'Alpha', teamB: 'Beta', winner: 'Alpha', bestOf: 1 }
    await writeFile(domestic, JSON.stringify({ matches: [{ ...game, id: 'domestic', date: '2026-07-26', event: 'LCK 2026' }] }))
    const tournament = JSON.stringify({ sourceUrl: 'https://example.com/scored-cup', matches: [
      { ...game, id: 'cup-a', date: '2026-10-03', event: '2026 Demacia Cup Global Invitational' },
      { ...game, id: 'cup-b', date: '2026-10-06', event: '2026 Demacia Cup Global Invitational' },
    ] })
    await writeFile(cup, tournament)
    await writeFile(duplicate, tournament)

    const data = await importRankingSourceData({ leaguepediaJsonPaths: [domestic, cup, duplicate] })
    const source = data.externalSources.find((entry) => entry.name === 'Leaguepedia Cargo: cup.json')
    assert.ok(source)
    assert.equal(data.matches.length, 3)
    assert.equal(source.rowCount, 2)
    assert.equal(source.coverageStart, '2026-10-03')
    assert.equal(source.coverageEnd, '2026-10-06')
    assert.equal(source.url, 'https://example.com/scored-cup')
    const duplicateSource = data.externalSources.find((entry) => entry.name === 'Leaguepedia Cargo: duplicate.json')
    assert.equal(duplicateSource?.rowCount, 0)
    assert.equal(duplicateSource?.status, 'reference-only')
    assert.equal(data.externalSources.reduce((total, entry) => total + (entry.rowCount ?? 0), 0), data.matches.length)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
