import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildPublicArtifactDag,
  validatePersistedArtifactNodes,
  type PersistedArtifactNode,
} from '../src/lib/incremental/artifactDag.ts'
import { assertCrunchParity } from '../src/lib/incremental/parity.ts'
import { createIncrementalSnapshotModelProvider } from '../src/lib/incremental/snapshotInputs.ts'
import {
  createPublicArtifactWritePlan,
  createSemanticPublicArtifactWritePlan,
} from '../src/lib/publicArtifacts/writePlan.ts'
import { createStaticRankingData } from '../src/lib/snapshot.ts'
import {
  fixedIncrementalFixture,
  mutateIncrementalFixture,
  type IncrementalFixture,
  type IncrementalMutation,
} from './fixtures/incrementalRankingFixtures.ts'

test('incremental state-at-date provider preserves full and public parity without direct model builds', () => {
  const fixture = fixedIncrementalFixture()
  const runMetadata = { generatedAt: '2026-05-10T18:00:00.000Z', runId: 'phase4-state-at-date' }
  const common = snapshotInput(fixture, runMetadata)
  const reference = createStaticRankingData(common)
  const provider = createIncrementalSnapshotModelProvider({ compatibilityHash: 'phase4-test' })
  const candidate = createStaticRankingData({ ...common, modelProvider: provider })
  const referencePlan = createPublicArtifactWritePlan(reference, { runMetadata })
  const candidatePlan = createPublicArtifactWritePlan(candidate, { runMetadata })
  assertCrunchParity(
    { fullSnapshot: reference, publicWrites: referencePlan.writes },
    { fullSnapshot: candidate, publicWrites: candidatePlan.writes },
  )
  const metrics = provider.metrics()
  assert.equal(metrics.directRankingBuilds, 0)
  assert.equal(metrics.directPlayerBuilds, 0)
  assert.ok(metrics.rankingRequests > 3)
  assert.ok(metrics.rankingReducerRuns <= metrics.rankingRequests)
  assert.equal(metrics.rankingReducerRuns + metrics.rankingResultCacheHits, metrics.rankingRequests)
  assert.equal(metrics.playerReducerRuns + metrics.playerResultCacheHits, metrics.playerRequests)
  assert.ok(metrics.rankingRows > 0)
})

test('state-at-date provider preserves parity across append, correction, identity, and tournament changes', () => {
  const mutations: IncrementalMutation[] = ['append', 'correction', 'identity-change', 'tournament-completion']
  for (const mutation of mutations) {
    const fixture = mutateIncrementalFixture(fixedIncrementalFixture(), mutation)
    const runMetadata = { generatedAt: '2026-05-20T18:00:00.000Z', runId: `phase4-${mutation}` }
    const common = snapshotInput(fixture, runMetadata)
    const reference = createStaticRankingData(common)
    const provider = createIncrementalSnapshotModelProvider({ compatibilityHash: `phase4-${mutation}` })
    const candidate = createStaticRankingData({ ...common, modelProvider: provider })
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
    assert.equal(provider.metrics().directRankingBuilds, 0, mutation)
    assert.equal(provider.metrics().directPlayerBuilds, 0, mutation)
  }
})

test('artifact DAG has exact no-change and metadata-only envelope behavior', () => {
  const fixture = fixedIncrementalFixture()
  const firstRun = { generatedAt: '2026-05-10T18:00:00.000Z', runId: 'phase4-envelope-a' }
  const secondRun = { generatedAt: '2026-05-10T19:00:00.000Z', runId: 'phase4-envelope-b' }
  const provider = createIncrementalSnapshotModelProvider({ compatibilityHash: 'phase4-metadata-only' })
  const firstData = createStaticRankingData({ ...snapshotInput(fixture, firstRun), modelProvider: provider })
  const reducerMetrics = provider.metrics()
  const secondData = createStaticRankingData({ ...snapshotInput(fixture, secondRun), modelProvider: provider })
  const metadataMetrics = provider.metrics()
  assert.equal(metadataMetrics.rankingReducerRuns, reducerMetrics.rankingReducerRuns)
  assert.equal(metadataMetrics.playerReducerRuns, reducerMetrics.playerReducerRuns)
  assert.equal(metadataMetrics.rankingRows, reducerMetrics.rankingRows)
  assert.equal(metadataMetrics.playerRows, reducerMetrics.playerRows)
  const first = requiredDag(buildPublicArtifactDag({
    actual: createPublicArtifactWritePlan(firstData, { runMetadata: firstRun }),
    semantic: createSemanticPublicArtifactWritePlan(firstData),
  }))
  const metadataOnly = requiredDag(buildPublicArtifactDag({
    actual: createPublicArtifactWritePlan(secondData, { runMetadata: secondRun }),
    semantic: createSemanticPublicArtifactWritePlan(secondData),
    previous: first.cache,
  }))
  assert.equal(metadataOnly.semanticReused, metadataOnly.nodes.length)
  assert.ok(metadataOnly.regenerated > 0)

  const unchanged = requiredDag(buildPublicArtifactDag({
    actual: createPublicArtifactWritePlan(secondData, { runMetadata: secondRun }),
    semantic: createSemanticPublicArtifactWritePlan(secondData),
    previous: metadataOnly.cache,
  }))
  assert.equal(unchanged.semanticReused, unchanged.nodes.length)
  assert.equal(unchanged.envelopeReused, unchanged.nodes.length)
  assert.equal(unchanged.regenerated, 0)
  assert.deepEqual(unchanged.writes, [])
})

