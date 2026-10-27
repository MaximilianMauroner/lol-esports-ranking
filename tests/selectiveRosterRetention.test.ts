import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import type { ExactPregameProbabilityState } from '../src/domains/rankings/forecast.ts'
import { initialTeamRating, rosterContinuityFloor } from '../src/domains/rankings/internal/policy/modelConfig.ts'
import {
  buildPlayerLineupEdges,
  type FinalSideRetention,
} from '../src/domains/rankings/internal/players/playerModel.ts'
import { createRatingReplayContext, prepareRatingUtcDateBoundary, replayRatingDates, type RatingReplayContext } from '../src/domains/rankings/internal/replay/model.ts'
import type { SeriesPassCapture } from '../src/domains/rankings/internal/replay/seriesPass.ts'
import type { MatchRecord, MatchRosterSnapshot, PregamePrediction, Role, Side, TeamProfile } from '../src/domains/rankings/types.ts'
import { emitPregamePredictionsForDate } from '../src/lib/ratingSeriesEngine.ts'

const roles: Role[] = ['Top', 'Jungle', 'Mid', 'Bot', 'Support']
const targetDate = '2026-01-10'
const teams: Record<string, TeamProfile> = {
  Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
  Beta: { name: 'Beta', code: 'BET', region: 'LCK', league: 'LCK' },
  Gamma: { name: 'Gamma', code: 'GAM', region: 'LCK', league: 'LCK' },
}

type GameInput = Partial<MatchRecord> & { id: string; date: string; alpha: string; winner: string; opponent?: string }

function game({ id, date, alpha, winner, opponent = 'Beta', ...overrides }: GameInput): MatchRecord {
  const alphaWon = winner === 'Alpha'
  return {
    id, sourceProvider: 'oracles-elixir', sourceGameId: id, dataCompleteness: 'scoreboard-game-stats',
    date, datetimeUtc: `${date}T10:00:00Z`, gameCompletedAtUtc: `${date}T11:00:00Z`, season: Number(date.slice(0, 4)),
    event: 'LCK 2026 Cup', phase: 'Groups', region: 'LCK', league: 'LCK', patch: '26.1', bestOf: 1, tier: 'regional-regular',
    teamA: 'Alpha', teamB: opponent, teamASide: 'blue', teamBSide: 'red', winner,
    teamAKills: alphaWon ? 25 : 5, teamBKills: alphaWon ? 5 : 25, teamAGold: alphaWon ? 62000 : 54000, teamBGold: alphaWon ? 54000 : 62000,
    teamARoster: roster(alpha, 'blue', alphaWon, date),
    teamBRoster: roster(opponent.toLowerCase(), 'red', !alphaWon, date),
    ...overrides,
  }
}

function roster(prefix: string, side: Side, won: boolean, observedAt: string, withStats = true): MatchRosterSnapshot {
  return {
    sourceProvider: 'oracles-elixir', teamId: prefix, observedAt, completeness: 'complete-five-role',
    players: roles.map(role => ({ id: `${prefix}-${role}`, name: `${prefix} ${role}`, role,
      stats: withStats ? { side, won, kills: won ? 6 : 1, deaths: won ? 1 : 6, assists: won ? 9 : 2,
        damageShare: 0.2, earnedGoldShare: 0.2, vspm: 1 } : undefined })),
  }
}

const strongHistory = [
  game({ id: 'h1', date: '2026-01-02', alpha: 'main', winner: 'Alpha' }),
  game({ id: 'h2', date: '2026-01-04', alpha: 'main', winner: 'Alpha' }),
  game({ id: 'h3', date: '2026-01-06', alpha: 'main', winner: 'Alpha' }),
  game({ id: 'h4', date: '2026-01-08', alpha: 'academy', winner: 'Alpha' }),
]
const weakHistory = [
  game({ id: 'w1', date: '2026-01-01', alpha: 'main', winner: 'Alpha' }),
  game({ id: 'w2', date: '2026-01-03', alpha: 'academy', winner: 'Beta' }),
  game({ id: 'w3', date: '2026-01-05', alpha: 'academy', winner: 'Beta' }),
  game({ id: 'w4', date: '2026-01-07', alpha: 'academy', winner: 'Beta' }),
  game({ id: 'w5', date: '2026-01-08', alpha: 'academy', winner: 'Beta' }),
]
const target = game({ id: 'target', date: targetDate, alpha: 'main', winner: 'Alpha' })
const control = [...strongHistory, target]

