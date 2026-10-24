import assert from 'node:assert/strict'
import test from 'node:test'
import { runSwissStats, swissStatsConditioning, type SwissStatsInput, type SwissStatsProvenance } from '../src/domains/tournaments/simulation'
import { simulateSwissStats } from '../src/domains/tournaments/internal/swissStats'
import { legalSwissMatchings, uniformLegalSwissDraw } from '../src/domains/tournaments/internal/swissLegalDraw'
import { drawContext, drawProblem, fillDraw, resolveScenario, seedBaseline, type DrawnRound, type SwissBaseline } from '../src/domains/tournaments/internal/swissScenario'
import { WORLDS_2026_SWISS_RULES } from '../src/domains/tournaments/internal/worlds2026Swiss'
import { worldsRandom } from '../src/domains/tournaments/internal/worldsSimulation'
import { worldsBasis, worldsEvent } from './fixtures/worldsFixtures'

const basis = worldsBasis()
const provenance: SwissStatsProvenance = { snapshotId: basis.snapshotId, publishedAt: basis.ratingPublishedAt, ratingDataAsOf: basis.ratingDataAsOf,
  dataMode: basis.dataMode, sources: ['synthetic-fixture'], modelVersion: basis.model.version, modelConfigHash: basis.model.configHash }
const options = { trials: 500, seed: 42 }
const baseline = seedBaseline('LEC', 'Fnatic')
function simulate(scenario = resolveScenario(baseline, []), trials = options.trials) {
  return simulateSwissStats(baseline.teams, scenario, () => 0.5, { ...options, trials }, provenance)
}
function ratedInput(): SwissStatsInput {
  return { teams: structuredClone(baseline.teams), scenario: resolveScenario(baseline, []), model: structuredClone(basis.model), provenance,
    standings: baseline.teams.map((team) => ({ ...structuredClone(basis.snapshot.standings[0]), team: team.label, teamId: team.id, region: team.region as typeof basis.snapshot.standings[number]['region'] })) }
}
function completed(source: SwissBaseline) {
  const random = worldsRandom(13)
  const choices: DrawnRound[] = []
  for (;;) {
    const scenario = resolveScenario(source, choices)
    if (scenario.next.kind === 'complete') return scenario
    assert.equal(scenario.next.kind, 'draw')
    if (scenario.next.kind !== 'draw') throw new Error('Unexpected open results')
    const pairs = fillDraw(scenario.next.context, random)!
    choices.push({ pairs, winners: pairs.map(([first]) => first) })
  }
}

