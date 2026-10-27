import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { exportPregameSeries } from '../scripts/rankings/export-pregame-series.ts'
import { replayPregameSeriesBatch, replayPregameSeriesState, replaySimpleEloSeries, replaySimpleEloSeriesBatch, simpleEloPolicy } from '../src/domains/rankings/forecast.ts'
import type { AvailableRankingGame, PregameSeriesRequest } from '../src/domains/rankings/forecast.ts'
import { sampleMatches } from './fixtures/rankingFixtures.ts'

const beforeCompletion = Date.parse('2026-02-10T00:30:00Z')
const completedAt = Date.parse('2026-02-10T00:40:00Z')
const request = (asOf: number): PregameSeriesRequest => ({
  seriesId: 'completion-target', eventId: 'completion-event', homeTeamId: 'gen', awayTeamId: 't1',
  homeSourceTeam: 'Gen.G', awaySourceTeam: 'T1', bestOf: 3, scheduleRevision: '1',
  scheduledStartAt: asOf + 7200_000, scheduleObservedAt: asOf - 1000, scheduleProvider: 'lolesports-schedule',
  asOf, validUntil: asOf + 3600_000, event: 'LCK 2026 Spring', patch: '26.1', season: 2026,
  league: 'LCK', region: 'LCK', tier: 'regional-regular',
})
const history: AvailableRankingGame[] = sampleMatches.slice(0, 2).map((match, index) => ({
  match: { ...match, id: `completion-history-${index}`, sourceProvider: 'leaguepedia-cargo',
    sourceGameId: `completion-history-${index}`, sourceMatchId: `completion-history-${index}`,
    officialMatchId: `completion-history-${index}`, bestOf: 1, bestOfBasis: 'official' },
  observedAt: Date.parse(match.date) + 3600_000, resultAvailableAt: Date.parse(match.date) + 3600_000,
}))
const unfinished: AvailableRankingGame = {
  match: { ...history[0].match, id: 'completion-overnight', sourceGameId: 'completion-overnight',
    sourceMatchId: 'completion-overnight', officialMatchId: 'completion-overnight', date: '2026-02-09',
    datetimeUtc: '2026-02-09T23:50:00Z', gameCompletedAtUtc: new Date(completedAt).toISOString(), winner: 'T1' },
  observedAt: completedAt, resultAvailableAt: null,
}

for (const modelKind of ['ranking', 'simple-elo'] as const) {
  test(`${modelKind} export preserves the raw completion boundary in states and probabilities`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'completion-export-'))
    try {
      const manifest = join(directory, 'manifest.json')
      const requests = join(directory, 'requests.json')
      const candidate = join(directory, 'candidate.json')
      const raw = join(directory, 'oracle.csv')
      const games = [...history, unfinished].map(row => row.match)
      const csv = (includeUnfinished: boolean) => [
        'gameid,date,year,league,split,playoffs,game,patch,position,side,teamname,result,kills,totalgold,gamelength',
        ...games.slice(0, includeUnfinished ? 3 : 2).flatMap((match, index) => {
          const date = index === 2 ? '2026-02-09 23:50:00' : `${match.date} 12:00:00`
          return [
            `${match.id},${date},2026,LCK,Spring,0,1,16.1,team,Blue,${match.teamA},${Number(match.winner === match.teamA)},${match.teamAKills},${match.teamAGold},${index === 2 ? 3000 : 1800}`,
            `${match.id},${date},2026,LCK,Spring,0,1,16.1,team,Red,${match.teamB},${Number(match.winner === match.teamB)},${match.teamBKills},${match.teamBGold},${index === 2 ? 3000 : 1800}`,
          ]
        }),
      ].join('\n')
      await writeFile(manifest, JSON.stringify({ files: { oracleCsv: ['oracle.csv'] } }))
      await writeFile(requests, JSON.stringify({ evidenceMode: 'synthetic', availability: 'historical-limited',
        observations: games.map(match => ({ gameId: `oe-${match.id}`, observedAt: completedAt + 1000, resultAvailableAt: null })),
        requests: [{ ...request(beforeCompletion), seriesId: 'before-completion' }, { ...request(completedAt), seriesId: 'at-completion' }],
      }))
      await writeFile(candidate, JSON.stringify({ modelKind,
        candidateId: modelKind === 'simple-elo' ? simpleEloPolicy.candidateId : 'completion-export',
        parentCandidateId: null, calibrationFit: null, transform: { temperature: 1, dependence: 0, calibrationOrder: 'game-before-series' },
      }))
      await writeFile(raw, csv(false))
      const baseline = await exportPregameSeries(manifest, requests, candidate, join(directory, 'baseline.jsonl'))
      await writeFile(raw, csv(true))
      const output = join(directory, 'completed.jsonl')
      const actual = await exportPregameSeries(manifest, requests, candidate, output)
      const states = (await readFile(`${output}.states.jsonl`, 'utf8')).trim().split('\n').map(line => JSON.parse(line).state)
      assert.equal(actual[0].modelStateHash, baseline[0].modelStateHash)
      assert.equal(actual[0].homeSeriesWinProbability, baseline[0].homeSeriesWinProbability)
      assert.ok(!states[0].usedGameIds.includes(`oe-${unfinished.match.id}`))
      assert.ok(states[1].usedGameIds.includes(`oe-${unfinished.match.id}`))
      assert.notEqual(actual[1].modelStateHash, baseline[1].modelStateHash)
      assert.notEqual(actual[1].homeSeriesWinProbability, baseline[1].homeSeriesWinProbability)
      assert.equal(actual[0].eligible, false)
      assert.ok(actual[0].exclusions.includes('historical-availability-not-proven'))
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
}
const exactHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

