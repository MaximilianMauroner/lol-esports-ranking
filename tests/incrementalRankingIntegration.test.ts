import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { MatchRecord, MatchRosterSnapshot, Role, Side, TeamProfile } from '../src/types.ts'
import { buildRankingIncrementally, mergePartialPlayerDirectoryArtifact, type IncrementalRankingBuildResult, type RestoredIncrementalAuthority } from '../scripts/incremental-ranking-orchestrator.ts'
import { createGenerationManifest, prepareSemanticArtifact } from '../scripts/public-artifact-storage.mjs'
import type { RankingSourceImport } from '../scripts/ranking-source-import.ts'
import { normalizeRankingRefreshOutcome } from '../scripts/ranking-refresh-outcome-contract.mjs'
import { buildStaticSnapshot } from '../scripts/build-static-snapshot.ts'
import { createStaticRankingData } from '../src/lib/snapshot.ts'
import { buildPlayerModel } from '../src/lib/model.ts'
import { runRefreshOnce } from '../scripts/refresh-once.mjs'

test('partial player directory preserves valid unaffected season players and diagnostics', () => {
  const merged = mergePartialPlayerDirectoryArtifact({
    artifactKind: 'player-directory',
    players: [{ id: 'current' }],
    scopedPlayers: { '2026__All__All': [{ id: 'new-2026' }] },
    diagnostics: {
      sameTeamTopFiveClustering: { scope: 'All__All__All' },
      scopedSameTeamTopFiveClustering: { '2026__All__All': { scope: 'new-2026' } },
    },
  }, {
    scopedPlayers: {
      '2025__All__All': [{ id: 'old-2025' }],
      '2026__All__All': [{ id: 'old-2026' }],
      '2024__All__All': [{ id: 'obsolete' }],
    },
    diagnostics: { scopedSameTeamTopFiveClustering: {
      '2025__All__All': { scope: 'old-2025' },
      '2026__All__All': { scope: 'old-2026' },
      '2024__All__All': { scope: 'obsolete' },
    } },
  }, new Set(['2026__All__All']), new Set(['2025__All__All', '2026__All__All']))

  assert.deepEqual(merged.scopedPlayers, {
    '2025__All__All': [{ id: 'old-2025' }],
    '2026__All__All': [{ id: 'new-2026' }],
  })
  assert.deepEqual((merged.diagnostics as Record<string, unknown>).scopedSameTeamTopFiveClustering, {
    '2025__All__All': { scope: 'old-2025' },
    '2026__All__All': { scope: 'new-2026' },
  })
})

