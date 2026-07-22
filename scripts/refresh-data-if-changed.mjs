import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { manifestWithResolvedFiles } from './local-data-manifest.js'
import { bucketConfigFromEnv, downloadBucketDirectory, downloadBucketObject, readBucketBytes, readBucketJson, uploadRankingArtifacts } from './railway-bucket.mjs'
import {
  recordRolloutOutcome,
} from './durable-ranking-state.mjs'
import { createNormalizedOracleChunks } from './normalized-provider-chunks.mjs'

const wrapperOnlyArgs = new Set([
  'force',
  'bucket-required',
  'bucketRequired',
  'manifest',
  'output',
  'public-data-dir',
  'raw-dir',
  'lookback-days',
  'lookbackDays',
  'merge-existing-raw',
  'mergeExistingRaw',
  'skip-bucket-upload',
  'skipBucketUpload',
  'skip-crunch',
  'staging-dir',
  'state',
])

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await refreshDataIfChanged(process.argv.slice(2))
}

export async function refreshDataIfChanged(rawArgs = [], options = {}) {
  const args = parseArgs(rawArgs)
  const env = options.env ?? process.env
  const leaseGuard = refreshLeaseGuard(env)
  if (hasRefreshLeaseIdentity(env) && !leaseGuard) {
    throw new Error('Refresh publication requires active-generation.json lease authority')
  }
  const rawDir = resolve(stringArg(args.rawDir ?? env.RANKING_RAW_DIR ?? 'data/raw'))
  const manifestPath = resolve(stringArg(args.manifest ?? `${rawDir}/manifest.json`))
  const statePath = resolve(stringArg(args.state ?? env.RANKING_REFRESH_STATE ?? `${rawDir}/refresh-state.json`))
  const output = resolve(stringArg(args.output ?? env.RANKING_DERIVED_OUTPUT ?? 'data/derived/ranking-snapshot.full.json'))
  const reconciliationOutput = resolve(stringArg(args.reconciliationOutput ?? env.RANKING_RECONCILIATION_OUTPUT ?? `${rawDir}/reconciliation.json`))
  const publicDataDir = resolve(stringArg(args.publicDataDir ?? env.RANKING_PUBLIC_DATA_DIR ?? '.generated/ranking-data'))
  const privateStateDir = resolve(stringArg(env.RANKING_INCREMENTAL_STATE_DIR ?? '.ranking-crunch'))
  const durableCandidatePath = resolve(privateStateDir, 'durable-candidate.json')
  const crunchReceiptPath = resolve(privateStateDir, 'durable-crunch-receipt.json')
  const end = stringArg(args.end ?? env.RANKING_REFRESH_END ?? today())
  const force = booleanArg(args.force) || env.RANKING_FORCE_REFRESH === 'true'
  const skipCrunch = booleanArg(args.skipCrunch) || env.RANKING_SKIP_CRUNCH === 'true'
  const bucketUploadEnabled = !booleanArg(args.skipBucketUpload) && env.RANKING_BUCKET_UPLOAD_ENABLED !== 'false'
  const bucketRequired = booleanArg(args.bucketRequired) || env.RANKING_BUCKET_REQUIRED === 'true'
  const bucketConfig = options.bucketConfig ?? bucketConfigFromEnv(env)
  const restoreRawEnabled = env.RANKING_BUCKET_RESTORE_RAW !== 'false'
  const stagingDir = resolve(stringArg(args.stagingDir ?? `data/.refresh-staging-${process.pid}-${Date.now()}`))
  const stagingManifestPath = resolve(stagingDir, 'manifest.json')
  const configuredBootstrapStart = env.RANKING_REFRESH_BOOTSTRAP_START ?? env.RANKING_REFRESH_START
  const bootstrapStart = stringArg(configuredBootstrapStart ?? '2011-01-01')
  const extraDownloadArgs = [
    ...passThroughDownloadArgs(rawArgs),
    ...splitExtraArgs(env.RANKING_REFRESH_DOWNLOAD_ARGS),
  ]
  const localManifest = manifestWithResolvedFiles(await readJsonIfExists(manifestPath), rawDir)
  const hasUsableLocalRawBaseline = await manifestHasUsableSourceFiles(localManifest)
  const restoreResult = restoreRawEnabled && bucketConfig.enabled
    ? await selectPreferredRawBaseline({
        rawDir,
        manifestPath,
        statePath,
        localManifest,
        hasUsableLocalRawBaseline,
        bootstrapStart,
        config: bucketConfig,
        client: options.bucketClient,
        promotionOperations: options.rawPromotionOperations,
      })
    : { restored: false, reason: restoreRawEnabled ? 'bucket-disabled' : 'disabled' }
  const previousManifest = manifestWithResolvedFiles(await readJsonIfExists(manifestPath), rawDir)
  const hasExistingRawBaseline = await manifestHasUsableSourceFiles(previousManifest)
    && (configuredBootstrapStart === undefined || manifestHasBootstrapCoverage(previousManifest, bootstrapStart))
  const window = refreshDateWindow({
    args,
    env,
    end,
    hasExistingRawBaseline,
  })
  const start = window.start
  const mergeExistingRaw = booleanArg(args.mergeExistingRaw)
    || env.RANKING_REFRESH_MERGE_RAW === 'true'
    || (window.lookbackDays !== null && hasExistingRawBaseline)

  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(stagingDir, { recursive: true })

  try {
    await (options.run ?? runCommand)(process.execPath, [
      'scripts/download-local-data.mjs',
      '--start',
      start,
      '--end',
      end,
      '--out-dir',
      stagingDir,
      '--manifest',
      stagingManifestPath,
      ...extraDownloadArgs,
    ])

    const stagingManifest = await readJson(stagingManifestPath)
    const previousState = await readJsonIfExists(statePath)
    const healthFingerprint = createSourceHealthFingerprint(stagingManifest)
    if (!manifestHasCurrentMatchSourceFiles(stagingManifest)) {
      const state = createStaleSourceState({
        previousState,
        previousManifest,
        stagingManifest,
        start,
        end,
        window,
        mergeExistingRaw,
        restoreResult,
        healthFingerprint,
      })
      await mkdir(dirname(statePath), { recursive: true })
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)
      console.warn(`No current Oracle or Leaguepedia source files were downloaded for ${start} through ${end}; preserving existing ranking artifacts.`)
      return {
        changed: false,
        status: 'stale-source',
        reason: 'no-current-match-source-data',
        durableCandidate: { kind: 'not-produced', reason: 'stale-source' },
        healthFingerprint,
        previousFingerprint: previousState?.fingerprint,
      }
    }

    const fingerprint = await createSourceFingerprint(stagingManifest, {
      additionalFiles: env.RANKING_STATIC_PLAYER_JSON
        ? [{ kind: 'static-player-rosters', path: resolve(env.RANKING_STATIC_PLAYER_JSON) }]
        : [],
    })
    const changed = force || previousState?.fingerprint !== fingerprint.fingerprint

    const stagedManifestForRawDir = rewriteManifestPaths(stagingManifest, stagingDir, rawDir)
    const mergedManifest = mergeExistingRaw
      ? mergeRawManifests(previousManifest, stagedManifestForRawDir)
      : stagedManifestForRawDir
    const normalizedOracle = await createNormalizedOracleChunks({
      manifest: mergedManifest,
      rawDir,
      stagingDir,
    })
    const finalManifest = {
      ...mergedManifest,
      files: {
        ...mergedManifest.files,
        normalizedOracleCsv: normalizedOracle.files,
      },
      normalizedProviderChunks: {
        schemaVersion: 1,
        generatedAt: stagingManifest.generatedAt ?? new Date().toISOString(),
        chunks: normalizedOracle.chunks,
      },
    }

    if (mergeExistingRaw) {
      await mkdir(rawDir, { recursive: true })
      await cp(stagingDir, rawDir, { recursive: true, force: true })
    } else {
      await rm(rawDir, { recursive: true, force: true })
      await mkdir(dirname(rawDir), { recursive: true })
      await rename(stagingDir, rawDir)
    }
    await writeFile(manifestPath, `${JSON.stringify(finalManifest, null, 2)}\n`)

    const state = {
      schemaVersion: 1,
      status: changed ? 'refreshed' : 'preflight',
      refreshedAt: new Date().toISOString(),
      fingerprint: fingerprint.fingerprint,
      healthFingerprint: fingerprint.healthFingerprint,
      previousFingerprint: previousState?.fingerprint,
      downloadStart: start,
      downloadEnd: end,
      coverageStart: finalManifest.start,
      coverageEnd: finalManifest.end,
      lookbackDays: window.lookbackDays,
      bootstrapStart: window.bootstrapStart,
      mergeExistingRaw,
      restoredRaw: restoreResult,
      files: fingerprint.files,
      sources: stagingManifest?.sources ?? {},
      warnings: arrayValue(stagingManifest?.warnings),
      crunch: skipCrunch
        ? { skipped: true }
        : {
            skipped: false,
            output,
            publicDataDir,
          },
    }

    let durableCandidate
    if (!skipCrunch) {
      await rm(durableCandidatePath, { force: true })
      await rm(crunchReceiptPath, { force: true })
      const buildArgs = [
        'exec',
        'tsx',
        'scripts/build-static-snapshot.ts',
        '--output',
        output,
        '--public-data-dir',
        publicDataDir,
        '--manifest',
        manifestPath,
        '--reconciliation-output',
        reconciliationOutput,
        '--durable-candidate-output',
        durableCandidatePath,
        '--receipt',
        crunchReceiptPath,
      ]
      if (env.RANKING_STATIC_PLAYER_JSON) buildArgs.push('--static-player-json', env.RANKING_STATIC_PLAYER_JSON)
      await (options.run ?? runCommand)('pnpm', buildArgs)
      durableCandidate = validateDurableCandidateReceipt(await readJsonIfExists(durableCandidatePath))
      if (!durableCandidate) {
        throw new Error('Crunch completed without a valid durable candidate receipt')
      }
    }

    const crunchReceipt = skipCrunch ? undefined : await readJsonIfExists(crunchReceiptPath)
    if (crunchReceipt) state.crunch.receipt = crunchReceipt

    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)

    if (!skipCrunch && bucketUploadEnabled) {
      if (!bucketConfig.enabled && bucketRequired) {
        throw new Error(`Railway bucket upload is required but missing: ${bucketConfig.missing.join(', ')}`)
      }

      if (!bucketConfig.enabled) {
        state.bucket = {
          enabled: false,
          missing: bucketConfig.missing,
        }
        if (env.RANKING_BUCKET_UPLOAD_ENABLED === 'true') {
          console.warn(`Railway bucket upload skipped; missing ${bucketConfig.missing.join(', ')}.`)
        }
      } else {
        const semanticNoChange = durableCandidate?.eligibility === 'no-change'
        const browserManifest = semanticNoChange ? undefined : await readJson(resolve(publicDataDir, 'ranking-summary.json'))
        const generationId = !semanticNoChange && env.RANKING_REFRESH_FENCING_TOKEN
          ? stringArg(browserManifest?.artifactMeta?.runId)
          : undefined
        const eligibleCandidate = durableCandidate?.eligibility === 'eligible' ? durableCandidate : undefined
        const mismatchCandidate = durableCandidate?.eligibility === 'ineligible'
          && durableCandidate.outcome === 'parity-mismatch'
          && durableCandidate.parity?.result === 'mismatch'
          ? durableCandidate
          : undefined
        const rolloutCandidate = eligibleCandidate
          ?? (semanticNoChange && durableCandidate?.parity?.result === 'match' ? durableCandidate : undefined)
          ?? mismatchCandidate
        const bucketPublish = await uploadRankingArtifacts({
          publicDataDir,
          rawDir,
          fullSnapshotPath: semanticNoChange ? undefined : output,
          manifestPath,
          statePath,
          config: bucketConfig,
          client: options.bucketClient,
          uploadFullSnapshot: env.RANKING_BUCKET_UPLOAD_FULL_SNAPSHOT === 'true',
          generationId,
          publishGeneration: !semanticNoChange,
          fencingToken: env.RANKING_REFRESH_FENCING_TOKEN ? Number(env.RANKING_REFRESH_FENCING_TOKEN) : undefined,
          ...(leaseGuard ? { leaseGuard } : {}),
          rolloutUpdateId: durableCandidate?.runId,
          ...(eligibleCandidate ? {
            privateState: {
              manifestKey: eligibleCandidate.manifestKey,
              manifestDigest: eligibleCandidate.manifestDigest,
              manifestBytes: eligibleCandidate.manifestBytes,
              stateRoot: eligibleCandidate.stateRoot,
              identityHash: eligibleCandidate.identityHash,
              retention: eligibleCandidate.retention,
            },
          } : {}),
          ...(rolloutCandidate ? {
            rolloutForActive: (previousRollout) => recordRolloutOutcome(previousRollout, {
              identityHash: rolloutCandidate.identityHash,
              parity: rolloutCandidate.parity,
              at: new Date().toISOString(),
            }),
          } : {}),
          refreshStateForUpload: ({ bucket, prefix, artifactCount, uploadedCount, uploadedBytes, unchangedCount, unchangedBytes, skipped }) => {
            state.bucket = {
              enabled: true,
              bucket,
              prefix,
              artifactCount,
              uploadedCount,
              uploadedBytes,
              unchangedCount,
              unchangedBytes,
              skipped,
            }
            return state
          },
          rawRetentionDays: positiveInteger(env.RANKING_DURABLE_RETENTION_DAYS) ?? 35,
        })
        state.bucket = {
          enabled: true,
          bucket: bucketPublish.bucket,
          prefix: bucketPublish.prefix,
          artifactCount: bucketPublish.artifactCount,
          uploadedCount: bucketPublish.uploadedCount,
          uploadedBytes: bucketPublish.uploadedBytes,
          unchangedCount: bucketPublish.unchanged.length,
          unchangedBytes: bucketPublish.unchangedBytes,
          skipped: bucketPublish.skipped,
          ...(durableCandidate ? {
            durable: {
              uploadedObjects: durableCandidate.metrics?.uploadedObjects ?? 0,
              uploadedBytes: durableCandidate.metrics?.uploadedBytes ?? 0,
              skippedObjects: durableCandidate.metrics?.skippedObjects ?? 0,
              skippedBytes: durableCandidate.metrics?.skippedBytes ?? 0,
              parity: durableCandidate.parity?.result ?? 'not-run',
              promotion: bucketPublish.promotion,
            },
          } : {}),
        }
        if (eligibleCandidate && generationId) {
          state.bucket.durable.gc = { planned: 0, deleted: 0, skipped: 0, reason: 'deferred-to-exclusive-maintenance' }
        }
        if (crunchReceipt?.durable) {
          crunchReceipt.durable.promotion = semanticNoChange
            ? 'no-change'
            : bucketPublish.promotion?.promoted ? 'promoted'
              : bucketPublish.promotion?.idempotent ? 'no-change'
                : 'not-attempted'
          crunchReceipt.durable.gc = state.bucket.durable?.gc ?? { planned: 0, deleted: 0, skipped: 0 }
          state.crunch.receipt = crunchReceipt
          await writeFile(crunchReceiptPath, `${JSON.stringify(crunchReceipt, null, 2)}\n`)
        }
        const optionalSkippedMessage = bucketPublish.skipped?.length ? `; skipped ${bucketPublish.skipped.length} optional artifact(s)` : ''
        console.log(`Uploaded ${bucketPublish.uploadedCount} ranking artifact(s) (${bucketPublish.uploadedBytes} bytes); reused ${bucketPublish.unchangedCount} unchanged artifact(s) (${bucketPublish.unchangedBytes} bytes) in Railway bucket prefix ${bucketPublish.prefix || '(root)'}${optionalSkippedMessage}.`)
      }
    } else if (!skipCrunch) {
      state.bucket = {
        enabled: false,
        skipped: true,
      }
    }

    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)
    console.log(`${changed ? 'Source data changed' : 'Source data unchanged; crunch preflight completed'} for ${start} through ${end}.`)
    return {
      changed,
      status: changed ? 'refreshed' : 'preflight',
      durableCandidate: skipCrunch
        ? { kind: 'not-produced', reason: 'skip-crunch' }
        : { kind: 'produced', receipt: durableCandidate },
      fingerprint: fingerprint.fingerprint,
      healthFingerprint: fingerprint.healthFingerprint,
      previousFingerprint: previousState?.fingerprint,
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}

