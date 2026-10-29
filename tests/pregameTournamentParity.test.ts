import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { exportPregameSeries } from '../scripts/rankings/export-pregame-series.ts'
import { importRankingSourceData } from '../scripts/rankings/source-input.ts'
import { deriveTeamProfilesFromMatches, deriveTournamentInstances } from '../src/domains/rankings/evidence.ts'
import { replayPregameSeriesBatch, replayPregameSeriesState } from '../src/domains/rankings/forecast.ts'
import type { AvailableTournamentLifecycle, ExactPregameProbabilityState, PregameSeriesRequest } from '../src/domains/rankings/forecast.ts'
import { createRatingReplayContext, prepareRatingUtcDateBoundary, replayRatingDates } from '../src/domains/rankings/internal/replay/model.ts'
import { emitPregamePredictionsForDate } from '../src/lib/ratingSeriesEngine.ts'
import type { MatchRecord } from '../src/domains/rankings/types.ts'
import { sampleMatches } from './fixtures/rankingFixtures.ts'

const capture = Date.parse('2026-07-19T23:00:00Z')
const cutoff = Date.parse('2026-07-20T10:00:00Z')
const matches: MatchRecord[] = Array.from({ length: 3 }, (_, index) => ({ ...sampleMatches[0],
  id: `final-${index}`, sourceGameId: `final-${index}`, sourceMatchId: 'ewc-final', officialMatchId: 'ewc-final',
  sourceProvider: 'leaguepedia-cargo', date: '2026-07-19', event: 'EWC 2026', league: 'EWC',
  region: 'International', tier: 'minor-international', phase: 'Final', bestOf: 5, bestOfBasis: 'official', winner: 'Gen.G', teamB: 'G2 Esports',
}))
const request: PregameSeriesRequest = {
  seriesId: 'next', eventId: 'next-event', homeTeamId: 'gen', awayTeamId: 't1', homeSourceTeam: 'Gen.G', awaySourceTeam: 'G2 Esports',
  bestOf: 3, scheduleRevision: '1', scheduledStartAt: cutoff + 7200000, scheduleObservedAt: capture,
  scheduleProvider: 'lolesports-schedule', asOf: cutoff, validUntil: cutoff + 3600000,
  event: 'LCK 2026 Summer', patch: '26.14', season: 2026, league: 'LCK', region: 'LCK', tier: 'regional-regular',
}
const references = [{ matchId: 'ewc-final', leagueName: 'EWC', date: '2026-07-19', state: 'completed',
  retrievedAt: new Date(capture).toISOString(), coverageStart: '2026-07-19', coverageEnd: '2026-07-19', coverageEndComplete: true }]
const inputsFor = (games: MatchRecord[]) => games.map(match => ({ match, observedAt: capture, resultAvailableAt: capture }))
function evidenceFor(games: MatchRecord[], scheduleReferences = references): AvailableTournamentLifecycle[] {
  return deriveTournamentInstances({ matches: games, scheduleReferences, generatedAt: new Date(cutoff).toISOString() })
    .map(instance => ({ tournamentId: instance.id, lifecycle: instance, observedAt: capture }))
}
function production(games: MatchRecord[], evidence: AvailableTournamentLifecycle[]) {
  const teams = deriveTeamProfilesFromMatches(games)
  const context = createRatingReplayContext(games, teams, { tournamentLifecycles: new Map(evidence.map(row => [row.tournamentId, row.lifecycle])) })
  const state = replayRatingDates({ context, replayMatches: games })
  const target: MatchRecord = { ...games[0], id: request.seriesId, sourceMatchId: request.seriesId, officialMatchId: request.seriesId,
    date: '2026-07-20', event: request.event, league: request.league, region: request.region, tier: request.tier,
    phase: '', patch: request.patch, bestOf: request.bestOf, winner: '', teamAKills: 0, teamBKills: 0, teamAGold: 0, teamBGold: 0 }
  prepareRatingUtcDateBoundary({ dateMatches: [target], teams, state })
  let exact: ExactPregameProbabilityState | undefined
  emitPregamePredictionsForDate({ matches: [target], teams, state, pregamePlayerRatingEdges: new Map(), sideAdjustments: new Map(), onExactState: value => { exact = value } })
  return exact
}

test('completed international placement preserves exact production pregame state', () => {
  const evidence = evidenceFor(matches)
  assert.equal(evidence[0].lifecycle.status, 'completed')
  assert.equal(evidence[0].lifecycle.resultCoverageComplete, true)
  const actual = replayPregameSeriesState(inputsFor(matches), request, 'verified', evidence)
  assert.deepEqual(actual.state, production(matches, evidence))
  assert.notEqual(actual.state.home.rating, replayPregameSeriesState(inputsFor(matches), request, 'verified').state.home.rating)
})

