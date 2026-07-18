import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { canonicalCodeProvenanceHash } from '../scripts/canonical-code-provenance.ts'
import {
  loadIncrementalCommunityImports,
  promoteIncrementalState,
  stageIncrementalState,
  type ProviderAuthorities,
} from '../scripts/incremental-provider-state.ts'
import { importOraclesElixirCsv } from '../src/lib/importers/oraclesElixir.ts'
import { decodePrivateState, encodePrivateState } from '../src/lib/incremental/canonicalCodec.ts'
import { createCrunchCompatibility } from '../src/lib/incremental/compatibility.ts'
import { stableHash } from '../src/lib/incremental/hash.ts'
import { orchestrateCrunch } from '../src/lib/incremental/orchestrator.ts'
import { assertCrunchParity } from '../src/lib/incremental/parity.ts'

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
