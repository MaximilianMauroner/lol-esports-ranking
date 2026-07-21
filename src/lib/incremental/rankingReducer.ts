import type { MatchRecord, TeamProfile } from '../../types.ts'
import { eventWeightContextForMatches } from '../eventWeighting.ts'
import { matchesByDate } from '../matchContext.ts'
import {
  finalizeTeamReducer,
  initializeTeamReducer,
  processTeamDateBatch,
  restoreTeamReducer,
  snapshotTeamReducer,
  type RankingModelResult,
} from '../model.ts'
import type { PlacementTournamentLifecycle } from '../placementResiduals.ts'
import {
  finalizeLivePlayerEdgeReducer,
  initializeLivePlayerEdgeReducer,
  processLivePlayerEdgeDateBatch,
  restoreLivePlayerEdgeReducer,
  snapshotLivePlayerEdgeReducer,
} from '../playerModel.ts'
import {
  buildReducerDependencyPlan,
  canonicalPrefixHash,
  reducerCheckpointCanResume,
  reducerCheckpointRetentionDates,
  reducerDependencyHash,
  reducerDependencyChange,
  retainReducerCheckpointCatalog,
  selectLatestReducerCheckpoint,
  type IncrementalReducerCheckpoint,
} from './reducerCheckpoint.ts'

export type IncrementalRankingReducerResult = {
  ranking: RankingModelResult
  checkpoints: IncrementalReducerCheckpoint[]
  selectedCheckpointDate?: string
  rows: {
    livePlayerEdgeRows: number
    teamRows: number
  }
}

export function runIncrementalRankingReducers({
  matches,
  teams,
  tournamentLifecycles = new Map(),
  checkpointHistory = [],
}: {
  matches: MatchRecord[]
  teams: Record<string, TeamProfile>
  tournamentLifecycles?: ReadonlyMap<string, PlacementTournamentLifecycle>
  checkpointHistory?: IncrementalReducerCheckpoint[]
}): IncrementalRankingReducerResult {
  const eventWeightContext = eventWeightContextForMatches(matches)
  const dependencyPlan = buildReducerDependencyPlan({ matches, teams, tournamentLifecycles })
  const dependencyHash = reducerDependencyHash(dependencyPlan)
  const resumableCheckpoints = checkpointHistory
    .filter((checkpoint) => reducerCheckpointCanResume(checkpoint, matches, dependencyPlan))
    .toSorted((left, right) => (left.processedDate ?? '').localeCompare(right.processedDate ?? ''))
  const selectedCheckpoint = selectLatestReducerCheckpoint(checkpointHistory, matches, dependencyPlan)
  const rebuildPlacementContext = selectedCheckpoint
    ? Boolean(reducerDependencyChange(selectedCheckpoint.dependencyPlan, dependencyPlan).influenceDate)
    : false
  const retentionByDate = reducerCheckpointRetentionDates(matches)
  const livePlayerEdge = selectedCheckpoint
    ? restoreLivePlayerEdgeReducer(selectedCheckpoint.livePlayerEdge, matches, { teams, eventWeightContext })
    : initializeLivePlayerEdgeReducer(matches, { teams, eventWeightContext })
  const liveBatches = livePlayerEdgeDateBatches(matches, livePlayerEdge.processedDate)
  const liveCheckpointsByDate = new Map<string, ReturnType<typeof snapshotLivePlayerEdgeReducer>>()
  for (const batch of liveBatches) {
    processLivePlayerEdgeDateBatch(livePlayerEdge, batch)
    if (livePlayerEdge.processedDate && retentionByDate.has(livePlayerEdge.processedDate)) {
      liveCheckpointsByDate.set(livePlayerEdge.processedDate, snapshotLivePlayerEdgeReducer(livePlayerEdge))
    }
  }
  const pregamePlayerRatingEdges = finalizeLivePlayerEdgeReducer(livePlayerEdge)
  const team = selectedCheckpoint
    ? restoreTeamReducer(selectedCheckpoint.team, matches, teams, {
        tournamentLifecycles,
        pregamePlayerRatingEdges,
        rebuildPlacementContext,
      })
    : initializeTeamReducer(matches, teams, { tournamentLifecycles, pregamePlayerRatingEdges })
  const teamBatches = teamDateBatches(matches, team.processedDate)
  const replayedCheckpoints: IncrementalReducerCheckpoint[] = []
  for (const batch of teamBatches) {
    processTeamDateBatch(team, batch)
    const processedDate = team.processedDate
    if (!processedDate || !retentionByDate.has(processedDate)) continue
    const liveCheckpoint = liveCheckpointsByDate.get(processedDate)
    if (!liveCheckpoint) throw new Error(`Missing retained live player-edge checkpoint for team date ${processedDate}`)
    replayedCheckpoints.push({
      schemaVersion: 1,
      processedDate,
      canonicalPrefixHash: canonicalPrefixHash(matches, processedDate),
      dependencyHash,
      dependencyPlan,
      retention: retentionByDate.get(processedDate) ?? [],
      livePlayerEdge: liveCheckpoint,
      team: snapshotTeamReducer(team),
    })
  }
  if (!selectedCheckpoint && replayedCheckpoints.length === 0) {
    replayedCheckpoints.push({
      schemaVersion: 1,
      canonicalPrefixHash: canonicalPrefixHash(matches),
      dependencyHash,
      dependencyPlan,
      retention: [],
      livePlayerEdge: snapshotLivePlayerEdgeReducer(livePlayerEdge),
      team: snapshotTeamReducer(team),
    })
  }
  const checkpoints = retainReducerCheckpointCatalog(
    uniqueReducerCheckpoints([...resumableCheckpoints, ...replayedCheckpoints]),
    matches,
  )
  return {
    ranking: finalizeTeamReducer(team),
    checkpoints,
    selectedCheckpointDate: selectedCheckpoint?.processedDate,
    rows: {
      livePlayerEdgeRows: liveBatches.reduce((total, batch) => total + batch.length, 0),
      teamRows: teamBatches.reduce((total, batch) => total + batch.length, 0),
    },
  }
}

function uniqueReducerCheckpoints(checkpoints: IncrementalReducerCheckpoint[]) {
  return [...new Map(checkpoints.map((checkpoint) => [checkpoint.processedDate ?? '', checkpoint])).values()]
    .toSorted((left, right) => (left.processedDate ?? '').localeCompare(right.processedDate ?? ''))
}

function livePlayerEdgeDateBatches(matches: MatchRecord[], processedDate?: string) {
  return matchesByDate(matches.toSorted((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id)))
    .filter((batch) => !processedDate || (batch[0]?.date ?? '') > processedDate)
}

function teamDateBatches(matches: MatchRecord[], processedDate?: string) {
  return matchesByDate(matches.toSorted((left, right) => left.date.localeCompare(right.date)))
    .filter((batch) => !processedDate || (batch[0]?.date ?? '') > processedDate)
}
