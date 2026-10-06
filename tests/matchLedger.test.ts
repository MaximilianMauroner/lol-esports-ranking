import assert from 'node:assert/strict'
import test from 'node:test'
import { compatibleMatchEvents, hasConsistentImpactDirection, impactReportUrl, matchEventLabel } from '../src/lib/matchLedger.ts'
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
