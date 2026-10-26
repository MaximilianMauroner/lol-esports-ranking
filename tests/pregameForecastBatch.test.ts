import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportPregameSeries } from '../scripts/rankings/export-pregame-series.ts'
import { importRankingSourceData } from '../scripts/rankings/source-input.ts'
import test from 'node:test'
import { predictPregameSeries, replayPregameSeriesBatch, replayPregameSeriesState } from '../src/domains/rankings/forecast.ts'
import type { AvailableRankingGame, PregameForecastInput, PregameSeriesRequest } from '../src/domains/rankings/forecast.ts'
import { rosters, sampleMatches } from './fixtures/rankingFixtures.ts'

const cutoff = Date.parse('2026-02-10T10:00:00Z')
const request: PregameSeriesRequest = {
  seriesId: 'batch-series', eventId: 'batch-event', homeTeamId: 'gen', awayTeamId: 't1',
  homeSourceTeam: 'Gen.G', awaySourceTeam: 'T1', bestOf: 3, scheduleRevision: 'revision-1',
  scheduledStartAt: cutoff + 7200_000, scheduleObservedAt: cutoff - 1000, scheduleProvider: 'lolesports-schedule',
  asOf: cutoff, validUntil: cutoff + 7000_000, event: 'LCK 2026 Spring', patch: '26.1', season: 2026,
  league: 'LCK', region: 'LCK', tier: 'regional-regular',
}
const history: AvailableRankingGame[] = sampleMatches.slice(0, 2).map((match, index) => ({
  match: { ...match, id: `batch-game-${index}`, sourceProvider: 'leaguepedia-cargo', sourceGameId: `source-game-${index}` },
  observedAt: Date.parse(match.date) + 3600_000, resultAvailableAt: Date.parse(match.date) + 3600_000,
}))
const stateHash = (replay: ReturnType<typeof replayPregameSeriesState>) => createHash('sha256')
  .update(JSON.stringify({ ...replay.state, usedGameIds: replay.usedGameIds })).digest('hex')

function at(asOf: number): PregameSeriesRequest {
  return { ...request, asOf, scheduledStartAt: asOf + 7200_000, validUntil: asOf + 7000_000, scheduleObservedAt: asOf - 1000 }
}

test('batch preserves full state, hashes and receipts across request-specific boundaries', async () => {
  const fixture: PregameForecastInput = JSON.parse(await readFile('tests/fixtures/pregameForecastInput.json', 'utf8'))
  const requests = [
    { ...request, patch: '26.2', event: 'LCK 2026 Summer', season: 2027 },
    { ...request, bestOf: 5 as const, homeSourceTeam: 'T1', awaySourceTeam: 'Gen.G' },
    request,
    { ...request, bestOf: 1 as const, scheduleObservedAt: cutoff - 2000 },
  ]
  const before = structuredClone(history)
  const batch = replayPregameSeriesBatch(history, requests, 'verified')
  assert.deepEqual(history, before)
  assert.equal(batch.replayCount, 1)
  assert.equal(batch.replayedGames, history.length)
  for (const [index, target] of requests.entries()) {
    const single = replayPregameSeriesState(history, target, 'verified')
    assert.deepEqual(batch.results[index], single)
    assert.equal(stateHash(batch.results[index]), stateHash(single))
    const receipt = (replay: typeof single) => predictPregameSeries({ ...fixture, state: replay.state, metadata: {
      ...fixture.metadata, asOf: target.asOf, generatedAt: target.asOf, validUntil: target.validUntil,
      scheduledStartAt: target.scheduledStartAt, bestOf: target.bestOf, sourceObservedAt: replay.sourceObservedAt,
      modelStateHash: stateHash(replay), modelStateId: `prior-date:${stateHash(replay)}`,
    } })
    assert.deepEqual(receipt(batch.results[index]), receipt(single))
  }
  batch.results[0].usedGameIds.push('consumer-edit')
  batch.results[0].state.home.rating = 0
  assert.deepEqual(batch.results[2], replayPregameSeriesState(history, request, 'verified'))
})

test('same-date availability changes and UTC boundaries rebuild while input order is preserved', () => {
  const delayed: AvailableRankingGame = { ...history[0], match: { ...history[0].match, id: 'delayed', date: '2026-02-09', winner: 'T1' },
    observedAt: cutoff + 1000, resultAvailableAt: cutoff - 1000 }
  const inputs = [...history, delayed]
  const requests = [at(cutoff + 86400_000), at(cutoff + 1000), request, at(cutoff + 500)]
  const batch = replayPregameSeriesBatch(inputs, requests, 'verified')
  assert.deepEqual(batch.results, requests.map(row => replayPregameSeriesState(inputs, row, 'verified')))
  assert.equal(batch.replayCount, 3)
  assert.equal(batch.replayedGames, 8)
  assert.equal(batch.results[2].usedGameIds.includes('delayed'), false)
  assert.equal(batch.results[1].usedGameIds.includes('delayed'), true)
  const changedResultTime = inputs.map(row => row.match.id === 'delayed' ? { ...row, resultAvailableAt: cutoff + 1000 } : row)
  assert.deepEqual(replayPregameSeriesBatch(changedResultTime, requests, 'verified').results, batch.results)
})

