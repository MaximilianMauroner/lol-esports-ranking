import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { createGunzip, gunzipSync } from 'node:zlib'
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { parseFullAuditReceipt } from './full-audit-storage.mjs'
import { parseGenerationPublicationReceipt } from './generation-publication.mjs'
import { parseIncrementalStateManifest } from './incremental-state-storage.mjs'
import { canonicalJsonFor } from './public-artifact-storage.mjs'
import {
  bucketConfigFromEnv,
  bucketKey,
  createBucketClient,
  parseGenerationPublishReceipt,
  readActiveContentAddressedGeneration,
  readActiveRawSourceAuthority,
  readBucketJson,
} from './railway-bucket.mjs'
import { decodeRawObject, parseRawSourceReceipt } from './raw-source-storage.mjs'

const execFileAsync = promisify(execFile)
const SHA256 = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const AUDIT_DAY = /^audits\/days\/\d{4}-\d{2}-\d{2}\.json$/
const RECEIPT_KEYS = [
  'kind',
  'schemaVersion',
  'capturedAt',
  'baseline',
  'railway',
  'frozenBehavior',
  'active',
  'previous',
  'latestFullAudit',
  'recovery',
  'producingCode',
  'integrity',
  'canonicalDigest',
]
const BASELINE_TAG = 'ranking-restart-baseline-2026-07-23'
const DEFAULT_RECEIPT = 'ops/ranking-restart/baseline-receipt.json'

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  await runCli(process.argv.slice(2))
}

export async function runCli(argv, dependencies = {}) {
  const options = parseArgs(argv)
  if (options.command === 'verify') {
    const parsed = parseRankingRestartBaselineReceipt(JSON.parse(await readFile(resolve(options.receipt), 'utf8')))
    process.stdout.write(`${canonicalJsonFor(parsed)}\n`)
    return parsed
  }
  const env = dependencies.env ?? process.env
  const config = dependencies.config ?? bucketConfigFromEnv(env)
  const client = dependencies.client ?? createBucketClient(config)
  if (!config.enabled || !client) {
    throw new Error(`Ranking bucket is not configured: ${(config.missing ?? []).join(', ')}`)
  }
  const baselineCommit = await resolveCommitIdentity({
    explicitCommit: options.commit,
    env,
    cwd: dependencies.cwd,
    git: dependencies.git,
    hasGitMetadata: dependencies.hasGitMetadata,
  })
  const receipt = await captureRankingRestartBaseline({
    config,
    client,
    baselineCommit,
    baselineTag: options.tag,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    railway: {
      projectId: requiredOption(options.projectId, '--project-id'),
      environmentId: requiredOption(options.environmentId, '--environment-id'),
      bucketId: requiredOption(options.bucketId, '--bucket-id'),
      bucketName: requiredOption(options.bucketName, '--bucket-name'),
      web: {
        serviceId: requiredOption(options.webServiceId, '--web-service-id'),
        deploymentId: requiredOption(options.webDeploymentId, '--web-deployment-id'),
        commit: requiredOption(options.webCommit, '--web-commit'),
      },
      refresh: {
        serviceId: requiredOption(options.refreshServiceId, '--refresh-service-id'),
        deploymentId: requiredOption(options.refreshDeploymentId, '--refresh-deployment-id'),
        commit: requiredOption(options.refreshCommit, '--refresh-commit'),
      },
    },
    readers: dependencies.readers,
    onProgress: dependencies.onProgress ?? ((phase) => process.stderr.write(`ranking-baseline: ${phase}\n`)),
  })
  await writeFile(resolve(options.receipt), `${canonicalJsonFor(receipt)}\n`, { flag: 'wx' })
  process.stdout.write(`${canonicalJsonFor(receipt)}\n`)
  return receipt
}

export function parseArgs(argv) {
  const [command = 'verify', ...rest] = argv
  if (command !== 'capture' && command !== 'verify') throw new Error(`Unknown baseline command: ${command}`)
  const options = { command, receipt: DEFAULT_RECEIPT, tag: BASELINE_TAG }
  const names = {
    '--receipt': 'receipt',
    '--commit': 'commit',
    '--tag': 'tag',
    '--captured-at': 'capturedAt',
    '--project-id': 'projectId',
    '--environment-id': 'environmentId',
    '--bucket-id': 'bucketId',
    '--bucket-name': 'bucketName',
    '--web-service-id': 'webServiceId',
    '--web-deployment-id': 'webDeploymentId',
    '--web-commit': 'webCommit',
    '--refresh-service-id': 'refreshServiceId',
    '--refresh-deployment-id': 'refreshDeploymentId',
    '--refresh-commit': 'refreshCommit',
  }
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]
    const separator = argument.indexOf('=')
    const flag = separator === -1 ? argument : argument.slice(0, separator)
    const field = names[flag]
    if (!field) throw new Error(`Unknown baseline argument: ${argument}`)
    const value = separator === -1 ? rest[++index] : argument.slice(separator + 1)
    if (!value) throw new Error(`Missing value for ${flag}`)
    options[field] = value
  }
  if (command === 'verify' && rest.some((argument) => argument !== '--receipt' && !argument.startsWith('--receipt='))) {
    const allowed = rest.length === 2 && rest[0] === '--receipt'
    if (!allowed) throw new Error('Verify accepts only --receipt')
  }
  return options
}

