import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildRankingModel,
  finalizeTeamReducer,
  initializeTeamReducer,
  processTeamDateBatch,
  restoreTeamReducer,
  snapshotTeamReducer,
} from '../src/lib/model.ts'
import {
  buildPregamePlayerRatingEdges,
  finalizeLivePlayerEdgeReducer,
  initializeLivePlayerEdgeReducer,
  processLivePlayerEdgeDateBatch,
  restoreLivePlayerEdgeReducer,
  snapshotLivePlayerEdgeReducer,
} from '../src/lib/playerModel.ts'
import { decodePrivateState, encodePrivateState } from '../src/lib/incremental/canonicalCodec.ts'
import {
  buildReducerDependencyPlan,
  canonicalPrefixHash,
  retainReducerCheckpointCatalog,
  selectLatestReducerCheckpoint,
  type IncrementalReducerCheckpoint,
  privateStateHash,
  reducerCheckpointRetentionDates,
} from '../src/lib/incremental/reducerCheckpoint.ts'
import { fixedIncrementalFixture, mutateIncrementalFixture } from './fixtures/incrementalRankingFixtures.ts'
import type { MatchRecord } from '../src/types.ts'
import { runIncrementalRankingReducers } from '../src/lib/incremental/rankingReducer.ts'
import { createStaticRankingData } from '../src/lib/snapshot.ts'
import { createPublicArtifactWritePlan } from '../src/lib/publicArtifacts/writePlan.ts'
import { assertCrunchParity } from '../src/lib/incremental/parity.ts'
import { deriveTournamentInstances } from '../src/lib/internationalTournaments.ts'
import type { IncrementalFixture } from './fixtures/incrementalRankingFixtures.ts'
import {
  buildEventTrackers,
  isPlacementDependencyEvent,
  isRatedPlacementEvent,
} from '../src/lib/placementResiduals.ts'
import {
  createIncrementalCrunchReceipt,
  recordIncrementalReducerCandidate,
} from '../src/lib/incremental/metrics.ts'
import { orchestrateCrunch } from '../src/lib/incremental/orchestrator.ts'

test('direct live-edge and team wrappers are identical to explicit full lifecycles', () => {
  const fixture = fixedIncrementalFixture()
  const edgeReducer = initializeLivePlayerEdgeReducer(fixture.matches, { teams: fixture.teams })
  for (const batch of dateBatches(fixture.matches)) processLivePlayerEdgeDateBatch(edgeReducer, batch)
  assert.deepEqual(finalizeLivePlayerEdgeReducer(edgeReducer), buildPregamePlayerRatingEdges(fixture.matches, { teams: fixture.teams }))

  const teamReducer = initializeTeamReducer(fixture.matches, fixture.teams)
  for (const batch of dateBatches(fixture.matches)) processTeamDateBatch(teamReducer, batch)
  assert.deepEqual(finalizeTeamReducer(teamReducer), buildRankingModel(fixture.matches, fixture.teams))
})

test('latest append restores before the appended date and equals clean full', () => {
  const base = fixedIncrementalFixture()
  const appendedMatch = { ...base.matches[0]!, id: 'incremental-003', sourceGameId: 'incremental-003', date: '2026-05-17' }
  const appended = { ...base, matches: [...base.matches, appendedMatch] }
  const edgeBase = initializeLivePlayerEdgeReducer(base.matches, { teams: base.teams })
  for (const batch of dateBatches(base.matches)) processLivePlayerEdgeDateBatch(edgeBase, batch)
  const edgeRestored = restoreLivePlayerEdgeReducer(snapshotLivePlayerEdgeReducer(edgeBase), appended.matches, { teams: appended.teams })
  processLivePlayerEdgeDateBatch(edgeRestored, appended.matches.filter((match) => match.id === 'incremental-003'))
  assert.deepEqual(finalizeLivePlayerEdgeReducer(edgeRestored), buildPregamePlayerRatingEdges(appended.matches, { teams: appended.teams }))

  const teamBase = initializeTeamReducer(base.matches, base.teams)
  for (const batch of dateBatches(base.matches)) processTeamDateBatch(teamBase, batch)
  const teamRestored = restoreTeamReducer(snapshotTeamReducer(teamBase), appended.matches, appended.teams)
  processTeamDateBatch(teamRestored, appended.matches.filter((match) => match.id === 'incremental-003'))
  assert.deepEqual(finalizeTeamReducer(teamRestored), buildRankingModel(appended.matches, appended.teams))
})

