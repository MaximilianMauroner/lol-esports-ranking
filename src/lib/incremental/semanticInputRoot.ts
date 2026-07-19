import type { TournamentRatedMatchReference, TournamentScheduleReference } from '../internationalTournaments'
import { deriveTournamentInstances } from '../internationalTournaments'
import { stableHash } from './hash'

export type RankingTemporalContext = {
  schemaVersion: 1
  asOfDate: string
  calendarHash: string
  modelVersion: string
  modelConfigHash: string
  tournamentLifecycles: Array<{
    id: string
    status: 'ongoing' | 'completed' | 'unknown'
    boundaryDate: string
    ratedThroughDate: string
    scheduledEndDate?: string
    dataLag: boolean
    resultCoverageComplete: boolean
  }>
}

export function deriveRankingTemporalContext(options: {
  matches: readonly TournamentRatedMatchReference[]
  scheduleReferences: readonly TournamentScheduleReference[]
  generatedAt: string
  calendarHash: string
  modelVersion: string
  modelConfigHash: string
}): RankingTemporalContext {
  return {
    schemaVersion: 1,
    asOfDate: options.generatedAt.slice(0, 10),
    calendarHash: options.calendarHash,
    modelVersion: options.modelVersion,
    modelConfigHash: options.modelConfigHash,
    tournamentLifecycles: deriveTournamentInstances({
      matches: options.matches,
      scheduleReferences: options.scheduleReferences,
      generatedAt: options.generatedAt,
    }).map((instance) => ({
      id: instance.id,
      status: instance.status,
      boundaryDate: instance.boundaryDate,
      ratedThroughDate: instance.ratedThroughDate,
      ...(instance.scheduledEndDate ? { scheduledEndDate: instance.scheduledEndDate } : {}),
      dataLag: instance.dataLag,
      resultCoverageComplete: instance.resultCoverageComplete,
    })),
  }
}

export function createIncrementalSemanticInputRoot(options: {
  providerRoot: string
  canonicalRoot: string
  contextRoot: string
  staticPlayerRoot: string
  temporalContext: RankingTemporalContext
}) {
  const temporalRoot = stableHash(options.temporalContext)
  return {
    temporalRoot,
    inputRoot: stableHash({
      providerRoot: options.providerRoot,
      canonicalRoot: options.canonicalRoot,
      contextRoot: options.contextRoot,
      staticPlayerRoot: options.staticPlayerRoot,
      temporalRoot,
    }),
  }
}
