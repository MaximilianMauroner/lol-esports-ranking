import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishPreMatchReceiptOffline, pinPreMatchReceiptOffline, readForecastLedgerOffline, recordForecastDeliveryOffline } from '../scripts/tournament-forecast-receipts'
import { observeForecastDelivery } from '../scripts/tournament-forecast-delivery'
import { publishedRatingScale } from '../src/lib/modelConfig'
import { estimatePublicMatchup } from '../src/lib/publicMatchup'
import { loadTournamentForecastLedger } from '../src/lib/tournamentForecastArtifacts'
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
  return createPreMatchReceipt({ series: currentSeries, basis: forecastBasis, forecastRevision: 'rev-1',
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
  assert.equal(createPreMatchReceipt({ series: live, basis: basis(), forecastRevision: 'late',
    generatedAt: after, publishedAt: after, observedAt: after }).status, 'unavailable')
  assert.equal(receipt(basis(), series(), after).status, 'unavailable')
  const afterPin = pinPreMatchReceipt(ledger, { ...live, status: 'completed' }, '2026-09-27T15:00:00.000Z')
  assert.deepEqual(afterPin.pinned, ledger.pinned)
})

test('pinning waits for source-reported play and chooses the latest actual publication instant', () => {
  const earlier = receipt()
  const current = series()
  const later = createPreMatchReceipt({ series: current, basis: basis(),
    forecastRevision: 'offset-newer', generatedAt: before, publishedAt: '2026-09-27T11:30:00-01:00', observedAt: before })
  assert.equal(earlier.status, 'ready')
  assert.equal(later.status, 'ready')
  if (earlier.status !== 'ready' || later.status !== 'ready') return
  const ledger = appendForecastReceipt(appendForecastReceipt(emptyForecastLedger, earlier), later)
  const live = { ...current, status: 'live' as const, sourceState: 'inProgress' }
  assert.deepEqual(pinPreMatchReceipt(ledger, { ...live, sourceState: 'unstarted' }, after).pinned, {})
  assert.deepEqual(pinPreMatchReceipt(ledger, { ...live, sourceState: 'unknown' }, after).pinned, {})
  assert.equal(pinPreMatchReceipt(ledger, live, after).pinned[current.id], later.receiptKey)
})

test('a stalled optional forecast ledger read times out', async () => {
  const stalledFetch: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    assert.ok(signal)
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  await assert.rejects(loadTournamentForecastLedger(stalledFetch, 10), { name: 'TimeoutError' })
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
  assert.deepEqual(createPreMatchReceipt({ series: { ...series(), teams: corrected.teams }, basis: basis(),
    forecastRevision: 'unmapped-team', generatedAt: before, publishedAt: before, observedAt: before }).status, 'unavailable')
  assert.deepEqual(createPreMatchReceipt({ series: series(2), basis: basis(),
    forecastRevision: 'unsupported-format', generatedAt: before, publishedAt: before, observedAt: before }).status, 'unavailable')
})

