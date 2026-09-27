import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishPreMatchReceiptOffline, pinPreMatchReceiptOffline, readForecastLedgerOffline } from '../scripts/tournament-forecast-receipts'
import { publishedRatingScale } from '../src/lib/modelConfig'
import { estimatePublicMatchup } from '../src/lib/publicMatchup'
import type { PublicRankingShard, PublicTeamStanding } from '../src/lib/publicArtifacts/schema'
import type { TournamentSeries } from '../src/lib/tournamentFeed'
import {
  appendForecastReceipt, createPreMatchReceipt, emptyForecastLedger, forecastTournamentSeries, isForecastLedger,
  pinPreMatchReceipt, pinnedForecast, scoreConditionedSeriesOdds, type ForecastBasis, type ForecastReceipt,
} from '../src/lib/tournamentForecast'

const start = '2026-09-27T13:00:00.000Z'
const before = '2026-09-27T12:00:00.000Z'
const after = '2026-09-27T13:01:00.000Z'
const customScale = { ...publishedRatingScale, version: 'fixture-scale', spreadMultiplier: 2.4 }
const model = { name: 'fixture model', version: 'fixture-v1', configHash: 'fixture-hash', ratingScale: customScale,
  parameters: { winProbabilityEloScale: 400, winProbabilityUncertaintyScale: 400, winProbabilityUncertaintyFloor: 0.2 } }

function standing(teamId: string, team: string, rating: number): PublicTeamStanding {
  return { teamId, team, code: team.slice(0, 3), rating, uncertainty: 120, rosterBasis: 'current-roster',
    wins: 20, losses: 10, eligibility: { eligible: true, reasons: [] } } as unknown as PublicTeamStanding
}
function series(bestOf: number | null = 5): TournamentSeries {
  return { id: 'official-match-1', eventId: 'worlds:2026', startTime: start, stage: 'Knockout', status: 'upcoming', sourceState: 'unstarted', bestOf,
    teams: [{ id: 'source-a', name: 'Alias A', code: 'A', gameWins: null, outcome: null },
      { id: 'source-b', name: 'Alias B', code: 'B', gameWins: null, outcome: null }], vodUrls: [] }
}
function basis(): ForecastBasis {
  return { snapshotId: 'run-1/default', ratingDataAsOf: '2026-09-26T23:00:00.000Z', ratingPublishedAt: before,
    dataMode: 'scheduled-public-data', model: structuredClone(model),
    identityMap: { version: 1, source: 'lolesports-persisted-site-api', revision: 'reviewed-fixture-1', mappings: [
      { sourceTeamId: 'source-a', teamId: 'team:alpha' }, { sourceTeamId: 'source-b', teamId: 'team:beta' },
    ] },
    snapshot: { modelVersion: model.version, modelConfigHash: model.configHash, ratingScale: customScale,
      standings: [standing('team:alpha', 'Alpha', 2000), standing('team:beta', 'Beta', 1800)] } as PublicRankingShard,
  }
}
function receipt(forecastBasis = basis(), currentSeries = series(), publishedAt = before) {
  const forecast = forecastTournamentSeries(currentSeries, forecastBasis)
  return createPreMatchReceipt({ series: currentSeries, forecast, forecastRevision: 'rev-1',
    generatedAt: before, publishedAt, observedAt: before })
}

