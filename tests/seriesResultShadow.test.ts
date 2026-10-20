import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  createRatingReplayContext, materializeRankingModel, replayRatingDates,
  type SeriesResultDateBatch, type SeriesResultInput,
} from '../src/domains/rankings/build.ts'
import { calculateSeriesResultUpdate } from '../src/domains/rankings/internal/replay/seriesResultUpdate.ts'
import { createRatingRunState } from '../src/domains/rankings/internal/replay/ratingRunState.ts'
import { resolveCanonicalSeries } from '../src/domains/rankings/evidence.ts'
import { mergeCommunityMatchSources } from '../src/domains/rankings/internal/evidence/communitySources.ts'
import type { MatchRecord, MatchRosterSnapshot, TeamProfile } from '../src/domains/rankings/types.ts'
import { crossMidnightReviewCases, crossMidnightTeams } from './fixtures/crossMidnightReviewCases.ts'
import {
  compareSeriesResultResponse, encodeSeriesResultRequest, MAX_BATCH_BYTES, numberBits, readBounded, runSeriesResultShadow, sha256,
} from '../tools/audit/series-result-shadow.ts'

const binary = process.env.RANKING_COMPUTE_TEST_BINARY
const artifactRoot = resolve('.agents/artifacts/series-result-tests')

function input(overrides: Partial<SeriesResultInput> = {}): SeriesResultInput {
  return {
    teams: [
      { team: 'Alpha', league: 'LCK', currentPowerRating: 1500, uncertainty: 50, rosterContinuity: undefined },
      { team: 'Beta', league: 'LCK', currentPowerRating: 1500, uncertainty: 50, rosterContinuity: 1 },
    ],
    bestOf: 1, observedOutcomeA: 1, observedOutcomeB: 0, strengthSignal: 1, eventK: 24, international: false,
    ...overrides,
  }
}
function dateBatch(inputs: readonly SeriesResultInput[]): SeriesResultDateBatch[] {
  const series = inputs.map((value, index) => ({
    seriesId: `synthetic\u0000${index}`, matchIds: [`game-${index}`], input: value, nodeResult: calculateSeriesResultUpdate(value),
  }))
  return [{ utcDate: '2026-01-01', authoritativeMatchIds: series.flatMap((s) => s.matchIds).sort(), series }]
}
async function temporary() {
  await mkdir(artifactRoot, { recursive: true })
  return mkdtemp(join(artifactRoot, 'run-'))
}
function responseFor(dates: readonly SeriesResultDateBatch[], request: Buffer) {
  const wire = JSON.parse(request.toString())
  return {
    schema: 'series-result-response-v1', requestSha256: sha256(request), model: wire.model,
    dates: dates.map((date) => ({ ...date, series: date.series.map((series) => ({
      seriesId: series.seriesId, matchIds: series.matchIds,
      result: Object.fromEntries(Object.entries(series.nodeResult).map(([field, value]) => [field, numberBits(value)])),
    })) })),
  }
}