export async function resolveCommitIdentity({
  explicitCommit,
  env = process.env,
  cwd = process.cwd(),
  git = defaultGitCommit,
  hasGitMetadata = defaultHasGitMetadata,
} = {}) {
  const candidates = [
    ['explicit CLI', explicitCommit],
    ['RAILWAY_GIT_COMMIT_SHA', env.RAILWAY_GIT_COMMIT_SHA],
    ['GIT_COMMIT_SHA', env.GIT_COMMIT_SHA],
  ]
  for (const [label, value] of candidates) {
    if (value !== undefined) return requiredCommit(value, label)
  }
  if (await hasGitMetadata(cwd)) return requiredCommit(await git(cwd), 'git')
  throw new Error('Commit identity is unavailable: pass --commit in archives without .git')
}

async function defaultHasGitMetadata(cwd) {
  try {
    await access(resolve(cwd, '.git'))
    return true
  } catch {
    return false
  }
}

async function defaultGitCommit(cwd) {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd })
  return stdout.trim()
}

export async function captureRankingRestartBaseline({
  config,
  client,
  baselineCommit,
  baselineTag,
  capturedAt,
  railway,
  readers = {},
  onProgress = () => {},
  beforeFinalPointerRead,
}) {
  const readPublic = readers.readActiveContentAddressedGeneration ?? readActiveContentAddressedGeneration
  const readState = readers.readActiveIncrementalState
    ?? ((options) => readIncrementalStateAuthority(firstPointer.value, options))
  const readRaw = readers.readActiveRawSourceAuthority ?? readActiveRawSourceAuthority
  const readPrevious = readers.readPreviousGenerationAuthorities
    ?? ((options) => readPreviousAuthorities(firstPointer.value, options))
  const firstPointer = await readBucketJson('active-generation.json', { config, client })
  if (!firstPointer.found || !firstPointer.etag) throw new Error('Active generation pointer is missing or has no ETag')
  onProgress('active-pointer-read')
  const [publicAuthority, stateAuthority, rawAuthority, previousAuthority] = await Promise.all([
    readPublic({ config, client, verifyArtifacts: false }),
    readState({ config, client, verifyObjects: false }),
    readRaw({ config, client }),
    readPrevious({ config, client, verifyArtifacts: false }),
  ])
  if (!publicAuthority.found || !stateAuthority.found || !rawAuthority.found || !previousAuthority.found) {
    throw new Error('Baseline requires complete active public/state/raw and previous-generation authorities')
  }
  onProgress('active-and-previous-authorities-read')
  await verifyPublicArtifactBodies(client, config, publicAuthority.manifest)
  onProgress('active-public-references-verified')
  await verifyStateReferences(client, config, stateAuthority.manifest)
  onProgress('active-state-references-verified')
  await verifyRawChildren(client, config, rawAuthority.receipt)
  onProgress('active-raw-references-verified')
  const activeGenerationId = requiredSafeId(publicAuthority.active.generationId, 'active generationId')
  const activePublish = await readStoredJson(
    client,
    config,
    `generations/${activeGenerationId}/publish.json`,
  )
  parseStoredGenerationPublishReceipt(activePublish.value, {
    generationId: activeGenerationId,
    prefix: config.prefix ?? '',
  })
  assertPublishReceiptBindings(activePublish.value, {
    publicManifest: {
      key: publicAuthority.active.manifestKey,
      digest: publicAuthority.active.manifestDigest,
      bytes: publicAuthority.active.manifestBytes,
    },
    rawReceipt: {
      key: publicAuthority.active.rawReceiptKey,
      digest: publicAuthority.active.rawReceiptDigest,
      bytes: publicAuthority.active.rawReceiptCompressedBytes,
    },
  })
  onProgress('active-publish-receipt-verified')
  const previousGenerationId = requiredSafeId(previousAuthority.previous.generationId, 'previous generationId')
  const previousPublish = await readStoredJsonOptional(
    client,
    config,
    `generations/${previousGenerationId}/publish.json`,
  )
  if (previousPublish.found) {
    parseStoredGenerationPublishReceipt(previousPublish.value, {
      generationId: previousGenerationId,
      prefix: config.prefix ?? '',
    })
    assertPublishReceiptBindings(previousPublish.value, {
      publicManifest: {
        key: previousAuthority.previous.manifestKey,
        digest: previousAuthority.public.digest,
        bytes: previousAuthority.public.bytes,
      },
      rawReceipt: {
        key: previousAuthority.previous.rawReceiptKey,
        digest: previousAuthority.previous.rawReceiptDigest,
        bytes: previousAuthority.raw.receiptReference.compressedBytes,
      },
    })
  }
  onProgress('previous-publish-receipt-verified')
  const latestFullAudit = await readLatestFullAuditAuthority({ config, client, verifiedAt: capturedAt })
  onProgress('audit-authority-verified')
  await beforeFinalPointerRead?.()
  const finalPointer = await readBucketJson('active-generation.json', { config, client })
  assertStablePointer(firstPointer, finalPointer)

  const manifest = publicAuthority.manifest
  const root = publicAuthority.rootArtifact
  const stateManifest = stateAuthority.manifest
  const rawReceipt = rawAuthority.receipt
  assertAuthorityAgreement({
    generationId: activeGenerationId,
    manifest,
    stateManifest,
    rawReceipt,
    pointer: publicAuthority.active,
    publishReceipt: activePublish.value,
  })
  if (!previousAuthority.state || !previousAuthority.raw) throw new Error('Previous generation is not complete')
  await verifyPublicArtifactBodies(client, config, previousAuthority.public.manifest)
  onProgress('previous-public-references-verified')
  await verifyStateReferences(client, config, previousAuthority.state.manifest)
  onProgress('previous-state-references-verified')
  await verifyRawChildrenFromBucket(client, config, previousAuthority.raw.receipt)
  onProgress('previous-raw-references-verified')
  assertAuthorityAgreement({
    generationId: previousGenerationId,
    manifest: previousAuthority.public.manifest,
    stateManifest: previousAuthority.state.manifest,
    rawReceipt: previousAuthority.raw.receipt,
    pointer: previousAuthority.previous,
    publishReceipt: previousPublish.found ? previousPublish.value : undefined,
  })
  const active = {
    generationId: activeGenerationId,
    pointer: {
      key: bucketKey(config, 'active-generation.json'),
      etag: normalizeEtag(firstPointer.etag),
      fencingToken: requiredNonNegativeInteger(publicAuthority.active.fencingToken, 'active fencingToken'),
      promotedAt: requiredIso(publicAuthority.active.promotedAt, 'active promotedAt'),
    },
    publicManifest: authorityReference(
      publicAuthority.active.manifestKey,
      publicAuthority.active.manifestDigest,
      publicAuthority.active.manifestBytes,
    ),
    stateManifest: authorityReference(
      publicAuthority.active.stateManifestKey,
      publicAuthority.active.stateManifestDigest,
      stateAuthority.bytes,
    ),
    rawReceipt: authorityReference(
      publicAuthority.active.rawReceiptKey,
      publicAuthority.active.rawReceiptDigest,
      publicAuthority.active.rawReceiptCompressedBytes,
    ),
    publishReceipt: authorityReference(activePublish.key, activePublish.sha256, activePublish.bytes),
    sourceReceiptDigest: requiredDigest(rawReceipt.sourceReceiptDigest, 'active sourceReceiptDigest'),
    model: modelAuthority(manifest.model),
    rankingSchemaVersion: requiredPositiveInteger(
      stateManifest.compatibility?.publicArtifactSchemaVersion,
      'ranking schemaVersion from state compatibility',
    ),
    coverage: coverageAuthority(root.coverage),
    dataMode: requiredString(root.dataMode ?? manifest.provenance?.dataMode, 'active dataMode'),
    seeded: root.coverage?.seededSample === true,
  }
  const previous = {
    generationId: previousGenerationId,
    promotedAt: requiredIso(previousAuthority.previous.promotedAt, 'previous promotedAt'),
    complete: true,
    publicManifest: authorityReference(
      previousAuthority.previous.manifestKey,
      previousAuthority.public.digest,
      previousAuthority.public.bytes,
    ),
    stateManifest: authorityReference(
      previousAuthority.previous.stateManifestKey,
      previousAuthority.previous.stateManifestDigest,
      previousAuthority.state.bytes,
    ),
    rawReceipt: authorityReference(
      previousAuthority.previous.rawReceiptKey,
      previousAuthority.previous.rawReceiptDigest,
      previousAuthority.raw.receiptReference.compressedBytes,
    ),
    publishReceipt: previousPublish.found
      ? { status: 'present', ...authorityReference(previousPublish.key, previousPublish.sha256, previousPublish.bytes) }
      : { status: 'absent', key: previousPublish.key, verifiedAt: capturedAt },
    sourceReceiptDigest: requiredDigest(previousAuthority.raw.receipt.sourceReceiptDigest, 'previous sourceReceiptDigest'),
    model: modelAuthority(previousAuthority.public.manifest.model),
  }
  const receiptWithoutDigest = {
    kind: 'ranking-restart-baseline-receipt',
    schemaVersion: 1,
    capturedAt: requiredIso(capturedAt, 'capturedAt'),
    baseline: {
      commit: requiredCommit(baselineCommit, 'baseline commit'),
      tag: requiredSafeId(baselineTag, 'baseline tag'),
    },
    railway: parseRailwayAuthority(railway),
    frozenBehavior: {
      cronSchedule: '0 */6 * * *',
      intervalMinutes: 360,
      refreshMode: 'gated',
      deliveryMode: 'proxy',
      deletionAuthorized: false,
      incrementalActivationAuthorized: false,
    },
    active,
    previous,
    latestFullAudit,
    recovery: {
      order: ['previous-complete-generation', 'authorized-full-replay-from-active-verified-raw'],
      scheduledFreshnessRemainsStrict: true,
      verifiedRawFullReplayRequires: ['force', 'recovery-authorization'],
    },
    producingCode: [
      'scripts/railway-bucket.mjs',
      'scripts/incremental-state-storage.mjs',
      'scripts/raw-source-storage.mjs',
      'scripts/full-audit-storage.mjs',
      'scripts/refresh-once.mjs',
      'scripts/refresh-data-if-changed.mjs',
    ],
    integrity: [
      integrityResult('active-pointer', active.pointer.key),
      integrityResult('active-public-and-referenced-artifacts', active.publicManifest.key),
      integrityResult('active-state-ledger-and-checkpoints', active.stateManifest.key),
      integrityResult('active-raw-receipt-and-children', active.rawReceipt.key),
      integrityResult('active-publish-receipt', active.publishReceipt.key),
      integrityResult('previous-public-state-raw-and-publish', previous.publishReceipt.key),
      integrityResult('latest-full-audit-authority', latestFullAudit.status === 'present' ? latestFullAudit.key : latestFullAudit.searchedPrefix),
      integrityResult('active-pointer-etag-recheck', active.pointer.key),
    ],
  }
  return parseRankingRestartBaselineReceipt({
    ...receiptWithoutDigest,
    canonicalDigest: canonicalReceiptDigest(receiptWithoutDigest),
  })
}

