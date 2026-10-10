import assert from 'node:assert/strict'
import test from 'node:test'
import { startWorldsWorker } from '../src/lib/worldsWorkerClient'
import type { WorldsWorkerMessage } from '../src/lib/worldsSimulationWorker'
import { historicalWorldsFixture, worldsBasis, worldsFixture } from './fixtures/worldsFixtures'
import { isWorldsArtifact, loadWorldsArtifact, worldsFeedEventKey, type HistoricalWorldsInput, type WorldsArtifact } from '../src/lib/worldsArtifacts'
import { worldsArtifact, worldsEvent } from './fixtures/worldsFixtures'
import { groupTournamentSeries, normalizeStatus, normalizeTournamentFeed, type TournamentEvent, type TournamentSeries } from '../src/lib/tournamentFeed'

function historicalEvent(state: HistoricalWorldsInput): TournamentEvent {
  const game = state.group.games[0]
  return { ...worldsEvent(), id: state.eventId, season: '2022', label: 'Synthetic Worlds 2022 group',
    series: [{ id: game.id, eventId: state.eventId, startTime: null, stage: 'Group A', status: 'completed', sourceState: 'completed', bestOf: 1, vodUrls: [],
      teams: [game.teamAId, game.teamBId].map((id) => ({ id, name: id, code: null, gameWins: id === game.winnerId ? 1 : 0, outcome: id === game.winnerId ? 'win' : 'loss' })) }] }
}

test('cancel invalidates saved old handlers before terminating the owned worker', () => {
  const received: WorldsWorkerMessage[] = []
  const worker = { onmessage: null as ((event: MessageEvent<WorldsWorkerMessage>) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null, terminated: false, postMessage() {}, terminate() { this.terminated = true } }
  const stop = startWorldsWorker(worldsFixture(), worldsBasis(), { seed: 47, trials: 10_000 }, (message) => received.push(message), () => worker)
  const queued = worker.onmessage!
  const queuedError = worker.onerror!
  queued({ data: { type: 'progress', completed: 100, total: 10_000 } } as MessageEvent<WorldsWorkerMessage>)
  stop()
  queued({ data: { type: 'error', detail: 'stale result' } } as MessageEvent<WorldsWorkerMessage>)
  queuedError({ message: 'stale error' } as ErrorEvent)
  assert.deepEqual(received, [{ type: 'progress', completed: 100, total: 10_000 }])
  assert.equal(worker.terminated, true); assert.equal(worker.onmessage, null)
})

test('companion schema rejects malformed JSON shapes before engine code; feed corrections change coherence key', async () => {
  const original = worldsArtifact()
  assert.ok(isWorldsArtifact(original))
  for (const value of [null, {}, { ...original, state: {} }, { ...original, state: { ...original.state, playIn: { results: [{}] } } }]) assert.equal(isWorldsArtifact(value), false)
  const event = worldsEvent()
  const originalKey = worldsFeedEventKey(event)
  event.series[0].teams[0].gameWins = 1
  assert.notEqual(worldsFeedEventKey(event), originalKey)
  const fetchBefore = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify(original), { status: 200 })
  try {
    await assert.rejects(loadWorldsArtifact(event, true, new AbortController().signal), /schedule revision/)
    await assert.rejects(loadWorldsArtifact(worldsEvent(), false, new AbortController().signal), /synthetic Worlds/)
    globalThis.fetch = async () => new Response(JSON.stringify({ ...original, dataMode: 'source-observation' }), { status: 200 })
    await assert.rejects(loadWorldsArtifact(worldsEvent(), false, new AbortController().signal), /Synthetic evidence cannot/)
  } finally { globalThis.fetch = fetchBefore }
})

