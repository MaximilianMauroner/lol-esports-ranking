import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PLAY_IN_REGIONS, drawByRulebook, drawPots, drawProblem, fillDraw, pairReason, resolveScenario, seedBaseline,
  type DrawContext, type DrawnRound, type PlayInRegion, type SwissBaseline,
} from '../src/domains/tournaments/internal/swissScenario'
import { WORLDS_2026_SWISS_RULES, replayWorlds2026Swiss, type SwissSeed } from '../src/domains/tournaments/internal/worlds2026Swiss'
import { shuffled, worldsRandom } from '../src/domains/tournaments/internal/worldsSimulation'

const SEEDS = 2_000
const ROUND_ONE_CLICKS = 5_000
const PLAY_IN_CHOICES: Array<PlayInRegion | null> = [null, ...PLAY_IN_REGIONS]
const evidence = { kind: 'synthetic-fixture' as const, reference: 'swiss-draw-test' }

function roundOneContext(region: PlayInRegion | null): DrawContext {
  const next = resolveScenario(seedBaseline(region), []).next
  assert.equal(next.kind, 'draw')
  return (next as { context: DrawContext }).context
}

function drawKey(pairs: readonly [string, string][]) {
  return pairs.map((pair) => [...pair].sort().join('-')).sort().join(' ')
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]]
  return values.flatMap((value, index) => permutations(values.filter((_, other) => other !== index)).map((rest) => [value, ...rest]))
}

/** Plays the whole stage with seeded draws and seeded coin-flip winners. */
function playOut(baseline: SwissBaseline, seed: number) {
  const random = worldsRandom(seed)
  let choices: DrawnRound[] = []
  for (;;) {
    const resolved = resolveScenario(baseline, choices)
    if (resolved.next.kind === 'complete') return { resolved, choices }
    if (resolved.next.kind === 'draw') {
      const pairs = fillDraw(resolved.next.context, random)
      assert.ok(pairs, `seed ${seed}: Round ${resolved.next.round} has a valid draw`)
      choices = [...resolved.choices, { pairs, winners: pairs.map((pair) => pair[random() < 0.5 ? 0 : 1]) }]
      continue
    }
    assert.fail(`seed ${seed}: Round ${resolved.next.round} has an open match`)
  }
}

/** The sourced validator from `worlds2026Swiss.ts`, which knows nothing about how the preview draws. */
function officialProblem(baseline: SwissBaseline, choices: DrawnRound[], region: PlayInRegion) {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 23, 0, minute)).toISOString()
  const resolved = resolveScenario(baseline, choices)
  const met = new Set<string>()
  const replay = replayWorlds2026Swiss({
    rulesId: WORLDS_2026_SWISS_RULES.id, eventId: 'preview', stateVersion: 'preview', asOf: at(1_000),
    entrants: baseline.teams.map((team) => ({ id: team.id, seed: team.seed as SwissSeed, region: team.region ?? region })),
    evidence: { entrants: evidence, results: evidence },
    rounds: choices.map((round, index) => {
      const rematchWaivers = round.pairs.filter((pair) => met.has(pair.toSorted().join())).map((pair) => ({ teamIds: pair, evidence }))
      for (const pair of round.pairs) met.add(pair.toSorted().join())
      return {
        round: index + 1, pairs: round.pairs, drawnAt: at(index * 60), drawEvidence: evidence, rematchWaivers,
        results: round.pairs.flatMap((pair, slot) => {
          const winner = round.winners[slot]
          if (!winner) return []
          const target = resolved.rounds[index].matches[slot].bestOf === 3 ? 2 : 1
          const gameWins: [number, number] = winner === pair[0] ? [target, 0] : [0, target]
          return [{ slot, matchId: `${index}-${slot}`, teamIds: pair, gameWins, observedAt: at(index * 60 + 30) }]
        }),
      }
    }),
  })
  return replay.status === 'supported' ? null : replay.detail
}