function parseStoredGenerationPublishReceipt(value, options) {
  return value?.artifactKind === 'ranking-generation-publication-readiness'
    ? parseGenerationPublicationReceipt(value, options)
    : parseGenerationPublishReceipt(value, options)
}

export async function readLatestFullAuditAuthority({ config, client, verifiedAt }) {
  const searchedPrefix = `${config.prefix ? `${config.prefix}/` : ''}audits/days/`
  const keys = []
  let continuationToken
  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: searchedPrefix,
      ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
    }))
    for (const entry of response.Contents ?? []) {
      const relative = relativeBucketKey(config, entry.Key)
      if (AUDIT_DAY.test(relative)) keys.push(relative)
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
    if (response.IsTruncated && !continuationToken) throw new Error('Audit listing was truncated without a continuation token')
  } while (continuationToken)
  keys.sort()
  const latest = keys.at(-1)
  if (!latest) {
    return {
      status: 'absent',
      searchedPrefix,
      verifiedAt: requiredIso(verifiedAt, 'audit absence verifiedAt'),
    }
  }
  const stored = await readStoredJson(client, config, latest)
  const receipt = parseFullAuditReceipt(stored.value)
  await verifyFullAuditReferences(client, config, receipt)
  return {
    status: 'present',
    key: stored.key,
    sha256: stored.sha256,
    bytes: stored.bytes,
    auditDate: receipt.auditDate,
    generationId: receipt.generationId,
    model: receipt.model,
  }
}