test('new lifecycle evidence invalidates same-date cache and future evidence cannot change prior state', () => {
  const evidence = evidenceFor(matches).map(row => ({ ...row, observedAt: cutoff + 1000 }))
  const later = { ...request, asOf: cutoff + 2000 }
  const batch = replayPregameSeriesBatch(inputsFor(matches), [request, later], 'verified', evidence)
  assert.equal(batch.replayCount, 2)
  assert.notEqual(batch.results[0].state.home.rating, batch.results[1].state.home.rating)
  assert.deepEqual(batch.results, [request, later].map(row => replayPregameSeriesState(inputsFor(matches), row, 'verified', evidence)))
  evidence[0].lifecycle.status = 'ongoing'
  assert.deepEqual(replayPregameSeriesState(inputsFor(matches), request, 'verified', evidence), batch.results[0])
})

test('exported exact state matches production after final and ignores future schedule captures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tournament-parity-'))
  try {
    const manifest = join(directory, 'manifest.json')
    const requests = join(directory, 'requests.json')
    const candidate = join(directory, 'candidate.json')
    const files = { leaguepediaJson: ['raw.json'], lolEsportsJson: ['schedule.json'] }
    await writeFile(join(directory, 'raw.json'), JSON.stringify({ fetchedAt: new Date(capture).toISOString(), matches }))
    const schedule = { fetchedAt: new Date(capture).toISOString(), coverage: { complete: true }, events: [{
      startTime: '2026-07-19T12:00:00Z', state: 'completed', blockName: 'Final', league: { name: 'EWC', slug: 'ewc' },
      match: { id: 'ewc-final', strategy: { type: 'bestOf', count: 5 }, teams: [{ name: 'Gen.G' }, { name: 'G2 Esports' }] },
    }] }
    await writeFile(join(directory, 'schedule.json'), JSON.stringify(schedule))
    await writeFile(manifest, JSON.stringify({ files }))
    const source = await importRankingSourceData({ manifestPath: manifest })
    const evidence = evidenceFor(source.matches, source.tournamentScheduleReferences as typeof references)
    assert.equal(evidence[0].lifecycle.status, 'completed')
    await writeFile(requests, JSON.stringify({ evidenceMode: 'synthetic', availability: 'verified', requests: [request],
      observations: source.matches.map(match => ({ gameId: match.id, observedAt: capture, resultAvailableAt: capture })) }))
    await writeFile(candidate, JSON.stringify({ candidateId: 'parity', parentCandidateId: null, calibrationFit: null,
      transform: { temperature: 1, calibrationOrder: 'game-before-series', dependence: 0 } }))
    const output = join(directory, 'first.jsonl')
    const receipts = await exportPregameSeries(manifest, requests, candidate, output)
    const saved = JSON.parse(await readFile(`${output}.states.jsonl`, 'utf8'))
    assert.deepEqual(saved.state, { ...production(source.matches, evidence), usedGameIds: source.matches.map(match => match.id).sort() })
    assert.notEqual(saved.state.home.rating, replayPregameSeriesState(inputsFor(source.matches), request, 'verified').state.home.rating)
    assert.equal(receipts[0].sideAssumption, 'neutral')
    assert.equal(receipts[0].lineupAssumption, 'prior-observed-roster')
    files.lolEsportsJson.push('future.json')
    schedule.fetchedAt = '2026-07-21T00:00:00Z'
    schedule.events[0].state = 'unstarted'
    await writeFile(join(directory, 'future.json'), JSON.stringify(schedule))
    await writeFile(manifest, JSON.stringify({ files }))
    const changed = await exportPregameSeries(manifest, requests, candidate, join(directory, 'second.jsonl'))
    assert.equal(changed[0].modelStateHash, receipts[0].modelStateHash)
    assert.equal(changed[0].homeSeriesWinProbability, receipts[0].homeSeriesWinProbability)
    const explicitSchedule = { ...schedule, fetchedAt: undefined, events: schedule.events.map(event => ({ ...event, state: 'completed' })) }
    const explicitBytes = JSON.stringify(explicitSchedule)
    await writeFile(join(directory, 'schedule.json'), explicitBytes)
    const explicitRequests = JSON.parse(await readFile(requests, 'utf8'))
    explicitRequests.sourceFiles = [{ path: 'schedule.json', observedAt: capture,
      sha256: createHash('sha256').update(explicitBytes).digest('hex') }]
    await writeFile(requests, JSON.stringify(explicitRequests))
    const explicitOutput = join(directory, 'explicit.jsonl')
    const explicit = await exportPregameSeries(manifest, requests, candidate, explicitOutput)
    assert.equal(explicit[0].eligible, true)
    assert.equal(explicit[0].modelStateHash, receipts[0].modelStateHash)
    assert.equal(explicit[0].homeSeriesWinProbability, receipts[0].homeSeriesWinProbability)
    assert.deepEqual(JSON.parse(await readFile(`${explicitOutput}.states.jsonl`, 'utf8')), saved)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