test('releasing import audit rows before snapshot preserves roster/player public semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incremental-lean-source-'))
  try {
    const normalSource = structuredClone(fixtureSource(sourcedPlayerMatchesWithSubstitutionAndCorrection()))
    normalSource.importedMatches = structuredClone(normalSource.matches)
    const leanSource = structuredClone(normalSource)
    const normal = await buildStaticSnapshot({
      sourceData: normalSource,
      generatedAt: '2026-07-22T00:00:00.000Z',
      publicDataDir: join(root, 'normal-public'),
      output: join(root, 'normal-full.json'),
      writeFullSnapshot: false,
      compactPlayerDirectory: false,
      silent: true,
    })
    const sourceReferences = new Set<unknown>(normalSource.matches.flatMap((entry) => [entry, entry.teamARoster, entry.teamBRoster]))
    assert.equal(normal.publicPlan.writes.some((write) => containsReference(write.value, sourceReferences)), false)
    const lean = await buildStaticSnapshot({
      sourceData: leanSource,
      generatedAt: '2026-07-22T00:00:00.000Z',
      publicDataDir: join(root, 'lean-public'),
      output: join(root, 'lean-full.json'),
      writeFullSnapshot: false,
      releaseImportAuditBeforeSnapshot: true,
      compactPlayerDirectory: true,
      silent: true,
    })
    const identities = (writes: typeof normal.publicPlan.writes) => Object.fromEntries(
      writes.map((write) => [write.relativePath, prepareSemanticArtifact(write.value).digest]),
    )
    const normalIdentities = identities(normal.publicPlan.writes)
    assert.deepEqual(identities(lean.publicPlan.writes), normalIdentities)
    assert.equal(
      prepareSemanticArtifact({
        artifactKind: 'player-model-regression',
        players: buildPlayerModel(normalSource.matches, {}, { teams: normalSource.teams }),
      }).digest,
      '8619633cd62e81ccf4549654dfe013298a2f421ec836d2597f2d99b1f33531f5',
    )
    assert.equal(normalIdentities['entities/players.json'], '5a0a99651117e85e2c4af847504168634fb7128abb614e154e85768695658e9e')
    const compactSnapshot = createStaticRankingData({
      matches: structuredClone(normalSource.matches),
      teams: structuredClone(normalSource.teams),
      rosters: {},
      generatedAt: '2026-07-22T00:00:00.000Z',
      compactPlayerDirectory: true,
    })
    assert.equal(Object.values(compactSnapshot.snapshots).every((snapshot) => snapshot.players.length === 0), true)
    assert.ok(compactSnapshot.precomputedPlayerDirectory)
    assert.ok(compactSnapshot.precomputedPlayerDirectory.players.length > 0)
    assert.equal(leanSource.importedMatches.length, 0)
    assert.deepEqual(leanSource.mergedTeams, {})
    assert.ok(normalSource.importedMatches.length > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('feature/mode matrix preserves disabled and daily/manual force full while canonical no-change exits before build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incremental-matrix-'))
  try {
    const source = fixtureSource(baseMatches())
    const disabled = await run(root, 'disabled', source, { mode: 'gated', cause: 'pending-match', enabled: false })
    assert.equal(disabled.action, 'publish-full')
    assert.equal(disabled.metrics.fullSnapshotWritten, true)
    if (disabled.action !== 'publish-full') return
    if (!('snapshot' in disabled.build) || !disabled.build.fullSnapshotDescriptor) throw new Error('Full build did not return its snapshot descriptor')
    const fullBuild = disabled.build
    const fullSnapshotDescriptor = fullBuild.fullSnapshotDescriptor
    if (!fullSnapshotDescriptor) throw new Error('Full build snapshot descriptor was released unexpectedly')
    const fullBytes = await readFile(join(root, 'disabled-full.json'))
    assert.equal(fullSnapshotDescriptor.bytes, fullBytes.byteLength)
    assert.equal(fullSnapshotDescriptor.sha256, createHash('sha256').update(fullBytes).digest('hex'))
    assert.equal(fullSnapshotDescriptor.generatedAt, fullBuild.snapshot.generatedAt)
    assert.deepEqual(fullSnapshotDescriptor.model, {
      version: fullBuild.snapshot.model.version,
      configHash: fullBuild.snapshot.model.configHash,
    })
    const missingState = await run(root, 'missing-state', source, { mode: 'gated', cause: 'pending-match', enabled: true })
    assert.equal(missingState.action, 'publish-full')
    const daily = await run(root, 'daily', source, { mode: 'gated', cause: 'daily-audit', enabled: true, restored: restoreFrom(disabled) })
    assert.equal(daily.action, 'publish-full')
    assert.equal(daily.metrics.parity, true)
    const manual = await run(root, 'manual', source, { mode: 'shadow', cause: 'manual-force', enabled: true })
    assert.equal(manual.action, 'publish-full')

    const restored = restoreFrom(disabled)
    const noChange = await run(root, 'unchanged', source, { mode: 'gated', cause: 'pending-match', enabled: true, restored })
    assert.equal(noChange.action, 'no-change', noChange.metrics.fallbackReason)
    assert.equal(outcomeForBuild(noChange), 'unchanged')
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
    assert.equal(outcomeForBuild(metadata), 'metadata-only')
    assert.equal(metadata.metrics.replayedMatchCount, 0)
    assert.deepEqual(metadata.metrics.changedPaths, ['/data/ranking-summary.json'])
    assert.equal(metadata.action === 'publish-incremental' ? metadata.build : undefined, undefined)
    await assert.rejects(access(join(root, 'metadata-full.json')))
  } finally {
    if (process.env.KEEP_INCREMENTAL_TEST_TMP !== 'true') await rm(root, { recursive: true, force: true })
  }
})