export async function createSourceFingerprint(manifest, { additionalFiles = [] } = {}) {
  const files = []
  for (const [kind, paths] of Object.entries(manifest?.files ?? {})) {
    if (!Array.isArray(paths)) continue
    for (const path of paths) {
      files.push({
        kind,
        name: basename(path),
        digest: await digestSourceFile(path),
      })
    }
  }
  for (const file of additionalFiles) {
    files.push({ kind: file.kind, name: basename(file.path), digest: await digestSourceFile(file.path) })
  }

  files.sort((left, right) => `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`))

  const content = {
    schemaVersion: manifest?.schemaVersion,
    start: manifest?.start,
    end: manifest?.end,
    files,
  }
  return {
    fingerprint: sha256(stableJson(content)),
    healthFingerprint: createSourceHealthFingerprint(manifest),
    files,
  }
}

export function createSourceHealthFingerprint(manifest) {
  return sha256(stableJson({
    sources: stripVolatileValues(manifest?.sources ?? {}),
    warnings: stripVolatileValues(manifest?.warnings ?? []),
  }))
}

export function refreshDateWindow({
  args = {},
  env = process.env,
  end = today(),
  hasExistingRawBaseline = false,
} = {}) {
  const lookbackDays = positiveInteger(args.lookbackDays ?? env.RANKING_REFRESH_LOOKBACK_DAYS)
  const bootstrapStart = stringArg(env.RANKING_REFRESH_BOOTSTRAP_START ?? env.RANKING_REFRESH_START ?? '2011-01-01')

  if (args.start !== undefined) {
    return {
      start: stringArg(args.start),
      end,
      lookbackDays,
      bootstrapStart,
      mode: 'explicit-start',
    }
  }

  if (lookbackDays !== null) {
    return {
      start: hasExistingRawBaseline ? dateDaysBefore(end, lookbackDays) : bootstrapStart,
      end,
      lookbackDays,
      bootstrapStart,
      mode: hasExistingRawBaseline ? 'lookback' : 'bootstrap',
    }
  }

  return {
    start: stringArg(env.RANKING_REFRESH_START ?? '2011-01-01'),
    end,
    lookbackDays,
    bootstrapStart,
    mode: 'full-window',
  }
}

