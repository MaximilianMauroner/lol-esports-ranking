import assert from 'node:assert/strict'
import test from 'node:test'
import { createMatchHistoryArtifacts, createStaticRankingData } from '../src/lib/snapshot.ts'
import { parsePublicMatchHistoryCatalog, parsePublicMatchHistoryIndex, parsePublicMatchHistoryPage, snapshotKey } from '../src/lib/publicArtifacts/schema.ts'
import type { MatchRecord, TeamProfile } from '../src/types.ts'

const teams: Record<string, TeamProfile> = {
  'Gen.G': { name: 'Gen.G', code: 'GEN', region: 'LCK', league: 'LCK' },
  T1: { name: 'T1', code: 'T1', region: 'LCK', league: 'LCK' },
}

test('match history publishes scoped game rows and series-atomic impact', () => {
  const data = createStaticRankingData({
    matches: [game(1, 'Gen.G'), game(2, 'Gen.G')],
    teams,
    rosters: {},
    generatedAt: '2026-07-16T00:00:00.000Z',
    dataMode: 'scheduled-public-data',
  })
  const artifacts = createMatchHistoryArtifacts(data)
  const key = snapshotKey({ season: '2026', event: 'All', region: 'All' })
  const index = parsePublicMatchHistoryIndex(artifacts.index)
  const catalog = parsePublicMatchHistoryCatalog(artifacts.catalogs[key])
  const shard = parsePublicMatchHistoryPage(artifacts.pages[key][1])

  assert.equal(index.scopeIndex[key].gameCount, 2)
  assert.equal(index.scopeIndex[key].seriesCount, 1)
  assert.equal(catalog.series.length, 1)
  assert.equal(catalog.series[0].page, 1)
  assert.equal(shard.matches.length, 2)
  assert.equal(shard.matches[0].gameNumber, 1)
  assert.equal(shard.matches[0].impact.unit, 'held')
  assert.equal(shard.matches[1].impact.unit, 'series-applied')
  assert.equal(typeof shard.matches[1].impact.teamA, 'number')
  assert.equal(typeof shard.matches[1].impact.teamB, 'number')
  assert.equal(shard.matches[1].winnerId, shard.matches[1].teamA.id)
  assert.deepEqual([shard.matches[1].seriesWinsA, shard.matches[1].seriesWinsB], [2, 0])
  assert.equal(shard.matches.every((match) => match.teamA.name === 'Gen.G' && match.teamB.name === 'T1'), true)
})

test('match history parser rejects a winner outside the two teams', () => {
  const data = createStaticRankingData({ matches: [game(1, 'Gen.G')], teams, rosters: {} })
  const artifacts = createMatchHistoryArtifacts(data)
  const shard = artifacts.pages[data.defaultSnapshotKey][1]
  assert.throws(() => parsePublicMatchHistoryPage({
    ...shard,
    matches: shard.matches.map((match) => ({ ...match, winnerId: 'team:unknown' })),
  }), /winnerId must identify a team/)
})

test('match history impact stays tied to the series when published ratings also move for other reasons', () => {
  const opening = game(1, 'Gen.G')
  opening.id = 'opening-game'
  opening.sourceGameId = 'opening-game'
  opening.sourceMatchId = 'opening-game'
  opening.date = '2026-07-15'
  opening.datetimeUtc = '2026-07-15T12:00:00.000Z'
  opening.bestOf = 1
  opening.bestOfBasis = 'provider'
  const data = createStaticRankingData({
    matches: [opening, game(1, 'Gen.G'), game(2, 'Gen.G')],
    teams,
    rosters: {},
    generatedAt: '2026-07-16T00:00:00.000Z',
    dataMode: 'scheduled-public-data',
  })
  const key = snapshotKey({ season: '2026', event: 'All', region: 'All' })
  const baselineEntry = createMatchHistoryArtifacts(data).pages[key][1].matches
    .find((entry) => entry.id === 'lck-series_2')
  assert.ok(baselineEntry)
  assert.equal(baselineEntry.impact.unit, 'series-applied')
  assert.ok((baselineEntry.impact.teamA ?? 0) > 0)
  assert.ok((baselineEntry.impact.teamB ?? 0) < 0)

  for (const standing of data.snapshots[key]?.standings ?? []) {
    const finalPoint = standing.history.at(-1)
    assert.ok(finalPoint?.source.seriesId)
    const firstSeriesPoint = standing.history.findIndex(
      (point) => point.source.seriesId === finalPoint.source.seriesId,
    )
    const previousPoint = standing.history[firstSeriesPoint - 1]
    assert.ok(previousPoint)
    previousPoint.rating = finalPoint.rating + (standing.team === 'Gen.G' ? 100 : -100)
  }

  const contaminatedEntry = createMatchHistoryArtifacts(data).pages[key][1].matches
    .find((entry) => entry.id === 'lck-series_2')
  assert.ok(contaminatedEntry)
  assert.deepEqual(contaminatedEntry.impact, baselineEntry.impact)
})

function game(gameNumber: number, winner: 'Gen.G' | 'T1'): MatchRecord {
  const swapped = gameNumber % 2 === 0
  return {
    id: `lck-series-game-${gameNumber}`,
    sourceProvider: 'oracles-elixir',
    sourceGameId: `lck-series_${gameNumber}`,
    sourceMatchId: `lck-series_${gameNumber}`,
    dataCompleteness: 'complete',
    date: '2026-07-16',
    datetimeUtc: `2026-07-16T1${gameNumber}:00:00.000Z`,
    gameNumber,
    season: 2026,
    event: 'LCK 2026 Split 2',
    phase: 'Regular season',
    region: 'LCK',
    league: 'LCK',
    patch: '26.14',
    bestOf: 3,
    bestOfBasis: 'provider',
    tier: 'regional-regular',
    teamA: swapped ? 'T1' : 'Gen.G',
    teamB: swapped ? 'Gen.G' : 'T1',
    winner,
    teamAKills: winner === (swapped ? 'T1' : 'Gen.G') ? 18 : 10,
    teamBKills: winner === (swapped ? 'Gen.G' : 'T1') ? 18 : 10,
    teamAGold: winner === (swapped ? 'T1' : 'Gen.G') ? 65_000 : 58_000,
    teamBGold: winner === (swapped ? 'Gen.G' : 'T1') ? 65_000 : 58_000,
  }
}
