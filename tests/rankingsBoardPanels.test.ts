import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { WhatChanged } from '../src/components/WhatChanged.tsx'
import { deriveRankingBoard, deriveRankingUniverse, type RankingBoardSelection, type RankingEvidence } from '../src/lib/rankingBoard.ts'
import type { RankingSummaryStanding } from '../src/lib/snapshot.ts'
import type { PublicTournamentMovementIndexEntry, PublicTournamentMovementShard, PublicTournamentMovementTeam } from '../src/lib/publicArtifacts/schema.ts'
import type { TournamentInstanceId } from '../src/lib/internationalTournaments.ts'

test('What changed names the upset event like the match ledger, not by its source path', () => {
  // Issue #115 F2.
  const html = renderToStaticMarkup(createElement(WhatChanged, {
    period: '30 days',
    upset: { winner: 'AL', loser: 'BLG', event: 'LPL/2026 Season/Regional Finals', chance: 0.21 },
  }))

  assert.match(html, /LPL · 2026 · Regional Finals/)
  assert.doesNotMatch(html, /LPL\/2026 Season/)
})

test('record order breaks equal wins by losses, and the reverse order mirrors it', () => {
  // Issue #115 F5: T1 39-22 sorted above KC 39-18 because only wins counted.
  const universe = deriveRankingUniverse(evidence([
    standing('T1', { rank: 1, wins: 39, losses: 22 }),
    standing('G2', { rank: 2, wins: 37, losses: 15 }),
    standing('KC', { rank: 3, wins: 39, losses: 18 }),
  ]))

  assert.deepEqual(teams(deriveRankingBoard(universe, selection({ sortKey: 'wins', sortDirection: 'descending' })).rows), ['KC', 'T1', 'G2'])
  assert.deepEqual(teams(deriveRankingBoard(universe, selection({ sortKey: 'wins', sortDirection: 'ascending' })).rows), ['G2', 'T1', 'KC'])
})

test('a falling participant left alone by the filters is only the faller', () => {
  const scope = [standing('Gen.G', { region: 'LCK', rank: 1 }), standing('KC', { region: 'LEC', rank: 2 })]
  const falling = deriveRankingUniverse(evidence(scope, msi([movement('Gen.G', 2), movement('KC', -4)])))
  assert.deepEqual(pickedTeams(deriveRankingBoard(falling, selection({ region: 'LEC' }))), { riser: undefined, faller: 'KC' })

  const rising = deriveRankingUniverse(evidence(scope, msi([movement('Gen.G', -2), movement('KC', 4)])))
  assert.deepEqual(pickedTeams(deriveRankingBoard(rising, selection({ region: 'LEC' }))), { riser: 'KC', faller: undefined })
})

test('tiers stay canonical for the scope while counts and disclosures follow the filters', () => {
  const universe = deriveRankingUniverse(evidence([
    standing('Leader', { region: 'LCK', rank: 1, rating: 2300 }),
    standing('Middle', { region: 'LEC', rank: 20, rating: 1900 }),
    standing('Last', { region: 'LEC', rank: 56, rating: 1500 }),
    standing('Newcomer', { region: 'LEC', rank: 57, rating: 1450, eligibility: { eligible: false } as RankingSummaryStanding['eligibility'] }),
  ]))
  const lec = deriveRankingBoard(universe, selection({ region: 'LEC' }))

  assert.deepEqual(teams(lec.rows), ['Middle', 'Last'])
  assert.deepEqual(lec.rows.map(universe.tierFor), ['B', 'C'])
  assert.deepEqual(lec.tierCounts, [{ tier: 'S', count: 0 }, { tier: 'A', count: 0 }, { tier: 'B', count: 1 }, { tier: 'C', count: 1 }])
  assert.deepEqual(teams(deriveRankingBoard(universe, selection({ region: 'LEC', tier: 'S' })).rows), [])
  assert.deepEqual(lec.disclosure, { regionFilter: 'LEC', tournamentFilter: 'All', tableTeamCount: 2, scopeTeamCount: 4, hiddenFromRankedCount: 1 })
  assert.equal(lec.activeFilterCount, 1)
})

