import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { canonicalCodeProvenanceHash } from '../scripts/canonical-code-provenance.ts'
import {
  attachIncrementalArtifactCache,
  attachIncrementalPlayerCheckpoints,
  attachIncrementalReducerCheckpoint,
  attachIncrementalSnapshotModelCache,
  loadIncrementalCommunityImports,
  promoteIncrementalState,
  stageIncrementalState,
  type ProviderAuthorities,
} from '../scripts/incremental-provider-state.ts'
import { importOraclesElixirCsv } from '../src/lib/importers/oraclesElixir.ts'
import { decodePrivateState, encodePrivateState } from '../src/lib/incremental/canonicalCodec.ts'
import { createCrunchCompatibility } from '../src/lib/incremental/compatibility.ts'
import { sha256Hex, stableHash } from '../src/lib/incremental/hash.ts'
import { orchestrateCrunch } from '../src/lib/incremental/orchestrator.ts'
import { assertCrunchParity } from '../src/lib/incremental/parity.ts'
import {
  buildReducerDependencyPlan,
  canonicalPrefixHash,
  privateStateHash,
  type IncrementalReducerCheckpoint,
} from '../src/lib/incremental/reducerCheckpoint.ts'
import { runIncrementalPlayerReducer } from '../src/lib/incremental/playerReducer.ts'
import type { PersistedArtifactNode } from '../src/lib/incremental/artifactDag.ts'
import {
  finalizeTeamReducer,
  initializeTeamReducer,
  processTeamDateBatch,
  snapshotTeamReducer,
} from '../src/lib/model.ts'
import {
  finalizeLivePlayerEdgeReducer,
  initializeLivePlayerEdgeReducer,
  processLivePlayerEdgeDateBatch,
  snapshotLivePlayerEdgeReducer,
} from '../src/lib/playerModel.ts'
import { matchesByDate } from '../src/lib/matchContext.ts'
import type { CanonicalRankingInput } from '../src/lib/incremental/canonicalState.ts'
import {
  createIncrementalSnapshotModelProvider,
  type PersistedSnapshotModelState,
} from '../src/lib/incremental/snapshotInputs.ts'
import { createStaticRankingData } from '../src/lib/snapshot.ts'
import { createPublicArtifactWritePlan } from '../src/lib/publicArtifacts/writePlan.ts'

const retrievedAt = '2026-07-18T00:00:00.000Z'
const authorities: ProviderAuthorities = {
  'oracles-elixir': { receiptId: 'oracle:test', fileSetAuthoritative: false, contentReplacementAuthoritative: false },
  'leaguepedia-cargo': { receiptId: 'leaguepedia:test', fileSetAuthoritative: false, contentReplacementAuthoritative: false },
  'lol-esports-api': { receiptId: 'lol-esports:test', fileSetAuthoritative: false, contentReplacementAuthoritative: false },
}
const compatibility = createCrunchCompatibility({ pipeline: 'test-v1', model: 'test-v1', codeProvenanceHash: 'code-v1' })
const header = 'gameid,date,year,league,split,playoffs,patch,position,side,teamname,result,kills,totalgold'
const firstGame = [
  'g1,2026-01-10,2026,LCK,Spring,0,26.1,team,Blue,Gen.G,1,18,65000',
  'g1,2026-01-10,2026,LCK,Spring,0,26.1,team,Red,T1,0,12,59000',
]
const secondGame = [
  'g2,2026-01-17,2026,LCK,Spring,0,26.1,team,Blue,T1,1,19,66000',
  'g2,2026-01-17,2026,LCK,Spring,0,26.1,team,Red,Gen.G,0,10,58000',
]

test('production generation reads unchanged source files zero times after atomic promotion', async () => {
  const fixture = await createFixture([header, ...firstGame].join('\n'))
  const first = await loadIncrementalCommunityImports(fixture.input)
  assert.ok(first.promotion)
  await promoteIncrementalState(first.promotion)
  const second = await loadIncrementalCommunityImports(fixture.input)
  assert.equal(first.fallback?.kind, 'checkpoint-unavailable')
  assert.equal(first.metrics.filesScanned, 1)
  assert.equal(second.metrics.filesScanned, 0)
  assert.equal(second.metrics.bytesScanned, 0)
  assert.equal(second.metrics.rowsParsed, 0)
  assert.deepEqual(second.imports?.oracleImports, first.imports?.oracleImports)
  assert.deepEqual(second.imports?.canonical, first.imports?.canonical)
  assert.deepEqual(first.imports?.oracleImports, [importOraclesElixirCsv(fixture.contents, { sourceFileName: '2026.csv', retrievedAt })])
  const active = await activeGeneration(fixture.stateDir)
  assert.equal(Object.keys(record(active.generation.providers)).length, 1)
  assert.ok(await readFile(resolve(fixture.stateDir, 'canonical', 'objects', `${stringField(record(active.generation.canonical), 'ledgerHash')}.json`), 'utf8'))
})