async function verifyFullAuditReferences(client, config, receipt) {
  const source = await readCompressedReference(client, config, receipt.sourceReceipt)
  const parsedRaw = parseRawSourceReceipt(decodeRawObject(receipt.sourceReceipt, source))
  if (parsedRaw.generationId !== receipt.generationId) throw new Error('Full audit raw receipt generation mismatch')
  await verifyRawChildren(client, config, parsedRaw)
  await verifyCompressedReference(client, config, receipt.rawLedger, 'full audit raw ledger')
  await verifyCompressedReference(client, config, receipt.fullSnapshot, 'full audit snapshot')
}

async function verifyRawChildren(client, config, receipt) {
  const children = [
    ...receipt.oracle.flatMap((source) => [source.baseline, ...source.deltas]),
    ...receipt.leaguepedia.map((source) => source.object),
    ...receipt.lolesports.map((source) => source.object),
  ]
  await mapConcurrent(children, 8, (child) => verifyCompressedReference(client, config, child, 'raw child'))
}

async function verifyRawChildrenFromBucket(client, config, receipt) {
  const children = [
    ...receipt.oracle.flatMap((source) => [source.baseline, ...source.deltas]),
    ...receipt.leaguepedia.map((source) => source.object),
    ...receipt.lolesports.map((source) => source.object),
  ]
  await mapConcurrent(children, 8, (child) => verifyCompressedReference(client, config, child, 'previous raw child'))
}

async function verifyPublicArtifactBodies(client, config, manifest) {
  await mapConcurrent(Object.values(manifest.artifacts), 8, async (identity) => {
    const relativeKey = `objects/sha256/${requiredDigest(identity.sha256, 'public artifact digest')}`
    const key = bucketKey(config, relativeKey)
    await verifyCompressedReference(client, config, {
      key: relativeKey,
      sha256: identity.sha256,
      bytes: identity.bytes,
      storageEncoding: 'gzip',
    }, `public artifact ${key}`)
  })
}

async function verifyStateReferences(client, config, manifest) {
  await mapConcurrent(
    [manifest.canonicalLedger, ...manifest.checkpoints.map((checkpoint) => checkpoint.object)],
    8,
    (reference) => verifyCompressedReference(client, config, reference, 'state object'),
  )
}

async function readIncrementalStateAuthority(pointer, { config, client }) {
  const generationId = requiredSafeId(pointer.generationId, 'state generationId')
  const expectedKey = bucketKey(config, `state/generations/${generationId}.json`)
  if (pointer.stateManifestKey !== expectedKey) throw new Error('State manifest key is not canonical')
  const stored = await readStoredJson(client, config, `state/generations/${generationId}.json`)
  if (stored.sha256 !== pointer.stateManifestDigest) throw new Error('State manifest digest mismatch')
  const manifest = parseIncrementalStateManifest(stored.value)
  if (canonicalJsonFor(manifest) !== canonicalJsonFor(stored.value)) throw new Error('State manifest is not canonical')
  return { found: true, active: pointer, manifest, bytes: stored.bytes, canonicalLedger: {}, checkpoints: [] }
}

async function readPreviousAuthorities(pointer, { config, client }) {
  const previous = pointer.previousGeneration
  if (!previous) return { found: false, reason: 'previous-generation-missing' }
  const generationId = requiredSafeId(previous.generationId, 'previous generationId')
  const publicRelativeKey = `generations/${generationId}/manifest.json`
  if (previous.manifestKey !== bucketKey(config, publicRelativeKey)) throw new Error('Previous public manifest key is not canonical')
  const publicStored = await readStoredJson(client, config, publicRelativeKey)
  const manifest = publicStored.value
  if (manifest.generationId !== generationId || manifest.runId !== generationId
    || manifest.storageMode !== 'content-addressed-gzip-v1' || !manifest.artifacts || typeof manifest.artifacts !== 'object') {
    throw new Error('Previous public manifest is invalid')
  }
  const stateRelativeKey = `state/generations/${generationId}.json`
  if (previous.stateManifestKey !== bucketKey(config, stateRelativeKey)) throw new Error('Previous state manifest key is not canonical')
  const stateStored = await readStoredJson(client, config, stateRelativeKey)
  if (stateStored.sha256 !== previous.stateManifestDigest) throw new Error('Previous state manifest digest mismatch')
  const stateManifest = parseIncrementalStateManifest(stateStored.value)
  const rawReference = {
    key: relativeBucketKey(config, previous.rawReceiptKey),
    sha256: requiredDigest(previous.rawReceiptDigest, 'previous raw receipt digest'),
    bytes: Number.NaN,
    compressedBytes: Number.NaN,
    storageEncoding: 'gzip',
  }
  const rawKey = bucketKey(config, rawReference.key)
  const rawObject = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: rawKey }))
  rawReference.bytes = Number(rawObject.Metadata?.['semantic-bytes'])
  rawReference.compressedBytes = Number(rawObject.ContentLength)
  const compressed = await bodyBytes(rawObject.Body)
  assertCompressedMetadata(rawObject, rawReference, rawKey, compressed.byteLength)
  const receipt = parseRawSourceReceipt(decodeRawObject(rawReference, compressed))
  return {
    found: true,
    previous,
    public: { manifest, digest: publicStored.sha256, bytes: publicStored.bytes, artifacts: {} },
    state: { manifest: stateManifest, bytes: stateStored.bytes, canonicalLedger: {}, checkpoints: [] },
    raw: { receipt, receiptReference: rawReference },
  }
}

