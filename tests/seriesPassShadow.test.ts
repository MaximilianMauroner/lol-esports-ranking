import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createRatingReplayContext, materializeRankingModel, replayRatingDates } from '../src/domains/rankings/build.ts'
import {
  compareSeriesPassResponse, encodeSeriesPassRequest, MAX_BATCH_BYTES, numberBits, readBounded, runSeriesPassShadow, sha256,
} from '../tools/audit/series-pass-shadow.ts'
import { game, observe, profiles, roster, sparseDate, variedGames } from './seriesPassFixtures.ts'

const binary = process.env.RANKING_COMPUTE_TEST_BINARY
const artifactRoot = resolve('.agents/artifacts/series-pass-tests')
async function temporary() {
  await mkdir(artifactRoot, { recursive: true })
  return mkdtemp(join(artifactRoot, 'run-'))
}
function responseFor(captures: ReturnType<typeof observe>['captures'], request: Buffer) {
  const encode = (value: unknown, indexes = false): unknown => {
    if (typeof value === 'number') return indexes ? value : numberBits(value)
    if (Array.isArray(value)) return value.map((item) => encode(item, indexes))
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value)
      const source = entries.length === 1 && entries[0][0] === 'member'
      return Object.fromEntries(entries.map(([key, child]) => [key, encode(child, indexes || source || key === 'inserted')]))
    }
    return value
  }
  return {
    schema: 'series-pass-response-v1', requestSha256: sha256(request), model: JSON.parse(request.toString()).model,
    dates: captures.map((capture) => encode(capture.expected)),
  }
}

test('the real date observer is detached and leaves checkpoints and materialized rankings unchanged', () => {
  const matches = variedGames()
  const context = createRatingReplayContext(structuredClone(matches), structuredClone(profiles))
  const baseline = replayRatingDates({ context, replayMatches: context.authoritativeMatches })
  const observed = observe(matches)
  assert.deepStrictEqual(observed.state, baseline)
  assert.deepStrictEqual(materializeRankingModel(observed), materializeRankingModel({ context, state: baseline }))
  const { captures } = observed
  assert.equal(captures.length, 7)
  const date = captures[1]
  assert.equal(date.frame.series.length, 2)
  assert.equal(date.expected.series[1].continuity[0].rosterContinuity, 0)
  assert.notEqual(date.expected.series[0].members[0].sides[0].localExecutionRating,
    date.expected.series[1].members[0].sides[0].localExecutionBefore)
  assert.equal(date.expected.series[0].members[0].sides[0].snapshotRating,
    date.expected.series[1].members[0].sides[0].snapshotRating)
  const emptyPatch = date.expected.series[1].members[0].sideSamples
  assert.deepEqual(emptyPatch.map(([key]) => key), ['all', 'all'])
  assert.equal(emptyPatch[1][1].total, emptyPatch[0][1].total + 1)
  assert.equal(captures[3].expected.series[0].outcomeA, 0.5)
  assert.equal(captures[3].expected.series[0].members.at(-1)!.leagueHistory.length, 0)
  assert.equal(captures[4].expected.series[0].state, 'ongoing')
  assert.equal(captures[5].expected.teams[0].lastRoster, 'prior')
  assert.equal(captures[6].expected.series[0].state, 'unknown')
  assert.throws(() => { (date.frame.teams[0] as { rating: number }).rating = 999 })
  assert.throws(() => { (date.expected.series[0].members as unknown[]).push({}) })
  observed.state.ratings.set('Alpha', 999)
  assert.notEqual(date.expected.teams[0].rating, 999)
  assert.throws(() => replayRatingDates({ context, replayMatches: [matches[1]] }), /complete authoritative UTC date/)
})

