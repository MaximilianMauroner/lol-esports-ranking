import assert from 'node:assert/strict'
import test from 'node:test'
import { tournamentSections, type EliminationSection, type GroupSection, type SwissSection } from '../src/lib/tournamentBracket'
import type { TournamentSeries } from '../src/lib/tournamentFeed'

/** [Leaguepedia tab_N, start day (null when not supplied), team 1, team 2, winner (1, 2 or 0 for unplayed)] */
type Row = [string, string | null, string | null, string | null, 0 | 1 | 2]

function event(rows: Row[]): TournamentSeries[] {
  return rows.map(([tabMatch, day, first, second, winner]) => {
    const stage = tabMatch.replace(/_\d+$/, '')
    const team = (name: string | null, slot: 1 | 2) => ({
      id: name, name, code: null,
      gameWins: winner ? (winner === slot ? 3 : 1) : null,
      outcome: winner ? (winner === slot ? 'win' : 'loss') : null,
    })
    return {
      id: `Event_${tabMatch}`, eventId: 'Event', startTime: day ? `2026-${day}:00.000Z` : null, stage,
      status: winner ? 'completed' : 'upcoming', sourceState: winner ? 'completed' : 'scheduled', bestOf: 5,
      teams: [team(first, 1), team(second, 2)], vodUrls: [],
    }
  })
}
function sides(section: EliminationSection) {
  return Object.fromEntries(section.matches.map((match) => [match.series.id.replace('Event_', ''), match.side]))
}
function feeders(section: EliminationSection, id: string) {
  return section.matches.find((match) => match.series.id === `Event_${id}`)!.feeders.map((feeder) => feeder.replace('Event_', ''))
}

test('a double-elimination playoff gets upper and lower brackets, byes and a grand final from team records', () => {
  // LCS 2026 Summer Playoffs. Upper and lower series share "Round N" tabs; seeds 1 and 2 enter in Round 2.
  const [section] = tournamentSections(event([
    ['Round 1_1', '09-12T20:00', 'Cloud9', 'Shopify Rebellion', 1],
    ['Round 1_2', '09-13T20:00', 'Sentinels', 'FlyQuest', 2],
    ['Round 2_1', '09-19T20:00', 'LYON', 'Cloud9', 2],
    ['Round 1_3', '09-18T20:00', 'Shopify Rebellion', 'Sentinels', 1],
    ['Round 2_2', '09-20T20:00', 'Team Liquid', 'FlyQuest', 1],
    ['Round 2_3', '09-25T20:00', 'FlyQuest', 'Shopify Rebellion', 2],
    ['Round 3_1', '09-26T20:00', 'LYON', 'Shopify Rebellion', 1],
    ['Round 4_1', '09-27T20:00', 'Cloud9', 'Team Liquid', 2],
    ['Round 4_2', '10-03T20:00', 'Cloud9', 'LYON', 2],
    ['Finals_1', '10-04T20:00', 'Team Liquid', 'LYON', 1],
  ]))
  assert.equal(section?.kind, 'elimination')
  const bracket = section as EliminationSection
  assert.equal(bracket.hasLower, true)
  assert.deepEqual(bracket.columns, ['Round 1', 'Round 2', 'Round 3', 'Round 4', 'Finals'])
  assert.deepEqual(sides(bracket), {
    'Round 1_1': 'upper', 'Round 1_2': 'upper', 'Round 1_3': 'lower',
    'Round 2_1': 'upper', 'Round 2_2': 'upper', 'Round 2_3': 'lower',
    'Round 3_1': 'lower', 'Round 4_1': 'upper', 'Round 4_2': 'lower', 'Finals_1': 'final',
  })
  assert.deepEqual(feeders(bracket, 'Round 2_1'), ['Round 1_1'], 'A bye team has no feeder')
  assert.deepEqual(feeders(bracket, 'Round 4_1').sort(), ['Round 2_1', 'Round 2_2'])
  assert.deepEqual(feeders(bracket, 'Round 1_3'), [], 'Teams dropping from the upper bracket have no lower-lane feeder')
  assert.deepEqual(feeders(bracket, 'Finals_1').sort(), ['Round 4_1', 'Round 4_2'])
})

