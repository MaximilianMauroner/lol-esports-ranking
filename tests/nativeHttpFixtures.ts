import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { canonicalJsonFor, createGenerationManifest, prepareSemanticArtifact } from '../scripts/public-artifact-storage.mjs'
import { parsePublicRankingManifest, parsePublicRankingShard, PUBLIC_ARTIFACT_SCHEMA_VERSION } from '../src/domains/rankings/internal/published/schema.ts'

export function syntheticArtifacts() {
  const schemaVersion = PUBLIC_ARTIFACT_SCHEMA_VERSION
  const generatedAt = '2026-10-17T00:00:00.000Z'
  const model = { version: 'synthetic-http-model', configHash: 'synthetic-http-config' }
  const artifactMeta = { schemaVersion, runId: 'synthetic-native-http', generatedAt, modelVersion: model.version, modelConfigHash: model.configHash }
  const filter = { season: 'All', event: 'All', region: 'All' }
  const ratingScale = {
    version: 'synthetic-scale', internalAnchor: 1500, publishedAnchor: 1800, spreadMultiplier: 3.25,
    publishedMinimum: 1000, publishedMaximum: 3000, label: 'Power Index', shortLabel: 'Power', description: 'Synthetic HTTP fixture scale.',
  }
  const shard = parsePublicRankingShard({
    artifactKind: 'public-snapshot-shard', artifactMeta, ratingScale, filter,
    modelVersion: model.version, modelConfigHash: model.configHash, matchCount: 0,
    sourceBreakdown: [], scoreFamilies: [], standings: [], leagues: [], regions: [],
  })
  const manifest = parsePublicRankingManifest({
    artifactKind: 'public-ranking-manifest', schemaVersion, artifactMeta, summaryMode: 'browser-summary', ratingScale,
    generatedAt, source: 'Synthetic native HTTP fixture', dataMode: 'seeded-sample', model,
    coverage: {}, dataQuality: {}, sources: [{ name: 'Synthetic fixture', kind: 'seed', description: 'Transport proof only.', status: 'reference-only' }],
    playerData: { metric: {} }, walkForward: {}, filterOptions: { seasons: ['All'], events: ['All'], regions: ['All'] },
    defaultFilter: filter, defaultSnapshotKey: 'All__All__All', tournamentMovementIndexUrl: '/data/history/tournament-moves/index.json', teamCount: 0,
    snapshotIndex: { All__All__All: { url: '/data/scopes/all.json', filter, matchCount: 0, sourceBreakdown: [] } },
  })
  return { manifest, shard }
}

export async function writeSyntheticArtifacts(root: string, generation: boolean) {
  const { manifest, shard } = syntheticArtifacts()
  const files = [
    { logicalPath: '/data/ranking-summary.json', value: manifest },
    { logicalPath: '/data/scopes/all.json', value: shard },
    { logicalPath: manifest.tournamentMovementIndexUrl, value: { artifactKind: 'synthetic-unread-tournament-index' } },
  ]
  const prepared = files.map(({ logicalPath, value }) => ({ logicalPath, artifact: prepareSemanticArtifact(value, { compress: false }) }))
  const write = async (path: string, bytes: string | Buffer) => {
    const file = join(root, path.replace(/^\/data\//, ''))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, bytes)
  }
  for (const file of files) await write(file.logicalPath, JSON.stringify(file.value))
  if (generation) {
    for (const { artifact } of prepared) {
      await write(`/data/objects/sha256/${artifact.digest}`, artifact.canonicalBytes)
      for (const child of artifact.children) await write(`/data/objects/sha256/${child.digest}`, child.canonicalBytes)
    }
    const index = createGenerationManifest({ generationId: manifest.artifactMeta.runId, rootManifest: manifest, entries: prepared.map(({ logicalPath, artifact }) => ({ logicalPath, digest: artifact.digest, bytes: artifact.bytes })) })
    await write('/data/ranking-summary.json', canonicalJsonFor(index))
  }
  return { manifest, shard, prepared }
}