type ContextChange = (context: RatingReplayContext) => RatingReplayContext
const unchanged: ContextChange = context => context
const withoutEvidence: ContextChange = context => ({ ...context, continuityRetention: new Map() })
const both = (first: ContextChange, second: ContextChange): ContextChange => context => second(first(context))

function retention(corpus: MatchRecord[], finalMatchId = 'target') {
  const entry = buildPlayerLineupEdges(corpus, { teams }).continuityRetention.get(finalMatchId)
  assert.ok(entry, `retention entry for ${finalMatchId}`)
  return entry
}

function replay(corpus: MatchRecord[], change: ContextChange = unchanged, finalMatchId = 'target', offsets?: { stable: number; execution: number }) {
  const context = change(createRatingReplayContext(corpus, teams))
  let step: { before: SeriesPassCapture['frame']['teams'][number]; series: SeriesPassCapture['expected']['series'][number] } | undefined
  const prefix = offsets && replayRatingDates({ context, replayMatches: corpus.filter(match => match.date < targetDate) })
  if (prefix && offsets) {
    prefix.ratings.set('Alpha', initialTeamRating + offsets.stable)
    prefix.executionRatings.set('Alpha', initialTeamRating + offsets.execution)
  }
  const state = replayRatingDates({
    context,
    state: prefix || undefined,
    replayMatches: prefix ? corpus.filter(match => match.date >= targetDate) : corpus,
    onSeriesPassDate: capture => {
      const index = capture.frame.series.findIndex(series => series.members.some(member => member.id === finalMatchId))
      if (index < 0) return
      step = { before: capture.frame.teams.find(team => team.team === 'Alpha')!, series: capture.expected.series[index]! }
    },
  })
  assert.ok(step, `continuity step for ${finalMatchId}`)
  return { state, step }
}

function baselineRetained(value: number, continuity: number) {
  return initialTeamRating + (rosterContinuityFloor + (1 - rosterContinuityFloor) * continuity) * (value - initialTeamRating)
}

test('freshness decay alone cannot prove a weaker negative played lineup', () => {
  const corpus = [
    ...['2025-07-12', '2025-07-13', '2025-07-14'].map((date, index) =>
      game({ id: `old-${index}`, date, alpha: 'main', winner: 'Beta' })),
    game({ id: 'recent', date: '2026-01-08', alpha: 'academy', winner: 'Beta' }), target,
  ]
  const edges = buildPlayerLineupEdges(corpus, { teams })
  assert.ok(edges.forecast.get('target')!.teamAAdjustment < 0)
  assert.equal(edges.forecast.get('target')!.teamACoverage, 1)
  assert.equal(retention(corpus).teamA, 'baseline-contraction')
  assert.deepEqual(replay(corpus).state, replay(corpus, withoutEvidence).state)
})

test('fully decayed played strength cannot prove an upgrade against a negative reference', () => {
  const corpus = [
    ...['2022-07-12', '2022-07-13', '2022-07-14'].map((date, index) =>
      game({ id: `old-${index}`, date, alpha: 'main', winner: 'Alpha' })),
    game({ id: 'recent', date: '2026-01-08', alpha: 'academy', winner: 'Beta' }), target,
  ]
  const edges = buildPlayerLineupEdges(corpus, { teams })
  assert.ok(edges.forecast.get('target')!.teamAAdjustment < 0)
  assert.equal(edges.forecast.get('target')!.teamACoverage, 1)
  assert.equal(retention(corpus).teamA, 'baseline-contraction')
  assert.deepEqual(replay(corpus).state, replay(corpus, withoutEvidence).state)
})

