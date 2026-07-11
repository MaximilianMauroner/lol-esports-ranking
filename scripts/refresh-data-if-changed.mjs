import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { manifestWithResolvedFiles } from './local-data-manifest.js'
import { bucketConfigFromEnv, downloadBucketDirectory, downloadBucketObject, uploadRankingArtifacts } from './railway-bucket.mjs'

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
  const rawDir = resolve(stringArg(args.rawDir ?? env.RANKING_RAW_DIR ?? 'data/raw'))
  const manifestPath = resolve(stringArg(args.manifest ?? `${rawDir}/manifest.json`))
  const statePath = resolve(stringArg(args.state ?? env.RANKING_REFRESH_STATE ?? `${rawDir}/refresh-state.json`))
  const output = resolve(stringArg(args.output ?? env.RANKING_DERIVED_OUTPUT ?? 'data/derived/ranking-snapshot.full.json'))
  const reconciliationOutput = resolve(stringArg(args.reconciliationOutput ?? env.RANKING_RECONCILIATION_OUTPUT ?? `${rawDir}/reconciliation.json`))
  const publicDataDir = resolve(stringArg(args.publicDataDir ?? env.RANKING_PUBLIC_DATA_DIR ?? 'public/data'))
  const end = stringArg(args.end ?? env.RANKING_REFRESH_END ?? today())
  const force = booleanArg(args.force) || env.RANKING_FORCE_REFRESH === 'true'
  const skipCrunch = booleanArg(args.skipCrunch) || env.RANKING_SKIP_CRUNCH === 'true'
  const bucketUploadEnabled = !booleanArg(args.skipBucketUpload) && env.RANKING_BUCKET_UPLOAD_ENABLED !== 'false'
  const bucketRequired = booleanArg(args.bucketRequired) || env.RANKING_BUCKET_REQUIRED === 'true'
  const bucketConfig = options.bucketConfig ?? bucketConfigFromEnv(env)
  const restoreRawEnabled = env.RANKING_BUCKET_RESTORE_RAW !== 'false'
  const stagingDir = resolve(stringArg(args.stagingDir ?? `data/.refresh-staging-${process.pid}-${Date.now()}`))
  const stagingManifestPath = resolve(stagingDir, 'manifest.json')
  const extraDownloadArgs = [
    ...passThroughDownloadArgs(rawArgs),
    ...splitExtraArgs(env.RANKING_REFRESH_DOWNLOAD_ARGS),
  ]
  const localManifest = manifestWithResolvedFiles(await readJsonIfExists(manifestPath), rawDir)
  const hasUsableLocalRawBaseline = await manifestHasUsableSourceFiles(localManifest)
  const restoreResult = restoreRawEnabled && bucketConfig.enabled
    ? await restoreRawFromBucketIfMissing({
        rawDir,
        manifestPath,
        statePath,
        hasUsableLocalRawBaseline,
        config: bucketConfig,
        client: options.bucketClient,
      })
    : { restored: false, reason: restoreRawEnabled ? 'bucket-disabled' : 'disabled' }
  const previousManifest = manifestWithResolvedFiles(await readJsonIfExists(manifestPath), rawDir)
  const configuredBootstrapStart = env.RANKING_REFRESH_BOOTSTRAP_START ?? env.RANKING_REFRESH_START
  const bootstrapStart = stringArg(configuredBootstrapStart ?? '2011-01-01')
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
        healthFingerprint,
        previousFingerprint: previousState?.fingerprint,
      }
    }

    const fingerprint = await createSourceFingerprint(stagingManifest)
    const changed = force || previousState?.fingerprint !== fingerprint.fingerprint

    if (!changed) {
      const state = {
        ...(previousState ?? {}),
        status: 'unchanged',
        checkedAt: new Date().toISOString(),
        fingerprint: fingerprint.fingerprint,
        healthFingerprint: fingerprint.healthFingerprint,
        downloadStart: start,
        downloadEnd: end,
        sources: stagingManifest?.sources ?? {},
        warnings: arrayValue(stagingManifest?.warnings),
        crunch: {
          skipped: true,
          reason: 'unchanged-source-data',
        },
        publish: {
          skipped: true,
          reason: 'unchanged-source-data',
        },
      }
      await mkdir(dirname(statePath), { recursive: true })
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)
      console.log(`No source-data changes detected for ${start} through ${end}; skipping crunch.`)
      return {
        changed: false,
        fingerprint: fingerprint.fingerprint,
        healthFingerprint: fingerprint.healthFingerprint,
        previousFingerprint: previousState?.fingerprint,
      }
    }

    const stagedManifestForRawDir = rewriteManifestPaths(stagingManifest, stagingDir, rawDir)
    const finalManifest = mergeExistingRaw
      ? mergeRawManifests(previousManifest, stagedManifestForRawDir)
      : stagedManifestForRawDir

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
      status: 'refreshed',
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

    if (!skipCrunch) {
      await (options.run ?? runCommand)('pnpm', [
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
      ])
    }

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
        const browserManifest = await readJson(resolve(publicDataDir, 'ranking-summary.json'))
        const generationId = env.RANKING_REFRESH_FENCING_TOKEN
          ? stringArg(browserManifest?.artifactMeta?.runId)
          : undefined
        const bucketPublish = await uploadRankingArtifacts({
          publicDataDir,
          rawDir,
          fullSnapshotPath: output,
          manifestPath,
          statePath,
          config: bucketConfig,
          client: options.bucketClient,
          uploadFullSnapshot: env.RANKING_BUCKET_UPLOAD_FULL_SNAPSHOT === 'true',
          generationId,
          fencingToken: env.RANKING_REFRESH_FENCING_TOKEN ? Number(env.RANKING_REFRESH_FENCING_TOKEN) : undefined,
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
    console.log(`Source data changed; refreshed ranking artifacts for ${start} through ${end}.`)
    return {
      changed: true,
      fingerprint: fingerprint.fingerprint,
      healthFingerprint: fingerprint.healthFingerprint,
      previousFingerprint: previousState?.fingerprint,
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}

export async function createSourceFingerprint(manifest) {
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

async function restoreRawFromBucketIfMissing({ rawDir, manifestPath, statePath, hasUsableLocalRawBaseline, config, client }) {
  if (hasUsableLocalRawBaseline) {
    return {
      restored: false,
      reason: 'local-baseline-present',
    }
  }

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
