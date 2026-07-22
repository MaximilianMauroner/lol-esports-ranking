import assert from 'node:assert/strict'
import test from 'node:test'
import type { MatchRecord, MatchRosterSnapshot, TeamProfile } from '../src/types.ts'
import { eventWeightContextForMatches } from '../src/lib/eventWeighting.ts'
import { ensureLeague } from '../src/lib/leagueRatings.ts'
import { matchesByDate } from '../src/lib/matchContext.ts'
import {
  finalizeRatingRunStateAtUtcBoundary,
  processRatingUtcDateBoundary,
} from '../src/lib/model.ts'
import { transparentGprModelMetadata } from '../src/lib/modelConfig.ts'
import { buildPregamePlayerRatingEdges } from '../src/lib/playerModel.ts'
import type { PlacementTournamentLifecycle } from '../src/lib/placementResiduals.ts'
import {
  decodeRatingCheckpoint,
  encodeRatingCheckpoint,
  RATING_CHECKPOINT_SCHEMA_VERSION,
  validateRatingCheckpoint,
  type RatingCheckpointIdentity,
} from '../src/lib/ratingCheckpoint.ts'
import {
  buildRatingCheckpointEventContract,
  ratingCheckpointInventory,
  reconcileRatingCheckpointEvents,
  selectRatingCheckpointReplayBoundary,
} from '../src/lib/ratingCheckpointInventory.ts'
import { createRatingRunState, type RatingRunState } from '../src/lib/ratingRunState.ts'

const checkpointIdentity: RatingCheckpointIdentity = {
  importerVersion: 'test-importer-v1',
  identityTaxonomyHash: 'taxonomy-test-v1',
  rawLedgerPrefixHash: 'raw-prefix-test-v1',
}

const teams: Record<string, TeamProfile> = {
  Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
  Beta: { name: 'Beta', code: 'BET', region: 'LCK', league: 'LCK' },
  Gamma: { name: 'Gamma', code: 'GAM', region: 'LPL', league: 'LPL' },
  Delta: { name: 'Delta', code: 'DEL', region: 'LPL', league: 'LPL' },
}

test('checkpoint exhaustively and losslessly round-trips every RatingRunState field', () => {
  const matches = replayMatches()
  const state = completeRun(matches)
  const checkpoint = encodeAtBoundary(state, '2026-01-03', matches)
  const decoded = decodeRatingCheckpoint(checkpoint, checkpointIdentity)

  assert.deepEqual(decoded.state, state)
  assert.equal(decoded.metadata.schemaVersion, RATING_CHECKPOINT_SCHEMA_VERSION)
  assert.equal(decoded.metadata.modelVersion, transparentGprModelMetadata.version)
  assert.equal(decoded.metadata.modelConfigHash, transparentGprModelMetadata.configHash)
  assert.equal(decoded.metadata.processedThroughUtcDate, '2026-01-03')
  assert.equal(decoded.metadata.processedThroughMatchId, state.previousMatch?.id)
  assert.match(decoded.metadata.eventContract.eventContextFingerprint, /^fnv1a64-/)
  assert.match(decoded.metadata.eventContract.eventInventoryFingerprint, /^fnv1a64-/)
  assert.deepEqual(
    [...ratingCheckpointInventory.includedFields].sort(),
    Object.keys(state).sort(),
  )
  assert.deepEqual(
    ratingCheckpointInventory.externalState.map((entry) => entry.status),
    ['external-deferred', 'external-deferred', 'external-deferred'],
  )
})

test('semantically identical maps and sets serialize byte-identically regardless of insertion order', () => {
  const state = completeRun(replayMatches())
  const serialized = encodeAtBoundary(state, '2026-01-03', replayMatches())
  const reordered = decodeRatingCheckpoint(serialized, checkpointIdentity).state
  reordered.ratings = reverseMap(reordered.ratings)
  reordered.histories = reverseMap(reordered.histories)
  reordered.eventWeightContext = {
    worldsEndDateByCalendarYear: new Map(
      [...reordered.eventWeightContext.worldsEndDateByCalendarYear.entries()].reverse(),
    ),
  }
  for (const tracker of reordered.eventTrackers.values()) {
    tracker.participants = new Set([...tracker.participants].reverse())
    tracker.teamLeagues = reverseMap(tracker.teamLeagues)
    tracker.preEventPowers = reverseMap(tracker.preEventPowers)
  }

  assert.equal(encodeAtBoundary(reordered, '2026-01-03', replayMatches()), serialized)
})

