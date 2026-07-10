import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveTournamentInstances,
  teamMatchesTournamentFilter,
  tournamentFamilyForEvent,
  tournamentEntriesForScope,
  tournamentFilterOptionsForStandings,
  tournamentInstanceForEvent,
} from '../src/lib/internationalTournaments.ts'
import type { PublicTeamStanding, PublicTournamentMovementIndexEntry } from '../src/lib/publicArtifacts/schema.ts'

test('groups international tournament event labels by family', () => {
  assert.equal(tournamentFamilyForEvent('FST 2026'), 'first-stand')
  assert.equal(tournamentFamilyForEvent('2026 First Stand Tournament'), 'first-stand')
  assert.equal(tournamentFamilyForEvent('MSI 2026'), 'msi')
  assert.equal(tournamentFamilyForEvent('2026 Mid-Season Invitational'), 'msi')
  assert.equal(tournamentFamilyForEvent('Worlds 2026 Main Event'), 'worlds')
  assert.equal(tournamentFamilyForEvent('WLDs 2026'), 'worlds')
  assert.equal(tournamentFamilyForEvent('EWC 2026'), 'ewc')
  assert.equal(tournamentFamilyForEvent('Esports World Cup 2026'), 'ewc')
})

test('normalizes aliases into one season-specific instance without merging years', () => {
  assert.equal(tournamentInstanceForEvent('MSI 2026')?.id, 'msi:2026')
  assert.equal(tournamentInstanceForEvent('2026 Mid-Season Invitational')?.id, 'msi:2026')
  assert.equal(tournamentInstanceForEvent('MSI', 2025)?.id, 'msi:2025')
  assert.notEqual(tournamentInstanceForEvent('MSI', 2025)?.id, tournamentInstanceForEvent('MSI', 2026)?.id)
})

test('does not treat regional qualifier labels as international tournament fields', () => {
  assert.equal(tournamentFamilyForEvent('LCK 2026 Road to MSI'), undefined)
  assert.equal(tournamentFamilyForEvent('Esports World Cup 2026/Online Qualifiers/Korea'), undefined)
})

test('builds exact tournament options from movement index entries', () => {
  const options = tournamentFilterOptionsForStandings([
    standingWithEvents('team-a', 'MSI 2026', '2026 Mid-Season Invitational'),
    standingWithEvents('team-b', 'FST 2026'),
    standingWithEvents('team-c', 'LCK 2026 Rounds 1-2'),
  ], [movementEntry('msi:2026', 11)])

  assert.deepEqual(
    options.map((option) => [option.value, option.count]),
    [
      ['All', 3],
      ['international', 2],
      ['tournament:msi:2026', 11],
    ],
  )
  assert.match(options.at(-1)?.label ?? '', /MSI 2026 · Ongoing/)
})

test('keeps tournament instances compatible with the active season and checkpoint window', () => {
  const entries = [movementEntry('msi:2026', 11), {
    ...movementEntry('msi:2026', 9),
    id: 'msi:2025' as const,
    season: '2025',
    label: 'MSI 2025',
    startDate: '2025-06-27',
    boundaryDate: '2025-07-13',
    ratedThroughDate: '2025-07-13',
  }]

  assert.deepEqual(tournamentEntriesForScope(entries, 'All').map((entry) => entry.id), ['msi:2026', 'msi:2025'])
  assert.deepEqual(tournamentEntriesForScope(entries, '2026').map((entry) => entry.id), ['msi:2026'])
  assert.deepEqual(tournamentEntriesForScope(entries, '2026', { startDate: '2026-01-01', endDate: '2026-03-31' }), [])
  assert.deepEqual(tournamentEntriesForScope(entries, '2026', { startDate: '2026-06-01', endDate: '2026-08-01' }).map((entry) => entry.id), ['msi:2026'])
})

test('matches broad international filters from appearances and exact filters from shard team ids', () => {
  const standing = standingWithEvents('team-a', 'MSI 2026')

  assert.equal(teamMatchesTournamentFilter(standing, 'All'), true)
  assert.equal(teamMatchesTournamentFilter(standing, 'international'), true)
  assert.equal(teamMatchesTournamentFilter(standing, 'tournament:msi:2026', new Set(['team-a'])), true)
  assert.equal(teamMatchesTournamentFilter(standing, 'tournament:msi:2026', new Set(['team-b'])), false)
})

test('prefers durable tournament appearance metadata for the broad international filter', () => {
  const standing = {
    teamId: 'team-worlds',
    tournamentAppearances: [{
      family: 'worlds' as const,
      event: 'Worlds 2026 Main Event',
      lastDate: '2026-10-20',
      matchCount: 4,
    }],
    recentMatches: [],
  }

  assert.equal(teamMatchesTournamentFilter(standing, 'international'), true)
})

test('derives ongoing lifecycle from future unstarted schedule rows without rating them', () => {
  const [instance] = deriveTournamentInstances({
    generatedAt: '2026-07-10T12:00:00.000Z',
    matches: [
      { event: 'MSI 2026', season: 2026, date: '2026-06-28' },
      { event: '2026 Mid-Season Invitational', season: 2026, date: '2026-07-08' },
    ],
    scheduleReferences: [
      { leagueName: 'MSI', date: '2026-06-28', state: 'completed', retrievedAt: '2026-07-09T12:00:00Z', coverageStart: '2026-06-28', coverageEnd: '2026-07-12' },
      { leagueSlug: 'msi', date: '2026-07-12', state: 'unstarted', retrievedAt: '2026-07-09T12:00:00Z', coverageStart: '2026-06-28', coverageEnd: '2026-07-12' },
    ],
  })

  assert.equal(instance?.id, 'msi:2026')
  assert.equal(instance?.status, 'ongoing')
  assert.equal(instance?.startDate, '2026-06-28')
  assert.equal(instance?.ratedThroughDate, '2026-07-08')
  assert.equal(instance?.scheduledEndDate, '2026-07-12')
  assert.equal(instance?.boundaryDate, '2026-07-10')
})