test('a beaten team meeting a fresh lower-bracket seed plays in the lower bracket', () => {
  // LEC 2026 Spring Playoffs: Natus Vincere and GIANTX enter the lower bracket in the "Round 1" tab.
  const [section] = tournamentSections(event([
    ['Round 1_1', '05-23T15:00', 'Karmine Corp', 'G2 Esports', 2],
    ['Round 1_2', '05-24T15:00', 'Team Vitality', 'Movistar KOI', 2],
    ['Round 3_1', '05-25T15:00', 'Movistar KOI', 'G2 Esports', 2],
    ['Round 1_3', '05-30T15:00', 'Karmine Corp', 'Natus Vincere', 1],
    ['Round 1_4', '05-31T15:00', 'Team Vitality', 'GIANTX', 2],
    ['Round 2_1', '06-01T15:00', 'Karmine Corp', 'GIANTX', 1],
    ['Round 3_2', '06-06T15:00', 'Movistar KOI', 'Karmine Corp', 2],
    ['Finals_1', '06-07T15:00', 'G2 Esports', 'Karmine Corp', 1],
  ]))
  const bracket = section as EliminationSection
  assert.deepEqual(sides(bracket), {
    'Round 1_1': 'upper', 'Round 1_2': 'upper', 'Round 3_1': 'upper',
    'Round 1_3': 'lower', 'Round 1_4': 'lower', 'Round 2_1': 'lower', 'Round 3_2': 'lower', 'Finals_1': 'final',
  })
  assert.deepEqual(bracket.columns, ['Round 1', 'Round 2', 'Round 3', 'Finals'], 'Round 3_1 plays before Round 2_1, but rounds stay in number order')
  assert.deepEqual(feeders(bracket, 'Round 2_1'), ['Round 1_3', 'Round 1_4'])
  assert.deepEqual(feeders(bracket, 'Finals_1'), ['Round 3_1', 'Round 3_2'])
})

test('a named round robin opening a knockout stays in the upper bracket', () => {
  // Asia Masters 2025 Finals: three teams play each other once in the Last Chance Qualifier.
  const [section] = tournamentSections(event([
    ['Last Chance Qualifier_1', '10-09T06:00', 'KT', 'DRX', 2],
    ['Last Chance Qualifier_2', '10-09T08:00', 'KT', 'DK', 1],
    ['Last Chance Qualifier_3', '10-09T10:00', 'DK', 'DRX', 2],
    ['Round 1_1', '10-10T06:00', 'DRX', 'DNF', 1], ['Round 1_2', '10-10T09:00', 'BFX', 'T1', 2],
    ['Round 2_1', '10-11T06:00', 'DRX', 'T1', 2], ['Round 1_3', '10-11T09:00', 'DNF', 'BFX', 1],
    ['Round 2_2', '10-12T09:00', 'DRX', 'DNF', 1], ['Finals_1', '10-13T09:00', 'T1', 'DRX', 1],
  ]))
  const bracket = sides(section as EliminationSection)
  assert.deepEqual(['_1', '_2', '_3'].map((n) => bracket[`Last Chance Qualifier${n}`]), ['upper', 'upper', 'upper'])
  assert.deepEqual([bracket['Round 1_3'], bracket['Round 2_2'], bracket['Finals_1']], ['lower', 'lower', 'final'])
})

test('Play-In losses do not move playoff series into the lower bracket', () => {
  // LPL 2026 Split 1 Playoffs, trimmed: Team WE and Invictus Gaming lost in the Play-In, then open the playoffs.
  const [section] = tournamentSections(event([
    ['Play-In Round 1_1', '02-09T06:00', 'Top Esports', 'Team WE', 1],
    ['Play-In Round 1_2', '02-09T09:00', 'Invictus Gaming', 'Ninjas in Pyjamas.CN', 2],
    ['Play-In Round 2_1', '02-10T06:00', 'ThunderTalk Gaming', 'LNG Esports', 2],
    ['Play-In Round 2_2', '02-10T09:00', 'EDward Gaming', 'Oh My God', 2],
    ['Play-In Round 3_1', '02-11T06:00', 'Invictus Gaming', 'Oh My God', 1],
    ['Play-In Round 3_2', '02-11T09:00', 'Team WE', 'LNG Esports', 1],
    ['Round 1_1', '02-24T06:00', 'JD Gaming', 'Top Esports', 1],
    ['Round 1_2', '02-24T09:00', "Anyone's Legend", 'Team WE', 1],
    ['Round 1_3', '02-25T06:00', 'Weibo Gaming', 'Invictus Gaming', 1],
    ['Round 1_4', '02-25T09:00', 'Bilibili Gaming', 'Ninjas in Pyjamas.CN', 1],
  ]))
  const bracket = sides(section as EliminationSection)
  assert.deepEqual([bracket['Play-In Round 3_1'], bracket['Play-In Round 3_2']], ['lower', 'lower'])
  assert.deepEqual([bracket['Round 1_1'], bracket['Round 1_2'], bracket['Round 1_3'], bracket['Round 1_4']], ['upper', 'upper', 'upper', 'upper'])
})

