import type { BucketClient, BucketStorageConfig } from './railway-bucket.mjs'

export type BaselineAuthorityReference = { key: string; sha256: string; bytes: number }
export type BaselineModelAuthority = { version: string; configHash: string }
export type LatestFullAuditAuthority =
  | { status: 'absent'; searchedPrefix: string; verifiedAt: string }
  | {
      status: 'present'
      key: string
      sha256: string
      bytes: number
      auditDate: string
      generationId: string
      model: BaselineModelAuthority
    }
export type RankingRestartBaselineReceipt = {
  kind: 'ranking-restart-baseline-receipt'
  schemaVersion: 1
  capturedAt: string
  baseline: { commit: string; tag: string }
  railway: {
    projectId: string
    environmentId: string
    bucketId: string
    bucketName: string
    web: { serviceId: string; deploymentId: string; commit: string }
    refresh: { serviceId: string; deploymentId: string; commit: string }
  }
  frozenBehavior: {
    cronSchedule: '0 */6 * * *'
    intervalMinutes: 360
    refreshMode: 'gated'
    deliveryMode: 'proxy'
    deletionAuthorized: false
    incrementalActivationAuthorized: false
  }
  active: {
    generationId: string
    pointer: { key: string; etag: string; fencingToken: number; promotedAt: string }
    publicManifest: BaselineAuthorityReference
    stateManifest: BaselineAuthorityReference
    rawReceipt: BaselineAuthorityReference
    publishReceipt: BaselineAuthorityReference
    sourceReceiptDigest: string
    model: BaselineModelAuthority
    rankingSchemaVersion: number
    coverage: { start: string; end: string; matchCount: number; seeded: boolean }
    dataMode: string
    seeded: boolean
  }
  previous: {
    generationId: string
    promotedAt: string
    complete: true
    publicManifest: BaselineAuthorityReference
    stateManifest: BaselineAuthorityReference
    rawReceipt: BaselineAuthorityReference
    publishReceipt:
      | ({ status: 'present' } & BaselineAuthorityReference)
      | { status: 'absent'; key: string; verifiedAt: string }
    sourceReceiptDigest: string
    model: BaselineModelAuthority
  }
  latestFullAudit: LatestFullAuditAuthority
  recovery: {
    order: ['previous-complete-generation', 'authorized-full-replay-from-active-verified-raw']
    scheduledFreshnessRemainsStrict: true
    verifiedRawFullReplayRequires: ['force', 'recovery-authorization']
  }
  producingCode: string[]
  integrity: Array<{ scope: string; key: string; result: 'verified' }>
  canonicalDigest: string
}

export function parseArgs(argv: string[]): Record<string, string | boolean>
export function runCli(argv: string[], dependencies?: Record<string, unknown>): Promise<RankingRestartBaselineReceipt>
export function resolveCommitIdentity(options?: {
  explicitCommit?: string
  env?: NodeJS.ProcessEnv
  cwd?: string
  git?: (cwd: string) => string | Promise<string>
  hasGitMetadata?: (cwd: string) => boolean | Promise<boolean>
}): Promise<string>
export function captureRankingRestartBaseline(options: {
  config: BucketStorageConfig
  client: BucketClient
  baselineCommit: string
  baselineTag: string
  capturedAt: string
  railway: RankingRestartBaselineReceipt['railway']
  readers?: Record<string, (...args: never[]) => Promise<unknown>>
}): Promise<RankingRestartBaselineReceipt>
export function readLatestFullAuditAuthority(options: {
  config: BucketStorageConfig
  client: BucketClient
  verifiedAt: string
}): Promise<LatestFullAuditAuthority>
export function parseRankingRestartBaselineReceipt(value: unknown): RankingRestartBaselineReceipt
export function canonicalReceiptDigest(value: unknown): string
export function assertAuthorityAgreement(value: Record<string, unknown>): void
export function assertStablePointer(first: Record<string, unknown>, final: Record<string, unknown>): void
