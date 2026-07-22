import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { MatchRecord, TeamProfile } from '../src/types'
import { buildRankingIncrementally, type IncrementalRankingBuildResult, type RestoredIncrementalAuthority } from './incremental-ranking-orchestrator.ts'
import { createGenerationManifest, prepareSemanticArtifact } from './public-artifact-storage.mjs'
import type { RankingSourceImport } from './ranking-source-import.ts'

const targets = { computeMs: 15_000, peakRssBytes: 750 * 1024 * 1024, uploadedBytes: 2 * 1024 * 1024, fullSnapshotWritten: false }
const teams: Record<string, TeamProfile> = {
  Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
  Beta: { name: 'Beta', code: 'BET', region: 'LCK', league: 'LCK' },
  Gamma: { name: 'Gamma', code: 'GAM', region: 'LPL', league: 'LPL' },
  Delta: { name: 'Delta', code: 'DEL', region: 'LPL', league: 'LPL' },
}
const root = await mkdtemp(join(tmpdir(), 'incremental-ranking-benchmark-'))
try {
  const baselineSource = fixtureSource(generateMatches(500))
  const baseline = await run('baseline', baselineSource, { mode: 'gated', cause: 'daily-audit', enabled: true })
  const restored = restoreFrom(baseline)
  const nextSource = fixtureSource([...baselineSource.matches, match(501)])
  const started = performance.now()
  const incremental = await run('incremental', nextSource, { mode: 'gated', cause: 'pending-match', enabled: true, restored })
  const computeMs = performance.now() - started
  const full = await run('full', nextSource, { mode: 'legacy', cause: 'daily-audit', enabled: false })
  if (incremental.action !== 'publish-incremental' || full.action === 'no-change') throw new Error('Benchmark did not exercise the incremental fast path')
  const parity = JSON.stringify(semanticMap(incremental)) === JSON.stringify(semanticMap(full))
  const unique = new Map<string, number>()
  for (const artifact of incremental.patch?.changedArtifacts ?? []) {
    const prepared = prepareSemanticArtifact(artifact.value)
    unique.set(prepared.digest, prepared.compressedBytes)
  }
  const uploadedBytes = [...unique.values()].reduce((sum, bytes) => sum + bytes, 0)
    + gzipSync(Buffer.from(JSON.stringify(incremental.patch?.expectedLogicalPaths ?? []))).byteLength
  const peakRssBytes = Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024)
  const pass = computeMs < targets.computeMs
    && peakRssBytes < targets.peakRssBytes
    && uploadedBytes < targets.uploadedBytes
    && incremental.metrics.fullSnapshotWritten === targets.fullSnapshotWritten
    && parity
  const output = {
    computeMs: Math.round(computeMs), peakRssBytes, uploadedBytes, objectCount: unique.size + 1,
    fullSnapshotWritten: incremental.metrics.fullSnapshotWritten,
    changedPaths: incremental.metrics.changedPaths.length,
    reusedPaths: incremental.metrics.reusedPaths.length,
    parity,
    target: { computeMs: '<15000', peakRssBytes: '<786432000', uploadedBytes: '<2097152', fullSnapshotWritten: false, parity: true },
    pass,
  }
  process.stdout.write(`${JSON.stringify(output)}\n`)
  if (process.argv.includes('--enforce-targets') && !pass) process.exitCode = 1
} finally {
  await rm(root, { recursive: true, force: true })
}

function run(name: string, sourceData: RankingSourceImport, options: { mode: 'legacy' | 'shadow' | 'gated'; cause: string; enabled: boolean; restored?: RestoredIncrementalAuthority }) {
  return buildRankingIncrementally({
    ...options, sourceData, silent: true, generatedAt: '2026-07-22T00:00:00.000Z',
    manifestPath: join(root, 'unused.json'), output: join(root, `${name}.full.json`), publicDataDir: join(root, `${name}-public`),
  })
}