test('forecast matches public model for decisive formats, swapped teams and an explicit published scale', () => {
  for (const bestOf of [1, 3, 5]) {
    const input = series(bestOf)
    const chosen = basis()
    const result = forecastTournamentSeries(input, chosen)
    assert.equal(result.status, 'ready')
    if (result.status !== 'ready') continue
    const expected = estimatePublicMatchup(chosen.snapshot.standings[0]!, chosen.snapshot.standings[1]!, model, { bestOf, sideAssumption: 'neutral' })
    assert.equal(result.homeGameWinProbability, expected.homeGameWinProbability)
    assert.equal(result.homeSeriesWinProbability, expected.homeSeriesWinProbability)
    assert.equal(result.awaySeriesWinProbability, expected.awaySeriesWinProbability)
    const swapped = { ...input, teams: [input.teams[1]!, input.teams[0]!] }
    const reverse = forecastTournamentSeries(swapped, chosen)
    assert.equal(reverse.status, 'ready')
    if (reverse.status === 'ready') assert.equal(reverse.homeSeriesWinProbability, result.awaySeriesWinProbability)
  }
  const blue = forecastTournamentSeries(series(1), basis(), { sideAssumption: 'home-blue', sideBasis: 'fixture side assignment', blueSideRatingEdge: 50 })
  const red = forecastTournamentSeries(series(1), basis(), { sideAssumption: 'home-red', sideBasis: 'fixture side assignment', blueSideRatingEdge: 50 })
  assert.equal(blue.status, 'ready')
  assert.equal(red.status, 'ready')
  if (blue.status === 'ready' && red.status === 'ready') {
    assert.ok(blue.homeGameWinProbability > red.homeGameWinProbability)
    assert.equal(blue.homeGameWinProbability, estimatePublicMatchup(basis().snapshot.standings[0]!, basis().snapshot.standings[1]!, model,
      { bestOf: 1, sideAssumption: 'home-blue', blueSideRatingEdge: 50 }).homeGameWinProbability)
  }
  assert.equal(forecastTournamentSeries(series(5), basis(), { sideAssumption: 'home-blue', sideBasis: 'fixture side assignment' }).status, 'unavailable')
})

test('unknown and tie-capable formats, absent source IDs and unmapped aliases fail closed', () => {
  for (const bestOf of [null, 0, 2, 4, 7]) {
    const result = forecastTournamentSeries(series(bestOf), basis())
    assert.deepEqual(result.status === 'unavailable' && result.reason, 'unsupported-format')
  }
  const missingId = series()
  missingId.teams[0]!.id = null
  assert.equal(forecastTournamentSeries(missingId, basis()).status, 'unavailable')
  assert.equal(forecastTournamentSeries({ ...series(), sourceState: 'inProgress' }, basis()).status, 'unavailable')
  const renamed = series()
  renamed.teams[0]!.name = 'Alpha'
  const noMapping = basis()
  noMapping.identityMap.mappings = noMapping.identityMap.mappings.slice(1)
  const result = forecastTournamentSeries(renamed, noMapping)
  assert.deepEqual(result.status === 'unavailable' && result.reason, 'unmapped-team')
  const noScale = basis()
  noScale.model.ratingScale = undefined
  assert.deepEqual(forecastTournamentSeries(series(), noScale).status, 'unavailable')
  const noCalibration = basis()
  noCalibration.model.parameters = {}
  assert.deepEqual(forecastTournamentSeries(series(), noCalibration).status, 'unavailable')
})

test('receipt is pinned before play, remains frozen across model revisions and rejects post-start publication', () => {
  const first = receipt()
  assert.equal(first.status, 'ready')
  if (first.status !== 'ready') return
  let ledger = appendForecastReceipt(emptyForecastLedger, first)
  assert.equal(appendForecastReceipt(ledger, first), ledger)
  assert.throws(() => appendForecastReceipt(ledger, { ...first, modelVersion: 'tampered' }), /different content/)
  const live = { ...series(), status: 'live' as const, sourceState: 'inProgress', teams: series().teams.map((team, index) => ({ ...team, gameWins: index === 0 ? 1 : 0 })) }
  ledger = pinPreMatchReceipt(ledger, live, after)
  const pinned = pinnedForecast(ledger, live)
  assert.equal(pinned.status, 'ready')
  const revised = basis()
  revised.snapshot.standings[0]!.rating = 1100
  revised.model.version = 'fixture-v2'
  assert.deepEqual(pinnedForecast(ledger, live), pinned)
  assert.equal(createPreMatchReceipt({ series: live, forecast: forecastTournamentSeries(series(), basis()), forecastRevision: 'late',
    generatedAt: after, publishedAt: after, observedAt: after }).status, 'unavailable')
  assert.equal(receipt(basis(), series(), after).status, 'unavailable')
  const afterPin = pinPreMatchReceipt(ledger, { ...live, status: 'completed' }, '2026-09-27T15:00:00.000Z')
  assert.deepEqual(afterPin.pinned, ledger.pinned)
})