async function readStoredJson(client, config, relativeKey) {
  const key = bucketKey(config, relativeKey)
  const object = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
  const bytes = await bodyBytes(object.Body)
  if (Number(object.ContentLength) !== bytes.byteLength) throw new Error(`Stored JSON byte count mismatch: ${key}`)
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(`Stored JSON is corrupt: ${key}`, { cause: error })
  }
  return { key, value, bytes: bytes.byteLength, sha256: sha256(bytes), etag: object.ETag }
}

async function readStoredJsonOptional(client, config, relativeKey) {
  try {
    return { found: true, ...await readStoredJson(client, config, relativeKey) }
  } catch (error) {
    if (error?.name === 'NoSuchKey' || error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) {
      return { found: false, key: bucketKey(config, relativeKey) }
    }
    throw error
  }
}

async function readCompressedReference(client, config, reference) {
  const key = bucketKey(config, reference.key)
  const object = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
  const compressed = await bodyBytes(object.Body)
  assertCompressedMetadata(object, reference, key, compressed.byteLength)
  let semantic
  try {
    semantic = gunzipSync(compressed)
  } catch (error) {
    throw new Error(`Compressed authority is corrupt: ${key}`, { cause: error })
  }
  if (semantic.byteLength !== reference.bytes || sha256(semantic) !== reference.sha256) {
    throw new Error(`Compressed authority digest mismatch: ${key}`)
  }
  return compressed
}

function assertCompressedMetadata(object, reference, key, observedBytes) {
  if (object.ContentEncoding !== 'gzip'
    || object.Metadata?.sha256 !== reference.sha256
    || object.Metadata?.['semantic-bytes'] !== String(reference.bytes)
    || object.Metadata?.encoding !== 'gzip'
    || Number(object.ContentLength) !== reference.compressedBytes
    || observedBytes !== reference.compressedBytes) {
    throw new Error(`Compressed authority metadata mismatch: ${key}`)
  }
}

async function verifyCompressedReference(client, config, reference, label) {
  const key = bucketKey(config, reference.key)
  const object = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
  const contentLength = Number(object.ContentLength)
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0
    || object.ContentEncoding !== 'gzip'
    || object.Metadata?.sha256 !== reference.sha256
    || object.Metadata?.['semantic-bytes'] !== String(reference.bytes)
    || object.Metadata?.encoding !== 'gzip'
    || (reference.compressedBytes !== undefined && contentLength !== reference.compressedBytes)) {
    throw new Error(`${label} metadata mismatch: ${key}`)
  }
  let compressedBytes = 0
  let semanticBytes = 0
  const digest = createHash('sha256')
  const countCompressed = new Transform({
    transform(chunk, _encoding, callback) {
      compressedBytes += chunk.length
      callback(null, chunk)
    },
  })
  const hashSemantic = new Transform({
    transform(chunk, _encoding, callback) {
      semanticBytes += chunk.length
      digest.update(chunk)
      callback()
    },
  })
  try {
    await pipeline(readableBody(object.Body), countCompressed, createGunzip(), hashSemantic)
  } catch (error) {
    throw new Error(`${label} gzip is corrupt: ${key}`, { cause: error })
  }
  if (compressedBytes !== contentLength || semanticBytes !== reference.bytes || digest.digest('hex') !== reference.sha256) {
    throw new Error(`${label} body digest mismatch: ${key}`)
  }
}

function readableBody(body) {
  return typeof body?.pipe === 'function' ? body : Readable.from([body])
}

export function parseRankingRestartBaselineReceipt(value) {
  assertExactKeys(value, RECEIPT_KEYS, 'baseline receipt')
  if (value.kind !== 'ranking-restart-baseline-receipt' || value.schemaVersion !== 1) {
    throw new Error('Unsupported baseline receipt schema')
  }
  requiredIso(value.capturedAt, 'capturedAt')
  parseBaseline(value.baseline)
  parseRailwayAuthority(value.railway)
  parseFrozenBehavior(value.frozenBehavior)
  parseActive(value.active)
  parsePrevious(value.previous)
  parseLatestAudit(value.latestFullAudit)
  parseRecovery(value.recovery)
  parseProducingCode(value.producingCode)
  parseIntegrity(value.integrity)
  validateCanonicalRelationships(value)
  requiredDigest(value.canonicalDigest, 'canonicalDigest')
  const { canonicalDigest, ...withoutDigest } = value
  if (canonicalReceiptDigest(withoutDigest) !== canonicalDigest) throw new Error('Baseline canonical digest mismatch')
  return value
}

export function canonicalReceiptDigest(value) {
  return sha256(Buffer.from(canonicalJsonFor(value), 'utf8'))
}

