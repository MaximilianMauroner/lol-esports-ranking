import assert from 'node:assert/strict'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CopyObjectCommand,
  CreateMultipartUploadCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command,
  PutBucketPolicyCommand, PutObjectAclCommand, PutObjectCommand, PutObjectTaggingCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { minioFixture } from './nativeRankingOriginFixtures.ts'
import { sdkErrorDiagnostic } from './nativeRankingOriginProcesses.ts'

test('isolated MinIO proves fixed public reads and denied mutations with the same principal', { timeout: 60_000 }, async t => {
  const fixture = await minioFixture()
  const { reader, publisher, bucket, key } = fixture
  let uploadId: string | undefined
  const multipartKey = key('objects/sha256/multipart-fixture')
  try {
    const semantic = Buffer.from(JSON.stringify({ artifactKind: 'public-semantic-artifact', schemaVersion: 1,
      content: { artifactKind: 'fixture', source: 'Synthetic IAM fixture' } }))
    const digest = createHash('sha256').update(semantic).digest('hex')
    const compressed = gzipSync(semantic)
    const publicBodies = new Map([
      ['active-generation.json', Buffer.from('{"generationId":"synthetic-a"}')],
      ['generations/synthetic-a/manifest.json', Buffer.from('{"fixture":"manifest"}')],
      ['generations/synthetic-a/publish.json', Buffer.from('{"fixture":"publish"}')],
      ['generations/synthetic-a/data/history/team-series/index.json', Buffer.from('{"fixture":"stored-logical"}')],
      [`objects/sha256/${digest}`, compressed],
    ])
    for (const [path, body] of publicBodies) {
      await fixture.put(path, body, path.startsWith('objects/') ? { encoding: 'gzip',
        metadata: { sha256: digest, 'semantic-bytes': String(semantic.length), encoding: 'gzip' } } : {})
    }
    for (const path of ['raw/objects/sha256/private', 'state/generations/synthetic-a.json', 'ops/refresh-lease.json']) {
      await fixture.put(path, Buffer.from('private synthetic fixture'))
    }
    await publisher.send(new PutObjectCommand({ Bucket: bucket, Key: 'other-prefix/active-generation.json', Body: 'other namespace' }))
    for (const [path, body] of publicBodies) assert.deepEqual(await fixture.get(path), body)
    const upload = await publisher.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: multipartKey }))
    assert.ok(upload.UploadId)
    uploadId = upload.UploadId
    const before = await fixture.inventory()
    const denialAttempts = [
      ['put-public', async () => reader.send(new PutObjectCommand({ Bucket: bucket, Key: key(`objects/sha256/${digest}`), Body: 'bad' }))],
      ['put-pointer', async () => reader.send(new PutObjectCommand({ Bucket: bucket, Key: key('active-generation.json'), Body: 'bad' }))],
      ['put-logical', async () => reader.send(new PutObjectCommand({ Bucket: bucket, Key: key('generations/synthetic-a/data/other.json'), Body: 'bad' }))],
      ['put-lease', async () => reader.send(new PutObjectCommand({ Bucket: bucket, Key: key('ops/refresh-lease.json'), Body: 'bad' }))],
      ['delete', async () => reader.send(new DeleteObjectCommand({ Bucket: bucket, Key: key(`objects/sha256/${digest}`) }))],
      ['copy', async () => reader.send(new CopyObjectCommand({ Bucket: bucket, Key: key('copied.json'), CopySource: `${bucket}/${key(`objects/sha256/${digest}`)}` }))],
      ['multipart-create', async () => reader.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key('new-multipart') }))],
      ['multipart-upload', async () => reader.send(new UploadPartCommand({ Bucket: bucket, Key: multipartKey, UploadId: uploadId, PartNumber: 1, Body: 'bad' }))],
      ['multipart-complete', async () => reader.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: multipartKey, UploadId: uploadId,
        MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"fake"' }] } }))],
      ['multipart-abort', async () => reader.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: multipartKey, UploadId: uploadId }))],
      ['list', async () => reader.send(new ListObjectsV2Command({ Bucket: bucket }))],
      ['acl', async () => reader.send(new PutObjectAclCommand({ Bucket: bucket, Key: key(`objects/sha256/${digest}`), ACL: 'private' }))],
      ['tags', async () => reader.send(new PutObjectTaggingCommand({ Bucket: bucket, Key: key(`objects/sha256/${digest}`), Tagging: { TagSet: [{ Key: 'fixture', Value: 'bad' }] } }))],
      ['bucket-policy', async () => reader.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: '{"Version":"2012-10-17","Statement":[]}' }))],
      ...['raw/objects/sha256/private', 'state/generations/synthetic-a.json', 'ops/refresh-lease.json'].map(path =>
        [`private-${path.split('/')[0]}`, async () => reader.send(new GetObjectCommand({ Bucket: bucket, Key: key(path) }))] as const),
      ['other-prefix', async () => reader.send(new GetObjectCommand({ Bucket: bucket, Key: 'other-prefix/active-generation.json' }))],
    ] as const
    let deniedActions = 0
    for (const [name, operation] of denialAttempts) {
      await t.test(name, async denial => {
        await assert.rejects(operation, (error: unknown) => {
          try {
            assert.ok(error && typeof error === 'object' && '$metadata' in error && 'name' in error)
            assert.equal((error.$metadata as { httpStatusCode?: number }).httpStatusCode, 403)
            assert.equal(error.name, 'AccessDenied')
            return true
          } catch (assertionError) {
            denial.diagnostic(JSON.stringify({ operation: name, sdkError: sdkErrorDiagnostic(error) }))
            throw assertionError
          }
        })
        deniedActions += 1
      })
    }
    assert.deepEqual(await fixture.inventory(), before, 'Denied requests must preserve the full bucket byte inventory')
    for (const [path, body] of publicBodies) assert.deepEqual(await fixture.get(path), body)
    assert.deepEqual(Object.keys(fixture.originEnvironment).filter(name => /MINIO|MC_|RANKING_BUCKET|AWS_|PROXY/.test(name)), [])
    t.diagnostic(JSON.stringify({ ...fixture.provenance, publicReadClasses: publicBodies.size,
      denialAttempts: denialAttempts.length, deniedActions, inventoryObjects: before.length, byteIdentity: 'passed' }))
  } finally {
    try {
      if (uploadId) await publisher.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: multipartKey, UploadId: uploadId }))
    } finally { await fixture.close() }
  }
})
