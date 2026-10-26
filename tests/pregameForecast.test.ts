import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { predictPregameSeries, replayPregameSeriesState, seriesWinnerProbability, temperatureProbability } from '../src/domains/rankings/forecast.ts'
import type { AvailableRankingGame, PregameForecastInput, PregameSeriesRequest } from '../src/domains/rankings/forecast.ts'
import { neutralWinProbability, seriesWinProbability } from '../src/domains/rankings/internal/queries/winProbability.ts'
import { seriesPathLikelihood } from '../tools/calibration/lib/ranking-experiments.ts'
import { fitSeriesForecast } from '../tools/calibration/lib/fit-series-forecast.ts'
import { sampleMatches } from './fixtures/rankingFixtures.ts'
import { importRankingSourceData } from '../scripts/rankings/source-input.ts'
import { exportPregameSeries } from '../scripts/rankings/export-pregame-series.ts'

const hash = 'a'.repeat(64)
const asOf = Date.parse('2026-02-10T10:00:00Z')
const input: PregameForecastInput = {
  state: { precision: 'full', policy: 'prior-date', throughDate: '2026-02-09',
    home: { team: 'Gen.G', rating: 1612.123456789, uncertainty: 64.7654321, games: 20 },
    away: { team: 'T1', rating: 1507.987654321, uncertainty: 72.1234567, games: 18 } },
  transform: { temperature: 1, calibrationOrder: 'game-before-series', dependence: 0 },
  metadata: { candidateId: 'baseline', parentCandidateId: null, modelCommit: 'fixture', sourceHash: hash,
    configurationHash: hash, dependencyLockHash: hash, seriesId: 'fixture-series', eventId: 'fixture-event',
    homeTeamId: 'fixture-gen', awayTeamId: 'fixture-t1', bestOf: 3, scheduleRevision: 'fixture-schedule-1',
    scheduledStartAt: asOf + 3600_000, sideAssumption: 'neutral', lineupAssumption: 'prior-observed-roster',
    modelStateId: 'fixture-state', modelStateHash: hash, inputManifestHash: hash,
    inputDigests: [{ path: 'synthetic.json', sha256: hash }], generatedAt: asOf, asOf, validUntil: asOf + 1800_000,
    sourceObservedAt: [asOf - 1000], calibrationFit: null, evidenceMode: 'synthetic', availability: 'verified' },
}

const request: PregameSeriesRequest = {
  seriesId: 'fixture-series', eventId: 'fixture-event', homeTeamId: 'fixture-gen', awayTeamId: 'fixture-t1',
  homeSourceTeam: 'Gen.G', awaySourceTeam: 'T1', bestOf: 3, scheduleRevision: 'fixture-schedule-1',
  scheduledStartAt: asOf + 3600_000, scheduleObservedAt: asOf - 1000, scheduleProvider: 'lolesports-schedule',
  asOf, validUntil: asOf + 1800_000, event: 'LCK 2026 Spring', patch: '26.1', season: 2026, league: 'LCK', region: 'LCK', tier: 'regional-regular',
}
const history: AvailableRankingGame[] = sampleMatches.slice(0, 2).map((match, index) => ({
  match: { ...match, id: `real-shape-${index}`, sourceProvider: 'leaguepedia-cargo', sourceGameId: `game-${index}` },
  observedAt: Date.parse(match.date) + 3600_000, resultAvailableAt: Date.parse(match.date) + 3600_000,
}))

test('strict forecast preserves full precision and matches unchanged replay within its publication rounding', () => {
  for (const bestOf of [1, 3, 5] as const) {
    const result = predictPregameSeries({ ...input, metadata: { ...input.metadata, bestOf } })
    const baseline = neutralWinProbability(input.state.home, input.state.away, bestOf)
    assert.ok(Math.abs(result.componentGameProbabilities[0] - baseline.teamAGameWinProbability) <= .00005)
    assert.ok(Math.abs(result.homeSeriesWinProbability - baseline.teamASeriesWinProbability) <= .00005)
    assert.equal(result.homeSeriesWinProbability + result.awaySeriesWinProbability, 1)
    assert.equal(result.eligible, true)
  }
})

test('temperature identity and team complement symmetry include endpoints', () => {
  for (const p of [0, .01, .3, .5, .9, 1]) {
    assert.equal(temperatureProbability(p, 1), p)
    for (const t of [.5, 1.5, 3]) assert.ok(Math.abs(temperatureProbability(p, t) + temperatureProbability(1 - p, t) - 1) < 1e-12)
  }
  assert.throws(() => temperatureProbability(.5, 0))
})

