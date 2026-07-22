import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { MatchRecord, TeamProfile } from '../src/types.ts'
import { buildRankingIncrementally, type IncrementalRankingBuildResult, type RestoredIncrementalAuthority } from '../scripts/incremental-ranking-orchestrator.ts'
import { createGenerationManifest, prepareSemanticArtifact } from '../scripts/public-artifact-storage.mjs'
import type { RankingSourceImport } from '../scripts/ranking-source-import.ts'
import { buildStaticSnapshot } from '../scripts/build-static-snapshot.ts'

test('feature/mode matrix preserves legacy and daily/manual force full while canonical no-change exits before build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incremental-matrix-'))
  try {
    const source = fixtureSource(baseMatches())
    const disabled = await run(root, 'disabled', source, { mode: 'gated', cause: 'pending-match', enabled: false })
    assert.equal(disabled.action, 'publish-full')
    assert.equal(disabled.metrics.fullSnapshotWritten, true)
    const legacy = await run(root, 'legacy', source, { mode: 'legacy', cause: 'pending-match', enabled: true })
    assert.equal(legacy.action, 'publish-full')
    const daily = await run(root, 'daily', source, { mode: 'gated', cause: 'daily-audit', enabled: true })
    assert.equal(daily.action, 'publish-full')
    const manual = await run(root, 'manual', source, { mode: 'shadow', cause: 'manual-force', enabled: true })
    assert.equal(manual.action, 'publish-full')

    const restored = restoreFrom(disabled)
    const noChange = await run(root, 'unchanged', source, { mode: 'gated', cause: 'pending-match', enabled: true, restored })
    assert.equal(noChange.action, 'no-change', noChange.metrics.fallbackReason)
    assert.equal(noChange.metrics.fullSnapshotWritten, false)
    await assert.rejects(access(join(root, 'unchanged-full.json')))
    await assert.rejects(access(join(root, 'unchanged-public')))

    const metadataSource = { ...source, externalSources: [{
      name: 'Oracle fixture', kind: 'game-stats' as const, description: 'receipt-only change', status: 'active' as const,
      retrievedAt: '2026-07-22T00:01:00.000Z',
    }] }
    const metadata = await run(root, 'metadata', metadataSource, { mode: 'gated', cause: 'pending-match', enabled: true, restored })
    assert.equal(metadata.action, 'publish-incremental')
    assert.equal(metadata.metrics.classification, 'metadata-only')
    assert.equal(metadata.metrics.replayedMatchCount, 0)
    assert.deepEqual(metadata.metrics.changedPaths, ['/data/ranking-summary.json'])
    assert.equal(metadata.action === 'publish-incremental' ? metadata.build : undefined, undefined)
    await assert.rejects(access(join(root, 'metadata-full.json')))
  } finally {
    if (process.env.KEEP_INCREMENTAL_TEST_TMP !== 'true') await rm(root, { recursive: true, force: true })
  }
})

test('append, same-day insertion, and historical correction use whole-date replay and equal clean full semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incremental-parity-'))
  try {
    const base = await run(root, 'base', fixtureSource(baseMatches()), { mode: 'gated', cause: 'daily-audit', enabled: true })
    const restored = restoreFrom(base)
    const scenarios = {
      append: [...baseMatches(), match('m5', '2026-01-05', 'Event C')],
      appendExistingEvent: [...baseMatches(), match('m5-existing', '2026-01-05', 'Event B')],
      sameDay: [...baseMatches(), match('m4b', '2026-01-04', 'Event B', { datetimeUtc: '2026-01-04T18:00:00.000Z' })],
      correction: baseMatches().map((entry) => entry.id === 'm3' ? { ...entry, winner: 'Beta' } : entry),
    }
    for (const [name, matches] of Object.entries(scenarios)) {
      const source = fixtureSource(matches)
      const incremental = await run(root, `${name}-incremental`, source, { mode: 'gated', cause: 'pending-match', enabled: true, restored })
      assert.equal(incremental.action, 'publish-incremental', `${name}: ${incremental.metrics.fallbackReason ?? 'no fallback reason'}`)
      assert.equal(incremental.metrics.fullSnapshotWritten, false, name)
      assert.ok(incremental.metrics.replayedMatchCount > 0, name)
      const full = await run(root, `${name}-full`, source, { mode: 'legacy', cause: 'daily-audit', enabled: false })
      assert.deepEqual(semanticMap(incremental), semanticMap(full), name)
      await assert.rejects(access(join(root, `${name}-incremental-full.json`)), name)
    }
  } finally {
    if (process.env.KEEP_INCREMENTAL_TEST_TMP !== 'true') await rm(root, { recursive: true, force: true })
  }
})