for (const model of [
  { name: 'ranking', single: replayPregameSeriesState, batch: replayPregameSeriesBatch },
  { name: 'simple Elo', single: replaySimpleEloSeries, batch: replaySimpleEloSeriesBatch },
] as const) {
  test(`${model.name} excludes an unfinished prior-date result with unknown availability`, () => {
    const target = request(beforeCompletion)
    const expected = model.single(history, target, 'historical-limited')
    const inputs = [...history, structuredClone(unfinished)]
    const actual = model.single(inputs, target, 'historical-limited')
    assert.deepEqual(actual, expected)
    assert.equal(exactHash(actual), exactHash(expected))
    inputs.at(-1)!.match.winner = 'Gen.G'
    inputs.at(-1)!.match.teamAKills = 100
    inputs.at(-1)!.match.teamAGold = 100_000
    assert.deepEqual(model.single(inputs, target, 'historical-limited'), expected)
  })

  test(`${model.name} admits the result at completion and rebuilds same-day batch history`, () => {
    const inputs = [...history, unfinished]
    const targets = [request(completedAt), request(beforeCompletion), request(completedAt - 1)]
    const batch = model.batch(inputs, targets, 'historical-limited')
    assert.equal(batch.replayCount, 2)
    assert.deepEqual(batch.results, targets.map(target => model.single(inputs, target, 'historical-limited')))
    assert.ok(batch.results[0].usedGameIds.includes(unfinished.match.id))
    for (const index of [1, 2]) {
      assert.ok(!batch.results[index].usedGameIds.includes(unfinished.match.id))
      assert.deepEqual(batch.results[index], model.single(history, targets[index], 'historical-limited'))
    }
    assert.notEqual(exactHash(batch.results[0].state), exactHash(batch.results[1].state))
  })

  test(`${model.name} keeps verified completion and observation fencing`, () => {
    const result = { ...unfinished, resultAvailableAt: completedAt, observedAt: completedAt + 1000 }
    assert.deepEqual(model.single([...history, result], request(beforeCompletion), 'verified'),
      model.single(history, request(beforeCompletion), 'verified'))
    assert.ok(!model.single([...history, result], request(completedAt), 'verified').usedGameIds.includes(result.match.id))
    assert.ok(model.single([...history, result], request(completedAt + 1000), 'verified').usedGameIds.includes(result.match.id))
  })

  test(`${model.name} rejects a claimed result time before known completion`, () => {
    const impossible = { ...unfinished, resultAvailableAt: completedAt - 1 }
    for (const availability of ['verified', 'historical-limited'] as const) {
      assert.throws(() => model.single([...history, impossible], request(completedAt), availability), /provenance/)
    }
  })

  test(`${model.name} preserves unknown-completion historical behavior`, () => {
    const legacy = { ...unfinished, match: { ...unfinished.match, gameCompletedAtUtc: undefined } }
    assert.ok(model.single([...history, legacy], request(beforeCompletion), 'historical-limited').usedGameIds.includes(legacy.match.id))
    const invalid = { ...unfinished, match: { ...unfinished.match, gameCompletedAtUtc: 'invalid' } }
    assert.ok(!model.single([...history, invalid], request(beforeCompletion), 'historical-limited').usedGameIds.includes(invalid.match.id))
  })
}
