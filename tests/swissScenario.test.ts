import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeChoices, drawContext, drawProblem, encodeChoices, fillDraw, knockoutEntry, liveSwissBaseline, opponentOptions,
  pairReason, resolveScenario, seedBaseline, swapOpponent, teamOutcome, type DrawnRound, type SwissBaseline,
} from '../src/lib/swissScenario'
import { WORLDS_2026_SWISS_RULES, replayWorlds2026Swiss, type SwissSeed } from '../src/lib/worlds2026Swiss'
import type { TournamentEvent, TournamentSeries } from '../src/lib/tournamentFeed'

/** Draws every round with `fillDraw` and lets `pick` choose each winner. */
function playOut(baseline: SwissBaseline, pick: (pair: [string, string], round: number) => string) {
  let choices: DrawnRound[] = []
  for (;;) {
    const resolved = resolveScenario(baseline, choices)
    if (resolved.next.kind === 'complete') return { resolved, choices }
    if (resolved.next.kind === 'draw') {
      const pairs = fillDraw(resolved.next.context)
      assert.ok(pairs, `Round ${resolved.next.round} has a valid draw`)
      choices = [...resolved.choices, { pairs, winners: pairs.map(() => null) }]
      continue
    }
    const round = resolved.next.round
    choices = resolved.choices.map((entry, index) => index === round - 1
      ? { pairs: entry.pairs, winners: entry.pairs.map((pair, slot) => entry.winners[slot] ?? pick(pair, round)) }
      : entry)
  }
}

function poolOf(seed: string) {
  return WORLDS_2026_SWISS_RULES.pools.findIndex((pool) => (pool as readonly string[]).includes(seed))
}

test('round one pairs matched pools across regions, including the chosen Play-In region', () => {
  const baseline = seedBaseline('LCS')
  const context = resolveScenario(baseline, []).next
  assert.equal(context.kind, 'draw')
  if (context.kind !== 'draw') return
  const pairs = fillDraw(context.context)!
  assert.equal(pairs.length, 8)
  for (const [a, b] of pairs) {
    assert.equal(poolOf(a) + poolOf(b), 3, `${a} v ${b} is a matched pool`)
    assert.notEqual(a.replace(/\d+$/, ''), b.replace(/\d+$/, ''))
  }
  assert.equal(pairReason('LCS1', 'PLAYIN', context.context), 'same region')
  assert.equal(pairReason('LCK1', 'LCK4', context.context), 'same region')
  assert.equal(pairReason('LCK1', 'LCK2', context.context), 'pool not matched')
  assert.equal(pairReason('LEC1', 'PLAYIN', context.context), null)
  assert.equal(pairReason('LCS1', 'PLAYIN', drawContext(1, seedBaseline(null).teams, resolveScenario(seedBaseline(null), []).standings)), null)
})

test('a played-out scenario follows the Swiss format and passes the sourced rules validator', () => {
  const baseline = seedBaseline('LEC')
  const { resolved, choices } = playOut(baseline, (pair) => pair[0])
  assert.deepEqual(resolved.rounds.map((round) => round.matches.length), [8, 8, 8, 6, 3])
  assert.deepEqual(resolved.rounds.map((round) => round.matches.map((match) => match.bestOf).sort().join('')), ['11111111', '11111111', '11113333', '333333', '333'])
  const outcomes = resolved.standings.map(teamOutcome)
  const count = (state: string, losses: number) => outcomes.filter((entry) => entry.state === state && entry.losses === losses).length
  assert.deepEqual([count('advanced', 0), count('advanced', 1), count('advanced', 2)], [2, 3, 3])
  assert.deepEqual(outcomes.filter((entry) => entry.state === 'eliminated').map((entry) => entry.state === 'eliminated' && entry.placement).sort(),
    ['12th–14th', '12th–14th', '12th–14th', '15th–16th', '15th–16th', '9th–11th', '9th–11th', '9th–11th'])
  const knockout = knockoutEntry(resolved.standings)!
  assert.deepEqual([knockout.undefeated.length, knockout.oneLoss.length, knockout.twoLosses.length], [2, 3, 3])

  const at = (minute: number) => new Date(Date.UTC(2026, 9, 23, 0, minute)).toISOString()
  const replay = replayWorlds2026Swiss({
    rulesId: WORLDS_2026_SWISS_RULES.id, eventId: 'preview', stateVersion: 'preview', asOf: at(500),
    entrants: baseline.teams.map((team) => ({ id: team.id, seed: team.seed as SwissSeed, region: team.region! })),
    evidence: { entrants: { kind: 'synthetic-fixture', reference: 'preview' }, results: { kind: 'synthetic-fixture', reference: 'preview' } },
    rounds: choices.map((round, index) => ({
      round: index + 1, pairs: round.pairs, drawnAt: at(index * 60), drawEvidence: { kind: 'synthetic-fixture', reference: 'preview' }, rematchWaivers: [],
      results: round.pairs.map((pair, slot) => {
        const bestOf = resolved.rounds[index].matches[slot].bestOf
        return { slot, matchId: `${index}-${slot}`, teamIds: pair, gameWins: [bestOf === 3 ? 2 : 1, 0] as [number, number], observedAt: at(index * 60 + 30) }
      }),
    })),
  })
  assert.equal(replay.status, 'supported', JSON.stringify(replay))
  if (replay.status === 'supported') assert.deepEqual(replay.standings.map(({ id, wins, losses }) => [id, wins, losses]).sort(),
    resolved.standings.map(({ id, wins, losses }) => [id, wins, losses]).sort())
})

