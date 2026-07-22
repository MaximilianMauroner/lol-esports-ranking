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
  ratingCheckpointInventory,
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
  const checkpoint = encodeAtBoundary(state, '2026-01-03')
  const decoded = decodeRatingCheckpoint(checkpoint, checkpointIdentity)

  assert.deepEqual(decoded.state, state)
  assert.equal(decoded.metadata.schemaVersion, RATING_CHECKPOINT_SCHEMA_VERSION)
  assert.equal(decoded.metadata.modelConfigHash, transparentGprModelMetadata.configHash)
  assert.equal(decoded.metadata.processedThroughUtcDate, '2026-01-03')
  assert.equal(decoded.metadata.processedThroughSeriesId, state.previousMatch?.id)
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
  const serialized = encodeAtBoundary(state, '2026-01-03')
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

  assert.equal(encodeAtBoundary(reordered, '2026-01-03'), serialized)
})

test('checkpoint validation fails closed for corruption and every invalidation identity', () => {
  const serialized = encodeAtBoundary(completeRun(replayMatches()), '2026-01-03')
  assertInvalid(serialized.replace('"processedMatchCount":3', '"processedMatchCount":4'), checkpointIdentity, 'payload-digest')
  assertInvalid(
    serialized.replace('"schemaVersion":1', '"schemaVersion":99'),
    checkpointIdentity,
    'schema-version',
  )
  assertInvalid(
    serialized.replace(transparentGprModelMetadata.configHash, 'fnv1a-deadbeef'),
    checkpointIdentity,
    'model-config',
  )
  assertInvalid(serialized, { ...checkpointIdentity, importerVersion: 'test-importer-v2' }, 'importer-version')
  assertInvalid(serialized, { ...checkpointIdentity, identityTaxonomyHash: 'taxonomy-test-v2' }, 'identity-taxonomy')
  assertInvalid(serialized, { ...checkpointIdentity, rawLedgerPrefixHash: 'other-prefix' }, 'raw-ledger-prefix')
  assertInvalid('{not-json', checkpointIdentity, 'malformed')
})

test('append resume from a decoded predecessor checkpoint equals a clean full replay', () => {
  const matches = replayMatches()
  const clean = completeRun(matches)
  const partial = prepareState(matches)
  processDates(partial, matches, (date) => date <= '2026-01-02')
  finalizeRatingRunStateAtUtcBoundary(partial, cloneTeams())
  const resumed = decodeRatingCheckpoint(encodeAtBoundary(partial, '2026-01-02'), checkpointIdentity).state
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
  const predecessor = prepareState(corrected)
  processDates(predecessor, corrected, (date) => date < '2026-01-02')
  const resumed = decodeRatingCheckpoint(encodeAtBoundary(predecessor, '2026-01-01'), checkpointIdentity).state
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
  const predecessor = prepareState(corrected)
  processDates(predecessor, corrected, (date) => date < '2026-01-02')
  const resumed = decodeRatingCheckpoint(encodeAtBoundary(predecessor, '2026-01-01'), checkpointIdentity).state
  processDates(resumed, corrected, (date) => date >= '2026-01-02')
  finalizeRatingRunStateAtUtcBoundary(resumed, cloneTeams())

  assert.deepEqual(resumed, completeRun(corrected))
})

test('placement tournament completion remains deterministic across a boundary resume', () => {
  const matches = worldsMatches()
  const lifecycles = completedWorldsLifecycle()
  const clean = completeRun(matches, lifecycles)
  const partial = prepareState(matches, lifecycles)
  processDates(partial, matches, (date) => date < '2026-11-02')
  finalizeRatingRunStateAtUtcBoundary(partial, cloneTeams())
  const resumed = decodeRatingCheckpoint(encodeAtBoundary(partial, '2026-10-21'), checkpointIdentity).state
  processDates(resumed, matches, (date) => date >= '2026-11-02')
  finalizeRatingRunStateAtUtcBoundary(resumed, cloneTeams())

  assert.deepEqual(resumed, clean)
  assert.equal([...resumed.eventTrackers.values()].every((tracker) => tracker.applied), true)
  assert.ok([...resumed.leaguePlacementDeltas.values()].some((delta) => delta !== 0))
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

function encodeAtBoundary(state: RatingRunState, processedThroughUtcDate: string) {
  return encodeRatingCheckpoint(state, checkpointIdentity, {
    processedThroughUtcDate,
    processedThroughSeriesId: state.previousMatch?.id ?? null,
  })
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
