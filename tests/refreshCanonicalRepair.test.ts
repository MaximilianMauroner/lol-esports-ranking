import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { buildStaticSnapshot } from '../scripts/build-static-snapshot.ts'
import { canonicalJsonFor, createGenerationManifest, prepareSemanticArtifact } from '../scripts/public-artifact-storage.mjs'
import type { BucketClient, BucketConfig } from '../scripts/railway-bucket.mjs'

const refreshScript: string = '../scripts/refresh-data-if-changed.mjs'
const { refreshDataIfChanged } = await import(refreshScript) as {
  refreshDataIfChanged: (args: string[], options: {
    env: Record<string, string>
    bucketConfig: BucketConfig
    bucketClient: BucketClient
    readActiveRawSourceAuthority: () => Promise<{ found: false }>
    run: (command: string, args: string[]) => Promise<void>
    uploadRankingArtifacts: (options: {
      publicDataDir: string
      generationId?: string
      stateManifestAuthority?: { key: string; digest: string }
    }) => Promise<Record<string, unknown>>
  }) => Promise<{ changed: boolean; status?: string; incrementalAction?: string }>
}

for (const repair of ['partial publication', 'missing marker'] as const) {
  test(`canonical equality permits a safe skip but cannot conceal ${repair}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'refresh-canonical-repair-'))
    const rawDir = join(root, 'raw')
    const publicDataDir = join(root, 'public')
    const bucketDir = join(root, 'bucket')
    const statePath = join(rawDir, 'refresh-state.json')
    const config: BucketConfig = {
      enabled: true, bucket: 'fixture', prefix: 'rankings', region: 'auto',
      endpoint: 'http://fixture.invalid', accessKeyId: 'fixture', secretAccessKey: 'fixture',
    }
    const objects = new Map<string, {
      bytes: Buffer; etag: string; metadata?: Record<string, string>; encoding?: string; contentType?: string
    }>()
    const client = {
      async send(command: unknown) {
        if (command instanceof PutObjectCommand) {
          const input = command.input
          assert.ok(typeof input.Body === 'string' || input.Body instanceof Uint8Array)
          const bytes = Buffer.from(input.Body)
          const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`
          objects.set(String(input.Key), { bytes, etag, metadata: input.Metadata, encoding: input.ContentEncoding, contentType: input.ContentType })
          return { ETag: etag }
        }
        assert.ok(command instanceof GetObjectCommand || command instanceof HeadObjectCommand)
        const object = objects.get(String(command.input.Key))
        if (!object) throw Object.assign(new Error('Missing fixture object'), { name: 'NoSuchKey' })
        return { Body: object.bytes, ETag: object.etag, ContentLength: object.bytes.length, Metadata: object.metadata, ContentEncoding: object.encoding, ContentType: object.contentType }
      },
    }
    let source = 'A'
    let ignoredColumn = 'one'
    let failPublication = false
    let publications = 0
    async function refresh(incremental = true) {
      return refreshDataIfChanged([
        '--raw-dir', rawDir, '--manifest', join(rawDir, 'manifest.json'), '--state', statePath,
        '--staging-dir', join(root, 'staging'), '--output', join(root, 'full.json'), '--public-data-dir', publicDataDir,
        '--start', '2026-01-01', '--end', '2026-06-29',
      ], {
        env: { RANKING_BUCKET_RESTORE_RAW: 'false', RANKING_RAW_SOURCE_WORKER: 'node',
          ...(incremental ? { RANKING_REFRESH_FENCING_TOKEN: '7' } : {}) },
        bucketConfig: config,
        bucketClient: client,
        readActiveRawSourceAuthority: async () => ({ found: false }),
        run: async (command, args) => {
          if (args.includes('scripts/download-local-data.mjs')) {
            const csv = join(argument(args, '--out-dir'), '2026.csv')
            await writeFile(csv, [
              'gameid,date,year,league,split,playoffs,patch,position,side,teamname,result,kills,totalgold,ignored',
              `fixture-game,2026-06-29,2026,LCK,Summer,0,26.13,team,Blue,Gen.G,${source === 'A' ? 1 : 0},18,65000,${ignoredColumn}`,
              `fixture-game,2026-06-29,2026,LCK,Summer,0,26.13,team,Red,T1,${source === 'A' ? 0 : 1},10,58000,${ignoredColumn}`,
            ].join('\n'))
            await writeFile(argument(args, '--manifest'), JSON.stringify({
              schemaVersion: 1, start: '2026-01-01', end: '2026-06-29', generatedAt: '2026-06-29T00:00:00.000Z',
              files: { oracleCsv: [csv], leaguepediaJson: [], lolEsportsJson: [] },
              sources: { oracle: { status: 'downloaded', downloadedCount: 1 } }, warnings: [],
            }))
            return
          }
          assert.equal(command, 'pnpm')
          assert.ok(args.includes('scripts/build-static-snapshot.ts'))
          await buildStaticSnapshot({ manifestPath: argument(args, '--manifest'), output: argument(args, '--output'),
            publicDataDir, env: {}, silent: true })
        },
        uploadRankingArtifacts: async (options) => {
          publications += 1
          await mkdir(bucketDir, { recursive: true })
          if (failPublication) {
            await cp(join(options.publicDataDir, 'ranking-summary.json'), join(bucketDir, 'ranking-summary.json'))
            throw new Error('Partial mutable publication')
          }
          await cp(options.publicDataDir, bucketDir, { recursive: true })
          if (publications === 1) {
            assert.ok(options.generationId && options.stateManifestAuthority)
            const rootManifest = JSON.parse(await readFile(join(options.publicDataDir, 'ranking-summary.json'), 'utf8'))
            const artifact = prepareSemanticArtifact(rootManifest)
            await client.send(new PutObjectCommand({
              Bucket: config.bucket, Key: `rankings/objects/sha256/${artifact.digest}`, Body: artifact.compressed, ContentEncoding: 'gzip',
              Metadata: { sha256: artifact.digest, 'semantic-bytes': String(artifact.bytes), encoding: 'gzip' },
            }))
            const manifestBytes = Buffer.from(canonicalJsonFor({
              ...createGenerationManifest({ generationId: options.generationId, rootManifest,
                entries: [{ logicalPath: '/data/ranking-summary.json', digest: artifact.digest, bytes: artifact.bytes }] }),
              schemaVersion: 1,
            }))
            const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex')
            const manifestKey = `rankings/generations/${options.generationId}/manifest.json`
            const stored = await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: manifestKey, Body: manifestBytes, Metadata: { sha256: manifestDigest } }))
            await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: 'rankings/active-generation.json', Body: JSON.stringify({
              generationId: options.generationId, storageMode: 'content-addressed-gzip-v1', manifestKey, manifestDigest,
              manifestBytes: manifestBytes.length, manifestEtag: stored.ETag,
              stateManifestKey: options.stateManifestAuthority.key, stateManifestDigest: options.stateManifestAuthority.digest,
            }) }))
          }
          return {
            enabled: true, bucket: config.bucket, prefix: config.prefix, uploaded: [], unchanged: [], skipped: [],
            artifactCount: 0, uploadedCount: 0, uploadedBytes: 0, unchangedCount: 0, unchangedBytes: 0,
          }
        },
      })
    }
    try {
      assert.equal((await refresh()).changed, true)
      const publishedA = await readFile(join(bucketDir, 'ranking-summary.json'), 'utf8')
      ignoredColumn = 'two'
      assert.equal((await refresh()).status, 'canonical-no-change')
      assert.equal(publications, 1)
      assert.equal(await readFile(join(bucketDir, 'ranking-summary.json'), 'utf8'), publishedA)

      if (repair === 'partial publication') {
        source = 'B'
        failPublication = true
        await assert.rejects(refresh(false), /Partial mutable publication/)
        assert.notEqual(await readFile(join(bucketDir, 'ranking-summary.json'), 'utf8'), publishedA)
        source = 'A'
        failPublication = false
      } else {
        const state = JSON.parse(await readFile(statePath, 'utf8'))
        delete state.publishedFingerprint
        await writeFile(statePath, JSON.stringify(state))
      }
      const beforeRepair = publications
      const result = await refresh()
      assert.equal(result.changed, true)
      assert.equal(result.incrementalAction, 'publish-full')
      assert.equal(publications, beforeRepair + 1)
      assert.equal(await readFile(join(bucketDir, 'ranking-summary.json'), 'utf8'),
        await readFile(join(publicDataDir, 'ranking-summary.json'), 'utf8'))
      assert.equal((await refresh()).changed, false)
      assert.equal(publications, beforeRepair + 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

function argument(args: string[], flag: string) {
  const index = args.indexOf(flag)
  assert.notEqual(index, -1)
  return args[index + 1]
}