test('retry no-change reconciliation acknowledges a match after publish-to-parent crash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incremental-reconciliation-'))
  try {
    const official = (entry: MatchRecord): MatchRecord => ({
      ...entry,
      officialMatchId: `official-${entry.id}`,
      officialGameId: `official-game-${entry.id}`,
    })
    const baselineMatches = baseMatches().map(official)
    const baseline = await run(root, 'reconciliation-base', fixtureSource(baselineMatches), {
      mode: 'gated', cause: 'daily-audit', enabled: true,
    })
    const pendingMatchId = 'official-pending'
    const pending = official(match('pending', '2026-01-05', 'Event C', {
      officialMatchId: pendingMatchId,
      officialGameId: 'official-game-pending',
    }))
    const source = fixtureSource([...baselineMatches, pending])
    source.importedMatches = structuredClone(source.matches)
    const reconciliationOutput = join(root, 'reconciliation.json')
    const restored = restoreFrom(baseline)
    const first = await buildRankingIncrementally({
      mode: 'gated', cause: 'pending-match', enabled: true,
      sourceData: source,
      restored,
      generatedAt: '2026-07-22T00:00:00.000Z',
      manifestPath: join(root, 'unused-manifest.json'),
      output: join(root, 'reconciliation-full.json'),
      publicDataDir: join(root, 'reconciliation-public'),
      reconciliationOutput,
      silent: true,
    })
    assert.equal(first.action, 'publish-incremental')
    if (first.action !== 'publish-incremental') throw new Error('incremental publication required')
    const published = restoreIncremental(restored, first)
    assert.equal(source.importedMatches.length, 0)
    await rm(reconciliationOutput, { force: true })

    const retrySource = fixtureSource([...baselineMatches, pending])
    retrySource.importedMatches = structuredClone(retrySource.matches)
    let retry: IncrementalRankingBuildResult | undefined
    let writes = 0
    const parent = await runRefreshOnce({
      env: {
        RANKING_REFRESH_MODE: 'gated',
        RANKING_RECONCILIATION_OUTPUT: reconciliationOutput,
        RANKING_REFRESH_METRICS_PATH: join(root, 'refresh-metrics.json'),
      },
      runId: 'reconciliation-parent',
      owner: 'worker',
      now: () => new Date('2026-07-22T00:00:00Z'),
      monotonicNow: (() => { let value = 0; return () => ++value })(),
      bucketConfig: { enabled: true },
      bucketClient: {},
      acquireLease: async () => ({
        acquired: true as const,
        lease: { owner: 'worker', fencingToken: 1, expiresAt: '2026-07-22T00:45:00Z' },
        etag: 'lease',
      }),
      assertLease: async () => ({ live: true as const }),
      renewLease: async (_key: string, authority: { lease: Record<string, unknown> }) => ({
        renewed: true as const,
        lease: { ...authority.lease, expiresAt: '2026-07-22T00:45:00Z' },
        etag: 'renewed',
        promotionEtag: 'renewed',
      }),
      releaseLease: async () => ({ released: true }),
      readBucketJson: async () => ({ found: false }),
      writeBucketJson: async () => ({ written: true, etag: `state-${++writes}` }),
      readLocalState: async () => undefined,
      writeLocalState: async () => undefined,
      fetchProbe: async () => ({
        checkedAt: '2026-07-22T00:00:00Z',
        coverageComplete: true,
        events: [{ matchId: pendingMatchId, state: 'completed', startTime: '2026-01-05T12:00:00Z', teams: [{ id: 'Alpha', gameWins: 1 }, { id: 'Beta', gameWins: 0 }] }],
      }),
      runChild: async () => {
        retry = await buildRankingIncrementally({
          mode: 'gated', cause: 'pending-match', enabled: true,
          sourceData: retrySource,
          restored: published,
          generatedAt: '2026-07-22T00:00:00.000Z',
          manifestPath: join(root, 'unused-manifest.json'),
          output: join(root, 'reconciliation-full.json'),
          publicDataDir: join(root, 'reconciliation-public'),
          reconciliationOutput,
          silent: true,
        })
      },
      setInterval: () => ({ unref() {} }),
      clearInterval: () => undefined,
      logger: { log() {}, warn() {}, error() {} },
    })
    assert.equal(retry?.action, 'no-change')
    const reconciliation = JSON.parse(await readFile(reconciliationOutput, 'utf8')) as {
      matches: Array<{ matchId: string; status: string }>
    }
    assert.ok(reconciliation.matches.length > 0)
    assert.deepEqual(reconciliation.matches.find((entry) => entry.matchId === pendingMatchId), {
      matchId: pendingMatchId,
      status: 'exact',
      canonicalSeriesId: 'official-match\u0000official-pending',
      scoredGameIds: ['official-game-pending'],
    })
    assert.ok(retrySource.importedMatches.length > 0)
    assert.equal((parent.state as { pending: Record<string, unknown> }).pending[pendingMatchId], undefined)

    const metadataOutput = join(root, 'metadata-reconciliation.json')
    const metadataSource = structuredClone(retrySource)
    metadataSource.externalSources = [{
      name: 'retry metadata', kind: 'static-metadata', description: 'metadata-only reconciliation fixture',
      status: 'active', retrievedAt: '2026-07-22T00:00:00.000Z', coverageStart: '2026-01-01', coverageEnd: '2026-01-05', rowCount: 1,
    }]
    const metadata = await buildRankingIncrementally({
      mode: 'gated', cause: 'pending-match', enabled: true,
      sourceData: metadataSource,
      restored: published,
      generatedAt: '2026-07-22T00:00:00.000Z',
      manifestPath: join(root, 'unused-metadata-manifest.json'),
      output: join(root, 'metadata-full.json'),
      publicDataDir: join(root, 'metadata-public'),
      reconciliationOutput: metadataOutput,
      silent: true,
    })
    assert.equal(metadata.metrics.classification, 'metadata-only')
    const metadataReconciliation = JSON.parse(await readFile(metadataOutput, 'utf8')) as { matches: Array<{ matchId: string }> }
    assert.equal(metadataReconciliation.matches.some((entry) => entry.matchId === pendingMatchId), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('daily audit compares corpus authority across refreshed receipt identities without hiding state drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incremental-audit-receipt-identity-'))
  try {
    const source = fixtureSource(baseMatches())
    const baseline = await run(root, 'receipt-baseline', source, {
      mode: 'gated', cause: 'daily-audit', enabled: true, sourceReceiptDigest: 'a'.repeat(64),
    })
    const restored = restoreFrom(baseline)
    const clean = await run(root, 'receipt-refresh', source, {
      mode: 'gated', cause: 'daily-audit', enabled: true, restored, sourceReceiptDigest: 'b'.repeat(64),
    })
    assert.equal(clean.action, 'publish-full')
    assert.equal(clean.metrics.parity, true)
    assert.equal(clean.metrics.stateParity, true)
    assert.equal(clean.metrics.stateParityReport?.sourceReceiptEqual, false)
    assert.equal(clean.metrics.stateParityReport?.checkpointEqual, true)
    assert.equal(clean.state.sourceReceiptDigest, 'b'.repeat(64))
    assert.equal(clean.metrics.stateParityReport?.mismatchPaths.includes('$.sourceReceiptDigest'), false)

    const corrupt = structuredClone(restored)
    corrupt.checkpoints[0].bundle.ratingCheckpoint = {
      ...(corrupt.checkpoints[0].bundle.ratingCheckpoint as Record<string, unknown>),
      injectedStateMismatch: true,
    }
    const mismatch = await run(root, 'receipt-state-mismatch', source, {
      mode: 'gated', cause: 'daily-audit', enabled: true, restored: corrupt, sourceReceiptDigest: 'c'.repeat(64),
    })
    assert.equal(mismatch.action, 'publish-full')
    assert.equal(mismatch.metrics.stateParity, false)
    assert.equal(mismatch.metrics.stateParityReport?.checkpointEqual, false)
    assert.ok(mismatch.metrics.stateParityReport?.mismatchPaths.some((path) => path.includes('injectedStateMismatch')))
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
      assert.equal(outcomeForBuild(incremental), incremental.metrics.classification)
      assert.equal(incremental.metrics.fullSnapshotWritten, false, name)
      assert.ok(incremental.metrics.replayedMatchCount > 0, name)
      const full = await run(root, `${name}-full`, source, { mode: 'gated', cause: 'daily-audit', enabled: false })
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
    assert.equal(shadow.metrics.parity, false)
    assert.equal(shadow.metrics.semanticParityReport?.equal, true)
    assert.equal(shadow.metrics.stateParity, false)
    assert.equal(shadow.metrics.stateParityReport?.checkpointEqual, false)
    assert.equal(shadow.diagnostic?.reason, 'checkpoint-state-parity-mismatch')
    const shadowFull = await run(root, 'shadow-authority', appended, { mode: 'gated', cause: 'daily-audit', enabled: false })
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
    assert.equal(outcomeForBuild(mismatch), 'parity-failure')
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
    const full = await run(root, 'tournament-transition-full', transitioned, { mode: 'gated', cause: 'daily-audit', enabled: false })
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

test('a correction can be promoted and followed by an append without losing predecessor checkpoint authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incremental-correction-append-'))
  try {
    const baseline = await run(root, 'sequence-base', fixtureSource(baseMatches()), { mode: 'gated', cause: 'daily-audit', enabled: true })
    const baselineAuthority = restoreFrom(baseline)
    const correctedMatches = baseMatches().map((entry) => entry.id === 'm3' ? { ...entry, winner: 'Beta' } : entry)
    const corrected = await run(root, 'sequence-correction', fixtureSource(correctedMatches), {
      mode: 'gated', cause: 'pending-match', enabled: true, restored: baselineAuthority,
    })
    assert.equal(corrected.action, 'publish-incremental', corrected.metrics.fallbackReason)
    const correctedAuthority = restoreIncremental(baselineAuthority, corrected)
    const appendedSource = fixtureSource([...correctedMatches, match('m5', '2026-01-05', 'Event C')])
    const appended = await run(root, 'sequence-append', appendedSource, {
      mode: 'gated', cause: 'pending-match', enabled: true, restored: correctedAuthority,
    })
    assert.equal(appended.action, 'publish-incremental', appended.metrics.fallbackReason)
    const full = await run(root, 'sequence-full', appendedSource, { mode: 'gated', cause: 'daily-audit', enabled: false })
    assert.deepEqual(semanticMap(appended), semanticMap(full))
  } finally {
    if (process.env.KEEP_INCREMENTAL_TEST_TMP !== 'true') await rm(root, { recursive: true, force: true })
  }
})