test('Swiss rounds before a double-elimination playoff with an unbeaten-versus-unbeaten final', () => {
  // LCS 2026 Lock-In: LYON drops to the lower bracket without a playoff loss and wins the Finals.
  const sections = tournamentSections(event([
    ['Swiss Round 1_1', '01-24T21:00', 'C9', 'TL', 1], ['Swiss Round 1_2', '01-25T00:00', 'SR', 'DSG', 2],
    ['Swiss Round 1_3', '01-25T21:00', 'FLY', 'SHO', 1], ['Swiss Round 1_4', '01-26T00:00', 'LYON', 'DIG', 1],
    ['Swiss Round 2_1', '01-31T21:00', 'C9', 'LYON', 1], ['Swiss Round 2_2', '02-01T00:00', 'SR', 'DIG', 1],
    ['Swiss Round 2_3', '02-01T21:00', 'FLY', 'DSG', 1], ['Swiss Round 2_4', '02-02T00:00', 'SHO', 'TL', 2],
    ['Swiss Round 3_1', '02-07T21:00', 'TL', 'SR', 2], ['Swiss Round 3_2', '02-08T00:00', 'DSG', 'LYON', 1],
    ['Swiss Round 3_3', '02-08T21:00', 'DIG', 'SHO', 1], ['Swiss Round 3_4', '02-09T00:00', 'C9', 'FLY', 1],
    ['Last Chance_1', '02-09T03:00', 'TL', 'DIG', 1],
    ['Playoffs Round 1_1', '02-14T21:00', 'SR', 'DSG', 1], ['Playoffs Round 1_2', '02-15T21:00', 'C9', 'FLY', 1],
    ['Playoffs Round 1_3', '02-20T21:00', 'DSG', 'TL', 2], ['Playoffs Round 1_4', '02-21T21:00', 'FLY', 'LYON', 2],
    ['Playoffs Round 2_1', '02-22T21:00', 'C9', 'SR', 1], ['Playoffs Round 2_2', '02-27T21:00', 'LYON', 'TL', 1],
    ['Playoffs Round 3_1', '02-28T21:00', 'SR', 'LYON', 2],
    ['Finals_1', '03-01T21:00', 'C9', 'LYON', 2],
  ]))
  assert.deepEqual(sections.map((section) => section.kind), ['swiss', 'elimination'])
  const bracket = sections[1] as EliminationSection
  assert.equal(bracket.hasLower, true)
  assert.equal(sides(bracket)['Finals_1'], 'final')
})

test('an undrawn double-elimination bracket places TBD series by tab order and team counts', () => {
  // Worlds 2026 Play-In before its first series: only the opening pairs are known.
  const [section] = tournamentSections(event([
    ['Round 1_1', '10-15T18:00', 'Cloud9', 'Karmine Corp', 0],
    ['Round 1_2', '10-15T23:00', 'FURIA', 'MVK Esports', 0],
    ['Round 2_1', '10-16T18:00', null, null, 0],
    ['Round 1_3', '10-16T23:00', null, null, 0],
    ['Round 2_2', '10-17T18:00', null, null, 0],
    ['Round 3_1', '10-18T18:00', null, null, 0],
  ]))
  const bracket = section as EliminationSection
  assert.deepEqual(sides(bracket), {
    'Round 1_1': 'upper', 'Round 1_2': 'upper', 'Round 1_3': 'lower',
    'Round 2_1': 'upper', 'Round 2_2': 'lower', 'Round 3_1': 'final',
  })
  assert.deepEqual(feeders(bracket, 'Round 2_1'), ['Round 1_1', 'Round 1_2'])
  assert.deepEqual(feeders(bracket, 'Round 2_2'), ['Round 1_3'])
})

test('a knockout without losers rounds is single elimination with paired feeders', () => {
  const [section] = tournamentSections(event([
    ['Quarterfinals_1', '11-03T22:00', 'Gen.G', 'T1', 1],
    ['Quarterfinals_2', '11-04T22:00', 'BLG', 'G2', 2],
    ['Quarterfinals_3', '11-05T22:00', null, null, 0],
    ['Quarterfinals_4', '11-06T22:00', null, null, 0],
    ['Semifinals_1', '11-07T22:00', 'Gen.G', 'G2', 0],
    ['Semifinals_2', '11-08T22:00', null, null, 0],
    ['Finals_1', '11-14T19:00', null, null, 0],
  ]))
  const bracket = section as EliminationSection
  assert.equal(bracket.hasLower, false)
  assert.ok(bracket.matches.every((match) => match.side === 'upper'))
  assert.deepEqual(feeders(bracket, 'Semifinals_1'), ['Quarterfinals_1', 'Quarterfinals_2'])
  assert.deepEqual(feeders(bracket, 'Semifinals_2'), ['Quarterfinals_3', 'Quarterfinals_4'])
  assert.deepEqual(feeders(bracket, 'Finals_1'), ['Semifinals_1', 'Semifinals_2'])
})

