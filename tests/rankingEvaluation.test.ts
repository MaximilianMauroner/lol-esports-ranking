import assert from 'node:assert/strict'
import test from 'node:test'
import { binaryMetricContract } from '../src/domains/rankings/internal/projections/binaryPredictionMetrics.ts'
import { chronologicalCohorts, compareEvaluationExports, readEvaluationExport, summarizeEvaluation, type EvaluationExport } from '../tools/calibration/lib/rankingEvaluation.ts'
import { buildEvaluationData, replayInputDigest, requireEvaluationGeneratedAt, type ReplayInputs } from '../tools/calibration/lib/rankingEvaluationData.ts'
import { createRatingReplayContext, replayRatingDates } from '../src/domains/rankings/internal/replay/model.ts'
import { seriesWinProbability } from '../src/domains/rankings/internal/queries/winProbability.ts'
import type { MatchRecord, PregamePrediction } from '../src/domains/rankings/types.ts'
import { sampleMatches, teams } from './fixtures/rankingFixtures.ts'

function syntheticReplay(): ReplayInputs {
  return { matches: structuredClone(sampleMatches.slice(0, 2)), teams: structuredClone(teams), tournamentLifecycles: null }
}

function fixture(): EvaluationExport {
  return { schemaVersion: 2, replayInputs: replayInputDigest([syntheticReplay()]), target: 'game', modelVersion: 'fixture', modelConfigHash: 'fixture',
    sourceIdentity: 'synthetic-fixture', temporalPolicy: 'latest-corrected-prior-replay', metricContract: binaryMetricContract,
    rows: Array.from({ length: 6 }, (_, index) => ({ id: `game-${index}`, seriesId: `series-${index}`,
      eventId: `event-${index}`, date: '2025-01-01', teamA: 'Alpha', teamB: 'Beta', leagueA: 'LCK', leagueB: 'LPL',
      actual: 1, probability: 0.5, segments: ['cross-region'] })) }
}

test('prediction pairing rejects duplicate IDs, swapped sides, changed outcomes, targets, source and segments', () => {
  const base = fixture()
  const mutations = [
    { ...base, rows: [base.rows[0], base.rows[0]] },
    { ...base, rows: base.rows.map((row) => ({ ...row, teamA: 'Beta', teamB: 'Alpha' })) },
    { ...base, rows: base.rows.map((row) => ({ ...row, actual: 0 })) },
    { ...base, rows: base.rows.map((row) => ({ ...row, segments: [] })) },
    { ...base, target: 'series' }, { ...base, sourceIdentity: 'different-corpus' },
    { ...base, rows: base.rows.map((row) => ({ ...row, probability: NaN })) },
  ]
  for (const changed of mutations) assert.throws(() => compareEvaluationExports(base, changed, 100))
})

test('empty and event-poor comparisons remain unavailable and cannot pass the gate', () => {
  const base = fixture()
  const empty = { ...base, rows: [] }
  const result = compareEvaluationExports(empty, empty, 100)
  assert.equal(result.passed, false)
  assert.equal(result.global.brierDelta, null)
  assert.equal(result.global.confidence95.status, 'unavailable')
  const oneEvent = { ...base, rows: base.rows.map((row) => ({ ...row, eventId: 'one-tournament' })) }
  assert.equal(compareEvaluationExports(oneEvent, oneEvent, 100).passed, false)
  const domestic = { ...base, rows: base.rows.map((row) => ({ ...row, segments: [] })) }
  assert.equal(compareEvaluationExports(domestic, domestic, 100).passed, false)
})