test('shadow publishes full authority and missing/context-invalid checkpoints or parity mismatch diagnose and fall back fully', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incremental-fallbacks-'))
  try {
    const baseline = await run(root, 'fallback-base', fixtureSource(baseMatches()), { mode: 'gated', cause: 'daily-audit', enabled: true })
    const restored = restoreFrom(baseline)
    const appended = fixtureSource([...baseMatches(), match('m5', '2026-01-05', 'Event C')])
    const shadow = await run(root, 'shadow', appended, { mode: 'shadow', cause: 'pending-match', enabled: true, restored })
    assert.equal(shadow.action, 'publish-full')
    assert.equal(shadow.metrics.parity, true)
    assert.equal(shadow.metrics.stateParity, true)
    assert.equal(shadow.diagnostic, undefined)
    const shadowFull = await run(root, 'shadow-authority', appended, { mode: 'legacy', cause: 'daily-audit', enabled: false })
    assert.deepEqual(shadow.state, shadowFull.action === 'no-change' ? undefined : shadowFull.state)

    const missing = await run(root, 'missing', appended, {
      mode: 'gated', cause: 'pending-match', enabled: true,
      restored: { ...restored, checkpoints: [] },
    })
    assert.equal(missing.action, 'publish-full')
    assert.match(missing.metrics.fallbackReason ?? '', /checkpoint-no-safe-checkpoint/)
    assert.equal(missing.diagnostic?.kind, 'incremental-fallback')

    const invalid = structuredClone(restored)
    invalid.checkpoints.at(-1)!.bundle.causalSummaries = { invalid: true }
    const contextInvalid = await run(root, 'context-invalid', appended, { mode: 'gated', cause: 'pending-match', enabled: true, restored: invalid })
    assert.equal(contextInvalid.action, 'publish-full')
    assert.match(contextInvalid.metrics.fallbackReason ?? '', /checkpoint-/)

    const corruptCandidate: typeof buildStaticSnapshot = async (options) => {
      const built = await buildStaticSnapshot({ ...options, silent: true })
      if (options?.writeFullSnapshot === false) {
        const scope = built.publicPlan.writes.find((write) => write.relativePath.startsWith('scopes/'))
        if (scope && scope.value && typeof scope.value === 'object' && !Array.isArray(scope.value)) {
          scope.value = { ...scope.value, matchCount: -1 }
        }
      }
      return built
    }
    const mismatch = await run(root, 'parity-mismatch', appended, {
      mode: 'shadow', cause: 'pending-match', enabled: true, restored, buildSnapshot: corruptCandidate,
    })
    assert.equal(mismatch.action, 'publish-full')
    assert.equal(mismatch.metrics.parity, false)
    assert.equal(mismatch.diagnostic?.kind, 'shadow-parity')
    assert.equal(mismatch.diagnostic?.parity?.equal, false)
  } finally {
    if (process.env.KEEP_INCREMENTAL_TEST_TMP !== 'true') await rm(root, { recursive: true, force: true })
  }
})

