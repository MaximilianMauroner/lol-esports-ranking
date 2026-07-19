import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildPlayerModel,
  finalizePlayerModelReducer,
  initializePlayerModelReducer,
  processPlayerModelDateBatch,
  restorePlayerModelReducer,
  snapshotPlayerModelReducer,
} from '../src/lib/playerModel.ts'
import { runIncrementalPlayerReducer } from '../src/lib/incremental/playerReducer.ts'
import { reducerCheckpointRetentionDates } from '../src/lib/incremental/reducerCheckpoint.ts'
import { runIncrementalRankingReducers } from '../src/lib/incremental/rankingReducer.ts'
import { buildRankingModel } from '../src/lib/model.ts'
import { assertCrunchParity } from '../src/lib/incremental/parity.ts'
import { createPublicArtifactWritePlan } from '../src/lib/publicArtifacts/writePlan.ts'
import { createStaticRankingData } from '../src/lib/snapshot.ts'
import { createIncrementalCrunchReceipt, recordIncrementalReducerCandidate } from '../src/lib/incremental/metrics.ts'
import { orchestrateCrunch } from '../src/lib/incremental/orchestrator.ts'
import type { IncrementalReducerCheckpoint } from '../src/lib/incremental/reducerCheckpoint.ts'
import type { IncrementalPlayerCheckpoint } from '../src/lib/incremental/playerReducer.ts'
import type { LeagueStrength, MatchRecord, PlayerProfile, Role, Side, TeamProfile } from '../src/types.ts'

const teams: Record<string, TeamProfile> = {
  Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
  Beta: { name: 'Beta', code: 'BET', region: 'LCK', league: 'LCK' },
}

test('sourced player lifecycle restores a date checkpoint with exact full-corpus residual controls', () => {
  const matches = sourcedMatches()
  const expected = buildPlayerModel(matches, {}, { teams })
  const reducer = initializePlayerModelReducer(matches, {}, { teams })
  processPlayerModelDateBatch(reducer, [matches[0]!])
  processPlayerModelDateBatch(reducer, [matches[1]!])
  const checkpoint = snapshotPlayerModelReducer(reducer)
  const checkpointBeforeFinalize = structuredClone(checkpoint)

  finalizePlayerModelReducer(reducer)
  assert.deepEqual(checkpoint, checkpointBeforeFinalize)

  const restored = restorePlayerModelReducer(checkpoint, matches, {}, { teams })
  processPlayerModelDateBatch(restored, [matches[2]!])
  assert.deepEqual(finalizePlayerModelReducer(restored), expected)
})

test('static player lifecycle restores without changing seeded roster output', () => {
  const rosters = staticRosters()
  const matches = [staticMatch('static-1', '2026-01-01', 'Alpha'), staticMatch('static-2', '2026-01-02', 'Beta')]
  const expected = buildPlayerModel(matches, rosters, { teams })
  const reducer = initializePlayerModelReducer(matches, rosters, { teams })
  processPlayerModelDateBatch(reducer, [matches[0]!])
  const restored = restorePlayerModelReducer(snapshotPlayerModelReducer(reducer), matches, rosters, { teams })
  processPlayerModelDateBatch(restored, [matches[1]!])
  assert.deepEqual(finalizePlayerModelReducer(restored), expected)
})

test('incremental static mode preserves legacy stable same-date input order', () => {
  const rosters = staticRosters()
  const matches = [
    staticMatch('z-later-id-first-input', '2026-01-01', 'Alpha'),
    staticMatch('a-earlier-id-second-input', '2026-01-01', 'Beta'),
  ]
  const expected = buildPlayerModel(matches, rosters, { teams })
  const incremental = runIncrementalPlayerReducer({ matches, rosters, teams, leagueStrengths: [] })
  assert.deepEqual(incremental.players, expected)
  assert.deepEqual(
    incremental.players.find((player) => player.id === 'alpha-Mid')?.history,
    expected.find((player) => player.id === 'alpha-Mid')?.history,
  )
})

