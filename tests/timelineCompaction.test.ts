import assert from 'node:assert/strict'
import test from 'node:test'
import {
  groupAdjacentTimelineEntries,
  inferBestOfForScore,
  summarizeTimelineResults,
  timelineGroupKey,
  timelineSourceSummary,
} from '../src/lib/timelineCompaction.ts'

test('timeline compaction groups adjacent series and shapes source provenance', () => {
  const entries = [
    { date: '2026-06-01', event: 'MSI 2026', opponent: 'Gen.G', result: 'W' as const, source: { provider: 'seed', gameId: 'g1', fileName: 'fixture.csv', bestOf: 5 } },
    { date: '2026-06-01', event: 'MSI 2026', opponent: 'Gen.G', result: 'L' as const, source: { provider: 'seed', gameId: 'g2', fileName: 'fixture.csv', bestOf: 5 } },
    { date: '2026-06-01', event: 'MSI 2026', opponent: 'Gen.G', result: 'W' as const, source: { provider: 'seed', gameId: 'g3', fileName: 'fixture.csv', bestOf: 5 } },
    { date: '2026-06-08', event: 'MSI 2026', opponent: 'T1', result: 'L' as const, source: { provider: 'seed', gameId: 'g4', fileName: 'fixture.csv', bestOf: 1 } },
  ]

  const groups = groupAdjacentTimelineEntries(entries, (entry) =>
    timelineGroupKey([entry.date, entry.event, entry.opponent, entry.source.bestOf]),
  )
  const series = groups[0]
  assert.ok(series)
  const result = summarizeTimelineResults(series.entries, (entry) => entry.result)

  assert.equal(groups.length, 2)
  assert.deepEqual(result, { wins: 2, losses: 1, games: 3, result: 'W' })
  assert.equal(inferBestOfForScore(result.wins, result.losses, series.entries.at(-1)?.source.bestOf), 3)
  assert.deepEqual(timelineSourceSummary(series.entries, (entry) => entry.source), {
    sourceProvider: 'seed',
    sourceGameId: 'g3',
    sourceFileName: 'fixture.csv',
    sourceGameIds: ['g1', 'g2', 'g3'],
  })
})