async function selectPreferredRawBaseline({ rawDir, manifestPath, statePath, localManifest, hasUsableLocalRawBaseline, bootstrapStart, config, client, promotionOperations }) {
  let active
  try {
    active = await readBucketJson('active-generation.json', { config, client })
  } catch (error) {
    return handleRawInspectionFailure({
      error,
      hasUsableLocalRawBaseline,
      rawDir,
      manifestPath,
      statePath,
      config,
      client,
    })
  }
  if (active.found && active.value?.rawState) {
    let inspected
    try {
      inspected = await inspectRawGeneration({ rawDir, rawState: active.value.rawState, config, client })
    } catch (error) {
      return handleRawInspectionFailure({
        error,
        hasUsableLocalRawBaseline,
        rawDir,
        manifestPath,
        statePath,
        config,
        client,
      })
    }
    if (!inspected.valid) {
      return {
        restored: false,
        reason: inspected.reason,
        selection: hasUsableLocalRawBaseline ? 'local' : 'none',
      }
    }
    const comparison = compareRawBaselineManifests({
      localManifest,
      remoteManifest: inspected.manifest,
      localUsable: hasUsableLocalRawBaseline,
      remoteUsable: true,
      bootstrapStart,
    })
    if (comparison.preferred !== 'remote') {
      return {
        restored: false,
        reason: comparison.reason,
        selection: comparison.preferred,
        comparison,
      }
    }
    let restored
    try {
      restored = await restoreRawGeneration({
        rawDir,
        manifestPath,
        statePath,
        rawState: active.value.rawState,
        inspected,
        config,
        client,
        promotionOperations,
      })
    } catch (error) {
      if (!(error instanceof RawGenerationSourceReadError)
        || !hasUsableLocalRawBaseline
        || !await manifestHasUsableSourceFiles(localManifest)) throw error
      return {
        restored: false,
        reason: 'remote-restore-failed',
        selection: 'local',
        restore: {
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        },
        comparison,
      }
    }
    if (restored.restored) {
      console.log(`Restored ${restored.downloadedCount} raw baseline file(s) from active Railway raw generation.`)
      return { ...restored, comparison }
    }
    return {
      ...restored,
      ...(hasUsableLocalRawBaseline ? { selection: 'local' } : {}),
      comparison,
    }
  }

  if (hasUsableLocalRawBaseline) {
    return {
      restored: false,
      reason: 'active-raw-generation-missing',
      selection: 'local',
    }
  }

  return restoreLegacyRawBaseline({ rawDir, manifestPath, statePath, config, client })
}