test('static same-date input reorder rejects stale checkpoint and replays clean full', () => {
  const rosters = staticRosters()
  const matches = [
    staticMatch('z-static-first', '2026-01-01', 'Alpha'),
    staticMatch('a-static-second', '2026-01-01', 'Beta'),
  ]
  const baseline = runIncrementalPlayerReducer({ matches, rosters, teams, leagueStrengths: [] })
  const reordered = [matches[1]!, matches[0]!]
  const replayed = runIncrementalPlayerReducer({
    matches: reordered,
    rosters,
    teams,
    leagueStrengths: [],
    checkpointHistory: baseline.checkpoints,
  })
  assert.equal(replayed.selectedCheckpointDate, undefined)
  assert.equal(replayed.rows, 20)
  assert.deepEqual(replayed.players, buildPlayerModel(reordered, rosters, { teams, leagueStrengths: [] }))
  assert.notDeepEqual(replayed.players, baseline.players)
})

test('sourced same-date input reorder keeps deterministic ID order and checkpoint reuse', () => {
  const matches = [
    sourcedMatch('z-sourced-first', '2026-01-01', 'Alpha'),
    sourcedMatch('a-sourced-second', '2026-01-01', 'Beta'),
  ]
  const baseline = runIncrementalPlayerReducer({ matches, rosters: {}, teams, leagueStrengths: [] })
  const reordered = runIncrementalPlayerReducer({
    matches: [matches[1]!, matches[0]!],
    rosters: {},
    teams,
    leagueStrengths: [],
    checkpointHistory: baseline.checkpoints,
  })
  assert.equal(reordered.selectedCheckpointDate, '2026-01-01')
  assert.equal(reordered.rows, 0)
  assert.deepEqual(reordered.players, baseline.players)
  assert.deepEqual(reordered.players, buildPlayerModel([matches[1]!, matches[0]!], {}, { teams, leagueStrengths: [] }))
})

test('long corpus snapshots only retained checkpoint dates without output drift', () => {
  const rosters = staticRosters()
  const start = Date.UTC(2025, 0, 1)
  const matches = Array.from({ length: 180 }, (_, index) => staticMatch(
    `long-${String(index).padStart(3, '0')}`,
    new Date(start + index * 86_400_000).toISOString().slice(0, 10),
    index % 2 === 0 ? 'Alpha' : 'Beta',
  ))
  const incremental = runIncrementalPlayerReducer({ matches, rosters, teams, leagueStrengths: [] })
  const retainedDates = [...reducerCheckpointRetentionDates(matches).values()]
    .filter((classes) => classes.length > 0).length
  assert.equal(incremental.checkpointSnapshots, retainedDates)
  assert.ok(incremental.checkpointSnapshots < matches.length / 3)
  assert.deepEqual(incremental.players, buildPlayerModel(matches, rosters, { teams }))
})

test('incremental player reducer reuses append suffix and produces zero-row warm no-change runs', () => {
  const matches = sourcedMatches()
  const first = runIncrementalPlayerReducer({ matches: matches.slice(0, 2), rosters: {}, teams, leagueStrengths: [] })
  const appended = runIncrementalPlayerReducer({
    matches,
    rosters: {},
    teams,
    leagueStrengths: [],
    checkpointHistory: first.checkpoints,
  })
  assert.equal(appended.selectedCheckpointDate, '2026-01-02')
  assert.equal(appended.rows, 10)
  assert.deepEqual(appended.players, buildPlayerModel(matches, {}, { teams, leagueStrengths: [] }))

  const warm = runIncrementalPlayerReducer({
    matches,
    rosters: {},
    teams,
    leagueStrengths: [],
    checkpointHistory: appended.checkpoints,
  })
  assert.equal(warm.selectedCheckpointDate, '2026-01-03')
  assert.equal(warm.rows, 0)
  assert.deepEqual(warm.players, appended.players)
})