test('checkpoint validation fails closed for corruption and every invalidation identity', () => {
  const serialized = encodeAtBoundary(completeRun(replayMatches()), '2026-01-03', replayMatches())
  assertInvalid(serialized.replace('"processedMatchCount":3', '"processedMatchCount":4'), checkpointIdentity, 'payload-digest')
  assertInvalid(
    serialized.replace('"schemaVersion":2', '"schemaVersion":99'),
    checkpointIdentity,
    'schema-version',
  )
  assertInvalid(
    serialized.replace(transparentGprModelMetadata.configHash, 'fnv1a-deadbeef'),
    checkpointIdentity,
    'model-config',
  )
  assertInvalid(
    serialized.replace(transparentGprModelMetadata.version, 'transparent-power-index-other'),
    checkpointIdentity,
    'model-version',
  )
  assertInvalid(serialized, { ...checkpointIdentity, importerVersion: 'test-importer-v2' }, 'importer-version')
  assertInvalid(serialized, { ...checkpointIdentity, identityTaxonomyHash: 'taxonomy-test-v2' }, 'identity-taxonomy')
  assertInvalid(serialized, { ...checkpointIdentity, rawLedgerPrefixHash: 'other-prefix' }, 'raw-ledger-prefix')
  assertInvalid('{not-json', checkpointIdentity, 'malformed')
})

test('terminal match identity and exact UTC boundary are mandatory', () => {
  const matches = replayMatches()
  const serialized = encodeAtBoundary(completeRun(matches), '2026-01-03', matches)
  assertInvalid(
    serialized.replace('"processedThroughMatchId":"day-three"', '"processedThroughMatchId":null'),
    checkpointIdentity,
    'malformed',
  )
  assertInvalid(
    serialized.replace('"processedThroughMatchId":"day-three"', '"processedThroughMatchId":"day-two"'),
    checkpointIdentity,
    'boundary-mismatch',
  )
  assertInvalid(
    serialized.replace('"processedThroughUtcDate":"2026-01-03"', '"processedThroughUtcDate":"2026-01-02"'),
    checkpointIdentity,
    'boundary-mismatch',
  )
  assertInvalid(
    serialized.replace('"processedThroughUtcDate":"2026-01-03"', '"processedThroughUtcDate":"2026-02-30"'),
    checkpointIdentity,
    'boundary-mismatch',
  )
})

test('checkpoint encoding rejects an event inventory derived from future corpus rows', () => {
  const matches = worldsMatches()
  const state = prepareState(matches)
  processDates(state, matches, (date) => date === '2026-10-20')

  assert.throws(
    () => encodeAtBoundary(state, '2026-10-20', matches),
    (error) => error instanceof Error
      && error.name === 'InvalidRatingCheckpointError'
      && /event inventory\/context/.test(error.message),
  )
})

test('canonical Map and Set ordering uses locale-independent code units for case and accents', () => {
  const names = ['A-team', 'a-team', 'É-team', 'ä-team', 'é-team']
  const matches = [
    internationalFixture('accent-one', names[0]!, names[1]!),
    internationalFixture('accent-two', names[2]!, names[3]!),
    internationalFixture('accent-three', names[4]!, names[0]!),
  ]
  const state = completeRun(matches)
  const serialized = encodeAtBoundary(state, '2026-01-03', matches)
  const reordered = decodeRatingCheckpoint(serialized, checkpointIdentity).state
  reordered.ratings = reverseMap(reordered.ratings)
  const tracker = reordered.eventTrackers.get('first-stand:2026')
  assert.ok(tracker)
  tracker.participants = new Set([...tracker.participants].reverse())
  tracker.preEventPowers = reverseMap(tracker.preEventPowers)

  assert.equal(encodeAtBoundary(reordered, '2026-01-03', matches), serialized)
  assert.match(serialized, /"participants":\["A-team","a-team","É-team","ä-team","é-team"\]/)
})

test('append resume from a decoded predecessor checkpoint equals a clean full replay', () => {
  const matches = replayMatches()
  const clean = completeRun(matches)
  const prefix = matches.filter((match) => match.date <= '2026-01-02')
  const partial = prepareState(prefix)
  processDates(partial, prefix, () => true)
  finalizeRatingRunStateAtUtcBoundary(partial, cloneTeams())
  const resumed = reconcileReadyState(
    decodeRatingCheckpoint(encodeAtBoundary(partial, '2026-01-02', prefix), checkpointIdentity),
    matches,
  )
  processDates(resumed, matches, (date) => date > '2026-01-02')
  finalizeRatingRunStateAtUtcBoundary(resumed, cloneTeams())

  assert.deepEqual(resumed, clean)
})

