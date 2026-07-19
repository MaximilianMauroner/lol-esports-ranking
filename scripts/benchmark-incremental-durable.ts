import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodePrivateState, encodePrivateState } from '../src/lib/incremental/canonicalCodec.ts'
import { assertCrunchParity } from '../src/lib/incremental/parity.ts'
import {
  createIncrementalSnapshotModelProvider,
  type PersistedSnapshotModelState,
} from '../src/lib/incremental/snapshotInputs.ts'
import { createPublicArtifactWritePlan } from '../src/lib/publicArtifacts/writePlan.ts'
import { createStaticRankingData } from '../src/lib/snapshot.ts'
import type { PlayerProfile, Role } from '../src/types.ts'
import {
  createMemoryDurableObjectStore,
  promoteDurableGeneration,
  restoreDurableGeneration,
  stageDurableGeneration,
  type DurableIdentity,
} from './durable-ranking-state.mjs'
import {
  fixedIncrementalFixture,
  mutateIncrementalFixture,
  type IncrementalFixture,
} from '../tests/fixtures/incrementalRankingFixtures.ts'

type BenchmarkScenario = {
  name: 'no-change' | 'append' | 'old-correction' | 'context-only' | 'static-player-change' | 'cold-restore'
  fixture: IncrementalFixture
  rosters: Record<string, PlayerProfile[]>
  coldRestore?: boolean
}

const identity: DurableIdentity = {
  compatibilityHash: 'phase5-benchmark',
  pipelineVersion: 'incremental-canonical-v2',
  codeHash: 'benchmark-code',
  modelVersion: 'transparent-gpr-v2',
  modelConfigHash: 'benchmark-config',
}