test('event-aware bootstrap preserves common event effects and reproduces paired losses', () => {
  const base = fixture()
  const next = { ...base, rows: base.rows.map((row) => ({ ...row, probability: .75 })) }
  const result = compareEvaluationExports(base, next, 100)
  assert.equal(result.global.brierDelta, -.1875)
  assert.equal(result.global.confidence95.status, 'estimated')
  assert.equal(result.passed, true)
  assert.equal(result.superiority.status, 'supported-on-this-cohort')
  assert.equal(result.superiority.publishedAccuracyClaim, false)
  assert.deepEqual(result, compareEvaluationExports(base, next, 100))
  const duplicatedGames = { ...next, rows: next.rows.flatMap((row) => [row, { ...row, id: row.id + '-second' }]) }
  assert.equal(summarizeEvaluation(duplicatedGames.rows).events, 6)
})

test('metric endpoints, bins and missing denominators match the shared versioned contract', () => {
  const row = fixture().rows[0]
  const result = summarizeEvaluation([{ ...row, probability: 0 }, { ...row, id: 'right', probability: 1 }])
  assert.equal(result.brier, .5)
  assert.equal(result.logLoss, (-Math.log(.001) - Math.log(.999)) / 2)
  assert.equal(result.impossibleOutcomes, 1)
  assert.equal(result.calibration[9].count, 1)
  assert.equal(result.calibration[1].meanPredicted, null)
  assert.equal(summarizeEvaluation([]).accuracy, null)
  assert.throws(() => readEvaluationExport({ ...fixture(), metricContract: {} }))
})

test('chronological folds withhold whole events that cross a boundary', () => {
  const row = fixture().rows[0]
  const rows = [row, { ...row, id: 'later', date: '2025-05-01' },
    { ...row, id: 'validation', seriesId: 'second', eventId: 'second', date: '2025-06-01' }]
  const split = chronologicalCohorts(rows, '2025-04-01', '2025-06-30')
  assert.equal(split.fit.length, 0)
  assert.equal(split.validation.length, 1)
  assert.equal(split.excluded.length, 2)
})

test('export builder rejects stale source joins, duplicate identities and mixed model identities', () => {
  const matches = sampleMatches.slice(0, 2)
  const context = createRatingReplayContext(matches, { ...teams })
  const { predictions } = replayRatingDates({ context, replayMatches: matches })
  const exportPredictions = (rows: PregamePrediction[], source = matches) =>
    buildEvaluationData({ matches: source, teams: context.teams, tournamentLifecycles: null }, rows, { sourceIdentity: 'synthetic-fixture' })
  const first = predictions[0]
  const mutations: Array<Partial<PregamePrediction>> = [
    { teamA: first.teamB, teamB: first.teamA },
    { teamA: 'Different team' }, { date: '2025-01-01' }, { event: 'Different event' },
    { actualWinner: first.teamB }, { seriesId: 'different-series' },
  ]
  for (const mutation of mutations) assert.throws(() => exportPredictions([{ ...first, ...mutation }, predictions[1]]), /source or orientation differs|winner contradicts probability/)
  assert.throws(() => exportPredictions([first, first]), /Duplicate prediction identities/)
  assert.throws(() => exportPredictions(predictions, [matches[0], matches[0]]), /Duplicate source match identities/)
  assert.throws(() => exportPredictions([first, { ...predictions[1], modelVersion: 'different-model' }]), /Mixed prediction model identities/)
  assert.throws(() => exportPredictions([first, { ...predictions[1], modelConfigHash: 'different-config' }]), /Mixed prediction model identities/)
})