test('same-day insertion resumes only from the predecessor and replays the whole UTC date', () => {
  const original = replayMatches()
  const inserted = matchFixture({
    id: 'same-day-insertion',
    date: '2026-01-02',
    teamA: 'Alpha',
    teamB: 'Gamma',
    teamAHomeLeague: 'LCK',
    teamBHomeLeague: 'LPL',
    teamARegion: 'LCK',
    teamBRegion: 'LPL',
    region: 'International',
    league: 'First Stand',
    event: 'First Stand 2026',
    tier: 'minor-international',
    winner: 'Gamma',
  })
  const corrected = [...original, inserted]
  const prefix = corrected.filter((match) => match.date < '2026-01-02')
  const predecessor = prepareState(prefix)
  processDates(predecessor, prefix, () => true)
  const resumed = reconcileReadyState(
    decodeRatingCheckpoint(encodeAtBoundary(predecessor, '2026-01-01', prefix), checkpointIdentity),
    corrected,
  )
  processDates(resumed, corrected, (date) => date >= '2026-01-02')
  finalizeRatingRunStateAtUtcBoundary(resumed, cloneTeams())

  assert.deepEqual(resumed, completeRun(corrected))
  assert.deepEqual(selectRatingCheckpointReplayBoundary({
    availableProcessedThroughUtcDates: ['2026-01-01', '2026-01-02'],
    changedUtcDate: '2026-01-02',
  }), {
    changedUtcDate: '2026-01-02',
    replayFromUtcDate: '2026-01-02',
    resumeAfterUtcDate: '2026-01-01',
    requiresFullReplay: false,
    requiresWholeUtcDateReplay: true,
    reason: 'predecessor-boundary',
  })
})

test('historical correction replays from its predecessor through the current boundary', () => {
  const corrected = replayMatches().map((match) => match.id === 'day-two'
    ? { ...match, winner: match.teamB }
    : match)
  const prefix = corrected.filter((match) => match.date < '2026-01-02')
  const predecessor = prepareState(prefix)
  processDates(predecessor, prefix, () => true)
  const resumed = reconcileReadyState(
    decodeRatingCheckpoint(encodeAtBoundary(predecessor, '2026-01-01', prefix), checkpointIdentity),
    corrected,
  )
  processDates(resumed, corrected, (date) => date >= '2026-01-02')
  finalizeRatingRunStateAtUtcBoundary(resumed, cloneTeams())

  assert.deepEqual(resumed, completeRun(corrected))
})

test('a newly discovered future event merges safely and preserves pre-event powers and placement behavior', () => {
  const prefix = [matchFixture({ id: 'pre-worlds', date: '2026-09-01' })]
  const matches = [...prefix, ...worldsMatches()]
  const lifecycles = completedWorldsLifecycle()
  const clean = completeRun(matches, lifecycles)
  const partial = prepareState(prefix)
  processDates(partial, prefix, () => true)
  finalizeRatingRunStateAtUtcBoundary(partial, cloneTeams())
  const checkpoint = decodeRatingCheckpoint(
    encodeAtBoundary(partial, '2026-09-01', prefix),
    checkpointIdentity,
  )
  const reconciliation = reconcileRatingCheckpointEvents({
    checkpoint,
    freshMatches: matches,
    freshEventWeightContext: eventWeightContextForMatches(matches),
    freshTournamentLifecycles: lifecycles,
  })
  assert.equal(reconciliation.status, 'ready')
  if (reconciliation.status !== 'ready') throw new Error('Expected future event merge')
  assert.deepEqual(reconciliation.mergedFutureEventIds, ['worlds:2026'])
  const resumed = reconciliation.state
  processDates(resumed, matches, (date) => date > '2026-09-01')
  finalizeRatingRunStateAtUtcBoundary(resumed, cloneTeams())

  assert.deepEqual(resumed, clean)
  assert.equal([...resumed.eventTrackers.values()].every((tracker) => tracker.applied), true)
  assert.ok([...resumed.leaguePlacementDeltas.values()].some((delta) => delta !== 0))
  const tracker = resumed.eventTrackers.get('worlds:2026')
  assert.ok(tracker)
  assert.equal(tracker.preEventPowers.size, tracker.participants.size)
  assert.equal([...tracker.participants].every((team) => tracker.preEventPowers.has(team)), true)
})

