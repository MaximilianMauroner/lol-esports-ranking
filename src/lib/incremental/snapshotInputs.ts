import type { LeagueStrength, MatchRecord, PlayerProfile, PlayerStanding, TeamProfile } from '../../types.ts'
import { eventWeightContextForMatches } from '../eventWeighting.ts'
import type { RankingModelResult } from '../model.ts'
import type { PlacementTournamentLifecycle } from '../placementResiduals.ts'
import { playerModelModeForMatches } from '../playerModel.ts'
import { runIncrementalPlayerReducer, type IncrementalPlayerCheckpoint } from './playerReducer.ts'
import { runIncrementalRankingReducers } from './rankingReducer.ts'
import type { IncrementalReducerCheckpoint } from './reducerCheckpoint.ts'
import { privateStateHash } from './reducerCheckpoint.ts'

export type SnapshotRankingInput = {
  matches: MatchRecord[]
  teams: Record<string, TeamProfile>
  tournamentLifecycles?: ReadonlyMap<string, PlacementTournamentLifecycle>
}

export type SnapshotPlayerInput = {
  matches: MatchRecord[]
  rosters: Record<string, PlayerProfile[]>
  teams: Record<string, TeamProfile>
  leagueStrengths: LeagueStrength[]
}

export type SnapshotInputMetrics = {
  rankingRequests: number
  rankingResultCacheHits: number
  rankingReducerRuns: number
  rankingRows: number
  playerRequests: number
  playerResultCacheHits: number
  playerReducerRuns: number
  playerRows: number
  directRankingBuilds: number
  directPlayerBuilds: number
}

export type SnapshotModelProvider = {
  ranking(input: SnapshotRankingInput): RankingModelResult
  players(input: SnapshotPlayerInput): PlayerStanding[]
  metrics(): SnapshotInputMetrics
  persistedState?(): PersistedSnapshotModelState
}

export type PersistedSnapshotModelState = {
  schemaVersion: 1
  compatibilityHash: string
  rankingCatalogs: Map<string, IncrementalReducerCheckpoint[]>
  playerCatalogs: Map<string, IncrementalPlayerCheckpoint[]>
  rankingResults: Map<string, RankingModelResult>
  playerResults: Map<string, PlayerStanding[]>
}

export type SnapshotModelCacheLookup = {
  schemaVersion: 2
  compatibilityHash: string
  get<T>(collection: keyof Omit<PersistedSnapshotModelState, 'schemaVersion' | 'compatibilityHash'>, key: string): T | undefined
}