test('score-conditioned odds use frozen game probability and reject impossible or changed series', () => {
  const created = receipt()
  assert.equal(created.status, 'ready')
  if (created.status !== 'ready') return
  const frozen = created as ForecastReceipt
  const live = { ...series(), status: 'live' as const, sourceState: 'inProgress', teams: series().teams.map((team, index) => ({ ...team, gameWins: index === 0 ? 1 : 0 })) }
  const atOneZero = scoreConditionedSeriesOdds(frozen, live)
  assert.equal(atOneZero.status, 'ready')
  if (atOneZero.status === 'ready') assert.ok(atOneZero.homeSeriesWinProbability > frozen.homeSeriesWinProbability)
  live.teams[0]!.gameWins = 2
  live.teams[1]!.gameWins = 1
  assert.equal(scoreConditionedSeriesOdds(frozen, live).status, 'ready')
  live.teams[0]!.gameWins = 3
  const terminal = scoreConditionedSeriesOdds(frozen, live)
  assert.equal(terminal.status, 'ready')
  if (terminal.status === 'ready') assert.equal(terminal.homeSeriesWinProbability, 1)
  live.teams[1]!.gameWins = 3
  assert.deepEqual(scoreConditionedSeriesOdds(frozen, live).status, 'unavailable')
  assert.deepEqual(scoreConditionedSeriesOdds(frozen, { ...live, bestOf: 3 }).status, 'unavailable')
  assert.deepEqual(scoreConditionedSeriesOdds(frozen, { ...live, eventId: 'worlds:2027' }).status, 'unavailable')
  const contradictory = { ...live, status: 'completed' as const, teams: [
    { ...live.teams[0]!, gameWins: 3, outcome: 'loss' }, { ...live.teams[1]!, gameWins: 1, outcome: 'win' },
  ] }
  assert.deepEqual(scoreConditionedSeriesOdds(frozen, contradictory).status, 'unavailable')
})

test('participant and event corrections cannot relabel a pinned forecast', () => {
  const created = receipt()
  assert.equal(created.status, 'ready')
  if (created.status !== 'ready') return
  const initial = appendForecastReceipt(emptyForecastLedger, created)
  const live = { ...series(), status: 'live' as const, sourceState: 'inProgress' }
  const corrected = { ...live, teams: [{ ...live.teams[0]!, id: 'source-c' }, live.teams[1]!] }
  assert.equal(pinnedForecast(pinPreMatchReceipt(initial, corrected, after), corrected).status, 'unavailable')
  const pinned = pinPreMatchReceipt(initial, live, after)
  assert.equal(pinnedForecast(pinned, live).status, 'ready')
  assert.deepEqual(pinnedForecast(pinned, corrected).status, 'unavailable')
  assert.deepEqual(pinnedForecast(pinned, { ...live, eventId: 'worlds:2027' }).status, 'unavailable')
  assert.deepEqual(pinnedForecast(pinned, { ...live, bestOf: 3 }).status, 'unavailable')
  assert.deepEqual(createPreMatchReceipt({ series: { ...series(), teams: corrected.teams }, forecast: forecastTournamentSeries(series(), basis()),
    forecastRevision: 'mismatched-team', generatedAt: before, publishedAt: before, observedAt: before }).status, 'unavailable')
  assert.deepEqual(createPreMatchReceipt({ series: series(3), forecast: forecastTournamentSeries(series(), basis()),
    forecastRevision: 'mismatched-format', generatedAt: before, publishedAt: before, observedAt: before }).status, 'unavailable')
})

test('played-game evidence and corrected earlier start prevent pre-match labeling', () => {
  const played = series()
  played.teams[0]!.gameWins = 1
  assert.deepEqual(forecastTournamentSeries(played, basis()).status, 'unavailable')
  const cleanForecast = forecastTournamentSeries(series(), basis())
  assert.deepEqual(createPreMatchReceipt({ series: played, forecast: cleanForecast, forecastRevision: 'played',
    generatedAt: before, publishedAt: before, observedAt: before }).status, 'unavailable')
  const outcome = series()
  outcome.teams[0]!.outcome = 'win'
  assert.deepEqual(forecastTournamentSeries(outcome, basis()).status, 'unavailable')

  const originallyLater = { ...series(), startTime: '2026-09-27T14:00:00.000Z' }
  const created = createPreMatchReceipt({ series: originallyLater, forecast: forecastTournamentSeries(originallyLater, basis()),
    forecastRevision: 'before-original-start', generatedAt: '2026-09-27T13:30:00.000Z',
    publishedAt: '2026-09-27T13:30:00.000Z', observedAt: before })
  assert.equal(created.status, 'ready')
  if (created.status !== 'ready') return
  const ledger = appendForecastReceipt(emptyForecastLedger, created)
  const correctedLive = { ...originallyLater, startTime: start, status: 'live' as const, sourceState: 'inProgress' }
  assert.equal(pinnedForecast(pinPreMatchReceipt(ledger, correctedLive, '2026-09-27T13:40:00.000Z'), correctedLive).status, 'unavailable')
  const pinnedBeforeCorrection = pinPreMatchReceipt(ledger, { ...correctedLive, startTime: originallyLater.startTime }, '2026-09-27T13:40:00.000Z')
  assert.equal(pinnedForecast(pinnedBeforeCorrection, correctedLive).status, 'unavailable')
})

