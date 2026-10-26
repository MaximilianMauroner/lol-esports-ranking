import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { exportPregameSeries } from '../scripts/rankings/export-pregame-series.ts'
import type { ForecastCandidate, ForecastRequestFile } from '../scripts/rankings/export-pregame-series.ts'
import { importRankingSourceData } from '../scripts/rankings/source-input.ts'
import { replaySimpleElo, replaySimpleEloSeries, replaySimpleEloSeriesBatch } from '../src/domains/rankings/forecast.ts'
import type { PregameSeriesRequest, SimpleEloState } from '../src/domains/rankings/forecast.ts'
import { eventTierConfig } from '../src/domains/rankings/policy.ts'
import { evaluationBaselineProbabilities } from '../tools/calibration/lib/evaluationBaselines.ts'
import { sampleMatches } from './fixtures/rankingFixtures.ts'

const cutoff = Date.parse('2026-02-10T10:00:00Z')
const capture = Date.parse('2026-02-09T22:00:00Z')
const future = Date.parse('2026-03-01T00:00:00Z')
const request: PregameSeriesRequest = {
  seriesId: 'next', eventId: 'event-next', homeTeamId: 'gen', awayTeamId: 't1',
  homeSourceTeam: 'Gen.G', awaySourceTeam: 'T1', bestOf: 3, scheduleRevision: 'schedule-1',
  scheduledStartAt: cutoff + 7200000, scheduleObservedAt: cutoff - 1000, scheduleProvider: 'lolesports-schedule',
  asOf: cutoff, validUntil: cutoff + 7000000, event: 'LCK 2026 Spring', patch: '26.1', season: 2026,
  league: 'LCK', region: 'LCK', tier: 'regional-regular',
}
const games = [0, 1].map(index => ({ ...sampleMatches[0], id: `elo-game-${index + 1}`, sourceGameId: `elo-game-${index + 1}`,
  sourceMatchId: 'elo-series', sourceProvider: 'leaguepedia-cargo' as const, bestOf: 3 as const, bestOfBasis: 'official' as const }))
const inputs = games.map(match => ({ match, observedAt: capture, resultAvailableAt: capture }))

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'simple-elo-'))
  const manifest = join(directory, 'manifest.json')
  const requests = join(directory, 'requests.json')
  const candidatePath = join(directory, 'candidate.json')
  const raw = { fetchedAt: new Date(capture).toISOString(), matches: structuredClone(games) }
  const files = { leaguepediaJson: ['raw.json'], lolEsportsJson: [] as string[] }
  await writeFile(join(directory, 'raw.json'), JSON.stringify(raw))
  await writeFile(manifest, JSON.stringify({ files }))
  const source = await importRankingSourceData({ manifestPath: manifest })
  const requestFile: ForecastRequestFile = { evidenceMode: 'synthetic', availability: 'verified',
    observations: source.matches.map(match => ({ gameId: match.id, observedAt: capture, resultAvailableAt: capture })), requests: [{ ...request }] }
  const candidate: ForecastCandidate = { modelKind: 'simple-elo', candidateId: 'simple-elo-v1', parentCandidateId: null,
    calibrationFit: null, transform: { temperature: 1, calibrationOrder: 'game-before-series', dependence: 0 } }
  let run = 0
  return { directory, raw, files, requestFile, candidate, async export(cli = false) {
    await writeFile(manifest, JSON.stringify({ files }))
    await writeFile(requests, JSON.stringify(requestFile))
    await writeFile(candidatePath, JSON.stringify(candidate))
    const output = join(directory, `forecast-${run++}.jsonl`)
    const started = Date.now()
    const receipts = cli ? (() => {
      const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'scripts/rankings/export-pregame-series.ts',
        manifest, requests, candidatePath, output], { encoding: 'utf8' }))
      assert.equal(result.eligible, requestFile.requests.length)
      return null
    })() : await exportPregameSeries(manifest, requests, candidatePath, output)
    const rows = receipts ?? (await readFile(output, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const states = (await readFile(`${output}.states.jsonl`, 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { modelStateId: string; modelStateHash: string; state: SimpleEloState })
    return { rows, states, started, manifest: JSON.parse(await readFile(`${output}.manifest.json`, 'utf8')) }
  } }
}

