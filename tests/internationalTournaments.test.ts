import assert from 'node:assert/strict'
import test from 'node:test'
import {
  teamMatchesTournamentFilter,
  tournamentFamilyForEvent,
  tournamentFilterOptionsForStandings,
} from '../src/lib/internationalTournaments.ts'
import type { PublicTeamStanding } from '../src/lib/publicArtifacts/schema.ts'

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

test('does not treat regional qualifier labels as international tournament fields', () => {
  assert.equal(tournamentFamilyForEvent('LCK 2026 Road to MSI'), undefined)
  assert.equal(tournamentFamilyForEvent('Esports World Cup 2026/Online Qualifiers/Korea'), undefined)
})

test('builds tournament filter options from teams with tournament matches', () => {
  const options = tournamentFilterOptionsForStandings([
    standingWithEvents('MSI 2026', '2026 Mid-Season Invitational'),
    standingWithEvents('FST 2026'),
    standingWithEvents('LCK 2026 Rounds 1-2'),
    standingWithEvents('Esports World Cup 2026/Online Qualifiers/Korea'),
  ])

  assert.deepEqual(
    options.map((option) => [option.value, option.count]),
    [
      ['All', 4],
      ['international', 2],
      ['first-stand', 1],
      ['msi', 1],
    ],
  )
})

test('matches tournament filters against team event families', () => {
  const standing = standingWithEvents('MSI 2026')

  assert.equal(teamMatchesTournamentFilter(standing, 'All'), true)
  assert.equal(teamMatchesTournamentFilter(standing, 'international'), true)
  assert.equal(teamMatchesTournamentFilter(standing, 'msi'), true)
  assert.equal(teamMatchesTournamentFilter(standing, 'first-stand'), false)
})

test('prefers durable tournament appearance metadata over the recent-match window', () => {
  const options = tournamentFilterOptionsForStandings([{
    tournamentAppearances: [{
      family: 'worlds',
      event: 'Worlds 2026 Main Event',
      lastDate: '2026-10-20',
      matchCount: 4,
    }],
    recentMatches: [],
  }])

  assert.deepEqual(
    options.map((option) => [option.value, option.count]),
    [
      ['All', 1],
      ['international', 1],
      ['worlds', 1],
    ],
  )
})

function standingWithEvents(...events: string[]): Pick<PublicTeamStanding, 'recentMatches' | 'tournamentAppearances'> {
  return {
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
