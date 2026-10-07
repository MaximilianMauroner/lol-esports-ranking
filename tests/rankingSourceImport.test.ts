import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

for (const provider of ['leaguepedia', 'oracle'] as const) {
  test(`${provider} source coverage separates equal basenames and assigns duplicates to the first input`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ranking-source-ownership-'))
    try {
      const games = [
        { id: 'first', date: '2026-07-26' },
        { id: 'second', date: '2026-07-27' },
      ]
      const contents = [games.slice(0, 1), games.slice(1), games].map((rows) => provider === 'leaguepedia'
        ? JSON.stringify({ matches: rows.map((game) => ({ ...game, event: 'LCK 2026', teamA: 'Alpha', teamB: 'Beta', winner: 'Alpha', bestOf: 1 })) })
        : oracleCsv(rows))
      const paths: string[] = []
      for (const [index, content] of contents.entries()) {
        const directory = join(root, String(index))
        await mkdir(directory)
        const path = join(directory, provider === 'leaguepedia' ? 'scored.json' : 'scored.csv')
        await writeFile(path, content)
        paths.push(path)
      }

      const data = await importRankingSourceData(provider === 'leaguepedia'
        ? { leaguepediaJsonPaths: paths }
        : { oracleCsvPaths: paths })
      assert.equal(data.matches.length, 2)
      assert.deepEqual(data.externalSources.map((source) => ({
        rowCount: source.rowCount, status: source.status, start: source.coverageStart, end: source.coverageEnd,
      })), [
        { rowCount: 1, status: 'active', start: '2026-07-26', end: '2026-07-26' },
        { rowCount: 1, status: 'active', start: '2026-07-27', end: '2026-07-27' },
        { rowCount: 0, status: 'reference-only', start: undefined, end: undefined },
      ])
      assert.ok(data.matches.every((match) => match.sourceFileName === (provider === 'leaguepedia' ? 'scored.json' : 'scored.csv')))
      assert.equal(JSON.stringify(data).includes(root), false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('source ownership stays with the retained Oracle game after Leaguepedia metadata enrichment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-source-enrichment-'))
  try {
    const oracle = join(root, 'oracle.csv')
    const leaguepedia = join(root, 'leaguepedia.json')
    await writeFile(oracle, oracleCsv([{ id: 'shared', date: '2026-07-26' }]))
    await writeFile(leaguepedia, JSON.stringify({ matches: [{
      id: 'shared', date: '2026-07-26', event: 'LCK 2026', teamA: 'Alpha', teamB: 'Beta', winner: 'Alpha',
      bestOf: 5, teamAKills: 18, teamBKills: 12, teamAGold: 62000, teamBGold: 59000,
    }] }))

    const data = await importRankingSourceData({ oracleCsvPaths: [oracle], leaguepediaJsonPaths: [leaguepedia] })
    assert.equal(data.matches.length, 1)
    assert.equal(data.matches[0].id, 'oe-shared')
    assert.equal(data.matches[0].bestOf, 5)
    assert.deepEqual(data.externalSources.map((source) => source.rowCount), [1, 0])
    assert.equal(data.externalSources[1].status, 'reference-only')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('curated inventory preserves input provenance without an inherited provider refresh receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-source-inventory-'))
  try {
    const snapshot = join(root, 'scored.json')
    const manifest = join(root, 'manifest.json')
    const sourceUrl = 'https://example.com/scored-cup'
    const fetchedAt = '2026-10-07T06:00:00.000Z'
    const historicalWarning = 'Historical refresh on 2026-07-26: Leaguepedia was rate-limited; prior files were preserved.'
    await writeFile(snapshot, JSON.stringify({ sourceUrl, fetchedAt, matches: [{
      id: 'curated', date: '2026-10-06', event: 'LCK 2026', teamA: 'Alpha', teamB: 'Beta', winner: 'Alpha',
    }] }))
    await writeFile(manifest, JSON.stringify({
      schemaVersion: 1, start: '2025-01-01', end: '2026-10-06', generatedAt: '2026-10-07T08:00:00.000Z',
      files: { leaguepediaJson: ['scored.json'] }, warnings: [historicalWarning],
    }))

    const data = await importRankingSourceData({ manifestPath: manifest })
    assert.equal(data.matches.length, 1)
    const source = data.externalSources[0]
    assert.equal(source.url, sourceUrl)
    assert.equal(source.retrievedAt, fetchedAt)
    assert.equal(source.coverageEnd, '2026-10-06')
    assert.equal(Object.hasOwn(source, 'refreshReceipt'), false)
    assert.equal(source.warnings?.[0].message, historicalWarning)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cached Oracle source coverage serializes without an invented retrieval date', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-source-oracle-provenance-'))
  try {
    const csv = join(root, 'cached.csv')
    await writeFile(csv, oracleCsv([{ id: 'cached', date: '2026-07-26' }]))
    const data = await importRankingSourceData({ oracleCsvPaths: [csv] })
    assert.equal(data.matches.length, 1)
    const source = data.externalSources[0]
    assert.equal(source.rowCount, 1)
    assert.equal(source.coverageStart, '2026-07-26')
    assert.equal(source.coverageEnd, '2026-07-26')
    assert.equal(source.retrievedAt, undefined)
    assert.equal(JSON.stringify(data.externalSources).includes('"retrievedAt":'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function oracleCsv(games: { id: string; date: string }[]) {
  return [
    'gameid,date,year,league,split,playoffs,position,side,teamname,result,kills,totalgold',
    ...games.flatMap(({ id, date }) => [
      `${id},${date},2026,LCK,,0,team,blue,Alpha,1,18,62000`,
      `${id},${date},2026,LCK,,0,team,red,Beta,0,12,59000`,
    ]),
  ].join('\n')
}