test('production generation restores scoped snapshot results across fresh providers and append', async () => {
  const completed2025Game = firstGame.map((row) => row.replace('2026-01-10,2026', '2025-01-10,2025'))
  const fixture = await createFixture([header, ...completed2025Game].join('\n'))
  const first = await loadIncrementalCommunityImports(fixture.input)
  assert.ok(first.promotion)
  assert.ok(first.imports)
  const firstRun = { generatedAt: '2026-07-18T00:00:00.000Z', runId: 'provider-cache-first' }
  const firstProvider = createIncrementalSnapshotModelProvider({ compatibilityHash: compatibility.hash })
  const firstCandidate = createStaticRankingData(snapshotInputForCanonical(first.imports.canonical, firstRun, firstProvider))
  assertSnapshotParity(first.imports.canonical, firstRun, firstCandidate)
  const firstPersisted = firstProvider.persistedState()
  await promoteIncrementalState(attachIncrementalSnapshotModelCache(
    first.promotion,
    fixture.stateDir,
    firstPersisted,
  ))

  const warm = await loadIncrementalCommunityImports(fixture.input)
  assert.ok(warm.imports)
  assert.ok(warm.snapshotModelCache, JSON.stringify(warm.fallback))
  const metadataRun = { generatedAt: '2026-07-18T01:00:00.000Z', runId: 'provider-cache-metadata' }
  const warmProvider = createIncrementalSnapshotModelProvider({
    compatibilityHash: compatibility.hash,
    previous: warm.snapshotModelCache,
  })
  const warmCandidate = createStaticRankingData(snapshotInputForCanonical(warm.imports.canonical, metadataRun, warmProvider))
  assertSnapshotParity(warm.imports.canonical, metadataRun, warmCandidate)
  const warmMetrics = warmProvider.metrics()
  assert.equal(warmMetrics.rankingReducerRuns, 0)
  assert.equal(warmMetrics.playerReducerRuns, 0)
  assert.equal(warmMetrics.rankingRows, 0)
  assert.equal(warmMetrics.playerRows, 0)
  assert.equal(warmMetrics.rankingRequests, warmMetrics.rankingResultCacheHits)
  assert.equal(warmMetrics.playerRequests, warmMetrics.playerResultCacheHits)

  await writeFile(fixture.sourcePath, [header, ...completed2025Game, ...secondGame].join('\n'))
  const appended = await loadIncrementalCommunityImports(fixture.input)
  assert.ok(appended.imports)
  assert.ok(appended.snapshotModelCache)
  const appendRun = { generatedAt: '2026-07-19T00:00:00.000Z', runId: 'provider-cache-append' }
  const appendProvider = createIncrementalSnapshotModelProvider({
    compatibilityHash: compatibility.hash,
    previous: appended.snapshotModelCache,
  })
  const appendCandidate = createStaticRankingData(snapshotInputForCanonical(appended.imports.canonical, appendRun, appendProvider))
  assertSnapshotParity(appended.imports.canonical, appendRun, appendCandidate)
  const appendMetrics = appendProvider.metrics()
  assert.ok(appendMetrics.rankingResultCacheHits + appendMetrics.playerResultCacheHits > 0)
  assert.ok(appendMetrics.rankingReducerRuns + appendMetrics.playerReducerRuns > 0)
  assert.equal(appendMetrics.rankingRequests, appendMetrics.rankingReducerRuns + appendMetrics.rankingResultCacheHits)
  assert.equal(appendMetrics.playerRequests, appendMetrics.playerReducerRuns + appendMetrics.playerResultCacheHits)
  const bounded = appendProvider.persistedState()
  assert.ok(bounded.rankingResults.size <= appendMetrics.rankingRequests)
  assert.ok(bounded.playerResults.size <= appendMetrics.playerRequests)
  assert.ok([...firstPersisted.rankingResults.keys()].some((key) => bounded.rankingResults.has(key)))
})

test('retrieval metadata changes preserve the canonical semantic root and skip reconciliation', async () => {
  const fixture = await createFixture([header, ...firstGame].join('\n'))
  const first = await loadIncrementalCommunityImports(fixture.input)
  assert.ok(first.promotion)
  await promoteIncrementalState(first.promotion)
  const before = await activeGeneration(fixture.stateDir)
  const beforeCanonical = record(before.generation.canonical)

  const metadataOnly = await loadIncrementalCommunityImports({
    ...fixture.input,
    oracleRetrievedAt: '2026-07-19T00:00:00.000Z',
    now: '2026-07-19T00:00:00.000Z',
  })
  assert.equal(metadataOnly.fallback, undefined)
  assert.equal(metadataOnly.metrics.filesScanned, 0)
  assert.equal(metadataOnly.metrics.bytesScanned, 0)
  assert.equal(metadataOnly.metrics.rowsParsed, 0)
  assert.equal(metadataOnly.metrics.observationsNormalized, 0)
  assert.equal(metadataOnly.imports?.oracleImports[0]?.source.retrievedAt, '2026-07-19T00:00:00.000Z')
  assert.ok(metadataOnly.promotion)
  assert.equal(metadataOnly.promotion.stagedWrites.some((write) => write.path.includes('/canonical/objects/')), false)
  await promoteIncrementalState(metadataOnly.promotion)

  const after = await activeGeneration(fixture.stateDir)
  const afterCanonical = record(after.generation.canonical)
  assert.equal(stringField(afterCanonical, 'providerRoot'), stringField(beforeCanonical, 'providerRoot'))
  assert.equal(stringField(afterCanonical, 'ledgerHash'), stringField(beforeCanonical, 'ledgerHash'))
})