test('simple Elo freezes within UTC date and matches existing complete-series control', () => {
  const k = eventTierConfig['regional-regular'].kFactor
  const replay = replaySimpleElo(games)
  assert.equal(replay.probabilities.get(games[0].id), .5)
  assert.equal(replay.probabilities.get(games[1].id), .5)
  assert.equal(replay.teams.get('Gen.G')!.rating, 1500 + k)
  assert.equal(replay.teams.get('T1')!.rating, 1500 - k)
  const target = { ...games[0], id: 'target', sourceMatchId: 'target', date: '2026-02-10', bestOf: 1 as const }
  const existing = evaluationBaselineProbabilities([...games, target])
  assert.equal(existing.get(target.id)!.elo, 1 / (1 + 10 ** (-2 * k / 400)))
  const causal = replaySimpleEloSeries(inputs, request, 'verified')
  assert.equal(1 / (1 + 10 ** ((causal.state.away.rating - causal.state.home.rating) / 400)), existing.get(target.id)!.elo)
  assert.deepEqual(causal.state.usedGameIds, games.map(game => game.id))
  assert.throws(() => replaySimpleEloSeries(inputs.slice(0, 1), request, 'verified'), /No completed causal Elo history/)
})

test('Elo advances once per day and applies each tournament K without ranking shrinkage', () => {
  const k = eventTierConfig['regional-regular'].kFactor
  const international = { ...games[0], id: 'international', sourceMatchId: 'international',
    date: '2026-01-20', bestOf: 1 as const, tier: 'msi-bracket' as const, winner: 'T1' }
  const p = 1 / (1 + 10 ** (-2 * k / 400))
  const expectedHome = 1500 + k - eventTierConfig['msi-bracket'].kFactor * p
  const replay = replaySimpleEloSeries([...inputs, { match: international, observedAt: capture, resultAvailableAt: capture }], request, 'verified')
  assert.equal(replay.state.home.rating, expectedHome)
  assert.equal(replay.state.away.rating, 3000 - expectedHome)
  assert.equal(replay.state.throughDate, '2026-01-20')
  assert.equal(replay.state.home.games, 3)
  assert.equal(replaySimpleElo([...games, international]).probabilities.get(international.id), p)
})

test('Elo replay excludes same-date results and later observations before canonical series resolution', () => {
  const baseline = replaySimpleEloSeries(inputs, request, 'verified')
  const additions = [
    { ...inputs[0], observedAt: cutoff - 1, resultAvailableAt: cutoff - 1, match: { ...games[0], id: 'same-day', sourceMatchId: 'same-day', bestOf: 1 as const, date: '2026-02-10' } },
    { ...inputs[0], observedAt: future, match: { ...games[0], id: 'unobserved', sourceMatchId: 'unobserved', bestOf: 1 as const } },
  ]
  for (const row of additions) {
    const before = replaySimpleEloSeries([...inputs, row], request, 'verified')
    row.match.winner = 'T1'
    assert.deepEqual(replaySimpleEloSeries([...inputs, row], request, 'verified'), before)
    assert.deepEqual(before, baseline)
  }
  assert.throws(() => replaySimpleEloSeries(inputs, { ...request, homeSourceTeam: 'Missing team' }, 'verified'), /No completed causal Elo history/)
})

