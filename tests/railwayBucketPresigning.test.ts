import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import {
  PRESIGNED_URL_EXPIRY_SECONDS,
  createBucketClient,
  headBucketObject,
  parseContentAddressedObjectPath,
  preparePresignedBucketDelivery,
  presignBucketObject,
  uploadContentAddressedPublicArtifacts,
  type BucketClient,
  type BucketStorageConfig,
} from '../scripts/railway-bucket.mjs'
import { prepareSemanticArtifact } from '../scripts/public-artifact-storage.mjs'

const digest = 'a'.repeat(64)
const relativePath = `objects/sha256/${digest}`
const config: BucketStorageConfig = {
  enabled: true,
  bucket: 'test-bucket',
  endpoint: 'https://storage.example.test',
  region: 'auto',
  accessKeyId: 'access-key',
  secretAccessKey: 'secret-key',
  prefix: 'rankings',
  forcePathStyle: true,
}

test('content-addressed bucket paths are strict before any SDK or signer call', async () => {
  let sdkCalls = 0
  let signerCalls = 0
  const client: BucketClient = { async send() { sdkCalls += 1; return {} } }
  const signer = async () => { signerCalls += 1; return 'https://storage.example.test/signed' }
  const invalid = [
    `objects/sha256/${'A'.repeat(64)}`,
    `objects/sha256/${digest}.json`,
    `objects/sha256/${digest}/suffix`,
    `objects/sha256/%61${'a'.repeat(62)}`,
    `objects/sha256/../${digest}`,
    `../objects/sha256/${digest}`,
    `objects//sha256/${digest}`,
  ]

  assert.deepEqual(parseContentAddressedObjectPath(relativePath), { path: relativePath, sha256: digest })
  for (const path of invalid) {
    assert.throws(() => parseContentAddressedObjectPath(path), /Invalid content-addressed/)
    await assert.rejects(headBucketObject(path, { config, client }), /Invalid content-addressed/)
    await assert.rejects(presignBucketObject(path, { config, client, signer }), /Invalid content-addressed/)
  }
  assert.equal(sdkCalls, 0)
  assert.equal(signerCalls, 0)
})

test('bucket HEAD maps immutable metadata without reading a body', async () => {
  let commandName = ''
  const lastModified = new Date('2026-07-22T12:00:00.000Z')
  const client: BucketClient = {
    async send(command) {
      commandName = commandConstructorName(command)
      return {
        ContentLength: 70_000,
        ContentType: 'application/json; charset=utf-8',
        ContentEncoding: 'gzip',
        CacheControl: 'public, max-age=31536000, immutable',
        Metadata: { sha256: digest, 'semantic-bytes': '140000', encoding: 'gzip' },
        ETag: '"etag"',
        LastModified: lastModified,
      }
    },
  }

  const result = await headBucketObject(relativePath, { config, client })
  assert.equal(commandName, 'HeadObjectCommand')
  assert.deepEqual(result, {
    found: true,
    key: `rankings/${relativePath}`,
    contentLength: 70_000,
    contentType: 'application/json; charset=utf-8',
    contentEncoding: 'gzip',
    cacheControl: 'public, max-age=31536000, immutable',
    metadata: { sha256: digest, 'semantic-bytes': '140000', encoding: 'gzip' },
    etag: '"etag"',
    lastModified,
  })
})

test('bucket presigning uses method-specific commands and a fixed 3600-second expiry', async () => {
  const seen: Array<{ command: string; expiresIn: number }> = []
  const client: BucketClient = { async send() { return {} } }
  const signer = async (_client: BucketClient, command: unknown, options: { expiresIn: 3600 }) => {
    seen.push({ command: commandConstructorName(command), expiresIn: options.expiresIn })
    return `https://storage.example.test/signed?X-Amz-Expires=${options.expiresIn}`
  }

  const getUrl = await presignBucketObject(relativePath, { config, client, signer, method: 'GET' })
  const headUrl = await presignBucketObject(relativePath, { config, client, signer, method: 'HEAD' })
  assert.equal(PRESIGNED_URL_EXPIRY_SECONDS, 3600)
  assert.equal(new URL(getUrl).searchParams.get('X-Amz-Expires'), '3600')
  assert.equal(new URL(headUrl).searchParams.get('X-Amz-Expires'), '3600')
  assert.deepEqual(seen, [
    { command: 'GetObjectCommand', expiresIn: 3600 },
    { command: 'HeadObjectCommand', expiresIn: 3600 },
  ])

  const realClient = createBucketClient(config)
  assert.ok(realClient)
  const realUrl = await presignBucketObject(relativePath, { config, client: realClient })
  assert.equal(new URL(realUrl).searchParams.get('X-Amz-Expires'), '3600')
})

test('signer failures are surfaced for the server soft fallback', async () => {
  const client: BucketClient = { async send() { return {} } }
  await assert.rejects(
    presignBucketObject(relativePath, {
      config,
      client,
      signer: async () => { throw new Error('signer unavailable') },
    }),
    /signer unavailable/,
  )
})

test('server delivery decision retains HEAD metadata when signing fails', async () => {
  const bucketHead = {
    found: true as const,
    key: `rankings/${relativePath}`,
    contentLength: 70_000,
    contentType: 'application/json; charset=utf-8',
    contentEncoding: 'gzip',
    cacheControl: 'public, max-age=31536000, immutable',
    metadata: { sha256: digest, 'semantic-bytes': '140000', encoding: 'gzip' },
    etag: '"etag"',
  }
  let headCalls = 0
  let signCalls = 0
  const result = await preparePresignedBucketDelivery(relativePath, {
    config,
    client: { async send() { return {} } },
    thresholdBytes: 65_536,
    head: async () => { headCalls += 1; return bucketHead },
    presign: async () => { signCalls += 1; throw new Error('signer unavailable') },
  })

  assert.deepEqual(result, { kind: 'sign-failed', bucketHead })
  assert.equal(headCalls, 1)
  assert.equal(signCalls, 1)
})