test('causal tournament schedule transitions replay while future schedule appends keep predecessor checkpoints valid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incremental-tournament-transition-'))
  try {
    const tournamentMatches = baseMatches().map((entry) => ({
      ...entry,
      event: 'MSI 2026',
      tier: 'msi-bracket' as const,
      officialMatchId: `official-${entry.id}`,
    }))
    const baseSource = fixtureSource(tournamentMatches)
    baseSource.tournamentScheduleReferences = tournamentMatches.map((entry) => ({
      matchId: entry.officialMatchId!, leagueName: 'MSI', date: entry.date, startTime: `${entry.date}T12:00:00.000Z`,
      state: 'unstarted', retrievedAt: '2026-01-04T00:00:00.000Z', coverageStart: '2025-12-20', coverageEnd: '2026-01-04', coverageEndComplete: true,
    }))
    const baseline = await run(root, 'tournament-base', baseSource, { mode: 'gated', cause: 'daily-audit', enabled: true })
    const restored = restoreFrom(baseline)
    const transitioned = structuredClone(baseSource)
    transitioned.tournamentScheduleReferences = transitioned.tournamentScheduleReferences.map((entry) => ({ ...entry, state: 'completed', retrievedAt: '2026-01-05T00:00:00.000Z' }))
    const incremental = await run(root, 'tournament-transition', transitioned, { mode: 'gated', cause: 'pending-match', enabled: true, restored })
    assert.equal(incremental.action, 'publish-full')
    assert.equal(incremental.metrics.classification, 'historical-correction')
    assert.match(incremental.metrics.fallbackReason ?? '', /checkpoint-/)
    const full = await run(root, 'tournament-transition-full', transitioned, { mode: 'legacy', cause: 'daily-audit', enabled: false })
    assert.deepEqual(semanticMap(incremental), semanticMap(full))

    const future = structuredClone(baseSource)
    future.tournamentScheduleReferences.push({
      matchId: 'future-match', leagueName: 'MSI', date: '2026-02-01', startTime: '2026-02-01T12:00:00.000Z',
      state: 'unstarted', retrievedAt: '2026-01-05T00:00:00.000Z', coverageStart: '2025-12-20', coverageEnd: '2026-02-01', coverageEndComplete: true,
    })
    const appended = await run(root, 'tournament-schedule-append', future, { mode: 'gated', cause: 'pending-match', enabled: true, restored })
    assert.equal(appended.action, 'publish-incremental', appended.metrics.fallbackReason)
    assert.equal(appended.metrics.classification, 'latest-append')
    assert.ok(appended.metrics.selectedBoundary)
  } finally {
    if (process.env.KEEP_INCREMENTAL_TEST_TMP !== 'true') await rm(root, { recursive: true, force: true })
  }
})

test('provider availability is attributed to the receipt covering the newly observed match', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incremental-provider-availability-'))
  try {
    const baselineSource = fixtureSource(baseMatches())
    baselineSource.externalSources = [providerReceipt('2026-01-04T06:00:00.000Z', '2026-01-04')]
    const baseline = await run(root, 'provider-base', baselineSource, { mode: 'gated', cause: 'daily-audit', enabled: true })
    const appendedSource = fixtureSource([...baseMatches(), match('m5', '2026-01-05', 'Event C')])
    appendedSource.externalSources = [
      providerReceipt('2026-01-04T06:00:00.000Z', '2026-01-04'),
      providerReceipt('2026-01-05T08:30:00.000Z', '2026-01-05', 'Oracle fixture delta'),
    ]
    const incremental = await run(root, 'provider-append', appendedSource, {
      mode: 'gated', cause: 'pending-match', enabled: true, restored: restoreFrom(baseline),
    })
    assert.equal(incremental.action, 'publish-incremental', incremental.metrics.fallbackReason)
    assert.equal(incremental.metrics.providerAvailableAt, '2026-01-05T08:30:00.000Z')
  } finally {
    if (process.env.KEEP_INCREMENTAL_TEST_TMP !== 'true') await rm(root, { recursive: true, force: true })
  }
})

function run(
  root: string,
  name: string,
  sourceData: RankingSourceImport,
  options: { mode: 'legacy' | 'shadow' | 'gated'; cause: string; enabled: boolean; restored?: RestoredIncrementalAuthority; buildSnapshot?: typeof buildStaticSnapshot },
) {
  return buildRankingIncrementally({
    ...options,
    sourceData,
    generatedAt: '2026-07-22T00:00:00.000Z',
    manifestPath: join(root, 'unused-manifest.json'),
    output: join(root, `${name}-full.json`),
    publicDataDir: join(root, `${name}-public`),
    diagnosticPath: join(root, `${name}-diagnostic.json`),
  })
}

