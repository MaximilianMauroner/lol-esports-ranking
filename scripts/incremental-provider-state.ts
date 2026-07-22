import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { knownTeamIdentities } from '../src/data/teamIdentity.ts'
import type { OracleImportResult } from '../src/lib/importers/oraclesElixir.ts'
import type { LeaguepediaImportResult } from '../src/lib/importers/leaguepedia.ts'
import type { LolEsportsReferenceImportResult } from '../src/lib/importers/lolEsports.ts'
import { transparentGprModelMetadata } from '../src/lib/model.ts'
import { mergeTeamProfiles } from '../src/lib/teamProfiles.ts'
import { decodePrivateState, encodePrivateState } from '../src/lib/incremental/canonicalCodec.ts'
import { buildCanonicalLedger, CANONICAL_LEDGER_SCHEMA_VERSION, type CanonicalLedger } from '../src/lib/incremental/canonicalLedger.ts'
import { reconcileCanonicalObservations } from '../src/lib/incremental/canonicalReconciler.ts'
import type { CanonicalRankingInput } from '../src/lib/incremental/canonicalState.ts'
import { compatibilityFallback, type CrunchCompatibility } from '../src/lib/incremental/compatibility.ts'
import { canonicalContextDigests } from '../src/lib/incremental/dependencyDigests.ts'
import { stableHash, sha256Hex } from '../src/lib/incremental/hash.ts'
import { scanOracleCsv } from '../src/lib/incremental/oracleScanner.ts'
import {
  compatibleFingerprint,
  processProviderFile,
  type ProviderFileFingerprint,
  type ProviderFileLedger,
  type ProviderId,
  type ProviderScanMetrics,
} from '../src/lib/incremental/providerLedger.ts'
import { scanLeaguepediaJson, scanLolEsportsJson } from '../src/lib/incremental/providerScanners.ts'
import type { IncrementalFallbackReason } from '../src/lib/incremental/types.ts'
import {
  isIncrementalReducerCheckpoint,
  reducerDependencyChange,
  canonicalPrefixHash,
  fullMatchCanonicalPrefixHash,
  privateStateHash,
  type IncrementalReducerCheckpoint,
  type PersistedReducerCheckpointCore,
  type ReducerJournalHashes,
  type ReducerCheckpointRetention,
  type ReducerDependencyPlan,
} from '../src/lib/incremental/reducerCheckpoint.ts'
import {
  isIncrementalPlayerCheckpoint,
  type IncrementalPlayerCheckpoint,
  type PersistedPlayerCheckpointCore,
} from '../src/lib/incremental/playerReducer.ts'
import {
  validatePersistedArtifactNodes,
  type PersistedArtifactNode,
} from '../src/lib/incremental/artifactDag.ts'
import {
  validatePersistedSnapshotModelState,
  type PersistedSnapshotModelState,
  type SnapshotModelCacheLookup,
} from '../src/lib/incremental/snapshotInputs.ts'

const LOCAL_STATE_SCHEMA_VERSION = 2 as const

type FileSignature = {
  device: string
  inode: string
  byteLength: number
  modifiedNs: string
  changedNs: string
}

export type ProviderAuthority = {
  receiptId: string
  fileSetAuthoritative: boolean
  contentReplacementAuthoritative: boolean
}

export type ProviderAuthorities = Record<ProviderId, ProviderAuthority>

type ProviderGenerationEntry = {
  sourcePath: string
  provider: ProviderId
  signature: FileSignature
  ledgerHash: string
  authority: ProviderAuthority
  authorityHash: string
  trustedDigest?: string
  trustedBytes?: number
}

type CanonicalGenerationEntry = {
  providerRoot: string
  ledgerHash: string
}

type GenerationFileSet = {
  paths: Record<ProviderId, string[]>
  authorities: ProviderAuthorities
  authorityHash: string
}

type ReducerCheckpointGenerationEntry = {
  processedDate?: string
  checkpointHash: string
  journalHashes: ReducerJournalHashes
  retention: ReducerCheckpointRetention[]
}

type PlayerCheckpointGenerationEntry = {
  processedDate?: string
  checkpointHash: string
  historyHash: string
  retention: ReducerCheckpointRetention[]
}

type StateGeneration = {
  schemaVersion: typeof LOCAL_STATE_SCHEMA_VERSION
  kind: 'incremental-generation'
  providers: Record<string, ProviderGenerationEntry>
  canonical: CanonicalGenerationEntry
  fileSet: GenerationFileSet
  compatibility: CrunchCompatibility
  reducerCheckpoints?: ReducerCheckpointGenerationEntry[]
  playerCheckpoints?: PlayerCheckpointGenerationEntry[]
  artifactCache?: { cacheHash: string; nodeCount: number }
  snapshotModelCache?: SnapshotModelCacheGenerationEntry
}

type SnapshotModelCacheGenerationEntry =
  | { schemaVersion?: 1; cacheHash: string; rankingResults: number; playerResults: number }
  | { schemaVersion: 2; indexHash: string; rankingResults: number; playerResults: number; entryCount: number; entryHashes: string[] }

type SnapshotModelCollection = 'rankingCatalogs' | 'playerCatalogs' | 'rankingResults' | 'playerResults'

type SnapshotModelCacheEntryPayload = {
  schemaVersion: 2
  kind: 'snapshot-model-cache-entry'
  compatibilityHash: string
  collection: SnapshotModelCollection
  key: string
  value: unknown
}

type SnapshotModelCacheEntryReference = {
  collection: SnapshotModelCollection
  key: string
  hash: string
  bytes: number
}

type SnapshotModelCacheIndexV2 = {
  schemaVersion: 2
  kind: 'snapshot-model-cache-index'
  compatibilityHash: string
  entries: SnapshotModelCacheEntryReference[]
}

export type IncrementalStateTreeSummary = {
  generationHash: string
  compatibilityHash: string
  providerRoot: string
  canonicalRoot: string
  contextRoot: string
  componentRoot: string
  stateRoot: string
  reachablePaths: string[]
  retention: ReducerCheckpointRetention[]
  retentionBoundaries: Array<{ processedDate?: string; classes: ReducerCheckpointRetention[] }>
}

type ActiveGenerationPointer = {
  schemaVersion: typeof LOCAL_STATE_SCHEMA_VERSION
  kind: 'active-generation'
  generationHash: string
}

type ContentEnvelope = {
  schemaVersion: typeof LOCAL_STATE_SCHEMA_VERSION
  kind: 'provider-ledger' | 'canonical-ledger' | 'state-generation' | 'reducer-checkpoint' | 'reducer-journal' | 'player-checkpoint' | 'player-history-journal' | 'artifact-cache' | 'snapshot-model-cache' | 'snapshot-model-cache-index' | 'snapshot-model-cache-entry'
  contentHash: string
  payload: unknown
}

export type PendingIncrementalStateWrite = { path: string; contents: string }

type ProviderPathResult = {
  ledger?: ProviderFileLedger
  fallback?: IncrementalFallbackReason
  metrics: ProviderScanMetrics
  contentRead: boolean
  objectWrite?: PendingIncrementalStateWrite
  entry?: ProviderGenerationEntry
}

type LoadedProviderState = { entry: ProviderGenerationEntry; ledger: ProviderFileLedger }

type LoadedGeneration = {
  generation: StateGeneration
  providers: Map<string, LoadedProviderState>
  canonicalLedger: CanonicalLedger
  reducerCheckpoints: IncrementalReducerCheckpoint[]
  playerCheckpoints: IncrementalPlayerCheckpoint[]
  artifactCache: PersistedArtifactNode[]
  snapshotModelCache?: PersistedSnapshotModelState | LazySnapshotModelCacheLookup
  checkpointLoader?: IncrementalCheckpointLoader
}

type ReducerStateIOMetrics = { bytesRead: number; objectsRead: number; objectsDecoded: number }

type LazySnapshotModelCacheLookup = SnapshotModelCacheLookup & {
  bindMetrics(metrics: IncrementalLoadMetrics): void
}

export type IncrementalStatePromotion = {
  stagedWrites: PendingIncrementalStateWrite[]
  pointerWrite: PendingIncrementalStateWrite
  reducerStateBytesWritten: number
}

export type IncrementalLoadMetrics = ProviderScanMetrics & {
  filesScanned: number
  reducerStateBytesRead: number
  reducerStateBytesWritten: number
}

export type IncrementalCommunityImports = {
  oracleImports: OracleImportResult[]
  leaguepediaImports: LeaguepediaImportResult[]
  lolEsportsImports: LolEsportsReferenceImportResult[]
  metrics: IncrementalLoadMetrics
  canonical: CanonicalRankingInput
}

export type IncrementalCommunityLoadResult = {
  imports?: IncrementalCommunityImports
  promotion?: IncrementalStatePromotion
  fallback?: IncrementalFallbackReason
  metrics: IncrementalLoadMetrics
  reducerCheckpoint?: IncrementalReducerCheckpoint
  reducerCheckpoints?: IncrementalReducerCheckpoint[]
  playerCheckpoint?: IncrementalPlayerCheckpoint
  playerCheckpoints?: IncrementalPlayerCheckpoint[]
  artifactCache?: PersistedArtifactNode[]
  snapshotModelCache?: PersistedSnapshotModelState | SnapshotModelCacheLookup
  checkpointLoader?: IncrementalCheckpointLoader
}

export type IncrementalCheckpointLoader = {
  bindMetrics(metrics: IncrementalLoadMetrics): void
  loadReducerCheckpoints(matches: CanonicalRankingInput['matches'], dependencyPlan: ReducerDependencyPlan): Promise<IncrementalReducerCheckpoint[]>
  loadPlayerCheckpoints(matches: CanonicalRankingInput['matches'], dependencyHash: string): Promise<IncrementalPlayerCheckpoint[]>
}

