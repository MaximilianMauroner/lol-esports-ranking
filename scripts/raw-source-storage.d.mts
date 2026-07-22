export const RAW_SOURCE_STORAGE_MODE: 'content-addressed-raw-gzip-v1'
export const RAW_SOURCE_RECEIPT_KIND: 'raw-source-generation-receipt'
export const ORACLE_BASELINE_KIND: 'oracle-complete-game-baseline'
export const ORACLE_DELTA_KIND: 'oracle-date-league-delta'
export const NARROW_SOURCE_KIND: 'raw-narrow-provider-file'

export type RawObjectReference = {
  key: string
  sha256: string
  bytes: number
  compressedBytes: number
  storageEncoding: 'gzip'
}

export type PreparedRawObject<T extends object = Record<string, unknown>> = {
  value: T
  canonicalJson: string
  canonicalBytes: Buffer
  digest: string
  bytes: number
  compressed: Buffer
  compressedBytes: number
}

export type OraclePartition = { utcDate: string; league: string }
export type CanonicalOracleGame = {
  gameId: string
  date: string
  league: string
  rows: string[][]
  digest: string
}
export type CanonicalOracleSource = {
  sourceFileName: string
  importerVersion: string
  header: string[]
  headerDigest: string
  games: CanonicalOracleGame[]
  digest: string
}

export type OracleDeltaMutation =
  | { operation: 'add'; gameId: string; game: CanonicalOracleGame }
  | { operation: 'replace'; gameId: string; expectedPreviousDigest: string; game: CanonicalOracleGame }
  | { operation: 'delete'; gameId: string; expectedPreviousDigest: string }

export type OracleBaselineObject = {
  artifactKind: 'oracle-complete-game-baseline'
  schemaVersion: 1
  importerVersion: string
  sourceFileName: string
  header: string[]
  headerDigest: string
  oracleDigest: string
  games: CanonicalOracleGame[]
}

export type OracleDeltaObject = {
  artifactKind: 'oracle-date-league-delta'
  schemaVersion: 1
  importerVersion: string
  sourceFileName: string
  header: string[]
  headerDigest: string
  partition: OraclePartition
  previousOracleDigest: string
  nextOracleDigest: string
  mutations: OracleDeltaMutation[]
}

export type NarrowProvider = 'leaguepedia' | 'lolesports'
export type NarrowSourceObject = {
  artifactKind: 'raw-narrow-provider-file'
  schemaVersion: 1
  provider: NarrowProvider
  importerVersion: string
  sourceFileName: string
  contentSha256: string
  content: string
}

export type RawReceiptOracleSource = {
  sourceFileName: string
  headerDigest: string
  effectiveOracleDigest: string
  baseline: RawObjectReference
  deltas: RawObjectReference[]
}
export type RawReceiptNarrowSource = {
  sourceFileName: string
  contentSha256: string
  object: RawObjectReference
}
export type RawSourceReceipt = {
  artifactKind: 'raw-source-generation-receipt'
  schemaVersion: 1
  storageMode: 'content-addressed-raw-gzip-v1'
  generationId: string
  importerVersion: string
  coverage: { start: string; end: string }
  rawIdentityDigest: string
  sourceReceiptInputs: Record<string, unknown>
  sourceReceiptDigest: string
  oracle: RawReceiptOracleSource[]
  leaguepedia: RawReceiptNarrowSource[]
  lolesports: RawReceiptNarrowSource[]
}

export function prepareRawObject<T extends object>(value: T): PreparedRawObject<T>
export function rawObjectReferenceFor(prepared: PreparedRawObject): RawObjectReference
export function decodeRawObject(reference: RawObjectReference, compressed: Uint8Array): Record<string, unknown>

export function parseOracleCsv(csv: string, options: { sourceFileName: string; importerVersion: string }): CanonicalOracleSource
export function prepareOracleBaseline(options: {
  csv: string
  sourceFileName: string
  importerVersion: string
}): {
  source: CanonicalOracleSource
  value: OracleBaselineObject
  prepared: PreparedRawObject<OracleBaselineObject>
  reference: RawObjectReference
}
export function prepareOracleBaselineFromSource(source: CanonicalOracleSource): ReturnType<typeof prepareOracleBaseline>
export function parseOracleBaseline(value: unknown, compatibility?: { importerVersion?: string }): CanonicalOracleSource
export function prepareOracleMutationChain(options: {
  previousSource: CanonicalOracleSource
  nextCsv?: string
  nextSource?: CanonicalOracleSource
}): {
  source: CanonicalOracleSource
  deltas: Array<{ value: OracleDeltaObject; prepared: PreparedRawObject<OracleDeltaObject>; reference: RawObjectReference }>
  mutations: Array<OracleDeltaMutation & { partition: OraclePartition }>
}
export function parseOracleDelta(value: unknown, compatibility?: {
  importerVersion?: string
  sourceFileName?: string
  headerDigest?: string
}): OracleDeltaObject
export function applyOracleDelta(source: CanonicalOracleSource, delta: OracleDeltaObject): CanonicalOracleSource

export function prepareNarrowSourceObject(options: {
  provider: NarrowProvider
  sourceFileName: string
  content: string | Uint8Array
  importerVersion: string
}): {
  value: NarrowSourceObject
  prepared: PreparedRawObject<NarrowSourceObject>
  reference: RawObjectReference
}
export function parseNarrowSourceObject(value: unknown, compatibility?: {
  provider?: NarrowProvider
  importerVersion?: string
}): NarrowSourceObject

export function prepareRawSourceReceipt(options: {
  generationId: string
  importerVersion: string
  coverage: { start: string; end: string }
  sourceReceiptInputs: Record<string, unknown>
  oracle: RawReceiptOracleSource[]
  leaguepedia?: RawReceiptNarrowSource[]
  lolesports?: RawReceiptNarrowSource[]
}): { receipt: RawSourceReceipt; prepared: PreparedRawObject<RawSourceReceipt>; authorityDigest: string }
export function parseRawSourceReceipt(value: unknown): RawSourceReceipt

export type RawObjectResolver = (reference: RawObjectReference) => Uint8Array | undefined | Promise<Uint8Array | undefined>
export type ReconstructedRawSources = {
  receipt: RawSourceReceipt
  oracle: Array<{ sourceFileName: string; csv: string; source: CanonicalOracleSource }>
  leaguepedia: NarrowSourceObject[]
  lolesports: NarrowSourceObject[]
}
export function reconstructRawSourceReceipt(receipt: RawSourceReceipt, objectResolver: RawObjectResolver): Promise<ReconstructedRawSources>
export function materializeRawSourceReceipt(options: {
  receipt: RawSourceReceipt
  objectResolver: RawObjectResolver
  destinationDir: string
  generatedAt: string
}): Promise<ReconstructedRawSources & {
  manifest: Record<string, unknown>
  manifestPath: string
}>