test('seven-day correction replays the affected date suffix with no same-day leakage', () => {
  const fixture = fixedIncrementalFixture()
  const correctedMatches = fixture.matches.map((match) => match.id === 'incremental-002'
    ? { ...match, winner: match.teamB, teamAKills: 9, teamBKills: 18 }
    : match)
  const prefix = fixture.matches.filter((match) => match.date < '2026-01-17')

  const edgePrefix = initializeLivePlayerEdgeReducer(fixture.matches, { teams: fixture.teams })
  processLivePlayerEdgeDateBatch(edgePrefix, prefix)
  const edgeRestored = restoreLivePlayerEdgeReducer(snapshotLivePlayerEdgeReducer(edgePrefix), correctedMatches, { teams: fixture.teams })
  for (const batch of dateBatches(correctedMatches.filter((match) => match.date >= '2026-01-17'))) processLivePlayerEdgeDateBatch(edgeRestored, batch)
  assert.deepEqual(finalizeLivePlayerEdgeReducer(edgeRestored), buildPregamePlayerRatingEdges(correctedMatches, { teams: fixture.teams }))

  const teamPrefix = initializeTeamReducer(fixture.matches, fixture.teams)
  processTeamDateBatch(teamPrefix, prefix)
  const teamRestored = restoreTeamReducer(snapshotTeamReducer(teamPrefix), correctedMatches, fixture.teams)
  for (const batch of dateBatches(correctedMatches.filter((match) => match.date >= '2026-01-17'))) processTeamDateBatch(teamRestored, batch)
  assert.deepEqual(finalizeTeamReducer(teamRestored), buildRankingModel(correctedMatches, fixture.teams))
})

test('same-day additions freeze pregame state and finalization does not mutate checkpoints', () => {
  const fixture = mutateIncrementalFixture(fixedIncrementalFixture(), 'same-day-series-addition')
  const edgeReducer = initializeLivePlayerEdgeReducer(fixture.matches, { teams: fixture.teams })
  const teamReducer = initializeTeamReducer(fixture.matches, fixture.teams)
  for (const batch of dateBatches(fixture.matches)) {
    processLivePlayerEdgeDateBatch(edgeReducer, batch)
    processTeamDateBatch(teamReducer, batch)
  }
  const sameDay = fixture.matches.filter((match) => match.date === '2026-01-17')
  const edges = finalizeLivePlayerEdgeReducer(edgeReducer)
  assert.equal(edges.get(sameDay[0]!.id)?.teamAAdjustment, edges.get(sameDay[1]!.id)?.teamBAdjustment)

  const edgeCheckpoint = snapshotLivePlayerEdgeReducer(edgeReducer)
  const teamCheckpoint = snapshotTeamReducer(teamReducer)
  const before = encodePrivateState({ edgeCheckpoint, teamCheckpoint })
  finalizeLivePlayerEdgeReducer(edgeReducer)
  finalizeTeamReducer(teamReducer)
  assert.equal(encodePrivateState({ edgeCheckpoint, teamCheckpoint }), before)
})