test('a manual draw moves a team to the next open slot when the current slot blocks a valid pairing', () => {
  const context = roundOneContext('LEC')
  const legal = (a: string, b: string) => !pairReason(a, b, context)
  assert.deepEqual(drawByRulebook(['LCK1', 'LPL1', 'LCS1', 'LEC1', 'LCK4', 'LPL4', 'LCP2', 'PLAYIN'], legal),
    [['LCK1', 'LPL4'], ['LPL1', 'LCK4'], ['LCS1', 'PLAYIN'], ['LEC1', 'LCP2']])
})

test('manual Round 1 draws stay valid across sampled pot orders', () => {
  const context = roundOneContext('LEC')
  const random = worldsRandom(5)
  for (let draw = 0; draw < 300; draw++) {
    const order = [0, 3, 1, 2].flatMap((pool) => shuffled([...WORLDS_2026_SWISS_RULES.pools[pool]], random))
    const pairs = drawByRulebook(order, (a, b) => !pairReason(a, b, context))
    assert.ok(pairs)
    assert.equal(drawProblem(pairs, context), null)
  }
})

test('Round 1 manual fills are valid, vary per click, and follow the preview draw algorithm', (t) => {
  for (const region of PLAY_IN_CHOICES) {
    const context = roundOneContext(region)
    const legal = drawPots(context).map(([home, away]) => permutations(away)
      .map((aways) => home.map((id, index): [string, string] => [id, aways[index]]))
      .filter((pairs) => pairs.every(([a, b]) => !pairReason(a, b, context))).map(drawKey))
    const exact = new Map<string, number>()
    for (const [home, away] of drawPots(context)) {
      const orders = permutations(home).flatMap((homes) => permutations(away).map((aways) => [...homes, ...aways]))
      for (const order of orders) {
        for (const pair of drawByRulebook(order, (a, b) => !pairReason(a, b, context))!) {
          const key = [...pair].sort().join('-')
          exact.set(key, (exact.get(key) ?? 0) + 1 / orders.length)
        }
      }
    }

    const draws = new Map<string, number>()
    const matchups = new Map<string, number>()
    for (let seed = 1; seed <= ROUND_ONE_CLICKS; seed++) {
      const pairs = fillDraw(context, worldsRandom(seed))
      assert.ok(pairs, `seed ${seed} draws`)
      const baseline = seedBaseline(region)
      for (const known of region ? [region] : PLAY_IN_REGIONS) {
        assert.equal(officialProblem(baseline, [{ pairs, winners: pairs.map(() => null) }], known), null, `seed ${seed}, Play-In ${known}`)
      }
      draws.set(drawKey(pairs), (draws.get(drawKey(pairs)) ?? 0) + 1)
      for (const pair of pairs) matchups.set([...pair].sort().join('-'), (matchups.get([...pair].sort().join('-')) ?? 0) + 1)
    }

    const label = region ?? 'not chosen'
    const legalDraws = legal[0].length * legal[1].length
    assert.equal(draws.size, legalDraws, `Play-In ${label}: all ${legalDraws} legal draws show up in ${ROUND_ONE_CLICKS} clicks`)
    assert.deepEqual([...matchups.keys()].sort(), [...exact.keys()].sort(), `Play-In ${label}: every possible matchup shows up`)
    const worst = Math.max(...[...exact].map(([key, p]) => Math.abs((matchups.get(key) ?? 0) / ROUND_ONE_CLICKS - p)))
    assert.ok(worst < 0.04, `Play-In ${label}: matchup shares stay within 4 points of the manual algorithm shares (worst ${worst.toFixed(3)})`)
    t.diagnostic(`Round 1, Play-In ${label}: ${draws.size} of ${legalDraws} legal draws in ${ROUND_ONE_CLICKS} clicks, each drawn ${Math.min(...draws.values())} to ${Math.max(...draws.values())} times, ${matchups.size} matchups, worst share gap ${(worst * 100).toFixed(1)} pts`)
    if (region === 'LEC') {
      for (const home of WORLDS_2026_SWISS_RULES.pools[0]) {
        const row = [...matchups].filter(([key]) => key.split('-').includes(home)).sort(([a], [b]) => a.localeCompare(b))
        t.diagnostic(`  ${home}: ${row.map(([key, count]) => `${key.split('-').find((id) => id !== home)} ${(count / ROUND_ONE_CLICKS * 100).toFixed(1)}% (manual algorithm ${(exact.get(key)! * 100).toFixed(1)}%)`).join(', ')}`)
      }
    }
  }
})