function restoreFrom(result: IncrementalRankingBuildResult): RestoredIncrementalAuthority {
  if (result.action === 'no-change') throw new Error('Benchmark baseline did not build')
  if (!result.build) throw new Error('Benchmark baseline materialization is missing')
  const rootManifest = result.build.publicPlan.manifest as Record<string, unknown>
  const generationId = (rootManifest.artifactMeta as { runId: string }).runId
  const entries = result.build.publicPlan.writes.map((write) => {
    const artifact = prepareSemanticArtifact(write.value)
    return { logicalPath: `/data/${write.relativePath}`, digest: artifact.digest, bytes: artifact.bytes }
  })
  const checkpoints = result.state.checkpoints.map((checkpoint) => ({
    candidate: {
      boundary: checkpoint.boundary, rawPrefix: checkpoint.rawPrefix,
      object: { key: `state/objects/sha256/${'a'.repeat(64)}`, sha256: 'a'.repeat(64), bytes: 1, compressedBytes: 1, storageEncoding: 'gzip' as const },
    },
    bundle: { ratingCheckpoint: checkpoint.ratingCheckpoint, causalSummaries: checkpoint.causalSummaries },
  }))
  return {
    stateManifest: {
      artifactKind: 'incremental-state-generation-manifest', schemaVersion: 1, storageMode: 'content-addressed-state-gzip-v1',
      generationId, runId: generationId, baseGenerationId: null, baseRunId: null,
      canonicalLedger: { key: `state/objects/sha256/${'b'.repeat(64)}`, sha256: 'b'.repeat(64), bytes: 1, compressedBytes: 1, storageEncoding: 'gzip' },
      sourceReceiptDigest: result.state.sourceReceiptDigest, compatibility: result.state.compatibility,
      checkpoints: checkpoints.map((checkpoint) => checkpoint.candidate),
    },
    canonicalLedger: result.state.ledger, checkpoints, publicManifest: createGenerationManifest({ generationId, rootManifest, entries }), rootArtifact: rootManifest,
  }
}

function semanticMap(result: Exclude<IncrementalRankingBuildResult, { action: 'no-change' }>) {
  if (!result.build) throw new Error('Benchmark build is missing')
  return Object.fromEntries(result.build.publicPlan.writes.map((write) => [write.relativePath, prepareSemanticArtifact(write.value).digest]))
}

function fixtureSource(matches: MatchRecord[]): RankingSourceImport {
  return { manifest: { generatedAt: '2026-07-22T00:00:00.000Z', files: {} }, importedMatches: matches, matches, teams, mergedTeams: teams,
    source: 'deterministic benchmark fixture', dataMode: 'scheduled-public-data', externalSources: [], tournamentScheduleReferences: [] }
}
function generateMatches(count: number) { return Array.from({ length: count }, (_, index) => match(index + 1)) }
function match(index: number): MatchRecord {
  const date = new Date(Date.UTC(2024, 0, 1 + Math.floor((index - 1) / 2))).toISOString().slice(0, 10)
  const left = index % 2 ? 'Alpha' : 'Gamma'
  const right = index % 2 ? 'Beta' : 'Delta'
  return {
    id: `m${index}`, sourceProvider: 'oracles-elixir', sourceGameId: `m${index}`, sourceMatchId: `series-${index}`,
    date, datetimeUtc: `${date}T${String(index % 24).padStart(2, '0')}:00:00.000Z`, season: Number(date.slice(0, 4)),
    event: `Season ${date.slice(0, 4)}`, phase: 'Regular season', region: index % 2 ? 'LCK' : 'LPL', league: index % 2 ? 'LCK' : 'LPL',
    patch: '26.1', bestOf: 1, tier: 'regional-regular', teamA: left, teamB: right,
    winner: index % 3 ? left : right, teamAKills: index % 3 ? 10 : 5, teamBKills: index % 3 ? 5 : 10,
    teamAGold: index % 3 ? 60_000 : 55_000, teamBGold: index % 3 ? 55_000 : 60_000,
  }
}
