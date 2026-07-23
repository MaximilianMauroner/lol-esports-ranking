export const RAILWAY_PRICING_VERIFIED_AT: '2026-07-23'
export const RAILWAY_PRICING_SOURCES: readonly string[]
export const RAILWAY_RATES: Readonly<{
  memoryGbSecond: number
  cpuVcpuSecond: number
  volumeGbSecond: number
  serviceEgressGb: number
  bucketGbMonth: number
  bucketOperations: 0
  bucketEgressGb: 0
  hobbyMinimum: 5
  hobbyIncludedUsage: 5
}>
export type RailwayUsage = { cpuSeconds?: number | null; memoryGbSeconds?: number | null; volumeGbSeconds?: number | null; serviceEgressGb?: number | null; serviceUploadGb?: number | null; bucketGbMonths?: number | null; bucketStorageGbMonths?: number | null }
export type RailwayCost = {
  usage: { cpuSeconds: number | null; memoryGbSeconds: number | null; volumeGbSeconds: number | null; serviceEgressGb: number | null; bucketGbMonths: number | null }
  components: Record<string, number | null>
  resourceCost: number | null
  usageCost: number | null
  totalUsage: number | null
  hobbyBilled: number | null
  warning: string | null
}
export type MonthlyRailwayCost = RailwayCost & { year: number; period: 'current' | string; assumptions: { corpusGb: number | null; runsPerMonth: number | null; storageGb: number | null; annualGrowth: Record<string, number | null> } }
export type RailwayMarginal =
  | { status: 'unknown'; cost: null; reason: string }
  | { status: 'partial'; cost: null; reason: string; sampleCount: number; runIds: string[]; usage: RailwayCost['usage'] }
  | { status: 'measured'; cost: number | null; sampleCount: number; runIds: string[]; usage: RailwayCost['usage']; components: RailwayCost['components'] }
export function costForUsage(usage?: RailwayUsage): RailwayCost
export function createMonthlyProjections(model?: Record<string, unknown>): MonthlyRailwayCost[]
export function createRailwayCostReport(input?: Record<string, unknown>): {
  artifactKind: 'ranking-railway-cost-report'
  schemaVersion: 1
  recordedAt: string
  commit?: string
  deploymentId?: string
  runId?: string
  evidenceClass?: 'live' | 'production-like-fixture'
  expiresAt?: string
  pricing: { verifiedAt: string; sources: string[]; rates: typeof RAILWAY_RATES; notes: Record<string, string> }
  measured: RailwayCost
  monthly: MonthlyRailwayCost[]
  marginals: Record<'oneMatch' | 'unchangedProbe', RailwayMarginal>
}
export function parseRailwayCostReport(value: unknown): ReturnType<typeof createRailwayCostReport> & {
  commit: string
  deploymentId: string
  runId: string
  evidenceClass: 'live' | 'production-like-fixture'
  expiresAt: string
}
export function hasMeasuredProductionUsage(value: unknown): boolean
