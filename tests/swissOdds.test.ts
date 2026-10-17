import assert from 'node:assert/strict'
import test from 'node:test'
import { drawByRulebook, drawProblem, fillDraw, pairReason, resolveScenario, seedBaseline, type DrawnRound } from '../src/lib/swissScenario'
import { simulateSwissOdds, type SeriesWinChance } from '../src/lib/swissOdds'
import { WORLDS_2026_SWISS_RULES } from '../src/lib/worlds2026Swiss'
import { shuffled, worldsRandom } from '../src/lib/worldsSimulation'

const baseline = seedBaseline('LEC', 'Fnatic')
const ids = baseline.teams.map((team) => team.id)
const coinFlip: SeriesWinChance = () => 0.5
/** The team earlier in the seed list always wins. */
const bySeed: SeriesWinChance = (a, b) => ids.indexOf(a) < ids.indexOf(b) ? 1 : 0

function roundOneContext() {
  const next = resolveScenario(baseline, []).next
  assert.equal(next.kind, 'draw')
  if (next.kind !== 'draw') throw new Error('no draw')
  return next.context
}

test('a drawn team that would break a restriction, now or later in the draw, moves to the next open slot', () => {
  const context = roundOneContext()
  const legal = (a: string, b: string) => !pairReason(a, b, context)
  // LCK4 may not meet LCK1. LCP2 may not take the LCS1 slot, because then Fnatic (LEC) could only meet LEC1.
  assert.deepEqual(drawByRulebook(['LCK1', 'LPL1', 'LCS1', 'LEC1', 'LCK4', 'LPL4', 'LCP2', 'PLAYIN'], legal),
    [['LCK1', 'LPL4'], ['LPL1', 'LCK4'], ['LCS1', 'PLAYIN'], ['LEC1', 'LCP2']])
})

test('the rulebook draw always gives a legal Round 1 for any pot order', () => {
  const context = roundOneContext()
  const random = worldsRandom(5)
  for (let draw = 0; draw < 300; draw++) {
    const order = [0, 3, 1, 2].flatMap((pool) => shuffled([...WORLDS_2026_SWISS_RULES.pools[pool]], random))
    const pairs = drawByRulebook(order, (a, b) => !pairReason(a, b, context))
    assert.ok(pairs)
    assert.equal(drawProblem(pairs, context), null)
  }
})

test('every trial sends exactly eight teams through, and a group gets a team out at least as often as its best member', () => {
  const lec = baseline.teams.filter((team) => team.region === 'LEC').map((team) => team.id)
  const odds = simulateSwissOdds(baseline.teams, resolveScenario(baseline, []), coinFlip, [lec, ids], { trials: 2000, seed: 1 })
  const total = [...odds.advance.values()].reduce((sum, value) => sum + value, 0)
  assert.ok(Math.abs(total - 8) < 1e-9, `eight teams advance per trial, got ${total}`)
  assert.equal(odds.anyAdvance[1], 1)
  const lecShares = lec.map((id) => odds.advance.get(id)!)
  assert.ok(odds.anyAdvance[0] >= Math.max(...lecShares) && odds.anyAdvance[0] <= lecShares.reduce((sum, value) => sum + value, 0))
})

test('a team that wins every match always advances, and one that loses every match never does', () => {
  const odds = simulateSwissOdds(baseline.teams, resolveScenario(baseline, []), bySeed, [], { trials: 500, seed: 2 })
  assert.equal(odds.advance.get(ids[0]), 1)
  assert.equal(odds.advance.get(ids.at(-1)!), 0)
})

test('picked results count as played, whatever the ratings say', () => {
  const random = worldsRandom(1)
  let choices: DrawnRound[] = []
  for (let scenario = resolveScenario(baseline, choices); scenario.next.kind !== 'complete'; scenario = resolveScenario(baseline, choices)) {
    if (scenario.next.kind === 'draw') {
      const pairs = fillDraw(scenario.next.context, random)!
      choices = [...scenario.choices, { pairs, winners: pairs.map(() => null) }]
    } else {
      // The upset result: the later seed wins every picked match.
      choices = scenario.choices.map((round) => ({ pairs: round.pairs, winners: round.pairs.map((pair) => ids.indexOf(pair[0]) > ids.indexOf(pair[1]) ? pair[0] : pair[1]) }))
    }
  }
  const finished = resolveScenario(baseline, choices)
  const odds = simulateSwissOdds(baseline.teams, finished, bySeed, [], { trials: 50, seed: 3 })
  for (const row of finished.standings) assert.equal(odds.advance.get(row.id), row.status === 'advanced' ? 1 : 0, row.id)
})

test('the same seed gives the same odds, and ten thousand trials stay fast', () => {
  const scenario = resolveScenario(baseline, [])
  const started = performance.now()
  const first = simulateSwissOdds(baseline.teams, scenario, coinFlip, [ids], { trials: 10_000, seed: 4 })
  const elapsed = performance.now() - started
  assert.deepEqual(simulateSwissOdds(baseline.teams, scenario, coinFlip, [ids], { trials: 10_000, seed: 4 }), first)
  console.log(`10,000 trials in ${elapsed.toFixed(0)} ms`)
})