test('whole Swiss stages filled from many seeds pass the sourced validator and draw differently', (t) => {
  const stages = new Set<string>()
  const perRound = Array.from({ length: 5 }, () => new Set<string>())
  let rematches = 0
  for (let seed = 1; seed <= SEEDS; seed++) {
    const region = PLAY_IN_CHOICES[seed % PLAY_IN_CHOICES.length]
    const baseline = seedBaseline(region)
    const { choices } = playOut(baseline, seed)
    assert.equal(choices.length, 5)
    for (const known of region ? [region] : PLAY_IN_REGIONS) assert.equal(officialProblem(baseline, choices, known), null, `seed ${seed}, Play-In ${known}`)
    const met = new Set<string>()
    for (const [index, round] of choices.entries()) {
      perRound[index].add(drawKey(round.pairs))
      for (const pair of round.pairs) {
        if (met.has(pair.toSorted().join())) rematches++
        met.add(pair.toSorted().join())
      }
    }
    stages.add(choices.map((round) => drawKey(round.pairs)).join(' | '))
  }
  assert.equal(stages.size, SEEDS, 'no two seeds play out the same stage')
  for (const [index, draws] of perRound.entries()) if (index) assert.ok(draws.size > SEEDS / 2, `Round ${index + 1}: ${draws.size} different draws`)
  t.diagnostic(`Full stages: ${stages.size} different in ${SEEDS} seeds. Different draws per round: ${perRound.map((draws, index) => `R${index + 1} ${draws.size}`).join(', ')}. Waived rematches: ${rematches}`)
})

test('the same record, many clicks: a fixed Round 2 draws differently each time and never repeats a Round 1 match', (t) => {
  const baseline = seedBaseline('LCS')
  const first = fillDraw(roundOneContext('LCS'), worldsRandom(1))!
  const afterOne = resolveScenario(baseline, [{ pairs: first, winners: first.map((pair) => pair[0]) }])
  assert.equal(afterOne.next.kind, 'draw')
  const context = (afterOne.next as { context: DrawContext }).context
  const draws = new Map<string, number>()
  for (let seed = 1; seed <= SEEDS; seed++) {
    const pairs = fillDraw(context, worldsRandom(seed))!
    for (const [a, b] of pairs) assert.equal(pairReason(a, b, context, false), null, `seed ${seed}: ${a} v ${b}`)
    draws.set(drawKey(pairs), (draws.get(drawKey(pairs)) ?? 0) + 1)
  }
  const counts = [...draws.values()].sort((a, b) => b - a)
  assert.ok(draws.size > 100, `${draws.size} different Round 2 draws`)
  assert.ok(counts[0] < SEEDS / 20, `no Round 2 draw dominates (most common ${counts[0]}x)`)
  t.diagnostic(`Round 2 after a fixed Round 1: ${draws.size} different draws in ${SEEDS} clicks, most common ${counts[0]}x, least common ${counts.at(-1)}x`)
})

test('fillDraw with no random source still varies between calls', () => {
  const context = roundOneContext('CBLOL')
  const seen = new Set(Array.from({ length: 50 }, () => drawKey(fillDraw(context)!)))
  assert.ok(seen.size > 1, `${seen.size} different draws in 50 calls`)
})