test('a proven stronger lineup keeps a positive offset through the continuity step and changes nothing else there', () => {
  const edges = buildPlayerLineupEdges(control, { teams })
  assert.equal(edges.continuityRetention.get('target')!.teamA, 'proven-stronger-lineup')

  const proven = replay(control)
  const baseline = replay(control, withoutEvidence)
  const before = proven.step.before
  assert.deepEqual(before, baseline.step.before, 'both replays reach the target with the same state')
  const continuity = proven.step.series.continuity[0]
  assert.ok(continuity.rosterContinuity! < 1, 'the main lineup differs from the last processed academy roster')
  assert.ok(before.rating! > initialTeamRating && before.executionRating! > initialTeamRating, 'fixture enters with positive offsets')

  assert.equal(continuity.rating, before.rating, 'stable rating keeps its positive offset')
  assert.equal(continuity.executionRating, before.executionRating, 'execution rating keeps its positive offset')
  assert.equal(baseline.step.series.continuity[0].rating, baselineRetained(before.rating!, continuity.rosterContinuity!))
  assert.equal(baseline.step.series.continuity[0].executionRating, baselineRetained(before.executionRating!, continuity.rosterContinuity!))

  assert.equal(continuity.uncertainty, baseline.step.series.continuity[0].uncertainty, 'uncertainty penalty is unchanged')
  assert.equal(continuity.rosterContinuity, baseline.step.series.continuity[0].rosterContinuity, 'continuity is unchanged')
  assert.deepEqual(proven.step.series.continuity[1], baseline.step.series.continuity[1], 'the opponent is unchanged')
  assert.deepEqual(proven.step.series.input, baseline.step.series.input, 'the result expectation is unchanged')
  assert.deepEqual(proven.step.series.result, baseline.step.series.result, 'the result update is unchanged')
  assert.deepEqual(proven.state.rosterPriorOffsets, baseline.state.rosterPriorOffsets, 'stored roster prior offsets are unchanged')
  assert.deepEqual(proven.state.uncertainties, baseline.state.uncertainties)
  assert.equal(proven.state.ratings.get('Beta'), baseline.state.ratings.get('Beta'))
  assert.ok(proven.state.ratings.get('Alpha')! > baseline.state.ratings.get('Alpha')!, 'the protected strength survives the result update')
})

test('a proven stronger lineup with negative offsets keeps the baseline upward move exactly', () => {
  const corpus = [...weakHistory, target]
  const edges = buildPlayerLineupEdges(corpus, { teams })
  assert.equal(edges.continuityRetention.get('target')!.teamA, 'proven-stronger-lineup')
  const proven = replay(corpus)
  const before = proven.step.before
  assert.ok(before.rating! < initialTeamRating && before.executionRating! < initialTeamRating, 'fixture enters with negative offsets')
  assert.ok(proven.step.series.continuity[0].rating! > before.rating!, 'the baseline contraction moves the negative offset upward')
  assert.deepEqual(proven.state, replay(corpus, withoutEvidence).state)
})

