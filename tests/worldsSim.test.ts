import assert from 'node:assert/strict'
import test from 'node:test'
import { simulateWorldsStyleTournament, type WorldsSimTeamInput } from '../src/lib/worldsSim.ts'

test('Worlds-style Swiss and bracket simulation is deterministic and conserved', () => {
  const teams = Array.from({ length: 16 }, (_, index): WorldsSimTeamInput => ({
    team: `Team ${index + 1}`,
    seed: index + 1,
    rating: 1800 - index * 35,
    uncertainty: 45,
    region: index < 4 ? 'LCK' : index < 8 ? 'LPL' : index < 12 ? 'LEC' : 'LCS',
  }))

  const first = simulateWorldsStyleTournament(teams, { iterations: 800, seed: 20260628 })
  const second = simulateWorldsStyleTournament(teams, { iterations: 800, seed: 20260628 })
  const favorite = first.teams[0]
  const outsider = first.teams.at(-1)

  assert.deepEqual(first, second)
  assert.equal(first.format.bracketSize, 8)
  assert.equal(first.format.swissBestOf, 1)
  assert.equal(first.format.swissQualificationBestOf, 3)
  assert.equal(first.format.bracketBestOf, 5)
  assert.ok(favorite)
  assert.ok(outsider)
  assert.ok(favorite.swissAdvanceProbability > outsider.swissAdvanceProbability)
  assert.ok(favorite.championshipProbability > outsider.championshipProbability)
  assert.ok(Math.abs(sum(first.teams.map((team) => team.bracketEntryProbability)) - 8) <= 0.001)
  assert.ok(Math.abs(sum(first.teams.map((team) => team.championshipProbability)) - 1) <= 0.001)
})

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0)
}