test('checkpoint restore preserves transfers, role changes, rebuilt controls, and every public player field', () => {
  const matches = Array.from({ length: 25 }, (_, index) => careerMatch(index))
  const prefix = runIncrementalPlayerReducer({
    matches: matches.slice(0, 12),
    rosters: {},
    teams,
    leagueStrengths: [],
  })
  const incremental = runIncrementalPlayerReducer({
    matches,
    rosters: {},
    teams,
    leagueStrengths: [],
    checkpointHistory: prefix.checkpoints,
  })
  const expected = buildPlayerModel(matches, {}, { teams, leagueStrengths: [] })
  assert.deepEqual(incremental.players, expected)
  assert.notEqual(prefix.checkpoints.at(-1)?.residualControlHash, incremental.checkpoints.at(-1)?.residualControlHash)

  const actualCareer = requiredPlayer(incremental.players, 'career-player')
  const expectedCareer = requiredPlayer(expected, 'career-player')
  assert.deepEqual(fullPlayerFingerprint(actualCareer), fullPlayerFingerprint(expectedCareer))
  assert.equal(actualCareer.appearance?.flags.includes('multi-team-career'), true)
  assert.equal(actualCareer.appearance?.flags.includes('multi-role-career'), true)
  assert.deepEqual(actualCareer.appearance?.teamHistory, expectedCareer.appearance?.teamHistory)
  assert.deepEqual(actualCareer.appearance?.roleHistory, expectedCareer.appearance?.roleHistory)
  assert.ok(actualCareer.individualResidual?.rank)
  assert.ok(actualCareer.individualResidual?.rolePowerRank)
})

test('missing stats and incomplete matchups remain unrated across checkpoint restore', () => {
  const matches = sourcedMatches()
  const missingStats = {
    ...matches[1]!,
    teamARoster: removePlayerStats(matches[1]!.teamARoster, 'Mid'),
  }
  const partial = {
    ...matches[2]!,
    teamBRoster: matches[2]!.teamBRoster ? { ...matches[2]!.teamBRoster, completeness: 'partial' as const } : undefined,
  }
  const corpus = [matches[0]!, missingStats, partial]
  const prefix = runIncrementalPlayerReducer({ matches: corpus.slice(0, 1), rosters: {}, teams, leagueStrengths: [] })
  const restored = runIncrementalPlayerReducer({
    matches: corpus,
    rosters: {},
    teams,
    leagueStrengths: [],
    checkpointHistory: prefix.checkpoints,
  })
  assert.equal(restored.rows, 0)
  assert.deepEqual(restored.players, buildPlayerModel(corpus, {}, { teams, leagueStrengths: [] }))
  assert.equal(requiredPlayer(restored.players, 'alpha-Mid').games, 1)
})

test('incremental player reducer rewinds corrections and invalidates changed final league strengths', () => {
  const matches = sourcedMatches()
  const baseline = runIncrementalPlayerReducer({ matches, rosters: {}, teams, leagueStrengths: [] })
  const corrected = matches.map((match, index) => index === 1
    ? sourcedMatch(match.id, match.date, 'Alpha')
    : match)
  const correctionRun = runIncrementalPlayerReducer({
    matches: corrected,
    rosters: {},
    teams,
    leagueStrengths: [],
    checkpointHistory: baseline.checkpoints,
  })
  assert.equal(correctionRun.selectedCheckpointDate, '2026-01-01')
  assert.equal(correctionRun.rows, 20)
  assert.deepEqual(correctionRun.players, buildPlayerModel(corrected, {}, { teams, leagueStrengths: [] }))

  const leagueStrengths = [leagueStrength('LCK', 1510)]
  const dependencyRun = runIncrementalPlayerReducer({
    matches,
    rosters: {},
    teams,
    leagueStrengths,
    checkpointHistory: baseline.checkpoints,
  })
  assert.equal(dependencyRun.selectedCheckpointDate, undefined)
  assert.equal(dependencyRun.rows, 30)
  assert.deepEqual(dependencyRun.players, buildPlayerModel(matches, {}, { teams, leagueStrengths }))
})