test('a matching content key cannot hide omitted or conflicting source results, or a live series', async () => {
  const state = worldsFixture()
  const observed = state.playIn.results[0]
  const event = worldsEvent(state)
  event.series = [{ id: observed.matchId, eventId: event.id, startTime: null, stage: 'Play-In', status: 'completed', sourceState: 'completed', bestOf: 5,
    teams: observed.teamIds.map((id, slot) => ({ id, name: id, code: id, gameWins: observed.gameWins[slot], outcome: slot === 1 ? 'win' : 'loss' })), vodUrls: [] }]
  const fetchBefore = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify(worldsArtifact(state, event)), { status: 200 })
  try {
    await loadWorldsArtifact(event, true, new AbortController().signal)
    event.series[0].teams[0].gameWins = 0
    await assert.rejects(loadWorldsArtifact(event, true, new AbortController().signal), /contradicts the confirmed schedule/)
    event.series[0].teams[0].gameWins = observed.gameWins[0]
    state.playIn.results.shift()
    await assert.rejects(loadWorldsArtifact(event, true, new AbortController().signal), /must retain confirmed schedule result/)
    event.series[0].status = 'live'; event.series[0].sourceState = 'inProgress'
    await assert.rejects(loadWorldsArtifact(event, true, new AbortController().signal), /Live game conditioning is not supported/)
  } finally { globalThis.fetch = fetchBefore }
})

test('pre-Swiss companions require direct qualifier provenance and cannot label synthetic direct evidence as sourced', async () => {
  const state = worldsFixture('play-in')
  const event = worldsEvent(state)
  // Schedule membership is not proof of qualification, and schedules can precede populated matches.
  event.series = []
  const sourceEvidence = { kind: 'source-observation', reference: 'Retained entrant/draw observations and canonical identities' } as const
  state.playIn.evidence = { entrants: sourceEvidence, draw: sourceEvidence, results: sourceEvidence }
  const artifact = { ...worldsArtifact(state, event), dataMode: 'source-observation' as const }
  const fetchBefore = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify(artifact), { status: 200 })
  try {
    await assert.rejects(loadWorldsArtifact(event, false, new AbortController().signal), /Synthetic evidence cannot/)
    for (const reference of [undefined, '', '   ']) {
      if (reference === undefined) Reflect.deleteProperty(state, 'directEntrantEvidence')
      else state.directEntrantEvidence = { ...sourceEvidence, reference }
      assert.equal(isWorldsArtifact(artifact), false)
      await assert.rejects(loadWorldsArtifact(event, false, new AbortController().signal), /schema is unsupported or incomplete/)
    }
    state.directEntrantEvidence = sourceEvidence
    assert.equal(isWorldsArtifact(artifact), true)
    const loaded = await loadWorldsArtifact(event, false, new AbortController().signal)
    assert.equal(loaded.state.format, 'worlds-2026')
    assert.deepEqual(loaded.state.directEntrantEvidence, sourceEvidence)
  } finally { globalThis.fetch = fetchBefore }
})

test('terminal source states without results stay in the schedule but cannot become unplayed Worlds simulations', async () => {
  const observed = worldsFixture().playIn.results[0]
  const fetchBefore = globalThis.fetch
  try {
    for (const sourceState of ['complete', 'completed', 'COMPLETE', 'COMPLETED', 'unstarted']) {
      const feed = normalizeTournamentFeed({
        observations: [{ event: { state: sourceState, startTime: '2026-10-18T12:00:00Z', league: { slug: 'worlds' },
          match: { id: observed.matchId, strategy: { count: 5 }, teams: observed.teamIds.map((id) => ({ id })) } },
          detail: { tournament: { id: 'synthetic-worlds-terminal-state' } } }],
        fetchedAt: '2026-10-31T23:00:00Z', coverageStart: '2026-10-01T00:00:00Z', coverageEnd: '2026-11-01T00:00:00Z', coverageComplete: true,
      })
      const event = feed.events[0]
      const state = worldsFixture('play-in')
      state.playIn.eventId = event.id
      globalThis.fetch = async () => new Response(JSON.stringify(worldsArtifact(state, event)), { status: 200 })
      assert.ok(event.series[0].teams.every((team) => team.gameWins === null && team.outcome === null))
      if (sourceState === 'unstarted') {
        await loadWorldsArtifact(event, true, new AbortController().signal)
        assert.equal(groupTournamentSeries(event.series).upcoming.length, 1)
      } else {
        assert.equal(event.series[0].status, 'unknown')
        await assert.rejects(loadWorldsArtifact(event, true, new AbortController().signal), /terminal source series lacks a confirmed result/)
        assert.equal(groupTournamentSeries(event.series).unresolved[0].id, observed.matchId)
        // The same source series is supported once a confirmed score and matching observation arrive.
        event.series[0].status = 'completed'
        event.series[0].teams.forEach((team, slot) => { team.gameWins = observed.gameWins[slot] })
        state.playIn.results.push(structuredClone(observed))
        await loadWorldsArtifact(event, true, new AbortController().signal)
        assert.equal(groupTournamentSeries(event.series).results.length, 1)
      }
    }
  } finally { globalThis.fetch = fetchBefore }
})