export async function runDurableBenchmark() {
  const root = await mkdtemp(join(tmpdir(), 'ranking-durable-benchmark-'))
  const stateDir = join(root, 'state')
  const restoredDir = join(root, 'restored')
  const store = createMemoryDurableObjectStore()
  try {
    const base = fixedIncrementalFixture()
    const baseRosters = staticRosters()
    const baseProvider = createIncrementalSnapshotModelProvider({ compatibilityHash: identity.compatibilityHash })
    createStaticRankingData(snapshotInput(base, baseRosters, baseProvider, 'benchmark-base'))
    const baseState = baseProvider.persistedState()
    await writePrivateProviderState(stateDir, baseState)
    const initial = await stageDurableGeneration({
      store,
      stateDir,
      identity,
      generatedAt: '2026-07-19T00:00:00.000Z',
      parity: { result: 'match' },
    })
    await promoteDurableGeneration({
      store,
      candidate: initial,
      fencingToken: 1,
      generationId: 'benchmark-base',
      promotedAt: '2026-07-19T00:00:01.000Z',
      parityOutcome: { result: 'match' },
    })

    const scenarios: BenchmarkScenario[] = [
      { name: 'no-change', fixture: base, rosters: baseRosters },
      { name: 'append', fixture: mutateIncrementalFixture(base, 'append'), rosters: baseRosters },
      { name: 'old-correction', fixture: mutateIncrementalFixture(base, 'correction'), rosters: baseRosters },
      { name: 'context-only', fixture: mutateIncrementalFixture(base, 'tournament-completion'), rosters: baseRosters },
      { name: 'static-player-change', fixture: base, rosters: renamedStaticRoster(baseRosters) },
      { name: 'cold-restore', fixture: base, rosters: baseRosters, coldRestore: true },
    ]
    const rows = []
    for (const [index, scenario] of scenarios.entries()) {
      const previous = scenario.coldRestore
        ? await restoredProviderState(store, restoredDir)
        : baseState
      const provider = createIncrementalSnapshotModelProvider({ compatibilityHash: identity.compatibilityHash, previous })
      const runId = `benchmark-${scenario.name}`
      const common = snapshotInput(scenario.fixture, scenario.rosters, undefined, runId)
      const reference = createStaticRankingData(common)
      const candidate = createStaticRankingData({ ...common, modelProvider: provider })
      const runMetadata = common.runMetadata
      const referencePlan = createPublicArtifactWritePlan(reference, { runMetadata })
      const candidatePlan = createPublicArtifactWritePlan(candidate, { runMetadata })
      assertCrunchParity(
        { fullSnapshot: reference, publicWrites: referencePlan.writes },
        { fullSnapshot: candidate, publicWrites: candidatePlan.writes },
      )
      const metrics = provider.metrics()
      assert.equal(metrics.directRankingBuilds, 0)
      assert.equal(metrics.directPlayerBuilds, 0)
      await writePrivateProviderState(stateDir, provider.persistedState())
      const staged = await stageDurableGeneration({
        store,
        stateDir,
        identity,
        generatedAt: `2026-07-${String(20 + index).padStart(2, '0')}T00:00:00.000Z`,
        parity: { result: 'match', scenario: scenario.name },
      })
      rows.push({
        scenario: scenario.name,
        publicBytes: referencePlan.writes.reduce((sum, write) => sum + Buffer.byteLength(write.contents), 0),
        rankingRequests: metrics.rankingRequests,
        rankingRuns: metrics.rankingReducerRuns,
        rankingRows: metrics.rankingRows,
        playerRequests: metrics.playerRequests,
        playerRuns: metrics.playerReducerRuns,
        playerRows: metrics.playerRows,
        resultCacheHits: metrics.rankingResultCacheHits + metrics.playerResultCacheHits,
        uploadedObjects: staged.metrics.uploadedObjects,
        uploadedBytes: staged.metrics.uploadedBytes,
        skippedObjects: staged.metrics.skippedObjects,
        skippedBytes: staged.metrics.skippedBytes,
      })
    }
    const noChange = rows.find((row) => row.scenario === 'no-change')
    assert.ok(noChange)
    assert.equal(noChange.rankingRuns, 0)
    assert.equal(noChange.playerRuns, 0)
    return { schemaVersion: 1, scenarios: rows }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function restoredProviderState(store: ReturnType<typeof createMemoryDurableObjectStore>, restoredDir: string) {
  const restore = await restoreDurableGeneration({ store, stateDir: restoredDir, expectedIdentity: identity })
  assert.equal(restore.restored, true)
  const contents = await readFile(join(restoredDir, 'snapshot-models', 'provider-state.json'), 'utf8')
  return parsePersistedProviderState(decodePrivateState(contents))
}

async function writePrivateProviderState(stateDir: string, state: PersistedSnapshotModelState) {
  await mkdir(join(stateDir, 'snapshot-models'), { recursive: true })
  await writeFile(join(stateDir, 'active-generation.json'), 'benchmark-active\n')
  await writeFile(join(stateDir, 'snapshot-models', 'provider-state.json'), encodePrivateState(state))
}

function parsePersistedProviderState(value: unknown): PersistedSnapshotModelState {
  assert.equal(typeof value, 'object')
  assert.notEqual(value, null)
  assert.equal(Array.isArray(value), false)
  const state = value as Partial<PersistedSnapshotModelState>
  assert.equal(state.schemaVersion, 1)
  assert.ok(state.rankingCatalogs instanceof Map)
  assert.ok(state.playerCatalogs instanceof Map)
  assert.ok(state.rankingResults instanceof Map)
  assert.ok(state.playerResults instanceof Map)
  return state as PersistedSnapshotModelState
}

function snapshotInput(
  fixture: IncrementalFixture,
  rosters: Record<string, PlayerProfile[]>,
  modelProvider: ReturnType<typeof createIncrementalSnapshotModelProvider> | undefined,
  runId: string,
) {
  return {
    matches: fixture.matches,
    teams: fixture.teams,
    rosters,
    runMetadata: { generatedAt: '2026-07-19T00:00:00.000Z', runId },
    source: 'phase5 benchmark fixture',
    dataMode: 'scheduled-public-data' as const,
    tournamentScheduleReferences: fixture.scheduleReferences,
    ...(modelProvider ? { modelProvider } : {}),
  }
}

function staticRosters(): Record<string, PlayerProfile[]> {
  const roles: Role[] = ['Top', 'Jungle', 'Mid', 'Bot', 'Support']
  return Object.fromEntries(['Gen.G', 'T1'].map((team) => [team, roles.map((role) => ({
    id: `${team}-${role}`,
    name: `${team} ${role}`,
    team,
    role,
  }))]))
}

function renamedStaticRoster(rosters: Record<string, PlayerProfile[]>) {
  return Object.fromEntries(Object.entries(rosters).map(([team, players]) => [team, players.map((player, index) => (
    team === 'T1' && index === 0 ? { ...player, name: `${player.name} Updated` } : { ...player }
  ))]))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  console.log(JSON.stringify(await runDurableBenchmark(), null, 2))
}