test('unproven, unpriced, equal, weaker and missing evidence keep the baseline contraction bit for bit', () => {
  const played = roster('main', 'blue', true, targetDate)
  const first = { ...target, id: 'series-1', sourceMatchId: 'target-series', gameNumber: 1, bestOf: 3 }
  const second = { ...target, id: 'target', sourceMatchId: 'target-series', gameNumber: 2, bestOf: 3,
    datetimeUtc: `${targetDate}T12:00:00Z`, gameCompletedAtUtc: `${targetDate}T13:00:00Z` }
  const cases: Array<[string, MatchRecord[], ContextChange]> = [
    ['weaker played lineup', [
      game({ id: 'h1', date: '2026-01-02', alpha: 'main', winner: 'Alpha' }),
      game({ id: 'h2', date: '2026-01-04', alpha: 'academy', winner: 'Beta' }),
      game({ id: 'h3', date: '2026-01-06', alpha: 'main', winner: 'Alpha' }),
      game({ id: 'h4', date: '2026-01-08', alpha: 'main', winner: 'Alpha' }),
      game({ id: 'target', date: targetDate, alpha: 'academy', winner: 'Alpha' }),
    ], unchanged],
    ['identical lineup', [...strongHistory, { ...target, teamARoster: roster('academy', 'blue', true, targetDate) }], unchanged],
    ['unpriced rookies', [...strongHistory, { ...target, teamARoster: roster('rookie', 'blue', true, targetDate) }], unchanged],
    ['unpriced reference', [...strongHistory.slice(0, 3),
      { ...strongHistory[3]!, teamARoster: roster('academy', 'blue', false, '2026-01-08', false) }, target], unchanged],
    ['partial roster', [...strongHistory, { ...target, teamARoster: { ...played, completeness: 'partial', players: played.players.slice(0, 4) } }], unchanged],
    ['announcement roster', [...strongHistory, { ...target, teamARoster: { ...played, evidenceBasis: 'official-announcement' } }], unchanged],
    ['late completion', [...strongHistory, { ...target, gameCompletedAtUtc: '2026-01-11T00:10:00Z' }], unchanged],
    ['late roster observation', [...strongHistory, { ...target, teamARoster: roster('main', 'blue', true, '2026-01-11') }], unchanged],
    ['lineup change inside the series', [...strongHistory, { ...first, teamARoster: roster('academy', 'blue', true, targetDate) }, second], unchanged],
    ['mixed home league inside the series', [...strongHistory, first, { ...second, teamAHomeLeague: 'LPL' }], unchanged],
  ]
  for (const [label, corpus, change] of cases) {
    assert.deepEqual(replay(corpus, change).state, replay(corpus, both(change, withoutEvidence)).state, label)
  }
  const reference = createRatingReplayContext(cases[3]![1], teams).pregamePlayerRatingEdges.get('target')!
  assert.deepEqual([reference.teamAAdjustment, reference.teamACoverage], [0, 0], 'the stat-less academy guess is a gated zero')
})

function zeroPriceReference() {
  const prior = game({ id: 'balanced-reference', date: '2026-01-08', alpha: 'academy', winner: 'Alpha', opponent: 'Gamma' })
  for (const player of prior.teamARoster!.players) {
    Object.assign(player.stats!, { kills: 0, deaths: 6, assists: 0, damageShare: 0.1, earnedGoldShare: 0.1, vspm: 0 })
  }
  for (const player of prior.teamBRoster!.players) {
    Object.assign(player.stats!, { kills: 6, deaths: 1, assists: 9, damageShare: 0.25, earnedGoldShare: 0.25, vspm: 2 })
  }
  return prior
}

test('a genuine priced zero reference can prove stronger players while a gated zero cannot', () => {
  const prior = zeroPriceReference()
  const priced = [...strongHistory.slice(0, 3), prior, target]
  const gated = [...strongHistory.slice(0, 3), { ...prior,
    teamARoster: roster('academy', 'blue', true, prior.date, false) }, target]
  const edges = buildPlayerLineupEdges(priced, { teams })
  assert.equal(edges.forecast.get('target')!.teamAAdjustment, 0)
  assert.equal(edges.forecast.get('target')!.teamACoverage, 1)
  assert.ok(edges.forecast.get('target')!.teamAFreshnessWeight > 0)
  assert.equal(retention(priced).teamA, 'proven-stronger-lineup')
  assert.equal(buildPlayerLineupEdges(gated, { teams }).forecast.get('target')!.teamAAdjustment, 0)
  assert.equal(retention(gated).teamA, 'baseline-contraction')
})

test('both prices need the existing minimum player coverage', () => {
  const mixed = roster('main', 'blue', true, '2026-01-08', false)
  mixed.players = mixed.players.map(player => ['Mid', 'Bot'].includes(player.role)
    ? { ...player, id: `rookie-${player.role}` } : player)
  const thinReference = [...strongHistory.slice(0, 3), { ...strongHistory[3]!, teamARoster: mixed }, target]
  const forecast = buildPlayerLineupEdges(thinReference, { teams }).forecast.get('target')!
  assert.equal(forecast.teamACoverage, 0.58)
  assert.equal(forecast.teamAAdjustment, 0)
  assert.equal(retention(thinReference).teamA, 'baseline-contraction')
  const thinPlayed = [...strongHistory, { ...target, teamARoster: { ...mixed, observedAt: targetDate } }]
  assert.equal(retention(thinPlayed).teamA, 'baseline-contraction')
  assert.equal(retention(control).teamA, 'proven-stronger-lineup')
})