test('date observer sees frozen detached captures after complete markers and preserves replay', () => {
  const teams: Record<string, TeamProfile> = Object.fromEntries(['Alpha', 'Beta', 'Gamma'].map((name) => [name, { name, code: name, league: 'LCK', region: 'LCK' }]))
  const roster = (prefix: string): MatchRosterSnapshot => ({
    sourceProvider: 'oracles-elixir', teamId: prefix, observedAt: '2026-01-01', completeness: 'complete-five-role',
    players: (['Top', 'Jungle', 'Mid', 'Bot', 'Support'] as const).map((role) => ({ id: `${prefix}-${role}`, name: `${prefix}-${role}`, role })),
  })
  const match = (id: string, date: string, teamB: string, lineup: string): MatchRecord => ({
    id, sourceGameId: id, sourceProvider: 'oracles-elixir', dataCompleteness: 'scoreboard-game-stats',
    date, datetimeUtc: `${date}T${id === 'second' ? '16' : '12'}:00:00Z`, season: 2026,
    event: 'LCK 2026 Spring', phase: 'Regular season', region: 'LCK', league: 'LCK', patch: '26.1', bestOf: 1,
    tier: 'regional-regular', teamA: 'Alpha', teamB, winner: 'Alpha', teamAKills: 20, teamBKills: 12,
    teamAGold: 65000, teamBGold: 59000, teamARoster: roster(lineup), teamBRoster: roster(teamB),
  })
  const matches = [match('first', '2026-01-01', 'Beta', 'old'), match('second', '2026-01-01', 'Gamma', 'new'), match('third', '2026-01-02', 'Beta', 'new')]
  const baselineContext = createRatingReplayContext(structuredClone(matches), structuredClone(teams))
  const baseline = replayRatingDates({ context: baselineContext, replayMatches: baselineContext.authoritativeMatches })
  const context = createRatingReplayContext(structuredClone(matches), structuredClone(teams))
  const state = createRatingRunState(context.authoritativeMatches, context.teams, context.eventWeightContext, context.tournamentLifecycles)
  const captured: SeriesResultDateBatch[] = []
  replayRatingDates({ context, state, replayMatches: [...context.authoritativeMatches].reverse(), onSeriesResultDate: (date) => {
    assert.equal(state.processedThroughUtcDate, date.utcDate)
    assert.deepEqual(date.authoritativeMatchIds, state.processedThroughUtcDateMatchIds)
    assert.notEqual(date.authoritativeMatchIds, state.processedThroughUtcDateMatchIds)
    assert.throws(() => { (date.series[0].input.teams[0] as { uncertainty: number }).uncertainty = 999 })
    assert.throws(() => { (date.series[0].matchIds as string[]).push('bad') })
    assert.throws(() => { (date.series[0].nodeResult as { seriesDeltaA: number }).seriesDeltaA = 999 })
    assert(Object.isFrozen(date) && Object.isFrozen(date.series) && Object.isFrozen(date.series[0].input) && Object.isFrozen(date.series[0].input.teams))
    captured.push(date)
  } })
  assert.deepStrictEqual(state, baseline)
  assert.doesNotThrow(() => structuredClone(state))
  assert.doesNotThrow(() => structuredClone(context))
  assert.deepStrictEqual(materializeRankingModel({ context, state }), materializeRankingModel({ context: baselineContext, state: baseline }))
  assert.deepEqual(captured.map((date) => date.utcDate), ['2026-01-01', '2026-01-02'])
  assert.deepEqual(captured[0].series.map((series) => series.seriesId), resolveCanonicalSeries(matches.slice(0, 2)).map((series) => series.id))
  assert.equal(captured[0].series[0].input.teams[0].currentPowerRating, captured[0].series[1].input.teams[0].currentPowerRating)
  assert.equal(captured[0].series[1].input.teams[0].rosterContinuity, 0)
  const before = captured[0].series[0].input.teams[0].uncertainty
  state.uncertainties.set('Alpha', 999)
  assert.equal(captured[0].series[0].input.teams[0].uncertainty, before)
  assert.throws(() => replayRatingDates({ context, replayMatches: [matches[0]] }), /complete authoritative UTC date/)
})

