import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { uploadContentAddressedPublicArtifactPatch, uploadContentAddressedPublicArtifacts } from '../scripts/railway-bucket.mjs'

const config = { enabled: true, bucket: 'test', endpoint: 'https://example.invalid', region: 'auto', accessKeyId: 'x', secretAccessKey: 'y', prefix: 'rankings' }

test('partial artifact patch uploads only changed hashes and composes exact complete mapping with removals', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ranking-patch-'))
  const client = memoryS3()
  try {
    await mkdir(join(dir, 'matches/pages'), { recursive: true })
    await writeFile(join(dir, 'ranking-summary.json'), JSON.stringify(root('base')))
    await writeFile(join(dir, 'stable.json'), JSON.stringify({ artifactKind: 'fixture', value: 1 }))
    await writeFile(join(dir, 'removed.json'), JSON.stringify({ artifactKind: 'fixture', value: 2 }))
    await writeFile(join(dir, 'matches/pages/all-1.json'), JSON.stringify({ artifactKind: 'fixture-page', matches: ['old'] }))
    const base = await uploadContentAddressedPublicArtifacts(client, config, dir, 'base')
    const putsBefore = client.putKeys.length
    const patch = await uploadContentAddressedPublicArtifactPatch(client, config, {
      generationId: 'next',
      previousManifest: base.manifest,
      changedArtifacts: [
        { logicalPath: '/data/ranking-summary.json', value: root('next') },
        { logicalPath: '/data/matches/pages/all-1.json', value: { artifactKind: 'fixture-page', matches: ['old', 'new'] } },
      ],
      removedLogicalPaths: ['/data/removed.json'],
      expectedLogicalPaths: ['/data/ranking-summary.json', '/data/stable.json', '/data/matches/pages/all-1.json'],
    })
    const patchArtifacts = record(patch.manifest.artifacts)
    const baseArtifacts = record(base.manifest.artifacts)
    assert.deepEqual(Object.keys(patchArtifacts).sort(), [
      '/data/matches/pages/all-1.json', '/data/ranking-summary.json', '/data/stable.json',
    ])
    assert.equal(record(patchArtifacts['/data/stable.json']).sha256, record(baseArtifacts['/data/stable.json']).sha256)
    assert.deepEqual(patch.changedLogicalPaths, ['/data/matches/pages/all-1.json', '/data/ranking-summary.json'])
    assert.deepEqual(patch.reusedLogicalPaths, ['/data/stable.json'])
    assert.deepEqual(patch.removedLogicalPaths, ['/data/removed.json'])
    assert.equal(client.putKeys.length - putsBefore, 2, 'one new semantic hash plus one immutable manifest; provenance-only root reuses its hash')
    await assert.rejects(uploadContentAddressedPublicArtifactPatch(client, config, {
      generationId: 'bad', previousManifest: base.manifest,
      changedArtifacts: [{ logicalPath: '/data/ranking-summary.json', value: root('bad') }],
      expectedLogicalPaths: ['/data/ranking-summary.json'],
    }), /Incomplete public artifact patch mapping/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

function root(runId: string) {
  return {
    artifactKind: 'public-ranking-manifest', schemaVersion: 23, generatedAt: '2026-07-22T00:00:00.000Z',
    source: 'fixture', dataMode: 'test', sources: [{ name: 'fixture' }],
    model: { version: 'model-v1', configHash: 'config-v1' }, artifactMeta: { runId },
  }
}

type Stored = { bytes: Buffer; etag: string; contentType?: string; contentEncoding?: string; metadata: Record<string, string> }
function memoryS3() {
  const objects = new Map<string, Stored>()
  const putKeys: string[] = []
  let version = 0
  return {
    objects, putKeys,
    async send(command: unknown) {
      const details = command as { constructor: { name: string }; input: Record<string, unknown> }
      const name = details.constructor.name
      const input = details.input
      const key = String(input.Key)
      if (name === 'HeadObjectCommand' || name === 'GetObjectCommand') {
        const stored = objects.get(key)
        if (!stored) throw Object.assign(new Error('missing'), { name: name === 'HeadObjectCommand' ? 'NotFound' : 'NoSuchKey' })
        return {
          Body: Readable.from([stored.bytes]), ETag: stored.etag, ContentLength: stored.bytes.byteLength,
          ContentType: stored.contentType, ContentEncoding: stored.contentEncoding, Metadata: stored.metadata,
        }
      }
      if (name === 'PutObjectCommand') {
        if (input.IfNoneMatch === '*' && objects.has(key)) throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' })
        const bytes = await bodyBytes(input.Body)
        const etag = `"${++version}"`
        const metadata = isStringRecord(input.Metadata) ? input.Metadata : {}
        objects.set(key, { bytes, etag, contentType: stringValue(input.ContentType), contentEncoding: stringValue(input.ContentEncoding), metadata })
        putKeys.push(key)
        return { ETag: etag }
      }
      throw new Error(`unsupported ${name}`)
    },
  }
}
async function bodyBytes(value: unknown) {
  if (typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value)
  const chunks: Buffer[] = []
  for await (const chunk of value as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === 'string'))
}
function stringValue(value: unknown) { return typeof value === 'string' ? value : undefined }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected record')
  return value as Record<string, unknown>
}