test('exported aliases and swapped raw sides keep game and series probabilities aligned with canonical outcomes', () => {
  const alias = 'LYON (2024 American Team)'
  const matches: MatchRecord[] = [
    { ...sampleMatches[0], id: 'alias-1', officialMatchId: 'alias-series', gameNumber: 1,
      teamA: alias, teamB: 'Beta', winner: 'LYON', bestOf: 3 },
    { ...sampleMatches[0], id: 'alias-2', officialMatchId: 'alias-series', gameNumber: 2,
      teamA: 'Beta', teamB: 'LYON', winner: 'Beta', bestOf: 3 },
    { ...sampleMatches[0], id: 'alias-3', officialMatchId: 'alias-series', gameNumber: 3,
      teamA: 'LYON', teamB: 'Beta', winner: alias, bestOf: 3 },
  ]
  const templateContext = createRatingReplayContext(sampleMatches, { ...teams })
  const template = replayRatingDates({ context: templateContext, replayMatches: sampleMatches }).predictions[0]
  const predictions = matches.map((match): PregamePrediction => ({ ...template,
    id: match.id, seriesId: undefined, date: match.date, event: match.event,
    teamA: match.teamA === alias ? 'LYON' : match.teamA, teamB: match.teamB,
    actualWinner: match.winner, predictedWinner: match.teamA === 'Beta' ? match.teamB : 'LYON',
    teamAGameWinProbability: match.teamA === 'Beta' ? .2 : .8, teamBGameWinProbability: match.teamA === 'Beta' ? .8 : .2,
    variants: { ...template.variants, published: { ...template.variants.published,
      teamAGameWinProbability: match.teamA === 'Beta' ? .2 : .8, teamBGameWinProbability: match.teamA === 'Beta' ? .8 : .2 } } }))
  const exported = buildEvaluationData({ matches, teams: templateContext.teams, tournamentLifecycles: null }, predictions, { sourceIdentity: 'synthetic-alias-fixture' })
  assert.deepEqual(exported.rows.map((row) => [row.teamA, row.teamB, row.actual, row.probability]), [
    ['LYON', 'Beta', 1, .8], ['Beta', 'LYON', 1, .2], ['LYON', 'Beta', 1, .8],
  ])
  assert.equal(exported.seriesExport.rows.length, 1)
  assert.equal(exported.seriesExport.rows[0].teamA, 'LYON')
  assert.equal(exported.seriesExport.rows[0].actual, 1)
  assert.equal(exported.seriesExport.rows[0].probability, seriesWinProbability(.8, 3))
})

test('legacy exports remain readable summaries but never grant pairing authority', () => {
  const base = { ...fixture(), schemaVersion: 1, provenance: { trainingSourceIdentity: 'warmup-A' } }
  const next = { ...base, provenance: { trainingSourceIdentity: 'warmup-B' } }
  assert.equal(readEvaluationExport(base).schemaVersion, 1)
  assert.equal(summarizeEvaluation(readEvaluationExport(base).rows).count, 6)
  assert.throws(() => compareEvaluationExports(base, next, 100), /Legacy export/)
  assert.throws(() => compareEvaluationExports(base, fixture(), 100), /Legacy export/)
})

test('schema2 identity survives JSON and normalized-reader reparsing and admits model-only changes', () => {
  const base = fixture()
  const normalized = readEvaluationExport(JSON.parse(JSON.stringify(base)))
  const next = { ...normalized, modelVersion: 'different-model', modelConfigHash: 'different-config' }
  const result = compareEvaluationExports(normalized, next, 100)
  assert.equal(result.replayInputs, base.schemaVersion === 2 && base.replayInputs)
  assert.equal(result.passed, true)
  for (const replayInputs of [undefined, null, '', 'replay-inputs/v2:' + 'a'.repeat(64), 'replay-inputs/v1:abc', 'replay-inputs/v1:' + 'A'.repeat(64)]) {
    assert.throws(() => readEvaluationExport({ ...base, replayInputs }), /Invalid replay-input identity/)
  }
  const different = syntheticReplay()
  different.matches[0].winner = different.matches[0].teamB
  assert.throws(() => compareEvaluationExports(base, { ...base, replayInputs: replayInputDigest([different]) }, 100), /Replay inputs differ/)
})