test('the comparator checks every member and final state field, bits, presence and order', () => {
  const { captures } = observe(variedGames())
  const request = encodeSeriesPassRequest(captures.map((capture) => capture.frame))
  assert(!request.includes('"expected":') && !request.includes('executionDelta') && !request.includes('components'))
  const result = compareSeriesPassResponse(responseFor(captures, request), captures, request)
  assert.equal(result.members, variedGames().length)
  assert(result.memberNumericFields > result.members * 100)
  assert(result.stateNumericFields > 0)
  const original = JSON.stringify(responseFor(captures, request))
  const mutations = [
    (value: ReturnType<typeof JSON.parse>) => { value.dates.pop() },
    (value: ReturnType<typeof JSON.parse>) => { value.dates[1].series.reverse() },
    (value: ReturnType<typeof JSON.parse>) => { value.dates[1].series[0].members[0].sides[0].executionDelta = numberBits(-0) },
    (value: ReturnType<typeof JSON.parse>) => { value.dates[1].series[0].members[0].sides[0].previousComponents.momentum = 'NaN' },
    (value: ReturnType<typeof JSON.parse>) => { delete value.dates[1].teams[0].lastPatch },
    (value: ReturnType<typeof JSON.parse>) => { value.dates[0].leagues[0].lastEvent = '' },
    (value: ReturnType<typeof JSON.parse>) => { value.dates[1].series[0].members[0].sides[0].wins = 1 },
    (value: ReturnType<typeof JSON.parse>) => { value.dates[1].series[1].members[0].sideSamples.reverse() },
    (value: ReturnType<typeof JSON.parse>) => { value.dates[2].inserted.leagues.lastEvents.reverse() },
    (value: ReturnType<typeof JSON.parse>) => { value.dates[0].teams[0].latestRatingUpdate.member.side = 1 },
    (value: ReturnType<typeof JSON.parse>) => { value.dates[1].extra = true },
    (value: ReturnType<typeof JSON.parse>) => { value.model.configHash = 'wrong' },
    (value: ReturnType<typeof JSON.parse>) => { value.requestSha256 = 'wrong' },
  ]
  for (const mutate of mutations) {
    const response = JSON.parse(original)
    mutate(response)
    assert.throws(() => compareSeriesPassResponse(response, captures, request))
  }
})