test('Node comparison rejects missing, extra, reordered, mismatched and malformed native outputs', () => {
  const dates = dateBatch([input(), input({ bestOf: 3 })])
  const request = encodeSeriesResultRequest(dates)
  assert(!request.includes('nodeResult') && !request.includes('expectedOutcomeA'))
  assert.equal(compareSeriesResultResponse(responseFor(dates, request), dates, request).fieldsCompared, 48)
  const mutations = [
    (value: ReturnType<typeof responseFor>) => { value.dates.pop() },
    (value: ReturnType<typeof responseFor>) => { value.dates[0].series.push(value.dates[0].series[0]) },
    (value: ReturnType<typeof responseFor>) => { value.dates[0].series.reverse() },
    (value: ReturnType<typeof responseFor>) => { delete value.dates[0].series[0].result.expectedOutcomeA },
    (value: ReturnType<typeof responseFor>) => { value.dates[0].series[0].result.extra = numberBits(1) },
    (value: ReturnType<typeof responseFor>) => { value.dates[0].series[0].result.seriesDeltaA = numberBits(-0) },
    (value: ReturnType<typeof responseFor>) => { value.dates[0].series[0].result.seriesDeltaA = 'NaN' },
    (value: ReturnType<typeof responseFor>) => { value.model.configHash = 'wrong' },
    (value: ReturnType<typeof responseFor>) => { value.requestSha256 = 'wrong' },
  ]
  for (const mutate of mutations) {
    const value = responseFor(dates, request)
    mutate(value)
    assert.throws(() => compareSeriesResultResponse(value, dates, request))
  }
})

function syntheticInputs() {
  const values: SeriesResultInput[] = []
  const leagues = ['LCK', 'LPL', 'LEC', 'LCS', 'LTA', 'LTA N', 'LTA S', 'LCP', 'CBLOL', 'VCS', 'PCS', 'LJL', 'LLA', 'TCL', 'LCO', 'NACL', 'LCKC', 'LCK CL', 'LAS', 'LFL', 'LFL2', 'NLC', 'NL', 'PRM', 'PRMP', 'LVP SL', 'LES', 'LIT', 'RL', 'NEXO', 'CCWS', 'HC', 'IC', 'EM', 'EMEA MASTERS', 'AL', 'HM', 'HW', 'HLL', 'EBL', 'LPLOL', 'CD', 'ROL', 'LRN', 'LRS', 'LTS', 'CT',
    'Unknown', 'unknown', '', 'Unmapped', '\ufeff lck \ufeff', '\u0085LCK\u0085', 'academy', 'éacademyé', '_academy', 'academy2', 'Kacademy',
    'Challenger', 'Challengers', 'Development', 'Division\ufeff2', 'Division\u00852', 'Division2', 'D2', 'Elite', 'National', 'Proving Grounds', 'Secondary', 'Nationalſ', 'ſecondary', 'Academyſ', 'DIVISION\u20282', 'division_2']
  for (const bestOf of [1, 2, 3, 5] as const) {
    for (const [index, league] of leagues.entries()) {
      for (const international of [false, true]) {
        const base = input()
        values.push(input({ bestOf, international,
          teams: [{ ...base.teams[0], league, currentPowerRating: 1100 + index * 13.789, uncertainty: [-100, 20, 50, 140, 1000][index % 5], rosterContinuity: [undefined, -1, 0, 0.5, 1, 2][index % 6] },
            { ...base.teams[1], league: index % 3 === 0 ? league : 'LCK', currentPowerRating: 1700 - index * 0.153, uncertainty: index * 3.13, rosterContinuity: undefined }],
          observedOutcomeA: index % 3 / 2, observedOutcomeB: 1 - index % 3 / 2, strengthSignal: 1.18, eventK: 32.615,
        }))
      }
    }
  }
  values.push(input({ eventK: 1 / 0.9, observedOutcomeA: 0, observedOutcomeB: 1 }))
  values.push(input({ eventK: -0 }))
  values.push(input({ teams: [{ ...input().teams[0], currentPowerRating: -1e100 }, { ...input().teams[1], currentPowerRating: 1e100 }] }))
  assert(Object.is(calculateSeriesResultUpdate(values[values.length - 3]).seriesDeltaA, -0), 'Negative half must round to signed zero')
  return values
}

