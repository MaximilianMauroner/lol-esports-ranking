import type { DurableObjectStore } from './durable-ranking-state.mjs'
import type { BucketClient } from './railway-bucket.mjs'

export type RankingStateGcPlan = Record<string, unknown> & {
  safe: boolean
  reason?: string
  plannedDeletes: Array<{ key: string; bytes: number; kind: string }>
}

export type RankingStateGcPlanningOptions = {
  store: DurableObjectStore
  activePointer?: Record<string, unknown>
  activeEtag?: string
  now: string
  recentDays: number
  stagingGraceMs: number
}

export type RankingStateGcResult = Record<string, unknown> & {
  released?: boolean
  reason?: string
}

export function runRankingStateGc(options?: {
  args?: string[]
  env?: NodeJS.ProcessEnv
  config?: unknown
  client?: BucketClient | null
  owner?: string
  output?: (message: string) => void | Promise<void>
  planGc?: (options: RankingStateGcPlanningOptions) => Promise<RankingStateGcPlan>
  now?: () => Date
}): Promise<RankingStateGcResult>