test('later append reuses completed prior-season, checkpoint, and tournament nodes', () => {
  const prior = priorSeasonFixture()
  const appended = structuredClone(prior)
  const template = appended.matches[0]!
  appended.matches.push({
    ...template,
    id: 'incremental-2026-append',
    sourceGameId: 'incremental-2026-append',
    date: '2026-01-10',
    season: 2026,
    event: 'LCK 2026 Regular Season',
  })
  const runMetadata = { generatedAt: '2026-05-20T18:00:00.000Z', runId: 'phase4-prior-season-reuse' }
  const priorData = createStaticRankingData(snapshotInput(prior, runMetadata))
  const appendedData = createStaticRankingData(snapshotInput(appended, runMetadata))
  const priorDag = requiredDag(buildPublicArtifactDag({
    actual: createPublicArtifactWritePlan(priorData, { runMetadata }),
    semantic: createSemanticPublicArtifactWritePlan(priorData),
  }))
  const appendedDag = requiredDag(buildPublicArtifactDag({
    actual: createPublicArtifactWritePlan(appendedData, { runMetadata }),
    semantic: createSemanticPublicArtifactWritePlan(appendedData),
    previous: priorDag.cache,
  }))
  const previousById = new Map(priorDag.cache.map((node) => [node.id, node]))
  for (const path of [
    'scopes/season-2025.json',
    'scopes/season-2025-split-2.json',
    'history/tournament-moves/msi-2025.json',
  ]) {
    const node = appendedDag.cache.find((candidate) => candidate.id === `public:${path}`)
    assert.ok(node, path)
    assert.equal(node.semanticHash, previousById.get(node.id)?.semanticHash, path)
    assert.ok(!appendedDag.writes.some((write) => write.relativePath === path), path)
  }
})

test('artifact DAG reuses completed nodes on append and rejects malformed graphs', () => {
  const base = fixedIncrementalFixture()
  const appended = mutateIncrementalFixture(base, 'append')
  const runMetadata = { generatedAt: '2026-05-10T18:00:00.000Z', runId: 'phase4-append' }
  const baseData = createStaticRankingData(snapshotInput(base, runMetadata))
  const appendedData = createStaticRankingData(snapshotInput(appended, runMetadata))
  const baseActual = createPublicArtifactWritePlan(baseData, { runMetadata })
  const baseDag = requiredDag(buildPublicArtifactDag({ actual: baseActual, semantic: createSemanticPublicArtifactWritePlan(baseData) }))
  const appendDag = requiredDag(buildPublicArtifactDag({
    actual: createPublicArtifactWritePlan(appendedData, { runMetadata }),
    semantic: createSemanticPublicArtifactWritePlan(appendedData),
    previous: baseDag.cache,
  }))
  assert.ok(appendDag.semanticReused > 0)
  assert.ok(appendDag.regenerated > 0)

  const duplicate = buildPublicArtifactDag({
    actual: { ...baseActual, writes: [...baseActual.writes, baseActual.writes[0]!] },
    semantic: createSemanticPublicArtifactWritePlan(baseData),
  })
  assert.match(duplicate.fallback?.kind === 'dependency-unknown' ? duplicate.fallback.dependency : '', /artifact-dag:duplicate/)
  const missing = buildPublicArtifactDag({
    actual: baseActual,
    semantic: { ...createSemanticPublicArtifactWritePlan(baseData), writes: [] },
  })
  assert.match(missing.fallback?.kind === 'dependency-unknown' ? missing.fallback.dependency : '', /artifact-dag:missing/)

  const cyclic: PersistedArtifactNode[] = [
    { id: 'a', kind: 'scope', semanticHash: 'a', envelopeHash: 'a', deps: ['b'] },
    { id: 'b', kind: 'scope', semanticHash: 'b', envelopeHash: 'b', deps: ['a'] },
  ]
  assert.throws(() => validatePersistedArtifactNodes(cyclic), /Artifact DAG cycle/)
})

function snapshotInput(
  fixture: IncrementalFixture,
  runMetadata: { generatedAt: string; runId: string },
) {
  return {
    matches: fixture.matches,
    teams: fixture.teams,
    rosters: {},
    runMetadata,
    source: 'phase4 fixed fixture',
    dataMode: 'scheduled-public-data' as const,
    tournamentScheduleReferences: fixture.scheduleReferences,
  }
}

function priorSeasonFixture(): IncrementalFixture {
  const fixture = fixedIncrementalFixture()
  return {
    ...fixture,
    matches: fixture.matches.map((match) => ({
      ...match,
      date: match.date.replace('2026', '2025'),
      season: 2025,
      event: match.event.replace('2026', '2025'),
    })),
    scheduleReferences: fixture.scheduleReferences.map((reference) => ({
      ...reference,
      tournamentId: reference.tournamentId?.replace('2026', '2025'),
      startTime: reference.startTime?.replace('2026', '2025'),
      date: reference.date?.replace('2026', '2025'),
      retrievedAt: reference.retrievedAt?.replace('2026', '2025'),
      coverageStart: reference.coverageStart?.replace('2026', '2025'),
      coverageEnd: reference.coverageEnd?.replace('2026', '2025'),
      state: 'completed',
      coverageEndComplete: true,
    })),
  }
}

function requiredDag(result: ReturnType<typeof buildPublicArtifactDag>) {
  assert.ok(result.dag, result.fallback?.kind === 'dependency-unknown' ? result.fallback.dependency : 'missing DAG')
  return result.dag
}