test('native CLI calculates all 24 fields exactly against actual TypeScript synthetic results', { skip: !binary }, async () => {
  const root = await temporary()
  try {
    const dates = dateBatch(syntheticInputs())
    const result = await runSeriesResultShadow({ dates, binaryPath: binary!, outputDir: join(root, 'parity') })
    assert.equal(result.fieldsCompared, dates[0].series.length * 24)
    assert.equal(result.mismatches, 0)
    console.log(JSON.stringify({ syntheticSeries: result.series, fieldsCompared: result.fieldsCompared, retainedSeries: 0 }))
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const merged of [false, true]) {
  test(`native CLI preserves real replay parity for ${merged ? 'a merged' : 'an unmerged'} series crossing UTC midnight`, { skip: !binary }, async () => {
    const teams: Record<string, TeamProfile> = Object.fromEntries(['Alpha', 'Beta'].map((name) => [name, { name, code: name, league: 'LCK', region: 'LCK' }]))
    const matches: MatchRecord[] = ['2026-01-01T23:50:00Z', '2026-01-02T00:30:00Z'].map((datetimeUtc, index) => ({
      id: `series_game_${index + 1}`, sourceGameId: `series_game_${index + 1}`,
      sourceProvider: 'oracles-elixir', dataCompleteness: 'scoreboard-game-stats',
      date: datetimeUtc.slice(0, 10), datetimeUtc, season: 2026,
      event: 'LCK 2026 Spring', phase: 'Regular season', region: 'LCK', league: 'LCK', patch: '26.1', bestOf: 3,
      tier: 'regional-regular', teamA: 'Alpha', teamB: 'Beta', winner: 'Alpha', teamAKills: 20, teamBKills: 12,
      teamAGold: 65000, teamBGold: 59000,
    }))
    const replayMatches = merged ? mergeCommunityMatchSources({ oracleMatches: matches, leaguepediaMatches: [] }) : matches
    const baselineContext = createRatingReplayContext(structuredClone(replayMatches), structuredClone(teams))
    const baseline = replayRatingDates({ context: baselineContext, replayMatches: baselineContext.authoritativeMatches })
    const context = createRatingReplayContext(structuredClone(replayMatches), structuredClone(teams))
    const state = createRatingRunState(context.authoritativeMatches, context.teams, context.eventWeightContext, context.tournamentLifecycles)
    const captured: SeriesResultDateBatch[] = []
    replayRatingDates({ context, state, replayMatches: context.authoritativeMatches, onSeriesResultDate: (date) => {
      assert.equal(state.processedThroughUtcDate, date.utcDate)
      assert.deepEqual(date.authoritativeMatchIds, state.processedThroughUtcDateMatchIds)
      captured.push(date)
    } })
    const seriesId = 'source-game-series\u0000oracles-elixir\u0000series'
    assert.deepEqual(captured.map((date) => ({
      utcDate: date.utcDate, authoritativeMatchIds: date.authoritativeMatchIds,
      series: date.series.map(({ seriesId, matchIds }) => ({ seriesId, matchIds })),
    })), merged ? [
      { utcDate: '2026-01-01', authoritativeMatchIds: ['series_game_1', 'series_game_2'], series: [{ seriesId, matchIds: ['series_game_1', 'series_game_2'] }] },
    ] : [
      { utcDate: '2026-01-01', authoritativeMatchIds: ['series_game_1'], series: [{ seriesId, matchIds: ['series_game_1'] }] },
      { utcDate: '2026-01-02', authoritativeMatchIds: ['series_game_2'], series: [{ seriesId, matchIds: ['series_game_2'] }] },
    ])
    const root = await temporary()
    try {
      const result = await runSeriesResultShadow({ dates: captured, binaryPath: binary!, outputDir: join(root, 'midnight') })
      assert.equal(result.dates, merged ? 1 : 2)
      assert.equal(result.series, merged ? 1 : 2)
      assert.equal(result.fieldsCompared, merged ? 24 : 48)
      assert.equal(result.mismatches, 0)
      assert.deepStrictEqual(state, baseline)
      assert.deepStrictEqual(materializeRankingModel({ context, state }), materializeRankingModel({ context: baselineContext, state: baseline }))
      if (merged) assert.ok(materializeRankingModel({ context, state }).standings.find(({ team }) => team === 'Alpha')!.baseRating > 1500)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}

for (const scenario of crossMidnightReviewCases()) {
  test(`native replay and season history preserve ${scenario.name}`, { skip: !binary }, async () => {
    const matches = mergeCommunityMatchSources(structuredClone(scenario.complete))
    const sameDateMatches = mergeCommunityMatchSources(structuredClone(scenario.sameDate))
    const scoped = matches.filter((match) => match.season === scenario.season && match.date.startsWith(`${scenario.season}-`))
    assert.equal(scoped.length, scenario.seriesGameCounts.reduce((sum, count) => sum + count, 0))
    const resolved = resolveCanonicalSeries(matches)
    assert.deepEqual(resolved.map(({ date }) => date), scenario.seriesDates)
    assert.deepEqual(resolved.map(({ games }) => games.length), scenario.seriesGameCounts)
    assert.ok(resolved.every(({ state }) => state === 'completed'))
    const root = await temporary()
    try {
      for (const [scope, games] of [['global', matches], ['season', scoped]] as const) {
        const context = createRatingReplayContext(games, structuredClone(crossMidnightTeams))
        const captured: SeriesResultDateBatch[] = []
        const state = replayRatingDates({ context, replayMatches: context.authoritativeMatches,
          onSeriesResultDate: (batch) => captured.push(batch) })
        const result = await runSeriesResultShadow({ dates: captured, binaryPath: binary!, outputDir: join(root, scope) })
        assert.equal(result.series, scenario.seriesGameCounts.length)
        assert.equal(result.fieldsCompared, scenario.seriesGameCounts.length * 24)
        assert.equal(result.mismatches, 0)
        const model = materializeRankingModel({ context, state })
        const baselineContext = createRatingReplayContext(sameDateMatches, structuredClone(crossMidnightTeams))
        const baselineState = replayRatingDates({ context: baselineContext, replayMatches: baselineContext.authoritativeMatches })
        const baseline = materializeRankingModel({ context: baselineContext, state: baselineState })
        assert.deepEqual(model.standings, baseline.standings)
        for (const standing of model.standings) {
          const updates = standing.history.filter((point) => point.ratingUpdate.updateUnit === 'series-atomic')
          assert.equal(updates.length, scenario.seriesGameCounts.length)
          assert.ok(updates.every((point) => point.delta !== 0))
          if (scenario.name === 'ordinal-rematch') {
            assert.deepEqual(updates.map((point) => point.source.officialMatchId),
              ['synthetic-official-round-1', 'synthetic-official-round-2'])
          }
        }
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}

test('real native CLI rejects invalid complete requests and oversized files', { skip: !binary }, async () => {
  const root = await temporary()
  try {
    const original = JSON.parse(encodeSeriesResultRequest(dateBatch([input(), input()])).toString())
    const mutations = [
      (v: typeof original) => { v.schema = 'unknown' },
      (v: typeof original) => { v.model.configHash = 'wrong' },
      (v: typeof original) => { v.extra = true },
      (v: typeof original) => { v.dates[0].utcDate = '2026-02-30' },
      (v: typeof original) => { v.dates.push(v.dates[0]) },
      (v: typeof original) => { v.dates[0].series[0].input.bestOf = 4 },
      (v: typeof original) => { v.dates[0].series[0].input.eventK = '7ff0000000000000' },
      (v: typeof original) => { v.dates[0].series[0].input.eventK = '0' },
      (v: typeof original) => { delete v.dates[0].series[0].input.teams[0].rosterContinuity },
      (v: typeof original) => { v.dates[0].series[0].input.teams[0].team = 'x'.repeat(4097) },
      (v: typeof original) => { v.dates[0].series[1].seriesId = v.dates[0].series[0].seriesId },
      (v: typeof original) => { v.dates[0].series[1].matchIds = v.dates[0].series[0].matchIds },
      (v: typeof original) => { v.dates[0].authoritativeMatchIds.push('absent') },
      (v: typeof original) => { v.dates[0].series[0].matchIds = ['other-date'] },
      (v: typeof original) => { v.dates[0].authoritativeMatchIds.reverse() },
      (v: typeof original) => { v.dates[0].series = [] },
      (v: typeof original) => { v.dates[0].series = Array(4097).fill(v.dates[0].series[0]) },
      (v: typeof original) => { v.dates[0].series[0].input.teams[0].tier = 'tier-one' },
      (v: typeof original) => { v.dates[0].series[0].input.eventK = numberBits(1e308); v.dates[0].series[0].input.strengthSignal = numberBits(1e308) },
      (v: typeof original) => {
        v.dates[0].series = Array.from({ length: 1100 }, (_, index) => ({
          seriesId: `large-${index}`, matchIds: [`large-${index}`],
          input: { ...v.dates[0].series[0].input, teams: v.dates[0].series[0].input.teams.map((team: Record<string, unknown>, teamIndex: number) => ({ ...team, team: String(teamIndex).repeat(4096) })) },
        }))
        v.dates[0].authoritativeMatchIds = v.dates[0].series.map((series: { seriesId: string }) => series.seriesId).sort()
      },
    ]
    const path = join(root, 'input.json')
    for (const [index, mutate] of mutations.entries()) {
      const value = structuredClone(original)
      mutate(value)
      await writeFile(path, JSON.stringify(value))
      const output = join(root, `rejected-${index}.json`)
      const result = spawnSync(binary!, ['series-result', path, output], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 })
      assert.equal(result.status, 1, result.stderr)
      await assert.rejects(readFile(output), { code: 'ENOENT' })
    }
    for (const bytes of ['{', JSON.stringify(original).slice(0, -1), JSON.stringify(original) + 'null', JSON.stringify(original).replace('{', '{"schema":"series-result-batch-v1",')]) {
      await writeFile(path, bytes)
      assert.equal(spawnSync(binary!, ['series-result', path, join(root, 'truncated.json')]).status, 1)
    }
    await writeFile(path, '')
    await truncate(path, MAX_BATCH_BYTES + 1)
    assert.equal(spawnSync(binary!, ['series-result', path, join(root, 'oversized.json')], { timeout: 10000 }).status, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Node process boundary enforces deadline, output bounds, truncation and exit status', async () => {
  const root = await temporary()
  try {
    for (const [name, body, message] of [
      ['deadline', 'setInterval(() => {}, 1000)', /deadline/],
      ['stdout', 'process.stdout.write("x".repeat(70000))', /stdout exceeds/],
      ['stderr', 'process.stderr.write("x".repeat(70000))', /stderr exceeds/],
      ['nonzero', 'process.exit(2)', /exited 2/],
      ['truncated', 'require("node:fs").writeFileSync(process.argv[4], "{")', /JSON/],
      ['missing', '', /JSON/],
      ['large-file', `require("node:fs").truncateSync(process.argv[4], ${MAX_BATCH_BYTES + 1})`, /byte limit/],
    ] as const) {
      const executable = join(root, `${name}.cjs`)
      await writeFile(executable, `#!${process.execPath}\n${body}\n`, { mode: 0o755 })
      await assert.rejects(runSeriesResultShadow({ dates: dateBatch([input()]), binaryPath: executable,
        outputDir: join(root, name), deadlineMs: name === 'deadline' ? 100 : 10000 }), message)
    }
    const oversized = join(root, 'oversized')
    await writeFile(oversized, '')
    await truncate(oversized, 32)
    await assert.rejects(readBounded(oversized, 16), /byte limit/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
