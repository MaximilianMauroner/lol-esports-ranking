import assert from 'node:assert/strict'
import test from 'node:test'
import { fitHierarchicalLeagues } from '../scripts/lib/hierarchical-leagues.ts'
import type { EvaluationRow } from '../src/lib/rankingEvaluation.ts'

function domesticAndSelectedEntrantRows() {
  const rows: EvaluationRow[] = []
  const add = (teamA: string, leagueA: string, teamB: string, leagueB: string, actual: 0 | 1) => {
    const id = `hierarchy-${rows.length}`
    rows.push({ id, seriesId: id, eventId: 'synthetic-hierarchy', date: '2025-01-01',
      teamA, leagueA, teamB, leagueB, actual, probability: .5, segments: [] })
  }
  for (let index = 0; index < 40; index += 1) {
    add('A0', 'A', 'A1', 'A', index % 2 === 0 ? 1 : 0)
    add('B0', 'B', 'B1', 'B', index % 2 === 0 ? 1 : 0)
    add('A0', 'A', 'B0', 'B', index % 2 === 0 ? 1 : 0)
    add('B-selected', 'B', 'A1', 'A', 1)
  }
  return { rows, add }
}

test('an international-only entrant does not change the mean used to center domestic team effects', () => {
  const { rows } = domesticAndSelectedEntrantRows()
  const fit = fitHierarchicalLeagues(rows, new Map([['A', 0], ['B', 0]]), 'A')
  const domesticB = fit.teams.filter((team) => team.league === 'B' && team.domesticGames > 0)
  const selected = fit.teams.find((team) => team.key === 'B\u0000B-selected')!
  assert.equal(domesticB.length, 2)
  assert.ok(Math.abs(domesticB.reduce((total, team) => total + team.value, 0)) < 1e-12)
  assert.equal(selected.domesticGames, 0)
  assert.ok(selected.value > .1)
  const leagueB = fit.leagues.find((league) => league.league === 'B')!
  assert.equal(leagueB.domesticMembers, 2)
  assert.equal(leagueB.provisional, false)
})

test('international links alone leave a league without observed domestic members provisional', () => {
  const { rows, add } = domesticAndSelectedEntrantRows()
  for (let index = 0; index < 40; index += 1) add('C-selected', 'C', 'A0', 'A', 1)
  const fit = fitHierarchicalLeagues(rows, new Map([['A', 0], ['B', 0], ['C', 0]]), 'A')
  const leagueC = fit.leagues.find((league) => league.league === 'C')!
  assert.equal(leagueC.connected, true)
  assert.equal(leagueC.crossGames, 40)
  assert.equal(leagueC.domesticMembers, 0)
  assert.equal(leagueC.provisional, true)
})