test('one actual synthetic replay binds game, series and all control exports', () => {
  const replay = syntheticReplay()
  const context = createRatingReplayContext(replay.matches, replay.teams)
  const state = replayRatingDates({ context, replayMatches: replay.matches })
  const data = buildEvaluationData(replay, state.predictions, { sourceIdentity: 'synthetic', scoreStart: replay.matches[1].date })
  assert.equal(data.replayInputs, replayInputDigest([replay]))
  assert.ok(Object.keys(data.variants).length > 0)
  for (const variant of [data, data.seriesExport, ...Object.values(data.variants)]) {
    const parsed = readEvaluationExport(JSON.parse(JSON.stringify(variant)))
    assert.equal(parsed.schemaVersion === 2 && parsed.replayInputs, data.replayInputs)
  }
  const warmup = structuredClone(replay)
  warmup.matches[0].teamAKills = (warmup.matches[0].teamAKills ?? 0) + 1
  const changed = buildEvaluationData(warmup, state.predictions, { sourceIdentity: 'synthetic', scoreStart: replay.matches[1].date })
  assert.equal(changed.sourceIdentity, data.sourceIdentity)
  assert.notEqual(changed.replayInputs, data.replayInputs)
})

test('digest binds every effective profile, lifecycle and exact generation-time dimension', () => {
  const replay = syntheticReplay()
  const lifecycle = { status: 'completed' as const, boundaryDate: '2025-01-02', ratedThroughDate: '2025-01-02', dataLag: false, resultCoverageComplete: false }
  replay.tournamentLifecycles = { generatedAt: '2025-02-01T00:00:00Z', byId: new Map([['one', lifecycle]]) }
  const digest = replayInputDigest([replay])
  const team = Object.keys(replay.teams)[0]
  const mutations: ReplayInputs[] = [
    ...Object.entries({ name: 'Changed', code: 'NEW', region: 'International', league: 'Unknown' }).map(([key, value]) => {
      const changed = structuredClone(replay)
      Object.assign(changed.teams[team], { [key]: value })
      return changed
    }),
    ...Object.entries({ status: 'ongoing', boundaryDate: '2025-01-03', ratedThroughDate: '2025-01-03', dataLag: true, resultCoverageComplete: true }).map(([key, value]) => ({
      ...replay, tournamentLifecycles: { generatedAt: replay.tournamentLifecycles!.generatedAt, byId: new Map([['one', { ...lifecycle, [key]: value }]]) },
    })),
    { ...replay, tournamentLifecycles: { generatedAt: '2025-02-01T00:00:00.000Z', byId: replay.tournamentLifecycles.byId } },
    { ...replay, tournamentLifecycles: { generatedAt: replay.tournamentLifecycles.generatedAt, byId: new Map() } },
    { ...replay, tournamentLifecycles: null },
  ]
  for (const changed of mutations) assert.notEqual(replayInputDigest([changed]), digest)
  assert.notEqual(replayInputDigest([{ ...replay, tournamentLifecycles: null }]), replayInputDigest([{ ...replay, tournamentLifecycles: { generatedAt: replay.tournamentLifecycles.generatedAt, byId: new Map() } }]))
  for (const invalid of [undefined, '', 'tomorrow', '2025-02-30T00:00:00Z', '2025-01-01']) assert.throws(() => requireEvaluationGeneratedAt(invalid), /generatedAt/)
  const offsetTime = '2025-01-01T23:00:00-02:00'
  assert.equal(requireEvaluationGeneratedAt(offsetTime), offsetTime)
})