test('replay lazily loads only the newest eligible predecessor checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incremental-lazy-checkpoint-'))
  try {
    const baseline = await run(root, 'lazy-base', fixtureSource(baseMatches()), { mode: 'gated', cause: 'daily-audit', enabled: true })
    const restored = restoreFrom(baseline)
    const stored = restored.checkpoints
    const requested: string[][] = []
    restored.checkpoints = []
    restored.loadCheckpoints = async (candidates = restored.stateManifest.checkpoints) => {
      requested.push(candidates.map((candidate) => `${candidate.boundary.date}/${candidate.boundary.matchId}`))
      return stored.filter((checkpoint) => candidates.some((candidate) => candidate.boundary.date === checkpoint.candidate.boundary.date
        && candidate.boundary.matchId === checkpoint.candidate.boundary.matchId))
    }
    const appended = await run(root, 'lazy-append', fixtureSource([...baseMatches(), match('m5', '2026-01-05', 'Event C')]), {
      mode: 'gated', cause: 'pending-match', enabled: true, restored,
    })
    assert.equal(appended.action, 'publish-incremental', appended.metrics.fallbackReason)
    assert.equal(requested.length, 1)
    assert.equal(requested[0]?.length, 1)
  } finally {
    if (process.env.KEEP_INCREMENTAL_TEST_TMP !== 'true') await rm(root, { recursive: true, force: true })
  }
})

