import assert from 'node:assert/strict'
import test from 'node:test'
import { forecastWorlds2026Knockout } from '../src/lib/worlds2026Knockout'
import { forecastWorlds2026PlayIn } from '../src/lib/worlds2026PlayIn'
import { replayWorlds2026Swiss, WORLDS_2026_SWISS_RULES } from '../src/lib/worlds2026Swiss'
import { drawWorlds2026Knockout, runWorldsSimulation, worldsRandom, worldsSamplingInterval, WORLD_STAGES, WORLD_FINISHES, type WorldsSimulationResult } from '../src/lib/worldsSimulation'
import { historicalWorldsFixture, worldsBasis, worldsFixture, worldsEvidence } from './fixtures/worldsFixtures'
import { replayWorlds2022Group } from '../src/lib/worlds2022ObservedGroups'

const options = { seed: 47, trials: 10_000 }
function report(result: WorldsSimulationResult) { assert.equal(result.status, 'supported', JSON.stringify(result)); return result.report }
function close(a: number, b: number, tolerance = 1e-10) { assert.ok(Math.abs(a - b) < tolerance, `${a} ≠ ${b}`) }
function conservation(result: ReturnType<typeof report>) {
  const capacities = [16, 8, 4, 2, 1]
  for (const [index, stage] of WORLD_STAGES.entries()) close(result.teams.reduce((sum, team) => sum + team.stages[stage]!, 0), capacities[index])
  const finishes = [1, 1, 1, 2, 3, 3, 4, 2, 1, 1]
  for (const [index, finish] of WORLD_FINISHES.entries()) close(result.teams.reduce((sum, team) => sum + team.finishes[finish]!, 0), finishes[index])
  for (const team of result.teams) {
    close(Object.values(team.finishes).reduce<number>((sum, p) => sum + p!, 0), 1)
    for (let index = 1; index < WORLD_STAGES.length; index++) assert.ok(team.stages[WORLD_STAGES[index]]! <= team.stages[WORLD_STAGES[index - 1]]!)
    assert.ok([...Object.values(team.stages), ...Object.values(team.finishes)].every((p) => p !== null && p >= 0 && p <= 1))
  }
}

test('2026 Swiss reference replay pins draws, Bo changes and 2/3/3 qualifier records', () => {
  const input = worldsFixture('knockout').swiss!
  const state = replayWorlds2026Swiss(input)
  assert.equal(state.status, 'supported', JSON.stringify(state))
  assert.equal(state.completedRounds, 5)
  assert.deepEqual([0, 1, 2].map((losses) => state.standings.filter((team) => team.wins === 3 && team.losses === losses).length), [2, 3, 3])
  assert.deepEqual(state.matches.filter((match) => match.round === 3).map((match) => match.bestOf), [3, 3, 3, 3, 1, 1, 1, 1])
  const reordered = structuredClone(input)
  reordered.entrants.reverse(); reordered.rounds.reverse()
  for (const round of reordered.rounds) { round.results.reverse(); for (const result of round.results) { result.teamIds.reverse(); result.gameWins.reverse() } }
  assert.deepEqual(replayWorlds2026Swiss(reordered), state)
})