test('diagnostic-only corrections rewind public players but reuse team and live-edge reducers', () => {
  const matches = sourcedMatches()
  const teamBase = runIncrementalRankingReducers({ matches, teams })
  const playerBase = runIncrementalPlayerReducer({
    matches,
    rosters: {},
    teams,
    leagueStrengths: teamBase.ranking.leagues,
  })
  const corrected = matches.map((match, index) => index === 1 ? withVisionScore(match, 73) : match)
  const teamCorrection = runIncrementalRankingReducers({
    matches: corrected,
    teams,
    checkpointHistory: teamBase.checkpoints,
  })
  const playerCorrection = runIncrementalPlayerReducer({
    matches: corrected,
    rosters: {},
    teams,
    leagueStrengths: teamCorrection.ranking.leagues,
    checkpointHistory: playerBase.checkpoints,
  })
  assert.deepEqual(teamCorrection.rows, { livePlayerEdgeRows: 0, teamRows: 0 })
  assert.equal(teamCorrection.selectedCheckpointDate, '2026-01-03')
  assert.deepEqual(
    teamCorrection.checkpoints.at(-1)?.livePlayerEdge.journal,
    teamBase.checkpoints.at(-1)?.livePlayerEdge.journal,
  )
  assert.deepEqual(teamCorrection.ranking, buildRankingModel(corrected, teams))
  assert.equal(playerCorrection.selectedCheckpointDate, '2026-01-01')
  assert.equal(playerCorrection.rows, 20)

  const common = {
    matches: corrected,
    teams,
    rosters: {},
    runMetadata: { generatedAt: '2026-07-19T00:00:00.000Z', runId: 'phase3-diagnostic-correction' },
    source: 'phase3 diagnostic correction',
    dataMode: 'scheduled-public-data' as const,
  }
  const reference = createStaticRankingData(common)
  const candidate = createStaticRankingData({
    ...common,
    precomputedGlobalRanking: teamCorrection.ranking,
    precomputedGlobalPlayers: playerCorrection.players,
  })
  assertCrunchParity(
    { fullSnapshot: reference, publicWrites: createPublicArtifactWritePlan(reference, { runMetadata: common.runMetadata }).writes },
    { fullSnapshot: candidate, publicWrites: createPublicArtifactWritePlan(candidate, { runMetadata: common.runMetadata }).writes },
  )
})

test('precomputed global players preserve the full snapshot and complete public write plan', () => {
  const matches = sourcedMatches()
  const ranking = buildRankingModel(matches, teams)
  const incremental = runIncrementalPlayerReducer({
    matches,
    rosters: {},
    teams,
    leagueStrengths: ranking.leagues,
  })
  const common = {
    matches,
    teams,
    rosters: {},
    runMetadata: { generatedAt: '2026-07-19T00:00:00.000Z', runId: 'phase3-player-parity' },
    source: 'phase3 fixed fixture',
    dataMode: 'scheduled-public-data' as const,
    precomputedGlobalRanking: ranking,
  }
  const reference = createStaticRankingData(common)
  const candidate = createStaticRankingData({ ...common, precomputedGlobalPlayers: incremental.players })
  const referencePlan = createPublicArtifactWritePlan(reference, { runMetadata: common.runMetadata })
  const candidatePlan = createPublicArtifactWritePlan(candidate, { runMetadata: common.runMetadata })
  assertCrunchParity(
    { fullSnapshot: reference, publicWrites: referencePlan.writes },
    { fullSnapshot: candidate, publicWrites: candidatePlan.writes },
  )
})

test('production receipts retain exact warm, append, correction, and fallback player metrics', async () => {
  const matches = sourcedMatches()
  const teamBase = runIncrementalRankingReducers({ matches, teams })
  const playerBase = runIncrementalPlayerReducer({
    matches,
    rosters: {},
    teams,
    leagueStrengths: teamBase.ranking.leagues,
  })
  const history = { team: teamBase.checkpoints, player: playerBase.checkpoints }

  const warm = await playerReceipt(matches, history)
  assertReceiptPlayerMetrics(warm, { rows: 0, selected: '2026-01-03', fallback: false })

  const appendedMatches = [...matches, sourcedMatch('sourced-4', '2026-01-04', 'Beta')]
  const appended = await playerReceipt(appendedMatches, history)
  assertReceiptPlayerMetrics(appended, { rows: 10, selected: '2026-01-03', fallback: false })

  const correctedMatches = matches.map((match, index) => index === 1 ? withVisionScore(match, 91) : match)
  const corrected = await playerReceipt(correctedMatches, history)
  assertReceiptPlayerMetrics(corrected, { rows: 20, selected: '2026-01-01', fallback: false })

  const fallback = await playerReceipt(matches, history, true)
  assertReceiptPlayerMetrics(fallback, { rows: 0, selected: '2026-01-03', fallback: true })
})

function sourcedMatches() {
  return [
    sourcedMatch('sourced-1', '2026-01-01', 'Alpha'),
    sourcedMatch('sourced-2', '2026-01-02', 'Beta'),
    sourcedMatch('sourced-3', '2026-01-03', 'Alpha'),
  ]
}