async function handleRawInspectionFailure({ error, hasUsableLocalRawBaseline, rawDir, manifestPath, statePath, config, client }) {
  const inspection = {
    status: 'failed',
    message: error instanceof Error ? error.message : String(error),
  }
  if (hasUsableLocalRawBaseline) {
    return {
      restored: false,
      reason: 'remote-inspection-failed',
      selection: 'local',
      inspection,
    }
  }
  const fallback = await restoreLegacyRawBaseline({ rawDir, manifestPath, statePath, config, client })
  return { ...fallback, inspection }
}

async function restoreLegacyRawBaseline({ rawDir, manifestPath, statePath, config, client }) {
  const result = await downloadBucketDirectory({
    destinationDir: rawDir,
    sourcePrefix: 'raw/files',
    config,
    client,
  })

  if (!result.enabled) {
    return {
      restored: false,
      reason: 'bucket-disabled',
      missing: result.missing,
    }
  }

  if (result.downloaded.length === 0) {
    return {
      restored: false,
      reason: 'bucket-empty',
      bucket: result.bucket,
      prefix: result.prefix,
    }
  }

  const manifestResult = await downloadBucketObject({
    relativeKey: 'raw/manifest.json',
    destinationPath: manifestPath,
    config,
    client,
  })
  const stateResult = await downloadBucketObject({
    relativeKey: 'raw/refresh-state.json',
    destinationPath: statePath,
    config,
    client,
  })

  console.log(`Restored ${result.downloaded.length} raw baseline file(s) from Railway bucket prefix ${result.prefix || '(root)'}.`)
  return {
    restored: true,
    bucket: result.bucket,
    prefix: result.prefix,
    downloadedCount: result.downloaded.length,
    manifestRestored: manifestResult.found,
    stateRestored: stateResult.found,
  }
}

async function inspectRawGeneration({ rawDir, rawState, config, client }) {
  if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)
    || typeof rawState.descriptorKey !== 'string'
    || typeof rawState.descriptorDigest !== 'string'
    || !isSha256(rawState.descriptorDigest)
    || !Number.isSafeInteger(rawState.descriptorBytes) || rawState.descriptorBytes <= 0
    || rawState.descriptorKey !== `raw/generations/${rawState.descriptorDigest}.json`) {
    return { valid: false, reason: 'raw-generation-pointer-invalid' }
  }
  const descriptorObject = await readBucketBytes(rawState.descriptorKey, { config, client })
  if (!descriptorObject.found || descriptorObject.contentLength !== rawState.descriptorBytes
    || sha256(descriptorObject.bytes) !== rawState.descriptorDigest) {
    return { valid: false, reason: 'raw-generation-descriptor-invalid' }
  }
  let descriptor
  try {
    descriptor = JSON.parse(Buffer.from(descriptorObject.bytes).toString('utf8'))
  } catch {
    return { valid: false, reason: 'raw-generation-descriptor-invalid' }
  }
  if (descriptor?.schemaVersion !== 1 || descriptor?.kind !== 'raw-generation' || !Array.isArray(descriptor.objects)) {
    return { valid: false, reason: 'raw-generation-descriptor-invalid' }
  }
  const manifestRefs = descriptor.objects.filter((ref) => ref?.kind === 'manifest')
  const sourceRefs = descriptor.objects.filter((ref) => ref?.kind === 'source')
  const stateRefs = descriptor.objects.filter((ref) => ref?.kind === 'refresh-state')
  if (manifestRefs.length !== 1 || sourceRefs.length === 0 || stateRefs.length > 1
    || !descriptor.objects.every(validRawGenerationReference)
    || stateRefs.some((ref) => ref.logicalPath !== 'refresh-state.json')) {
    return { valid: false, reason: 'raw-generation-reference-invalid' }
  }
  const logicalPaths = sourceRefs.map((ref) => ref.logicalPath)
  if (new Set(descriptor.objects.map((ref) => ref.logicalPath)).size !== descriptor.objects.length
    || logicalPaths.some((path) => ['manifest.json', 'refresh-state.json'].includes(path))) {
    return { valid: false, reason: 'raw-generation-reference-invalid' }
  }
  const manifestRef = manifestRefs[0]
  if (manifestRef.logicalPath !== 'manifest.json') {
    return { valid: false, reason: 'raw-generation-reference-invalid' }
  }
  const manifestObject = await readBucketBytes(manifestRef.key, { config, client })
  if (!manifestObject.found || manifestObject.contentLength !== manifestRef.bytes
    || sha256(manifestObject.bytes) !== manifestRef.digest) {
    return { valid: false, reason: 'raw-generation-manifest-invalid' }
  }
  let manifest
  try {
    manifest = JSON.parse(Buffer.from(manifestObject.bytes).toString('utf8'))
  } catch {
    return { valid: false, reason: 'raw-generation-manifest-invalid' }
  }
  if (manifest?.schemaVersion !== 1 || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    return { valid: false, reason: 'raw-generation-manifest-invalid' }
  }
  const manifestFileGroups = Object.values(manifest.files)
  if (manifestFileGroups.some((paths) => !Array.isArray(paths))) {
    return { valid: false, reason: 'raw-generation-manifest-invalid' }
  }
  const manifestPaths = manifestFileGroups.flat()
  if (manifestPaths.some((path) => typeof path !== 'string' || !safeRawLogicalPath(path, rawDir))
    || new Set(manifestPaths).size !== manifestPaths.length
    || !sameStringSet(manifestPaths, logicalPaths)) {
    return { valid: false, reason: 'raw-generation-manifest-invalid' }
  }
  return { valid: true, descriptor, manifest, manifestObject }
}