test('a fully decayed reference cannot prove an upgrade from freshly priced players', () => {
  const old = game({ id: 'old-academy', date: '2022-07-14', alpha: 'academy', winner: 'Alpha' })
  const elsewhere = strongHistory.slice(0, 3).map(match => ({ ...match, teamA: 'Gamma', winner: 'Gamma' }))
  const corpus = [old, ...elsewhere, target]
  const forecast = buildPlayerLineupEdges(corpus, { teams }).forecast.get('target')!
  assert.equal(forecast.teamAAdjustment, 0)
  assert.equal(forecast.teamACoverage, 1)
  assert.equal(forecast.teamAFreshnessWeight, 0)
  assert.equal(retention(corpus).teamA, 'baseline-contraction')
})

test('a stronger raw lineup with the same rounded price keeps baseline', () => {
  const old = ['2023-06-01', '2023-06-02', '2023-06-03'].map((date, index) =>
    game({ id: `old-${index}`, date, alpha: 'main', winner: 'Alpha' }))
  const corpus = [...old, zeroPriceReference(), target]
  const edges = buildPlayerLineupEdges(corpus, { teams })
  assert.equal(edges.forecast.get('target')!.teamAAdjustment, 0)
  assert.equal(retention(corpus).teamA, 'baseline-contraction')
  const fresher = [...strongHistory.slice(0, 3), zeroPriceReference(), target]
  assert.equal(retention(fresher).teamA, 'proven-stronger-lineup')
})

test('stable and execution retention each follow their own sign', () => {
  for (const offsets of [{ stable: 100, execution: -80 }, { stable: -100, execution: 80 }]) {
    const proven = replay(control, unchanged, 'target', offsets)
    const baseline = replay(control, withoutEvidence, 'target', offsets)
    assert.equal(proven.step.series.continuity[0].rating,
      Math.max(proven.step.before.rating!, baseline.step.series.continuity[0].rating!))
    assert.equal(proven.step.series.continuity[0].executionRating,
      Math.max(proven.step.before.executionRating!, baseline.step.series.continuity[0].executionRating!))
    assert.deepEqual(proven.step.series.result, baseline.step.series.result)
  }
})

test('the proof follows final-match sides when the last game swaps teams', () => {
  const first = { ...target, id: 'series-1', sourceMatchId: 'swapped', gameNumber: 1, bestOf: 3 }
  const final = { ...target, id: 'series-2', sourceMatchId: 'swapped', gameNumber: 2, bestOf: 3,
    teamA: 'Beta', teamB: 'Alpha', teamARoster: roster('beta', 'blue', false, targetDate),
    teamBRoster: roster('main', 'red', true, targetDate),
    datetimeUtc: `${targetDate}T12:00:00Z`, gameCompletedAtUtc: `${targetDate}T13:00:00Z` }
  const corpus = [...strongHistory, first, final]
  assert.deepEqual(retention(corpus, 'series-2'), { teamA: 'baseline-contraction', teamB: 'proven-stronger-lineup' })
  const proven = replay(corpus, unchanged, 'series-2')
  const baseline = replay(corpus, withoutEvidence, 'series-2')
  assert.ok(proven.state.ratings.get('Alpha')! > baseline.state.ratings.get('Alpha')!)
  assert.equal(proven.state.ratings.get('Beta'), baseline.state.ratings.get('Beta'))
})

test('a changed stronger lineup is proven and an unchanged lineup keeps baseline', () => {
  assert.deepEqual(retention(control), { teamA: 'proven-stronger-lineup', teamB: 'baseline-contraction' })
  assert.equal(retention([...strongHistory, { ...target, teamARoster: roster('academy', 'blue', true, targetDate) }]).teamA,
    'baseline-contraction')
})

