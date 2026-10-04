import assert from 'node:assert/strict'
import test from 'node:test'
import { publishedRatingScale } from '../src/lib/modelConfig'
import type { PublicTeamStanding } from '../src/lib/publicArtifacts/schema'
import { forecastTournamentSeries, type ForecastBasis } from '../src/lib/tournamentForecast'
import { WORLDS_2026_KNOCKOUT_RULES, replayWorlds2026Knockout, forecastWorlds2026Knockout,
  type Worlds2026KnockoutInput, type ObservedKnockoutResult, type KnockoutForecastResult } from '../src/lib/worlds2026Knockout'

const asOf = '2026-10-02T21:00:00Z'
const evidence = { kind: 'synthetic-fixture', reference: 'tests/worlds2026Knockout.test.ts' } as const
function input(results: ObservedKnockoutResult[] = []): Worlds2026KnockoutInput {
  return {
    rulesId: WORLDS_2026_KNOCKOUT_RULES.id, eventId: 'synthetic:worlds-2026', stateVersion: 'synthetic-state-1', asOf,
    qualifiers: [
      { id: 'A', swissWins: 3, swissLosses: 0 }, { id: 'B', swissWins: 3, swissLosses: 2 },
      { id: 'C', swissWins: 3, swissLosses: 1 }, { id: 'D', swissWins: 3, swissLosses: 1 },
      { id: 'E', swissWins: 3, swissLosses: 0 }, { id: 'F', swissWins: 3, swissLosses: 2 },
      { id: 'G', swissWins: 3, swissLosses: 1 }, { id: 'H', swissWins: 3, swissLosses: 2 },
    ], slots: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
    evidence: { qualifiers: evidence, draw: evidence, results: evidence }, results,
  }
}
function result(slot: number, teamIds: [string, string], gameWins: [number, number] = [3, 1]): ObservedKnockoutResult {
  return { slot, teamIds, gameWins, matchId: `synthetic:${slot}`, observedAt: asOf }
}
const completed = [result(0, ['A', 'B']), result(1, ['C', 'D']), result(2, ['E', 'F']), result(3, ['G', 'H']),
  result(4, ['A', 'C']), result(5, ['E', 'G']), result(6, ['A', 'E'], [1, 3])]

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
      mappings: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((id) => ({ sourceTeamId: id, teamId: `team:${id}` })) },
    snapshot: { artifactKind: 'public-snapshot-shard', filter: { region: 'All', event: 'All', season: 'All' },
      ratingScale: publishedRatingScale, modelVersion: 'fixture-v1', modelConfigHash: 'fixture-hash', matchCount: 0,
      sourceBreakdown: [], scoreFamilies: [], standings: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((id) => standing(id, 1800)), leagues: [], regions: [] },
  }
}
function supported(value: KnockoutForecastResult) {
  assert.equal(value.status, 'supported', JSON.stringify(value))
  return value
}
function close(a: number, b: number) { assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`) }
function conservation(value: ReturnType<typeof supported>) {
  close(value.totalProbability, 1)
  for (const row of value.teams) {
    close(row.finish5To8Probability + row.finish3To4Probability + row.runnerUpProbability + row.championProbability, 1)
    close(row.reachSemifinalProbability + row.finish5To8Probability, 1)
    close(row.reachFinalProbability + row.finish3To4Probability, row.reachSemifinalProbability)
    close(row.championProbability + row.runnerUpProbability, row.reachFinalProbability)
  }
  for (const [key, count] of [['reachSemifinalProbability', 4], ['reachFinalProbability', 2], ['championProbability', 1],
    ['finish5To8Probability', 4], ['finish3To4Probability', 2], ['runnerUpProbability', 1]] as const) {
    close(value.teams.reduce((sum, row) => sum + row[key], 0), count)
  }
}

test('symmetric eight-team bracket enumerates 128 fixed paths and conserves cumulative/finish slots', () => {
  const state = input()
  const model = basis()
  const original = structuredClone({ state, model })
  const forecast = supported(forecastWorlds2026Knockout(state, model))
  assert.equal(forecast.terminalPaths, 128)
  for (const row of forecast.teams) {
    close(row.reachSemifinalProbability, 0.5)
    close(row.reachFinalProbability, 0.25)
    close(row.championProbability, 0.125)
    assert.deepEqual(row.deterministicState, { id: row.id, reached: 'quarterfinal', eliminatedAt: null })
  }
  conservation(forecast)
  assert.deepEqual({ state, model }, original)
  assert.deepEqual(forecastWorlds2026Knockout(state, model), forecast)
  assert.ok(forecast.hypotheticalMatchups.every((match) => match.bestOf === 5 && match.sideAssumption === 'neutral'
    && match.matchId.startsWith('hypothetical:') && match.snapshotId === model.snapshotId && match.modelConfigHash === model.model.configHash))
  assert.ok(forecast.hypotheticalMatchups.every((match) => match.warnings.some((warning) => /sample data/.test(warning))))
})

test('independent partial rounds stay fixed and equivalent reordered/swapped observations replay identically', () => {
  const partial = replayWorlds2026Knockout(input([completed[0], completed[1], completed[4]]))
  assert.equal(partial.status, 'supported')
  if (partial.status === 'supported') assert.deepEqual(partial.readyMatches.map((match) => match.slot), [2, 3])
  const results = structuredClone(completed)
  results[0].teamIds = ['B', 'A']
  results[0].gameWins = [1, 3]
  assert.deepEqual(replayWorlds2026Knockout(input(results.reverse())), replayWorlds2026Knockout(input(completed)))
  const forecast = supported(forecastWorlds2026Knockout(input([completed[0]]), basis()))
  assert.equal(forecast.terminalPaths, 64)
  assert.equal(forecast.teams[1].championProbability, 0)
  assert.equal(forecast.teams[1].deterministicState.eliminatedAt, 'quarterfinal')
  close(forecast.teams[0].reachSemifinalProbability, 1)
  conservation(forecast)
})

test('semifinalists follow observed bracket links with no reseeding', () => {
  const forecast = supported(forecastWorlds2026Knockout(input(completed.slice(0, 4)), basis()))
  assert.equal(forecast.terminalPaths, 8)
  const semifinals = forecast.hypotheticalMatchups.filter((match) => [4, 5].includes(JSON.parse(match.matchId.slice('hypothetical:'.length))[1]))
  assert.deepEqual(semifinals.map((match) => match.teams.map((team) => team.sourceTeamId)), [['A', 'C'], ['E', 'G']])
  conservation(forecast)
})

test('completed bracket is deterministic without model inputs; eliminated ratings are not needed', () => {
  const model = basis()
  model.identityMap.mappings = []
  const forecast = supported(forecastWorlds2026Knockout(input(completed), model))
  assert.equal(forecast.terminalPaths, 1)
  assert.deepEqual(forecast.hypotheticalMatchups, [])
  assert.equal(forecast.teams[4].championProbability, 1)
  assert.equal(forecast.teams[0].runnerUpProbability, 1)
  conservation(forecast)
  model.identityMap.mappings = basis().identityMap.mappings.filter((row) => ['A', 'E'].includes(row.sourceTeamId))
  const final = supported(forecastWorlds2026Knockout(input(completed.slice(0, 6)), model))
  assert.equal(final.terminalPaths, 2)
  conservation(final)
})

test('asymmetric exact title odds increase with strength and final odds equal the #46 provider', () => {
  const model = basis()
  model.snapshot.standings[0].rating = 2100
  const forecast = supported(forecastWorlds2026Knockout(input(), model))
  assert.ok(forecast.teams[0].championProbability > 0.125)
  conservation(forecast)
  const final = supported(forecastWorlds2026Knockout(input(completed.slice(0, 6)), model))
  const provider = forecastTournamentSeries({ id: 'synthetic-final', eventId: 'synthetic:worlds-2026', stage: 'final',
    startTime: null, status: 'upcoming', sourceState: 'unstarted', bestOf: 5, vodUrls: [],
    teams: ['A', 'E'].map((id) => ({ id, name: null, code: null, gameWins: null, outcome: null })) }, model)
  assert.equal(provider.status, 'ready')
  if (provider.status === 'ready') close(final.teams[0].championProbability, provider.homeSeriesWinProbability)
})

test('uncertified rules, malformed qualifier records and illegal or missing draws fail closed', () => {
  const variants: Worlds2026KnockoutInput[] = [
    { ...input(), rulesId: 'worlds-2025' }, { ...input(), eventId: '' }, { ...input(), stateVersion: '' }, { ...input(), asOf: 'bad' },
    { ...input(), qualifiers: input().qualifiers.slice(1) }, { ...input(), qualifiers: input().qualifiers.map((row) => ({ ...row, swissLosses: 1 })) },
    { ...input(), slots: ['A', 'A', 'C', 'D', 'E', 'F', 'G', 'H'] },
    { ...input(), slots: ['A', 'C', 'B', 'D', 'E', 'F', 'G', 'H'] },
    { ...input(), slots: ['A', 'B', 'E', 'F', 'C', 'D', 'G', 'H'] },
    { ...input(), slots: ['A', 'E', 'B', 'F', 'C', 'D', 'G', 'H'] },
    { ...input(), slots: ['unknown', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] },
    { ...input(), evidence: { qualifiers: evidence, draw: { ...evidence, reference: ' ' } } },
    { ...input(completed), evidence: { qualifiers: evidence, draw: evidence } },
  ]
  for (const variant of variants) assert.equal(replayWorlds2026Knockout(variant).status, 'unsupported', JSON.stringify(variant))
  const empty = input()
  empty.evidence = { qualifiers: evidence, draw: evidence }
  assert.equal(replayWorlds2026Knockout(empty).status, 'supported')
  empty.evidence.results = { ...evidence, reference: '' }
  assert.equal(replayWorlds2026Knockout(empty).status, 'unsupported')
})

test('premature or reseeded results, impossible scores, duplicate IDs and future results fail closed', () => {
  const invalid = [
    [completed[4]], [completed[6]], [completed[0], completed[0]],
    [result(0, ['A', 'D'])], [result(0, ['A', 'A'])], [result(7, ['A', 'B'])], [result(0.5, ['A', 'B'])],
    [result(0, ['A', 'B'], [2, 1])], [result(0, ['A', 'B'], [3, 3])], [result(0, ['A', 'B'], [3, -1])], [result(0, ['A', 'B'], [3, 0.5])],
    [{ ...completed[0], observedAt: '2026-10-03T00:00:00Z' }],
    [...completed.slice(0, 4), result(4, ['A', 'G'])],
    [completed[0], { ...completed[1], matchId: completed[0].matchId }],
    [completed[0], completed[1], { ...completed[4], observedAt: '2026-10-02T20:00:00Z' }],
  ]
  for (const results of invalid) assert.equal(replayWorlds2026Knockout(input(results)).status, 'unsupported', JSON.stringify(results))
})

test('missing or incompatible ratings and future snapshot provenance yield no partial forecast', () => {
  const models = [basis(), basis(), basis(), basis(), basis()]
  models[0].identityMap.mappings.pop()
  models[1].snapshot.modelConfigHash = 'other-config'
  models[2].ratingPublishedAt = '2026-10-03T00:00:00Z'
  models[3].snapshot.standings[7].rating = Number.NaN
  models[4].ratingDataAsOf = '2026-10-01T02:00:00Z'
  for (const model of models) {
    const forecast = forecastWorlds2026Knockout(input(), model)
    assert.equal(forecast.status, 'unsupported')
    if (forecast.status === 'unsupported') assert.equal(forecast.reason, 'model-unavailable')
  }
})