test('forward dependence equals summed legal stopping-path likelihoods', () => {
  for (const bestOf of [1, 3, 5] as const) for (const dependence of [0, .7, 2]) {
    const probabilities = Array.from({ length: bestOf }, (_, i) => .52 + i * .06)
    let home = 0
    let total = 0
    const visit = (path: Array<0 | 1>) => {
      if (path.length) {
        const likelihood = seriesPathLikelihood(path, probabilities.slice(0, path.length), bestOf, dependence)
        if (likelihood.complete) {
          total += likelihood.likelihood
          if (path.filter(Boolean).length > path.length / 2) home += likelihood.likelihood
          return
        }
      }
      visit([...path, 0]); visit([...path, 1])
    }
    visit([])
    assert.ok(Math.abs(total - 1) < 1e-12)
    assert.ok(Math.abs(home - seriesWinnerProbability(probabilities, bestOf, dependence)) < 1e-12)
    assert.ok(Math.abs(home + seriesWinnerProbability(probabilities.map(p => 1 - p), bestOf, dependence) - 1) < 1e-12)
    assert.ok(Math.abs(seriesWinnerProbability(Array<number>(bestOf).fill(.63), bestOf, 0) - seriesWinProbability(.63, bestOf)) < 1e-12)
  }
})

test('strict forecast rejects missing state, unsupported formats and future evidence', () => {
  assert.throws(() => predictPregameSeries({ ...input, state: { ...input.state, home: { ...input.state.home, games: 0 } } }))
  assert.throws(() => predictPregameSeries({ ...input, metadata: { ...input.metadata, bestOf: 2 as 3 } }))
  assert.throws(() => predictPregameSeries({ ...input, state: { ...input.state, throughDate: '2026-02-10' } }))
  assert.throws(() => predictPregameSeries({ ...input, metadata: { ...input.metadata, sourceObservedAt: [asOf + 1] } }))
  assert.throws(() => predictPregameSeries({ ...input, transform: { ...input.transform, temperature: 1.2 } }))
  assert.throws(() => predictPregameSeries({ ...input, metadata: { ...input.metadata, evidenceMode: 'prospective', generatedAt: asOf + 1800_000 } }))
  const historical = predictPregameSeries({ ...input, metadata: { ...input.metadata, evidenceMode: 'retrospective', availability: 'historical-limited', generatedAt: asOf + 10000, sourceObservedAt: [asOf + 9999] } })
  assert.equal(historical.eligible, false)
  assert.deepEqual(historical.exclusions, ['historical-availability-not-proven'])
})

test('source adapter ignores unavailable outcomes and future corrections and rejects seed fallbacks', () => {
  const baseline = replayPregameSeriesState(history, request, 'verified')
  const future: AvailableRankingGame = { match: { ...history[0].match, id: 'future', date: '2026-02-11', winner: 'T1' }, observedAt: asOf + 86400_000, resultAvailableAt: asOf + 86400_000 }
  assert.deepEqual(replayPregameSeriesState([...history, future], request, 'verified'), baseline)
  const unavailable: AvailableRankingGame = { ...future, match: { ...future.match, date: '2026-02-09' } }
  assert.deepEqual(replayPregameSeriesState([...history, unavailable], request, 'verified'), baseline)
  assert.throws(() => replayPregameSeriesState([{ ...history[0], match: { ...history[0].match, sourceProvider: 'seed' } }], request, 'verified'))
  assert.throws(() => replayPregameSeriesState(history, { ...request, homeSourceTeam: 'Unknown' }, 'verified'))
  assert.throws(() => replayPregameSeriesState(history, { ...request, scheduleObservedAt: asOf + 1 }, 'verified'))
  assert.equal(baseline.state.home.games, 2)
  const receipt = predictPregameSeries({ ...input, state: baseline.state })
  assert.equal(receipt.componentGameProbabilities.length, 3)
})

test('bounded calibration uses earlier complete series and withholds crossing events', () => {
  const rows = [0, 1, 2].map(i => ({ seriesId: `s${i}`, eventId: `e${i}`, startsAt: 100 + i * 10, resultAvailableAt: 105 + i * 10,
    bestOf: 3 as const, winsHome: i === 2 ? 0 : 2, winsAway: i === 2 ? 2 : 0, gameProbability: .8 }))
  const grid = { temperatures: [1, 1.5], dependences: [0, .7], calibrationOrder: 'game-before-series' as const }
  const fit = fitSeriesForecast(rows, 200, grid)
  assert.deepEqual(fit, fitSeriesForecast(rows, 200, grid))
  assert.equal(fit.candidates.length, 4)
  assert.ok(fit.calibrationFit.endsAt < 200)
  assert.throws(() => fitSeriesForecast(rows, 125, grid))
  assert.throws(() => fitSeriesForecast(rows, 200, grid, ['e1']))
  assert.throws(() => fitSeriesForecast([{ ...rows[0], winsHome: 1, winsAway: 0 }], 200, grid))
})

