import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  CreateBucketCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3'
import { fixtureEnvironment, ownedProcess, requiredBinary, unusedLoopbackPort } from './nativeRankingOriginProcesses.ts'

const run = promisify(execFile)
const prefix = 'public-origin-fixture'
const region = 'us-east-1'
type Credentials = { accessKeyId: string; secretAccessKey: string }

export async function requireIsolatedNetwork() {
  assert.equal(process.platform, 'linux', 'The MinIO proof requires a Linux network namespace')
  const devices = (await readFile('/proc/self/net/dev', 'utf8')).trim().split('\n').slice(2)
    .map(line => line.split(':')[0].trim()).sort()
  assert.deepEqual(devices, ['lo'],
    'Run the MinIO proof in an owned network namespace with only loopback enabled')
}

export async function minioFixture() {
  await requireIsolatedNetwork()
  const minio = await requiredBinary('RANKING_ORIGIN_TEST_MINIO_BINARY')
  const mc = await requiredBinary('RANKING_ORIGIN_TEST_MC_BINARY')
  const directory = await mkdtemp(join(tmpdir(), 'ranking-origin-minio-'))
  const bucket = `ranking-origin-${randomUUID()}`
  const port = await unusedLoopbackPort()
  const consolePort = await unusedLoopbackPort()
  const endpoint = `http://127.0.0.1:${port}`
  const admin = { accessKeyId: `admin${randomBytes(12).toString('hex')}`, secretAccessKey: randomBytes(32).toString('hex') }
  const processHandle = ownedProcess(minio.path,
    ['server', join(directory, 'store'), '--address', `127.0.0.1:${port}`, '--console-address', `127.0.0.1:${consolePort}`],
    fixtureEnvironment({ MINIO_ROOT_USER: admin.accessKeyId, MINIO_ROOT_PASSWORD: admin.secretAccessKey,
      MINIO_BROWSER: 'off', MINIO_UPDATE: 'off', MINIO_CALLHOME_ENABLE: 'off' }))
  const clients: S3Client[] = []
  let cleanup: Promise<void> | undefined
  function client(credentials: Credentials) {
    const value = new S3Client({ endpoint, region, forcePathStyle: true, maxAttempts: 1, credentials,
      requestHandler: { connectionTimeout: 2_000, requestTimeout: 5_000 } })
    clients.push(value)
    return value
  }
  function close() {
    cleanup ??= (async () => {
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', terminate)
      for (const value of clients) value.destroy()
      try { await processHandle.close() } finally { await rm(directory, { recursive: true, force: true }) }
    })()
    return cleanup
  }
  const interrupt = () => { void close().finally(() => process.exit(130)) }
  const terminate = () => { void close().finally(() => process.exit(143)) }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  async function principal(name: string, policy: unknown): Promise<Credentials> {
    const path = join(directory, `${name}-policy.json`)
    await writeFile(path, JSON.stringify(policy), { mode: 0o600 })
    let stdout: string
    try {
      const response = await run(mc.path, ['--json', 'admin', 'user', 'svcacct', 'add', 'originfixture', '--policy', path], {
        env: fixtureEnvironment({ MC_CONFIG_DIR: join(directory, 'mc'),
          MC_HOST_originfixture: `http://${admin.accessKeyId}:${admin.secretAccessKey}@127.0.0.1:${port}` }),
        timeout: 10_000, maxBuffer: 32_768,
      })
      stdout = response.stdout
    } catch { throw new Error('Isolated MinIO service-account creation failed') }
    let value: { status?: string; accessKey?: string; secretKey?: string }
    try { value = JSON.parse(stdout) } catch { throw new Error('MinIO service-account response is invalid') }
    assert.equal(value.status, 'success', 'MinIO must create the isolated principal')
    assert.ok(typeof value.accessKey === 'string' && typeof value.secretKey === 'string', 'MinIO must return isolated credentials')
    return { accessKeyId: value.accessKey, secretAccessKey: value.secretKey }
  }
  try {
    await processHandle.ready(`${endpoint}/minio/health/ready`)
    const administrator = client(admin)
    await administrator.send(new CreateBucketCommand({ Bucket: bucket }))
    const publisherCredentials = await principal('publisher', { Version: '2012-10-17', Statement: [
      { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: [`arn:aws:s3:::${bucket}`] },
      { Effect: 'Allow', Action: ['s3:*'], Resource: [`arn:aws:s3:::${bucket}/*`] },
    ] })
    const policy = await readFile(new URL('../ops/ranking-origin/read-only-policy.json', import.meta.url), 'utf8')
    const readCredentials = await principal('reader', JSON.parse(policy.replaceAll('${BUCKET}', bucket).replaceAll('${PREFIX}', prefix)))
    assert.ok(readCredentials.accessKeyId !== publisherCredentials.accessKeyId, 'Reader and publisher must be separate principals')
    assert.ok(readCredentials.accessKeyId !== admin.accessKeyId, 'Reader and administrator must be separate principals')
    const publisher = client(publisherCredentials)
    const reader = client(readCredentials)
    const key = (relative: string) => `${prefix}/${relative}`
    async function put(relative: string, body: Buffer, options: { encoding?: string; metadata?: Record<string, string> } = {}) {
      return publisher.send(new PutObjectCommand({ Bucket: bucket, Key: key(relative), Body: body,
        ContentType: 'application/json; charset=utf-8', ContentEncoding: options.encoding, Metadata: options.metadata }))
    }
    async function get(relative: string) {
      const response = await reader.send(new GetObjectCommand({ Bucket: bucket, Key: key(relative) }))
      assert.ok(response.Body)
      return Buffer.from(await response.Body.transformToByteArray())
    }
    async function inventory() {
      const result: { key: string; sha256: string; bytes: number }[] = []
      let ContinuationToken: string | undefined
      do {
        const page = await administrator.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken }))
        for (const object of page.Contents ?? []) {
          assert.ok(object.Key)
          const response = await administrator.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }))
          assert.ok(response.Body)
          const body = Buffer.from(await response.Body.transformToByteArray())
          result.push({ key: object.Key, sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length })
        }
        ContinuationToken = page.NextContinuationToken
      } while (ContinuationToken)
      return result.sort((left, right) => left.key.localeCompare(right.key))
    }
    return { bucket, prefix, publisher, reader, key, put, get, inventory, close,
      provenance: { minioSha256: minio.sha256, mcSha256: mc.sha256, authority: 'synthetic-publication-authority' },
      originEnvironment: fixtureEnvironment({ RANKING_ORIGIN_ENDPOINT: endpoint, RANKING_ORIGIN_BUCKET: bucket,
        RANKING_ORIGIN_REGION: region, RANKING_ORIGIN_PREFIX: prefix, RANKING_ORIGIN_ADDRESSING_STYLE: 'path',
        RANKING_ORIGIN_ACCESS_KEY_ID: readCredentials.accessKeyId, RANKING_ORIGIN_SECRET_ACCESS_KEY: readCredentials.secretAccessKey }),
    }
  } catch (error) {
    await close()
    throw error
  }
}