export function validateCanonicalRelationships(value) {
  const pointerSuffix = 'active-generation.json'
  const pointerKey = value.active.pointer.key
  requiredSafeRelativePath(pointerKey, 'active pointer key')
  if (!pointerKey.endsWith(pointerSuffix)) throw new Error('Active pointer key is not canonical')
  const prefix = pointerKey.slice(0, -pointerSuffix.length).replace(/\/$/, '')
  requiredSafeRelativePath(prefix, 'bucket authority prefix')
  if (pointerKey !== joinedKey(prefix, pointerSuffix)) throw new Error('Active pointer key is not canonical')
  const generationPaths = (generationId) => ({
    publicManifest: joinedKey(prefix, `generations/${generationId}/manifest.json`),
    publishReceipt: joinedKey(prefix, `generations/${generationId}/publish.json`),
    stateManifest: joinedKey(prefix, `state/generations/${generationId}.json`),
  })
  const activePaths = generationPaths(value.active.generationId)
  const previousPaths = generationPaths(value.previous.generationId)
  for (const [label, key] of Object.entries({
    'active public manifest': value.active.publicManifest.key,
    'active publish receipt': value.active.publishReceipt.key,
    'active state manifest': value.active.stateManifest.key,
    'active raw receipt': value.active.rawReceipt.key,
    'previous public manifest': value.previous.publicManifest.key,
    'previous publish receipt': value.previous.publishReceipt.key,
    'previous state manifest': value.previous.stateManifest.key,
    'previous raw receipt': value.previous.rawReceipt.key,
  })) requiredSafeRelativePath(key, `${label} key`)
  assertEqual(value.active.publicManifest.key, activePaths.publicManifest, 'active public manifest path')
  assertEqual(value.active.publishReceipt.key, activePaths.publishReceipt, 'active publish receipt path')
  assertEqual(value.active.stateManifest.key, activePaths.stateManifest, 'active state manifest path')
  assertDigestPath(value.active.rawReceipt, prefix, 'active raw receipt')
  assertEqual(value.previous.publicManifest.key, previousPaths.publicManifest, 'previous public manifest path')
  assertEqual(value.previous.publishReceipt.key, previousPaths.publishReceipt, 'previous publish receipt path')
  assertEqual(value.previous.stateManifest.key, previousPaths.stateManifest, 'previous state manifest path')
  assertDigestPath(value.previous.rawReceipt, prefix, 'previous raw receipt')
  if (value.active.seeded !== value.active.coverage.seeded) throw new Error('Active seeded flags disagree')
  if (value.railway.web.commit !== value.baseline.commit || value.railway.refresh.commit !== value.baseline.commit) {
    throw new Error('Railway deployment commits do not match baseline commit')
  }
  const auditKey = value.latestFullAudit.status === 'present'
    ? joinedKey(prefix, `audits/days/${value.latestFullAudit.auditDate}.json`)
    : joinedKey(prefix, 'audits/days/')
  if (value.latestFullAudit.status === 'present') assertEqual(value.latestFullAudit.key, auditKey, 'full audit path')
  else {
    requiredSafeRelativePrefix(value.latestFullAudit.searchedPrefix, 'full audit searched prefix')
    assertEqual(value.latestFullAudit.searchedPrefix, auditKey, 'full audit searched prefix')
  }
  if (value.latestFullAudit.status === 'present') requiredSafeRelativePath(value.latestFullAudit.key, 'full audit key')
  const expectedIntegrity = [
    ['active-pointer', pointerKey],
    ['active-public-and-referenced-artifacts', value.active.publicManifest.key],
    ['active-state-ledger-and-checkpoints', value.active.stateManifest.key],
    ['active-raw-receipt-and-children', value.active.rawReceipt.key],
    ['active-publish-receipt', value.active.publishReceipt.key],
    ['previous-public-state-raw-and-publish', value.previous.publishReceipt.key],
    ['latest-full-audit-authority', auditKey],
    ['active-pointer-etag-recheck', pointerKey],
  ]
  for (const [index, [scope, key]] of expectedIntegrity.entries()) {
    const actual = value.integrity[index]
    if (scope === 'latest-full-audit-authority' && actual.key.endsWith('/')) {
      requiredSafeRelativePrefix(actual.key, `integrity scope ${scope} key`)
    } else requiredSafeRelativePath(actual.key, `integrity scope ${scope} key`)
    if (actual.scope !== scope || actual.key !== key || actual.result !== 'verified') {
      throw new Error(`Integrity scope ${scope} is not bound to its canonical authority`)
    }
  }
}

function assertDigestPath(reference, prefix, label) {
  assertEqual(reference.key, joinedKey(prefix, `raw/objects/sha256/${reference.sha256}`), `${label} path`)
}