test('future and unavailable outcomes cannot alter earlier states or probabilities', async () => {
  const fixture: PregameForecastInput = JSON.parse(await readFile('tests/fixtures/pregameForecastInput.json', 'utf8'))
  const inputs = [...history,
    { ...history[0], match: { ...history[0].match, id: 'same-date', date: '2026-02-10' }, observedAt: cutoff - 1000, resultAvailableAt: cutoff - 1000 },
    { ...history[0], match: { ...history[0].match, id: 'future', date: '2026-02-11' }, observedAt: cutoff + 2 * 86400_000, resultAvailableAt: cutoff + 2 * 86400_000 },
    { ...history[0], match: { ...history[0].match, id: 'unavailable', date: '2026-02-09' }, observedAt: cutoff + 1000, resultAvailableAt: cutoff + 1000 },
  ]
  const baseline = replayPregameSeriesBatch(inputs, [request, request], 'verified')
  for (const row of inputs.slice(2)) { row.match.winner = 'T1'; row.match.teamAKills = 100; row.match.patch = '99.99' }
  const changed = replayPregameSeriesBatch(inputs, [request, request], 'verified')
  assert.deepEqual(changed, baseline)
  assert.deepEqual(changed.results[0], replayPregameSeriesState(history, request, 'verified'))
  assert.equal(predictPregameSeries({ ...fixture, state: changed.results[0].state }).homeSeriesWinProbability,
    predictPregameSeries({ ...fixture, state: baseline.results[0].state }).homeSeriesWinProbability)
})

test('each batch rebuilds changed inputs and candidate receipts use their own transform', async () => {
  const fixture: PregameForecastInput = JSON.parse(await readFile('tests/fixtures/pregameForecastInput.json', 'utf8'))
  const inputs = structuredClone(history)
  const first = replayPregameSeriesBatch(inputs, [request], 'verified')
  inputs[0].match.winner = 'T1'
  const second = replayPregameSeriesBatch(inputs, [request], 'verified')
  assert.equal(second.replayCount, 1)
  assert.notEqual(stateHash(first.results[0]), stateHash(second.results[0]))
  assert.deepEqual(second.results[0], replayPregameSeriesState(inputs, request, 'verified'))
  const state = second.results[0].state
  const baseline = predictPregameSeries({ ...fixture, state })
  const candidate = predictPregameSeries({ ...fixture, state, transform: { ...fixture.transform, temperature: 2 }, metadata: {
    ...fixture.metadata, candidateId: 'candidate-2', calibrationFit: { startsAt: 0, endsAt: 1, seriesIds: ['earlier-series'] },
  } })
  assert.notEqual(candidate.homeSeriesWinProbability, baseline.homeSeriesWinProbability)
  assert.equal(candidate.candidateId, 'candidate-2')
})

test('historical-limited observations preserve eligibility and validation rejects bad evidence', async () => {
  const fixture: PregameForecastInput = JSON.parse(await readFile('tests/fixtures/pregameForecastInput.json', 'utf8'))
  const inputs = history.map(row => ({ ...row, resultAvailableAt: null, observedAt: cutoff + 1000 }))
  const batch = replayPregameSeriesBatch(inputs, [request, at(cutoff + 500)], 'historical-limited')
  assert.equal(batch.replayCount, 1)
  assert.deepEqual(batch.results[0], replayPregameSeriesState(inputs, request, 'historical-limited'))
  const receipt = predictPregameSeries({ ...fixture, state: batch.results[0].state, metadata: {
    ...fixture.metadata, availability: 'historical-limited', evidenceMode: 'retrospective',
    generatedAt: cutoff + 2000, sourceObservedAt: batch.results[0].sourceObservedAt,
  } })
  assert.equal(receipt.eligible, false)
  assert.deepEqual(receipt.exclusions, ['historical-availability-not-proven'])
  assert.throws(() => replayPregameSeriesBatch(inputs, [request], 'verified'), /No available/)
  assert.throws(() => replayPregameSeriesBatch([...history, history[0]], [request], 'verified'), /Duplicate/)
  assert.throws(() => replayPregameSeriesBatch(history, [{ ...request, scheduleObservedAt: cutoff + 1 }], 'verified'), /Schedule unavailable/)
  assert.throws(() => replayPregameSeriesBatch([{ ...history[0], match: { ...history[0].match, sourceProvider: 'seed' } }], [request], 'verified'), /provenance/)
  assert.deepEqual(replayPregameSeriesBatch(history, [], 'verified'), { results: [], replayCount: 0, replayedGames: 0 })
})

