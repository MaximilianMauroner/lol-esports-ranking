import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildDssPlayerResumeLedgers,
  playerResumeCreditEntries,
  type DssPlayerResumeSeriesInput,
} from '../src/lib/playerResumeLedger.ts'

test('playerResumeCreditEntries attributes weighted series value by contribution share', () => {
  const entries = playerResumeCreditEntries([
    seriesFixture({
      weightedSeriesValue: 12,
      players: [
        { id: 'mid', role: 'Mid', share: 0.3 },
        { id: 'bot', role: 'Bot', share: 0.2 },
      ],
    }),
  ])

  assert.equal(entries.length, 2)
  assert.equal(entries[0].playerId, 'mid')
  assert.equal(entries[0].resumeCredit, 3.5999999999999996)
  assert.equal(entries[0].international, true)
  assert.equal(entries[1].resumeCredit, 2.4000000000000004)
})

test('buildDssPlayerResumeLedgers aggregates career, season, split, international, and role ledgers', () => {
  const model = buildDssPlayerResumeLedgers([
    seriesFixture({ seriesKey: '2025-spring', date: '2025-02-01', season: 2025, splitId: 'spring', weightedSeriesValue: 20 }),
    seriesFixture({ seriesKey: '2026-spring', date: '2026-02-01', season: 2026, splitId: 'spring', weightedSeriesValue: 10 }),
    seriesFixture({ seriesKey: '2026-summer', date: '2026-06-01', season: 2026, splitId: 'summer', weightedSeriesValue: 6, tier: 'regional-regular' }),
  ])
  const mid = ledgerFor(model, 'mid')

  assert.equal(model.currentSeason, 2026)
  assert.equal(model.currentSplitId, 'summer')
  assert.equal(mid.careerResumeCredit, 18)
  assert.equal(mid.currentSeasonResumeCredit, 8)
  assert.equal(mid.currentSplitResumeCredit, 3)
  assert.equal(mid.internationalResumeCredit, 15)
  assert.equal(mid.roleResumeCredit.Mid, 18)
  assert.equal(mid.uncertainty, 0)
})

test('buildDssPlayerResumeLedgers honors explicit current scope and uncertainty callbacks', () => {
  const model = buildDssPlayerResumeLedgers([
    seriesFixture({ seriesKey: 'spring', season: 2026, splitId: 'spring', weightedSeriesValue: 10 }),
    seriesFixture({ seriesKey: 'summer', season: 2026, splitId: 'summer', weightedSeriesValue: 6 }),
  ], {
    currentSeason: 2026,
    currentSplitId: 'spring',
    uncertaintyFor: (_playerId, entries) => 100 - entries.length,
  })
  const mid = ledgerFor(model, 'mid')

  assert.equal(mid.currentSeasonResumeCredit, 8)
  assert.equal(mid.currentSplitResumeCredit, 5)
  assert.equal(mid.uncertainty, 98)
})

test('buildDssPlayerResumeLedgers treats current season as current split when split ids are absent', () => {
  const model = buildDssPlayerResumeLedgers([
    seriesFixture({ seriesKey: 'old', season: 2025, splitId: undefined, weightedSeriesValue: 20 }),
    seriesFixture({ seriesKey: 'current', season: 2026, splitId: undefined, weightedSeriesValue: 10 }),
  ])
  const mid = ledgerFor(model, 'mid')

  assert.equal(model.currentSeason, 2026)
  assert.equal(model.currentSplitId, undefined)
  assert.equal(mid.currentSeasonResumeCredit, 5)
  assert.equal(mid.currentSplitResumeCredit, 5)
})

function ledgerFor(model: ReturnType<typeof buildDssPlayerResumeLedgers>, playerId: string) {
  const ledger = model.ledgers.find((entry) => entry.playerId === playerId)
  assert.ok(ledger)
  return ledger
}

function seriesFixture(overrides: Partial<DssPlayerResumeSeriesInput> = {}): DssPlayerResumeSeriesInput {
  return {
    seriesKey: 'series',
    date: '2026-01-01',
    season: 2026,
    splitId: 'spring',
    event: 'Worlds 2026',
    tier: 'worlds-main',
    team: 'Alpha',
    weightedSeriesValue: 10,
    players: [
      { id: 'mid', role: 'Mid', share: 0.5 },
      { id: 'support', role: 'Support', share: 0.2 },
    ],
    ...overrides,
  }
}