test('Swiss rejects corrupt draws, missing prior rounds, future and nonterminal observations promptly', () => {
  const original = worldsFixture().swiss!
  const variants = [
    (input: typeof original) => { input.rounds[0].pairs[0][1] = 'LCK4' },
    (input: typeof original) => { input.rounds[4].pairs[0] = ['LCK2', 'LPL2'] },
    (input: typeof original) => { input.rounds.splice(1, 1) },
    (input: typeof original) => { input.rounds[0].results.pop() },
    (input: typeof original) => { input.rounds[0].results[0].gameWins = [2, 0] },
    (input: typeof original) => { input.rounds[0].results[0].observedAt = '2027-01-01T00:00:00Z' },
    (input: typeof original) => { input.rounds[1].drawnAt = '2026-10-23T11:00:00Z' },
    (input: typeof original) => { input.rounds[4].drawEvidence.reference = '' },
    (input: typeof original) => { input.rounds[4].rematchWaivers.push({ teamIds: ['LCK2', 'CBLOL1'], evidence: worldsEvidence }) },
  ]
  for (const change of variants) { const input = structuredClone(original); change(input); assert.equal(replayWorlds2026Swiss(input).status, 'unsupported') }
  const rematch = structuredClone(original)
  rematch.rounds[4].pairs = [['LCK2', 'LPL2'], ['CBLOL1', 'LCP2'], ['LPL4', 'LCK4']]
  assert.equal(replayWorlds2026Swiss(rematch).status, 'unsupported')
  rematch.rounds[4].rematchWaivers = [{ teamIds: ['LCK2', 'LPL2'], evidence: worldsEvidence }]
  assert.equal(replayWorlds2026Swiss(rematch).status, 'unsupported', 'A waiver cannot be invented when eligible draws exist.')
})

test('pre-event retains all 19 international entrants, exact Play-In odds and precise later-stage unavailability', async () => {
  const input = worldsFixture('play-in'); const basis = worldsBasis()
  const result = report(await runWorldsSimulation(input, basis, options))
  assert.equal(result.teams.length, 19)
  assert.ok(result.unavailable.some((detail) => detail === WORLDS_2026_SWISS_RULES.drawUnavailable))
  assert.ok(result.teams.every((team) => team.stages.knockout === null))
  close(result.teams.reduce((sum, team) => sum + team.stages.swiss!, 0), 16)
  const reference = forecastWorlds2026PlayIn(input.playIn, basis)
  assert.equal(reference.status, 'supported')
  for (const odds of reference.teams) close(result.teams.find((team) => team.id === odds.id)!.stages.swiss!, odds.advanceToSwissProbability)
  const missingRegion = structuredClone(input); missingRegion.directEntrants.pop()
  assert.equal((await runWorldsSimulation(missingRegion, basis, options)).status, 'unsupported')
})

test('direct qualification requires its own evidence before marking reached Swiss, even before a Swiss draw', async () => {
  for (const reference of [undefined, '', '   ']) {
    const input = worldsFixture('play-in')
    if (reference === undefined) Reflect.deleteProperty(input, 'directEntrantEvidence')
    else input.directEntrantEvidence = { ...worldsEvidence, reference }
    const result = await runWorldsSimulation(input, null, options)
    assert.equal(result.status, 'unsupported')
    assert.equal(result.reason, 'evidence-missing')
    assert.match(result.detail, /fifteen direct entrants/)
  }
  const input = worldsFixture('play-in')
  input.directEntrantEvidence = { kind: 'source-observation', reference: 'Retained direct qualifier observations and canonical identities' }
  const result = report(await runWorldsSimulation(input, null, options))
  assert.equal(result.teams.filter((team) => team.deterministicStages.swiss && team.stages.swiss === 1).length, 15)
  assert.deepEqual(result.pinnedState.directEntrantEvidence, input.directEntrantEvidence)
})