test('the uniform sampler enumerates each small perfect matching once and selects equal-width intervals', () => {
  const ids = ['a', 'b', 'c', 'd']
  assert.deepEqual(legalSwissMatchings(ids, () => true), [
    [['a', 'b'], ['c', 'd']], [['a', 'c'], ['b', 'd']], [['a', 'd'], ['b', 'c']],
  ])
  assert.equal(legalSwissMatchings([...ids, 'e', 'f'], () => true).length, 15)
  const context = drawContext(2, ids.map((id) => ({ id, label: id, seed: null, region: id })), ids.map((id) => ({ id, wins: 1, losses: 0, status: 'active', opponents: [] })))
  const counts = new Map<string, number>()
  for (let index = 0; index < 600; index++) {
    const key = JSON.stringify(uniformLegalSwissDraw(context, () => (index + 0.5) / 600))
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  assert.deepEqual([...counts.values()], [200, 200, 200])
  for (const value of [NaN, -1, 1, Infinity]) assert.throws(() => uniformLegalSwissDraw(context, () => value), /random draw/)
})

test('Round 1 uses exact cross-pool matchings, never a same-region opponent', () => {
  const context = drawContext(1, baseline.teams, resolveScenario(baseline, []).standings)
  const random = worldsRandom(10)
  for (let trial = 0; trial < 200; trial++) {
    const pairs = uniformLegalSwissDraw(context, random)
    assert.equal(drawProblem(pairs, context), null)
    assert.equal(new Set(pairs.flat()).size, 16)
    for (const [a, b] of pairs) {
      const left = baseline.teams.find((team) => team.id === a)!
      const right = baseline.teams.find((team) => team.id === b)!
      assert.notEqual(left.region, right.region)
      const pools = [left.seed, right.seed].map((seed) => WORLDS_2026_SWISS_RULES.pools.findIndex((pool) => (pool as readonly string[]).includes(seed!)))
      assert.equal(pools[0] + pools[1], 3)
    }
  }
})

test('normal buckets forbid rematches unless no rematch-free perfect matching exists', () => {
  const teams = baseline.teams.slice(0, 4).map((team) => ({ ...team, seed: null }))
  const standings = teams.map((team, index) => ({ id: team.id, wins: 1, losses: 0, status: 'active' as const, opponents: [teams[index ^ 1].id] }))
  const context = drawContext(2, teams, standings)
  const random = worldsRandom(19)
  for (let trial = 0; trial < 100; trial++) for (const [a, b] of uniformLegalSwissDraw(context, random)) assert.ok(!context.standings.get(a)!.opponents.includes(b))
  const unavoidable = drawContext(2, teams, standings.map((row) => ({ ...row, opponents: teams.filter((team) => team.id !== row.id).map((team) => team.id) })))
  assert.equal(unavoidable.rematchBuckets.has('1-0'), true)
  assert.equal(uniformLegalSwissDraw(unavoidable, random).length, 2)
})

test('equal-strength teams are symmetric, deterministic, and aggregate exactly eight qualifiers per trial', () => {
  const before = structuredClone(baseline)
  const result = simulate(undefined, 4000)
  assert.deepEqual(result, simulate(undefined, 4000))
  assert.deepEqual(baseline, before)
  assert.equal(result.teams.reduce((sum, team) => sum + team.advanceCount, 0), 8 * result.trials)
  assert.equal(result.regions.reduce((sum, region) => sum + region.qualifierCount, 0), 8 * result.trials)
  for (const team of result.teams) assert.ok(Math.abs(team.advanceCount / result.trials - 0.5) < 0.04, `${team.id} is symmetric`)
  for (const region of result.regions) {
    assert.ok(region.anyAdvanceCount <= result.trials)
    assert.ok(region.anyAdvanceCount <= region.qualifierCount)
    assert.ok(region.anyAdvanceCount >= Math.max(...result.teams.filter((team) => region.teamIds.includes(team.id)).map((team) => team.advanceCount)))
  }
})

test('every individual trial advances eight and singleton regions have exact any-team counts', () => {
  const teams = baseline.teams.map((team) => ({ ...team, region: team.id }))
  const source = { ...baseline, teams }
  for (let seed = 0; seed < 40; seed++) {
    const result = simulateSwissStats(teams, resolveScenario(source, []), () => 0.5, { trials: 1, seed }, provenance)
    assert.equal(result.teams.reduce((sum, team) => sum + team.advanceCount, 0), 8)
    for (const region of result.regions) assert.equal(region.anyAdvanceCount, result.teams.find((team) => team.id === region.region)!.advanceCount)
  }
})

test('observed results and scenario draws and picks remain fixed, with real progress', () => {
  const finished = completed(baseline)
  const source = { ...baseline, kind: 'live' as const, rounds: finished.rounds.slice(0, 2).map((round) => ({ pairs: round.matches.map((match) => match.teamIds), winners: round.matches.map((match) => match.winnerId) })) }
  const roundThree = finished.rounds[2]
  const choices: DrawnRound[] = [...source.rounds.map((round) => ({ ...round, winners: round.winners.map(() => null) })), { pairs: roundThree.matches.map((match) => match.teamIds), winners: roundThree.matches.map((match, index) => index === 0 ? match.winnerId : null) }]
  const scenario = resolveScenario(source, choices)
  const before = structuredClone(scenario)
  const progress: number[] = []
  const result = simulateSwissStats(source.teams, scenario, () => 0.5, { trials: 101, seed: 1 }, provenance, (completed, total) => { assert.equal(total, 101); progress.push(completed) })
  const locked = scenario.standings.filter((row) => row.status === 'advanced')
  assert.equal(locked.length, 1)
  assert.equal(result.teams.find((team) => team.id === locked[0].id)!.advanceCount, 101)
  assert.equal(result.fixedDraws, 3)
  assert.equal(result.fixedResults, 17)
  assert.deepEqual(progress, [0, 50, 100, 101])
  assert.deepEqual(scenario, before)
})

test('a completed scenario uses no random matchup estimates and exposes fixed outcomes', () => {
  const scenario = completed(baseline)
  const result = simulateSwissStats(baseline.teams, scenario, () => { throw new Error('No matchup should run') }, options, provenance)
  for (const team of result.teams) {
    const advanced = scenario.standings.find((row) => row.id === team.id)!.status === 'advanced'
    assert.equal(team.advanceCount, advanced ? result.trials : 0)
    assert.equal(team.fixed, advanced ? 'advanced' : 'eliminated')
  }
  for (const region of result.regions) assert.equal(region.anyAdvanceCount, result.teams.some((team) => region.teamIds.includes(team.id) && team.fixed === 'advanced') ? result.trials : 0)
})

test('invalid probabilities, counts, scenarios, rating joins, and model values are rejected', () => {
  for (const chance of [NaN, Infinity, -0.01, 1.01]) assert.throws(() => simulateSwissStats(baseline.teams, resolveScenario(baseline, []), () => chance, options, provenance), /probability/)
  for (const trials of [0, -1, 0.5, 100001, NaN]) assert.throws(() => simulateSwissStats(baseline.teams, resolveScenario(baseline, []), () => 0.5, { ...options, trials }, provenance), /trials/)
  const malformed = resolveScenario(baseline, [])
  malformed.standings[0].wins = 3
  assert.throws(() => simulate(malformed), /standings/)
  assert.throws(() => simulateSwissStats([...baseline.teams.slice(1), baseline.teams[1]], resolveScenario(baseline, []), () => 0.5, options, provenance), /unique/)
  const input = ratedInput()
  runSwissStats(input, { trials: 1, seed: 1 })
  for (const field of ['rating', 'uncertainty'] as const) for (const value of [null, NaN, Infinity]) {
    const bad = ratedInput(); Object.assign(bad.standings[0], { [field]: value })
    assert.throws(() => runSwissStats(bad, options), /finite rating/)
  }
  const missing = ratedInput(); missing.standings.shift()
  assert.throws(() => runSwissStats(missing, options), /unique published/)
  const duplicate = ratedInput(); duplicate.standings.push(duplicate.standings[0])
  assert.throws(() => runSwissStats(duplicate, options), /unique published/)
  const unknown = ratedInput(); unknown.teams[0].label = 'Unknown team'
  assert.throws(() => runSwissStats(unknown, options), /unique published/)
  const model = ratedInput(); model.model.parameters = { winProbabilityEloScale: NaN }
  assert.throws(() => runSwissStats(model, options), /model parameter/)
  for (const missing of ['winProbabilityEloScale', 'winProbabilityUncertaintyScale', 'winProbabilityUncertaintyFloor']) {
    const model = ratedInput()
    delete (model.model.parameters as Record<string, unknown>)[missing]
    assert.throws(() => runSwissStats(model, options), /model parameter/)
  }
  const empty = ratedInput(); empty.model.parameters = {}
  assert.throws(() => runSwissStats(empty, options), /model parameter/)
  const config = ratedInput(); config.model.configHash = 'different'
  assert.throws(() => runSwissStats(config, options), /model and config/)
})

test('live regions come from the unique rating standing, and no anchor rating fills an unknown team', () => {
  const input = ratedInput()
  input.teams = input.teams.map((team) => ({ ...team, seed: null, region: null }))
  const drawn = completed(baseline).rounds[0]
  input.scenario = resolveScenario({ kind: 'live', teams: input.teams, rounds: [{ pairs: drawn.matches.map((match) => match.teamIds), winners: drawn.matches.map(() => null) }] }, [])
  const result = runSwissStats(input, { trials: 2, seed: 1 })
  assert.equal(result.teams.every((team) => team.region === input.standings.find((row) => row.team === team.label)!.region), true)
  const unknown = ratedInput(); unknown.teams[15].label = 'Play-In winner'
  assert.throws(() => runSwissStats(unknown, options), /named Play-In/)
})

test('partly scored and live series block pre-match stats unless a matching scenario pick conditions them', () => {
  const event = worldsEvent()
  const finished = completed(baseline)
  const first = finished.rounds[0].matches[0]
  event.series = [{ ...event.series[0], stage: 'Round 1', status: 'upcoming', teams: first.teamIds.map((id, index) => ({ id, name: baseline.teams.find((team) => team.id === id)!.label, code: null, gameWins: index ? 0 : 1, outcome: null })) }]
  assert.match(swissStatsConditioning(event, baseline.teams, resolveScenario(baseline, [])).blocked!, /partial score/)
  assert.deepEqual(swissStatsConditioning(event, baseline.teams, finished), { blocked: null, conditioned: 1 })
  event.series[0].status = 'live'; event.series[0].teams.forEach((team) => { team.gameWins = 0 })
  assert.match(swissStatsConditioning(event, baseline.teams, resolveScenario(baseline, [])).blocked!, /live/)
  event.series[0].status = 'completed'; event.series[0].teams[0].gameWins = 1
  event.series[0].bestOf = 1
  assert.equal(swissStatsConditioning(event, baseline.teams, resolveScenario(baseline, [])).blocked, null)
})

test('completed Swiss series use the scenario format and reject incomplete or conflicting results', () => {
  const event = worldsEvent()
  const finished = completed(baseline)
  const drawn = finished.rounds[2]
  const source: SwissBaseline = { ...baseline, kind: 'live', rounds: finished.rounds.slice(0, 3).map((round) => ({ pairs: round.matches.map((match) => match.teamIds), winners: round.matches.map((match) => match.winnerId) })) }
  const scenario = resolveScenario(source, [])
  const first = drawn.matches.find((match) => match.bestOf === 3)!
  event.series = [{ ...event.series[0], stage: 'Round 3', bestOf: 3, status: 'completed', teams: first.teamIds.map((id, index) => ({
    id, name: baseline.teams.find((team) => team.id === id)!.label, code: null, gameWins: index ? 0 : 1, outcome: index ? 'loss' : 'win',
  })) }]
  assert.match(swissStatsConditioning(event, baseline.teams, scenario).blocked!, /incomplete or conflicting/)
  event.series[0].teams[0].gameWins = 2
  assert.equal(swissStatsConditioning(event, baseline.teams, scenario).blocked, null)
  event.series[0].bestOf = null
  assert.equal(swissStatsConditioning(event, baseline.teams, scenario).blocked, null, 'the scenario supplies the Swiss format')
  event.series[0].teams[1].gameWins = null
  assert.equal(swissStatsConditioning(event, baseline.teams, scenario).blocked, null, 'a missing loser score does not contradict a terminal winner')
  event.series[0].teams[0].outcome = 'loss'; event.series[0].teams[1].outcome = 'win'
  assert.match(swissStatsConditioning(event, baseline.teams, scenario).blocked!, /incomplete or conflicting/)
  event.series[0].teams.forEach((team) => { team.gameWins = null; team.outcome = null })
  assert.match(swissStatsConditioning(event, baseline.teams, scenario).blocked!, /incomplete or conflicting/)
  event.series[0].teams[0].outcome = 'win'
  assert.equal(swissStatsConditioning(event, baseline.teams, scenario).blocked, null)
  event.series[0].bestOf = 1
  assert.match(swissStatsConditioning(event, baseline.teams, scenario).blocked!, /incomplete or conflicting/)
  assert.equal(swissStatsConditioning(event, baseline.teams, resolveScenario(baseline, [])).blocked, null, 'unrelated observed results do not restrict a seed-only what-if scenario')
})