test('played-game evidence and corrected earlier start prevent pre-match labeling', () => {
  const played = series()
  played.teams[0]!.gameWins = 1
  assert.deepEqual(forecastTournamentSeries(played, basis()).status, 'unavailable')
  assert.deepEqual(createPreMatchReceipt({ series: played, basis: basis(), forecastRevision: 'played',
    generatedAt: before, publishedAt: before, observedAt: before }).status, 'unavailable')
  const outcome = series()
  outcome.teams[0]!.outcome = 'win'
  assert.deepEqual(forecastTournamentSeries(outcome, basis()).status, 'unavailable')

  const originallyLater = { ...series(), startTime: '2026-09-27T14:00:00.000Z' }
  const created = createPreMatchReceipt({ series: originallyLater, basis: basis(),
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
  assert.equal(isForecastLedger(wrapped({ ...created, warnings: undefined as unknown as string[] })), false)
  assert.equal(isForecastLedger(wrapped({ ...created, generatedAt: '2026-09-27T11:59:00.000Z' })), false)
  assert.equal(isForecastLedger(wrapped({ ...created, eventStateVersion: JSON.stringify([created.matchId, created.eventId, start, 'live', 'inProgress', 5,
    [['source-a', 1, null], ['source-b', 0, null]]]) })), false)
  assert.equal(isForecastLedger(wrapped({ ...created, eventStateVersion: JSON.stringify([created.matchId, created.eventId, start, 'upcoming', 'inProgress', 5,
    [['source-a', null, null], ['source-b', null, null]]]) })), false)
  assert.equal(isForecastLedger(wrapped({ ...created, eventStateVersion: JSON.stringify([created.matchId, created.eventId, start, 'upcoming', 'unstarted', 5,
    [['source-a', 1, null], ['source-b', 0, null]]]) })), false)
  assert.equal(createPreMatchReceipt({ series: series(), basis: basis(), forecastRevision: 'impossible-time',
    generatedAt: '2026-09-27T11:59:00.000Z', publishedAt: before, observedAt: before }).status, 'unavailable')
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
    const input = { series: current, basis: basis(), forecastRevision: 'rev-1', generatedAt: before, observedAt: before }
    const saved = await publishPreMatchReceiptOffline(root, input, new Date(before))
    assert.equal(saved.status, 'ready')
    assert.deepEqual(await publishPreMatchReceiptOffline(root, input, new Date(before)), saved)
    const callerInput = {
      ...input, forecast: { ...saved, homeGameWinProbability: 0.99, awayGameWinProbability: 0.01 },
    }
    assert.deepEqual(await publishPreMatchReceiptOffline(root, callerInput, new Date(before)), saved)
    const changedBasis = basis()
    changedBasis.snapshot.standings[0]!.rating = 1100
    await assert.rejects(publishPreMatchReceiptOffline(root, { ...input, basis: changedBasis }, new Date(before)), /Immutable forecast artifact/)
    const live = { ...current, status: 'live' as const, sourceState: 'inProgress' }
    const ledger = await pinPreMatchReceiptOffline(root, live, after)
    assert.equal(pinnedForecast(ledger, live).status, 'ready')
    await writeFile(join(root, 'receipts', 'interrupted-write.tmp'), '{')
    assert.deepEqual(await readForecastLedgerOffline(root), ledger)
    assert.equal((await publishPreMatchReceiptOffline(root, input, new Date(after))).status, 'unavailable')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('public delivery observer proves exact pre-schedule bytes without certifying actual play', async () => {
  const expected = receipt()
  assert.equal(expected.status, 'ready')
  const ledger = appendForecastReceipt(emptyForecastLedger, expected)
  const clock = new Date('2026-09-27T12:30:00.000Z')
  const input = { ledgerUrl: 'https://example.invalid/tournament-data/forecasts/ledger.json', receipt: expected,
    now: () => clock, fetcher: async () => new Response(JSON.stringify(ledger), { headers: { etag: '"fixture-ledger"', date: before } }) }
  const evidence = await observeForecastDelivery(input)
  assert.equal(evidence.observedAt, clock.toISOString(), 'The origin Date header cannot backdate delivery')
  assert.equal(evidence.evaluationEligible, false)
  assert.equal(evidence.certification, 'pending-source-approval-and-actual-play-evidence')
  assert.equal(evidence.etag, '"fixture-ledger"')
  assert.equal(evidence.matchId, expected.matchId)
  const root = await mkdtemp(join(tmpdir(), 'forecast-delivery-'))
  try {
    assert.deepEqual(await recordForecastDeliveryOffline(root, input), evidence)
    assert.deepEqual(await recordForecastDeliveryOffline(root, input), evidence, 'Same observation remains write-once')
  } finally { await rm(root, { recursive: true, force: true }) }
  await assert.rejects(observeForecastDelivery({ ...input, now: () => new Date(start) }), /not observed before/)
  await assert.rejects(observeForecastDelivery({ ...input, fetcher: async () => new Response('{}', { status: 404 }) }), /HTTP 404/)
  await assert.rejects(observeForecastDelivery({ ...input, fetcher: async () => new Response(JSON.stringify(emptyForecastLedger)) }), /not publicly delivered/)
  const altered = { ...expected, teams: expected.teams.map((team, index) => ({ ...team, rating: team.rating + index + 1 })) }
  await assert.rejects(observeForecastDelivery({ ...input, fetcher: async () => new Response(JSON.stringify({ ...ledger, receipts: { [expected.receiptKey]: altered } })) }), /not publicly delivered/)
  await assert.rejects(observeForecastDelivery({ ...input, ledgerUrl: 'https://example.invalid/ledger?token=secret' }), /public HTTPS URL/)
  await assert.rejects(observeForecastDelivery({ ...input, fetcher: async () => new Response(' '.repeat(8 * 1024 * 1024 + 1)) }), /exceeds observation budget/)
})