test('changes to an already-started event return a predecessor replay boundary', () => {
  const storedLifecycle = ongoingWorldsLifecycle('2026-10-20')
  const prefix = [worldsMatches()[0]!]
  const state = completeRun(prefix, storedLifecycle)
  const checkpoint = decodeRatingCheckpoint(
    encodeAtBoundary(state, '2026-10-20', prefix, storedLifecycle),
    checkpointIdentity,
  )

  const participantAndEndDateChange = reconcileRatingCheckpointEvents({
    checkpoint,
    freshMatches: worldsMatches().slice(0, 2),
    freshEventWeightContext: eventWeightContextForMatches(worldsMatches().slice(0, 2)),
    freshTournamentLifecycles: ongoingWorldsLifecycle('2026-10-21'),
    availableProcessedThroughUtcDates: ['2026-09-01', '2026-10-20'],
  })
  assert.deepEqual(participantAndEndDateChange, {
    status: 'replay-required',
    replayFromUtcDate: '2026-10-20',
    resumeAfterUtcDate: '2026-09-01',
    requiresFullReplay: false,
    reason: 'event-structure-changed',
    affectedEventIds: ['worlds:2026'],
  })

  const lifecycleChange = reconcileRatingCheckpointEvents({
    checkpoint,
    freshMatches: prefix,
    freshEventWeightContext: eventWeightContextForMatches(prefix),
    freshTournamentLifecycles: completedWorldsAt('2026-10-20'),
  })
  assert.deepEqual(lifecycleChange, {
    status: 'replay-required',
    replayFromUtcDate: '2026-10-20',
    requiresFullReplay: true,
    reason: 'event-structure-changed',
    affectedEventIds: ['worlds:2026'],
  })
})

test('event context or event-weight changes cannot silently resume the immediate predecessor', () => {
  const matches = replayMatches()
  const state = completeRun(matches)
  const checkpoint = decodeRatingCheckpoint(
    encodeAtBoundary(state, '2026-01-03', matches),
    checkpointIdentity,
  )
  const changedContext = { worldsEndDateByCalendarYear: new Map([[2026, '2026-01-01']]) }
  const result = reconcileRatingCheckpointEvents({
    checkpoint,
    freshMatches: matches,
    freshEventWeightContext: changedContext,
    availableProcessedThroughUtcDates: ['2025-12-31', '2026-01-02'],
  })

  assert.deepEqual(result, {
    status: 'replay-required',
    replayFromUtcDate: '2026-01-02',
    resumeAfterUtcDate: '2025-12-31',
    requiresFullReplay: false,
    reason: 'event-context-changed',
    affectedEventIds: ['first-stand:2026'],
  })
})

test('manual invalidation always signals a full replay fallback', () => {
  assert.deepEqual(selectRatingCheckpointReplayBoundary({
    availableProcessedThroughUtcDates: ['2026-01-01', '2026-01-02'],
    changedUtcDate: '2026-01-03',
    forceFullReplay: true,
  }), {
    changedUtcDate: '2026-01-03',
    replayFromUtcDate: '2026-01-03',
    requiresFullReplay: true,
    requiresWholeUtcDateReplay: true,
    reason: 'manual-full-invalidation',
  })
})

function completeRun(
  matches: MatchRecord[],
  tournamentLifecycles: ReadonlyMap<string, PlacementTournamentLifecycle> = new Map(),
) {
  const state = prepareState(matches, tournamentLifecycles)
  processDates(state, matches, () => true)
  finalizeRatingRunStateAtUtcBoundary(state, cloneTeams())
  return state
}

function prepareState(
  matches: MatchRecord[],
  tournamentLifecycles: ReadonlyMap<string, PlacementTournamentLifecycle> = new Map(),
) {
  const sorted = sortedMatches(matches)
  const stateTeams = cloneTeams()
  const eventWeightContext = eventWeightContextForMatches(sorted)
  const state = createRatingRunState(sorted, stateTeams, eventWeightContext, tournamentLifecycles)
  for (const profile of Object.values(stateTeams)) {
    ensureLeague(
      profile.league,
      state.leagueScores,
      state.previousLeagueScores,
      state.leagueWins,
      state.leagueLosses,
      state.leagueExpectedWins,
      state.leagueOpponentRatingSums,
      state.leagueForms,
      state.leagueMatchCounts,
    )
  }
  return state
}