export async function loadIncrementalCommunityImports({
  stateDir,
  oracleCsvPaths,
  leaguepediaJsonPaths,
  lolEsportsJsonPaths,
  oracleRetrievedAt,
  now,
  authorities,
  compatibility,
  sourceIds,
  trustedSources,
}: {
  stateDir: string
  oracleCsvPaths: string[]
  leaguepediaJsonPaths: string[]
  lolEsportsJsonPaths: string[]
  oracleRetrievedAt: string
  now: string
  authorities: ProviderAuthorities
  compatibility: CrunchCompatibility
  sourceIds?: Partial<Record<ProviderId, string[]>>
  trustedSources?: Partial<Record<ProviderId, Record<string, { digest: string; bytes: number }>>>
}): Promise<IncrementalCommunityLoadResult> {
  const reducerStateIO: ReducerStateIOMetrics = { bytesRead: 0, objectsRead: 0, objectsDecoded: 0 }
  let active: LoadedGeneration | undefined
  let restoreFallback: IncrementalFallbackReason | undefined
  try {
    active = await loadActiveGeneration(stateDir, reducerStateIO)
  } catch (error) {
    restoreFallback = checkpointCorrupt(error)
  }
  if (!active && !restoreFallback) {
    restoreFallback = { kind: 'checkpoint-unavailable', detail: 'No active incremental generation; cold bootstrap requires reference parity' }
  }
  if (active) {
    const fallback = compatibilityFallback(compatibility, active.generation.compatibility)
    if (fallback) {
      restoreFallback = fallback
      active = undefined
    }
  }

  const oracleSources = providerSources('oracles-elixir', oracleCsvPaths, sourceIds?.['oracles-elixir'], trustedSources?.['oracles-elixir'])
  const leaguepediaSources = providerSources('leaguepedia-cargo', leaguepediaJsonPaths, sourceIds?.['leaguepedia-cargo'], trustedSources?.['leaguepedia-cargo'])
  const lolEsportsSources = providerSources('lol-esports-api', lolEsportsJsonPaths, sourceIds?.['lol-esports-api'], trustedSources?.['lol-esports-api'])
  const currentFileSet = fileSetFor({ oracleSources, leaguepediaSources, lolEsportsSources, authorities })
  const removedFallback = active ? removedFileFallback(active.generation.fileSet, currentFileSet) : undefined
  try {
    const oracle = await Promise.all(oracleSources.map(({ path, sourceId, trusted }) => loadProviderPath({
      path, sourceId,
      trusted,
      provider: 'oracles-elixir',
      stateDir,
      oracleRetrievedAt,
      now,
      authority: authorities['oracles-elixir'],
      previous: active ? previousProviderState(active, 'oracles-elixir', sourceId, path) : undefined,
    })))
    const leaguepedia = await Promise.all(leaguepediaSources.map(({ path, sourceId, trusted }) => loadProviderPath({
      path, sourceId,
      trusted,
      provider: 'leaguepedia-cargo',
      stateDir,
      oracleRetrievedAt,
      now,
      authority: authorities['leaguepedia-cargo'],
      previous: active ? previousProviderState(active, 'leaguepedia-cargo', sourceId, path) : undefined,
    })))
    const lolEsports = await Promise.all(lolEsportsSources.map(({ path, sourceId, trusted }) => loadProviderPath({
      path, sourceId,
      trusted,
      provider: 'lol-esports-api',
      stateDir,
      oracleRetrievedAt,
      now,
      authority: authorities['lol-esports-api'],
      previous: active ? previousProviderState(active, 'lol-esports-api', sourceId, path) : undefined,
    })))
    const results = [...oracle, ...leaguepedia, ...lolEsports]
    const metrics = { ...aggregateMetrics(results), reducerStateBytesRead: reducerStateIO.bytesRead }
    if (active?.snapshotModelCache && 'bindMetrics' in active.snapshotModelCache) {
      active.snapshotModelCache.bindMetrics(metrics)
    }
    active?.checkpointLoader?.bindMetrics(metrics)
    const providerFallback = results.find((result) => result.fallback)?.fallback
    if (removedFallback || providerFallback) return { fallback: removedFallback ?? providerFallback, metrics }

    const successful = results
      .filter((result): result is ProviderPathResult & { ledger: ProviderFileLedger; entry: ProviderGenerationEntry } => Boolean(result.ledger && result.entry))
      .toSorted((left, right) => providerIdentity(left.entry).localeCompare(providerIdentity(right.entry)))
    const ledgers = successful.map((result) => result.ledger)
    const canonical = loadCanonicalState({ stateDir, ledgers, previous: active })
    const generation: StateGeneration = {
      schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
      kind: 'incremental-generation',
      providers: Object.fromEntries(successful
        .map((result) => [providerKey(result.entry.provider, result.entry.sourcePath), result.entry] as const)
        .sort(([left], [right]) => left.localeCompare(right))),
      canonical: canonical.entry,
      fileSet: currentFileSet,
      compatibility,
      ...(active?.generation.reducerCheckpoints ? { reducerCheckpoints: active.generation.reducerCheckpoints } : {}),
      ...(active?.generation.playerCheckpoints ? { playerCheckpoints: active.generation.playerCheckpoints } : {}),
      ...(active?.generation.artifactCache ? { artifactCache: active.generation.artifactCache } : {}),
      ...(active?.generation.snapshotModelCache ? { snapshotModelCache: active.generation.snapshotModelCache } : {}),
    }
    const generationHash = stableHash(generation)
    const stagedWrites = uniqueWrites([
      ...successful.flatMap((result) => result.objectWrite ? [result.objectWrite] : []),
      ...(canonical.objectWrite ? [canonical.objectWrite] : []),
      contentWrite(resolve(stateDir, 'generations', `${generationHash}.json`), 'state-generation', generationHash, generation),
    ])
    const promotion: IncrementalStatePromotion = {
      stagedWrites,
      reducerStateBytesWritten: 0,
      pointerWrite: privateWrite(resolve(stateDir, 'active-generation.json'), {
        schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
        kind: 'active-generation',
        generationHash,
      } satisfies ActiveGenerationPointer),
    }
    const imports: IncrementalCommunityImports = {
      oracleImports: ledgers.filter((ledger) => ledger.fingerprint.provider === 'oracles-elixir').map(oracleImportFor),
      leaguepediaImports: ledgers.filter((ledger) => ledger.fingerprint.provider === 'leaguepedia-cargo').map(leaguepediaImportFor),
      lolEsportsImports: ledgers.filter((ledger) => ledger.fingerprint.provider === 'lol-esports-api').map(lolEsportsImportFor),
      canonical: canonical.canonical,
      metrics,
    }
    return {
      imports,
      promotion,
      metrics,
      ...(active?.reducerCheckpoints.length ? {
        reducerCheckpoint: active.reducerCheckpoints.at(-1),
        reducerCheckpoints: active.reducerCheckpoints,
      } : {}),
      ...(active?.playerCheckpoints.length ? {
        playerCheckpoint: active.playerCheckpoints.at(-1),
        playerCheckpoints: active.playerCheckpoints,
      } : {}),
      ...(active?.artifactCache.length ? { artifactCache: active.artifactCache } : {}),
      ...(active?.snapshotModelCache ? { snapshotModelCache: active.snapshotModelCache } : {}),
      ...(active?.checkpointLoader ? { checkpointLoader: active.checkpointLoader } : {}),
      ...(restoreFallback ? { fallback: restoreFallback } : {}),
    }
  } catch (error) {
    return { fallback: checkpointCorrupt(error), metrics: { ...emptyMetrics(), reducerStateBytesRead: reducerStateIO.bytesRead } }
  }
}

export async function stageIncrementalState(promotion: IncrementalStatePromotion): Promise<{ reducerStateBytesWritten: number }> {
  for (const write of promotion.stagedWrites) await atomicWrite(write)
  return { reducerStateBytesWritten: promotion.reducerStateBytesWritten }
}

export async function promoteIncrementalState(promotion: IncrementalStatePromotion): Promise<{ reducerStateBytesWritten: number }> {
  await stageIncrementalState(promotion)
  await atomicWrite(promotion.pointerWrite)
  return { reducerStateBytesWritten: promotion.reducerStateBytesWritten }
}

export async function validateIncrementalStateTree(
  stateDir: string,
  expectedCompatibilityHash?: string,
): Promise<IncrementalStateTreeSummary> {
  const loaded = await loadActiveGeneration(stateDir, { bytesRead: 0 })
  if (!loaded) throw new Error('No active incremental generation')
  if (expectedCompatibilityHash !== undefined && loaded.generation.compatibility.hash !== expectedCompatibilityHash) {
    throw new Error('Incremental generation compatibility hash mismatch')
  }
  const pointer = parseActivePointer(decodePrivateState(await readFile(resolve(stateDir, 'active-generation.json'), 'utf8')))
  return stateTreeSummary(pointer.generationHash, loaded.generation, loaded.canonicalLedger)
}

export async function describeIncrementalStateTransition(
  promotion: IncrementalStatePromotion,
  stateDir: string,
): Promise<{ previous?: IncrementalStateTreeSummary; next: IncrementalStateTreeSummary; semanticNoChange: boolean }> {
  const previous = await validateIncrementalStateTree(stateDir).catch(() => undefined)
  const pointer = parseActivePointer(decodePrivateState(promotion.pointerWrite.contents))
  const generationPath = resolve(stateDir, 'generations', `${pointer.generationHash}.json`)
  const generationWrite = promotion.stagedWrites.find((write) => write.path === generationPath)
  if (!generationWrite) throw new Error('Pending incremental generation is unavailable for transition inspection')
  const generationEnvelope = decodePrivateState(generationWrite.contents)
  if (!isRecord(generationEnvelope) || generationEnvelope.kind !== 'state-generation' || !isRecord(generationEnvelope.payload)) {
    throw new Error('Invalid pending incremental generation envelope')
  }
  const generation = generationEnvelope.payload as StateGeneration
  verifyGeneration(generation)
  const canonicalPath = resolve(stateDir, 'canonical', 'objects', `${generation.canonical.ledgerHash}.json`)
  const canonicalWrite = promotion.stagedWrites.find((write) => write.path === canonicalPath)
  const canonicalLedger = canonicalWrite
    ? contentPayload<CanonicalLedger>(canonicalWrite.contents, 'canonical-ledger', generation.canonical.ledgerHash)
    : await readContentObject<CanonicalLedger>(canonicalPath, 'canonical-ledger', generation.canonical.ledgerHash)
  verifyCanonicalLedger(canonicalLedger)
  const next = stateTreeSummary(pointer.generationHash, generation, canonicalLedger)
  return { previous, next, semanticNoChange: previous?.stateRoot === next.stateRoot }
}

