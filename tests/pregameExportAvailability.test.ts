import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { exportPregameSeries } from '../scripts/rankings/export-pregame-series.ts'
import type { ForecastRequestFile } from '../scripts/rankings/export-pregame-series.ts'
import { importRankingSourceData } from '../scripts/rankings/source-input.ts'
import { sampleMatches } from './fixtures/rankingFixtures.ts'

const cutoff = Date.parse('2026-02-10T10:00:00Z')
const capture = '2026-02-09T00:00:00Z'
const future = '2026-03-01T00:00:00Z'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pregame-availability-'))
  const manifest = join(directory, 'manifest.json')
  const requests = join(directory, 'requests.json')
  const candidate = join(directory, 'candidate.json')
  const raw = { fetchedAt: capture, matches: sampleMatches.slice(0, 2).map((match, index) => ({ ...match,
    id: `availability-${index}`, bestOf: 1 })) }
  const files = { leaguepediaJson: ['raw.json'], lolEsportsJson: [] as string[], oracleCsv: [] as string[] }
  await writeFile(join(directory, 'raw.json'), JSON.stringify(raw))
  await writeFile(manifest, JSON.stringify({ files }))
  const source = await importRankingSourceData({ manifestPath: manifest })
  const requestFile: ForecastRequestFile = { evidenceMode: 'synthetic', availability: 'verified',
    observations: source.matches.map(match => ({ gameId: match.id, observedAt: Date.parse(match.date) + 3600_000,
      resultAvailableAt: Date.parse(match.date) + 3600_000 })), requests: [{
      seriesId: 'availability-series', eventId: 'availability-event', homeTeamId: 'gen', awayTeamId: 't1',
      homeSourceTeam: 'Gen.G', awaySourceTeam: 'T1', bestOf: 3, scheduleRevision: 'revision-1',
      scheduledStartAt: cutoff + 7200_000, scheduleObservedAt: cutoff - 1000, scheduleProvider: 'lolesports-schedule',
      asOf: cutoff, validUntil: cutoff + 7000_000, event: 'LCK 2026 Spring', patch: '26.1', season: 2026,
      league: 'LCK', region: 'LCK', tier: 'regional-regular',
    }] }
  await writeFile(candidate, JSON.stringify({ candidateId: 'availability', parentCandidateId: null,
    calibrationFit: null, transform: { temperature: 1, calibrationOrder: 'game-before-series', dependence: 0 } }))
  let run = 0
  return { directory, raw, files, requestFile, async export() {
    await writeFile(manifest, JSON.stringify({ files }))
    await writeFile(requests, JSON.stringify(requestFile))
    const output = join(directory, `forecast-${run++}.jsonl`)
    const receipts = await exportPregameSeries(manifest, requests, candidate, output)
    return { receipts, states: await readFile(`${output}.states.jsonl`, 'utf8') }
  } }
}