test('changing an earlier pick drops later draws that no longer fit and keeps earlier picks', () => {
  const baseline = seedBaseline(null)
  const firstRound = fillDraw((resolveScenario(baseline, []).next as { kind: 'draw'; context: Parameters<typeof fillDraw>[0] }).context)!
  const afterOne = resolveScenario(baseline, [{ pairs: firstRound, winners: firstRound.map((pair) => pair[0]) }])
  assert.equal(afterOne.next.kind, 'draw')
  if (afterOne.next.kind !== 'draw') return
  const secondRound = fillDraw(afterOne.next.context)!
  const choices: DrawnRound[] = [...afterOne.choices, { pairs: secondRound, winners: secondRound.map((pair) => pair[1]) }]
  assert.equal(resolveScenario(baseline, choices).next.kind, 'draw')

  const flipped = choices.map((round, index) => index === 0 ? { ...round, winners: round.winners.map((winner, slot) => slot === 0 ? round.pairs[0][1] : winner) } : round)
  const resolved = resolveScenario(baseline, flipped)
  assert.equal(resolved.droppedRounds, 1)
  assert.equal(resolved.choices.length, 1)
  assert.deepEqual(resolved.choices[0].winners.slice(1), firstRound.slice(1).map((pair) => pair[0]))

  const unpicked = resolveScenario(baseline, [{ pairs: firstRound, winners: firstRound.map((pair, slot) => slot ? pair[0] : null) }, choices[1]])
  assert.deepEqual(unpicked.next, { kind: 'results', round: 1 })
  assert.equal(unpicked.droppedRounds, 1)
  assert.equal(unpicked.standings.find((row) => row.id === firstRound[0][0])?.wins, 0)
})

test('opponent swaps stay inside the record bucket and never create an unwaived rematch', () => {
  const baseline = seedBaseline(null)
  const one = fillDraw((resolveScenario(baseline, []).next as { kind: 'draw'; context: Parameters<typeof fillDraw>[0] }).context)!
  const afterOne = resolveScenario(baseline, [{ pairs: one, winners: one.map((pair) => pair[0]) }])
  if (afterOne.next.kind !== 'draw') return assert.fail('expected a round two draw')
  const context = afterOne.next.context
  const two = fillDraw(context)!
  const team = two[0][0]
  const options = opponentOptions(two, team, context)
  assert.equal(options.length, 7, 'seven other teams share a 1-0 record')
  assert.ok(options.every((option) => context.standings.get(option.id)?.wins === 1))
  const target = options.find((option) => !option.reason && !two[0].includes(option.id))!
  const swapped = swapOpponent(two, team, target.id, context)!
  assert.equal(drawProblem(swapped, context), null)
  assert.ok(swapped.some((pair) => pair.includes(team) && pair.includes(target.id)))

  const afterTwo = resolveScenario(baseline, [...afterOne.choices, { pairs: two, winners: two.map((pair) => pair[0]) }])
  if (afterTwo.next.kind !== 'draw') return assert.fail('expected a round three draw')
  const roundThree = afterTwo.next.context
  const three = fillDraw(roundThree)!
  assert.equal(roundThree.rematchBuckets.size, 0)
  let rematchOptions = 0
  for (const id of three.flat()) {
    for (const option of opponentOptions(three, id, roundThree)) {
      if (!roundThree.standings.get(id)!.opponents.includes(option.id)) continue
      rematchOptions++
      assert.equal(option.reason, 'already played')
    }
  }
  assert.ok(rematchOptions > 0, 'some round three teams share a record with a past opponent')
  const otherRecord = two.flat().find((id) => context.standings.get(id)?.wins === 0)!
  assert.equal(opponentOptions(two, team, context).some((option) => option.id === otherRecord), false)
  assert.equal(swapOpponent(two, team, otherRecord, context), null)
})