test('content-addressed public uploads carry immutable JSON/gzip metadata', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-presigned-upload-'))
  const sent: Array<{ name: string; input: Record<string, unknown> }> = []
  const client: BucketClient = {
    async send(command) {
      const candidate = command as { input: Record<string, unknown> }
      const name = commandConstructorName(command)
      sent.push({ name, input: candidate.input })
      if (name === 'GetObjectCommand') throw Object.assign(new Error('missing'), { name: 'NoSuchKey' })
      return { ETag: '"uploaded"' }
    },
  }

  try {
    await mkdir(tempDir, { recursive: true })
    await writeFile(join(tempDir, 'ranking-summary.json'), JSON.stringify({
      artifactKind: 'public-ranking-manifest',
      generatedAt: '2026-07-22T12:00:00.000Z',
      source: 'test',
      dataMode: 'no-data',
      sources: [],
      model: { version: 'test-model', configHash: 'test-config' },
      artifactMeta: { runId: 'generation-test' },
    }))
    await uploadContentAddressedPublicArtifacts(client, config, tempDir, 'generation-test')
    const objectPut = sent.find((entry) => entry.name === 'PutObjectCommand'
      && String(entry.input.Key).startsWith('rankings/objects/sha256/'))
    assert.ok(objectPut)
    assert.equal(objectPut.input.ContentType, 'application/json; charset=utf-8')
    assert.equal(objectPut.input.ContentEncoding, 'gzip')
    assert.equal(objectPut.input.CacheControl, 'public, max-age=31536000, immutable')
    assert.deepEqual(Object.keys(objectPut.input.Metadata as Record<string, string>).sort(), ['encoding', 'semantic-bytes', 'sha256'])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('verified content-addressed objects with missing metadata are repaired once, then reused', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-presigned-migration-'))
  const source = {
    artifactKind: 'public-ranking-manifest',
    generatedAt: '2026-07-22T12:00:00.000Z',
    source: 'test',
    dataMode: 'no-data',
    sources: [],
    model: { version: 'test-model', configHash: 'test-config' },
    artifactMeta: { runId: 'generation-migration' },
  }
  const prepared = prepareSemanticArtifact(source)
  const objectKey = `rankings/objects/sha256/${prepared.digest}`
  let stored = {
    contentType: 'application/json; charset=utf-8',
    contentEncoding: 'gzip',
    cacheControl: undefined as string | undefined,
    metadata: {
      sha256: prepared.digest,
      'semantic-bytes': String(prepared.bytes),
      encoding: 'gzip',
    },
    body: prepared.compressed,
  }
  const contentPuts: Array<Record<string, unknown>> = []
  const client: BucketClient = {
    async send(command) {
      const candidate = command as { input: Record<string, unknown> }
      const name = commandConstructorName(command)
      if (name === 'GetObjectCommand' && candidate.input.Key === objectKey) {
        return {
          Body: Readable.from([stored.body]),
          ContentLength: stored.body.byteLength,
          ContentType: stored.contentType,
          ContentEncoding: stored.contentEncoding,
          CacheControl: stored.cacheControl,
          Metadata: stored.metadata,
        }
      }
      if (name === 'PutObjectCommand' && candidate.input.Key === objectKey) {
        contentPuts.push(candidate.input)
        stored = {
          contentType: String(candidate.input.ContentType),
          contentEncoding: String(candidate.input.ContentEncoding),
          cacheControl: String(candidate.input.CacheControl),
          metadata: candidate.input.Metadata as typeof stored.metadata,
          body: Buffer.from(candidate.input.Body as Uint8Array),
        }
      }
      return { ETag: '"uploaded"' }
    },
  }

  try {
    await writeFile(join(tempDir, 'ranking-summary.json'), JSON.stringify(source))
    const first = await uploadContentAddressedPublicArtifacts(client, config, tempDir, 'generation-migration')
    assert.equal(first.uploaded.some((entry) => entry.reason === 'content-addressed-object-metadata-upgraded'), true)
    assert.equal(contentPuts.length, 1)
    assert.equal(contentPuts[0]?.IfNoneMatch, undefined)
    assert.equal(contentPuts[0]?.ContentType, 'application/json; charset=utf-8')
    assert.equal(contentPuts[0]?.ContentEncoding, 'gzip')
    assert.equal(contentPuts[0]?.CacheControl, 'public, max-age=31536000, immutable')
    assert.deepEqual(contentPuts[0]?.Metadata, {
      sha256: prepared.digest,
      'semantic-bytes': String(prepared.bytes),
      encoding: 'gzip',
    })
    assert.deepEqual(Buffer.from(contentPuts[0]?.Body as Uint8Array), prepared.compressed)

    const second = await uploadContentAddressedPublicArtifacts(client, config, tempDir, 'generation-migration')
    assert.equal(second.unchanged.some((entry) => entry.reason === 'content-addressed-object-reused'), true)
    assert.equal(contentPuts.length, 1)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

function commandConstructorName(command: unknown) {
  return (command as { constructor: { name: string } }).constructor.name
}