test('cross-season corrections and whole-season deletion subtract extinct scope artifacts exactly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incremental-season-removal-'))
  try {
    const matches = [
      match('m-1', '2024-12-31', 'Event 2024'),
      match('m0', '2025-01-01', 'Event 2025'),
      match('m1', '2025-01-02', 'Event 2025'),
      match('m2', '2026-01-01', 'Event 2026'),
      match('m3', '2026-01-02', 'Event 2026'),
    ]
    const baseline = await run(root, 'season-base', fixtureSource(matches), { mode: 'gated', cause: 'daily-audit', enabled: true })
    const authority = restoreFrom(baseline)
    const correctedSource = fixtureSource(matches.map((entry) => entry.id === 'm1' ? { ...entry, winner: 'Beta' } : entry))
    const corrected = await run(root, 'season-correction', correctedSource, {
      mode: 'gated', cause: 'pending-match', enabled: true, restored: authority,
    })
    assert.equal(corrected.action, 'publish-incremental', corrected.metrics.fallbackReason)
    assert.ok(corrected.metrics.changedPaths.some((path) => path.startsWith('/data/scopes/') && path.includes('2026')))
    const correctionFull = await run(root, 'season-correction-full', correctedSource, { mode: 'gated', cause: 'daily-audit', enabled: false })
    assert.deepEqual(semanticMap(corrected), semanticMap(correctionFull))

    const removedSource = fixtureSource(matches.filter((entry) => entry.season !== 2025))
    const removed = await run(root, 'season-removed', removedSource, {
      mode: 'gated', cause: 'pending-match', enabled: true, restored: authority,
    })
    assert.equal(removed.action, 'publish-incremental', removed.metrics.fallbackReason)
    assert.ok(removed.metrics.removedPaths.some((path) => path.startsWith('/data/scopes/') && path.includes('2025')))
    assert.ok(removed.metrics.removedPaths.some((path) => path.startsWith('/data/matches/') && path.includes('2025')))
    const removalFull = await run(root, 'season-removed-full', removedSource, { mode: 'gated', cause: 'daily-audit', enabled: false })
    assert.deepEqual(semanticMap(removed), semanticMap(removalFull))
  } finally {
    if (process.env.KEEP_INCREMENTAL_TEST_TMP !== 'true') await rm(root, { recursive: true, force: true })
  }
})

