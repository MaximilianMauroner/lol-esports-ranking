import type {
  NarrowSourceObject,
  OracleBaselineObject,
  OracleDeltaObject,
  RawObjectReference,
  RawSourceReceipt,
  PreparedRawObject,
} from './raw-source-storage.mjs'

export const RAW_ORACLE_MAX_DELTAS: 32

export type ActiveRawSourceAuthority = {
  receipt: RawSourceReceipt
  objectResolver(reference: RawObjectReference): Promise<Uint8Array | undefined>
  streamObjectToFile?(reference: RawObjectReference, destinationPath: string): Promise<{ path: string; compressedBytes: number }>
}

export type PreparedRawSourceGeneration = {
  generationId: string
  importerVersion: string
  coverage: { start: string; end: string }
  sourceReceiptInputs: Record<string, unknown>
  oracle: RawSourceReceipt['oracle']
  leaguepedia: RawSourceReceipt['leaguepedia']
  lolesports: RawSourceReceipt['lolesports']
  objects: Array<PreparedRawObject<OracleBaselineObject | OracleDeltaObject | NarrowSourceObject>>
  verifiedSourceFiles: Array<{
    provider: 'oracle' | 'leaguepedia' | 'lolesports'
    sourceFileName: string
    sourcePath: string
    contentSha256: string
    headerDigest?: string
    effectiveOracleDigest?: string
  }>
  inheritedObjectResolver?: ActiveRawSourceAuthority['objectResolver']
  receipt: RawSourceReceipt
  receiptPrepared: PreparedRawObject<RawSourceReceipt>
  receiptReference: RawObjectReference
  sourceReceiptDigest: string
  rawIdentityDigest: string
}

export function prepareRawSourceGeneration(options: {
  manifestPath: string
  rawDir?: string
  generationId?: string
  importerVersion: string
  previousAuthority?: ActiveRawSourceAuthority
}): Promise<PreparedRawSourceGeneration>
export function finalizeRawSourceGeneration(generation: PreparedRawSourceGeneration, generationId: string): PreparedRawSourceGeneration
export function hydrateFileBackedRawSourceGeneration(value: Record<string, unknown>): PreparedRawSourceGeneration
export function materializePreparedRawSourceGeneration(
  generation: PreparedRawSourceGeneration,
  destinationDir: string,
  generatedAt: string,
): ReturnType<typeof import('./raw-source-storage.mjs').materializeRawSourceReceipt>
export function materializeVerifiedPreparedRawSourceGeneration(
  generation: PreparedRawSourceGeneration,
  destinationDir: string,
  generatedAt: string,
): Promise<{
  manifest: {
    schemaVersion: 1
    generatedAt: string
    start: string
    end: string
    files: { oracleCsv: string[]; leaguepediaJson: string[]; lolEsportsJson: string[] }
    sourceReceipt: {
      storageMode: string
      generationId: string
      rawIdentityDigest: string
      sourceReceiptDigest: string
    }
    sources: unknown
    warnings: unknown
    refreshWindow?: unknown
  }
  manifestPath: string
}>