test('later knockout tabs without start times keep play order', () => {
  const [section] = tournamentSections(event([
    ['Quarterfinals_1', '11-03T22:00', 'Gen.G', 'T1', 0],
    ['Quarterfinals_2', '11-04T22:00', 'BLG', 'G2', 0],
    ['Semifinals_1', null, null, null, 0],
    ['Finals_1', null, null, null, 0],
  ]))
  const bracket = section as EliminationSection
  assert.deepEqual(bracket.columns, ['Quarterfinals', 'Semifinals', 'Finals'])
  assert.deepEqual(feeders(bracket, 'Semifinals_1'), ['Quarterfinals_1', 'Quarterfinals_2'])
  assert.deepEqual(feeders(bracket, 'Finals_1'), ['Semifinals_1'])
})

test('decided series fill TBD slots unless already linked to this round', () => {
  const [section] = tournamentSections(event([
    ['Quarterfinals_1', '11-03T22:00', 'Gen.G', 'T1', 1],
    ['Quarterfinals_2', '11-04T22:00', 'BLG', 'G2', 2],
    ['Quarterfinals_3', '11-05T22:00', 'HLE', 'TES', 1],
    ['Quarterfinals_4', '11-06T22:00', 'KT', 'FLY', 0],
    ['Semifinals_1', '11-07T22:00', null, null, 0],
    ['Semifinals_2', '11-08T22:00', 'HLE', null, 0],
    ['Finals_1', '11-14T19:00', null, null, 0],
  ]))
  const bracket = section as EliminationSection
  assert.deepEqual(feeders(bracket, 'Semifinals_1'), ['Quarterfinals_1', 'Quarterfinals_2'], 'Two decided quarterfinals feed an undrawn semifinal')
  assert.deepEqual(feeders(bracket, 'Semifinals_2'), ['Quarterfinals_3', 'Quarterfinals_4'])

  const [moved] = tournamentSections(event([
    ['Quarterfinals_1', '11-03T22:00', 'Gen.G', 'T1', 1],
    ['Quarterfinals_2', '11-04T22:00', 'BLG', 'G2', 2],
    ['Quarterfinals_3', '11-05T22:00', 'HLE', 'TES', 0],
    ['Quarterfinals_4', '11-06T22:00', 'KT', 'FLY', 0],
    ['Semifinals_1', '11-07T22:00', null, null, 0],
    ['Semifinals_2', '11-08T22:00', 'Gen.G', null, 0],
  ]))
  assert.deepEqual(feeders(moved as EliminationSection, 'Semifinals_1'), ['Quarterfinals_2'], 'A quarterfinal already linked to Semifinals_2 does not fill a TBD slot')
})

test('an undrawn 16-team Swiss stage gets its record pools from the round sizes', () => {
  const rounds: Array<[string, number]> = [['Round 1', 8], ['Round 2', 8], ['Round 3', 8], ['Round 4', 6], ['Round 5', 3]]
  const rows = rounds.flatMap(([tab, count], index) => Array.from({ length: count }, (_, n): Row => [`${tab}_${n + 1}`, `10-${23 + index}T${String(10 + n).padStart(2, '0')}:00`, null, null, 0]))
  const sections = tournamentSections(event([...rows, ['Quarterfinals_1', '11-03T22:00', null, null, 0]]))
  assert.deepEqual(sections.map((section) => section.kind), ['swiss', 'elimination'])
  const swiss = sections[0] as SwissSection
  assert.equal(swiss.winsToAdvance, 3)
  assert.deepEqual(swiss.rounds.map((round) => round.pools.map((pool) => `${pool.label}:${pool.pending}`)), [
    ['0–0:8'], ['1–0:4', '0–1:4'], ['2–0:2', '1–1:4', '0–2:2'], ['2–1:3', '1–2:3'], ['2–2:3'],
  ])
})