export async function describeIncrementalInputTransition(
  promotion: IncrementalStatePromotion,
  stateDir: string,
): Promise<{ providerRoot: string; canonicalRoot: string; contextRoot: string }> {
  const pointer = parseActivePointer(decodePrivateState(promotion.pointerWrite.contents))
  const generationPath = resolve(stateDir, 'generations', `${pointer.generationHash}.json`)
  const generationWrite = promotion.stagedWrites.find((write) => write.path === generationPath)
  if (!generationWrite) throw new Error('Pending incremental generation is unavailable for input inspection')
  const generation = contentPayload<StateGeneration>(generationWrite.contents, 'state-generation', pointer.generationHash)
  verifyGeneration(generation)
  const canonicalPath = resolve(stateDir, 'canonical', 'objects', `${generation.canonical.ledgerHash}.json`)
  const canonicalWrite = promotion.stagedWrites.find((write) => write.path === canonicalPath)
  const canonicalLedger = canonicalWrite
    ? contentPayload<CanonicalLedger>(canonicalWrite.contents, 'canonical-ledger', generation.canonical.ledgerHash)
    : await readContentObject<CanonicalLedger>(canonicalPath, 'canonical-ledger', generation.canonical.ledgerHash)
  verifyCanonicalLedger(canonicalLedger)
  return {
    providerRoot: generation.canonical.providerRoot,
    canonicalRoot: canonicalLedger.rootHash,
    contextRoot: stableHash(canonicalLedger.contextDigests),
  }
}

export function attachIncrementalReducerCheckpoint(
  promotion: IncrementalStatePromotion,
  stateDir: string,
  checkpointOrHistory: IncrementalReducerCheckpoint | IncrementalReducerCheckpoint[],
): IncrementalStatePromotion {
  const pointer = parseActivePointer(decodePrivateState(promotion.pointerWrite.contents))
  const generationPath = resolve(stateDir, 'generations', `${pointer.generationHash}.json`)
  const generationWrite = promotion.stagedWrites.find((write) => write.path === generationPath)
  if (!generationWrite) throw new Error('Pending incremental generation is unavailable for reducer checkpoint attachment')
  const envelope = decodePrivateState(generationWrite.contents)
  if (!isRecord(envelope) || envelope.kind !== 'state-generation' || !isRecord(envelope.payload)) {
    throw new Error('Invalid pending incremental generation envelope')
  }
  const generation = envelope.payload as StateGeneration
  verifyGeneration(generation)
  const checkpoints = Array.isArray(checkpointOrHistory) ? checkpointOrHistory : [checkpointOrHistory]
  const checkpointWrites: PendingIncrementalStateWrite[] = []
  const newReducerCheckpoints = checkpoints.map((checkpoint): ReducerCheckpointGenerationEntry => {
    const journalHashes: ReducerJournalHashes = {
      histories: privateStateHash(checkpoint.team.journals.histories),
      predictions: privateStateHash(checkpoint.team.journals.predictions),
      leagueHistory: privateStateHash(checkpoint.team.journals.leagueHistory),
    }
    const core: PersistedReducerCheckpointCore = {
      schemaVersion: checkpoint.schemaVersion,
      processedDate: checkpoint.processedDate,
      canonicalPrefixHash: checkpoint.canonicalPrefixHash,
      dependencyHash: checkpoint.dependencyHash,
      dependencyPlan: checkpoint.dependencyPlan,
      retention: checkpoint.retention,
      livePlayerEdge: checkpoint.livePlayerEdge,
      team: {
        schemaVersion: checkpoint.team.schemaVersion,
        processedDate: checkpoint.team.processedDate,
        state: checkpoint.team.state,
      },
      teamJournalHashes: journalHashes,
    }
    const checkpointHash = privateStateHash(core)
    checkpointWrites.push(
      contentWrite(resolve(stateDir, 'reducers', 'journals', 'histories', `${journalHashes.histories}.json`), 'reducer-journal', journalHashes.histories, checkpoint.team.journals.histories),
      contentWrite(resolve(stateDir, 'reducers', 'journals', 'predictions', `${journalHashes.predictions}.json`), 'reducer-journal', journalHashes.predictions, checkpoint.team.journals.predictions),
      contentWrite(resolve(stateDir, 'reducers', 'journals', 'league-history', `${journalHashes.leagueHistory}.json`), 'reducer-journal', journalHashes.leagueHistory, checkpoint.team.journals.leagueHistory),
      contentWrite(resolve(stateDir, 'reducers', 'checkpoints', `${checkpointHash}.json`), 'reducer-checkpoint', checkpointHash, core),
    )
    return { processedDate: checkpoint.processedDate, checkpointHash, journalHashes, retention: checkpoint.retention }
  })
  const reducerCheckpoints = mergeCheckpointEntries(generation.reducerCheckpoints ?? [], newReducerCheckpoints)
  const nextGeneration: StateGeneration = { ...generation, reducerCheckpoints }
  const generationHash = stableHash(nextGeneration)
  const reducerWrites = uniqueWrites(checkpointWrites)
  return {
    stagedWrites: uniqueWrites([
      ...promotion.stagedWrites.filter((write) => write.path !== generationPath),
      ...reducerWrites,
      contentWrite(resolve(stateDir, 'generations', `${generationHash}.json`), 'state-generation', generationHash, nextGeneration),
    ]),
    pointerWrite: privateWrite(resolve(stateDir, 'active-generation.json'), {
      schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
      kind: 'active-generation',
      generationHash,
    } satisfies ActiveGenerationPointer),
    reducerStateBytesWritten: reducerWrites.reduce((total, write) => total + encodedByteLength(write.contents), 0),
  }
}

export function attachIncrementalPlayerCheckpoints(
  promotion: IncrementalStatePromotion,
  stateDir: string,
  checkpointOrHistory: IncrementalPlayerCheckpoint | IncrementalPlayerCheckpoint[],
): IncrementalStatePromotion {
  const pointer = parseActivePointer(decodePrivateState(promotion.pointerWrite.contents))
  const generationPath = resolve(stateDir, 'generations', `${pointer.generationHash}.json`)
  const generationWrite = promotion.stagedWrites.find((write) => write.path === generationPath)
  if (!generationWrite) throw new Error('Pending incremental generation is unavailable for player checkpoint attachment')
  const envelope = decodePrivateState(generationWrite.contents)
  if (!isRecord(envelope) || envelope.kind !== 'state-generation' || !isRecord(envelope.payload)) {
    throw new Error('Invalid pending incremental generation envelope')
  }
  const generation = envelope.payload as StateGeneration
  verifyGeneration(generation)
  const checkpoints = Array.isArray(checkpointOrHistory) ? checkpointOrHistory : [checkpointOrHistory]
  const checkpointWrites: PendingIncrementalStateWrite[] = []
  const newPlayerCheckpoints = checkpoints.map((checkpoint): PlayerCheckpointGenerationEntry => {
    const historyHash = privateStateHash(checkpoint.player.history)
    const core: PersistedPlayerCheckpointCore = {
      schemaVersion: checkpoint.schemaVersion,
      processedDate: checkpoint.processedDate,
      canonicalPrefixHash: checkpoint.canonicalPrefixHash,
      dependencyHash: checkpoint.dependencyHash,
      residualControlHash: checkpoint.residualControlHash,
      retention: checkpoint.retention,
      player: {
        schemaVersion: checkpoint.player.schemaVersion,
        processedDate: checkpoint.player.processedDate,
        processedRows: checkpoint.player.processedRows,
        mode: checkpoint.player.mode,
        state: checkpoint.player.state,
        latestRosterByTeam: checkpoint.player.latestRosterByTeam,
      },
      historyHash,
    }
    const checkpointHash = privateStateHash(core)
    checkpointWrites.push(
      contentWrite(
        resolve(stateDir, 'players', 'journals', 'history', `${historyHash}.json`),
        'player-history-journal',
        historyHash,
        checkpoint.player.history,
      ),
      contentWrite(
        resolve(stateDir, 'players', 'checkpoints', `${checkpointHash}.json`),
        'player-checkpoint',
        checkpointHash,
        core,
      ),
    )
    return { processedDate: checkpoint.processedDate, checkpointHash, historyHash, retention: checkpoint.retention }
  })
  const playerCheckpoints = mergeCheckpointEntries(generation.playerCheckpoints ?? [], newPlayerCheckpoints)
  const nextGeneration: StateGeneration = { ...generation, playerCheckpoints }
  const generationHash = stableHash(nextGeneration)
  const playerWrites = uniqueWrites(checkpointWrites)
  return {
    stagedWrites: uniqueWrites([
      ...promotion.stagedWrites.filter((write) => write.path !== generationPath),
      ...playerWrites,
      contentWrite(resolve(stateDir, 'generations', `${generationHash}.json`), 'state-generation', generationHash, nextGeneration),
    ]),
    pointerWrite: privateWrite(resolve(stateDir, 'active-generation.json'), {
      schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
      kind: 'active-generation',
      generationHash,
    } satisfies ActiveGenerationPointer),
    reducerStateBytesWritten: promotion.reducerStateBytesWritten
      + playerWrites.reduce((total, write) => total + encodedByteLength(write.contents), 0),
  }
}