test('final observed Swiss draw composes with random knockout and fixed bracket; seed pins counts and frozen inputs', async () => {
  const input = worldsFixture(); const basis = worldsBasis(); const before = JSON.stringify({ input, basis })
  const progress: number[] = []
  const first = report(await runWorldsSimulation(input, basis, options, { onProgress: (count) => progress.push(count) }))
  const second = report(await runWorldsSimulation(input, basis, options))
  assert.deepEqual(first.counts, second.counts)
  assert.deepEqual(first.teams, second.teams)
  assert.equal(JSON.stringify({ input, basis }), before)
  assert.equal(first.method, 'seeded-monte-carlo'); assert.equal(first.trials, 10_000); assert.equal(first.unavailable.length, 0)
  assert.equal(progress.at(-1), options.trials)
  conservation(first)
  // Independently: three fair 2–2 matches yield P(knockout)=1/2 for each team.
  // Hoeffding + union bound: chance of any of six deviations > .025 is < 4.5e-5.
  for (const id of input.swiss!.rounds[4].pairs.flat()) close(first.teams.find((team) => team.id === id)!.stages.knockout!, 0.5, 0.025)
  // Fair Bo5s give each qualifier title probability 1/8. A 2–2 entrant qualifies with probability 1/2.
  for (const team of first.teams.filter((team) => team.stages.knockout! > 0)) close(team.stages.champion!, team.stages.knockout === 1 ? 0.125 : 0.0625, 0.025)
  for (const match of first.hypotheticalMatchups) { assert.equal(match.snapshotId, basis.snapshotId); assert.equal(match.modelConfigHash, basis.model.configHash) }
  assert.equal(first.teams.find((team) => team.id === 'LCP3')!.state, 'Eliminated in Swiss · 0–3')
  assert.equal(first.teams.find((team) => team.id === 'CBLOL1')!.state, 'Swiss active · 2–2')
})

test('known knockout agrees with exact enumeration; completed event uses no present-day model', async () => {
  const input = worldsFixture('knockout'); const basis = worldsBasis()
  const result = report(await runWorldsSimulation(input, basis, options))
  const reference = forecastWorlds2026Knockout(input.knockout!, basis)
  assert.equal(reference.status, 'supported')
  for (const row of reference.teams) close(result.teams.find((team) => team.id === row.id)!.stages.champion!, row.championProbability)
  conservation(result)
  const complete = report(await runWorldsSimulation(worldsFixture('completed'), null, options))
  conservation(complete)
  assert.equal(complete.teams.find((team) => team.id === 'LCK1')!.stages.champion, 1)
  assert.equal(complete.method, 'exact-enumeration'); assert.equal(complete.hypotheticalMatchups.length, 0)
  const bad = worldsFixture('knockout'); bad.knockout!.qualifiers[0].id = 'CBLOL2'
  assert.equal((await runWorldsSimulation(bad, basis, options)).status, 'unsupported')
})

test('mid-event observations remain fixed and conflicting stage handoffs fail closed', async () => {
  const partial = worldsFixture()
  partial.swiss!.rounds[4].results.push({ slot: 0, matchId: 'confirmed-final-swiss', teamIds: ['LCK2', 'CBLOL1'], gameWins: [2, 1], observedAt: partial.playIn.asOf })
  const result = report(await runWorldsSimulation(partial, worldsBasis(), { seed: 47, trials: 1000 }))
  assert.equal(result.teams.find((team) => team.id === 'LCK2')!.stages.knockout, 1)
  assert.equal(result.teams.find((team) => team.id === 'CBLOL1')!.stages.champion, 0)
  assert.equal(result.teams.find((team) => team.id === 'LCK2')!.deterministicStages.knockout, true)
  assert.equal(result.teams.find((team) => team.id === 'LCK2')!.deterministicStages.champion, false)
  assert.equal(result.teams.find((team) => team.id === 'CBLOL1')!.deterministicStages.champion, true)
  assert.match(result.teams.find((team) => team.id === 'CBLOL1')!.state, /Eliminated/)
  conservation(result)
  for (const change of [
    (input: ReturnType<typeof worldsFixture>) => { input.swiss!.stateVersion = 'another-state' },
    (input: ReturnType<typeof worldsFixture>) => { input.swiss!.entrants.find((team) => team.seed === 'PLAYIN')!.id = 'LCS3' },
    (input: ReturnType<typeof worldsFixture>) => { input.playIn.results[5].observedAt = '2026-10-18T10:00:00Z' },
    (input: ReturnType<typeof worldsFixture>) => { input.swiss!.rounds[0].results[0].matchId = 'play-0' },
  ]) {
    const input = worldsFixture(); change(input)
    assert.equal((await runWorldsSimulation(input, worldsBasis(), options)).status, 'unsupported')
  }
})