test('corrupt active pointer cold-rebuilds with typed fallback and staged replacement', async () => {
  const fixture = await createFixture([header, ...firstGame].join('\n'))
  const first = await loadIncrementalCommunityImports(fixture.input)
  assert.ok(first.promotion)
  await promoteIncrementalState(first.promotion)
  await writeFile(activePointerPath(fixture.stateDir), '{not-json')
  const result = await loadIncrementalCommunityImports(fixture.input)
  assert.equal(result.fallback?.kind, 'checkpoint-corrupt')
  assert.equal(result.metrics.filesScanned, 1)
  assert.ok(result.promotion)
})

test('parseable provider object mutation cannot bypass semantic observation hashes', async () => {
  const fixture = await createFixture([header, ...firstGame].join('\n'))
  const first = await loadIncrementalCommunityImports(fixture.input)
  assert.ok(first.promotion)
  await promoteIncrementalState(first.promotion)
  const active = await activeGeneration(fixture.stateDir)
  const providers = record(active.generation.providers)
  const [providerKey] = Object.keys(providers)
  assert.ok(providerKey)
  const providerEntry = record(providers[providerKey])
  const ledgerHash = stringField(providerEntry, 'ledgerHash')
  const envelope = record(decodePrivateState(await readFile(resolve(fixture.stateDir, 'providers', 'objects', `${ledgerHash}.json`), 'utf8')))
  const ledger = record(envelope.payload)
  const observations = arrayField(ledger, 'observations')
  const firstObservation = record(observations[0])
  const payload = record(firstObservation.payload)
  const mutatedLedger = { ...ledger, observations: [{ ...firstObservation, payload: { ...payload, teamAKills: 999 } }, ...observations.slice(1)] }
  const mutatedHash = stableHash(mutatedLedger)
  await writePrivate(resolve(fixture.stateDir, 'providers', 'objects', `${mutatedHash}.json`), { ...envelope, contentHash: mutatedHash, payload: mutatedLedger })
  await installGeneration(fixture.stateDir, { ...active.generation, providers: { ...providers, [providerKey]: { ...providerEntry, ledgerHash: mutatedHash } } })

  const result = await loadIncrementalCommunityImports(fixture.input)
  assert.equal(result.fallback?.kind, 'checkpoint-corrupt')
  assert.match(result.fallback?.kind === 'checkpoint-corrupt' ? result.fallback.detail : '', /semantic hash mismatch/)
  assert.ok(result.promotion)
})

test('parseable canonical object mutation cannot bypass its semantic root', async () => {
  const fixture = await createFixture([header, ...firstGame].join('\n'))
  const first = await loadIncrementalCommunityImports(fixture.input)
  assert.ok(first.promotion)
  await promoteIncrementalState(first.promotion)
  const active = await activeGeneration(fixture.stateDir)
  const canonicalEntry = record(active.generation.canonical)
  const ledgerHash = stringField(canonicalEntry, 'ledgerHash')
  const envelope = record(decodePrivateState(await readFile(resolve(fixture.stateDir, 'canonical', 'objects', `${ledgerHash}.json`), 'utf8')))
  const ledger = record(envelope.payload)
  const mutatedLedger = { ...ledger, importedMatches: [] }
  const mutatedHash = stableHash(mutatedLedger)
  await writePrivate(resolve(fixture.stateDir, 'canonical', 'objects', `${mutatedHash}.json`), { ...envelope, contentHash: mutatedHash, payload: mutatedLedger })
  await installGeneration(fixture.stateDir, { ...active.generation, canonical: { ...canonicalEntry, ledgerHash: mutatedHash } })

  const result = await loadIncrementalCommunityImports(fixture.input)
  assert.equal(result.fallback?.kind, 'checkpoint-corrupt')
  assert.match(result.fallback?.kind === 'checkpoint-corrupt' ? result.fallback.detail : '', /semantic root mismatch/)
})

test('ambiguous deletion fallback preserves exact metrics from every provider attempt', async () => {
  const fixture = await createFixture([header, ...firstGame, ...secondGame].join('\n'))
  const secondPath = resolve(fixture.root, 'other.csv')
  await writeFile(secondPath, [header, ...secondGame].join('\n'))
  const input = { ...fixture.input, oracleCsvPaths: [fixture.sourcePath, secondPath] }
  const first = await loadIncrementalCommunityImports(input)
  assert.ok(first.promotion)
  await promoteIncrementalState(first.promotion)

  await writeFile(fixture.sourcePath, [header, ...secondGame].join('\n'))
  await writeFile(secondPath, [header, ...secondGame, ...firstGame].join('\n'))
  const result = await loadIncrementalCommunityImports(input)
  assert.equal(result.fallback?.kind, 'dependency-unknown')
  assert.match(result.fallback?.kind === 'dependency-unknown' ? result.fallback.dependency : '', /ambiguous-provider-deletion/)
  assert.equal(result.metrics.filesScanned, 2)
  assert.ok(result.metrics.bytesScanned > 0)
  assert.ok(result.metrics.rowsParsed > 0)
})