function processDates(
  state: RatingRunState,
  matches: MatchRecord[],
  includeDate: (date: string) => boolean,
) {
  const sorted = sortedMatches(matches)
  const stateTeams = cloneTeams()
  const pregamePlayerRatingEdges = buildPregamePlayerRatingEdges(sorted, {
    teams: stateTeams,
    eventWeightContext: eventWeightContextForMatches(sorted),
  })
  const lastDate = sorted.at(-1)?.date ?? '2026-01-01'
  for (const dateMatches of matchesByDate(sorted)) {
    const date = dateMatches[0]?.date
    if (!date || !includeDate(date)) continue
    processRatingUtcDateBoundary({
      dateMatches,
      teams: stateTeams,
      state,
      lastDate,
      pregamePlayerRatingEdges,
    })
  }
}

function encodeAtBoundary(
  state: RatingRunState,
  processedThroughUtcDate: string,
  prefixMatches: MatchRecord[],
  tournamentLifecycles: ReadonlyMap<string, PlacementTournamentLifecycle> = new Map(),
) {
  const eventWeightContext = eventWeightContextForMatches(prefixMatches)
  return encodeRatingCheckpoint(state, checkpointIdentity, {
    processedThroughUtcDate,
    processedThroughMatchId: state.previousMatch?.id ?? '',
  }, buildRatingCheckpointEventContract(prefixMatches, eventWeightContext, tournamentLifecycles))
}

function reconcileReadyState(
  checkpoint: ReturnType<typeof decodeRatingCheckpoint>,
  freshMatches: MatchRecord[],
  freshTournamentLifecycles: ReadonlyMap<string, PlacementTournamentLifecycle> = new Map(),
) {
  const result = reconcileRatingCheckpointEvents({
    checkpoint,
    freshMatches,
    freshEventWeightContext: eventWeightContextForMatches(freshMatches),
    freshTournamentLifecycles,
  })
  assert.equal(result.status, 'ready')
  if (result.status !== 'ready') throw new Error('Expected event reconciliation to be ready')
  return result.state
}

function assertInvalid(
  serialized: string,
  identity: RatingCheckpointIdentity,
  reason: ReturnType<typeof validateRatingCheckpoint> extends infer Result
    ? Result extends { ok: false; reason: infer Reason } ? Reason : never
    : never,
) {
  const result = validateRatingCheckpoint(serialized, identity)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, reason)
  assert.equal(result.requiresFullReplay, true)
}

function replayMatches() {
  return [
    matchFixture({
      id: 'day-one',
      date: '2026-01-01',
      teamARoster: rosterFixture('alpha', 'blue', true),
      teamBRoster: rosterFixture('beta', 'red', false),
      teamASide: 'blue',
      teamBSide: 'red',
    }),
    matchFixture({
      id: 'day-two',
      date: '2026-01-02',
      teamA: 'Gamma',
      teamB: 'Delta',
      teamAHomeLeague: 'LPL',
      teamBHomeLeague: 'LPL',
      teamARegion: 'LPL',
      teamBRegion: 'LPL',
      region: 'LPL',
      league: 'LPL',
      event: 'LPL 2026 Split 1',
      winner: 'Delta',
      patch: '26.2',
      teamARoster: rosterFixture('gamma', 'red', false),
      teamBRoster: rosterFixture('delta', 'blue', true),
      teamASide: 'red',
      teamBSide: 'blue',
    }),
    matchFixture({
      id: 'day-three',
      date: '2026-01-03',
      event: 'First Stand 2026',
      league: 'First Stand',
      region: 'International',
      tier: 'minor-international',
      teamA: 'Alpha',
      teamB: 'Gamma',
      teamAHomeLeague: 'LCK',
      teamBHomeLeague: 'LPL',
      teamARegion: 'LCK',
      teamBRegion: 'LPL',
      winner: 'Alpha',
    }),
  ]
}