export function attachIncrementalArtifactCache(
  promotion: IncrementalStatePromotion,
  stateDir: string,
  artifactCache: PersistedArtifactNode[],
): IncrementalStatePromotion {
  validatePersistedArtifactNodes(artifactCache)
  const pointer = parseActivePointer(decodePrivateState(promotion.pointerWrite.contents))
  const generationPath = resolve(stateDir, 'generations', `${pointer.generationHash}.json`)
  const generationWrite = promotion.stagedWrites.find((write) => write.path === generationPath)
  if (!generationWrite) throw new Error('Pending incremental generation is unavailable for artifact cache attachment')
  const envelope = decodePrivateState(generationWrite.contents)
  if (!isRecord(envelope) || envelope.kind !== 'state-generation' || !isRecord(envelope.payload)) {
    throw new Error('Invalid pending incremental generation envelope')
  }
  const generation = envelope.payload as StateGeneration
  verifyGeneration(generation)
  const cacheHash = privateStateHash(artifactCache)
  const cacheWrite = contentWrite(
    resolve(stateDir, 'artifacts', 'caches', `${cacheHash}.json`),
    'artifact-cache',
    cacheHash,
    artifactCache,
  )
  const nextGeneration: StateGeneration = {
    ...generation,
    artifactCache: { cacheHash, nodeCount: artifactCache.length },
  }
  const generationHash = stableHash(nextGeneration)
  return {
    stagedWrites: uniqueWrites([
      ...promotion.stagedWrites.filter((write) => write.path !== generationPath),
      cacheWrite,
      contentWrite(resolve(stateDir, 'generations', `${generationHash}.json`), 'state-generation', generationHash, nextGeneration),
    ]),
    pointerWrite: privateWrite(resolve(stateDir, 'active-generation.json'), {
      schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
      kind: 'active-generation',
      generationHash,
    } satisfies ActiveGenerationPointer),
    reducerStateBytesWritten: promotion.reducerStateBytesWritten + encodedByteLength(cacheWrite.contents),
  }
}

function mergeCheckpointEntries<T extends { processedDate?: string }>(previous: T[], next: T[]): T[] {
  return [...new Map([...previous, ...next].map((entry) => [entry.processedDate ?? '', entry])).values()]
    .toSorted((left, right) => (left.processedDate ?? '').localeCompare(right.processedDate ?? ''))
}

export function attachIncrementalSnapshotModelCache(
  promotion: IncrementalStatePromotion,
  stateDir: string,
  snapshotModelCache: PersistedSnapshotModelState,
): IncrementalStatePromotion {
  validatePersistedSnapshotModelState(snapshotModelCache)
  const pointer = parseActivePointer(decodePrivateState(promotion.pointerWrite.contents))
  const generationPath = resolve(stateDir, 'generations', `${pointer.generationHash}.json`)
  const generationWrite = promotion.stagedWrites.find((write) => write.path === generationPath)
  if (!generationWrite) throw new Error('Pending incremental generation is unavailable for snapshot model cache attachment')
  const envelope = decodePrivateState(generationWrite.contents)
  if (!isRecord(envelope) || envelope.kind !== 'state-generation' || !isRecord(envelope.payload)) {
    throw new Error('Invalid pending incremental generation envelope')
  }
  const generation = envelope.payload as StateGeneration
  verifyGeneration(generation)
  const entryWrites: PendingIncrementalStateWrite[] = []
  const entries: SnapshotModelCacheEntryReference[] = []
  for (const collection of snapshotModelCollections()) {
    for (const [key, value] of [...snapshotModelCache[collection]].sort(([left], [right]) => left.localeCompare(right))) {
      const payload: SnapshotModelCacheEntryPayload = {
        schemaVersion: 2,
        kind: 'snapshot-model-cache-entry',
        compatibilityHash: snapshotModelCache.compatibilityHash,
        collection,
        key,
        value,
      }
      const hash = privateStateHash(payload)
      const write = contentWrite(
        resolve(stateDir, 'snapshot-models', 'entries', `${hash}.json`),
        'snapshot-model-cache-entry',
        hash,
        payload,
      )
      entryWrites.push(write)
      entries.push({ collection, key, hash, bytes: encodedByteLength(write.contents) })
    }
  }
  const index: SnapshotModelCacheIndexV2 = {
    schemaVersion: 2,
    kind: 'snapshot-model-cache-index',
    compatibilityHash: snapshotModelCache.compatibilityHash,
    entries,
  }
  validateSnapshotModelCacheIndex(index, snapshotModelCache.compatibilityHash)
  const indexHash = privateStateHash(index)
  const indexWrite = contentWrite(
    resolve(stateDir, 'snapshot-models', 'indexes', `${indexHash}.json`),
    'snapshot-model-cache-index',
    indexHash,
    index,
  )
  const nextGeneration: StateGeneration = {
    ...generation,
    snapshotModelCache: {
      schemaVersion: 2,
      indexHash,
      rankingResults: snapshotModelCache.rankingResults.size,
      playerResults: snapshotModelCache.playerResults.size,
      entryCount: entries.length,
      entryHashes: entries.map((entry) => entry.hash).toSorted(),
    },
  }
  const generationHash = stableHash(nextGeneration)
  return {
    stagedWrites: uniqueWrites([
      ...promotion.stagedWrites.filter((write) => write.path !== generationPath),
      ...entryWrites,
      indexWrite,
      contentWrite(resolve(stateDir, 'generations', `${generationHash}.json`), 'state-generation', generationHash, nextGeneration),
    ]),
    pointerWrite: privateWrite(resolve(stateDir, 'active-generation.json'), {
      schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
      kind: 'active-generation',
      generationHash,
    } satisfies ActiveGenerationPointer),
    reducerStateBytesWritten: promotion.reducerStateBytesWritten
      + entryWrites.reduce((sum, write) => sum + encodedByteLength(write.contents), 0)
      + encodedByteLength(indexWrite.contents),
  }
}

async function loadActiveGeneration(stateDir: string, reducerStateIO: ReducerStateIOMetrics): Promise<LoadedGeneration | undefined> {
  const pointerValue = await readOptionalPrivateState(resolve(stateDir, 'active-generation.json'))
  if (pointerValue === undefined) return undefined
  const pointer = parseActivePointer(pointerValue)
  const generation = await readContentObject<StateGeneration>(
    resolve(stateDir, 'generations', `${pointer.generationHash}.json`),
    'state-generation',
    pointer.generationHash,
  )
  verifyGeneration(generation)
  const providers = new Map<string, LoadedProviderState>()
  for (const [key, rawEntry] of Object.entries(generation.providers).sort(([left], [right]) => left.localeCompare(right))) {
    const entry = parseProviderEntry(rawEntry)
    if (key !== providerKey(entry.provider, entry.sourcePath)) throw new Error(`Provider generation key mismatch for ${entry.sourcePath}`)
    const ledger = await readContentObject<ProviderFileLedger>(resolve(stateDir, 'providers', 'objects', `${entry.ledgerHash}.json`), 'provider-ledger', entry.ledgerHash)
    verifyProviderLedger(ledger)
    providers.set(key, { entry, ledger })
  }
  const canonicalLedger = await readContentObject<CanonicalLedger>(
    resolve(stateDir, 'canonical', 'objects', `${generation.canonical.ledgerHash}.json`),
    'canonical-ledger',
    generation.canonical.ledgerHash,
  )
  verifyCanonicalLedger(canonicalLedger)
  validateGenerationLinkage(generation, providers, canonicalLedger)
  const reducerCores: Array<{ entry: ReducerCheckpointGenerationEntry; core: PersistedReducerCheckpointCore }> = []
  for (const entry of generation.reducerCheckpoints ?? []) {
    const core = await readContentObject<PersistedReducerCheckpointCore>(
      resolve(stateDir, 'reducers', 'checkpoints', `${entry.checkpointHash}.json`),
      'reducer-checkpoint',
      entry.checkpointHash,
      reducerStateIO,
    )
    if (stableHash(core.teamJournalHashes) !== stableHash(entry.journalHashes)) throw new Error('Reducer checkpoint journal reference mismatch')
    if (core.processedDate !== entry.processedDate
      || core.processedDate !== core.livePlayerEdge.processedDate
      || core.processedDate !== core.team.processedDate
      || stableHash(core.retention) !== stableHash(entry.retention)
      || core.canonicalPrefixHash !== canonicalPrefixHash(canonicalLedger.matches, core.processedDate)) {
      throw new Error('Incompatible reducer checkpoint object')
    }
    reducerCores.push({ entry, core })
  }
  const playerCores: Array<{ entry: PlayerCheckpointGenerationEntry; core: PersistedPlayerCheckpointCore }> = []
  for (const entry of generation.playerCheckpoints ?? []) {
    const core = await readContentObject<PersistedPlayerCheckpointCore>(
      resolve(stateDir, 'players', 'checkpoints', `${entry.checkpointHash}.json`),
      'player-checkpoint',
      entry.checkpointHash,
      reducerStateIO,
    )
    if (core.historyHash !== entry.historyHash) throw new Error('Player checkpoint history reference mismatch')
    if (core.processedDate !== entry.processedDate
      || core.processedDate !== core.player.processedDate
      || stableHash(core.retention) !== stableHash(entry.retention)
      || core.canonicalPrefixHash !== fullMatchCanonicalPrefixHash(canonicalLedger.matches, core.processedDate)) {
      throw new Error('Incompatible player checkpoint object')
    }
    playerCores.push({ entry, core })
  }
  const checkpointLoader = createCheckpointLoader(stateDir, reducerCores, playerCores, reducerStateIO)
  const artifactCache = generation.artifactCache
    ? await readContentObject<PersistedArtifactNode[]>(
        resolve(stateDir, 'artifacts', 'caches', `${generation.artifactCache.cacheHash}.json`),
        'artifact-cache',
        generation.artifactCache.cacheHash,
        reducerStateIO,
      )
    : []
  validatePersistedArtifactNodes(artifactCache)
  if (generation.artifactCache && artifactCache.length !== generation.artifactCache.nodeCount) {
    throw new Error('Artifact cache node count mismatch')
  }
  const snapshotModelCache = generation.snapshotModelCache
    ? await loadSnapshotModelCache(stateDir, generation.snapshotModelCache, generation.compatibility.hash, reducerStateIO)
    : undefined
  if (snapshotModelCache && 'rankingCatalogs' in snapshotModelCache) {
    validatePersistedSnapshotModelState(snapshotModelCache, generation.compatibility.hash)
    if (snapshotModelCache.rankingResults.size !== generation.snapshotModelCache?.rankingResults
      || snapshotModelCache.playerResults.size !== generation.snapshotModelCache?.playerResults) {
      throw new Error('Snapshot model cache result count mismatch')
    }
  }
  return {
    generation,
    providers,
    canonicalLedger,
    reducerCheckpoints: [],
    playerCheckpoints: [],
    artifactCache,
    snapshotModelCache,
    checkpointLoader,
  }
}

