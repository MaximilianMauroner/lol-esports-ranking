import assert from 'node:assert/strict'
import test from 'node:test'
import { publishedRatingScale } from '../src/lib/modelConfig'
import type { PublicTeamStanding } from '../src/lib/publicArtifacts/schema'
import { forecastTournamentSeries, type ForecastBasis } from '../src/lib/tournamentForecast'
import {
  WORLDS_2026_PLAY_IN_RULES, forecastWorlds2026PlayIn, replayWorlds2026PlayIn,
  type ObservedPlayInResult, type PlayInForecastResult, type Worlds2026PlayInInput,
} from '../src/lib/worlds2026PlayIn'

const asOf = '2026-10-02T21:00:00Z'
const evidence = { kind: 'synthetic-fixture', reference: 'tests/worlds2026PlayIn.test.ts' } as const
function input(results: ObservedPlayInResult[] = []): Worlds2026PlayInInput {
  return {
    rulesId: WORLDS_2026_PLAY_IN_RULES.id, eventId: 'synthetic:worlds-2026', stateVersion: 'synthetic-state-1', asOf,
    entrants: [{ id: 'A', seed: 'CBLOL2' }, { id: 'B', seed: 'LCS3' }, { id: 'C', seed: 'LEC3' }, { id: 'D', seed: 'LCP3' }],
    slots: ['A', 'B', 'C', 'D'], evidence: { entrants: evidence, draw: evidence, results: evidence }, results,
  }
}
function result(slot: ObservedPlayInResult['slot'], teamIds: [string, string], gameWins: [number, number] = [3, 1]): ObservedPlayInResult {
  return { slot, matchId: `synthetic:${slot}`, teamIds, gameWins, observedAt: asOf }
}
const completed = [result('r1-a', ['A', 'B']), result('r1-b', ['C', 'D']),
  result('r2-upper', ['A', 'C']), result('r2-lower', ['B', 'D']), result('r3', ['C', 'B']), result('r4', ['A', 'C'], [0, 3])]