test('only proven, available, consistent played lineups in one home league are priced', () => {
  const partial = roster('main', 'blue', true, targetDate)
  const cases: Array<[string, MatchRecord]> = [
    ['missing roster', { ...target, teamARoster: undefined }],
    ['partial roster', { ...target, teamARoster: { ...partial, completeness: 'partial', players: partial.players.slice(0, 4) } }],
    ['announcement roster', { ...target, teamARoster: { ...partial, evidenceBasis: 'official-announcement' } }],
    ['schedule roster', { ...target, teamARoster: { ...partial, evidenceBasis: 'official-schedule' } }],
    ['duplicate player id', { ...target, teamARoster: { ...partial, players: partial.players.map(player => ({ ...player, id: 'main-Top' })) } }],
    ['missing completion', { ...target, gameCompletedAtUtc: undefined }],
    ['completion after the update date', { ...target, gameCompletedAtUtc: '2026-01-11T00:10:00Z' }],
    ['roster observed after the update date', { ...target, teamARoster: roster('main', 'blue', true, '2026-01-11') }],
    ['roster known after the update date', { ...target, teamARoster: { ...partial, knownAt: '2026-01-11T08:00:00Z' } }],
  ]
  for (const [label, changed] of cases) {
    assert.deepEqual(retention([...strongHistory, changed]).teamA, 'baseline-contraction', label)
  }

  const first = { ...target, id: 'series-1', sourceMatchId: 'target-series', gameNumber: 1, bestOf: 3 }
  const second = { ...target, id: 'series-2', sourceMatchId: 'target-series', gameNumber: 2, bestOf: 3,
    datetimeUtc: `${targetDate}T12:00:00Z`, gameCompletedAtUtc: `${targetDate}T13:00:00Z` }
  assert.equal(retention([...strongHistory, first, second], 'series-2').teamA, 'proven-stronger-lineup', 'consistent Bo3 lineup')
  assert.deepEqual(retention([...strongHistory, first, { ...second, teamARoster: roster('academy', 'blue', true, targetDate) }], 'series-2').teamA,
    'baseline-contraction', 'a lineup change inside the series is not priced from one game')
  assert.deepEqual(retention([...strongHistory, first, { ...second, teamAHomeLeague: 'LPL' }], 'series-2').teamA,
    'baseline-contraction', 'forecast and completed prices must share one home league')
  const middle = { ...second, winner: 'Beta', teamAHomeLeague: 'LPL' }
  const final = { ...second, id: 'series-3', gameNumber: 3,
    datetimeUtc: `${targetDate}T14:00:00Z`, gameCompletedAtUtc: `${targetDate}T15:00:00Z` }
  assert.equal(retention([...strongHistory, first, { ...middle, teamAHomeLeague: 'LCK' }, final], 'series-3').teamA,
    'proven-stronger-lineup', 'the three-game control has a consistent home league')
  assert.deepEqual(retention([...strongHistory, first, middle, final], 'series-3').teamA,
    'baseline-contraction', 'a middle-game home league conflict makes the series unproven')
  assert.equal(buildPlayerLineupEdges([...strongHistory, first, second], { teams }).continuityRetention.has('series-1'), false,
    'only the final match carries the series evidence')
})

test('old positive strength can still prove an upgrade with usable freshness', () => {
  const corpus = [
    game({ id: 'old-main', date: '2025-07-14', alpha: 'main', winner: 'Alpha' }),
    game({ id: 'statless-main', date: '2025-12-01', alpha: 'main', winner: 'Alpha',
      teamARoster: roster('main', 'blue', true, '2025-12-01', false) }),
    game({ id: 'academy', date: '2026-01-08', alpha: 'academy', winner: 'Beta' }),
    target,
  ]
  assert.equal(retention(corpus).teamA, 'proven-stronger-lineup')
})

