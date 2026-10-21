import assert from 'node:assert/strict'
import test from 'node:test'
import { eventAddress, resolveEventLink } from '../src/browser/tournaments/eventAddress'
import type { TournamentEvent } from '../src/domains/tournaments/read'

function event(id = '2026 Season World Championship/Main Event', overrides: Partial<TournamentEvent> = {}): TournamentEvent {
  return { id, sourceTournamentId: id, competition: 'worlds', label: 'Worlds 2026', season: '2026', series: [], ...overrides }
}

test('readable addresses cover Leaguepedia paths and LoL Esports identities', () => {
  const worlds = event()
  assert.equal(eventAddress(worlds), 'worlds-2026-main-event-0f9mesv')
  assert.equal(eventAddress(event('LCK/2026 Season/Playoffs', { competition: 'lck' })), 'lck-2026-playoffs-0tz9vne')
  assert.equal(eventAddress(event('worlds:2026')), 'worlds-2026-0x827j8')
  assert.match(eventAddress(event('Unknown/Élite Finals', { competition: null })), /^event-2026-elite-finals-[a-z0-9]{7}$/)
  assert.ok(eventAddress(worlds).length < new URLSearchParams({ event: worlds.id }).toString().slice(6).length)
})

test('addresses retain event identity across feed changes and matching stage slugs', () => {
  const first = event('Worlds/Rounds 1-2')
  const second = event('Worlds/Rounds 1–2')
  const address = eventAddress(first)
  assert.notEqual(address, eventAddress(second))
  assert.match(eventAddress(second), /^worlds-2026-rounds-1-2-/)
  const updated: TournamentEvent = { ...first, label: 'Corrected display name', series: [{
    id: 'result', eventId: first.id, startTime: null, stage: 'Final', status: 'completed', sourceState: 'completed',
    bestOf: 5, teams: [], vodUrls: [],
  }] }
  assert.equal(eventAddress(updated), address)
  for (const events of [[first], [second, first], [updated, second]]) {
    const link = resolveEventLink(events, address)
    assert.equal(link.kind, 'resolved')
    if (link.kind === 'resolved') assert.equal(link.event.id, first.id)
  }
})

test('raw IDs and tokens resolve, with absent and unsupported values explicit', () => {
  const entry = event()
  for (const value of [entry.id, eventAddress(entry)]) {
    assert.deepEqual(resolveEventLink([entry], value), { kind: 'resolved', event: entry, address: eventAddress(entry) })
  }
  assert.deepEqual(resolveEventLink([entry], undefined), { kind: 'absent' })
  assert.deepEqual(resolveEventLink([entry], ''), { kind: 'absent' })
  for (const value of ['unknown', 'worlds-2026-main-event', 'wrong-prefix-0f9mesv', 'worlds-2026-main-event-0000000']) {
    assert.deepEqual(resolveEventLink([entry], value), { kind: 'missing' })
  }
  assert.deepEqual(resolveEventLink([event(entry.id, { season: '2027' })], eventAddress(entry)), { kind: 'missing' })
})

test('duplicate identities and raw/address overlaps fail closed without precedence', () => {
  const entry = event()
  const duplicate = { ...entry }
  for (const value of [entry.id, eventAddress(entry)]) {
    assert.deepEqual(resolveEventLink([entry, duplicate], value), { kind: 'ambiguous' })
  }
  const rawOverlap = event(eventAddress(entry))
  for (const events of [[entry, rawOverlap], [rawOverlap, entry]]) {
    assert.deepEqual(resolveEventLink(events, eventAddress(entry)), { kind: 'ambiguous' })
  }
  assert.equal(resolveEventLink([entry, entry], entry.id).kind, 'resolved')
})

test('a compact hash collision cannot select a competition', () => {
  const first = event('costarring')
  const second = event('liquid')
  assert.equal(eventAddress(first), eventAddress(second))
  assert.deepEqual(resolveEventLink([first, second], eventAddress(first)), { kind: 'ambiguous' })
})

test('non-Latin identities and lone surrogates remain addressable', () => {
  for (const id of ['赛事/决赛', 'Worlds/\ud800', 'Worlds/\ud801']) {
    const entry = event(id, { competition: null, season: '二〇二六' })
    const address = eventAddress(entry)
    assert.match(address, /^event-[a-z0-9]{7}$/)
    assert.equal(resolveEventLink([entry], address).kind, 'resolved')
  }
  assert.notEqual(eventAddress(event('Worlds/\ud800')), eventAddress(event('Worlds/\ud801')))
})