async function loadSnapshotModelCache(
  stateDir: string,
  generationEntry: SnapshotModelCacheGenerationEntry,
  compatibilityHash: string,
  reducerStateIO: ReducerStateIOMetrics,
): Promise<PersistedSnapshotModelState | LazySnapshotModelCacheLookup> {
  if (!('schemaVersion' in generationEntry) || generationEntry.schemaVersion === undefined || generationEntry.schemaVersion === 1) {
    return readContentObject<PersistedSnapshotModelState>(
      resolve(stateDir, 'snapshot-models', 'caches', `${generationEntry.cacheHash}.json`),
      'snapshot-model-cache',
      generationEntry.cacheHash,
      reducerStateIO,
    )
  }
  const index = await readContentObject<SnapshotModelCacheIndexV2>(
    resolve(stateDir, 'snapshot-models', 'indexes', `${generationEntry.indexHash}.json`),
    'snapshot-model-cache-index',
    generationEntry.indexHash,
    reducerStateIO,
  )
  validateSnapshotModelCacheIndex(index, compatibilityHash)
  if (index.entries.length !== generationEntry.entryCount) throw new Error('Snapshot model cache entry count mismatch')
  if (stableHash(index.entries.map((entry) => entry.hash).toSorted()) !== stableHash(generationEntry.entryHashes)) {
    throw new Error('Snapshot model cache generation entry references do not match its index')
  }
  if (index.entries.filter((entry) => entry.collection === 'rankingResults').length !== generationEntry.rankingResults
    || index.entries.filter((entry) => entry.collection === 'playerResults').length !== generationEntry.playerResults) {
    throw new Error('Snapshot model cache result count mismatch')
  }
  const references = new Map(index.entries.map((entry) => [`${entry.collection}\u0000${entry.key}`, entry]))
  let metricsTarget: IncrementalLoadMetrics | undefined
  return {
    schemaVersion: 2,
    compatibilityHash,
    bindMetrics(metrics) {
      metricsTarget = metrics
    },
    get<T>(collection: SnapshotModelCollection, key: string): T | undefined {
      const reference = references.get(`${collection}\u0000${key}`)
      if (!reference) return undefined
      const payload = readContentObjectSync<SnapshotModelCacheEntryPayload>(
        resolve(stateDir, 'snapshot-models', 'entries', `${reference.hash}.json`),
        'snapshot-model-cache-entry',
        reference.hash,
        reducerStateIO,
        reference.bytes,
      )
      if (payload.schemaVersion !== 2 || payload.kind !== 'snapshot-model-cache-entry'
        || payload.compatibilityHash !== compatibilityHash
        || payload.collection !== reference.collection || payload.key !== reference.key) {
        throw new Error('Snapshot model cache entry reference mismatch')
      }
      if (metricsTarget) metricsTarget.reducerStateBytesRead = reducerStateIO.bytesRead
      return payload.value as T
    },
  }
}

function createCheckpointLoader(
  stateDir: string,
  reducerCores: Array<{ entry: ReducerCheckpointGenerationEntry; core: PersistedReducerCheckpointCore }>,
  playerCores: Array<{ entry: PlayerCheckpointGenerationEntry; core: PersistedPlayerCheckpointCore }>,
  reducerStateIO: ReducerStateIOMetrics,
): IncrementalCheckpointLoader {
  let metricsTarget: IncrementalLoadMetrics | undefined
  const syncMetrics = () => {
    if (metricsTarget) metricsTarget.reducerStateBytesRead = reducerStateIO.bytesRead
  }
  return {
    bindMetrics(metrics) {
      metricsTarget = metrics
    },
    async loadReducerCheckpoints(matches, dependencyPlan) {
      const selected = reducerCores
        .filter(({ core }) => reducerCoreCanResume(core, matches, dependencyPlan))
        .toSorted((left, right) => (left.core.processedDate ?? '').localeCompare(right.core.processedDate ?? ''))
        .at(-1)
      if (!selected) return []
      const { entry, core } = selected
      const histories = await readContentObject<IncrementalReducerCheckpoint['team']['journals']['histories']>(
        resolve(stateDir, 'reducers', 'journals', 'histories', `${entry.journalHashes.histories}.json`),
        'reducer-journal', entry.journalHashes.histories, reducerStateIO,
      )
      const predictions = await readContentObject<IncrementalReducerCheckpoint['team']['journals']['predictions']>(
        resolve(stateDir, 'reducers', 'journals', 'predictions', `${entry.journalHashes.predictions}.json`),
        'reducer-journal', entry.journalHashes.predictions, reducerStateIO,
      )
      const leagueHistory = await readContentObject<IncrementalReducerCheckpoint['team']['journals']['leagueHistory']>(
        resolve(stateDir, 'reducers', 'journals', 'league-history', `${entry.journalHashes.leagueHistory}.json`),
        'reducer-journal', entry.journalHashes.leagueHistory, reducerStateIO,
      )
      const checkpoint: IncrementalReducerCheckpoint = {
        schemaVersion: core.schemaVersion,
        processedDate: core.processedDate,
        canonicalPrefixHash: core.canonicalPrefixHash,
        dependencyHash: core.dependencyHash,
        dependencyPlan: core.dependencyPlan,
        retention: core.retention,
        livePlayerEdge: core.livePlayerEdge,
        team: { ...core.team, journals: { histories, predictions, leagueHistory } },
      }
      if (!isIncrementalReducerCheckpoint(checkpoint)) throw new Error('Incompatible selected reducer checkpoint object')
      syncMetrics()
      return [checkpoint]
    },
    async loadPlayerCheckpoints(matches, dependencyHash) {
      const selected = playerCores
        .filter(({ core }) => core.dependencyHash === dependencyHash
          && core.processedDate === core.player.processedDate
          && (!core.processedDate || matches.some((match) => match.date === core.processedDate))
          && core.canonicalPrefixHash === fullMatchCanonicalPrefixHash(matches, core.processedDate))
        .toSorted((left, right) => (left.core.processedDate ?? '').localeCompare(right.core.processedDate ?? ''))
        .at(-1)
      if (!selected) return []
      const { entry, core } = selected
      const history = await readContentObject<IncrementalPlayerCheckpoint['player']['history']>(
        resolve(stateDir, 'players', 'journals', 'history', `${entry.historyHash}.json`),
        'player-history-journal', entry.historyHash, reducerStateIO,
      )
      const checkpoint: IncrementalPlayerCheckpoint = {
        schemaVersion: core.schemaVersion,
        processedDate: core.processedDate,
        canonicalPrefixHash: core.canonicalPrefixHash,
        dependencyHash: core.dependencyHash,
        residualControlHash: core.residualControlHash,
        retention: core.retention,
        player: { ...core.player, history },
      }
      if (!isIncrementalPlayerCheckpoint(checkpoint)) throw new Error('Incompatible selected player checkpoint object')
      syncMetrics()
      return [checkpoint]
    },
  }
}

function reducerCoreCanResume(
  checkpoint: PersistedReducerCheckpointCore,
  matches: CanonicalRankingInput['matches'],
  dependencyPlan: ReducerDependencyPlan,
) {
  const dependencyChange = reducerDependencyChange(checkpoint.dependencyPlan, dependencyPlan)
  if (!dependencyChange.stableCompatible) return false
  if (dependencyChange.influenceDate && (!checkpoint.processedDate || checkpoint.processedDate >= dependencyChange.influenceDate)) return false
  if (checkpoint.processedDate !== checkpoint.livePlayerEdge.processedDate
    || checkpoint.processedDate !== checkpoint.team.processedDate) return false
  if (checkpoint.processedDate && !matches.some((match) => match.date === checkpoint.processedDate)) return false
  return checkpoint.canonicalPrefixHash === canonicalPrefixHash(matches, checkpoint.processedDate)
}

function snapshotModelCollections(): SnapshotModelCollection[] {
  return ['rankingCatalogs', 'playerCatalogs', 'rankingResults', 'playerResults']
}

function validateSnapshotModelCacheIndex(index: SnapshotModelCacheIndexV2, compatibilityHash: string) {
  if (index.schemaVersion !== 2 || index.kind !== 'snapshot-model-cache-index'
    || index.compatibilityHash !== compatibilityHash || !Array.isArray(index.entries)) {
    throw new Error('Invalid snapshot model cache v2 index')
  }
  const keys = new Set<string>()
  for (const entry of index.entries) {
    const identity = `${entry.collection}\u0000${entry.key}`
    if (!snapshotModelCollections().includes(entry.collection) || !entry.key || !entry.hash
      || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || keys.has(identity)) {
      throw new Error('Invalid or duplicate snapshot model cache v2 entry')
    }
    keys.add(identity)
  }
}