test('target stats, winner, same-date games and future games do not change the completed evidence', () => {
  const base = retention(control)
  const weakTarget = { ...target, winner: 'Beta', teamAKills: 0, teamBKills: 40,
    teamARoster: roster('main', 'blue', false, targetDate), teamBRoster: roster('beta', 'red', true, targetDate) }
  const sameDate = game({ id: 'same-date', date: targetDate, alpha: 'main', opponent: 'Gamma', winner: 'Gamma',
    datetimeUtc: `${targetDate}T14:00:00Z`, gameCompletedAtUtc: `${targetDate}T15:00:00Z` })
  const future = game({ id: 'future', date: '2026-01-20', alpha: 'academy', winner: 'Alpha' })
  for (const [label, corpus] of [
    ['target stats and winner', [...strongHistory, weakTarget]],
    ['same-date series', [...control, sameDate]],
    ['future series', [...control, future]],
  ] as const) {
    assert.deepEqual(retention([...corpus]), base satisfies FinalSideRetention, label)
  }
})

const targetGameDiagnosticFields = new Set(['actualWinner', 'segments', 'source', 'teamASide', 'teamBSide'])
const predictorOutput = (prediction: PregamePrediction) =>
  Object.fromEntries(Object.entries(prediction).filter(([key]) => !targetGameDiagnosticFields.has(key)))

function exactTargetForecast(corpus: MatchRecord[]) {
  const context = createRatingReplayContext(corpus, teams)
  const state = replayRatingDates({ context, replayMatches: corpus.filter(match => match.date < targetDate) })
  const dateMatches = corpus.filter(match => match.date === targetDate)
  prepareRatingUtcDateBoundary({ dateMatches, teams, state })
  const exact: ExactPregameProbabilityState[] = []
  emitPregamePredictionsForDate({ matches: dateMatches, teams, state, pregamePlayerRatingEdges: context.pregamePlayerRatingEdges,
    onExactState: value => exact.push(value) })
  return { exact, hash: createHash('sha256').update(JSON.stringify(exact)).digest('hex') }
}

test('target-date forecasts stay exact under target lineup, stats, winner and same-date result changes', () => {
  const sameDate = game({ id: 'same-date', date: targetDate, alpha: 'main', opponent: 'Gamma', winner: 'Alpha',
    datetimeUtc: `${targetDate}T14:00:00Z`, gameCompletedAtUtc: `${targetDate}T15:00:00Z` })
  const base = [...control, sameDate]
  const forecasts = (corpus: MatchRecord[]) => replay(corpus).state.predictions.filter(prediction => prediction.date === targetDate).map(predictorOutput)
  const expected = exactTargetForecast(base)
  const variants: Array<[string, MatchRecord[]]> = [
    ['academy played the target', [...strongHistory, { ...target, teamARoster: roster('academy', 'blue', true, targetDate) }, sameDate]],
    ['rookies played the target', [...strongHistory, { ...target, teamARoster: roster('rookie', 'blue', true, targetDate) }, sameDate]],
    ['target rosters missing', [...strongHistory, { ...target, teamARoster: undefined, teamBRoster: undefined }, sameDate]],
    ['target winner and stats flipped', [...strongHistory, { ...target, winner: 'Beta', teamAKills: 0, teamBKills: 40,
      teamARoster: roster('main', 'blue', false, targetDate), teamBRoster: roster('beta', 'red', true, targetDate) }, sameDate]],
    ['same-date lineup and winner changed', [...control, { ...sameDate, winner: 'Gamma', teamARoster: roster('rookie', 'blue', false, targetDate) }]],
  ]
  assert.equal(replay(base).step.series.continuity[0].rating, replay(base).step.before.rating, 'the target continuity step is protected')
  for (const [label, corpus] of variants) {
    const actualForecast = exactTargetForecast(corpus)
    assert.deepEqual(actualForecast.exact, expected.exact, `${label}: exact pregame state`)
    assert.equal(actualForecast.hash, expected.hash, `${label}: exact pregame state hash`)
    assert.deepEqual(forecasts(corpus), forecasts(base), `${label}: target-date probabilities and features`)
  }
})