test('checkpoint codec preserves full tournament trackers and restored completion parity', () => {
  const fixture = fixedIncrementalFixture()
  const tournamentLifecycles = new Map([['msi:2026', {
    status: 'completed' as const,
    boundaryDate: '2026-05-10',
    ratedThroughDate: '2026-05-10',
    dataLag: false,
    resultCoverageComplete: true,
  }]])
  const prefix = fixture.matches.filter((match) => match.date < '2026-05-10')
  const reducer = initializeTeamReducer(fixture.matches, fixture.teams, { tournamentLifecycles })
  for (const batch of dateBatches(prefix)) processTeamDateBatch(reducer, batch)
  const checkpoint = snapshotTeamReducer(reducer)
  assert.deepEqual(decodePrivateState(encodePrivateState(checkpoint)), checkpoint)
  const tracker = [...checkpoint.state.eventTrackers.values()][0]
  assert.ok(tracker)
  assert.ok(tracker.participants instanceof Set)
  assert.ok(tracker.teamLeagues instanceof Map)

  const restored = restoreTeamReducer(checkpoint, fixture.matches, fixture.teams, { tournamentLifecycles })
  for (const batch of dateBatches(fixture.matches.filter((match) => match.date >= '2026-05-10'))) processTeamDateBatch(restored, batch)
  assert.deepEqual(
    finalizeTeamReducer(restored),
    buildRankingModel(fixture.matches, fixture.teams, { tournamentLifecycles }),
  )
})

test('correction planner selects the latest daily checkpoint strictly before the changed date', () => {
  const fixture = fixedIncrementalFixture()
  const dependencyPlan = buildReducerDependencyPlan({ matches: fixture.matches, teams: fixture.teams })
  const dependencyHash = privateStateHash(dependencyPlan)
  const live = initializeLivePlayerEdgeReducer(fixture.matches, { teams: fixture.teams })
  const team = initializeTeamReducer(fixture.matches, fixture.teams)
  const checkpoints: IncrementalReducerCheckpoint[] = []
  for (const batch of dateBatches(fixture.matches)) {
    processLivePlayerEdgeDateBatch(live, batch)
    processTeamDateBatch(team, batch)
    const processedDate = batch[0]!.date
    checkpoints.push({
      schemaVersion: 1,
      processedDate,
      canonicalPrefixHash: canonicalPrefixHash(fixture.matches, processedDate),
      dependencyHash,
      dependencyPlan,
      retention: ['recent-daily'],
      livePlayerEdge: snapshotLivePlayerEdgeReducer(live),
      team: snapshotTeamReducer(team),
    })
  }
  const corrected = fixture.matches.map((match) => match.id === 'incremental-002'
    ? { ...match, winner: match.teamB, teamAKills: 8, teamBKills: 20 }
    : match)
  const correctedPlan = buildReducerDependencyPlan({ matches: corrected, teams: fixture.teams })
  assert.equal(selectLatestReducerCheckpoint(checkpoints, corrected, correctedPlan)?.processedDate, '2026-01-10')
})

test('checkpoint retention keeps recent daily plus durable monthly, season, and tournament boundaries', () => {
  const fixture = fixedIncrementalFixture()
  const template = reducerCheckpointTemplate(fixture)
  const dates = [
    ...Array.from({ length: 31 }, (_, index) => `2026-01-${String(index + 1).padStart(2, '0')}`),
    ...Array.from({ length: 14 }, (_, index) => `2026-02-${String(index + 1).padStart(2, '0')}`),
  ]
  const matches = dates.map((date, index): MatchRecord => ({
    ...fixture.matches[0]!,
    id: `retention-${index}`,
    sourceGameId: `retention-${index}`,
    date,
    ...(date === '2026-01-10' ? { event: 'MSI 2026', league: 'MSI', region: 'International', tier: 'msi-bracket' as const } : {}),
  }))
  const checkpoints = dates.map((processedDate): IncrementalReducerCheckpoint => ({
    ...template,
    processedDate,
    canonicalPrefixHash: canonicalPrefixHash(matches, processedDate),
    livePlayerEdge: { ...template.livePlayerEdge, processedDate },
    team: { ...template.team, processedDate },
  }))
  const retained = retainReducerCheckpointCatalog(checkpoints, matches, 5)
  const byDate = new Map(retained.map((checkpoint) => [checkpoint.processedDate, checkpoint.retention]))
  assert.ok(byDate.get('2026-01-31')?.includes('monthly'))
  assert.ok(byDate.get('2026-01-01')?.includes('season-boundary'))
  assert.ok(byDate.get('2026-02-14')?.includes('season-boundary'))
  assert.ok(byDate.get('2026-01-09')?.includes('international-boundary'))
  assert.ok(byDate.get('2026-01-10')?.includes('international-boundary'))
  assert.ok(byDate.get('2026-02-10')?.includes('recent-daily'))
})