function loadCanonicalState({
  stateDir,
  ledgers,
  previous,
}: {
  stateDir: string
  ledgers: ProviderFileLedger[]
  previous?: LoadedGeneration
}): { canonical: CanonicalRankingInput; entry: CanonicalGenerationEntry; objectWrite?: PendingIncrementalStateWrite } {
  const observations = ledgers.flatMap((ledger) => ledger.observations)
  const importedTeams = mergeTeamProfiles(ledgers.map((ledger) => ledger.teams))
  const schedules = observations.flatMap((observation) => observation.kind === 'schedule' ? [observation.payload] : [])
  const contextDigests = canonicalContextDigests({ identities: knownTeamIdentities, profiles: importedTeams, eventWeightContext: transparentGprModelMetadata, schedules })
  const providerRoot = stableHash(ledgers.map(providerCanonicalState))
  if (previous?.generation.canonical.providerRoot === providerRoot) {
    const ledger = previous.canonicalLedger
    if (stableHash(ledger.contextDigests) === stableHash(contextDigests)) {
      return {
        canonical: { matches: ledger.matches, teams: ledger.teams, importedMatches: ledger.importedMatches },
        entry: previous.generation.canonical,
      }
    }
  }
  const canonical = reconcileCanonicalObservations({ observations, importedTeams })
  const ledger = buildCanonicalLedger({ canonical, observations, contextDigests })
  const ledgerHash = stableHash(ledger)
  return {
    canonical,
    entry: { providerRoot, ledgerHash },
    objectWrite: contentWrite(resolve(stateDir, 'canonical', 'objects', `${ledgerHash}.json`), 'canonical-ledger', ledgerHash, ledger),
  }
}

function providerCanonicalState(ledger: ProviderFileLedger) {
  return {
    fingerprint: ledger.fingerprint,
    observations: ledger.observations,
    teams: ledger.teams,
  }
}

async function loadProviderPath({
  path,
  sourceId,
  provider,
  stateDir,
  oracleRetrievedAt,
  now,
  authority,
  previous,
  trusted,
}: {
  path: string
  sourceId: string
  provider: ProviderId
  stateDir: string
  oracleRetrievedAt: string
  now: string
  authority: ProviderAuthority
  previous?: LoadedProviderState
  trusted?: { digest: string; bytes: number }
}): Promise<ProviderPathResult> {
  if (trusted && previous?.entry.trustedDigest === trusted.digest && previous.entry.trustedBytes === trusted.bytes) {
    const ledger = provider === 'oracles-elixir'
      ? { ...previous.ledger, source: { ...previous.ledger.source, retrievedAt: oracleRetrievedAt } }
      : previous.ledger
    const ledgerHash = stableHash(ledger)
    return {
      ledger,
      entry: providerEntry({ sourceId, provider, signature: previous.entry.signature, ledgerHash, authority, trusted }),
      contentRead: false,
      metrics: { bytesScanned: 0, rowsParsed: 0, observationsNormalized: 0, observationsReused: ledger.observations.length },
      ...(ledgerHash === previous.entry.ledgerHash ? {} : { objectWrite: providerObjectWrite(stateDir, ledgerHash, ledger) }),
    }
  }
  const signature = await signatureFor(path)
  const previousLedger = previous?.ledger
  if (previous && equalSignature(previous.entry.signature, signature)) {
    const ledger = provider === 'oracles-elixir'
      ? { ...previous.ledger, source: { ...previous.ledger.source, retrievedAt: oracleRetrievedAt } }
      : previous.ledger
    const ledgerHash = stableHash(ledger)
    return {
      ledger,
      entry: providerEntry({ sourceId, provider, signature, ledgerHash, authority, trusted }),
      contentRead: false,
      metrics: { bytesScanned: 0, rowsParsed: 0, observationsNormalized: 0, observationsReused: ledger.observations.length },
      ...(ledgerHash === previous.entry.ledgerHash ? {} : { objectWrite: providerObjectWrite(stateDir, ledgerHash, ledger) }),
    }
  }

  const contents = await readFile(path, 'utf8')
  const contentHash = sha256Hex(contents)
  if (trusted && (signature.byteLength !== trusted.bytes || contentHash !== trusted.digest)) {
    throw new Error(`Trusted provider chunk mismatch for ${sourceId}`)
  }
  const fingerprint: ProviderFileFingerprint = { provider, fileId: sourceId, byteLength: signature.byteLength, contentHash }
  if (previousLedger && compatibleFingerprint(previousLedger.fingerprint, fingerprint)) {
    const ledger = provider === 'oracles-elixir'
      ? { ...previousLedger, source: { ...previousLedger.source, retrievedAt: oracleRetrievedAt } }
      : previousLedger
    const ledgerHash = stableHash(ledger)
    return {
      ledger,
      entry: providerEntry({ sourceId, provider, signature, ledgerHash, authority, trusted }),
      contentRead: true,
      metrics: { bytesScanned: signature.byteLength, rowsParsed: 0, observationsNormalized: 0, observationsReused: ledger.observations.length },
      ...(ledgerHash === previous?.entry.ledgerHash ? {} : { objectWrite: providerObjectWrite(stateDir, ledgerHash, ledger) }),
    }
  }

  const result = await processProviderFile({
    fingerprint,
    previous: previousLedger,
    authoritativeReplacement: authority.contentReplacementAuthoritative,
    readContents: async () => contents,
    normalize: (source, old) => {
      if (provider === 'oracles-elixir') return scanOracleCsv({ contents: source, fingerprint: { ...fingerprint, provider }, previous: old, retrievedAt: oracleRetrievedAt })
      if (provider === 'leaguepedia-cargo') return scanLeaguepediaJson({ contents: source, fingerprint: { ...fingerprint, provider }, previous: old })
      return scanLolEsportsJson({ contents: source, fingerprint: { ...fingerprint, provider }, previous: old })
    },
    now,
  })
  if (result.fallback) return { fallback: result.fallback, metrics: result.metrics, contentRead: true }
  verifyProviderLedger(result.ledger)
  const ledgerHash = stableHash(result.ledger)
  return {
    ledger: result.ledger,
    entry: providerEntry({ sourceId, provider, signature, ledgerHash, authority, trusted }),
    contentRead: true,
    metrics: result.metrics,
    objectWrite: providerObjectWrite(stateDir, ledgerHash, result.ledger),
  }
}

function providerEntry({
  sourceId,
  provider,
  signature,
  ledgerHash,
  authority,
  trusted,
}: {
  sourceId: string
  provider: ProviderId
  signature: FileSignature
  ledgerHash: string
  authority: ProviderAuthority
  trusted?: { digest: string; bytes: number }
}): ProviderGenerationEntry {
  return {
    sourcePath: sourceId,
    provider,
    signature,
    ledgerHash,
    authority,
    authorityHash: stableHash(authority),
    ...(trusted ? { trustedDigest: trusted.digest, trustedBytes: trusted.bytes } : {}),
  }
}

function providerObjectWrite(stateDir: string, ledgerHash: string, ledger: ProviderFileLedger) {
  return contentWrite(resolve(stateDir, 'providers', 'objects', `${ledgerHash}.json`), 'provider-ledger', ledgerHash, ledger)
}

function verifyGeneration(generation: StateGeneration) {
  if (generation.schemaVersion !== LOCAL_STATE_SCHEMA_VERSION
    || generation.kind !== 'incremental-generation'
    || !isRecord(generation.providers)
    || !isRecord(generation.canonical)
    || !isRecord(generation.fileSet)
    || !isRecord(generation.compatibility)) {
    throw new Error('Invalid incremental state generation')
  }
  if (generation.reducerCheckpoints !== undefined && (!Array.isArray(generation.reducerCheckpoints)
    || generation.reducerCheckpoints.some((entry) => !isReducerCheckpointGenerationEntry(entry)))) {
    throw new Error('Invalid reducer checkpoint index in state generation')
  }
  if (generation.playerCheckpoints !== undefined && (!Array.isArray(generation.playerCheckpoints)
    || generation.playerCheckpoints.some((entry) => !isPlayerCheckpointGenerationEntry(entry)))) {
    throw new Error('Invalid player checkpoint index in state generation')
  }
  if (generation.artifactCache !== undefined && (!isRecord(generation.artifactCache)
    || typeof generation.artifactCache.cacheHash !== 'string'
    || typeof generation.artifactCache.nodeCount !== 'number')) {
    throw new Error('Invalid artifact cache index in state generation')
  }
  if (generation.snapshotModelCache !== undefined) {
    const cache = generation.snapshotModelCache
    const commonValid = isRecord(cache)
      && typeof cache.rankingResults === 'number'
      && typeof cache.playerResults === 'number'
    const v1Valid = commonValid && (cache.schemaVersion === undefined || cache.schemaVersion === 1)
      && typeof cache.cacheHash === 'string'
    const v2Valid = commonValid && cache.schemaVersion === 2
      && typeof cache.indexHash === 'string'
      && typeof cache.entryCount === 'number'
      && Array.isArray(cache.entryHashes)
      && cache.entryHashes.every((hash) => typeof hash === 'string')
    if (!v1Valid && !v2Valid) throw new Error('Invalid snapshot model cache index in state generation')
  }
  if (generation.fileSet.authorityHash !== stableHash(generation.fileSet.authorities)) throw new Error('Provider file-set authority receipt hash mismatch')
  const compatibilityIntegrity = compatibilityFallback(generation.compatibility, generation.compatibility)
  if (compatibilityIntegrity) throw new Error('Invalid compatibility envelope in state generation')
  const expectedProviderKeys = (['oracles-elixir', 'leaguepedia-cargo', 'lol-esports-api'] as const)
    .flatMap((provider) => generation.fileSet.paths[provider].map((path) => providerKey(provider, path)))
    .sort()
  const actualProviderKeys = Object.keys(generation.providers).sort()
  if (stableHash(actualProviderKeys) !== stableHash(expectedProviderKeys)) throw new Error('Provider generation does not match its file set')
}