test('ambiguous removed files still return metrics for retained provider work', async () => {
  const fixture = await createFixture([header, ...firstGame].join('\n'))
  const removedPath = resolve(fixture.root, 'removed.csv')
  await writeFile(removedPath, [header, ...secondGame].join('\n'))
  const initialInput = { ...fixture.input, oracleCsvPaths: [fixture.sourcePath, removedPath] }
  const first = await loadIncrementalCommunityImports(initialInput)
  assert.ok(first.promotion)
  await promoteIncrementalState(first.promotion)
  await writeFile(fixture.sourcePath, [header, ...firstGame, ...secondGame].join('\n'))
  const result = await loadIncrementalCommunityImports(fixture.input)
  assert.equal(result.fallback?.kind, 'dependency-unknown')
  assert.match(result.fallback?.kind === 'dependency-unknown' ? result.fallback.dependency : '', /ambiguous-provider-file-removal/)
  assert.equal(result.metrics.filesScanned, 1)
  assert.ok(result.metrics.rowsParsed > 0)
})

test('compatibility mismatch cold-refreshes, promotes after fallback, then reuses', async () => {
  const fixture = await createFixture([header, ...firstGame].join('\n'))
  const first = await loadIncrementalCommunityImports(fixture.input)
  assert.ok(first.promotion)
  await promoteIncrementalState(first.promotion)
  const pointerBefore = await readFile(activePointerPath(fixture.stateDir), 'utf8')
  const nextCompatibility = createCrunchCompatibility({ pipeline: 'test-v1', model: 'test-v1', codeProvenanceHash: 'code-v2' })
  const mismatchInput = { ...fixture.input, compatibility: nextCompatibility }
  const mismatch = await loadIncrementalCommunityImports(mismatchInput)
  assert.equal(mismatch.fallback?.kind, 'compatibility-hash-mismatch')
  assert.equal(mismatch.metrics.filesScanned, 1)
  assert.ok(mismatch.promotion)
  assert.ok(mismatch.imports)
  assert.ok(first.imports)
  assert.equal(await readFile(activePointerPath(fixture.stateDir), 'utf8'), pointerBefore)

  const orchestration = await orchestrateCrunch({
    mode: 'incremental',
    runFull: () => first.imports,
    runIncremental: () => ({ output: mismatch.imports, fallback: mismatch.fallback! }),
  })
  assert.equal(orchestration.executedMode, 'full')
  assert.ok(orchestration.shadowOutput)
  assertCrunchParity(
    { fullSnapshot: canonicalPayload(orchestration.output), publicWrites: [] },
    { fullSnapshot: canonicalPayload(orchestration.shadowOutput), publicWrites: [] },
  )
  await promoteIncrementalState(mismatch.promotion)
  const next = await loadIncrementalCommunityImports(mismatchInput)
  assert.equal(next.fallback, undefined)
  assert.equal(next.metrics.filesScanned, 0)
})

test('concrete code provenance mutation invalidates restore without changing labels', async () => {
  const fixture = await createFixture([header, ...firstGame].join('\n'))
  const codeRoot = resolve(fixture.root, 'code')
  await mkdir(resolve(codeRoot, 'src', 'nested'), { recursive: true })
  await mkdir(resolve(codeRoot, 'scripts'), { recursive: true })
  await writeFile(resolve(codeRoot, 'src', 'nested', 'canonical.ts'), 'export const value = 1\n')
  await writeFile(resolve(codeRoot, 'scripts', 'build-static-snapshot.ts'), 'export const build = 1\n')
  await writeFile(resolve(codeRoot, 'scripts', 'canonical-code-provenance.ts'), 'export const provenance = 1\n')
  await writeFile(resolve(codeRoot, 'scripts', 'incremental-provider-state.ts'), 'export const state = 1\n')
  const firstDigest = await canonicalCodeProvenanceHash({ repositoryRoot: codeRoot })
  const firstInput = { ...fixture.input, compatibility: createCrunchCompatibility({ pipeline: 'same-label', codeProvenanceHash: firstDigest }) }
  const first = await loadIncrementalCommunityImports(firstInput)
  assert.ok(first.promotion)
  await promoteIncrementalState(first.promotion)

  await writeFile(resolve(codeRoot, 'src', 'nested', 'canonical.ts'), 'export const value = 2\n')
  const secondDigest = await canonicalCodeProvenanceHash({ repositoryRoot: codeRoot })
  assert.notEqual(secondDigest, firstDigest)
  const changed = await loadIncrementalCommunityImports({
    ...firstInput,
    compatibility: createCrunchCompatibility({ pipeline: 'same-label', codeProvenanceHash: secondDigest }),
  })
  assert.equal(changed.fallback?.kind, 'compatibility-hash-mismatch')
  assert.equal(changed.fallback?.kind === 'compatibility-hash-mismatch' ? changed.fallback.dependency : '', 'codeProvenanceHash')
  assert.ok(changed.promotion)
})