test('production reducer runner reports zero no-change rows and suffix rows for corrections', () => {
  const fixture = fixedIncrementalFixture()
  const cold = runIncrementalRankingReducers({ matches: fixture.matches, teams: fixture.teams })
  assert.deepEqual(cold.ranking, buildRankingModel(fixture.matches, fixture.teams))
  const unchanged = runIncrementalRankingReducers({
    matches: fixture.matches,
    teams: fixture.teams,
    checkpointHistory: cold.checkpoints,
  })
  assert.deepEqual(unchanged.rows, { livePlayerEdgeRows: 0, teamRows: 0 })
  assert.equal(unchanged.selectedCheckpointDate, '2026-05-10')

  const corrected = fixture.matches.map((match) => match.id === 'incremental-002'
    ? { ...match, winner: match.teamB, teamAKills: 8, teamBKills: 20 }
    : match)
  const replayed = runIncrementalRankingReducers({
    matches: corrected,
    teams: fixture.teams,
    checkpointHistory: cold.checkpoints,
  })
  assert.equal(replayed.selectedCheckpointDate, '2026-01-10')
  assert.deepEqual(replayed.rows, { livePlayerEdgeRows: 2, teamRows: 2 })
  assert.deepEqual(replayed.ranking, buildRankingModel(corrected, fixture.teams))
})

test('MSI play-in membership changes restore before tournament start and rebuild complete trackers', () => {
  const fixture = fixedIncrementalFixture()
  const expandedTeams = {
    ...fixture.teams,
    'MSI Newcomer': { name: 'MSI Newcomer', code: 'NEW', region: 'LEC' as const, league: 'LEC' },
  }
  const regionalTemplate = fixture.matches[0]!
  const baseMatches = [
    ...fixture.matches.map((match) => match.id === 'incremental-msi-001'
      ? { ...match, tier: 'msi-play-in' as const, phase: 'Play-in' }
      : match),
    {
      ...regionalTemplate,
      id: 'incremental-newcomer-regional',
      sourceGameId: 'incremental-newcomer-regional',
      date: '2026-01-24',
      teamB: 'MSI Newcomer',
    },
  ]
  const cold = runIncrementalRankingReducers({ matches: baseMatches, teams: expandedTeams })
  const firstMsi = baseMatches.find((match) => match.id === 'incremental-msi-001')!
  const appendedMatches = [...baseMatches, {
    ...firstMsi,
    id: 'incremental-msi-002',
    sourceGameId: 'incremental-msi-002',
    date: '2026-05-11',
    teamB: 'MSI Newcomer',
  }]
  const replayed = runIncrementalRankingReducers({
    matches: appendedMatches,
    teams: expandedTeams,
    checkpointHistory: cold.checkpoints,
  })
  assert.equal(replayed.selectedCheckpointDate, '2026-01-24')
  assert.deepEqual(replayed.rows, { livePlayerEdgeRows: 2, teamRows: 2 })
  assert.deepEqual(replayed.ranking, buildRankingModel(appendedMatches, expandedTeams))
})

test('tournament completion reuses pre-start state and replays placement exactly', () => {
  const fixture = fixedIncrementalFixture()
  const ongoing = new Map([['msi:2026', {
    status: 'ongoing' as const,
    boundaryDate: '2026-05-10',
    ratedThroughDate: '2026-05-10',
    dataLag: false,
    resultCoverageComplete: false,
  }]])
  const completed = new Map([['msi:2026', {
    status: 'completed' as const,
    boundaryDate: '2026-05-10',
    ratedThroughDate: '2026-05-10',
    dataLag: false,
    resultCoverageComplete: true,
  }]])
  const cold = runIncrementalRankingReducers({ matches: fixture.matches, teams: fixture.teams, tournamentLifecycles: ongoing })
  const replayed = runIncrementalRankingReducers({
    matches: fixture.matches,
    teams: fixture.teams,
    tournamentLifecycles: completed,
    checkpointHistory: cold.checkpoints,
  })
  assert.equal(replayed.selectedCheckpointDate, '2026-01-17')
  assert.deepEqual(replayed.rows, { livePlayerEdgeRows: 1, teamRows: 1 })
  assert.deepEqual(
    replayed.ranking,
    buildRankingModel(fixture.matches, fixture.teams, { tournamentLifecycles: completed }),
  )
})