function verifyProviderLedger(ledger: ProviderFileLedger) {
  if (ledger.observations.some((observation) => observation.payloadHash !== stableHash(observation.payload))) {
    throw new Error(`Provider observation semantic hash mismatch in ${ledger.fingerprint.fileId}`)
  }
}

function verifyCanonicalLedger(ledger: CanonicalLedger) {
  if (ledger.schemaVersion !== CANONICAL_LEDGER_SCHEMA_VERSION) throw new Error('Incompatible canonical ledger object')
  if (ledger.rootHash !== recomputeCanonicalRoot(ledger)) throw new Error('Canonical ledger semantic root mismatch')
}

function validateGenerationLinkage(
  generation: StateGeneration,
  providers: Map<string, LoadedProviderState>,
  canonicalLedger: CanonicalLedger,
) {
  const ledgers = [...providers.values()].toSorted((left, right) => providerIdentity(left.entry).localeCompare(providerIdentity(right.entry))).map(({ entry, ledger }) => {
    if (entry.provider !== ledger.fingerprint.provider
      || !sameProviderIdentity(entry.sourcePath, ledger.fingerprint.fileId)
      || entry.signature.byteLength !== ledger.fingerprint.byteLength) {
      throw new Error(`Provider ledger identity mismatch for ${entry.sourcePath}`)
    }
    return ledger
  })
  const providerRoot = stableHash(ledgers.map(providerCanonicalState))
  if (providerRoot !== generation.canonical.providerRoot) throw new Error('Canonical provider root mismatch')
  const observations = ledgers.flatMap((ledger) => ledger.observations)
  const importedTeams = mergeTeamProfiles(ledgers.map((ledger) => ledger.teams))
  const schedules = observations.flatMap((observation) => observation.kind === 'schedule' ? [observation.payload] : [])
  const contextDigests = canonicalContextDigests({ identities: knownTeamIdentities, profiles: importedTeams, eventWeightContext: transparentGprModelMetadata, schedules })
  const canonical = reconcileCanonicalObservations({ observations, importedTeams })
  const rebuilt = buildCanonicalLedger({ canonical, observations, contextDigests })
  if (stableHash(rebuilt) !== generation.canonical.ledgerHash || stableHash(rebuilt) !== stableHash(canonicalLedger)) {
    throw new Error('Canonical reconciliation linkage mismatch')
  }
}

function stateTreeSummary(generationHash: string, generation: StateGeneration, canonicalLedger: CanonicalLedger): IncrementalStateTreeSummary {
  const providerRoot = generation.canonical.providerRoot
  const canonicalRoot = canonicalLedger.rootHash
  const contextRoot = stableHash(canonicalLedger.contextDigests)
  const componentState = {
    reducerCheckpoints: generation.reducerCheckpoints ?? [],
    playerCheckpoints: generation.playerCheckpoints ?? [],
    snapshotModelCache: generation.snapshotModelCache,
  }
  const componentRoot = stableHash(componentState)
  const stateRoot = stableHash({ providerRoot, canonicalRoot, contextRoot, componentRoot })
  const reachablePaths = [
    'active-generation.json',
    `generations/${generationHash}.json`,
    ...Object.values(generation.providers).map((entry) => `providers/objects/${entry.ledgerHash}.json`),
    `canonical/objects/${generation.canonical.ledgerHash}.json`,
    ...(generation.reducerCheckpoints ?? []).flatMap((entry) => [
      `reducers/checkpoints/${entry.checkpointHash}.json`,
      `reducers/journals/histories/${entry.journalHashes.histories}.json`,
      `reducers/journals/predictions/${entry.journalHashes.predictions}.json`,
      `reducers/journals/league-history/${entry.journalHashes.leagueHistory}.json`,
    ]),
    ...(generation.playerCheckpoints ?? []).flatMap((entry) => [
      `players/checkpoints/${entry.checkpointHash}.json`,
      `players/journals/history/${entry.historyHash}.json`,
    ]),
    ...(generation.artifactCache ? [`artifacts/caches/${generation.artifactCache.cacheHash}.json`] : []),
    ...snapshotModelCacheReachablePaths(generation.snapshotModelCache),
  ]
  const retention = [...new Set([
    ...(generation.reducerCheckpoints ?? []).flatMap((entry) => entry.retention),
    ...(generation.playerCheckpoints ?? []).flatMap((entry) => entry.retention),
  ])].sort()
  const retentionBoundaries = [...new Map([
    ...(generation.reducerCheckpoints ?? []).map((entry) => [`${entry.processedDate ?? ''}:${entry.retention.join(',')}`, { ...(entry.processedDate ? { processedDate: entry.processedDate } : {}), classes: entry.retention }] as const),
    ...(generation.playerCheckpoints ?? []).map((entry) => [`${entry.processedDate ?? ''}:${entry.retention.join(',')}`, { ...(entry.processedDate ? { processedDate: entry.processedDate } : {}), classes: entry.retention }] as const),
  ]).values()].toSorted((left, right) => (left.processedDate ?? '').localeCompare(right.processedDate ?? ''))
  return {
    generationHash,
    compatibilityHash: generation.compatibility.hash,
    providerRoot,
    canonicalRoot,
    contextRoot,
    componentRoot,
    stateRoot,
    reachablePaths: [...new Set(reachablePaths)].sort(),
    retention,
    retentionBoundaries,
  }
}

function recomputeCanonicalRoot(ledger: CanonicalLedger) {
  return stableHash({
    matches: ledger.matches,
    importedMatches: ledger.importedMatches,
    teams: ledger.teams,
    partitions: ledger.partitions,
    contextDigests: ledger.contextDigests,
    observationToGroups: ledger.observationToGroups,
    groupToObservations: ledger.groupToObservations,
  })
}

function snapshotModelCacheReachablePaths(entry: SnapshotModelCacheGenerationEntry | undefined) {
  if (!entry) return []
  if (!('schemaVersion' in entry) || entry.schemaVersion === undefined || entry.schemaVersion === 1) {
    return [`snapshot-models/caches/${entry.cacheHash}.json`]
  }
  return [
    `snapshot-models/indexes/${entry.indexHash}.json`,
    ...entry.entryHashes.map((hash) => `snapshot-models/entries/${hash}.json`),
  ]
}

function fileSetFor({
  oracleSources,
  leaguepediaSources,
  lolEsportsSources,
  authorities,
}: {
  oracleSources: Array<{ sourceId: string }>
  leaguepediaSources: Array<{ sourceId: string }>
  lolEsportsSources: Array<{ sourceId: string }>
  authorities: ProviderAuthorities
}): GenerationFileSet {
  return {
    paths: {
      'oracles-elixir': oracleSources.map(({ sourceId }) => sourceId).sort(),
      'leaguepedia-cargo': leaguepediaSources.map(({ sourceId }) => sourceId).sort(),
      'lol-esports-api': lolEsportsSources.map(({ sourceId }) => sourceId).sort(),
    },
    authorities,
    authorityHash: stableHash(authorities),
  }
}

function removedFileFallback(previous: GenerationFileSet, current: GenerationFileSet): IncrementalFallbackReason | undefined {
  for (const provider of ['oracles-elixir', 'leaguepedia-cargo', 'lol-esports-api'] as const) {
    const currentNames = logicalFileNameCounts(current.paths[provider])
    const seen = new Map<string, number>()
    const removed = previous.paths[provider].filter((path) => {
      const name = logicalFileName(path)
      const occurrence = (seen.get(name) ?? 0) + 1
      seen.set(name, occurrence)
      return occurrence > (currentNames.get(name) ?? 0)
    })
    if (removed.length > 0 && !current.authorities[provider].fileSetAuthoritative) {
      return { kind: 'dependency-unknown', dependency: `ambiguous-provider-file-removal:${provider}:${removed.join(',')}` }
    }
  }
  return undefined
}

function parseActivePointer(value: unknown): ActiveGenerationPointer {
  if (!isRecord(value) || value.schemaVersion !== LOCAL_STATE_SCHEMA_VERSION || value.kind !== 'active-generation' || typeof value.generationHash !== 'string') {
    throw new Error('Invalid active generation pointer')
  }
  return value as ActiveGenerationPointer
}

function parseProviderEntry(value: unknown): ProviderGenerationEntry {
  if (!isRecord(value) || typeof value.sourcePath !== 'string' || typeof value.provider !== 'string' || !isRecord(value.signature) || typeof value.ledgerHash !== 'string' || !isRecord(value.authority)) {
    throw new Error('Invalid provider generation entry')
  }
  const entry = value as ProviderGenerationEntry
  if (!isProviderId(entry.provider)) throw new Error(`Invalid provider ID for ${entry.sourcePath}`)
  if (entry.authorityHash !== stableHash(entry.authority)) throw new Error(`Provider authority receipt hash mismatch for ${entry.sourcePath}`)
  if ((entry.trustedDigest !== undefined || entry.trustedBytes !== undefined)
    && (typeof entry.trustedDigest !== 'string' || !Number.isSafeInteger(entry.trustedBytes) || (entry.trustedBytes ?? 0) <= 0)) {
    throw new Error(`Invalid trusted provider chunk reference for ${entry.sourcePath}`)
  }
  return entry
}

function isProviderId(value: string): value is ProviderId {
  return value === 'oracles-elixir' || value === 'leaguepedia-cargo' || value === 'lol-esports-api'
}