test('interrupted and orphan staging leave the prior generation authoritative', async () => {
  const fixture = await createFixture([header, ...firstGame].join('\n'))
  const first = await loadIncrementalCommunityImports(fixture.input)
  assert.ok(first.promotion)
  await promoteIncrementalState(first.promotion)
  const pointerBefore = await readFile(activePointerPath(fixture.stateDir), 'utf8')
  await writeFile(fixture.sourcePath, [header, ...firstGame, ...secondGame].join('\n'))
  const candidate = await loadIncrementalCommunityImports(fixture.input)
  assert.ok(candidate.promotion)

  const [firstWrite] = candidate.promotion.stagedWrites
  assert.ok(firstWrite)
  await mkdir(dirname(firstWrite.path), { recursive: true })
  await writeFile(firstWrite.path, firstWrite.contents)
  assert.equal(await readFile(activePointerPath(fixture.stateDir), 'utf8'), pointerBefore)
  assert.equal((await loadIncrementalCommunityImports(fixture.input)).metrics.filesScanned, 1)

  await stageIncrementalState(candidate.promotion)
  assert.equal(await readFile(activePointerPath(fixture.stateDir), 'utf8'), pointerBefore)
  assert.equal((await loadIncrementalCommunityImports(fixture.input)).metrics.filesScanned, 1)
})

test('orphan staging without a root pointer is treated as cold state', async () => {
  const fixture = await createFixture([header, ...firstGame].join('\n'))
  const candidate = await loadIncrementalCommunityImports(fixture.input)
  assert.ok(candidate.promotion)
  await stageIncrementalState(candidate.promotion)
  const cold = await loadIncrementalCommunityImports(fixture.input)
  assert.equal(cold.fallback?.kind, 'checkpoint-unavailable')
  assert.equal(cold.metrics.filesScanned, 1)
})

test('reducer checkpoint is promoted and restored with the canonical generation', async () => {
  const fixture = await createFixture([header, ...firstGame].join('\n'))
  const first = await loadIncrementalCommunityImports(fixture.input)
  assert.ok(first.promotion)
  assert.ok(first.imports)
  const checkpoint = reducerCheckpointFor(first.imports.canonical)
  const promotion = attachIncrementalReducerCheckpoint(first.promotion, fixture.stateDir, checkpoint)
  const promoted = await promoteIncrementalState(promotion)
  assert.equal(promoted.reducerStateBytesWritten, promotion.reducerStateBytesWritten)
  assert.ok(promoted.reducerStateBytesWritten > 0)

  const restored = await loadIncrementalCommunityImports(fixture.input)
  assert.equal(restored.fallback, undefined)
  assert.deepEqual(restored.reducerCheckpoint, checkpoint)
  assert.equal(restored.metrics.filesScanned, 0)
  const active = await activeGeneration(fixture.stateDir)
  const [checkpointEntry] = arrayField(active.generation, 'reducerCheckpoints').map(record)
  assert.ok(checkpointEntry)
  const checkpointHash = stringField(checkpointEntry, 'checkpointHash')
  const journalHashes = record(checkpointEntry.journalHashes)
  const coreEnvelope = record(decodePrivateState(await readFile(resolve(fixture.stateDir, 'reducers', 'checkpoints', `${checkpointHash}.json`), 'utf8')))
  const core = record(coreEnvelope.payload)
  assert.equal('journals' in record(core.team), false)
  assert.deepEqual(record(core.teamJournalHashes), journalHashes)
  const historiesEnvelope = record(decodePrivateState(await readFile(resolve(fixture.stateDir, 'reducers', 'journals', 'histories', `${stringField(journalHashes, 'histories')}.json`), 'utf8')))
  const predictionsEnvelope = record(decodePrivateState(await readFile(resolve(fixture.stateDir, 'reducers', 'journals', 'predictions', `${stringField(journalHashes, 'predictions')}.json`), 'utf8')))
  const leagueHistoryEnvelope = record(decodePrivateState(await readFile(resolve(fixture.stateDir, 'reducers', 'journals', 'league-history', `${stringField(journalHashes, 'leagueHistory')}.json`), 'utf8')))
  assert.deepEqual(historiesEnvelope.payload, checkpoint.team.journals.histories)
  assert.deepEqual(predictionsEnvelope.payload, checkpoint.team.journals.predictions)
  assert.deepEqual(leagueHistoryEnvelope.payload, checkpoint.team.journals.leagueHistory)
  const reducerPaths = [
    resolve(fixture.stateDir, 'reducers', 'checkpoints', `${checkpointHash}.json`),
    resolve(fixture.stateDir, 'reducers', 'journals', 'histories', `${stringField(journalHashes, 'histories')}.json`),
    resolve(fixture.stateDir, 'reducers', 'journals', 'predictions', `${stringField(journalHashes, 'predictions')}.json`),
    resolve(fixture.stateDir, 'reducers', 'journals', 'league-history', `${stringField(journalHashes, 'leagueHistory')}.json`),
  ]
  const expectedStateBytes = (await Promise.all(reducerPaths.map((path) => readFile(path)))).reduce((total, contents) => total + contents.byteLength, 0)
  assert.equal(restored.metrics.reducerStateBytesRead, expectedStateBytes)
  assert.equal(promoted.reducerStateBytesWritten, expectedStateBytes)
})