test('a Swiss stage with results groups series by record and marks who advanced', () => {
  // Demacia Cup 2026: teams on 0–2 keep playing, which double elimination never does.
  const sections = tournamentSections(event([
    ['Round 1_1', '10-03T08:00', 'RED', 'NAVI', 1], ['Round 1_2', '10-03T09:00', 'LGD', 'FLY', 1],
    ['Round 1_3', '10-03T10:00', 'SR', 'KT', 2], ['Round 1_4', '10-03T11:00', 'VIT', 'BFX', 2],
    ['Round 2_1', '10-04T07:00', 'LGD', 'BFX', 2], ['Round 2_2', '10-04T09:00', 'RED', 'KT', 2],
    ['Round 2_3', '10-04T11:00', 'NAVI', 'FLY', 1], ['Round 2_4', '10-05T07:00', 'SR', 'VIT', 2],
    ['Round 3_1', '10-06T07:00', 'FLY', 'SR', 1],
    ['Quarterfinals_1', '10-12T06:00', 'KT', 'BFX', 1],
  ]))
  assert.deepEqual(sections.map((section) => section.kind), ['swiss', 'elimination'])
  const swiss = sections[0] as SwissSection
  assert.equal(swiss.winsToAdvance, null, 'This format does not match standard Swiss arithmetic')
  assert.deepEqual(swiss.rounds[1]!.pools.map((pool) => `${pool.label}:${pool.series.length}`), ['1–0:2', '0–1:2'])
  assert.deepEqual(swiss.rounds[2]!.pools.map((pool) => pool.label), ['0–2'])
  const advanced = swiss.standings.filter((standing) => standing.status === 'advanced').map((standing) => standing.team).sort()
  assert.deepEqual(advanced, ['BFX', 'KT'])
})

test('round-robin days become groups of teams that only play each other', () => {
  const sections = tournamentSections(event([
    ['Day 1_1', '09-20T06:00', 'T1A', 'EDGY', 2], ['Day 1_2', '09-20T07:00', 'Solary', 'Galions', 1],
    ['Day 2_1', '09-21T06:00', 'T1A', 'Fuego', 1], ['Day 2_2', '09-21T07:00', 'Galions', 'ZSK', 1],
    ['Day 3_1', '09-22T06:00', 'EDGY', 'Fuego', 1], ['Day 3_2', '09-22T07:00', 'Solary', 'ZSK', 1],
    ['Semifinals_1', '09-30T06:00', 'Solary', 'EDGY', 1],
  ]))
  assert.deepEqual(sections.map((section) => section.kind), ['groups', 'elimination'])
  const groups = (sections[0] as GroupSection).groups
  assert.deepEqual(groups.map((group) => group.standings.map((standing) => `${standing.team} ${standing.wins}-${standing.losses}`)), [
    ['EDGY 2-0', 'T1A 1-1', 'Fuego 0-2'],
    ['Solary 2-0', 'Galions 1-1', 'ZSK 0-2'],
  ])
})

test('named group tabs stay separate groups even when teams meet across them', () => {
  const [section] = tournamentSections(event([
    ['Group A_1', '09-20T06:00', 'A', 'B', 1],
    ['Group B_1', '09-20T07:00', 'C', 'D', 1],
    ['Group C_1', '09-21T06:00', 'A', 'C', 2],
  ]))
  const groups = (section as GroupSection).groups
  assert.deepEqual(groups.map((group) => `${group.label}: ${group.standings.map((standing) => `${standing.team} ${standing.wins}-${standing.losses}`).join(', ')}`), [
    'Group A: A 1-0, B 0-1', 'Group B: C 1-0, D 0-1', 'Group C: C 1-0, A 0-1',
  ])
})

test('"Group Stage" tabs are not group names, so their pods come from who plays whom', () => {
  const pods = (rows: Row[]) => (tournamentSections(event(rows))[0] as GroupSection).groups
    .map((group) => `${group.label}: ${group.standings.map((standing) => standing.team).sort().join(',')}`)
  assert.deepEqual(pods([
    ['Group Stage_1', '09-20T06:00', 'A', 'B', 1], ['Group Stage_2', '09-20T07:00', 'D', 'E', 1],
    ['Group Stage_3', '09-21T06:00', 'B', 'C', 1], ['Group Stage_4', '09-21T07:00', 'E', 'F', 1],
  ]), ['null: A,B,C', 'null: D,E,F'])
  assert.deepEqual(pods([
    ['Group Stage Day 1_1', '09-20T06:00', 'A', 'B', 1], ['Group Stage Day 1_2', '09-20T07:00', 'D', 'E', 1],
    ['Group Stage Day 2_1', '09-21T06:00', 'B', 'C', 1], ['Group Stage Day 2_2', '09-21T07:00', 'E', 'F', 1],
  ]), ['null: A,B,C', 'null: D,E,F'])
})
