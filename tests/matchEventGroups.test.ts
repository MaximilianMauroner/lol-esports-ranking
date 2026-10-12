import assert from 'node:assert/strict'
import test from 'node:test'
import { groupedMatchEvents } from '../src/lib/matchEventGroups.ts'
import { compatibleMatchEvents } from '../src/lib/matchLedger.ts'

test('premier events lead domestic families while qualifiers and development stay lower', () => {
  const refs = [
    { league: 'LCK', event: 'LCK/2026 Season/Rounds 3-4' },
    { league: 'LCK', event: 'LCK 2026 Cup' },
    { league: 'LPL', event: 'LPL 2026 Split 2' },
    { league: 'LCS', event: 'LCS 2026 Spring' },
    { league: 'LEC', event: 'LEC 2026 Summer' },
    { league: 'LCP', event: 'LCP 2026 Split 1' },
    { league: 'CBLOL', event: 'CBLOL 2026 Cup' },
    { league: 'LCKC', event: 'LCK CL 2026 Spring' },
    { league: 'LFL', event: 'LFL 2026 Spring' },
    // The event identity takes precedence over a source's domestic league field.
    { league: 'LCK', event: 'Esports World Cup 2026/Online Qualifiers/Korea' },
    { league: 'EWC', event: 'EWC 2026' },
    { league: 'Worlds', event: 'Worlds 2026' },
    { league: 'MSI', event: 'MSI 2026' },
    { league: 'FST', event: 'First Stand 2026' },
    { league: 'AC', event: 'AC 2026' },
    { league: 'DCup', event: 'Demacia Cup 2025' },
  ]
  const groups = groupedMatchEvents(refs, 'All')
  assert.deepEqual(groups.slice(0, 10).map((group) => group.label), [
    'Worlds', 'MSI', 'First Stand', 'Esports World Cup', 'LCK', 'LPL', 'LEC', 'LCS', 'LCP', 'CBLOL',
  ])
  const qualifierIndex = groups.findIndex((group) => group.label === 'Esports World Cup · Qualifiers')
  assert.ok(qualifierIndex > groups.findIndex((group) => group.label === 'CBLOL'))
  assert.ok(qualifierIndex < groups.findIndex((group) => group.label === 'LCK CL'))
  assert.deepEqual(groups.find((group) => group.label === 'LCK')?.events, ['LCK 2026 Cup', 'LCK/2026 Season/Rounds 3-4'])
  assert.deepEqual(groups.find((group) => group.label === 'Esports World Cup')?.events, ['EWC 2026'])
  assert.deepEqual(groups.find((group) => group.label === 'AC')?.events, ['AC 2026'])
  assert.deepEqual(groups.flatMap((group) => group.events).sort(), compatibleMatchEvents(refs, 'All'))
})

test('grouping is complete and stable across duplicate rows, source order, ambiguous events and league filters', () => {
  const refs = [
    { league: 'LCK', event: 'Spring 2026' },
    { league: 'LCK', event: 'Spring 2026' },
    { league: 'Unknown', event: 'Unmapped Invitational 2026' },
    { league: 'LCK', event: 'Mixed competition 2026' },
    { league: 'LPL', event: 'Mixed competition 2026' },
    { league: 'Unmapped league', event: 'New regional event 2026' },
    { league: 'EWC', event: 'Esports World Cup 2026/Online Qualifiers/EMEA' },
  ]
  const groups = groupedMatchEvents(refs, 'All')
  assert.deepEqual(groups, groupedMatchEvents(refs.toReversed(), 'All'))
  assert.deepEqual(groups.flatMap((group) => group.events).sort(), compatibleMatchEvents(refs, 'All'))
  assert.deepEqual(groups.find((group) => group.label === 'Other events')?.events, [
    'Mixed competition 2026', 'New regional event 2026', 'Unmapped Invitational 2026',
  ])
  assert.deepEqual(groupedMatchEvents(refs, 'LCK').flatMap((group) => group.events).sort(), compatibleMatchEvents(refs, 'LCK'))
  assert.deepEqual(groupedMatchEvents(refs, 'Missing'), [])
  assert.deepEqual(groupedMatchEvents([], 'All'), [])
})

test('parent league names do not promote academy events or override international event identity', () => {
  const refs = [
    { league: 'NACL', event: 'LCS Academy 2026 Spring' },
    { league: 'LPL', event: 'LPL Development 2026' },
    { league: 'LCKC', event: 'LCK CL 2026 Spring' },
    { league: 'NACL', event: 'Esports World Cup 2026/Online Qualifiers/North America' },
  ]
  const groups = groupedMatchEvents(refs, 'All')
  assert.deepEqual(groups.map((group) => group.label), ['Esports World Cup · Qualifiers', 'LCK CL', 'NACL', 'Other events'])
  assert.deepEqual(groups.find((group) => group.label === 'NACL')?.events, ['LCS Academy 2026 Spring'])
  assert.deepEqual(groups.find((group) => group.label === 'Other events')?.events, ['LPL Development 2026'])
})