function joinedKey(prefix, relative) {
  return prefix ? `${prefix}/${relative}` : relative
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} is not canonical`)
}

function parseBaseline(value) {
  assertExactKeys(value, ['commit', 'tag'], 'baseline identity')
  requiredCommit(value.commit, 'baseline commit')
  requiredSafeId(value.tag, 'baseline tag')
}

function parseRailwayAuthority(value) {
  assertExactKeys(value, ['projectId', 'environmentId', 'bucketId', 'bucketName', 'web', 'refresh'], 'Railway authority')
  for (const key of ['projectId', 'environmentId', 'bucketId']) requiredUuid(value[key], `Railway ${key}`)
  requiredSafeId(value.bucketName, 'Railway bucketName')
  for (const service of ['web', 'refresh']) {
    assertExactKeys(value[service], ['serviceId', 'deploymentId', 'commit'], `Railway ${service}`)
    requiredUuid(value[service].serviceId, `Railway ${service} serviceId`)
    requiredUuid(value[service].deploymentId, `Railway ${service} deploymentId`)
    requiredCommit(value[service].commit, `Railway ${service} commit`)
  }
  return value
}

function parseFrozenBehavior(value) {
  assertExactKeys(value, ['cronSchedule', 'intervalMinutes', 'refreshMode', 'deliveryMode', 'deletionAuthorized', 'incrementalActivationAuthorized'], 'frozen behavior')
  if (value.cronSchedule !== '0 */6 * * *' || value.intervalMinutes !== 360 || value.refreshMode !== 'gated'
    || value.deliveryMode !== 'proxy' || value.deletionAuthorized !== false || value.incrementalActivationAuthorized !== false) {
    throw new Error('Baseline changes frozen production behavior')
  }
}

function parseActive(value) {
  assertExactKeys(value, ['generationId', 'pointer', 'publicManifest', 'stateManifest', 'rawReceipt', 'publishReceipt', 'sourceReceiptDigest', 'model', 'rankingSchemaVersion', 'coverage', 'dataMode', 'seeded'], 'active authority')
  requiredSafeId(value.generationId, 'active generationId')
  assertExactKeys(value.pointer, ['key', 'etag', 'fencingToken', 'promotedAt'], 'active pointer')
  requiredString(value.pointer.key, 'active pointer key')
  requiredString(value.pointer.etag, 'active pointer ETag')
  if (value.pointer.etag.includes('"')) throw new Error('Active pointer ETag must be normalized')
  requiredNonNegativeInteger(value.pointer.fencingToken, 'active fencingToken')
  requiredIso(value.pointer.promotedAt, 'active promotedAt')
  for (const key of ['publicManifest', 'stateManifest', 'rawReceipt', 'publishReceipt']) parseAuthorityReference(value[key], `active ${key}`)
  requiredDigest(value.sourceReceiptDigest, 'active sourceReceiptDigest')
  parseModel(value.model)
  requiredPositiveInteger(value.rankingSchemaVersion, 'active rankingSchemaVersion')
  parseCoverage(value.coverage)
  requiredString(value.dataMode, 'active dataMode')
  if (typeof value.seeded !== 'boolean') throw new Error('Invalid active seeded')
}

function parsePrevious(value) {
  assertExactKeys(value, ['generationId', 'promotedAt', 'complete', 'publicManifest', 'stateManifest', 'rawReceipt', 'publishReceipt', 'sourceReceiptDigest', 'model'], 'previous authority')
  requiredSafeId(value.generationId, 'previous generationId')
  requiredIso(value.promotedAt, 'previous promotedAt')
  if (value.complete !== true) throw new Error('Previous generation must be complete')
  for (const key of ['publicManifest', 'stateManifest', 'rawReceipt']) parseAuthorityReference(value[key], `previous ${key}`)
  parseOptionalAuthority(value.publishReceipt, 'previous publishReceipt')
  requiredDigest(value.sourceReceiptDigest, 'previous sourceReceiptDigest')
  parseModel(value.model)
}

function parseLatestAudit(value) {
  if (value?.status === 'absent') {
    assertExactKeys(value, ['status', 'searchedPrefix', 'verifiedAt'], 'absent full audit authority')
    if (!value.searchedPrefix.endsWith('/audits/days/')) throw new Error('Invalid full audit searched prefix')
    requiredIso(value.verifiedAt, 'full audit absence verifiedAt')
    return
  }
  assertExactKeys(value, ['status', 'key', 'sha256', 'bytes', 'auditDate', 'generationId', 'model'], 'present full audit authority')
  if (value.status !== 'present' || !value.key.endsWith(`/audits/days/${value.auditDate}.json`)) throw new Error('Invalid present full audit authority')
  requiredDigest(value.sha256, 'full audit digest')
  requiredPositiveInteger(value.bytes, 'full audit bytes')
  requiredSafeId(value.generationId, 'full audit generationId')
  parseModel(value.model)
}

function parseRecovery(value) {
  assertExactKeys(value, ['order', 'scheduledFreshnessRemainsStrict', 'verifiedRawFullReplayRequires'], 'recovery contract')
  if (canonicalJsonFor(value.order) !== canonicalJsonFor(['previous-complete-generation', 'authorized-full-replay-from-active-verified-raw'])
    || value.scheduledFreshnessRemainsStrict !== true
    || canonicalJsonFor(value.verifiedRawFullReplayRequires) !== canonicalJsonFor(['force', 'recovery-authorization'])) {
    throw new Error('Invalid recovery contract')
  }
}

function parseProducingCode(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some((path) => {
    try {
      requiredSafeRelativePath(path, 'producing code path')
      return !path.startsWith('scripts/')
    } catch {
      return true
    }
  })) {
    throw new Error('Invalid producing code inventory')
  }
  if (new Set(value).size !== value.length) throw new Error('Duplicate producing code path')
}

function parseIntegrity(value) {
  if (!Array.isArray(value) || value.length !== 8) throw new Error('Baseline integrity must contain exactly eight checks')
  for (const entry of value) {
    assertExactKeys(entry, ['scope', 'key', 'result'], 'integrity result')
    requiredSafeId(entry.scope, 'integrity scope')
    requiredString(entry.key, 'integrity key')
    if (entry.result !== 'verified') throw new Error('Baseline integrity contains an unverified result')
  }
  if (new Set(value.map(({ scope }) => scope)).size !== value.length) throw new Error('Duplicate baseline integrity scope')
}

export function assertAuthorityAgreement({ generationId, manifest, stateManifest, rawReceipt, pointer, publishReceipt }) {
  if (manifest.generationId !== generationId || manifest.runId !== generationId
    || stateManifest.generationId !== generationId || rawReceipt.generationId !== generationId
    || pointer.generationId !== generationId || (publishReceipt && publishReceipt.generationId !== generationId)) {
    throw new Error('Crossed generation authorities')
  }
  if (manifest.model?.version !== stateManifest.compatibility?.modelVersion
    || manifest.model?.configHash !== stateManifest.compatibility?.modelConfigHash) {
    throw new Error('Public and state model authorities disagree')
  }
  if (stateManifest.sourceReceiptDigest !== rawReceipt.sourceReceiptDigest) {
    throw new Error('State and raw source receipt authorities disagree')
  }
}

export function assertPublishReceiptBindings(receipt, expected) {
  for (const name of ['publicManifest', 'rawReceipt']) {
    const actual = receipt?.authorities?.[name]
    const authority = expected?.[name]
    if (!actual || !authority
      || actual.key !== authority.key
      || actual.digest !== authority.digest
      || actual.bytes !== authority.bytes) {
      throw new Error(`Publish receipt ${name} authority does not match selected baseline authority`)
    }
  }
}

export function assertStablePointer(first, final) {
  if (!final.found || normalizeEtag(first.etag) !== normalizeEtag(final.etag)
    || canonicalJsonFor(first.value) !== canonicalJsonFor(final.value)) {
    throw new Error('Active generation changed during baseline capture')
  }
}

function coverageAuthority(value) {
  assertExactKeys(value, ['coverageStart', 'coverageEnd', 'latestMatchDate', 'matchCount', 'seededSample', 'sourceProviders'], 'ranking coverage')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.coverageStart ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(value.coverageEnd ?? '')) {
    throw new Error('Invalid ranking coverage dates')
  }
  requiredNonNegativeInteger(value.matchCount, 'ranking coverage matchCount')
  if (typeof value.seededSample !== 'boolean' || !Array.isArray(value.sourceProviders)
    || value.sourceProviders.some((provider) => typeof provider !== 'string' || provider.length === 0)) {
    throw new Error('Invalid ranking coverage authority')
  }
  return {
    start: value.coverageStart,
    end: value.coverageEnd,
    matchCount: value.matchCount,
    seeded: value.seededSample,
  }
}

function parseCoverage(value) {
  assertExactKeys(value, ['start', 'end', 'matchCount', 'seeded'], 'baseline coverage')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.start ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(value.end ?? '')) throw new Error('Invalid baseline coverage dates')
  requiredNonNegativeInteger(value.matchCount, 'baseline coverage matchCount')
  if (typeof value.seeded !== 'boolean') throw new Error('Invalid baseline coverage seeded')
}

function modelAuthority(value) {
  return { version: requiredString(value.version, 'model version'), configHash: requiredString(value.configHash, 'model configHash') }
}

function parseModel(value) {
  assertExactKeys(value, ['version', 'configHash'], 'model authority')
  modelAuthority(value)
}

function authorityReference(key, sha, bytes) {
  const value = {
    key: requiredString(key, 'authority key'),
    sha256: requiredDigest(sha, 'authority digest'),
    bytes: requiredPositiveInteger(bytes, 'authority bytes'),
  }
  return value
}

function parseAuthorityReference(value, label) {
  assertExactKeys(value, ['key', 'sha256', 'bytes'], label)
  authorityReference(value.key, value.sha256, value.bytes)
}

function parseOptionalAuthority(value, label) {
  if (value?.status === 'present') {
    assertExactKeys(value, ['status', 'key', 'sha256', 'bytes'], label)
    parseAuthorityReference({ key: value.key, sha256: value.sha256, bytes: value.bytes }, label)
    return
  }
  assertExactKeys(value, ['status', 'key', 'verifiedAt'], label)
  if (value.status !== 'absent') throw new Error(`Invalid ${label} status`)
  requiredString(value.key, `${label} key`)
  requiredIso(value.verifiedAt, `${label} verifiedAt`)
}

function integrityResult(scope, key) {
  return { scope, key, result: 'verified' }
}

function normalizeEtag(value) {
  const normalized = requiredString(value, 'ETag').replace(/^"|"$/g, '')
  if (!/^[A-Za-z0-9-]+$/.test(normalized)) throw new Error('Invalid ETag')
  return normalized
}

function relativeBucketKey(config, key) {
  const prefix = config.prefix ? `${config.prefix}/` : ''
  if (typeof key !== 'string' || !key.startsWith(prefix)) throw new Error('Bucket object is outside the canonical prefix')
  return key.slice(prefix.length)
}

function requiredOption(value, label) {
  if (!value) throw new Error(`Capture requires ${label}`)
  return value
}

function requiredCommit(value, label) {
  if (typeof value !== 'string' || !COMMIT.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

function requiredDigest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

function requiredSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

function requiredUuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${label}`)
  return value
}

function requiredSafeRelativePath(value, label) {
  requiredString(value, label)
  if (value.startsWith('/') || value.includes('\\')) throw new Error(`Invalid ${label}: path must be relative and use forward slashes`)
  const segments = value.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) {
    throw new Error(`Invalid ${label}: path contains an unsafe segment`)
  }
  return value
}

function requiredSafeRelativePrefix(value, label) {
  requiredString(value, label)
  if (!value.endsWith('/')) throw new Error(`Invalid ${label}: prefix must end with one slash`)
  requiredSafeRelativePath(value.slice(0, -1), label)
  return value
}

function requiredIso(value, label) {
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime()) || new Date(value).toISOString() !== value) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function requiredPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${label}`)
  return value
}

function requiredNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}`)
  return value
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`)
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`Invalid ${label} fields`)
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function bodyBytes(body) {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body)
  if (typeof body?.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray())
  const chunks = []
  for await (const chunk of body) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function mapConcurrent(values, concurrency, operation) {
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (index < values.length) {
      const current = index
      index += 1
      await operation(values[current], current)
    }
  })
  await Promise.all(workers)
}