test('match-page contraction removes obsolete trailing page objects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incremental-page-contraction-'))
  try {
    const series = Array.from({ length: 30 }, (_, index) => match(
      `series-${index + 1}`,
      `2026-01-${String(index + 1).padStart(2, '0')}`,
      'Long Event',
    ))
    const baselineMatches = [match('predecessor', '2025-12-31', 'Predecessor Event'), ...series]
    const baseline = await run(root, 'pages-base', fixtureSource(baselineMatches), { mode: 'gated', cause: 'daily-audit', enabled: true })
    const contractedSource = fixtureSource(baselineMatches.filter((entry) => entry.id === 'predecessor' || Number(entry.date.slice(-2)) <= 24))
    const contracted = await run(root, 'pages-contracted', contractedSource, {
      mode: 'gated', cause: 'pending-match', enabled: true, restored: restoreFrom(baseline),
    })
    assert.equal(contracted.action, 'publish-incremental', contracted.metrics.fallbackReason)
    assert.ok(contracted.metrics.removedPaths.filter((path) => path.includes('/matches/pages/')).some((path) => /-2\.json$/.test(path)))
    const full = await run(root, 'pages-full', contractedSource, { mode: 'gated', cause: 'daily-audit', enabled: false })
    assert.deepEqual(semanticMap(contracted), semanticMap(full))
  } finally {
    if (process.env.KEEP_INCREMENTAL_TEST_TMP !== 'true') await rm(root, { recursive: true, force: true })
  }
})

