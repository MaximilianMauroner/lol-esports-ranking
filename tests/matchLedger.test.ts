import assert from 'node:assert/strict'
import test from 'node:test'
import { compatibleMatchEvents, hasConsistentImpactDirection, impactReportUrl, matchEventFilterLabels, matchEventLabel } from '../src/lib/matchLedger.ts'
import type { PublicMatchHistoryEntry, PublicMatchHistorySeriesRef } from '../src/lib/publicArtifacts/schema.ts'

test('league options exclude incompatible events without changing event identifiers', () => {
  const refs = [
    { league: 'LCK', event: 'LCK/2026 Season/Rounds 3-4' },
    { league: 'LEC', event: 'LEC/2026 Season/Summer Season' },
    { league: 'MSI', event: 'MSI 2026' },
  ] as PublicMatchHistorySeriesRef[]
  assert.deepEqual(compatibleMatchEvents(refs, 'LCK'), ['LCK/2026 Season/Rounds 3-4'])
  assert.equal(compatibleMatchEvents(refs, 'All').length, 3)
  assert.equal(matchEventLabel(refs[0].event), 'LCK · 2026 · Rounds 3-4')
  assert.equal(matchEventLabel('DCup 2025'), 'Demacia Cup 2025')
})

test('colliding event choices show catalog coverage and raw identity without changing other labels', () => {
  const refs = [
    ...Array.from({ length: 27 }, () => ({ league: 'LPL', event: 'DCup 2025' })),
    { league: 'LPL', event: 'Demacia Cup 2025' },
    { league: 'LCK', event: 'DCup 2025' },
    { league: 'LCK', event: 'Unknown Invitational 2025' },
  ]
  const labels = matchEventFilterLabels(refs, 'All')
  assert.equal(labels.get('DCup 2025'), 'Demacia Cup 2025 · 28 series (DCup 2025)')
  assert.equal(labels.get('Demacia Cup 2025'), 'Demacia Cup 2025 · 1 series (Demacia Cup 2025)')
  assert.equal(labels.get('Unknown Invitational 2025'), 'Unknown Invitational 2025')
  assert.equal(matchEventFilterLabels(refs, 'LPL').get('DCup 2025'), 'Demacia Cup 2025 · 27 series (DCup 2025)')
  assert.deepEqual([...matchEventFilterLabels(refs, 'LCK')], [
    ['DCup 2025', 'Demacia Cup 2025'], ['Unknown Invitational 2025', 'Unknown Invitational 2025'],
  ])
  assert.deepEqual([...matchEventFilterLabels(refs.toReversed(), 'All')].sort(), [...labels].sort())
  assert.deepEqual([...matchEventFilterLabels(refs, 'Missing')], [])
})

test('raw event identities keep colliding labels distinct even when coverage is equal', () => {
  const labels = matchEventFilterLabels([
    { league: 'LPL', event: 'DCup 2025' }, { league: 'LPL', event: 'Demacia Cup 2025' },
    { league: 'Unknown', event: 'New/Cup' }, { league: 'Unknown', event: 'New · Cup' },
  ], 'All')
  assert.equal(labels.size, 4)
  assert.equal(new Set(labels.values()).size, 4)
  assert.equal(labels.get('DCup 2025'), 'Demacia Cup 2025 · 1 series (DCup 2025)')
  assert.equal(labels.get('New/Cup'), 'New · Cup · 1 series (New/Cup)')
})

test('old MSI impact remains rejected and reports the exact affected record and publication', () => {
  // Verified against immutable live generation run_20260926060805,
  // transparent-power-index-v0.2.0 / fnv1a-169aeb58. No upstream truth assumed.
  const match = {
    id: 'LOLTMNT01_418707', seriesId: 'official-match\u0000115570934355614551',
    date: '2026-07-06', event: 'MSI 2026',
    teamA: { id: 'blg', name: 'Bilibili Gaming' }, teamB: { id: 'lyon', name: 'LYON' },
    winnerId: 'blg', impact: { unit: 'series-applied', teamA: -32, teamB: -16 },
    source: { provider: 'oracles-elixir' },
  } as PublicMatchHistoryEntry
  assert.equal(hasConsistentImpactDirection(match), false)
  const body = new URL(impactReportUrl(match, 'run_20260926060805 / fnv1a-169aeb58')).searchParams.get('body')!
  assert.ok(body.includes(match.id))
  assert.ok(body.includes(JSON.stringify(match.seriesId)))
  assert.ok(body.includes('fnv1a-169aeb58'))
  assert.equal(hasConsistentImpactDirection({ ...match, impact: { ...match.impact, teamA: NaN } }), false)
})