test('dependence fits the complete score even when winner loss prefers independence', () => {
  const rows = [{ seriesId: 'sweep', eventId: 'event', startsAt: 100, resultAvailableAt: 110,
    bestOf: 3 as const, winsHome: 2, winsAway: 0, gameProbability: .6 }]
  for (const calibrationOrder of ['game-before-series', 'series-after-conversion'] as const) {
    const fit = fitSeriesForecast(rows, 200, { temperatures: [1], dependences: [0, 1, 3], calibrationOrder })
    assert.equal(fit.transform.dependence, 3)
    const independent = fit.candidates.find(candidate => candidate.transform.dependence === 0)!
    const fitted = fit.candidates.find(candidate => candidate.transform.dependence === 3)!
    assert.ok(fitted.meanScoreLogLoss < independent.meanScoreLogLoss)
    assert.ok(fitted.meanWinnerLogLoss > independent.meanWinnerLogLoss)
  }
})

test('offline CLI exports actual hashes and exact states without backdating generatedAt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pregame-export-'))
  try {
    const raw = join(dir, 'raw.json')
    const manifest = join(dir, 'manifest.json')
    const requests = join(dir, 'requests.json')
    const candidate = join(dir, 'candidate.json')
    const output = join(dir, 'forecasts.jsonl')
    await writeFile(raw, JSON.stringify({ fetchedAt: '2026-02-09T00:00:00Z', matches: history.map(row => row.match) }))
    await writeFile(manifest, JSON.stringify({ generatedAt: '2026-02-09T00:00:00Z', files: { leaguepediaJson: ['raw.json'] } }))
    const source = await importRankingSourceData({ manifestPath: manifest })
    assert.ok(source.matches.length)
    await writeFile(requests, JSON.stringify({ evidenceMode: 'synthetic', availability: 'verified', requests: [request],
      observations: source.matches.map(match => ({ gameId: match.id, observedAt: Date.parse(match.date) + 3600_000, resultAvailableAt: Date.parse(match.date) + 3600_000 })) }))
    await writeFile(candidate, JSON.stringify({ candidateId: 'synthetic-baseline', parentCandidateId: null, transform: input.transform, calibrationFit: null }))
    const before = Date.now()
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/rankings/export-pregame-series.ts', manifest, requests, candidate, output], { encoding: 'utf8' })
    assert.equal(JSON.parse(stdout).exported, 1)
    const receipt = JSON.parse((await readFile(output, 'utf8')).trim())
    assert.ok(receipt.generatedAt >= before && receipt.generatedAt <= Date.now())
    assert.equal(receipt.inputDigests.find((item: { path: string }) => item.path === raw).sha256, createHash('sha256').update(await readFile(raw)).digest('hex'))
    assert.equal(receipt.dependencyLockHash, createHash('sha256').update(await readFile('pnpm-lock.yaml')).digest('hex'))
    const state = JSON.parse((await readFile(`${output}.states.jsonl`, 'utf8')).trim())
    assert.equal(receipt.modelStateHash, createHash('sha256').update(JSON.stringify(state.state)).digest('hex'))
    const direct = predictPregameSeries({ state: state.state, transform: input.transform, metadata: receipt })
    assert.equal(receipt.homeSeriesWinProbability, direct.homeSeriesWinProbability)
    await assert.rejects(exportPregameSeries(manifest, requests, candidate, output), /EEXIST/)
    const protocol = join(dir, 'protocol.json')
    await writeFile(protocol, JSON.stringify({ seed: 123, maximumJointFitTrials: 6, maximumRuntimeMs: 60000,
      folds: [{ fitThrough: '2026-01-20', validateThrough: '2026-02-11' }] }))
    const searchDir = join(dir, 'search')
    execFileSync(process.execPath, ['--import', 'tsx', 'tools/calibration/search-ranking-model.ts', manifest, protocol, searchDir, requests], { encoding: 'utf8', timeout: 60000 })
    const trial = JSON.parse((await readFile(join(searchDir, 'forecasts-0.jsonl'), 'utf8')).trim())
    assert.equal(trial.homeSeriesWinProbability, receipt.homeSeriesWinProbability)
    const search = JSON.parse(await readFile(join(searchDir, 'report.json'), 'utf8'))
    assert.equal(search.trials.length, 6)
    assert.deepEqual(search.selection, [])
    assert.match(search.forecastSelection, /^not-performed/)
    assert.ok(search.trials.every((value: { forecastHash: string }) => /^[a-f0-9]{64}$/.test(value.forecastHash)))
    const beforeResume = await readFile(join(searchDir, 'forecasts-0.jsonl'), 'utf8')
    execFileSync(process.execPath, ['--import', 'tsx', 'tools/calibration/search-ranking-model.ts', manifest, protocol, searchDir, requests], { encoding: 'utf8', timeout: 60000 })
    assert.equal(await readFile(join(searchDir, 'forecasts-0.jsonl'), 'utf8'), beforeResume)

  } finally { await rm(dir, { recursive: true, force: true }) }
})


test('shared synthetic receipt remains the direct pure-predictor result', async () => {
  const fixture = JSON.parse(await readFile('tests/fixtures/pregameForecastInput.json', 'utf8'))
  const receipt = JSON.parse(await readFile('tests/fixtures/pregameForecastReceipt.json', 'utf8'))
  assert.deepEqual(predictPregameSeries(fixture), receipt)
})
