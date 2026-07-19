import type { LeagueStrength, MatchRecord, PlayerProfile, PlayerStanding, TeamProfile } from '../../types.ts'
import { eventWeightContextForMatches } from '../eventWeighting.ts'
import { matchesByDate } from '../matchContext.ts'
import {
  buildIndividualResidualControlModel,
  finalizePlayerModelReducer,
  initializePlayerModelReducer,
  playerModelModeForMatches,
  processPlayerModelDateBatch,
  restorePlayerModelReducer,
  snapshotPlayerModelReducer,
  sortPlayerModelMatches,
  type PlayerModelCheckpoint,
  type PlayerRatingContext,
} from '../playerModel.ts'
import {
  fullMatchCanonicalPrefixHash,
  privateStateHash,
  reducerCheckpointRetentionDates,
  type ReducerCheckpointRetention,
} from './reducerCheckpoint.ts'

export const PLAYER_REDUCER_CHECKPOINT_SCHEMA_VERSION = 1 as const

export type IncrementalPlayerCheckpoint = {
  schemaVersion: typeof PLAYER_REDUCER_CHECKPOINT_SCHEMA_VERSION
  processedDate?: string
  canonicalPrefixHash: string
  dependencyHash: string
  residualControlHash: string
  retention: ReducerCheckpointRetention[]
  player: PlayerModelCheckpoint
}

export type PersistedPlayerCheckpointCore = Omit<IncrementalPlayerCheckpoint, 'player'> & {
  player: Omit<PlayerModelCheckpoint, 'history'>
  historyHash: string
}

export type IncrementalPlayerReducerResult = {
  players: PlayerStanding[]
  checkpoints: IncrementalPlayerCheckpoint[]
  selectedCheckpointDate?: string
  rows: number
  checkpointSnapshots: number
}

export function runIncrementalPlayerReducer({
  matches,
  rosters,
  teams,
  leagueStrengths,
  checkpointHistory = [],
}: {
  matches: MatchRecord[]
  rosters: Record<string, PlayerProfile[]>
  teams: Record<string, TeamProfile>
  leagueStrengths: LeagueStrength[]
  checkpointHistory?: IncrementalPlayerCheckpoint[]
}): IncrementalPlayerReducerResult {
  const mode = playerModelModeForMatches(matches)
  const sortedMatches = sortPlayerModelMatches(matches, mode)
  const context: PlayerRatingContext = {
    teams,
    leagueStrengths,
    eventWeightContext: eventWeightContextForMatches(sortedMatches),
  }
  const dependencyHash = playerReducerDependencyHash({ matches: sortedMatches, rosters, context })
  const residualControlHash = playerResidualControlHash(sortedMatches, context)
  const resumable = checkpointHistory
    .filter((checkpoint) => playerCheckpointCanResume(checkpoint, sortedMatches, dependencyHash))
    .toSorted(compareCheckpointDate)
  const selected = resumable.at(-1)
  const reducer = selected
    ? restorePlayerModelReducer(selected.player, sortedMatches, rosters, context)
    : initializePlayerModelReducer(sortedMatches, rosters, context)
  const retentionByDate = reducerCheckpointRetentionDates(sortedMatches)
  const replayed: IncrementalPlayerCheckpoint[] = []
  let rows = 0
  for (const batch of suffixDateBatches(sortedMatches, reducer.processedDate)) {
    rows += processPlayerModelDateBatch(reducer, batch)
    if (!reducer.processedDate || (retentionByDate.get(reducer.processedDate)?.length ?? 0) === 0) continue
    replayed.push(createPlayerCheckpoint(
      reducer.processedDate,
      sortedMatches,
      dependencyHash,
      residualControlHash,
      retentionByDate.get(reducer.processedDate) ?? [],
      snapshotPlayerModelReducer(reducer),
    ))
  }
  if (!selected && replayed.length === 0) {
    replayed.push(createPlayerCheckpoint(
      undefined,
      sortedMatches,
      dependencyHash,
      residualControlHash,
      [],
      snapshotPlayerModelReducer(reducer),
    ))
  }
  return {
    players: finalizePlayerModelReducer(reducer),
    checkpoints: retainPlayerCheckpointCatalog([...resumable, ...replayed], sortedMatches),
    selectedCheckpointDate: selected?.processedDate,
    rows,
    checkpointSnapshots: replayed.length,
  }
}