async function restoreRawGeneration({ rawDir, manifestPath, statePath, rawState, inspected, config, client, promotionOperations }) {
  const generation = inspected ?? await inspectRawGeneration({ rawDir, rawState, config, client })
  if (!generation.valid) return { restored: false, reason: generation.reason }
  const descriptor = generation.descriptor
  const staging = `${rawDir}.restore-${process.pid}-${Date.now()}`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  let downloadedCount = 0
  try {
    for (const ref of descriptor.objects) {
      let object
      try {
        object = ref.kind === 'manifest' ? generation.manifestObject : await readBucketBytes(ref.key, { config, client })
      } catch (error) {
        if (ref.kind === 'source') throw new RawGenerationSourceReadError(error)
        throw error
      }
      if (!object.found || object.contentLength !== ref.bytes || sha256(object.bytes) !== ref.digest) {
        return { restored: false, reason: 'raw-generation-object-invalid' }
      }
      if (ref.kind === 'source') {
        const destination = resolve(staging, ref.logicalPath)
        if (!destination.startsWith(`${resolve(staging)}${sep}`)) return { restored: false, reason: 'raw-generation-reference-invalid' }
        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, object.bytes)
        downloadedCount += 1
      } else if (ref.kind === 'manifest') {
        const restoredManifest = {
          ...generation.manifest,
          files: Object.fromEntries(Object.entries(generation.manifest.files ?? {}).map(([kind, paths]) => [
            kind,
            Array.isArray(paths) ? paths.map((path) => resolve(rawDir, String(path))) : [],
          ])),
        }
        await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(restoredManifest, null, 2)}\n`)
      } else if (ref.kind === 'refresh-state') {
        await writeFile(join(staging, 'refresh-state.json'), object.bytes)
      }
    }
    if (downloadedCount === 0) return { restored: false, reason: 'raw-generation-empty' }
    await promoteRawGenerationDirectory({ staging, rawDir, manifestPath, statePath }, promotionOperations)
    return { restored: true, source: 'active-raw-generation', downloadedCount, manifestRestored: true, stateRestored: await pathExists(statePath) }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function promoteRawGenerationDirectory({ staging, rawDir, manifestPath, statePath }, {
  renameDirectory = rename,
  copyFile = cp,
  removePath = rm,
} = {}) {
  const transactionId = `${process.pid}-${Date.now()}`
  const previousDir = `${rawDir}.previous-${transactionId}`
  const defaultManifestPath = resolve(rawDir, 'manifest.json')
  const defaultStatePath = resolve(rawDir, 'refresh-state.json')
  const metadataBackupDir = `${rawDir}.metadata-previous-${transactionId}`
  const customMetadataPaths = [
    ...(resolve(manifestPath) === defaultManifestPath ? [] : [manifestPath]),
    ...(resolve(statePath) === defaultStatePath ? [] : [statePath]),
  ]
  const externalBackups = []
  await bestEffortRemove(removePath, previousDir)
  await bestEffortRemove(removePath, metadataBackupDir)
  for (const [index, path] of customMetadataPaths.entries()) {
    const backupPath = join(metadataBackupDir, `${index}.json`)
    const existed = await pathExists(path)
    if (existed) {
      await mkdir(dirname(backupPath), { recursive: true })
      await copyFile(path, backupPath)
    }
    externalBackups.push({ path, backupPath, existed })
  }

  let hasPrevious = false
  let promoted = false
  try {
    try {
      await renameDirectory(rawDir, previousDir)
      hasPrevious = true
    } catch (error) {
      if (filesystemErrorCode(error) !== 'ENOENT') throw error
    }
    await renameDirectory(staging, rawDir)
    promoted = true

    if (resolve(manifestPath) !== defaultManifestPath) {
      await mkdir(dirname(manifestPath), { recursive: true })
      await copyFile(defaultManifestPath, manifestPath)
    }
    if (resolve(statePath) !== defaultStatePath) {
      if (await pathExists(defaultStatePath)) {
        await mkdir(dirname(statePath), { recursive: true })
        await copyFile(defaultStatePath, statePath)
      } else {
        await removePath(statePath, { force: true })
      }
    }
  } catch (error) {
    let rollbackSucceeded = true
    if (promoted) {
      if (!await rollbackWithoutMasking(() => renameDirectory(rawDir, staging), 'evacuate failed raw promotion')) rollbackSucceeded = false
    }
    if (hasPrevious) {
      if (!await rollbackWithoutMasking(() => renameDirectory(previousDir, rawDir), 'restore previous raw baseline')) rollbackSucceeded = false
    }
    for (const backup of externalBackups) {
      if (!await rollbackWithoutMasking(async () => {
        if (backup.existed) await copyFile(backup.backupPath, backup.path)
        else await removePath(backup.path, { force: true })
      }, `restore external raw metadata ${backup.path}`)) rollbackSucceeded = false
    }
    if (rollbackSucceeded) {
      await bestEffortRemove(removePath, previousDir)
      await bestEffortRemove(removePath, metadataBackupDir)
    }
    throw error
  }

  await bestEffortRemove(removePath, previousDir)
  await bestEffortRemove(removePath, metadataBackupDir)
}

export function compareRawBaselineManifests({ localManifest, remoteManifest, localUsable, remoteUsable, bootstrapStart }) {
  if (remoteUsable && !localUsable) {
    const remote = rawBaselineEvidence(remoteManifest, bootstrapStart)
    return remote.valid
      ? { preferred: 'remote', reason: 'remote-only-usable-baseline', local: { usable: false }, remote }
      : { preferred: 'none', reason: 'remote-baseline-malformed', local: { usable: false }, remote }
  }
  if (localUsable && !remoteUsable) {
    return { preferred: 'local', reason: 'remote-baseline-unusable', local: rawBaselineEvidence(localManifest, bootstrapStart), remote: { usable: false } }
  }
  if (!localUsable && !remoteUsable) {
    return { preferred: 'none', reason: 'no-usable-raw-baseline', local: { usable: false }, remote: { usable: false } }
  }

  const local = rawBaselineEvidence(localManifest, bootstrapStart)
  const remote = rawBaselineEvidence(remoteManifest, bootstrapStart)
  if (!remote.valid) return { preferred: 'local', reason: 'remote-baseline-malformed', local, remote }
  if (!local.valid) return { preferred: 'local', reason: 'baseline-evidence-incomparable', local, remote }
  if (!remote.matchCoverageKnown || !local.matchCoverageKnown) {
    return { preferred: 'local', reason: 'baseline-evidence-incomparable', local, remote }
  }

  const coverageComparison = compareCoverage(remote, local)
  const oracleComparison = Math.sign(remote.oracleQuality - local.oracleQuality)
  const remoteHasOracleSuperset = setContains(remote.oracleFileIdentities, local.oracleFileIdentities)
  const localHasOracleSuperset = setContains(local.oracleFileIdentities, remote.oracleFileIdentities)
  const oracleFilesEquivalent = remoteHasOracleSuperset && localHasOracleSuperset
  const remoteHasMatchCoverageSuperset = intervalsContain(remote.matchCoverageIntervals, local.matchCoverageIntervals)
  const localHasMatchCoverageSuperset = intervalsContain(local.matchCoverageIntervals, remote.matchCoverageIntervals)
  const matchCoverageEquivalent = remoteHasMatchCoverageSuperset && localHasMatchCoverageSuperset
  const remoteNonWorse = coverageComparison.bootstrap >= 0
    && coverageComparison.start >= 0
    && coverageComparison.end >= 0
    && remoteHasOracleSuperset
    && remoteHasMatchCoverageSuperset
    && oracleComparison >= 0
  const localNonWorse = coverageComparison.bootstrap <= 0
    && coverageComparison.start <= 0
    && coverageComparison.end <= 0
    && localHasOracleSuperset
    && localHasMatchCoverageSuperset
    && oracleComparison <= 0
  const remoteStrictlyBetter = coverageComparison.bootstrap > 0
    || coverageComparison.start > 0
    || coverageComparison.end > 0
    || !localHasOracleSuperset
    || !localHasMatchCoverageSuperset
    || oracleComparison > 0
  const localStrictlyBetter = coverageComparison.bootstrap < 0
    || coverageComparison.start < 0
    || coverageComparison.end < 0
    || !remoteHasOracleSuperset
    || !remoteHasMatchCoverageSuperset
    || oracleComparison < 0

  if (remoteNonWorse && remoteStrictlyBetter) {
    return { preferred: 'remote', reason: 'remote-baseline-dominates', local, remote }
  }
  if (localNonWorse && localStrictlyBetter) {
    return { preferred: 'local', reason: 'local-baseline-dominates', local, remote }
  }
  const equivalentEvidence = coverageComparison.bootstrap === 0
    && coverageComparison.start === 0
    && coverageComparison.end === 0
    && oracleFilesEquivalent
    && matchCoverageEquivalent
    && oracleComparison === 0
  if (equivalentEvidence) {
    if (remote.generatedAtMs > local.generatedAtMs) {
      return { preferred: 'remote', reason: 'remote-baseline-newer', local, remote }
    }
    return { preferred: 'local', reason: 'local-baseline-current', local, remote }
  }
  return { preferred: 'local', reason: 'baseline-evidence-incomparable', local, remote }
}

function rawBaselineEvidence(manifest, bootstrapStart) {
  const end = validDate(manifest?.end)
  const generatedAtMs = validTimestamp(manifest?.generatedAt)
  const start = validDate(manifest?.start)
  const oracleFiles = arrayValue(manifest?.files?.oracleCsv)
  const oracleFileIdentities = uniqueValues(oracleFiles.map(oracleFileIdentity).filter(Boolean)).sort()
  const leaguepediaFiles = arrayValue(manifest?.files?.leaguepediaJson)
  const leaguepediaStatus = String(manifest?.sources?.leaguepedia?.latestStatus ?? manifest?.sources?.leaguepedia?.status ?? '').toLowerCase()
  const parsedMatchCoverage = leaguepediaFiles.map(matchCoverageInterval)
  const matchCoverageKnown = parsedMatchCoverage.every(Boolean)
    && (leaguepediaFiles.length > 0 || leaguepediaStatus === 'skipped')
  const matchCoverageIntervals = matchCoverageKnown ? normalizeCoverageIntervals(parsedMatchCoverage) : []
  const oracle = manifest?.sources?.oracle
  const oracleStatus = String(oracle?.latestStatus ?? oracle?.status ?? '').toLowerCase()
  const hasOracleFiles = oracleFiles.length > 0
  const knownOracleStatus = ['', 'downloaded', 'partial', 'reused', 'preserved', 'failed', 'skipped', 'unavailable'].includes(oracleStatus)
  const oracleStatusRequiresFiles = ['downloaded', 'partial', 'reused', 'preserved'].includes(oracleStatus)
  const valid = Boolean(manifest?.schemaVersion === 1 && manifest?.files && typeof manifest.files === 'object'
    && !Array.isArray(manifest.files) && start && end && start <= end && generatedAtMs !== null && knownOracleStatus
    && !(oracleStatusRequiresFiles && !hasOracleFiles))
  const oracleQuality = oracleStatus === 'downloaded' && hasOracleFiles
    ? 2
    : hasOracleFiles ? 1 : 0
  return {
    usable: true,
    valid,
    fullBootstrapCoverage: valid ? manifestHasBootstrapCoverage(manifest, bootstrapStart) : false,
    start,
    end,
    generatedAt: generatedAtMs === null ? undefined : new Date(generatedAtMs).toISOString(),
    generatedAtMs,
    oracleQuality,
    oracleStatus: oracleStatus || 'unknown',
    hasOracleFiles,
    oracleFileIdentities,
    matchCoverageKnown,
    matchCoverageIntervals,
  }
}

function compareCoverage(left, right) {
  return {
    bootstrap: Number(left.fullBootstrapCoverage) - Number(right.fullBootstrapCoverage),
    start: right.start.localeCompare(left.start),
    end: left.end.localeCompare(right.end),
  }
}

function oracleFileIdentity(path) {
  const normalized = String(path).replaceAll('\\', '/')
  const marker = 'oracles-elixir/'
  const markerIndex = normalized.lastIndexOf(`/${marker}`)
  if (markerIndex >= 0) return normalized.slice(markerIndex + 1)
  if (normalized.startsWith(marker)) return normalized
  return basename(normalized)
}

function setContains(superset, subset) {
  const values = new Set(superset)
  return subset.every((value) => values.has(value))
}

function matchCoverageInterval(path) {
  const match = basename(String(path)).match(/^scoreboard-games-(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})\.json$/)
  if (!match) return undefined
  const start = validDate(match[1])
  const end = validDate(match[2])
  return start && end && start <= end ? { start, end } : undefined
}

function normalizeCoverageIntervals(intervals) {
  const normalized = []
  for (const interval of intervals.toSorted((left, right) => `${left.start}:${left.end}`.localeCompare(`${right.start}:${right.end}`))) {
    const previous = normalized.at(-1)
    if (!previous || interval.start > dateDaysBefore(previous.end, -1)) {
      normalized.push({ ...interval })
    } else if (interval.end > previous.end) {
      previous.end = interval.end
    }
  }
  return normalized
}

function intervalsContain(superset, subset) {
  return subset.every((required) => superset.some((available) => available.start <= required.start && available.end >= required.end))
}

class RawGenerationSourceReadError extends Error {
  constructor(cause) {
    super(`Remote raw source payload read failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'RawGenerationSourceReadError'
  }
}