test('real Elo export retains exact state, source closure, fixed identity and actual generation time', async () => {
  const f = await fixture()
  try {
    const output = await f.export(true)
    const receipt = output.rows[0]
    assert.equal(receipt.modelKind, 'simple-elo')
    assert.equal(receipt.candidateId, 'simple-elo-v1')
    assert.equal(receipt.parentCandidateId, null)
    assert.equal(receipt.calibrationFit, null)
    assert.equal(receipt.calibratorVersion, 'simple-elo-identity-v1')
    assert.equal(receipt.seriesConversionVersion, 'simple-elo-independent-series-v1')
    assert.ok(receipt.generatedAt >= output.started)
    assert.ok(receipt.generatedAt <= Date.now())
    assert.equal(receipt.modelStateHash, createHash('sha256').update(JSON.stringify(output.states[0].state)).digest('hex'))
    assert.equal('uncertainty' in output.states[0].state.home, false)
    assert.equal(output.states[0].state.home.games, 2)
    assert.deepEqual(receipt.sourceObservedAt, [capture, request.scheduleObservedAt])
    assert.ok(output.manifest.sourceDigests.some((row: { path: string }) => row.path.endsWith('simpleEloReplay.ts')))
    for (const input of receipt.inputDigests) assert.equal(input.sha256, createHash('sha256').update(await readFile(input.path)).digest('hex'))
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})

test('Elo Bo1, Bo3 and Bo5 use independent conversion and complement under team reversal', async () => {
  const f = await fixture()
  try {
    f.requestFile.requests = ([1, 3, 5] as const).flatMap(bestOf => [
      { ...request, seriesId: `forward-${bestOf}`, bestOf },
      { ...request, seriesId: `reverse-${bestOf}`, bestOf, homeTeamId: request.awayTeamId, awayTeamId: request.homeTeamId,
        homeSourceTeam: request.awaySourceTeam, awaySourceTeam: request.homeSourceTeam },
    ])
    const { rows } = await f.export()
    const k = eventTierConfig['regional-regular'].kFactor
    const p = 1 / (1 + 10 ** (-2 * k / 400))
    const expected = [p, p ** 2 * (3 - 2 * p), p ** 3 * (10 - 15 * p + 6 * p ** 2)]
    for (let index = 0; index < 3; index++) {
      assert.ok(Math.abs(rows[index * 2].homeSeriesWinProbability - expected[index]) < 1e-14)
      assert.ok(Math.abs(rows[index * 2].homeSeriesWinProbability + rows[index * 2 + 1].homeSeriesWinProbability - 1) < 1e-14)
      assert.deepEqual(rows[index * 2].componentGameProbabilities, Array(index * 2 + 1).fill(p))
    }
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})

test('late raw revisions and changed future outcomes cannot alter an earlier Elo receipt', async () => {
  const f = await fixture()
  try {
    f.requestFile.requests.push({ ...request, seriesId: 'second', asOf: cutoff + 1000 })
    const baseline = await f.export()
    f.files.leaguepediaJson.unshift('future.json')
    const revision = { fetchedAt: new Date(future).toISOString(), matches: f.raw.matches.map(match => ({ ...match, winner: 'T1' })) }
    await writeFile(join(f.directory, 'future.json'), JSON.stringify(revision))
    const late = await f.export()
    assert.deepEqual(late.states, baseline.states)
    assert.equal(late.rows[0].homeSeriesWinProbability, baseline.rows[0].homeSeriesWinProbability)
    revision.matches[0].teamAKills += 100
    await writeFile(join(f.directory, 'future.json'), JSON.stringify(revision))
    assert.deepEqual((await f.export()).states, baseline.states)
    revision.fetchedAt = new Date(capture).toISOString()
    revision.matches = f.raw.matches.map(match => ({ ...match, winner: 'T1' }))
    await writeFile(join(f.directory, 'future.json'), JSON.stringify(revision))
    assert.notEqual((await f.export()).rows[0].homeSeriesWinProbability, baseline.rows[0].homeSeriesWinProbability)
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})

test('late schedule enrichment cannot redefine completed Elo history', async () => {
  const f = await fixture()
  try {
    f.requestFile.requests.push({ ...request, seriesId: 'second', asOf: cutoff + 1000 })
    const baseline = await f.export()
    f.files.lolEsportsJson.push('schedule.json')
    const schedule = { fetchedAt: new Date(future).toISOString(), events: [{
      startTime: `${games[0].date}T00:00:00Z`, state: 'completed', blockName: 'Regular season',
      league: { name: 'LCK', slug: 'lck' }, match: { id: 'changed-format', strategy: { type: 'bestOf', count: 5 },
        teams: [{ name: 'Gen.G' }, { name: 'T1' }] },
    }] }
    await writeFile(join(f.directory, 'schedule.json'), JSON.stringify(schedule))
    assert.deepEqual((await f.export()).states, baseline.states)
    schedule.fetchedAt = new Date(capture).toISOString()
    await writeFile(join(f.directory, 'schedule.json'), JSON.stringify(schedule))
    await assert.rejects(f.export(), /No completed causal Elo history/)
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})

test('future observations inside an admitted capture cannot change earlier Elo state', async () => {
  const f = await fixture()
  try {
    f.requestFile.requests.push({ ...request, seriesId: 'second', asOf: cutoff + 1000 })
    const baseline = await f.export()
    const added = f.raw.matches.map((match, index) => ({ ...match, id: `extra-game-${index + 1}`, sourceGameId: `extra-game-${index + 1}`, sourceMatchId: 'extra-series' }))
    f.raw.matches.push(...added)
    await writeFile(join(f.directory, 'raw.json'), JSON.stringify(f.raw))
    const source = await importRankingSourceData({ leaguepediaJsonPaths: [join(f.directory, 'raw.json')] })
    f.requestFile.observations.push(...source.matches.filter(match => !f.requestFile.observations.some(row => row.gameId === match.id))
      .map(match => ({ gameId: match.id, observedAt: future, resultAvailableAt: capture })))
    assert.deepEqual((await f.export()).states, baseline.states)
    for (const match of added) match.winner = 'T1'
    await writeFile(join(f.directory, 'raw.json'), JSON.stringify(f.raw))
    assert.deepEqual((await f.export()).states, baseline.states)
    for (const row of f.requestFile.observations) row.observedAt = capture
    assert.notEqual((await f.export()).rows[0].homeSeriesWinProbability, baseline.rows[0].homeSeriesWinProbability)
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})

test('Elo rejects transforms, fit provenance, renamed controls and unsupported kinds', async () => {
  const f = await fixture()
  try {
    const original = structuredClone(f.candidate)
    for (const mutation of [
      { candidateId: 'other' }, { parentCandidateId: 'parent' },
      { calibrationFit: { startsAt: 0, endsAt: 1, seriesIds: ['training'] } },
      { transform: { ...original.transform, temperature: 2 } },
      { transform: { ...original.transform, dependence: .1 } },
      { transform: { ...original.transform, calibrationOrder: 'series-after-conversion' as const } },
      { modelKind: 'ranking' as const }, { modelKind: 'unknown' as 'ranking' },
    ]) {
      Object.assign(f.candidate, original, mutation)
      await assert.rejects(f.export(), /Simple Elo|Reserved simple Elo|Unsupported forecast model/)
    }
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})

test('Elo requires captured inputs and does not mark historical-limited state eligible', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.directory, 'raw.json'), JSON.stringify({ matches: f.raw.matches }))
    await assert.rejects(f.export(), /Missing source file capture/)
    f.requestFile.sourceFiles = [{ path: 'raw.json', observedAt: capture,
      sha256: createHash('sha256').update(await readFile(join(f.directory, 'raw.json'))).digest('hex') }]
    assert.equal((await f.export()).rows[0].eligible, true)
    f.requestFile.availability = 'historical-limited'
    const limited = await f.export()
    assert.equal(limited.rows[0].eligible, false)
    assert.deepEqual(limited.rows[0].exclusions, ['historical-availability-not-proven'])
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})


test('Elo batch reuses same-date history, preserves request order and keeps states independent', () => {
  const reverse = { ...request, seriesId: 'reverse', asOf: cutoff + 1000, scheduleObservedAt: cutoff + 500,
    homeTeamId: request.awayTeamId, awayTeamId: request.homeTeamId,
    homeSourceTeam: request.awaySourceTeam, awaySourceTeam: request.homeSourceTeam }
  const targets = [reverse, request, { ...request, seriesId: 'third', bestOf: 5 as const }]
  const independent = targets.map(target => replaySimpleEloSeries(inputs, target, 'verified'))
  const batch = replaySimpleEloSeriesBatch(inputs, targets, 'verified')
  assert.deepEqual(batch.results, independent)
  assert.equal(batch.replayCount, 1)
  assert.equal(batch.replayedGames, 2)
  assert.deepEqual(batch.results[0].sourceObservedAt, [capture, reverse.scheduleObservedAt])
  assert.equal(batch.results[0].state.home.team, request.awaySourceTeam)
  batch.results[1].state.home.rating = 0
  batch.results[1].state.usedGameIds.push('mutated')
  assert.deepEqual(batch.results[2], independent[2])
  assert.deepEqual(replaySimpleEloSeriesBatch(inputs, [], 'verified'), { results: [], replayCount: 0, replayedGames: 0 })
})

test('Elo batch separates cutoff dates and newly available games in both availability modes', () => {
  const late = { match: { ...games[0], id: 'late-game', sourceGameId: 'late-game', sourceMatchId: 'late-series', bestOf: 1 as const, winner: 'T1' },
    observedAt: cutoff + 500, resultAvailableAt: cutoff + 500 }
  const later = { ...request, seriesId: 'later', asOf: cutoff + 1000 }
  const nextDay = { ...request, seriesId: 'next-day', asOf: cutoff + 86400000,
    validUntil: request.validUntil + 86400000, scheduledStartAt: request.scheduledStartAt + 86400000 }
  const targets = [nextDay, later, request, { ...request, seriesId: 'repeat' }]
  for (const availability of ['verified', 'historical-limited'] as const) {
    const all = [...inputs, late]
    const batch = replaySimpleEloSeriesBatch(all, targets, availability)
    assert.deepEqual(batch.results, targets.map(target => replaySimpleEloSeries(all, target, availability)))
    assert.equal(batch.replayCount, 3)
    assert.equal(batch.replayedGames, 8)
    assert.notEqual(batch.results[1].state.home.rating, batch.results[2].state.home.rating)
  }
})

test('Elo batch validates every request and input, and counts incomplete games actually replayed', () => {
  assert.throws(() => replaySimpleEloSeriesBatch([...inputs, inputs[0]], [request], 'verified'), /Duplicate Elo input/)
  assert.throws(() => replaySimpleEloSeriesBatch(inputs, [request, { ...request, scheduleObservedAt: cutoff + 1 }], 'verified'), /Invalid explicit Elo/)
  assert.throws(() => replaySimpleEloSeriesBatch(inputs, [request, { ...request, homeSourceTeam: 'Missing' }], 'verified'), /No completed causal Elo history/)
  assert.throws(() => replaySimpleEloSeriesBatch([{ ...inputs[0], observedAt: -1 }], [request], 'verified'), /Missing or invalid Elo source/)
  const incomplete = { ...inputs[0], match: { ...games[0], id: 'incomplete', sourceMatchId: 'incomplete' } }
  const batch = replaySimpleEloSeriesBatch([...inputs, incomplete], [request, request], 'verified')
  assert.equal(batch.replayCount, 1)
  assert.equal(batch.replayedGames, 3)
  assert.deepEqual(batch.results[0], replaySimpleEloSeries(inputs, request, 'verified'))
})

test('Elo batch cannot retain a later outcome across calls or expose it before observation', () => {
  const late = { match: { ...games[0], id: 'late-game', sourceGameId: 'late-game', sourceMatchId: 'late-series', bestOf: 1 as const },
    observedAt: cutoff + 500, resultAvailableAt: capture }
  const targets = [request, { ...request, seriesId: 'later', asOf: cutoff + 1000 }]
  const all = [...inputs, late]
  const before = replaySimpleEloSeriesBatch(all, targets, 'verified')
  late.match.winner = 'T1'
  const after = replaySimpleEloSeriesBatch(all, targets, 'verified')
  assert.deepEqual(after.results[0], before.results[0])
  assert.notEqual(after.results[1].state.home.rating, before.results[1].state.home.rating)
  assert.deepEqual(after.results, targets.map(target => replaySimpleEloSeries(all, target, 'verified')))
})

test('real Elo batch CLI reports one replay and matches each independent state and probability', async () => {
  const f = await fixture()
  try {
    const targets = [
      { ...request, seriesId: 'reverse', asOf: cutoff + 1000, scheduleObservedAt: cutoff + 500,
        homeTeamId: request.awayTeamId, awayTeamId: request.homeTeamId,
        homeSourceTeam: request.awaySourceTeam, awaySourceTeam: request.homeSourceTeam },
      { ...request }, { ...request, seriesId: 'five', bestOf: 5 as const },
    ]
    f.requestFile.requests = targets
    const batch = await f.export(true)
    assert.equal(batch.manifest.replayCount, 1)
    assert.equal(batch.manifest.replayedGames, 2)
    assert.deepEqual(batch.rows.map(row => row.seriesId), targets.map(target => target.seriesId))
    for (const [index, target] of targets.entries()) {
      f.requestFile.requests = [target]
      const independent = await f.export()
      assert.equal(independent.manifest.replayCount, 1)
      assert.deepEqual(batch.states[index], independent.states[0])
      assert.equal(batch.rows[index].homeSeriesWinProbability, independent.rows[0].homeSeriesWinProbability)
      assert.deepEqual(batch.rows[index].componentGameProbabilities, independent.rows[0].componentGameProbabilities)
      assert.deepEqual(batch.rows[index].sourceObservedAt, independent.rows[0].sourceObservedAt)
    }
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})
