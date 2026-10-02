import assert from 'node:assert/strict'
import test from 'node:test'
import type { MatchRecord, TeamProfile } from '../src/types.ts'
import { createMatchHistoryArtifacts, createStaticRankingData } from '../src/lib/snapshot.ts'

const teams: Record<string, TeamProfile> = {
  Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
  Beta: { name: 'Beta', code: 'BET', region: 'LCK', league: 'LCK' },
}

test('chronological 25-series partitions keep latest appends on the tail while catalog lookup stays newest-first', () => {
  const originalMatches = Array.from({ length: 26 }, (_, index) => match(index + 1))
  const original = artifacts(originalMatches)
  assert.equal(original.catalog.series[0]?.id.includes('series-26'), true)
  assert.equal(original.catalog.series[0]?.page, 2026000002)
  assert.equal(original.catalog.series.at(-1)?.date, '2026-01-01')
  assert.equal(original.catalog.series.at(-1)?.page, 2026000001)

  const appended = artifacts([...originalMatches, match(27)])
  assert.deepEqual(appended.pages[2026000001], original.pages[2026000001])
  assert.notDeepEqual(appended.pages[2026000002], original.pages[2026000002])
  assert.equal(appended.catalog.series[0]?.id.includes('series-27'), true)
  assert.equal(appended.catalog.series[0]?.page, 2026000002)

  const inserted = match(100, '2026-01-15T12:30:00.000Z')
  const historical = artifacts([...originalMatches, inserted])
  assertCatalogPageLookup(historical.catalog.series, historical.pages)
})

function artifacts(matches: MatchRecord[]) {
  const data = createStaticRankingData({
    matches,
    teams: structuredClone(teams),
    rosters: {},
    generatedAt: '2026-02-01T00:00:00.000Z',
    dataMode: 'scheduled-public-data',
  })
  const artifacts = createMatchHistoryArtifacts(data)
  return {
    catalog: artifacts.catalogs[data.defaultSnapshotKey]!,
    pages: artifacts.pages[data.defaultSnapshotKey]!,
  }
}

function assertCatalogPageLookup(
  refs: { id: string; page: number }[],
  pages: Record<number, { matches: { seriesId: string }[] }>,
) {
  for (const ref of refs) {
    assert.equal(pages[ref.page]?.matches.some((match) => match.seriesId === ref.id), true, ref.id)
  }
}

function match(index: number, datetimeUtc?: string): MatchRecord {
  const day = Math.min(index, 28)
  const date = `2026-01-${String(day).padStart(2, '0')}`
  return {
    id: `game-${index}`,
    sourceProvider: 'oracles-elixir',
    sourceGameId: `game-${index}`,
    sourceMatchId: `series-${index}`,
    date,
    datetimeUtc: datetimeUtc ?? `${date}T12:00:00.000Z`,
    season: 2026,
    event: 'LCK 2026',
    phase: 'Regular season',
    region: 'LCK',
    league: 'LCK',
    patch: '26.1',
    bestOf: 1,
    bestOfBasis: 'provider',
    tier: 'regional-regular',
    teamA: 'Alpha',
    teamB: 'Beta',
    winner: index % 2 ? 'Alpha' : 'Beta',
    teamAKills: index % 2 ? 10 : 5,
    teamBKills: index % 2 ? 5 : 10,
    teamAGold: index % 2 ? 60_000 : 55_000,
    teamBGold: index % 2 ? 55_000 : 60_000,
  }
}


test('New Year preserves prior pages, keeps a cross-year series atomic, and a corrected opening date moves its partition', () => {
  const opening = { ...match(1), date: '2025-12-31', datetimeUtc: '2025-12-31T23:50:00.000Z', officialMatchId: 'cross-year' }
  const closing = { ...match(2), date: '2026-01-01', datetimeUtc: '2026-01-01T00:20:00.000Z', officialMatchId: 'cross-year' }
  const before = artifacts([opening, closing])
  assert.equal(before.catalog.series.length, 1)
  assert.equal(before.catalog.series[0].storageYear, '2025')
  assert.equal(before.pages[2025000001].gameCount, 2)
  const after = artifacts([opening, closing, { ...match(3), date: '2026-01-02' }])
  assert.deepEqual(after.pages[2025000001], before.pages[2025000001])
  assert.equal(after.catalog.series[0].storageYear, '2026')
  const corrected = artifacts([{ ...opening, date: '2026-01-01', datetimeUtc: '2026-01-01T00:10:00.000Z' }, closing])
  assert.equal(corrected.pages[2025000001], undefined)
  assert.equal(corrected.pages[2026000001].gameCount, 2)
  assertCatalogPageLookup(corrected.catalog.series, corrected.pages)
})