test('regex-only MSI qualifiers create conservative boundaries without placement rating math', () => {
  const fixture = fixedIncrementalFixture()
  const qualifier = {
    ...fixture.matches[0]!,
    id: 'msi-qualifier-boundary',
    sourceGameId: 'msi-qualifier-boundary',
    date: '2026-04-01',
    event: 'MSI 2026 Qualifier',
    phase: 'Qualifier',
    tier: 'qualifier' as const,
  }
  assert.equal(isPlacementDependencyEvent(qualifier), true)
  assert.equal(isRatedPlacementEvent(qualifier), false)
  assert.equal(buildEventTrackers([qualifier]).size, 0)
  assert.ok(reducerCheckpointRetentionDates([fixture.matches[0]!, qualifier]).get(qualifier.date)?.includes('international-boundary'))
  const ranking = buildRankingModel([qualifier], fixture.teams)
  assert.ok(ranking.standings.every((standing) => standing.ratingUpdate.leaguePlacementDelta === 0))
})

test('cold, warm, append, correction, tournament, and shadow artifacts retain full public parity', () => {
  const base = fixedIncrementalFixture()
  const cold = assertArtifactParity(base)
  const scenarios = [
    base,
    mutateIncrementalFixture(base, 'append'),
    mutateIncrementalFixture(base, 'correction'),
    mutateIncrementalFixture(base, 'tournament-completion'),
  ]
  for (const scenario of scenarios) assertArtifactParity(scenario, cold.checkpoints)
})

test('parity-gated receipts publish full while retaining candidate no-change, suffix, and fallback metrics', async () => {
  const fixture = fixedIncrementalFixture()
  const cold = runIncrementalRankingReducers({ matches: fixture.matches, teams: fixture.teams })
  const warm = await parityGatedReceipt(fixture, cold.checkpoints)
  assert.equal(warm.receipt.requestedMode, 'incremental')
  assert.equal(warm.receipt.executedMode, 'full')
  assert.deepEqual(warm.receipt.reducers, { livePlayerEdgeRows: 0, teamRows: 0, playerRows: null })
  assert.equal(warm.receipt.checkpoint.selected, '2026-05-10')

  for (const mutation of ['append', 'correction'] as const) {
    const changed = await parityGatedReceipt(mutateIncrementalFixture(fixture, mutation), cold.checkpoints)
    assert.equal(changed.receipt.executedMode, 'full')
    assert.ok((changed.receipt.reducers.teamRows ?? 0) > 0)
    assert.ok((changed.receipt.reducers.livePlayerEdgeRows ?? 0) > 0)
    if (mutation === 'append') assert.ok(changed.receipt.checkpoint.selected)
  }
  const fallback = { kind: 'checkpoint-unavailable' as const, detail: 'parity-gated fallback test' }
  const fallbackRun = await parityGatedReceipt(fixture, cold.checkpoints, fallback)
  assert.equal(fallbackRun.receipt.requestedMode, 'incremental')
  assert.equal(fallbackRun.receipt.executedMode, 'full')
  assert.deepEqual(fallbackRun.receipt.checkpoint.fallback, fallback)
  assert.equal(fallbackRun.receipt.checkpoint.selected, '2026-05-10')
  assert.deepEqual(fallbackRun.receipt.reducers, { livePlayerEdgeRows: 0, teamRows: 0, playerRows: null })
})