test('an exact tournament board and its comparisons read one projected universe', () => {
  const scope = [
    standing('Gen.G', { region: 'LCK', rank: 1, rating: 2200 }),
    standing('KC', { region: 'LEC', rank: 2, rating: 2100 }),
    standing('Home only', { region: 'LCK', rank: 3, rating: 2000 }),
  ]
  const universe = deriveRankingUniverse(evidence(scope, msi([movement('Gen.G', 2), movement('KC', -4)])))
  const board = deriveRankingBoard(universe, selection({ region: 'LEC', pageSize: 1, requestedPage: 9 }))

  assert.deepEqual(teams(universe.standings), ['Gen.G', 'KC'])
  assert.deepEqual(universe.standings.map((team) => team.rating), [2020, 1960])
  assert.deepEqual(teams(board.visibleRows), ['KC'])
  assert.equal(board.visibleRows[0], universe.standings[1])
  assert.deepEqual(board.page, { current: 1, count: 1, start: 0, end: 1 })
  assert.equal(board.disclosure.scopeTeamCount, 2)
})

test('a loaded tournament that the index does not offer projects neither the board nor comparisons', () => {
  const scope = [standing('Gen.G', { rank: 1, rating: 2200 }), standing('Home only', { rank: 2, rating: 2000 })]
  const universe = deriveRankingUniverse({ ...evidence(scope, msi([movement('Gen.G', 2)])), tournamentEntries: [] })

  assert.equal(universe.tournamentFilter, 'All')
  assert.equal(universe.tournament, undefined)
  assert.equal(universe.standings, scope)
  assert.deepEqual(teams(deriveRankingBoard(universe, selection()).rows), ['Gen.G', 'Home only'])
})

const MSI = 'msi:2026' as TournamentInstanceId

function evidence(standings: RankingSummaryStanding[], shard?: PublicTournamentMovementShard): RankingEvidence {
  return {
    standings,
    regions: [],
    requestedTournamentFilter: shard ? `tournament:${MSI}` : 'All',
    tournamentEntries: shard ? [{ ...shard, url: '/data/history/tournament-moves/msi-2026.json' } as PublicTournamentMovementIndexEntry] : [],
    tournamentShard: shard,
    latestMatchDate: '2026-07-02',
  }
}

function selection(overrides: Partial<RankingBoardSelection> = {}): RankingBoardSelection {
  return { region: 'All', tier: 'All', eligibility: 'ranked', search: '', sortKey: 'rank', sortDirection: 'ascending', pageSize: 25, requestedPage: 1, ...overrides }
}

function msi(teams: PublicTournamentMovementTeam[]): PublicTournamentMovementShard {
  return {
    id: MSI, family: 'msi', season: '2026', label: 'MSI 2026', status: 'completed',
    startDate: '2026-06-28', boundaryDate: '2026-07-02', ratedThroughDate: '2026-07-02', dataLag: false,
    participantCount: teams.length, teams,
  } as PublicTournamentMovementShard
}

function movement(team: string, rankMovement: number): PublicTournamentMovementTeam {
  const ratingDelta = rankMovement * 10
  return {
    teamId: team, team, code: team, eligible: true, eligibilityReasons: [],
    startRank: 5, endRank: 5 - rankMovement, rankMovement, startRating: 2000, endRating: 2000 + ratingDelta, ratingDelta, points: [],
  }
}

function standing(team: string, overrides: Partial<RankingSummaryStanding> = {}): RankingSummaryStanding {
  return {
    teamId: team, team, code: team, region: 'LCK', league: 'LCK', rank: 1, rating: 2000, wins: 10, losses: 5,
    confidence: 70, uncertainty: 60, recentMatches: [], eligibility: { eligible: true }, ...overrides,
  } as RankingSummaryStanding
}

function teams(rows: readonly RankingSummaryStanding[]) {
  return rows.map((row) => row.team)
}

function pickedTeams({ movement }: ReturnType<typeof deriveRankingBoard>) {
  if (movement.kind !== 'tournament') assert.fail('expected tournament movement')
  return { riser: movement.riser?.team, faller: movement.faller?.team }
}