function run(
  root: string,
  name: string,
  sourceData: RankingSourceImport,
  options: { mode: 'shadow' | 'gated'; cause: string; enabled: boolean; restored?: RestoredIncrementalAuthority; buildSnapshot?: typeof buildStaticSnapshot; sourceReceiptDigest?: string },
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

function restoreIncremental(previous: RestoredIncrementalAuthority, result: IncrementalRankingBuildResult): RestoredIncrementalAuthority {
  assert.equal(result.action, 'publish-incremental')
  if (result.action !== 'publish-incremental') throw new Error('incremental result required')
  const artifacts = { ...previous.artifacts }
  for (const path of result.patch.removedLogicalPaths) delete artifacts[path]
  for (const artifact of result.patch.changedArtifacts) artifacts[artifact.logicalPath] = artifact.value
  const rootArtifact = artifacts['/data/ranking-summary.json'] as Record<string, unknown>
  const artifactMeta = rootArtifact.artifactMeta as { runId: string }
  const entries = Object.entries(artifacts).map(([logicalPath, value]) => {
    const prepared = prepareSemanticArtifact(value)
    return { logicalPath, digest: prepared.digest, bytes: prepared.bytes }
  })
  const priorByBoundary = new Map(previous.checkpoints.map((checkpoint) => [
    `${checkpoint.candidate.boundary.date}\u0000${checkpoint.candidate.boundary.matchId}`,
    checkpoint,
  ]))
  const checkpoints = result.state.checkpoints.map((checkpoint, index) => {
    const key = `${checkpoint.boundary.date}\u0000${checkpoint.boundary.matchId}`
    const prior = priorByBoundary.get(key)
    if (checkpoint.storedObjectReference && prior) return { candidate: { boundary: checkpoint.boundary, rawPrefix: checkpoint.rawPrefix, object: checkpoint.storedObjectReference }, bundle: prior.bundle }
    const digest = String(index + 1).padStart(64, 'c').slice(-64)
    const object = checkpoint.storedObjectReference ?? { key: `state/objects/sha256/${digest}`, sha256: digest, bytes: 1, compressedBytes: 1, storageEncoding: 'gzip' as const }
    return {
      candidate: { boundary: checkpoint.boundary, rawPrefix: checkpoint.rawPrefix, object },
      bundle: { artifactKind: 'incremental-state-checkpoint-bundle', schemaVersion: 1, boundary: checkpoint.boundary, rawPrefix: checkpoint.rawPrefix, compatibility: result.state.compatibility, ratingCheckpoint: checkpoint.ratingCheckpoint, causalSummaries: checkpoint.causalSummaries },
    }
  })
  return {
    stateManifest: {
      artifactKind: 'incremental-state-generation-manifest', schemaVersion: 1, storageMode: 'content-addressed-state-gzip-v1',
      generationId: artifactMeta.runId, runId: artifactMeta.runId, baseGenerationId: previous.stateManifest.generationId,
      baseRunId: previous.stateManifest.runId, canonicalLedger: previous.stateManifest.canonicalLedger,
      sourceReceiptDigest: result.state.sourceReceiptDigest, compatibility: result.state.compatibility,
      checkpoints: checkpoints.map((checkpoint) => checkpoint.candidate),
    },
    canonicalLedger: result.state.ledger, checkpoints,
    publicManifest: createGenerationManifest({ generationId: artifactMeta.runId, rootManifest: rootArtifact, entries }),
    rootArtifact, artifacts,
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

function outcomeForBuild(result: IncrementalRankingBuildResult) {
  return normalizeRankingRefreshOutcome({
    sourceResult: result.action === 'no-change' ? 'unchanged' : 'completed',
    providerStatus: 'usable',
    force: false,
    rawRecoveryAuthorized: false,
    verifiedRawAuthority: false,
    dataMode: result.sourceData.dataMode,
    rankingChangeKind: result.metrics.classification,
    buildAction: result.action,
    parity: result.metrics.parity,
    fallbackReason: result.metrics.fallbackReason
      ?? (result.action === 'no-change' ? null : result.diagnostic?.reason ?? null),
  }).outcome
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

function sourcedPlayerMatchesWithSubstitutionAndCorrection(): MatchRecord[] {
  return Array.from({ length: 25 }, (_, index) => {
    const day = String(index + 1).padStart(2, '0')
    const entry = match(`player-${day}`, `2026-01-${day}`, 'Player Event')
    const winner = index % 2 === 0 ? 'Alpha' : 'Beta'
    return {
      ...entry,
      winner,
      teamARoster: sourcedRoster('alpha', 'blue', winner === 'Alpha', entry.date, {
        ...(index === 10 ? { Mid: { kills: 18 } } : {}),
      }),
      teamBRoster: sourcedRoster('beta', 'red', winner === 'Beta', entry.date, {}, {
        ...(index === 24 ? { Bot: 'beta-sub-Bot' } : {}),
      }),
    }
  })
}

function containsReference(value: unknown, references: ReadonlySet<unknown>, visited = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return false
  if (references.has(value)) return true
  if (visited.has(value)) return false
  visited.add(value)
  return Object.values(value).some((entry) => containsReference(entry, references, visited))
}

function sourcedRoster(
  prefix: string,
  side: Side,
  won: boolean,
  observedAt: string,
  statOverrides: Partial<Record<Role, { kills?: number }>> = {},
  idOverrides: Partial<Record<Role, string>> = {},
): MatchRosterSnapshot {
  const roles: Role[] = ['Top', 'Jungle', 'Mid', 'Bot', 'Support']
  return {
    sourceProvider: 'oracles-elixir',
    teamId: prefix,
    observedAt,
    completeness: 'complete-five-role',
    players: roles.map((role) => ({
      id: idOverrides[role] ?? `${prefix}-${role}`,
      name: idOverrides[role] ?? `${prefix} ${role}`,
      role,
      stats: {
        side,
        won,
        kills: statOverrides[role]?.kills ?? (won ? 4 : 2),
        deaths: won ? 2 : 4,
        assists: won ? 9 : 5,
        damageShare: 0.2,
        earnedGoldShare: 0.2,
        vspm: role === 'Support' ? 2.2 : 1,
      },
    })),
  }
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