async function readContentObject<T>(
  path: string,
  kind: ContentEnvelope['kind'],
  expectedHash: string,
  reducerStateIO?: ReducerStateIOMetrics,
  expectedBytes?: number,
): Promise<T> {
  const contents = await readFile(path, 'utf8')
  if (expectedBytes !== undefined && encodedByteLength(contents) !== expectedBytes) {
    throw new Error(`${kind} byte length mismatch`)
  }
  if (reducerStateIO && (kind === 'reducer-checkpoint'
    || kind === 'reducer-journal'
    || kind === 'player-checkpoint'
    || kind === 'player-history-journal'
    || kind === 'artifact-cache'
    || kind === 'snapshot-model-cache'
    || kind === 'snapshot-model-cache-index'
    || kind === 'snapshot-model-cache-entry')) {
    reducerStateIO.bytesRead += encodedByteLength(contents)
    reducerStateIO.objectsRead += 1
  }
  const value = decodePrivateState(contents)
  if (reducerStateIO) reducerStateIO.objectsDecoded += 1
  if (!isRecord(value) || value.schemaVersion !== LOCAL_STATE_SCHEMA_VERSION || value.kind !== kind || value.contentHash !== expectedHash) {
    throw new Error(`Invalid ${kind} envelope`)
  }
  const payloadHash = kind === 'reducer-checkpoint'
    || kind === 'reducer-journal'
    || kind === 'player-checkpoint'
    || kind === 'player-history-journal'
    || kind === 'artifact-cache'
    || kind === 'snapshot-model-cache'
    || kind === 'snapshot-model-cache-index'
    || kind === 'snapshot-model-cache-entry'
    ? privateStateHash(value.payload)
    : stableHash(value.payload)
  if (payloadHash !== expectedHash) throw new Error(`${kind} semantic hash mismatch`)
  return value.payload as T
}

function readContentObjectSync<T>(
  path: string,
  kind: ContentEnvelope['kind'],
  expectedHash: string,
  reducerStateIO: ReducerStateIOMetrics,
  expectedBytes?: number,
): T {
  const contents = readFileSync(path, 'utf8')
  const bytes = encodedByteLength(contents)
  if (expectedBytes !== undefined && bytes !== expectedBytes) throw new Error(`${kind} byte length mismatch`)
  reducerStateIO.bytesRead += bytes
  reducerStateIO.objectsRead += 1
  const value = decodePrivateState(contents)
  reducerStateIO.objectsDecoded += 1
  if (!isRecord(value) || value.schemaVersion !== LOCAL_STATE_SCHEMA_VERSION || value.kind !== kind || value.contentHash !== expectedHash) {
    throw new Error(`Invalid ${kind} envelope`)
  }
  if (privateStateHash(value.payload) !== expectedHash) throw new Error(`${kind} semantic hash mismatch`)
  return value.payload as T
}

function contentPayload<T>(contents: string, kind: ContentEnvelope['kind'], expectedHash: string): T {
  const value = decodePrivateState(contents)
  if (!isRecord(value) || value.schemaVersion !== LOCAL_STATE_SCHEMA_VERSION || value.kind !== kind || value.contentHash !== expectedHash) {
    throw new Error(`Invalid ${kind} envelope`)
  }
  if (stableHash(value.payload) !== expectedHash) throw new Error(`${kind} semantic hash mismatch`)
  return value.payload as T
}

function isReducerCheckpointGenerationEntry(value: unknown): value is ReducerCheckpointGenerationEntry {
  return isRecord(value)
    && (value.processedDate === undefined || typeof value.processedDate === 'string')
    && typeof value.checkpointHash === 'string'
    && isReducerJournalHashes(value.journalHashes)
    && Array.isArray(value.retention)
}

function isPlayerCheckpointGenerationEntry(value: unknown): value is PlayerCheckpointGenerationEntry {
  return isRecord(value)
    && (value.processedDate === undefined || typeof value.processedDate === 'string')
    && typeof value.checkpointHash === 'string'
    && typeof value.historyHash === 'string'
    && Array.isArray(value.retention)
}

function isReducerJournalHashes(value: unknown): value is ReducerJournalHashes {
  return isRecord(value)
    && typeof value.histories === 'string'
    && typeof value.predictions === 'string'
    && typeof value.leagueHistory === 'string'
}

async function readOptionalPrivateState(path: string): Promise<unknown | undefined> {
  try {
    return decodePrivateState(await readFile(path, 'utf8'))
  } catch (error) {
    if (isMissingFileError(error)) return undefined
    throw error
  }
}

function contentWrite(path: string, kind: ContentEnvelope['kind'], contentHash: string, payload: unknown): PendingIncrementalStateWrite {
  return privateWrite(path, { schemaVersion: LOCAL_STATE_SCHEMA_VERSION, kind, contentHash, payload } satisfies ContentEnvelope)
}

function privateWrite(path: string, value: unknown): PendingIncrementalStateWrite {
  return { path, contents: encodePrivateState(value) }
}

function uniqueWrites(writes: PendingIncrementalStateWrite[]) {
  return [...new Map(writes.map((write) => [write.path, write])).values()]
}

async function atomicWrite({ path, contents }: PendingIncrementalStateWrite) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, contents)
  await rename(temporary, path)
}

async function signatureFor(path: string): Promise<FileSignature> {
  const value = await stat(path, { bigint: true })
  return {
    device: value.dev.toString(),
    inode: value.ino.toString(),
    byteLength: Number(value.size),
    modifiedNs: value.mtimeNs.toString(),
    changedNs: value.ctimeNs.toString(),
  }
}

function aggregateMetrics(results: ProviderPathResult[]): IncrementalLoadMetrics {
  return results.reduce((total, result) => ({
    filesScanned: total.filesScanned + (result.contentRead ? 1 : 0),
    bytesScanned: total.bytesScanned + result.metrics.bytesScanned,
    rowsParsed: total.rowsParsed + result.metrics.rowsParsed,
    observationsNormalized: total.observationsNormalized + result.metrics.observationsNormalized,
    observationsReused: total.observationsReused + result.metrics.observationsReused,
    reducerStateBytesRead: total.reducerStateBytesRead,
    reducerStateBytesWritten: total.reducerStateBytesWritten,
  }), emptyMetrics())
}

function emptyMetrics(): IncrementalLoadMetrics {
  return {
    filesScanned: 0,
    bytesScanned: 0,
    rowsParsed: 0,
    observationsNormalized: 0,
    observationsReused: 0,
    reducerStateBytesRead: 0,
    reducerStateBytesWritten: 0,
  }
}

function encodedByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength
}

function checkpointCorrupt(error: unknown): IncrementalFallbackReason {
  return { kind: 'checkpoint-corrupt', detail: error instanceof Error ? error.message : 'Unknown incremental state failure' }
}

function providerKey(provider: ProviderId, path: string) {
  return stableHash({ provider, path })
}

function providerIdentity(entry: Pick<ProviderGenerationEntry, 'provider' | 'sourcePath'>) {
  return `${entry.provider}\u0000${entry.sourcePath}`
}

function providerSources(
  provider: ProviderId,
  paths: string[],
  explicitSourceIds?: string[],
  trustedSources?: Record<string, { digest: string; bytes: number }>,
) {
  if (explicitSourceIds && explicitSourceIds.length !== paths.length) {
    throw new Error(`${provider} source ID count must match its source path count`)
  }
  const sourceIds = explicitSourceIds?.map(normalizeSourceId) ?? paths.map((path) => normalizeSourceId(basename(path)))
  const duplicate = sourceIds.find((sourceId, index) => sourceIds.indexOf(sourceId) !== index)
  if (duplicate) {
    throw new Error(`${provider} has duplicate logical source ID ${duplicate}; provide explicit manifest-relative source IDs`)
  }
  return paths.map((path, index) => {
    const sourceId = sourceIds[index]!
    return { path, sourceId, trusted: trustedSources?.[sourceId] }
  })
}

function previousProviderState(active: LoadedGeneration, provider: ProviderId, sourceId: string, runtimePath: string) {
  const direct = active.providers.get(providerKey(provider, sourceId))
    ?? active.providers.get(providerKey(provider, runtimePath))
  if (direct) return direct
  const matches = [...active.providers.values()].filter(({ entry }) => (
    entry.provider === provider && logicalFileName(entry.sourcePath) === logicalFileName(sourceId)
  ))
  return matches.length === 1 ? matches[0] : undefined
}

function logicalFileName(value: string) {
  return basename(value).replace(/#\d+$/, '')
}

function normalizeSourceId(value: string) {
  const normalized = value.normalize('NFKC').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/').trim()
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`Invalid logical provider source ID: ${value}`)
  }
  return normalized
}

function sameProviderIdentity(entrySourceId: string, ledgerFileId: string) {
  return entrySourceId === ledgerFileId
    || logicalFileName(entrySourceId) === logicalFileName(ledgerFileId)
}

function logicalFileNameCounts(values: string[]) {
  const counts = new Map<string, number>()
  for (const value of values) {
    const name = logicalFileName(value)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return counts
}

function oracleImportFor(ledger: ProviderFileLedger): OracleImportResult {
  return { matches: ledger.observations.flatMap((observation) => observation.kind === 'match' ? [observation.payload] : []), teams: ledger.teams, source: ledger.source as OracleImportResult['source'] }
}

function leaguepediaImportFor(ledger: ProviderFileLedger): LeaguepediaImportResult {
  return { matches: ledger.observations.flatMap((observation) => observation.kind === 'match' ? [observation.payload] : []), teams: ledger.teams, source: ledger.source as LeaguepediaImportResult['source'] }
}

function lolEsportsImportFor(ledger: ProviderFileLedger): LolEsportsReferenceImportResult {
  return { events: ledger.observations.flatMap((observation) => observation.kind === 'schedule' ? [observation.payload] : []), source: ledger.source as LolEsportsReferenceImportResult['source'] }
}

function equalSignature(left: FileSignature, right: FileSignature) {
  return left.device === right.device
    && left.inode === right.inode
    && left.byteLength === right.byteLength
    && left.modifiedNs === right.modifiedNs
    && left.changedNs === right.changedNs
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