test('player checkpoint and immutable history journal share atomic generation promotion', async () => {
  const fixture = await createFixture([header, ...firstGame].join('\n'))
  const first = await loadIncrementalCommunityImports(fixture.input)
  assert.ok(first.promotion)
  assert.ok(first.imports)
  const teamCheckpoint = reducerCheckpointFor(first.imports.canonical)
  const playerRun = runIncrementalPlayerReducer({
    matches: first.imports.canonical.matches,
    rosters: {},
    teams: first.imports.canonical.teams,
    leagueStrengths: [],
  })
  const teamPromotion = attachIncrementalReducerCheckpoint(first.promotion, fixture.stateDir, teamCheckpoint)
  const promotion = attachIncrementalPlayerCheckpoints(teamPromotion, fixture.stateDir, playerRun.checkpoints)
  const promoted = await promoteIncrementalState(promotion)

  const restored = await loadIncrementalCommunityImports(fixture.input)
  assert.deepEqual(restored.playerCheckpoints, playerRun.checkpoints)
  const active = await activeGeneration(fixture.stateDir)
  assert.equal(arrayField(active.generation, 'reducerCheckpoints').length, 1)
  const [playerEntry] = arrayField(active.generation, 'playerCheckpoints').map(record)
  assert.ok(playerEntry)
  const checkpointHash = stringField(playerEntry, 'checkpointHash')
  const historyHash = stringField(playerEntry, 'historyHash')
  const corePath = resolve(fixture.stateDir, 'players', 'checkpoints', `${checkpointHash}.json`)
  const historyPath = resolve(fixture.stateDir, 'players', 'journals', 'history', `${historyHash}.json`)
  const coreEnvelope = record(decodePrivateState(await readFile(corePath, 'utf8')))
  const core = record(coreEnvelope.payload)
  assert.equal('history' in record(core.player), false)
  assert.equal(core.historyHash, historyHash)
  const historyEnvelope = record(decodePrivateState(await readFile(historyPath, 'utf8')))
  assert.deepEqual(historyEnvelope.payload, playerRun.checkpoints[0]?.player.history)
  assert.ok(promoted.reducerStateBytesWritten > 0)
  assert.equal(restored.metrics.reducerStateBytesRead, promoted.reducerStateBytesWritten)
})

test('player checkpoint and history journal reject independent parseable tampering', async () => {
  for (const target of ['checkpoint', 'history'] as const) {
    const fixture = await createFixture([header, ...firstGame].join('\n'))
    const first = await loadIncrementalCommunityImports(fixture.input)
    assert.ok(first.promotion)
    assert.ok(first.imports)
    const playerRun = runIncrementalPlayerReducer({
      matches: first.imports.canonical.matches,
      rosters: {},
      teams: first.imports.canonical.teams,
      leagueStrengths: [],
    })
    await promoteIncrementalState(attachIncrementalPlayerCheckpoints(
      first.promotion,
      fixture.stateDir,
      playerRun.checkpoints,
    ))
    const active = await activeGeneration(fixture.stateDir)
    const [entry] = arrayField(active.generation, 'playerCheckpoints').map(record)
    assert.ok(entry)
    const path = target === 'checkpoint'
      ? resolve(fixture.stateDir, 'players', 'checkpoints', `${stringField(entry, 'checkpointHash')}.json`)
      : resolve(fixture.stateDir, 'players', 'journals', 'history', `${stringField(entry, 'historyHash')}.json`)
    const envelope = record(decodePrivateState(await readFile(path, 'utf8')))
    if (target === 'checkpoint') {
      const player = record(record(envelope.payload).player)
      const state = record(player.state)
      assert.ok(state.ratings instanceof Map)
      state.ratings.set('tampered-player', 999)
    } else {
      assert.ok(envelope.payload instanceof Map)
      envelope.payload.set('tampered-player', [])
    }
    await writePrivate(path, envelope)
    const result = await loadIncrementalCommunityImports(fixture.input)
    assert.equal(result.fallback?.kind, 'checkpoint-corrupt')
    assert.match(
      result.fallback?.kind === 'checkpoint-corrupt' ? result.fallback.detail : '',
      new RegExp(`${target === 'checkpoint' ? 'player-checkpoint' : 'player-history-journal'} semantic hash mismatch`),
    )
  }
})