test('canonical replay encoding preserves meaningful orders and rejects invalid values', () => {
  const replay = syntheticReplay()
  const digest = replayInputDigest([replay])
  const reorderedObjects = { ...replay, matches: replay.matches.map((match) => Object.fromEntries(Object.entries(match).reverse()) as MatchRecord),
    teams: Object.fromEntries(Object.entries(replay.teams).map(([key, value]) => [key, { league: value.league, region: value.region, code: value.code, name: value.name }])) }
  assert.equal(replayInputDigest([reorderedObjects]), digest)
  assert.notEqual(replayInputDigest([{ ...replay, matches: [...replay.matches].reverse() }]), digest)
  assert.notEqual(replayInputDigest([{ ...replay, teams: Object.fromEntries(Object.entries(replay.teams).reverse()) }]), digest)
  const roster = structuredClone(replay)
  const players = [{ id: 'one', name: 'One', role: 'Top' as const }, { id: 'two', name: 'Two', role: 'Jungle' as const }]
  roster.matches[0].teamARoster = { sourceProvider: 'oracles-elixir', observedAt: '2025-01-01', completeness: 'partial', players }
  const rosterDigest = replayInputDigest([roster])
  players.reverse()
  assert.notEqual(replayInputDigest([roster]), rosterDigest)
  const lifecycle = { status: 'ongoing' as const, boundaryDate: '2025-01-01', ratedThroughDate: '2025-01-01', dataLag: false, resultCoverageComplete: false }
  const withMap = { ...replay, tournamentLifecycles: { generatedAt: '2025-01-01T00:00:00Z', byId: new Map([['a', lifecycle], ['b', lifecycle]]) } }
  assert.equal(replayInputDigest([withMap]), replayInputDigest([{ ...withMap, tournamentLifecycles: { ...withMap.tournamentLifecycles, byId: new Map([...withMap.tournamentLifecycles.byId].reverse()) } }]))
  assert.equal(replayInputDigest([{ ...replay, matches: replay.matches.map((match) => ({ ...match, teamAKills: -0, teamAHomeLeague: undefined })) }]), replayInputDigest([{ ...replay, matches: replay.matches.map((match) => ({ ...match, teamAKills: 0, teamAHomeLeague: undefined })) }]))
  for (const invalid of [NaN, Infinity, undefined, 1n, () => 0, new Date(), Symbol('invalid')]) {
    const changed = structuredClone(replay)
    Object.assign(changed.matches[0], { extra: [invalid] })
    assert.throws(() => replayInputDigest([changed]), /Invalid replay-input/)
  }
  const cyclic = structuredClone(replay)
  Object.assign(cyclic.matches[0], { self: cyclic.matches[0] })
  assert.throws(() => replayInputDigest([cyclic]), /Invalid replay-input/)
  const sparse = structuredClone(replay)
  Object.assign(sparse.matches[0], { extra: Array(1) })
  assert.throws(() => replayInputDigest([sparse]), /Invalid replay-input/)
  const omitted = structuredClone(replay)
  delete omitted.matches[0].teamAHomeLeague
  const undefinedField = structuredClone(omitted)
  undefinedField.matches[0].teamAHomeLeague = undefined
  assert.equal(replayInputDigest([omitted]), replayInputDigest([undefinedField]))
  const filename = structuredClone(replay)
  filename.matches[0].sourceFileName = 'retained-games.json'
  const originalFilenameDigest = replayInputDigest([filename])
  filename.matches[0].sourceFileName = 'other-games.json'
  assert.notEqual(originalFilenameDigest, replayInputDigest([filename]))
  const duplicate = { ...replay, matches: [...replay.matches, replay.matches[0]] }
  assert.notEqual(replayInputDigest([duplicate]), digest)
})

test('ordered cutoff snapshots bind their actual prior profiles and differ from a full replay', () => {
  const full = syntheticReplay()
  const first = { matches: full.matches.slice(0, 1), teams: { [full.matches[0].teamA]: full.teams[full.matches[0].teamA] }, tournamentLifecycles: null }
  const second = { ...full, teams: structuredClone(full.teams) }
  const aggregate = replayInputDigest([first, second])
  assert.notEqual(aggregate, replayInputDigest([full]))
  assert.notEqual(aggregate, replayInputDigest([second, first]))
  second.teams[Object.keys(second.teams)[0]].code += 'changed'
  assert.notEqual(aggregate, replayInputDigest([first, second]))
})