function careerMatch(index: number): MatchRecord {
  const date = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10)
  const match = sourcedMatch(`career-${index}`, date, index % 2 === 0 ? 'Alpha' : 'Beta')
  if (index < 7) {
    match.teamARoster = replaceRolePlayer(match.teamARoster, 'Bot', 'career-player')
  } else if (index < 15) {
    match.teamBRoster = replaceRolePlayer(match.teamBRoster, 'Bot', 'career-player')
  } else {
    match.teamBRoster = replaceRolePlayer(match.teamBRoster, 'Mid', 'career-player')
  }
  return { ...match, patch: index < 12 ? '26.1' : '26.2', tier: index < 20 ? 'regional-regular' : 'major-playoffs' }
}

function sourcedMatch(id: string, date: string, winner: 'Alpha' | 'Beta'): MatchRecord {
  return {
    ...staticMatch(id, date, winner),
    sourceProvider: 'oracles-elixir',
    sourceGameId: `oe-${id}`,
    sourceFileName: 'incremental-player-fixture.csv',
    teamARoster: sourcedRoster('alpha', 'blue', winner === 'Alpha'),
    teamBRoster: sourcedRoster('beta', 'red', winner === 'Beta'),
  }
}

function sourcedRoster(prefix: string, side: Side, won: boolean): NonNullable<MatchRecord['teamARoster']> {
  const roles = ['Top', 'Jungle', 'Mid', 'Bot', 'Support'] as const
  return {
    sourceProvider: 'oracles-elixir',
    teamId: prefix,
    observedAt: '2026-01-01',
    completeness: 'complete-five-role',
    players: roles.map((role, index) => ({
      id: `${prefix}-${role}`,
      name: `${prefix} ${role}`,
      role,
      stats: {
        side,
        won,
        kills: won ? 4 + index : 1 + index,
        deaths: won ? 2 : 4,
        assists: won ? 9 : 5,
        damageShare: 0.16 + index * 0.02,
        earnedGoldShare: 0.16 + index * 0.02,
        vspm: role === 'Support' ? 2.2 : 1,
      },
    })),
  }
}

function withVisionScore(match: MatchRecord, visionScore: number): MatchRecord {
  const update = (roster: MatchRecord['teamARoster']) => roster ? {
    ...roster,
    players: roster.players.map((player) => player.stats
      ? { ...player, stats: { ...player.stats, visionScore } }
      : player),
  } : undefined
  return { ...match, teamARoster: update(match.teamARoster), teamBRoster: update(match.teamBRoster) }
}

function replaceRolePlayer(
  roster: MatchRecord['teamARoster'],
  role: Role,
  playerId: string,
): MatchRecord['teamARoster'] {
  if (!roster) return undefined
  return {
    ...roster,
    players: roster.players.map((player) => player.role === role
      ? { ...player, id: playerId, name: 'Career Player' }
      : player),
  }
}

function removePlayerStats(roster: MatchRecord['teamARoster'], role: Role): MatchRecord['teamARoster'] {
  if (!roster) return undefined
  return {
    ...roster,
    players: roster.players.map((player) => {
      if (player.role !== role) return player
      const { stats, ...profile } = player
      void stats
      return profile
    }),
  }
}

function requiredPlayer(players: ReturnType<typeof buildPlayerModel>, playerId: string) {
  const player = players.find((candidate) => candidate.id === playerId)
  assert.ok(player)
  return player
}

function fullPlayerFingerprint(player: ReturnType<typeof requiredPlayer>) {
  return {
    id: player.id,
    name: player.name,
    team: player.team,
    role: player.role,
    games: player.games,
    ratingBasis: player.ratingBasis,
    rating: player.rating,
    rank: player.rank,
    delta: player.delta,
    baseShare: player.baseShare,
    playerShare: player.playerShare,
    impactMultiplier: player.impactMultiplier,
    availability: player.availability,
    roleCertainty: player.roleCertainty,
    impactDrivers: player.impactDrivers,
    form: player.form,
    history: player.history,
    source: player.source,
    appearanceFlags: player.appearance?.flags,
    teamHistory: player.appearance?.teamHistory,
    roleHistory: player.appearance?.roleHistory,
    diagnostics: player.diagnostics,
    individualResidualScore: player.individualResidual?.score,
    individualResidualRank: player.individualResidual?.rank,
    rolePowerRank: player.individualResidual?.rolePowerRank,
    individualResidual: player.individualResidual,
  }
}

