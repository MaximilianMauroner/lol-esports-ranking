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
}

export function createIncrementalSnapshotModelProvider({
  compatibilityHash,
}: {
  compatibilityHash: string
}): SnapshotModelProvider {
  const rankingCatalogs = new Map<string, IncrementalReducerCheckpoint[]>()
  const playerCatalogs = new Map<string, IncrementalPlayerCheckpoint[]>()
  const rankingResults = new Map<string, RankingModelResult>()
  const playerResults = new Map<string, PlayerStanding[]>()
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
      const cached = rankingResults.get(resultKey)
      if (cached) {
        counters.rankingResultCacheHits += 1
        return structuredClone(cached)
      }
      const streamKey = privateStateHash({
        kind: 'snapshot-ranking-stream-v1',
        compatibilityHash,
        teams: input.teams,
      })
      const run = runIncrementalRankingReducers({
        matches: input.matches,
        teams: input.teams,
        tournamentLifecycles: input.tournamentLifecycles,
        checkpointHistory: rankingCatalogs.get(streamKey) ?? [],
      })
      rankingCatalogs.set(streamKey, run.checkpoints)
      rankingResults.set(resultKey, run.ranking)
      counters.rankingReducerRuns += 1
      counters.rankingRows += run.rows.livePlayerEdgeRows + run.rows.teamRows
      return structuredClone(run.ranking)
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
      const cached = playerResults.get(resultKey)
      if (cached) {
        counters.playerResultCacheHits += 1
        return structuredClone(cached)
      }
      const streamKey = privateStateHash({
        kind: 'snapshot-player-stream-v1',
        compatibilityHash,
        mode: playerModelModeForMatches(input.matches),
        rosters: input.rosters,
        teams: input.teams,
        leagueStrengths: input.leagueStrengths,
        eventWeightContext,
      })
      const run = runIncrementalPlayerReducer({
        ...input,
        checkpointHistory: playerCatalogs.get(streamKey) ?? [],
      })
      playerCatalogs.set(streamKey, run.checkpoints)
      playerResults.set(resultKey, run.players)
      counters.playerReducerRuns += 1
      counters.playerRows += run.rows
      return structuredClone(run.players)
    },
    metrics() {
      return { ...counters }
    },
  }
}