test('export batches same-date requests and does not reuse previous candidate or source results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pregame-batch-'))
  try {
    const manifestPath = join(directory, 'manifest.json')
    const rawPath = join(directory, 'raw.json')
    const requestsPath = join(directory, 'requests.json')
    const candidatePath = join(directory, 'candidate.json')
    const raw = { fetchedAt: '2026-02-09T00:00:00Z', matches: structuredClone(history.map(row => row.match)) }
    await writeFile(rawPath, JSON.stringify(raw))
    await writeFile(manifestPath, JSON.stringify({ generatedAt: raw.fetchedAt, files: { leaguepediaJson: ['raw.json'] } }))
    const source = await importRankingSourceData({ manifestPath })
    const inputs = source.matches.map(match => ({ match, observedAt: Date.parse(match.date) + 3600_000, resultAvailableAt: Date.parse(match.date) + 3600_000 }))
    const requests = [request, { ...request, seriesId: 'another-series', bestOf: 5 }]
    await writeFile(requestsPath, JSON.stringify({ evidenceMode: 'synthetic', availability: 'verified', requests,
      observations: inputs.map(row => ({ gameId: row.match.id, observedAt: row.observedAt, resultAvailableAt: row.resultAvailableAt })) }))
    const candidate = { candidateId: 'first', parentCandidateId: null, calibrationFit: null,
      transform: { temperature: 1, calibrationOrder: 'game-before-series', dependence: 0 } }
    await writeFile(candidatePath, JSON.stringify(candidate))
    const output = join(directory, 'first.jsonl')
    const first = await exportPregameSeries(manifestPath, requestsPath, candidatePath, output)
    const manifest = JSON.parse(await readFile(`${output}.manifest.json`, 'utf8'))
    assert.equal(manifest.replayCount, 1)
    assert.equal(manifest.replayedGames, source.matches.length)
    assert.deepEqual(first.map(row => row.seriesId), requests.map(row => row.seriesId))
    const expected = replayPregameSeriesState(inputs, request, 'verified')
    assert.equal(first[0].modelStateHash, stateHash(expected))
    assert.deepEqual(first[0].sourceObservedAt, [...new Set([...expected.sourceObservedAt, Date.parse(raw.fetchedAt)])].sort((a, b) => a - b))
    assert.equal(first[0].sideAssumption, 'neutral')
    assert.equal(first[0].lineupAssumption, 'prior-observed-roster')
    await writeFile(candidatePath, JSON.stringify({ ...candidate, candidateId: 'second',
      transform: { ...candidate.transform, temperature: 2 }, calibrationFit: { startsAt: 0, endsAt: 1, seriesIds: ['fit-series'] } }))
    const second = await exportPregameSeries(manifestPath, requestsPath, candidatePath, join(directory, 'second.jsonl'))
    assert.equal(second[0].candidateId, 'second')
    assert.equal(second[0].modelStateHash, first[0].modelStateHash)
    assert.notEqual(second[0].configurationHash, first[0].configurationHash)
    assert.notEqual(second[0].homeSeriesWinProbability, first[0].homeSeriesWinProbability)
    raw.matches[0].winner = 'T1'
    await writeFile(rawPath, JSON.stringify(raw))
    const changed = await exportPregameSeries(manifestPath, requestsPath, candidatePath, join(directory, 'changed.jsonl'))
    assert.notEqual(changed[0].modelStateHash, second[0].modelStateHash)
    assert.notEqual(changed[0].inputDigests.find(row => row.path === rawPath)?.sha256, second[0].inputDigests.find(row => row.path === rawPath)?.sha256)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})


test('shared history preserves observed rosters and cross-league priors', () => {
  const inputs: AvailableRankingGame[] = history.map(row => ({ ...row, match: { ...row.match,
    teamARoster: { sourceProvider: 'oracles-elixir', observedAt: row.match.date, completeness: 'complete-five-role', players: rosters[row.match.teamA] },
    teamBRoster: { sourceProvider: 'oracles-elixir', observedAt: row.match.date, completeness: 'complete-five-role', players: rosters[row.match.teamB] },
  } }))
  inputs.push({ match: { ...sampleMatches[2], sourceProvider: 'leaguepedia-cargo', sourceGameId: 'lec-history' },
    observedAt: Date.parse('2026-02-02'), resultAvailableAt: Date.parse('2026-02-02') })
  const requests: PregameSeriesRequest[] = [
    { ...request, awaySourceTeam: 'G2 Esports', awayTeamId: 'g2', league: 'MSI', region: 'International', event: 'MSI 2026', tier: 'msi-bracket' },
    request,
    { ...request, homeSourceTeam: 'Fnatic', homeTeamId: 'fnatic' },
  ]
  const batch = replayPregameSeriesBatch(inputs, requests, 'verified')
  assert.equal(batch.replayCount, 1)
  assert.deepEqual(batch.results, requests.map(row => replayPregameSeriesState(inputs, row, 'verified')))
})
