export const PRIVATE_CRUNCH_SCHEMA_VERSION = 1 as const

export type CrunchMode = 'full' | 'incremental-shadow' | 'incremental'

export type CrunchRunMetadata = {
  generatedAt: string
  runId: string
}

export type IncrementalFallbackReason =
  | { kind: 'incremental-mode-unavailable'; requestedMode: Exclude<CrunchMode, 'full'> }
  | { kind: 'private-schema-incompatible'; expected: number; actual?: number }
  | { kind: 'compatibility-hash-mismatch'; dependency: string; expected: string; actual?: string }
  | { kind: 'checkpoint-unavailable'; detail: string }
  | { kind: 'checkpoint-corrupt'; detail: string }
  | { kind: 'dependency-unknown'; dependency: string }