async function playerReceipt(
  matches: MatchRecord[],
  history: { team: IncrementalReducerCheckpoint[]; player: IncrementalPlayerCheckpoint[] },
  fallback = false,
) {
  const team = runIncrementalRankingReducers({ matches, teams, checkpointHistory: history.team })
  const player = runIncrementalPlayerReducer({
    matches,
    rosters: {},
    teams,
    leagueStrengths: team.ranking.leagues,
    checkpointHistory: history.player,
  })
  const receipt = createIncrementalCrunchReceipt({
    run: { generatedAt: '2026-07-19T00:00:00.000Z', runId: 'phase3-player-receipt' },
    requestedMode: 'incremental',
  })
  type Output = { rows: { livePlayerEdgeRows: number; teamRows: number; playerRows: number }; teamSelected?: string; playerSelected?: string }
  const candidate: Output = {
    rows: { ...team.rows, playerRows: player.rows },
    teamSelected: team.selectedCheckpointDate,
    playerSelected: player.selectedCheckpointDate,
  }
  const fallbackReason = { kind: 'checkpoint-unavailable' as const, detail: 'phase3 player receipt fallback' }
  const orchestration = await orchestrateCrunch<Output>({
    mode: 'incremental',
    receipt,
    requireReferenceParity: true,
    runFull: () => ({ rows: { livePlayerEdgeRows: 999, teamRows: 999, playerRows: 999 } }),
    runIncremental: () => ({ output: candidate, ...(fallback ? { fallback: fallbackReason } : {}) }),
  })
  const incrementalCandidate = orchestration.shadowOutput
  assert.ok(incrementalCandidate)
  recordIncrementalReducerCandidate(receipt, {
    ...incrementalCandidate.rows,
    selectedCheckpoint: incrementalCandidate.teamSelected,
    selectedPlayerCheckpoint: incrementalCandidate.playerSelected,
  })
  return { receipt, fallbackReason }
}

function assertReceiptPlayerMetrics(
  result: Awaited<ReturnType<typeof playerReceipt>>,
  expected: { rows: number; selected: string; fallback: boolean },
) {
  assert.equal(result.receipt.requestedMode, 'incremental')
  assert.equal(result.receipt.executedMode, 'full')
  assert.equal(result.receipt.reducers.playerRows, expected.rows)
  assert.equal(result.receipt.checkpoint.playerSelected, expected.selected)
  if (expected.fallback) assert.deepEqual(result.receipt.checkpoint.fallback, result.fallbackReason)
  else assert.equal(result.receipt.checkpoint.fallback, undefined)
}

function staticMatch(id: string, date: string, winner: 'Alpha' | 'Beta'): MatchRecord {
  return {
    id,
    date,
    season: 2026,
    event: 'LCK Fixture',
    phase: 'Regular season',
    region: 'LCK',
    league: 'LCK',
    patch: '26.1',
    bestOf: 1,
    tier: 'regional-regular',
    teamA: 'Alpha',
    teamB: 'Beta',
    winner,
    teamAKills: winner === 'Alpha' ? 18 : 10,
    teamBKills: winner === 'Beta' ? 18 : 10,
    teamAGold: winner === 'Alpha' ? 62000 : 57000,
    teamBGold: winner === 'Beta' ? 62000 : 57000,
    sourceProvider: 'seed',
    dataCompleteness: 'complete',
  }
}

function staticRosters(): Record<string, PlayerProfile[]> {
  const roles: Role[] = ['Top', 'Jungle', 'Mid', 'Bot', 'Support']
  return Object.fromEntries(['Alpha', 'Beta'].map((team) => [team, roles.map((role) => ({
    id: `${team.toLowerCase()}-${role}`,
    name: `${team} ${role}`,
    team,
    role,
  }))]))
}

function leagueStrength(league: string, score: number): LeagueStrength {
  return {
    league,
    region: 'LCK',
    tier: 'tier-one',
    priorScore: 1500,
    rawScore: score,
    connectivity: 1,
    score,
    adjustment: score - 1500,
    delta: score - 1500,
    wins: 0,
    losses: 0,
    internationalMatches: 0,
    form: [],
  }
}