function worldsMatches() {
  return [
    matchFixture({
      id: 'worlds-quarter-a',
      date: '2026-10-20',
      event: 'Worlds 2026 Playoffs',
      phase: 'Quarterfinals',
      league: 'Worlds',
      region: 'International',
      tier: 'worlds-playoffs',
      teamA: 'Alpha',
      teamB: 'Gamma',
      teamAHomeLeague: 'LCK',
      teamBHomeLeague: 'LPL',
      teamARegion: 'LCK',
      teamBRegion: 'LPL',
      winner: 'Alpha',
    }),
    matchFixture({
      id: 'worlds-quarter-b',
      date: '2026-10-21',
      event: 'Worlds 2026 Playoffs',
      phase: 'Quarterfinals',
      league: 'Worlds',
      region: 'International',
      tier: 'worlds-playoffs',
      teamA: 'Beta',
      teamB: 'Delta',
      teamAHomeLeague: 'LCK',
      teamBHomeLeague: 'LPL',
      teamARegion: 'LCK',
      teamBRegion: 'LPL',
      winner: 'Beta',
    }),
    matchFixture({
      id: 'worlds-final',
      date: '2026-11-02',
      event: 'Worlds 2026 Playoffs',
      phase: 'Final',
      league: 'Worlds',
      region: 'International',
      tier: 'worlds-playoffs',
      teamA: 'Alpha',
      teamB: 'Beta',
      teamAHomeLeague: 'LCK',
      teamBHomeLeague: 'LCK',
      teamARegion: 'LCK',
      teamBRegion: 'LCK',
      winner: 'Alpha',
    }),
  ]
}

function completedWorldsLifecycle(): ReadonlyMap<string, PlacementTournamentLifecycle> {
  return new Map([['worlds:2026', {
    status: 'completed',
    boundaryDate: '2026-11-02',
    ratedThroughDate: '2026-11-02',
    dataLag: false,
    resultCoverageComplete: true,
  }]])
}

function ongoingWorldsLifecycle(boundaryDate: string): ReadonlyMap<string, PlacementTournamentLifecycle> {
  return new Map([['worlds:2026', {
    status: 'ongoing',
    boundaryDate,
    ratedThroughDate: boundaryDate,
    dataLag: false,
    resultCoverageComplete: false,
  }]])
}

function completedWorldsAt(boundaryDate: string): ReadonlyMap<string, PlacementTournamentLifecycle> {
  return new Map([['worlds:2026', {
    status: 'completed',
    boundaryDate,
    ratedThroughDate: boundaryDate,
    dataLag: false,
    resultCoverageComplete: true,
  }]])
}

function internationalFixture(id: string, teamA: string, teamB: string) {
  return matchFixture({
    id,
    date: '2026-01-03',
    event: 'First Stand 2026',
    league: 'First Stand',
    region: 'International',
    tier: 'minor-international',
    teamA,
    teamB,
    teamAHomeLeague: 'LCK',
    teamBHomeLeague: 'LPL',
    teamARegion: 'LCK',
    teamBRegion: 'LPL',
    winner: teamA,
  })
}

function matchFixture(overrides: Partial<MatchRecord>): MatchRecord {
  return {
    id: 'fixture',
    sourceProvider: 'oracles-elixir',
    sourceGameId: 'fixture',
    dataCompleteness: 'scoreboard-game-stats',
    date: '2026-01-01',
    season: 2026,
    event: 'LCK 2026 Spring',
    phase: 'Regular season',
    region: 'LCK',
    league: 'LCK',
    teamAHomeLeague: 'LCK',
    teamBHomeLeague: 'LCK',
    teamARegion: 'LCK',
    teamBRegion: 'LCK',
    patch: '26.1',
    bestOf: 1,
    tier: 'regional-regular',
    teamA: 'Alpha',
    teamB: 'Beta',
    winner: 'Alpha',
    teamAKills: 20,
    teamBKills: 12,
    teamAGold: 65_000,
    teamBGold: 59_000,
    ...overrides,
  }
}

function rosterFixture(prefix: string, side: 'blue' | 'red', won: boolean): MatchRosterSnapshot {
  const roles = ['Top', 'Jungle', 'Mid', 'Bot', 'Support'] as const
  return {
    sourceProvider: 'oracles-elixir',
    teamId: prefix,
    observedAt: '2026-01-01',
    completeness: 'complete-five-role',
    players: roles.map((role) => ({
      id: `${prefix}-${role}`,
      name: `${prefix} ${role}`,
      role,
      stats: {
        side,
        won,
        kills: won ? 4 : 2,
        deaths: won ? 2 : 4,
        assists: won ? 9 : 5,
        damageShare: 0.2,
        earnedGoldShare: 0.2,
        vspm: role === 'Support' ? 2.2 : 1,
      },
    })),
  }
}

function sortedMatches(matches: MatchRecord[]) {
  return matches.toSorted((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id))
}

function cloneTeams() {
  return Object.fromEntries(Object.entries(teams).map(([name, profile]) => [name, { ...profile }]))
}

function reverseMap<Key, Value>(map: Map<Key, Value>) {
  return new Map([...map.entries()].reverse())
}