test('artifact DAG cache shares atomic generation promotion and rejects tampering', async () => {
  const fixture = await createFixture([header, ...firstGame].join('\n'))
  const first = await loadIncrementalCommunityImports(fixture.input)
  assert.ok(first.promotion)
  const cache: PersistedArtifactNode[] = [
    {
      id: 'public:scopes/default.json',
      kind: 'scope',
      semanticHash: 'semantic-scope',
      envelopeHash: 'envelope-scope',
      semanticClosureHash: closureHash('semantic-scope', []),
      envelopeClosureHash: closureHash('envelope-scope', []),
      deps: [],
    },
    {
      id: 'public:ranking-summary.json',
      kind: 'manifest',
      semanticHash: 'semantic-manifest',
      envelopeHash: 'envelope-manifest',
      semanticClosureHash: closureHash('semantic-manifest', [['public:scopes/default.json', closureHash('semantic-scope', [])]]),
      envelopeClosureHash: closureHash('envelope-manifest', [['public:scopes/default.json', closureHash('envelope-scope', [])]]),
      deps: ['public:scopes/default.json'],
    },
  ]
  const snapshotModelCache: PersistedSnapshotModelState = {
    schemaVersion: 1 as const,
    compatibilityHash: compatibility.hash,
    rankingCatalogs: new Map(),
    playerCatalogs: new Map(),
    rankingResults: new Map(),
    playerResults: new Map(),
  }
  const promotion = attachIncrementalArtifactCache(
    attachIncrementalSnapshotModelCache(first.promotion, fixture.stateDir, snapshotModelCache),
    fixture.stateDir,
    cache,
  )
  const promoted = await promoteIncrementalState(promotion)
  const restored = await loadIncrementalCommunityImports(fixture.input)
  assert.deepEqual(restored.artifactCache, cache)
  assert.deepEqual(restored.snapshotModelCache, snapshotModelCache)
  assert.equal(restored.metrics.reducerStateBytesRead, promoted.reducerStateBytesWritten)

  const active = await activeGeneration(fixture.stateDir)
  const cacheEntry = record(active.generation.artifactCache)
  const cachePath = resolve(fixture.stateDir, 'artifacts', 'caches', `${stringField(cacheEntry, 'cacheHash')}.json`)
  const envelope = record(decodePrivateState(await readFile(cachePath, 'utf8')))
  assert.ok(Array.isArray(envelope.payload))
  const firstNode = record(envelope.payload[0])
  firstNode.semanticHash = 'tampered-semantic'
  await writePrivate(cachePath, envelope)
  const corrupt = await loadIncrementalCommunityImports(fixture.input)
  assert.equal(corrupt.fallback?.kind, 'checkpoint-corrupt')
  assert.match(corrupt.fallback?.kind === 'checkpoint-corrupt' ? corrupt.fallback.detail : '', /artifact-cache semantic hash mismatch/)
})

test('each reducer journal object rejects independent parseable tampering', async () => {
  for (const journal of ['histories', 'predictions', 'leagueHistory'] as const) {
    const fixture = await createFixture([header, ...firstGame].join('\n'))
    const first = await loadIncrementalCommunityImports(fixture.input)
    assert.ok(first.promotion)
    assert.ok(first.imports)
    await promoteIncrementalState(attachIncrementalReducerCheckpoint(
      first.promotion,
      fixture.stateDir,
      reducerCheckpointFor(first.imports.canonical),
    ))
    const active = await activeGeneration(fixture.stateDir)
    const [checkpointEntry] = arrayField(active.generation, 'reducerCheckpoints').map(record)
    assert.ok(checkpointEntry)
    const hashes = record(checkpointEntry.journalHashes)
    const directory = journal === 'leagueHistory' ? 'league-history' : journal
    const path = resolve(fixture.stateDir, 'reducers', 'journals', directory, `${stringField(hashes, journal)}.json`)
    const envelope = record(decodePrivateState(await readFile(path, 'utf8')))
    if (envelope.payload instanceof Map) envelope.payload.set('tampered-team', [])
    else {
      assert.ok(Array.isArray(envelope.payload))
      envelope.payload.push({ tampered: true })
    }
    await writePrivate(path, envelope)
    const result = await loadIncrementalCommunityImports(fixture.input)
    assert.equal(result.fallback?.kind, 'checkpoint-corrupt')
    assert.match(result.fallback?.kind === 'checkpoint-corrupt' ? result.fallback.detail : '', /reducer-journal semantic hash mismatch/)
  }
})

test('parseable reducer Map mutation cannot bypass its private-state semantic hash', async () => {
  const fixture = await createFixture([header, ...firstGame].join('\n'))
  const first = await loadIncrementalCommunityImports(fixture.input)
  assert.ok(first.promotion)
  assert.ok(first.imports)
  const checkpoint = reducerCheckpointFor(first.imports.canonical)
  await promoteIncrementalState(attachIncrementalReducerCheckpoint(first.promotion, fixture.stateDir, checkpoint))
  const active = await activeGeneration(fixture.stateDir)
  const [checkpointEntry] = arrayField(active.generation, 'reducerCheckpoints').map(record)
  assert.ok(checkpointEntry)
  const checkpointHash = stringField(checkpointEntry, 'checkpointHash')
  const reducerPath = resolve(fixture.stateDir, 'reducers', 'checkpoints', `${checkpointHash}.json`)
  const envelope = record(decodePrivateState(await readFile(reducerPath, 'utf8')))
  const payload = record(envelope.payload)
  const livePlayerEdge = record(payload.livePlayerEdge)
  const state = record(livePlayerEdge.state)
  assert.ok(state.ratings instanceof Map)
  state.ratings.set('tampered-player', 999)
  await writePrivate(reducerPath, envelope)

  const result = await loadIncrementalCommunityImports(fixture.input)
  assert.equal(result.fallback?.kind, 'checkpoint-corrupt')
  assert.match(result.fallback?.kind === 'checkpoint-corrupt' ? result.fallback.detail : '', /reducer-checkpoint semantic hash mismatch/)
  assert.ok(result.promotion)
})