test('a record bucket with no draw free of rematches allows the officials waiver and fills it last', () => {
  const teams = ['A', 'B', 'C', 'D'].map((id) => ({ id, label: id, seed: null, region: null }))
  const standings = teams.map(({ id }) => ({ id, wins: 1, losses: 1, status: 'active' as const, opponents: id === 'A' ? ['B', 'C', 'D'] : ['A'] }))
  const context = drawContext(3, teams, standings)
  assert.ok(context.rematchBuckets.has('1-1'))
  assert.equal(pairReason('A', 'B', context, false), 'already played')
  assert.equal(pairReason('A', 'B', context), null)
  assert.deepEqual(fillDraw(context), [['A', 'B'], ['C', 'D']])

  const free = drawContext(3, teams, standings.map((row) => ({ ...row, opponents: row.id === 'A' ? ['B'] : row.id === 'B' ? ['A'] : [] })))
  assert.equal(free.rematchBuckets.size, 0)
  assert.equal(pairReason('A', 'B', free), 'already played')
  assert.deepEqual(fillDraw(free), [['A', 'C'], ['B', 'D']])
})

function series(round: number, slot: number, teams: [string | null, string | null], winner: 0 | 1 | null = null, status?: TournamentSeries['status']): TournamentSeries {
  return {
    id: `2026 Season World Championship/Main Event_Round ${round}_${slot + 1}`, eventId: 'main', startTime: `2026-10-${22 + round}T${10 + slot}:00:00.000Z`,
    stage: `Round ${round}`, status: status ?? (winner === null ? 'upcoming' : 'completed'), sourceState: 'scheduled', bestOf: 1,
    teams: teams.map((name, index) => ({ id: name, name, code: null, gameWins: winner === null ? null : Number(index === winner), outcome: winner === null ? null : index === winner ? 'win' : 'loss' })),
    vodUrls: [],
  }
}
const names = Array.from({ length: 16 }, (_, index) => `Team ${String.fromCharCode(65 + index)}`)
function mainEvent(list: TournamentSeries[]): TournamentEvent {
  return { id: 'worlds:main', sourceTournamentId: '2026 Season World Championship/Main Event', competition: 'worlds', label: 'Worlds 2026 Main Event', season: '2026', series: list }
}

test('the live baseline uses published draws and results, and preview picks never replace them', () => {
  assert.deepEqual(liveSwissBaseline(mainEvent(Array.from({ length: 8 }, (_, slot) => series(1, slot, [null, null])))),
    { status: 'unavailable', detail: 'The Round 1 draw is not in the schedule yet.' })

  const roundOne = Array.from({ length: 8 }, (_, slot) => series(1, slot, [names[slot * 2], names[slot * 2 + 1]], slot < 6 ? 0 : null))
  roundOne[6] = { ...roundOne[6], status: 'live' }
  const partial = [...roundOne, series(2, 0, [names[0], names[2]]), series(2, 1, [null, null])]
  const live = liveSwissBaseline(mainEvent(partial))
  assert.equal(live.status, 'ready')
  if (live.status !== 'ready') return
  assert.equal(live.baseline.rounds.length, 1)
  assert.equal(live.note, 'The Round 2 draw is only partly published, so the preview starts before it.')

  const choices: DrawnRound[] = [{ pairs: live.baseline.rounds[0].pairs, winners: live.baseline.rounds[0].pairs.map((pair) => pair[1]) }]
  const resolved = resolveScenario(live.baseline, choices)
  assert.equal(resolved.replacedPicks, 6)
  assert.deepEqual(resolved.rounds[0].matches.map((match) => match.result), ['live', 'live', 'live', 'live', 'live', 'live', 'preview', 'preview'])
  assert.deepEqual(resolved.rounds[0].matches.map((match) => match.winnerId), [...names.filter((_, index) => index % 2 === 0).slice(0, 6), names[13], names[15]])
  assert.deepEqual(resolved.choices[0].winners, [null, null, null, null, null, null, names[13], names[15]])
  assert.equal(resolved.next.kind, 'draw')

  const allDone = roundOne.map((_, slot) => series(1, slot, [names[slot * 2], names[slot * 2 + 1]], 0))
  const mismatched = liveSwissBaseline(mainEvent([...allDone, ...Array.from({ length: 8 }, (_, slot) => series(2, slot, [names[slot], names[15 - slot]]))]))
  assert.equal(mismatched.status, 'unavailable')
  assert.match(mismatched.status === 'unavailable' ? mismatched.detail : '', /Round 2 in the schedule does not follow the Swiss draw rules: Team A and Team P: different record/)
})