test('receipt parser rejects backdated, mismatched and non-upcoming persisted artifacts', () => {
  const created = receipt()
  assert.equal(created.status, 'ready')
  if (created.status !== 'ready') return
  const wrapped = (candidate: ForecastReceipt) => ({ version: 1, receipts: { [candidate.receiptKey]: candidate }, pinned: { [candidate.matchId]: candidate.receiptKey } })
  assert.equal(isForecastLedger(wrapped(created)), true)
  assert.equal(isForecastLedger(wrapped({ ...created, generatedAt: after })), false)
  assert.equal(isForecastLedger(wrapped({ ...created, ratingPublishedAt: after })), false)
  assert.equal(isForecastLedger(wrapped({ ...created, sourceObservedAt: after })), false)
  assert.equal(isForecastLedger(wrapped({ ...created, eventStateVersion: JSON.stringify([created.matchId, created.eventId, start, 'live', 'inProgress', 5,
    [['source-a', 1, null], ['source-b', 0, null]]]) })), false)
  assert.equal(isForecastLedger(wrapped({ ...created, eventStateVersion: JSON.stringify([created.matchId, created.eventId, start, 'upcoming', 'inProgress', 5,
    [['source-a', null, null], ['source-b', null, null]]]) })), false)
  assert.equal(isForecastLedger(wrapped({ ...created, eventStateVersion: JSON.stringify([created.matchId, created.eventId, start, 'upcoming', 'unstarted', 5,
    [['source-a', 1, null], ['source-b', 0, null]]]) })), false)
})

test('Bo1 score conditioning requires one integer completed-game win', () => {
  const created = receipt(basis(), series(1))
  assert.equal(created.status, 'ready')
  if (created.status !== 'ready') return
  const live = { ...series(1), status: 'live' as const, sourceState: 'inProgress', teams: [
    { ...series(1).teams[0]!, gameWins: 0.5 }, { ...series(1).teams[1]!, gameWins: 0.5 },
  ] }
  assert.deepEqual(scoreConditionedSeriesOdds(created, live).status, 'unavailable')
  live.teams[0]!.gameWins = 1
  live.teams[1]!.gameWins = 0
  const terminal = scoreConditionedSeriesOdds(created, live)
  assert.equal(terminal.status, 'ready')
  if (terminal.status === 'ready') assert.equal(terminal.homeSeriesWinProbability, 1)
})

test('offline store writes each receipt and pin once without overwriting a revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forecast-receipts-'))
  try {
    const current = series()
    const forecast = forecastTournamentSeries(current, basis())
    const input = { series: current, forecast, forecastRevision: 'rev-1', generatedAt: before, observedAt: before }
    const saved = await publishPreMatchReceiptOffline(root, input, new Date(before))
    assert.equal(saved.status, 'ready')
    assert.deepEqual(await publishPreMatchReceiptOffline(root, input, new Date(before)), saved)
    const changed = forecast.status === 'ready' ? { ...forecast, modelVersion: 'altered' } : forecast
    await assert.rejects(publishPreMatchReceiptOffline(root, { ...input, forecast: changed }, new Date(before)), /Immutable forecast artifact/)
    const live = { ...current, status: 'live' as const, sourceState: 'inProgress' }
    const ledger = await pinPreMatchReceiptOffline(root, live, after)
    assert.equal(pinnedForecast(ledger, live).status, 'ready')
    assert.deepEqual(await readForecastLedgerOffline(root), ledger)
    assert.equal((await publishPreMatchReceiptOffline(root, input, new Date(after))).status, 'unavailable')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