test('native series pass matches actual replay calculations, state and inserted map order', { skip: !binary }, async () => {
  const root = await temporary()
  try {
    const { captures } = observe(variedGames(), (state) => {
      state.ratings.set('Alpha', 1651.25)
      state.executionRatings.set('Alpha', 1400.125)
      state.momentums.set('Alpha', -0)
      state.wins.set('Alpha', 4)
      state.losses.set('Alpha', 15)
      state.factorSums.delete('Alpha')
      state.factorCounts.delete('Alpha')
      state.lastRosterByTeam.set('Alpha', roster('Alpha'))
    })
    const result = await runSeriesPassShadow({ captures, binaryPath: binary!, outputDir: join(root, 'parity') })
    assert.equal(result.members, variedGames().length)
    assert.equal(result.seriesResultFields, result.series * 24)
    assert.equal(result.mismatches, 0)
    assert.deepEqual(captures[0].expected.inserted.teams.factorSums, [0])
    console.log(JSON.stringify({ synthetic: true, ...result, batches: result.batches.length }))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('native series IDs may repeat across UTC midnight and signed zero survives a skipped write', { skip: !binary }, async () => {
  const root = await temporary()
  try {
    const matches = ['2026-01-01T23:50:00Z', '2026-01-02T00:30:00Z'].map((datetimeUtc, index) => game(`midnight_game_${index + 1}`, {
      sourceMatchId: 'midnight', date: datetimeUtc.slice(0, 10), datetimeUtc, bestOf: 3,
      teamARoster: undefined, teamBRoster: undefined, teamAKills: 0, teamBKills: 0, teamAGold: 0, teamBGold: 0,
      winner: 'Beta',
    }))
    const { captures } = observe(matches, (state) => state.executionRatings.set('Alpha', 1184))
    assert.equal(captures[0].frame.series[0].seriesId, captures[1].frame.series[0].seriesId)
    assert(Object.is(captures[0].expected.series[0].members[0].sides[0].executionDelta, -0))
    assert.equal(captures[0].expected.teams[0].executionRating, 1184)
    assert.equal(captures[0].expected.series[0].members[0].sides[0].seriesDelta, 0)
    await runSeriesPassShadow({ captures, binaryPath: binary!, outputDir: join(root, 'midnight') })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('sparse maps preserve absence and ordered insertions while local execution advances on a skipped live delta', { skip: !binary }, async () => {
  const root = await temporary()
  try {
    const capture = sparseDate()
    assert(Object.is(capture.expected.series[0].members[0].sides[0].executionDelta, -0))
    assert.equal(capture.expected.teams[0].rating, null)
    assert.equal(capture.expected.teams[0].executionRating, null)
    assert.equal(capture.expected.series[0].members[0].sides[0].localExecutionRating, 1500)
    assert.deepEqual(capture.expected.inserted.teams.ratings, [])
    assert.deepEqual(capture.expected.inserted.teams.executionRatings, [])
    assert.deepEqual(capture.expected.inserted.teams.previousDisplayRatings, [0, 1])
    assert.equal(capture.expected.leagues[0].score, null)
    const request = encodeSeriesPassRequest([capture.frame])
    const fixture = JSON.parse(await readFile(new URL('./fixtures/rankingComputeSeriesPass.json', import.meta.url), 'utf8'))
    assert.deepEqual(JSON.parse(request.toString()), fixture.request, 'Synthetic native fixture input differs from its Node source')
    assert.deepEqual(responseFor([capture], request).dates, fixture.expectedDates, 'Synthetic native fixture expectation differs from Node')
    await runSeriesPassShadow({ captures: [capture], binaryPath: binary!, outputDir: join(root, 'sparse') })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('native preserves league priors, caps and tier transfers through the real replay', { skip: !binary }, async () => {
  const root = await temporary()
  try {
    const captures = []
    const leagues = ['LCK', 'LEC', 'CBLOL', 'Unknown', '', '\ufeff lck \ufeff', '\u0085LCK\u0085',
      'academy', 'éacademyé', '_academy', 'Kacademy', 'Division\ufeff2', 'Division\u00852', 'Nationalſ']
    for (const [index, league] of leagues.entries()) {
      for (const international of [false, true]) {
        const teams = structuredClone(profiles)
        teams.Alpha.league = league
        const matches = [game(`tier-${index}-${international}`, {
          date: `2026-02-${String(index + 1).padStart(2, '0')}`, datetimeUtc: undefined,
          teamARoster: undefined, teamBRoster: undefined,
          event: international ? 'MSI 2026' : 'LCK Spring', region: international ? 'International' : 'LCK',
        })]
        const observed = observe(matches, (state) => {
          state.leagueScores.set(league, 1600.125)
          state.leagueMatchCounts.set(league, 7)
          state.ratings.set('Alpha', 1637.25)
          state.rosterPriorOffsets.set('Alpha', 31.35)
          state.wins.set('Alpha', 5)
          state.losses.set('Alpha', 11)
        }, teams)
        captures.push(...observed.captures)
      }
    }
    for (const [index, capture] of captures.entries()) {
      await runSeriesPassShadow({ captures: [capture], binaryPath: binary!, outputDir: join(root, String(index)) })
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('native rejects malformed frames, impossible membership and overflowing counts without an output', { skip: !binary }, async () => {
  const root = await temporary()
  try {
    const { captures } = observe(variedGames())
    const original = JSON.parse(encodeSeriesPassRequest(captures.map((capture) => capture.frame)).toString())
    const mutations = [
      (v: typeof original) => { v.schema = 'wrong' },
      (v: typeof original) => { v.model.configHash = 'wrong' },
      (v: typeof original) => { v.extra = true },
      (v: typeof original) => { delete v.dates[0].teams[0].rating },
      (v: typeof original) => { v.dates[0].teams[0].rating = '7ff0000000000000' },
      (v: typeof original) => { v.dates[0].teams[0].rating = '7FF0000000000000' },
      (v: typeof original) => { v.dates[0].teams[0].rating = 'x' },
      (v: typeof original) => { v.dates[0].teams[0].rating = 1500 },
      (v: typeof original) => { v.dates[0].teams[0].rating = numberBits(1e308); v.dates[0].teams[0].momentum = numberBits(1e308) },
      (v: typeof original) => { v.dates[0].utcDate = '2026-02-30' },
      (v: typeof original) => { v.dates[0].utcDate = '2026-1-1' },
      (v: typeof original) => { v.dates[0].lastDate = '2025-01-01' },
      (v: typeof original) => { v.dates.reverse() },
      (v: typeof original) => { v.dates[1].authoritativeMatchIds.push('missing') },
      (v: typeof original) => { v.dates[1].authoritativeMatchIds.reverse() },
      (v: typeof original) => { v.dates[1].series[1].seriesId = v.dates[1].series[0].seriesId },
      (v: typeof original) => { v.dates[1].series.reverse() },
      (v: typeof original) => { v.dates[2].series[0].members.reverse() },
      (v: typeof original) => { v.dates[0].series[0].teams[0] = 999 },
      (v: typeof original) => { v.dates[0].series[0].leagues[0] = 999 },
      (v: typeof original) => { v.dates[0].series[0].bestOf = 4 },
      (v: typeof original) => { v.dates[0].series[0].wins[0] = 0 },
      (v: typeof original) => { v.dates[0].series[0].state = 'completed' },
      (v: typeof original) => { v.dates[0].series[0].members[0].ordering.datetimeUtc = '2026-01-02T00:00:00Z' },
      (v: typeof original) => { v.dates[0].series[0].members[0].ordering.datetimeUtc = 'bad' },
      (v: typeof original) => { v.dates[0].series[0].members[0].ordering.gameNumber = numberBits(0.5) },
      (v: typeof original) => { v.dates[0].series[0].members[0].winner = 2 },
      (v: typeof original) => { v.dates[1].series[0].members[0].sides[0].team = 2 },
      (v: typeof original) => { v.dates[0].series[0].members[0].sides[0].colour = 'red' },
      (v: typeof original) => { v.dates[0].series[0].members[0].sides[0].roster.players[0].role = 'ADC' },
      (v: typeof original) => { v.dates[0].series[0].members[0].sides[0].roster.players[0].role = 'Top' },
      (v: typeof original) => { v.dates[0].series[0].members[0].sides[0].roster.players.pop() },
      (v: typeof original) => { v.dates[0].series[0].members[0].sides[0].roster.players[0].id = '' },
      (v: typeof original) => { v.dates[0].series[0].members[0].sides[0].gold = numberBits(-1) },
      (v: typeof original) => { v.dates[0].series[0].members[0].matchId = 'other' },
      (v: typeof original) => { v.dates[0].series[0].members[0].event = 'x'.repeat(4097) },
      (v: typeof original) => { v.dates[0].processedMatchCount = numberBits(Number.MAX_SAFE_INTEGER) },
      (v: typeof original) => { v.dates[0].teams[0].wins = numberBits(-1) },
      (v: typeof original) => { v.dates[0].sideSamples = [['all', { blueWins: numberBits(2), total: numberBits(1) }]] },
      (v: typeof original) => { v.dates[0].leagues[0].lastUpdated = '2026-02-30' },
    ]
    const inputPath = join(root, 'input.json')
    for (const [index, mutate] of mutations.entries()) {
      const value = structuredClone(original)
      mutate(value)
      await writeFile(inputPath, JSON.stringify(value))
      const output = join(root, `rejected-${index}.json`)
      const result = spawnSync(binary!, ['series-pass', inputPath, output], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 })
      assert.equal(result.status, 1, `mutation ${index}: ${result.stderr}`)
      await assert.rejects(readFile(output), { code: 'ENOENT' })
    }
    for (const bytes of ['{', JSON.stringify(original).slice(0, -1), JSON.stringify(original) + 'null',
      JSON.stringify(original).replace('{', '{"schema":"series-pass-batch-v1",')]) {
      await writeFile(inputPath, bytes)
      assert.equal(spawnSync(binary!, ['series-pass', inputPath, join(root, 'truncated.json')], { timeout: 10000 }).status, 1)
    }
    await writeFile(inputPath, '')
    await truncate(inputPath, MAX_BATCH_BYTES + 1)
    assert.equal(spawnSync(binary!, ['series-pass', inputPath, join(root, 'oversized.json')], { timeout: 10000 }).status, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Node enforces native process deadlines, byte limits, truncated output and exit status', async () => {
  const root = await temporary()
  try {
    const { captures } = observe([game('boundary')])
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
      await assert.rejects(runSeriesPassShadow({ captures, binaryPath: executable,
        outputDir: join(root, name), deadlineMs: name === 'deadline' ? 100 : 10000 }), message)
    }
    const oversized = join(root, 'oversized')
    await writeFile(oversized, '')
    await truncate(oversized, 32)
    await assert.rejects(readBounded(oversized, 16), /byte limit/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('fake transport splits small inputs when complete-date responses exceed 64 MiB together', async () => {
  const root = await temporary()
  try {
    const original = observe(variedGames()).captures.slice(1, 3)
    const request = encodeSeriesPassRequest(original.map((capture) => capture.frame))
    assert(request.length < 16 << 10)
    const template = join(root, 'template.json')
    await writeFile(template, JSON.stringify(responseFor(original, request)))
    const padding = 'é'.repeat(17 << 20)
    const captures = original.map((capture) => ({ ...capture, expected: { ...capture.expected,
      teams: capture.expected.teams.map((team, index) => index === 0 ? { ...team, lastPatch: padding } : team),
    } }))
    const executable = join(root, 'response.cjs')
    await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs')
const crypto = require('node:crypto')
const request = fs.readFileSync(process.argv[3])
const input = JSON.parse(request)
const response = JSON.parse(fs.readFileSync(${JSON.stringify(template)}, 'utf8'))
response.requestSha256 = crypto.createHash('sha256').update(request).digest('hex')
response.dates = input.dates.map(frame => response.dates.find(date => date.utcDate === frame.utcDate))
for (const date of response.dates) date.teams[0].lastPatch = 'é'.repeat(17 << 20)
const bytes = JSON.stringify(response)
if (Buffer.byteLength(bytes) > ${MAX_BATCH_BYTES}) {
  process.stderr.write('series-pass: response exceeds 64 MiB')
  process.exit(1)
}
fs.writeFileSync(process.argv[4], bytes)
`, { mode: 0o755 })
    const result = await runSeriesPassShadow({ captures, binaryPath: executable, outputDir: join(root, 'split') })
    assert.equal(result.batches.length, 2)
    const counts = compareSeriesPassResponse(responseFor(captures, request), captures, request)
    for (const key of Object.keys(counts) as (keyof typeof counts)[]) assert.equal(result[key], counts[key], key)
    for (const [index, batch] of result.batches.entries()) {
      const input = await readFile(batch.inputPath)
      assert.deepEqual(input, encodeSeriesPassRequest([captures[index].frame]))
      assert.equal(batch.requestSha256, sha256(input))
      const output = await readFile(batch.outputPath)
      assert(output.length <= MAX_BATCH_BYTES)
      assert.equal(batch.responseSha256, sha256(output))
      assert.deepEqual(JSON.parse(output.toString()).dates, responseFor([captures[index]], input).dates)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('an oversized complete-date response fails with its date and limit before spawn', async () => {
  const root = await temporary()
  try {
    const captures = observe([game('oversized-response')]).captures.map((capture) => ({ ...capture, expected: { ...capture.expected,
      teams: capture.expected.teams.map((team, index) => index === 0 ? { ...team, lastPatch: 'é'.repeat(33 << 20) } : team),
    } }))
    const marker = join(root, 'spawned')
    const executable = join(root, 'must-not-spawn.cjs')
    await writeFile(executable, `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')
process.exit(2)
`, { mode: 0o755 })
    await assert.rejects(runSeriesPassShadow({ captures, binaryPath: executable, outputDir: join(root, 'oversized') }),
      /2026-01-01.*response.*64 MiB/)
    await assert.rejects(readFile(marker), { code: 'ENOENT' })
    await assert.rejects(readFile(join(root, 'oversized', 'batch-0', 'request.json')), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