test('a round with fewer published matches than its size keeps the earlier live rounds', () => {
  const roundOne = Array.from({ length: 8 }, (_, slot) => series(1, slot, [names[slot * 2], names[slot * 2 + 1]], 0))
  const live = liveSwissBaseline(mainEvent([...roundOne, series(2, 0, [names[0], names[2]])]))
  assert.equal(live.status, 'ready', JSON.stringify(live))
  if (live.status !== 'ready') return
  assert.equal(live.baseline.rounds.length, 1)
  assert.equal(live.note, 'The Round 2 draw is only partly published, so the preview starts before it.')
  assert.equal(resolveScenario(live.baseline, []).next.kind, 'draw')
})

test('saved live picks name the same teams after the schedule moves a Round 1 match', () => {
  const roundOne = Array.from({ length: 8 }, (_, slot) => series(1, slot, [names[slot * 2], names[slot * 2 + 1]]))
  const moved = roundOne.map((entry, slot) => slot === 0 ? { ...entry, startTime: '2026-10-23T23:00:00.000Z' } : entry)
  const before = liveSwissBaseline(mainEvent(roundOne))
  const after = liveSwissBaseline(mainEvent(moved))
  if (before.status !== 'ready' || after.status !== 'ready') return assert.fail('expected both live baselines')
  const pairs = before.baseline.rounds[0].pairs
  const text = encodeChoices(before.baseline, [{ pairs, winners: pairs.map((pair, slot) => pair[slot % 2]) }])
  const picks = (baseline: SwissBaseline) => {
    const resolved = resolveScenario(baseline, decodeChoices(baseline, text))
    assert.equal(resolved.replacedPicks, 0)
    assert.equal(resolved.droppedRounds, 0)
    return resolved.rounds[0].matches.map((match) => `${match.teamIds.join(' v ')}: ${match.winnerId}`).sort()
  }
  assert.deepEqual(picks(after.baseline), picks(before.baseline))
  assert.deepEqual(picks(after.baseline), pairs.map((pair, slot) => `${pair.join(' v ')}: ${pair[slot % 2]}`).sort())
  assert.deepEqual(after.baseline.rounds[0].pairs.at(-1), [names[0], names[1]], 'match order still follows the schedule')
})

test('choices survive the page address and ignore malformed input', () => {
  const baseline = seedBaseline('LCP')
  const { choices } = playOut(baseline, (pair, round) => pair[round % 2])
  const text = encodeChoices(baseline, choices)
  assert.match(text, /^([0-9a-f]{2}[012]){8}\.([0-9a-f]{2}[012]){8}\.([0-9a-f]{2}[012]){8}\.([0-9a-f]{2}[012]){6}\.([0-9a-f]{2}[012]){3}$/)
  assert.deepEqual(decodeChoices(baseline, text), choices)
  assert.deepEqual(decodeChoices(baseline, 'zz1'), [])
  assert.deepEqual(decodeChoices(baseline, 'not valid'), [])
  assert.deepEqual(resolveScenario(baseline, decodeChoices(baseline, '011')).choices, [])
  assert.equal(resolveScenario(baseline, decodeChoices(baseline, '011')).droppedRounds, 1)
})