test('cancelled series block unsupported advancement while postponed, delayed and upcoming schedules remain supported', async () => {
  const state = worldsFixture('play-in')
  const event = worldsEvent(state)
  event.series = [{ id: 'play-0', eventId: event.id, startTime: null, stage: 'Play-In', status: 'upcoming', sourceState: 'unstarted', bestOf: 5,
    teams: ['CBLOL2', 'LCS3'].map((id) => ({ id, name: id, code: id, gameWins: null, outcome: null })), vodUrls: [] }]
  const series = event.series[0]
  const fetchBefore = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify(worldsArtifact(state, event)), { status: 200 })
  try {
    for (const sourceState of ['cancelled', 'canceled', 'CANCELLED', 'CANCELED']) {
      series.sourceState = sourceState
      series.status = normalizeStatus(sourceState)
      await assert.rejects(loadWorldsArtifact(event, true, new AbortController().signal), /cancelled-series replacement, withdrawal and forfeit semantics are unsupported/)
      assert.equal(groupTournamentSeries(event.series).results[0].id, series.id)
      // Cancellation evidence must also win over an inconsistent normalized status.
      series.status = 'unknown'
      await assert.rejects(loadWorldsArtifact(event, true, new AbortController().signal), /cancelled-series replacement/)
    }
    series.sourceState = 'unknown'; series.status = 'cancelled'
    await assert.rejects(loadWorldsArtifact(event, true, new AbortController().signal), /cancelled-series replacement/)
    for (const sourceState of ['postponed', 'delayed', 'unstarted']) {
      series.sourceState = sourceState
      series.status = normalizeStatus(sourceState)
      await loadWorldsArtifact(event, true, new AbortController().signal)
      assert.equal(groupTournamentSeries(event.series).upcoming[0].id, series.id)
    }
  } finally { globalThis.fetch = fetchBefore }
})

test('a coherent companion cannot complete a scheduled match that the feed still marks unresolved', async () => {
  const state = worldsFixture()
  const observed = state.playIn.results[0]
  const event = worldsEvent(state)
  event.series = [{ id: observed.matchId, eventId: event.id, startTime: null, stage: 'Play-In', status: 'upcoming', sourceState: 'unstarted', bestOf: 5,
    teams: observed.teamIds.map((id) => ({ id, name: id, code: id, gameWins: null, outcome: null })), vodUrls: [] }]
  const series = event.series[0]
  const fetchBefore = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify(worldsArtifact(state, event)), { status: 200 })
  try {
    for (const sourceState of ['unstarted', 'postponed', 'delayed', 'unknown']) {
      series.sourceState = sourceState; series.status = normalizeStatus(sourceState)
      await assert.rejects(loadWorldsArtifact(event, true, new AbortController().signal), /before the schedule confirms its completion/)
      assert.equal(groupTournamentSeries(event.series).upcoming[0].id, observed.matchId)
    }
    series.sourceState = 'completed'; series.status = 'completed'
    series.teams.forEach((team, slot) => { team.gameWins = observed.gameWins[slot] })
    await loadWorldsArtifact(event, true, new AbortController().signal)
    // Earlier results may legitimately fall outside the bounded schedule window.
    event.series = []
    await loadWorldsArtifact(event, true, new AbortController().signal)
  } finally { globalThis.fetch = fetchBefore }
})