async function parityGatedReceipt(
  fixture: IncrementalFixture,
  checkpointHistory: IncrementalReducerCheckpoint[],
  fallback?: { kind: 'checkpoint-unavailable'; detail: string },
) {
  const candidate = runIncrementalRankingReducers({
    matches: fixture.matches,
    teams: fixture.teams,
    checkpointHistory,
  })
  type ReceiptOutput = Pick<typeof candidate, 'rows' | 'selectedCheckpointDate'>
  const receipt = createIncrementalCrunchReceipt({
    run: { generatedAt: '2026-07-19T00:00:00.000Z', runId: 'phase2-receipt' },
    requestedMode: 'incremental',
  })
  const orchestration = await orchestrateCrunch<ReceiptOutput>({
    mode: 'incremental',
    receipt,
    requireReferenceParity: true,
    runFull: () => ({ rows: { livePlayerEdgeRows: 999, teamRows: 999 } }),
    runIncremental: () => ({
      output: { rows: candidate.rows, selectedCheckpointDate: candidate.selectedCheckpointDate },
      ...(fallback ? { fallback } : {}),
    }),
  })
  const incrementalCandidate = orchestration.shadowOutput
  assert.ok(incrementalCandidate)
  recordIncrementalReducerCandidate(receipt, {
    ...incrementalCandidate.rows,
    selectedCheckpoint: incrementalCandidate.selectedCheckpointDate,
  })
  return { receipt, orchestration }
}

function assertArtifactParity(fixture: IncrementalFixture, checkpointHistory: IncrementalReducerCheckpoint[] = []) {
  const generatedAt = '2026-07-19T00:00:00.000Z'
  const tournamentLifecycles = new Map(
    deriveTournamentInstances({
      matches: fixture.matches,
      scheduleReferences: fixture.scheduleReferences,
      generatedAt,
    }).map((instance) => [instance.id, {
      status: instance.status,
      boundaryDate: instance.boundaryDate,
      ratedThroughDate: instance.ratedThroughDate,
      dataLag: instance.dataLag,
      resultCoverageComplete: instance.resultCoverageComplete,
    }] as const),
  )
  const incremental = runIncrementalRankingReducers({
    matches: fixture.matches,
    teams: fixture.teams,
    tournamentLifecycles,
    checkpointHistory,
  })
  const common = {
    matches: fixture.matches,
    teams: fixture.teams,
    rosters: {},
    runMetadata: { generatedAt, runId: 'phase2-parity' },
    source: 'phase2 fixed fixture',
    dataMode: 'scheduled-public-data' as const,
    tournamentScheduleReferences: fixture.scheduleReferences,
  }
  const reference = createStaticRankingData(common)
  const candidate = createStaticRankingData({ ...common, precomputedGlobalRanking: incremental.ranking })
  const referencePlan = createPublicArtifactWritePlan(reference, { runMetadata: common.runMetadata })
  const candidatePlan = createPublicArtifactWritePlan(candidate, { runMetadata: common.runMetadata })
  assertCrunchParity(
    { fullSnapshot: reference, publicWrites: referencePlan.writes },
    { fullSnapshot: candidate, publicWrites: candidatePlan.writes },
  )
  return incremental
}

function reducerCheckpointTemplate(fixture: ReturnType<typeof fixedIncrementalFixture>): IncrementalReducerCheckpoint {
  const live = initializeLivePlayerEdgeReducer([], { teams: fixture.teams })
  const team = initializeTeamReducer([], fixture.teams)
  const dependencyPlan = buildReducerDependencyPlan({ matches: [], teams: fixture.teams })
  return {
    schemaVersion: 1,
    canonicalPrefixHash: canonicalPrefixHash([]),
    dependencyHash: privateStateHash(dependencyPlan),
    dependencyPlan,
    retention: [],
    livePlayerEdge: snapshotLivePlayerEdgeReducer(live),
    team: snapshotTeamReducer(team),
  }
}

function dateBatches(matches: MatchRecord[]) {
  const batches = new Map<string, MatchRecord[]>()
  for (const match of matches.toSorted((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id))) {
    batches.set(match.date, [...(batches.get(match.date) ?? []), match])
  }
  return [...batches.values()]
}