export function playerCheckpointCanResume(
  checkpoint: IncrementalPlayerCheckpoint,
  matches: MatchRecord[],
  dependencyHash: string,
) {
  if (checkpoint.schemaVersion !== PLAYER_REDUCER_CHECKPOINT_SCHEMA_VERSION
    || checkpoint.dependencyHash !== dependencyHash
    || checkpoint.processedDate !== checkpoint.player.processedDate) return false
  if (checkpoint.processedDate && !matches.some((match) => match.date === checkpoint.processedDate)) return false
  return checkpoint.canonicalPrefixHash === fullMatchCanonicalPrefixHash(matches, checkpoint.processedDate)
}

export function retainPlayerCheckpointCatalog(
  checkpoints: IncrementalPlayerCheckpoint[],
  matches: MatchRecord[],
  recentDailyCount = 32,
) {
  const ordered = [...new Map(checkpoints.map((checkpoint) => [checkpoint.processedDate ?? '', checkpoint])).values()]
    .toSorted(compareCheckpointDate)
  const retention = reducerCheckpointRetentionDates(matches, recentDailyCount)
  if (ordered.length === 1 && ordered[0]?.processedDate === undefined) retention.set('', ['recent-daily'])
  return ordered.flatMap((checkpoint) => {
    const classes = retention.get(checkpoint.processedDate ?? '') ?? []
    return classes.length > 0 ? [{ ...checkpoint, retention: classes }] : []
  })
}

export function playerReducerDependencyHash({
  matches,
  rosters,
  context,
}: {
  matches: MatchRecord[]
  rosters: Record<string, PlayerProfile[]>
  context: PlayerRatingContext
}) {
  return privateStateHash({
    reducerSchema: 'incremental-public-player-reducer-v1',
    sourceCoveragePolicy: 'observed-player-stats-any-match-v1',
    mode: playerModelModeForMatches(matches),
    rosters,
    teams: context.teams ?? {},
    leagueStrengths: context.leagueStrengths ?? [],
    eventWeightContext: context.eventWeightContext ?? eventWeightContextForMatches(matches),
  })
}

export function playerResidualControlHash(matches: MatchRecord[], context: PlayerRatingContext) {
  const leagueRatings = new Map((context.leagueStrengths ?? []).map((league) => [league.league, league.score]))
  return privateStateHash(buildIndividualResidualControlModel(matches, context, leagueRatings))
}

export function isIncrementalPlayerCheckpoint(value: unknown): value is IncrementalPlayerCheckpoint {
  if (!isRecord(value)
    || value.schemaVersion !== PLAYER_REDUCER_CHECKPOINT_SCHEMA_VERSION
    || (value.processedDate !== undefined && typeof value.processedDate !== 'string')
    || typeof value.canonicalPrefixHash !== 'string'
    || typeof value.dependencyHash !== 'string'
    || typeof value.residualControlHash !== 'string'
    || !Array.isArray(value.retention)
    || !isRecord(value.player)) return false
  const player = value.player
  return player.schemaVersion === 1
    && (player.mode === 'sourced' || player.mode === 'static')
    && (player.processedDate === undefined || typeof player.processedDate === 'string')
    && typeof player.processedRows === 'number'
    && isRecord(player.state)
    && player.history instanceof Map
}

function createPlayerCheckpoint(
  processedDate: string | undefined,
  matches: MatchRecord[],
  dependencyHash: string,
  residualControlHash: string,
  retention: ReducerCheckpointRetention[],
  player: PlayerModelCheckpoint,
): IncrementalPlayerCheckpoint {
  return {
    schemaVersion: PLAYER_REDUCER_CHECKPOINT_SCHEMA_VERSION,
    processedDate,
    canonicalPrefixHash: fullMatchCanonicalPrefixHash(matches, processedDate),
    dependencyHash,
    residualControlHash,
    retention,
    player,
  }
}

function suffixDateBatches(matches: MatchRecord[], processedDate?: string) {
  return matchesByDate(matches)
    .filter((batch) => !processedDate || (batch[0]?.date ?? '') > processedDate)
}

function compareCheckpointDate(left: IncrementalPlayerCheckpoint, right: IncrementalPlayerCheckpoint) {
  return (left.processedDate ?? '').localeCompare(right.processedDate ?? '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