function restoreFrom(result: IncrementalRankingBuildResult): RestoredIncrementalAuthority {
  assert.notEqual(result.action, 'no-change')
  if (result.action === 'no-change') throw new Error('unreachable')
  if (!result.build) throw new Error('baseline materialization is missing')
  const root = result.build.publicPlan.manifest as Record<string, unknown>
  const artifactMeta = root.artifactMeta as { runId: string }
  const entries = result.build.publicPlan.writes.map((write) => {
    const prepared = prepareSemanticArtifact(write.value)
    return { logicalPath: `/data/${write.relativePath}`, digest: prepared.digest, bytes: prepared.bytes }
  })
  const publicManifest = createGenerationManifest({ generationId: artifactMeta.runId, rootManifest: root, entries })
  const checkpoints = result.state.checkpoints.map((checkpoint) => ({
    candidate: {
      boundary: checkpoint.boundary,
      rawPrefix: checkpoint.rawPrefix,
      object: { key: `state/objects/sha256/${'a'.repeat(64)}`, sha256: 'a'.repeat(64), bytes: 1, compressedBytes: 1, storageEncoding: 'gzip' as const },
    },
    bundle: {
      artifactKind: 'incremental-state-checkpoint-bundle', schemaVersion: 1,
      boundary: checkpoint.boundary, rawPrefix: checkpoint.rawPrefix,
      compatibility: result.state.compatibility,
      ratingCheckpoint: checkpoint.ratingCheckpoint, causalSummaries: checkpoint.causalSummaries,
    },
  }))
  return {
    stateManifest: {
      artifactKind: 'incremental-state-generation-manifest', schemaVersion: 1,
      storageMode: 'content-addressed-state-gzip-v1', generationId: artifactMeta.runId, runId: artifactMeta.runId,
      baseGenerationId: null, baseRunId: null,
      canonicalLedger: { key: `state/objects/sha256/${'b'.repeat(64)}`, sha256: 'b'.repeat(64), bytes: 1, compressedBytes: 1, storageEncoding: 'gzip' },
      sourceReceiptDigest: result.state.sourceReceiptDigest, compatibility: result.state.compatibility,
      checkpoints: checkpoints.map((checkpoint) => checkpoint.candidate),
    },
    canonicalLedger: result.state.ledger,
    checkpoints,
    publicManifest,
    rootArtifact: root,
    artifacts: Object.fromEntries(result.build.publicPlan.writes.map((write) => [`/data/${write.relativePath}`, write.value])),
  }
}

function semanticMap(result: IncrementalRankingBuildResult) {
  if (result.action === 'no-change') throw new Error('no build')
  if (result.action === 'publish-incremental') {
    const mapped = Object.fromEntries(Object.entries(result.patch.previousManifest.artifacts as Record<string, { sha256: string }>).map(([path, identity]) => [path, identity.sha256]))
    for (const path of result.patch.removedLogicalPaths) delete mapped[path]
    for (const artifact of result.patch.changedArtifacts) mapped[artifact.logicalPath] = prepareSemanticArtifact(artifact.value).digest
    return mapped
  }
  if (!result.build) throw new Error('no materialized build')
  return Object.fromEntries(result.build.publicPlan.writes.map((write) => [`/data/${write.relativePath}`, prepareSemanticArtifact(write.value).digest]))
}

const teams: Record<string, TeamProfile> = {
  Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
  Beta: { name: 'Beta', code: 'BET', region: 'LCK', league: 'LCK' },
}
function fixtureSource(matches: MatchRecord[]): RankingSourceImport {
  return {
    manifest: { schemaVersion: 1, generatedAt: '2026-07-22T00:00:00.000Z', files: {} },
    importedMatches: matches, matches, teams, mergedTeams: teams,
    source: 'deterministic integration fixture', dataMode: 'scheduled-public-data', externalSources: [], tournamentScheduleReferences: [],
  }
}
function providerReceipt(retrievedAt: string, coverageEnd: string, name = 'Oracle fixture') {
  return {
    name, kind: 'game-stats' as const, description: 'fixture provider receipt', status: 'active' as const,
    retrievedAt, coverageStart: '2025-12-01', coverageEnd, rowCount: 1,
  }
}
function baseMatches() {
  return [
    match('m0', '2025-12-31', 'Event Zero'),
    match('m1', '2026-01-01', 'Event A'),
    match('m2', '2026-01-02', 'Event A'),
    match('m3', '2026-01-03', 'Event B'),
    match('m4', '2026-01-04', 'Event B'),
  ]
}
function match(id: string, date: string, event: string, overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    id, sourceProvider: 'oracles-elixir', sourceGameId: id, sourceMatchId: `series-${id}`,
    date, datetimeUtc: `${date}T12:00:00.000Z`, season: Number(date.slice(0, 4)), event,
    phase: 'Regular season', region: 'LCK', league: 'LCK', patch: '26.1', bestOf: 1,
    tier: 'regional-regular', teamA: 'Alpha', teamB: 'Beta', winner: 'Alpha',
    teamAKills: 10, teamBKills: 5, teamAGold: 60_000, teamBGold: 55_000, ...overrides,
  }
}