function standing(id: string, rating: number): PublicTeamStanding {
  return {
    teamId: `team:${id}`, leagueId: 'synthetic-league', team: id, code: id, region: 'LCK', league: 'synthetic-league',
    rosterBasis: 'sourced', baseRating: rating, leagueScore: 100, leagueAdjustment: 0, leagueDelta: 0,
    ratingComponents: { leagueAnchor: rating, teamStableOffset: 0, rosterPriorOffset: 0, momentum: 0, contextAdjustment: 0, uncertainty: 30 },
    rating, previousRating: rating, delta: 0, rank: 1, previousRank: 1, movement: 0, wins: 20, losses: 10,
    recordBasis: 'standing-record-from-ranking-model', scoreFamily: 'power-index', confidence: 1, uncertainty: 30,
    form: [], strongestFactor: 'context', eligibility: { eligible: true, reasons: [] },
    factors: { context: 0, recency: 0, execution: 0, opponent: 0, league: 0 }, recentEvents: [], recentMatches: [],
  }
}
function basis(): ForecastBasis {
  return {
    snapshotId: 'synthetic-snapshot', ratingDataAsOf: '2026-10-01T00:00:00Z', ratingPublishedAt: '2026-10-01T01:00:00Z',
    dataMode: 'seeded-sample',
    model: { name: 'Synthetic test model', version: 'fixture-v1', configHash: 'fixture-hash', ratingScale: publishedRatingScale,
      parameters: { winProbabilityEloScale: 400, winProbabilityUncertaintyScale: 400, winProbabilityUncertaintyFloor: 0.2 } },
    identityMap: { version: 1, source: 'lolesports-persisted-site-api', revision: 'synthetic-identities',
      mappings: ['A', 'B', 'C', 'D'].map((id) => ({ sourceTeamId: id, teamId: `team:${id}` })) },
    snapshot: { artifactKind: 'public-snapshot-shard', filter: { region: 'All', event: 'All', season: 'All' },
      ratingScale: publishedRatingScale, modelVersion: 'fixture-v1', modelConfigHash: 'fixture-hash', matchCount: 0,
      sourceBreakdown: [], scoreFamilies: [], standings: ['A', 'B', 'C', 'D'].map((id) => standing(id, 1800)), leagues: [], regions: [] },
  }
}
function supported(value: PlayInForecastResult) {
  assert.equal(value.status, 'supported', JSON.stringify(value))
  return value
}
function close(a: number, b: number) { assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`) }
function conservation(value: ReturnType<typeof supported>) {
  close(value.totalProbability, 1)
  for (const row of value.teams) close(row.advanceToSwissProbability + row.finish17Probability + row.finish18Probability + row.finish19Probability, 1)
  for (const key of ['advanceToSwissProbability', 'finish17Probability', 'finish18Probability', 'finish19Probability'] as const) {
    close(value.teams.reduce((sum, row) => sum + row[key], 0), 1)
  }
}

test('complete symmetric Play-In enumerates 64 paths and conserves one Swiss/each finish slot', () => {
  const state = input()
  const model = basis()
  const original = structuredClone({ state, model })
  const forecast = supported(forecastWorlds2026PlayIn(state, model))
  assert.equal(forecast.terminalPaths, 64)
  assert.equal(forecast.method, 'exact-enumeration')
  for (const row of forecast.teams) {
    close(row.advanceToSwissProbability, 0.25)
    close(row.finish17Probability, 0.25)
    close(row.finish18Probability, 0.25)
    close(row.finish19Probability, 0.25)
    assert.equal(row.deterministicStatus, 'active')
  }
  conservation(forecast)
  assert.deepEqual({ state, model }, original)
  assert.deepEqual(forecastWorlds2026PlayIn(state, model), forecast)
  assert.ok(forecast.hypotheticalMatchups.every((match) => match.bestOf === 5 && match.sideAssumption === 'neutral'
    && match.matchId.startsWith('hypothetical:') && match.snapshotId === model.snapshotId && match.modelConfigHash === model.model.configHash))
  assert.match(forecast.assumptions.join(' '), /RoDS|not modeled/)
  assert.ok(forecast.hypotheticalMatchups.every((match) => match.warnings.some((warning) => /sample data/.test(warning))))
})

test('completed opening winners have 3/8 Swiss odds and losers 1/8 without a final reset', () => {
  const forecast = supported(forecastWorlds2026PlayIn(input(completed.slice(0, 2)), basis()))
  assert.equal(forecast.terminalPaths, 16)
  for (const row of forecast.teams) close(row.advanceToSwissProbability, ['A', 'C'].includes(row.id) ? 3 / 8 : 1 / 8)
  conservation(forecast)
})

test('partial independent rounds replay, reordered observations and swapped score orientation are equivalent', () => {
  const partial = replayWorlds2026PlayIn(input(completed.slice(0, 1)))
  assert.equal(partial.status, 'supported')
  if (partial.status === 'supported') assert.deepEqual(partial.readyMatches.map((match) => match.slot), ['r1-b'])
  const results = structuredClone(completed)
  results[0].teamIds = ['B', 'A']
  results[0].gameWins = [1, 3]
  const original = replayWorlds2026PlayIn(input(completed))
  assert.deepEqual(replayWorlds2026PlayIn(input(results.reverse())), original)
  assert.deepEqual(forecastWorlds2026PlayIn(input([...completed].reverse()), basis()), forecastWorlds2026PlayIn(input(completed), basis()))
})

test('final loser is eliminated even with one match loss and terminal state requires no model', () => {
  const state = input(completed)
  const forecast = supported(forecastWorlds2026PlayIn(state, { ...basis(), identityMap: { ...basis().identityMap, mappings: [] } }))
  assert.equal(forecast.terminalPaths, 1)
  assert.deepEqual(forecast.hypotheticalMatchups, [])
  assert.deepEqual(forecast.state.teams.map((team) => [team.id, team.finish, team.losses]), [['A', 17, 1], ['B', 18, 2], ['C', 'swiss', 1], ['D', 19, 2]])
  assert.equal(forecast.teams.find((row) => row.id === 'C')?.advanceToSwissProbability, 1)
  assert.equal(forecast.teams.find((row) => row.id === 'C')?.deterministicStatus, 'qualified')
  conservation(forecast)
})

test('a stronger team improves exact odds, and a fixed final uses the #46 Bo5 probability unchanged', () => {
  const model = basis()
  model.snapshot.standings[0].rating = 2000
  const all = supported(forecastWorlds2026PlayIn(input(), model))
  assert.ok(all.teams[0].advanceToSwissProbability > 0.25)
  conservation(all)
  const forecast = supported(forecastWorlds2026PlayIn(input(completed.slice(0, 5)), model))
  const provider = forecastTournamentSeries({ id: 'hypothetical-final', eventId: 'synthetic:worlds-2026', stage: 'Play-In',
    startTime: null, status: 'upcoming', sourceState: 'unstarted', bestOf: 5, vodUrls: [],
    teams: ['A', 'C'].map((id) => ({ id, name: null, code: null, gameWins: null, outcome: null })) }, model)
  assert.equal(provider.status, 'ready')
  if (provider.status === 'ready') close(forecast.teams[0].advanceToSwissProbability, provider.homeSeriesWinProbability)
  assert.equal(forecast.terminalPaths, 2)
  assert.equal(forecast.teams[1].deterministicStatus, 'eliminated')
  conservation(forecast)
})

test('rules, entrant seeds, opening draw and distinct tagged observations fail closed', () => {
  const variants: Worlds2026PlayInInput[] = [
    { ...input(), rulesId: 'worlds-2025' }, { ...input(), eventId: '' }, { ...input(), stateVersion: '' }, { ...input(), asOf: 'bad' },
    { ...input(), entrants: input().entrants.slice(1) }, { ...input(), slots: ['A', 'A', 'C', 'D'] },
    { ...input(), slots: ['A', 'B', 'C', 'unknown'] },
    { ...input(), entrants: input().entrants.map((team) => ({ ...team, seed: 'CBLOL2' })) },
    { ...input(), evidence: { entrants: evidence, draw: { ...evidence, reference: ' ' } } },
    { ...input(completed), evidence: { entrants: evidence, draw: evidence } },
  ]
  for (const variant of variants) assert.equal(replayWorlds2026PlayIn(variant).status, 'unsupported', JSON.stringify(variant))
})

test('premature downstream results, reseeding, duplicates, invalid scores and future observations are rejected', () => {
  const invalid = [
    [completed[2]], [completed[5]], [completed[0], completed[0]],
    [result('r1-a', ['A', 'D'])], [result('r1-a', ['A', 'A'])],
    [result('r1-a', ['A', 'B'], [2, 1])], [result('r1-a', ['A', 'B'], [3, 3])],
    [result('r1-a', ['A', 'B'], [3, -1])], [result('r1-a', ['A', 'B'], [3, 0.5])],
    [{ ...completed[0], observedAt: '2026-10-03T00:00:00Z' }],
    [...completed.slice(0, 5), result('r4', ['A', 'B'])],
    [completed[0], { ...completed[1], matchId: completed[0].matchId }],
  ]
  for (const results of invalid) assert.equal(replayWorlds2026PlayIn(input(results)).status, 'unsupported', JSON.stringify(results))
})

test('missing/future/incompatible frozen inputs never yield partial or substitute odds', () => {
  const models = [basis(), basis(), basis(), basis()]
  models[0].identityMap.mappings.pop()
  models[1].snapshot.modelConfigHash = 'other-config'
  models[2].ratingPublishedAt = '2026-10-03T00:00:00Z'
  models[3].snapshot.standings[3].rating = Number.NaN
  for (const model of models) {
    const value = forecastWorlds2026PlayIn(input(), model)
    assert.equal(value.status, 'unsupported')
    if (value.status === 'unsupported') assert.equal(value.reason, 'model-unavailable')
  }
})

test('an accepted finite rating scale that overflows provider calculations cannot yield supported NaN odds', () => {
  const model = basis()
  const scale = { ...publishedRatingScale, spreadMultiplier: Number.MIN_VALUE }
  model.model.ratingScale = scale
  model.snapshot.ratingScale = scale
  for (const team of model.snapshot.standings) team.rating = 2000
  const value = forecastWorlds2026PlayIn(input(), model)
  assert.equal(value.status, 'unsupported')
  if (value.status === 'unsupported') assert.equal(value.reason, 'model-unavailable')
})


test('an empty bracket may omit result evidence but cannot echo explicitly invalid result provenance', () => {
  const empty = input()
  empty.evidence = { entrants: evidence, draw: evidence }
  assert.equal(replayWorlds2026PlayIn(empty).status, 'supported')
  empty.evidence.results = { ...evidence, reference: ' ' }
  const value = replayWorlds2026PlayIn(empty)
  assert.equal(value.status, 'unsupported')
  if (value.status === 'unsupported') assert.equal(value.reason, 'evidence-missing')
  assert.equal(forecastWorlds2026PlayIn(empty, basis()).status, 'unsupported')
})

test('snapshot data cannot postdate publication, including when both dates precede the state cutoff', () => {
  const model = basis()
  model.ratingDataAsOf = '2026-10-01T02:00:00Z'
  const invalid = forecastWorlds2026PlayIn(input(), model)
  assert.equal(invalid.status, 'unsupported')
  if (invalid.status === 'unsupported') assert.equal(invalid.reason, 'model-unavailable')
  model.ratingPublishedAt = model.ratingDataAsOf
  assert.equal(forecastWorlds2026PlayIn(input(), model).status, 'supported')
})