test('late official enrichment cannot change earlier eligible probabilities or exact states', async () => {
  const f = await fixture()
  try {
    const baseline = await f.export()
    const references = { fetchedAt: future, events: f.raw.matches.map((match, index) => ({
      startTime: `${match.date}T00:00:00Z`, state: 'completed', blockName: 'Playoffs',
      league: { name: 'LCK', slug: 'lck' }, match: { id: `official-${index}`, strategy: { type: 'bestOf', count: 5 },
        teams: [{ name: match.teamA }, { name: match.teamB }] },
    })) }
    f.files.lolEsportsJson.push('reference.json')
    await writeFile(join(f.directory, 'reference.json'), JSON.stringify(references))
    const late = await f.export()
    assert.equal(late.states, baseline.states)
    assert.equal(late.receipts[0].eligible, true)
    assert.equal(late.receipts[0].homeSeriesWinProbability, baseline.receipts[0].homeSeriesWinProbability)
    assert.deepEqual(late.receipts[0].sourceObservedAt, baseline.receipts[0].sourceObservedAt)
    assert.ok(late.receipts[0].sourceObservedAt.includes(Date.parse(capture)))
    references.fetchedAt = capture
    await writeFile(join(f.directory, 'reference.json'), JSON.stringify(references))
    const available = await f.export()
    assert.notEqual(available.states, baseline.states)
    assert.notEqual(available.receipts[0].homeSeriesWinProbability, baseline.receipts[0].homeSeriesWinProbability)
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})

test('future raw revisions are filtered before duplicate selection and retain batch order', async () => {
  const f = await fixture()
  try {
    const baseline = await f.export()
    const revision = { fetchedAt: future, matches: f.raw.matches.map(match => ({ ...match,
      winner: match.winner === match.teamA ? match.teamB : match.teamA, bestOf: 5 })) }
    await writeFile(join(f.directory, 'revision.json'), JSON.stringify(revision))
    f.files.leaguepediaJson.unshift('revision.json')
    const later = Date.parse('2026-03-02T10:00:00Z')
    const request = f.requestFile.requests[0]
    f.requestFile.requests.unshift({ ...request, seriesId: 'later-series', asOf: later,
      scheduleObservedAt: later - 1000, scheduledStartAt: later + 7200_000, validUntil: later + 7000_000 })
    const result = await f.export()
    assert.equal(result.states.trim().split('\n')[1], baseline.states.trim())
    assert.equal(result.receipts[1].homeSeriesWinProbability, baseline.receipts[0].homeSeriesWinProbability)
    assert.notEqual(result.receipts[0].modelStateHash, baseline.receipts[0].modelStateHash)
    assert.ok(result.receipts[0].sourceObservedAt.includes(Date.parse(future)))
    revision.matches[0].teamAKills += 20
    await writeFile(join(f.directory, 'revision.json'), JSON.stringify(revision))
    const changed = await f.export()
    assert.equal(changed.states.trim().split('\n')[1], baseline.states.trim())
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})

test('unobserved raw enrichment cannot change prior state even in an available snapshot', async () => {
  const f = await fixture()
  try {
    const csv = ['gameid,date,year,league,split,playoffs,position,side,teamname,result,kills,totalgold',
      ...f.raw.matches.flatMap(match => [
        `${match.id},${match.date},2026,LCK,Spring,0,team,blue,${match.teamA},${Number(match.winner === match.teamA)},${match.teamAKills},${match.teamAGold}`,
        `${match.id},${match.date},2026,LCK,Spring,0,team,red,${match.teamB},${Number(match.winner === match.teamB)},${match.teamBKills},${match.teamBGold}`,
      ])].join('\n')
    const path = join(f.directory, 'oracle.csv')
    await writeFile(path, csv)
    f.files.oracleCsv.push('oracle.csv')
    f.requestFile.sourceFiles = [{ path: 'oracle.csv', observedAt: Date.parse(capture),
      sha256: createHash('sha256').update(csv).digest('hex') }]
    const oracle = await importRankingSourceData({ oracleCsvPaths: [path] })
    f.requestFile.observations.push(...oracle.matches.map(match => ({ gameId: match.id,
      observedAt: Date.parse(match.date) + 3600_000, resultAvailableAt: Date.parse(match.date) + 3600_000 })))
    const baseline = await f.export()
    f.raw.matches[0].bestOf = 5
    f.requestFile.observations[0].observedAt = Date.parse(future)
    await writeFile(join(f.directory, 'raw.json'), JSON.stringify(f.raw))
    const unavailable = await f.export()
    assert.equal(unavailable.states, baseline.states)
    assert.equal(unavailable.receipts[0].homeSeriesWinProbability, baseline.receipts[0].homeSeriesWinProbability)
    f.requestFile.observations[0].observedAt = cutoff - 1
    const available = await f.export()
    assert.ok(available.receipts[0].sourceObservedAt.includes(cutoff - 1))
    assert.notEqual(available.states, baseline.states)
    assert.notEqual(available.receipts[0].homeSeriesWinProbability, baseline.receipts[0].homeSeriesWinProbability)
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})

test('verified export requires source capture evidence and binds explicit evidence to bytes', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.directory, 'raw.json'), JSON.stringify({ matches: f.raw.matches }))
    await assert.rejects(f.export(), /Missing source file capture/)
    f.requestFile.sourceFiles = [{ path: 'raw.json', observedAt: Date.parse(capture),
      sha256: createHash('sha256').update(await readFile(join(f.directory, 'raw.json'))).digest('hex') }]
    assert.equal((await f.export()).receipts[0].eligible, true)
    await writeFile(join(f.directory, 'raw.json'), JSON.stringify(f.raw))
    await assert.rejects(f.export(), /Invalid source file capture/)
    f.requestFile.availability = 'historical-limited'
    f.requestFile.evidenceMode = 'retrospective'
    const historical = await f.export()
    assert.equal(historical.receipts[0].eligible, false)
    assert.deepEqual(historical.receipts[0].exclusions, ['historical-availability-not-proven'])
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})

test('late Oracle rows cannot replace earlier Leaguepedia games during reconciliation', async () => {
  const f = await fixture()
  try {
    const baseline = await f.export()
    const csv = ['gameid,date,year,league,split,playoffs,position,side,teamname,result,kills,totalgold',
      ...f.raw.matches.flatMap(match => [
        `${match.id},${match.date},2026,LCK,Spring,0,team,blue,${match.teamA},0,5,50000`,
        `${match.id},${match.date},2026,LCK,Spring,0,team,red,${match.teamB},1,30,70000`,
      ])].join('\n')
    const path = join(f.directory, 'oracle.csv')
    await writeFile(path, csv)
    f.files.oracleCsv.push('oracle.csv')
    f.requestFile.sourceFiles = [{ path: 'oracle.csv', observedAt: Date.parse(future),
      sha256: createHash('sha256').update(csv).digest('hex') }]
    const oracle = await importRankingSourceData({ oracleCsvPaths: [path] })
    assert.equal(oracle.matches.length, 2)
    f.requestFile.observations.push(...oracle.matches.map(match => ({ gameId: match.id,
      observedAt: Date.parse(match.date) + 3600_000, resultAvailableAt: Date.parse(match.date) + 3600_000 })))
    const late = await f.export()
    assert.equal(late.states, baseline.states)
    assert.equal(late.receipts[0].homeSeriesWinProbability, baseline.receipts[0].homeSeriesWinProbability)
    f.requestFile.sourceFiles[0].observedAt = Date.parse(capture)
    const available = await f.export()
    assert.notEqual(available.states, baseline.states)
    assert.ok(available.states.includes('oe-availability-0'))
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})