test('only claims completed when schedule coverage extends beyond the completed final', () => {
  const [completed] = deriveTournamentInstances({
    generatedAt: '2026-08-01T00:00:00.000Z',
    matches: [{ event: 'MSI 2026', season: 2026, date: '2026-07-12' }],
    scheduleReferences: [{ leagueName: 'MSI', date: '2026-07-12', state: 'completed', coverageStart: '2026-07-12', coverageEnd: '2026-08-01', coverageEndComplete: true }],
  })
  const [partial] = deriveTournamentInstances({
    generatedAt: '2026-07-10T00:00:00.000Z',
    matches: [{ event: 'MSI 2026', season: 2026, date: '2026-07-09' }],
    scheduleReferences: [{ leagueName: 'MSI', date: '2026-07-09', state: 'completed', coverageEnd: '2026-07-09' }],
  })

  assert.equal(completed?.status, 'completed')
  assert.equal(completed?.boundaryDate, '2026-07-12')
  assert.equal(partial?.status, 'unknown')
  assert.equal(partial?.boundaryDate, '2026-07-09')
})

test('drops ambiguous qualifier rows that predate the main tournament schedule', () => {
  const instances = deriveTournamentInstances({
    generatedAt: '2026-07-10T00:00:00.000Z',
    matches: [
      { event: 'EWC 2026', season: 2026, date: '2026-05-05' },
      { event: 'EWC 2026', season: 2026, date: '2026-05-14' },
    ],
    scheduleReferences: [
      { leagueName: 'Esports World Cup', date: '2026-07-16', state: 'unstarted', coverageStart: '2026-05-21', coverageEnd: '2026-07-19' },
      { leagueSlug: 'ewc', date: '2026-07-19', state: 'unstarted', coverageStart: '2026-05-21', coverageEnd: '2026-07-19' },
    ],
  })

  assert.deepEqual(instances, [])
})

test('does not clip rated opening matches when schedule coverage starts mid-event', () => {
  const [instance] = deriveTournamentInstances({
    generatedAt: '2026-07-04T00:00:00.000Z',
    matches: [
      { event: 'MSI 2026', season: 2026, date: '2026-06-28' },
      { event: 'MSI 2026', season: 2026, date: '2026-07-02' },
    ],
    scheduleReferences: [
      { leagueName: 'MSI', date: '2026-07-02', state: 'completed', retrievedAt: '2026-07-04T00:00:00Z', coverageStart: '2026-07-02', coverageEnd: '2026-07-08' },
      { leagueName: 'MSI', date: '2026-07-08', state: 'unstarted', retrievedAt: '2026-07-04T00:00:00Z', coverageStart: '2026-07-02', coverageEnd: '2026-07-08' },
    ],
  })

  assert.equal(instance?.startDate, '2026-06-28')
})

test('rejects qualifier and regional-final evidence even when event aliases look international', () => {
  const instances = deriveTournamentInstances({
    generatedAt: '2026-10-01T00:00:00.000Z',
    matches: [
      { event: 'MSI 2026 Qualifier', season: 2026, date: '2026-05-01', tier: 'qualifier' },
      { event: 'WLDs 2026', season: 2026, date: '2026-09-20', phase: 'Regional Finals', tier: 'worlds-main' },
    ],
  })

  assert.deepEqual(instances, [])
})

test('uses the newest observation for overlapping official schedule matches', () => {
  const [instance] = deriveTournamentInstances({
    generatedAt: '2026-08-01T00:00:00.000Z',
    matches: [{ event: 'MSI 2026', season: 2026, date: '2026-07-12' }],
    scheduleReferences: [
      { matchId: 'final', leagueName: 'MSI', date: '2026-07-12', state: 'unstarted', retrievedAt: '2026-07-11T00:00:00Z', coverageStart: '2026-07-12', coverageEnd: '2026-07-12' },
      { matchId: 'final', leagueName: 'MSI', date: '2026-07-12', state: 'completed', retrievedAt: '2026-08-01T00:00:00Z', coverageStart: '2026-07-12', coverageEnd: '2026-08-01', coverageEndComplete: true },
    ],
  })

  assert.equal(instance?.status, 'completed')
})

function standingWithEvents(
  teamId: string,
  ...events: string[]
): Pick<PublicTeamStanding, 'teamId' | 'recentMatches' | 'tournamentAppearances'> {
  return {
    teamId,
    recentMatches: events.map((event) => ({
      date: '2026-07-01',
      event,
      opponent: 'Opponent',
      result: 'W',
      rating: 1800,
      delta: 12,
    })),
  }
}

function movementEntry(id: 'msi:2026', participantCount: number): PublicTournamentMovementIndexEntry {
  return {
    id,
    family: 'msi',
    season: '2026',
    label: 'MSI 2026',
    status: 'ongoing',
    startDate: '2026-06-28',
    boundaryDate: '2026-07-10',
    ratedThroughDate: '2026-07-08',
    scheduledEndDate: '2026-07-12',
    dataLag: false,
    participantCount,
    url: '/data/history/tournament-moves/msi-2026.json',
  }
}