export function createIncrementalSnapshotModelProvider({
  compatibilityHash,
  cloneResults = true,
  previous,
  persistNewResults = true,
  persistCatalogUpdates = true,
}: {
  compatibilityHash: string
  cloneResults?: boolean
  previous?: PersistedSnapshotModelState | SnapshotModelCacheLookup
  persistNewResults?: boolean
  persistCatalogUpdates?: boolean
}): SnapshotModelProvider {
  if (previous && 'rankingCatalogs' in previous) validatePersistedSnapshotModelState(previous, compatibilityHash)
  if (previous && previous.compatibilityHash !== compatibilityHash) throw new Error('Snapshot model state compatibility hash mismatch')
  const lookup = previous && !('rankingCatalogs' in previous) ? previous : undefined
  const initialRankingCatalogs = previous && 'rankingCatalogs' in previous ? previous.rankingCatalogs : new Map<string, IncrementalReducerCheckpoint[]>()
  const initialPlayerCatalogs = previous && 'playerCatalogs' in previous ? previous.playerCatalogs : new Map<string, IncrementalPlayerCheckpoint[]>()
  const initialRankingResults = previous && 'rankingResults' in previous ? previous.rankingResults : new Map<string, RankingModelResult>()
  const initialPlayerResults = previous && 'playerResults' in previous ? previous.playerResults : new Map<string, PlayerStanding[]>()
  const rankingCatalogs = new Map(initialRankingCatalogs)
  const playerCatalogs = new Map(initialPlayerCatalogs)
  const rankingResults = new Map(initialRankingResults)
  const playerResults = new Map(initialPlayerResults)
  const touchedRankingStreams = new Set<string>()
  const touchedPlayerStreams = new Set<string>()
  const touchedRankingResults = new Set<string>()
  const touchedPlayerResults = new Set<string>()
  const counters: SnapshotInputMetrics = {
    rankingRequests: 0,
    rankingResultCacheHits: 0,
    rankingReducerRuns: 0,
    rankingRows: 0,
    playerRequests: 0,
    playerResultCacheHits: 0,
    playerReducerRuns: 0,
    playerRows: 0,
    directRankingBuilds: 0,
    directPlayerBuilds: 0,
  }

  return {
    ranking(input) {
      counters.rankingRequests += 1
      const resultKey = privateStateHash({
        kind: 'snapshot-ranking-result-v1',
        compatibilityHash,
        matches: input.matches,
        teams: input.teams,
        tournamentLifecycles: input.tournamentLifecycles ?? new Map(),
      })
      const streamKey = privateStateHash({
        kind: 'snapshot-ranking-stream-v1',
        compatibilityHash,
        teams: input.teams,
        tournamentLifecycles: input.tournamentLifecycles ?? new Map(),
      })
      touchedRankingResults.add(resultKey)
      touchedRankingStreams.add(streamKey)
      const cached = cachedValue<RankingModelResult>(rankingResults, lookup, 'rankingResults', resultKey)
      if (cached) {
        counters.rankingResultCacheHits += 1
        return cloneResults ? structuredClone(cached) : cached
      }
      const run = runIncrementalRankingReducers({
        matches: input.matches,
        teams: input.teams,
        tournamentLifecycles: input.tournamentLifecycles,
        checkpointHistory: cachedValue<IncrementalReducerCheckpoint[]>(rankingCatalogs, lookup, 'rankingCatalogs', streamKey) ?? [],
      })
      rankingCatalogs.set(streamKey, run.checkpoints)
      rankingResults.set(resultKey, run.ranking)
      counters.rankingReducerRuns += 1
      counters.rankingRows += run.rows.livePlayerEdgeRows + run.rows.teamRows
      return cloneResults ? structuredClone(run.ranking) : run.ranking
    },
    players(input) {
      counters.playerRequests += 1
      const eventWeightContext = eventWeightContextForMatches(input.matches)
      const resultKey = privateStateHash({
        kind: 'snapshot-player-result-v1',
        compatibilityHash,
        matches: input.matches,
        rosters: input.rosters,
        teams: input.teams,
        leagueStrengths: input.leagueStrengths,
        eventWeightContext,
      })
      const streamKey = privateStateHash({
        kind: 'snapshot-player-stream-v1',
        compatibilityHash,
        mode: playerModelModeForMatches(input.matches),
        rosters: input.rosters,
        teams: input.teams,
        leagueStrengths: input.leagueStrengths,
        eventWeightContext,
      })
      touchedPlayerResults.add(resultKey)
      touchedPlayerStreams.add(streamKey)
      const cached = cachedValue<PlayerStanding[]>(playerResults, lookup, 'playerResults', resultKey)
      if (cached) {
        counters.playerResultCacheHits += 1
        return cloneResults ? structuredClone(cached) : cached
      }
      const run = runIncrementalPlayerReducer({
        ...input,
        checkpointHistory: cachedValue<IncrementalPlayerCheckpoint[]>(playerCatalogs, lookup, 'playerCatalogs', streamKey) ?? [],
      })
      playerCatalogs.set(streamKey, run.checkpoints)
      playerResults.set(resultKey, run.players)
      counters.playerReducerRuns += 1
      counters.playerRows += run.rows
      return cloneResults ? structuredClone(run.players) : run.players
    },
    metrics() {
      return { ...counters }
    },
    persistedState() {
      return {
        schemaVersion: 1 as const,
        compatibilityHash,
        rankingCatalogs: selectedEntries(persistCatalogUpdates ? rankingCatalogs : initialRankingCatalogs, touchedRankingStreams),
        playerCatalogs: selectedEntries(persistCatalogUpdates ? playerCatalogs : initialPlayerCatalogs, touchedPlayerStreams),
        rankingResults: selectedEntries(persistNewResults ? rankingResults : initialRankingResults, touchedRankingResults),
        playerResults: selectedEntries(persistNewResults ? playerResults : initialPlayerResults, touchedPlayerResults),
      }
    },
  }
}

function cachedValue<T>(
  map: Map<string, T>,
  lookup: SnapshotModelCacheLookup | undefined,
  collection: keyof Omit<PersistedSnapshotModelState, 'schemaVersion' | 'compatibilityHash'>,
  key: string,
): T | undefined {
  if (map.has(key)) return map.get(key)
  const value = lookup?.get<T>(collection, key)
  if (value !== undefined) map.set(key, value)
  return value
}

function selectedEntries<T>(source: Map<string, T>, selected: Set<string>): Map<string, T> {
  return new Map([...selected].flatMap((key) => {
    const value = source.get(key)
    return value === undefined ? [] : [[key, value] as const]
  }))
}

export function validatePersistedSnapshotModelState(
  state: PersistedSnapshotModelState,
  compatibilityHash?: string,
): void {
  if (state.schemaVersion !== 1
    || typeof state.compatibilityHash !== 'string'
    || !(state.rankingCatalogs instanceof Map)
    || !(state.playerCatalogs instanceof Map)
    || !(state.rankingResults instanceof Map)
    || !(state.playerResults instanceof Map)) {
    throw new Error('Invalid persisted snapshot model state')
  }
  if (compatibilityHash !== undefined && state.compatibilityHash !== compatibilityHash) {
    throw new Error('Snapshot model state compatibility hash mismatch')
  }
  validateStringMap(state.rankingCatalogs, Array.isArray)
  validateStringMap(state.playerCatalogs, Array.isArray)
  validateStringMap(state.rankingResults, isRecord)
  validateStringMap(state.playerResults, Array.isArray)
}

function validateStringMap<T>(map: Map<string, T>, validate: (value: T) => boolean): void {
  for (const [key, value] of map) {
    if (typeof key !== 'string' || key.length === 0 || !validate(value)) {
      throw new Error('Invalid persisted snapshot model cache entry')
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