function validRawGenerationReference(ref) {
  return Boolean(ref && typeof ref === 'object' && !Array.isArray(ref)
    && ['source', 'manifest', 'refresh-state'].includes(ref.kind)
    && typeof ref.logicalPath === 'string' && safeRawLogicalPath(ref.logicalPath)
    && typeof ref.key === 'string' && ref.key === `raw/objects/${ref.digest}`
    && isSha256(ref.digest)
    && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0)
}

function safeRawLogicalPath(path, root = '/raw-baseline-root') {
  if (!path || path.includes('\\') || path.includes('\0') || path.startsWith('/')) return false
  if (path.split('/').some((part) => !part || part === '.' || part === '..')) return false
  const destination = resolve(root, path)
  return destination.startsWith(`${resolve(root)}${sep}`)
}

function sameStringSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value))
}

function filesystemErrorCode(error) {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined
}

async function bestEffortRemove(removePath, path) {
  try {
    await removePath(path, { recursive: true, force: true })
  } catch {
    // Cleanup is secondary to the completed or rolled-back promotion.
  }
}

async function rollbackWithoutMasking(operation, description) {
  try {
    await operation()
    return true
  } catch (error) {
    console.warn(`Raw baseline rollback could not ${description}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? value : undefined
}

function validTimestamp(value) {
  if (typeof value !== 'string') return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function mergeRawManifests(previousManifest, nextManifest) {
  if (!manifestHasSourceFiles(previousManifest)) return nextManifest
  const preservedWarnings = preservedBaselineWarnings(previousManifest, nextManifest)

  return {
    ...nextManifest,
    start: minDate(previousManifest.start, nextManifest.start),
    end: maxDate(previousManifest.end, nextManifest.end),
    refreshWindow: {
      start: nextManifest.start,
      end: nextManifest.end,
    },
    files: mergeManifestFiles(previousManifest.files, nextManifest.files),
    sources: mergeManifestSources(previousManifest.sources, nextManifest.sources),
    warnings: uniqueValues([
      ...arrayValue(nextManifest.warnings),
      ...preservedWarnings,
    ]),
  }
}

function mergeManifestFiles(previousFiles = {}, nextFiles = {}) {
  const merged = {}
  for (const key of new Set([...Object.keys(previousFiles), ...Object.keys(nextFiles)])) {
    merged[key] = uniqueValues([
      ...arrayValue(nextFiles[key]),
      ...arrayValue(previousFiles[key]),
    ])
  }
  return merged
}

function mergeManifestSources(previousSources = {}, nextSources = {}) {
  const sources = {}
  for (const sourceName of new Set([...Object.keys(previousSources), ...Object.keys(nextSources)])) {
    const previousSource = previousSources?.[sourceName]
    const nextSource = nextSources?.[sourceName]
    if (!nextSource || typeof nextSource !== 'object') {
      sources[sourceName] = previousSource
      continue
    }
    sources[sourceName] = {
      ...nextSource,
      ...(previousSource?.status ? { previousStatus: previousSource.status } : {}),
      latestStatus: nextSource?.status,
    }
  }

  return sources
}

function preservedBaselineWarnings(previousManifest, nextManifest) {
  const warnings = []
  const windowText = `${nextManifest?.start ?? 'unknown'} through ${nextManifest?.end ?? 'unknown'}`
  if (arrayValue(previousManifest?.files?.oracleCsv).length > 0 && arrayValue(nextManifest?.files?.oracleCsv).length === 0) {
    warnings.push(`Oracle source preserved from previous raw baseline because no Oracle CSVs were downloaded for refresh window ${windowText}.`)
  }
  if (arrayValue(previousManifest?.files?.leaguepediaJson).length > 0 && arrayValue(nextManifest?.files?.leaguepediaJson).length === 0) {
    warnings.push(`Leaguepedia source preserved from previous raw baseline because no Leaguepedia files were downloaded for refresh window ${windowText}.`)
  }
  return warnings
}

function createStaleSourceState({
  previousState,
  previousManifest,
  stagingManifest,
  start,
  end,
  window,
  mergeExistingRaw,
  restoreResult,
  healthFingerprint,
}) {
  return {
    schemaVersion: 1,
    status: 'stale-source',
    reason: 'no-current-match-source-data',
    refreshedAt: new Date().toISOString(),
    previousFingerprint: previousState?.fingerprint,
    fingerprint: previousState?.fingerprint,
    healthFingerprint,
    downloadStart: start,
    downloadEnd: end,
    coverageStart: previousManifest?.start ?? previousState?.coverageStart,
    coverageEnd: previousManifest?.end ?? previousState?.coverageEnd,
    lookbackDays: window.lookbackDays,
    bootstrapStart: window.bootstrapStart,
    mergeExistingRaw,
    restoredRaw: restoreResult,
    files: stagingManifest?.files ?? {},
    sources: stagingManifest?.sources ?? {},
    warnings: arrayValue(stagingManifest?.warnings),
    crunch: {
      skipped: true,
      reason: 'no-current-match-source-data',
    },
    publish: {
      skipped: true,
      reason: 'no-current-match-source-data',
    },
  }
}

function manifestHasCurrentMatchSourceFiles(manifest) {
  return arrayValue(manifest?.files?.oracleCsv).length > 0
    || arrayValue(manifest?.files?.leaguepediaJson).length > 0
}

function manifestHasSourceFiles(manifest) {
  return Object.values(manifest?.files ?? {}).some((paths) => Array.isArray(paths) && paths.length > 0)
}

async function manifestHasUsableSourceFiles(manifest) {
  const paths = Object.values(manifest?.files ?? {})
    .flatMap((entries) => Array.isArray(entries) ? entries : [])
  if (paths.length === 0) return false

  for (const path of paths) {
    if (!await pathExists(path)) return false
  }
  return true
}

export function manifestHasBootstrapCoverage(manifest, bootstrapStart) {
  if (manifest?.sources?.leaguepedia?.status === 'skipped') return true
  return arrayValue(manifest?.files?.leaguepediaJson).some((path) => {
    const match = basename(path).match(/^scoreboard-games-(\d{4}-\d{2}-\d{2})_to_/)
    return Boolean(match && match[1] <= bootstrapStart)
  })
}

async function digestSourceFile(path) {
  const buffer = await readFile(path)
  if (!String(path).endsWith('.json')) return sha256(buffer)

  try {
    return sha256(stableJson(stripVolatileValues(JSON.parse(buffer.toString('utf8')))))
  } catch {
    return sha256(buffer)
  }
}

function rewriteManifestPaths(value, fromDir, toDir) {
  const fromPrefix = `${resolve(fromDir)}${sep}`
  const toPrefix = `${resolve(toDir)}${sep}`
  return mapJson(value, (entry) => {
    if (typeof entry === 'string' && entry.startsWith(fromPrefix)) {
      return `${toPrefix}${entry.slice(fromPrefix.length)}`
    }
    return entry
  })
}

function stripVolatileValues(value) {
  return mapJson(value, (entry, key) => {
    if (key && ['fetchedAt', 'generatedAt', 'retrievedAt'].includes(key)) return undefined
    return entry
  })
}

function mapJson(value, visit, key) {
  const visited = visit(value, key)
  if (visited === undefined) return undefined
  if (visited === null || typeof visited !== 'object') return visited
  if (Array.isArray(visited)) {
    return visited
      .map((entry) => mapJson(entry, visit))
      .filter((entry) => entry !== undefined)
  }

  const mapped = {}
  for (const [entryKey, entryValue] of Object.entries(visited)) {
    const next = mapJson(entryValue, visit, entryKey)
    if (next !== undefined) mapped[entryKey] = next
  }
  return mapped
}

function passThroughDownloadArgs(rawArgs) {
  const result = []
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]
    if (!arg.startsWith('--')) continue

    const name = arg.slice(2)
    const next = rawArgs[index + 1]
    const hasValue = next && !next.startsWith('--')
    const normalized = toCamelCase(name)
    if (wrapperOnlyArgs.has(name) || wrapperOnlyArgs.has(normalized) || ['start', 'end', 'out-dir', 'outDir'].includes(name)) {
      if (hasValue) index += 1
      continue
    }

    result.push(arg)
    if (hasValue) {
      result.push(next)
      index += 1
    }
  }
  return result
}

function splitExtraArgs(value) {
  if (!value) return []
  return String(value).split(/\s+/).map((entry) => entry.trim()).filter(Boolean)
}

function runCommand(command, commandArgs) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, { stdio: 'inherit' })
    child.on('error', rejectRun)
    child.on('exit', (code) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`${command} ${commandArgs.join(' ')} exited with ${code}`))
    })
  })
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function readJsonIfExists(path) {
  try {
    await access(path, fsConstants.F_OK)
    return await readJson(path)
  } catch {
    return undefined
  }
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function parseArgs(rawArgs) {
  const parsed = {}
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = rawArgs[index + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = true
      parsed[toCamelCase(key)] = true
    } else {
      parsed[key] = next
      parsed[toCamelCase(key)] = next
      index += 1
    }
  }
  return parsed
}

function toCamelCase(value) {
  return value.replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase())
}

function stringArg(value) {
  if (value === undefined || value === true || value === false) return ''
  return String(value)
}

function booleanArg(value) {
  return value === true || value === 'true'
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

function positiveInteger(value) {
  if (value === undefined || value === true || value === false || value === '') return null
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`Expected a positive integer, received ${value}`)
  }
  return number
}

function validateDurableCandidateReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1
    || typeof value.runId !== 'string'
    || (value.eligibility !== 'eligible' && value.eligibility !== 'no-change' && value.eligibility !== 'ineligible')
    || typeof value.outcome !== 'string'
    || !value.identity || typeof value.identity !== 'object' || Array.isArray(value.identity)
    || typeof value.identityHash !== 'string'
    || value.identityHash !== sha256(stableJson(value.identity))) return undefined
  if (value.eligibility === 'eligible' && (typeof value.manifestKey !== 'string'
    || typeof value.manifestDigest !== 'string'
    || typeof value.manifestBytes !== 'number'
    || typeof value.stateRoot !== 'string'
    || !value.retention || typeof value.retention !== 'object' || Array.isArray(value.retention)
    || typeof value.retention.date !== 'string' || !Array.isArray(value.retention.boundaries)
    || !value.metrics || typeof value.metrics !== 'object'
    || !value.parity || typeof value.parity !== 'object')) return undefined
  if (value.eligibility === 'no-change' && typeof value.stateRoot !== 'string') return undefined
  return value
}

function refreshLeaseGuard(env) {
  const key = env.RANKING_REFRESH_LEASE_KEY
  const owner = env.RANKING_REFRESH_LEASE_OWNER
  const etag = env.RANKING_REFRESH_LEASE_ETAG
  const authorityKey = env.RANKING_REFRESH_LEASE_AUTHORITY_KEY
  const fencingToken = Number(env.RANKING_REFRESH_FENCING_TOKEN)
  if (!key || !owner || authorityKey !== 'active-generation.json' || !Number.isFinite(fencingToken) || fencingToken <= 0) return undefined
  return { key, owner, ...(etag ? { etag } : {}), authorityKey, fencingToken }
}

function hasRefreshLeaseIdentity(env) {
  return Boolean(env.RANKING_REFRESH_FENCING_TOKEN
    || env.RANKING_REFRESH_LEASE_KEY
    || env.RANKING_REFRESH_LEASE_OWNER
    || env.RANKING_REFRESH_LEASE_ETAG
    || env.RANKING_REFRESH_LEASE_AUTHORITY_KEY)
}

function dateDaysBefore(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

function minDate(left, right) {
  if (!left) return right
  if (!right) return left
  return left < right ? left : right
}

function maxDate(left, right) {
  if (!left) return right
  if (!right) return left
  return left > right ? left : right
}

function arrayValue(value) {
  return Array.isArray(value) ? value : []
}

function uniqueValues(values) {
  return Array.from(new Set(values.filter((value) => value !== undefined && value !== null)))
}