test('historical canonical game IDs reconcile schedule participants, orientation, completion, format and winner evidence', async () => {
  const state = historicalWorldsFixture()
  const event = historicalEvent(state)
  const original = structuredClone(event.series[0])
  const fetchBefore = globalThis.fetch
  globalThis.fetch = async () => {
    const artifact: WorldsArtifact = { version: 1, eventId: event.id, feedEventKey: worldsFeedEventKey(event), dataMode: 'synthetic-fixture', state }
    return new Response(JSON.stringify(artifact), { status: 200 })
  }
  try {
    await loadWorldsArtifact(event, true, new AbortController().signal)
    event.series[0].teams.reverse()
    await loadWorldsArtifact(event, true, new AbortController().signal)
    event.series = [structuredClone(original)]
    event.series[0].teams.forEach((team) => { team.outcome = null })
    await loadWorldsArtifact(event, true, new AbortController().signal)
    event.series = [structuredClone(original)]
    event.series[0].teams.forEach((team) => { team.gameWins = null })
    await loadWorldsArtifact(event, true, new AbortController().signal)
    const conflicts: Array<(series: TournamentSeries) => void> = [
      (series) => { series.teams[0].gameWins = 0; series.teams[1].gameWins = 1; series.teams[0].outcome = 'loss'; series.teams[1].outcome = 'win' },
      (series) => { series.teams[0].outcome = 'loss' },
      (series) => { series.teams[1].id = 'past-gamma' },
      (series) => { series.teams[0].id = 'other-group'; series.bestOf = 5 },
      (series) => { series.bestOf = 5 },
      (series) => { series.bestOf = null },
      (series) => { for (const team of series.teams) { team.gameWins = null; team.outcome = null } },
      (series) => { series.teams[1].gameWins = null; for (const team of series.teams) team.outcome = null },
      (series) => { series.teams[1].outcome = null; for (const team of series.teams) team.gameWins = null },
    ]
    for (const change of conflicts) {
      event.series = [structuredClone(original)]
      change(event.series[0])
      await assert.rejects(loadWorldsArtifact(event, true, new AbortController().signal), /Historical group replay.*schedule/)
    }
    for (const sourceState of ['unstarted', 'postponed', 'completed', 'inProgress', 'cancelled']) {
      event.series = [structuredClone(original)]
      const series = event.series[0]
      series.sourceState = sourceState; series.status = sourceState === 'completed' ? 'unknown' : normalizeStatus(sourceState)
      for (const team of series.teams) { team.gameWins = null; team.outcome = null }
      await assert.rejects(loadWorldsArtifact(event, true, new AbortController().signal), /Historical group replay.*schedule/)
    }
  } finally { globalThis.fetch = fetchBefore }
})

test('historical reconciliation preserves bounded windows and unrelated stages but never maps the two group legs by pair', async () => {
  const state = historicalWorldsFixture()
  const event = historicalEvent(state)
  const original = structuredClone(event.series[0])
  const fetchBefore = globalThis.fetch
  globalThis.fetch = async () => {
    const artifact: WorldsArtifact = { version: 1, eventId: event.id, feedEventKey: worldsFeedEventKey(event), dataMode: 'synthetic-fixture', state }
    return new Response(JSON.stringify(artifact), { status: 200 })
  }
  try {
    event.series[0].id = 'unlinked-third-leg'
    await assert.rejects(loadWorldsArtifact(event, true, new AbortController().signal), /must retain schedule result.*canonical series ID/)
    event.series[0].bestOf = null
    await assert.rejects(loadWorldsArtifact(event, true, new AbortController().signal), /schedule series.*known Bo1 format/)
    event.series[0].bestOf = 0
    await assert.rejects(loadWorldsArtifact(event, true, new AbortController().signal), /schedule series.*known Bo1 format/)
    event.series[0].bestOf = 5; event.series[0].stage = 'Knockout'
    await loadWorldsArtifact(event, true, new AbortController().signal)
    event.series[0] = { ...structuredClone(original), id: 'other-group-game', status: 'live', sourceState: 'inProgress' }
    event.series[0].teams.forEach((team, index) => { team.id = `other-group-${index}` })
    await loadWorldsArtifact(event, true, new AbortController().signal)
    event.series = []
    await loadWorldsArtifact(event, true, new AbortController().signal)
    assert.equal(state.group.games.length, 12, 'Observations outside the bounded schedule window remain retained.')
  } finally { globalThis.fetch = fetchBefore }
})