test('unsupported model never yields partial totals; future basis, missing active team and invalid options fail safely', async () => {
  const input = worldsFixture()
  for (const change of [
    (basis: ReturnType<typeof worldsBasis>) => { basis.ratingPublishedAt = '2027-01-01T00:00:00Z' },
    (basis: ReturnType<typeof worldsBasis>) => { basis.identityMap.mappings = basis.identityMap.mappings.filter((row) => row.sourceTeamId !== 'CBLOL1') },
    (basis: ReturnType<typeof worldsBasis>) => { basis.snapshot.standings[0].uncertainty = Number.NaN },
    (basis: ReturnType<typeof worldsBasis>) => {
      const scale = { ...basis.model.ratingScale!, spreadMultiplier: Number.MIN_VALUE }
      basis.model.ratingScale = scale; basis.snapshot.ratingScale = scale
      for (const row of basis.snapshot.standings) row.rating = 2000
    },
  ]) {
    const basis = worldsBasis(); change(basis)
    const result = report(await runWorldsSimulation(input, basis, options))
    assert.ok(result.unavailable.length); assert.equal(result.counts.length, 0)
    assert.equal(result.teams.find((team) => team.id === 'CBLOL1')!.stages.champion, null)
  }
  for (const invalid of [{ seed: -1, trials: 1 }, { seed: 1, trials: 100_000 }, { seed: 1.5, trials: 100 }]) assert.equal((await runWorldsSimulation(input, worldsBasis(), invalid)).status, 'unsupported')
})

test('bounded computation yields and aborts before publishing; sampled zero has a positive upper error bound', async () => {
  const controller = new AbortController(); let seen = 0
  await assert.rejects(runWorldsSimulation(worldsFixture(), worldsBasis(), options, {
    signal: controller.signal, onProgress: (completed) => { seen = completed; controller.abort() },
  }), /abort/i)
  assert.ok(seen > 0 && seen <= options.trials)
  const [lower, upper] = worldsSamplingInterval(0, 10_000)
  close(lower, 0); assert.ok(upper > 0 && upper < 0.001)
})

test('knockout draw has the 36 equally weighted bracket outcomes implied by unrestricted §4.3.4 selection', () => {
  const replay = replayWorlds2026Swiss(worldsFixture('knockout').swiss!)
  assert.equal(replay.status, 'supported')
  const random = worldsRandom(47); const counts = new Map<string, number>()
  for (let trial = 0; trial < 36_000; trial++) {
    const slots = drawWorlds2026Knockout(replay.standings, random)
    assert.deepEqual([slots[0], slots[4]], ['LCK1', 'LCP1'])
    assert.ok(['LCK2', 'LPL2', 'LPL4'].includes(slots[1]) && ['LCK2', 'LPL2', 'LPL4'].includes(slots[5]))
    assert.equal(new Set(slots).size, 8)
    const key = JSON.stringify([slots[1], [slots[2], slots[3]].sort(), slots[5], [slots[6], slots[7]].sort()])
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  assert.equal(counts.size, 36)
  // Simultaneous Hoeffding bound < .0023 for tolerance .012 per category.
  for (const count of counts.values()) close(count / 36_000, 1 / 36, 0.012)
})

test('2022 observed groups keep historical labels and model unavailability; boundary ties stay explicit', () => {
  const input = historicalWorldsFixture()
  const replay = replayWorlds2022Group(input.group)
  assert.equal(replay.status, 'supported')
  assert.deepEqual(replay.knockoutQualifierIds, ['past-alpha', 'past-beta'])
  assert.equal(replay.forecast.reason, 'historical-model-inputs-unavailable')
  input.group.games.find((game) => game.id === 'past-1-2-1')!.winnerId = 'past-gamma'
  assert.match(JSON.stringify(replayWorlds2022Group(input.group)), /tiebreaker-rules-unavailable/)
})