function snapshotInputForCanonical(
  canonical: CanonicalRankingInput,
  runMetadata: { generatedAt: string; runId: string },
  modelProvider?: ReturnType<typeof createIncrementalSnapshotModelProvider>,
) {
  return {
    matches: canonical.matches,
    teams: canonical.teams,
    rosters: {},
    runMetadata,
    source: 'production provider state fixture',
    dataMode: 'scheduled-public-data' as const,
    ...(modelProvider ? { modelProvider } : {}),
  }
}

function assertSnapshotParity(
  canonical: CanonicalRankingInput,
  runMetadata: { generatedAt: string; runId: string },
  candidate: ReturnType<typeof createStaticRankingData>,
) {
  const reference = createStaticRankingData(snapshotInputForCanonical(canonical, runMetadata))
  assertCrunchParity(
    {
      fullSnapshot: reference,
      publicWrites: createPublicArtifactWritePlan(reference, { runMetadata }).writes,
    },
    {
      fullSnapshot: candidate,
      publicWrites: createPublicArtifactWritePlan(candidate, { runMetadata }).writes,
    },
  )
}

async function createFixture(contents: string) {
  const root = await mkdtemp(resolve(tmpdir(), 'lol-ranking-provider-state-'))
  const sourcePath = resolve(root, '2026.csv')
  const stateDir = resolve(root, 'state')
  await writeFile(sourcePath, contents)
  return {
    root,
    contents,
    sourcePath,
    stateDir,
    input: {
      stateDir,
      oracleCsvPaths: [sourcePath],
      leaguepediaJsonPaths: [],
      lolEsportsJsonPaths: [],
      oracleRetrievedAt: retrievedAt,
      now: retrievedAt,
      authorities,
      compatibility,
    },
  }
}

function reducerCheckpointFor(canonical: CanonicalRankingInput): IncrementalReducerCheckpoint {
  const livePlayerEdge = initializeLivePlayerEdgeReducer(canonical.matches, { teams: canonical.teams })
  for (const batch of matchesByDate(canonical.matches)) processLivePlayerEdgeDateBatch(livePlayerEdge, batch)
  const edges = finalizeLivePlayerEdgeReducer(livePlayerEdge)
  const team = initializeTeamReducer(canonical.matches, canonical.teams, { pregamePlayerRatingEdges: edges })
  for (const batch of matchesByDate(canonical.matches)) processTeamDateBatch(team, batch)
  finalizeTeamReducer(team)
  const dependencyPlan = buildReducerDependencyPlan({ matches: canonical.matches, teams: canonical.teams })
  return {
    schemaVersion: 1,
    processedDate: team.processedDate,
    canonicalPrefixHash: canonicalPrefixHash(canonical.matches, team.processedDate),
    dependencyHash: privateStateHash(dependencyPlan),
    dependencyPlan,
    retention: ['recent-daily'],
    livePlayerEdge: snapshotLivePlayerEdgeReducer(livePlayerEdge),
    team: snapshotTeamReducer(team),
  }
}

function activePointerPath(stateDir: string) {
  return resolve(stateDir, 'active-generation.json')
}

async function activeGeneration(stateDir: string) {
  const pointer = record(decodePrivateState(await readFile(activePointerPath(stateDir), 'utf8')))
  const generationHash = stringField(pointer, 'generationHash')
  const envelope = record(decodePrivateState(await readFile(resolve(stateDir, 'generations', `${generationHash}.json`), 'utf8')))
  return { pointer, envelope, generation: record(envelope.payload) }
}

async function installGeneration(stateDir: string, generation: Record<string, unknown>) {
  const generationHash = stableHash(generation)
  await writePrivate(resolve(stateDir, 'generations', `${generationHash}.json`), {
    schemaVersion: 2,
    kind: 'state-generation',
    contentHash: generationHash,
    payload: generation,
  })
  await writePrivate(activePointerPath(stateDir), { schemaVersion: 2, kind: 'active-generation', generationHash })
}

async function writePrivate(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, encodePrivateState(value))
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

function closureHash(selfHash: string, dependencies: Array<[string, string]>) {
  return sha256Hex(JSON.stringify({ selfHash, dependencies }))
}

function stringField(value: Record<string, unknown>, field: string): string {
  assert.equal(typeof value[field], 'string')
  return value[field] as string
}

function arrayField(value: Record<string, unknown>, field: string): unknown[] {
  assert.ok(Array.isArray(value[field]))
  return value[field] as unknown[]
}

function canonicalPayload(imports: { canonical?: unknown } | undefined) {
  return imports?.canonical
}
