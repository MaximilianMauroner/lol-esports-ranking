import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { manifestWithResolvedFiles } from './local-data-manifest.js'
import { bucketConfigFromEnv, createBucketClient, readActiveContentAddressedGeneration, readActiveRawSourceAuthority, uploadRankingArtifacts } from './railway-bucket.mjs'
import { completeRefreshMetrics, createRefreshMetrics, mergeRefreshMetrics, readRefreshMetrics, writeRefreshMetrics } from './refresh-metrics.mjs'
import { readActiveIncrementalState } from './incremental-state-storage.mjs'
import { buildRankingIncrementally, persistIncrementalStateBuild, RANKING_INCREMENTAL_IMPORTER_VERSION, releasePersistedIncrementalInputs } from './incremental-ranking-orchestrator.ts'
import { finalizeRawSourceGeneration, hydrateFileBackedRawSourceGeneration } from './raw-source-generation.mjs'
import { isFullAuditEligible, publishFullAuditDayReceipt, stageFullAuditSnapshot } from './full-audit-storage.mjs'
import { rawSourceWorkerExecArgv } from './refresh-worker-memory.mjs'
import {
  authorityIdentityFor,
  prepareRankingSourceAuthorityEvidence,
  validateRawSourceAuthority,
} from './ranking-source-authority.mjs'

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await refreshDataIfChanged(process.argv.slice(2))
}

export async function refreshDataIfChanged(rawArgs = [], options = {}) {
  const args = parseArgs(rawArgs)
  const env = options.env ?? process.env
  const wallNow = options.now ?? Date.now
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const metricsPath = env.RANKING_REFRESH_METRICS_PATH
  const runId = env.RANKING_REFRESH_RUN_ID ?? `refresh-child-${process.pid}`
  const metrics = createRefreshMetrics({
    runId,
    mode: env.RANKING_REFRESH_MODE === 'shadow' ? 'shadow' : 'gated',
    cause: env.RANKING_REFRESH_CAUSE ?? (env.RANKING_FORCE_REFRESH === 'true' ? 'manual-force' : 'pending-match'),
    affectedIds: parseAffectedIds(env.RANKING_REFRESH_AFFECTED_IDS),
    affectedDate: env.RANKING_REFRESH_AFFECTED_DATE,
    now: wallNow,
    monotonicNow,
  })
  let inheritedMetrics = await readRefreshMetrics(metricsPath)
  const rawDir = resolve(stringArg(args.rawDir ?? env.RANKING_RAW_DIR ?? 'data/raw'))
  let manifestPath = resolve(stringArg(args.manifest ?? `${rawDir}/manifest.json`))
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
  const bucketClient = options.bucketClient ?? createBucketClient(bucketConfig)
  const stageAuditSnapshot = options.stageFullAuditSnapshot ?? stageFullAuditSnapshot
  const publishAuditReceipt = options.publishFullAuditDayReceipt ?? publishFullAuditDayReceipt
  const restoreRawEnabled = env.RANKING_BUCKET_RESTORE_RAW !== 'false'
  const stagingDir = resolve(stringArg(args.stagingDir ?? `data/.refresh-staging-${process.pid}-${Date.now()}`))
  const stagingManifestPath = resolve(stagingDir, 'manifest.json')
  const rawWorkerDir = `${stagingDir}-raw-worker`
  await rm(rawWorkerDir, { recursive: true, force: true })
  const extraDownloadArgs = [
    ...passThroughDownloadArgs(rawArgs),
    ...splitExtraArgs(env.RANKING_REFRESH_DOWNLOAD_ARGS),
  ]
  const restoreStarted = monotonicNow()
  const localManifest = manifestWithResolvedFiles(await readJsonIfExists(manifestPath), rawDir)
  const hasUsableLocalRawBaseline = await manifestHasUsableSourceFiles(localManifest)
  const restoreResult = restoreRawEnabled && bucketConfig.enabled
    ? await attemptOptionalRawRestore({
        rawDir,
        manifestPath,
        hasUsableLocalRawBaseline,
        config: bucketConfig,
        client: bucketClient,
        rawWorkerDir,
      })
    : { restored: false, reason: restoreRawEnabled ? 'bucket-disabled' : 'disabled' }
  metrics.recordStage('restore', {
    durationMs: monotonicNow() - restoreStarted,
    result: restoreResult.restored ? 'completed' : 'not-applicable',
    output: { ...restoreResult, rssBytes: process.memoryUsage().rss },
  })
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

  let refreshError
  let canonicalMetrics
  let terminalResult = 'completed'
  let completedPromotionAt
  let completedPromotionEtag
  let publishedGenerationId
  let publishedBucket
  let refreshState
  let incrementalBuild
  let restoredIncremental
  let rawSourceGeneration
  let providerAvailableAt
  let acceptedRawRecovery
  try {
    const providerStarted = monotonicNow()
    let providerCommandError
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
    } catch (error) {
      providerCommandError = error
    }
    const stagingManifest = await readValidProviderManifest(stagingManifestPath, providerCommandError, {
      start,
      end,
      stagingDir,
    })
    metrics.recordProcessResource({
      processKey: `${runId}:raw-source-subprocess`,
      cpuSeconds: null,
      memoryGbSeconds: null,
      peakRssBytes: null,
      sampleCount: 0,
    })
    metrics.recordStage('provider-fetch', {
      durationMs: monotonicNow() - providerStarted,
      result: providerCommandError ? 'failed' : 'completed',
      output: { start, end },
    })
    metrics.recordWork({ broadFetches: 1 })

    let currentStagingManifest = stagingManifest
    metrics.recordWork({
      providerRequests: finiteOrNull(currentStagingManifest?.fetchTelemetry?.requests),
      providerRetries: finiteOrNull(currentStagingManifest?.fetchTelemetry?.retryCount),
    })
    const previousState = await readJsonIfExists(statePath)
    if (!manifestHasCurrentMatchSourceFiles(currentStagingManifest)) {
      const attemptedAt = new Date(wallNow()).toISOString()
      const providerResult = sourceProviderResult(currentStagingManifest)
      const outageReason = providerCommandError ? 'provider-command-failed' : 'no-current-match-source-data'
      const recoveryAuthorized = force && env.RANKING_REUSE_RAW_ON_SOURCE_FAILURE === 'true'
      if (recoveryAuthorized && bucketConfig.enabled && bucketClient) {
        try {
          acceptedRawRecovery = await restoreVerifiedRawRecovery({
            config: bucketConfig,
            client: bucketClient,
            stagingDir,
            rawWorkerDir,
            generatedAt: attemptedAt,
            importerVersion: RANKING_INCREMENTAL_IMPORTER_VERSION,
          })
          currentStagingManifest = manifestWithResolvedFiles(await readJson(stagingManifestPath), stagingDir)
          const evidence = prepareRankingSourceAuthorityEvidence({
            mode: 'forced-verified-raw-recovery',
            runId,
            attemptedAt,
            providerResult,
            requestedCoverage: { start, end },
            authority: authorityIdentityFor(acceptedRawRecovery.validated),
            outage: {
              reason: outageReason,
              attemptedCoverage: { start, end },
              providerResult,
            },
            restoredBaseline: {
              generationId: acceptedRawRecovery.validated.receipt.generationId,
              sourceReceiptDigest: acceptedRawRecovery.validated.receipt.sourceReceiptDigest,
              rawIdentityDigest: acceptedRawRecovery.validated.receipt.rawIdentityDigest,
              coverage: acceptedRawRecovery.validated.receipt.coverage,
            },
            compatibility: {
              importerVersion: acceptedRawRecovery.validated.receipt.importerVersion,
              receiptSchemaVersion: acceptedRawRecovery.validated.receipt.schemaVersion,
              storageMode: acceptedRawRecovery.validated.receipt.storageMode,
            },
          })
          const sourceAuthorityEvidence = {
            evidence: evidence.evidence,
            evidenceDigest: evidence.evidenceDigest,
            bytes: evidence.bytes,
          }
          metrics.setEvidence({ sourceAuthorityEvidence })
          currentStagingManifest = {
            ...currentStagingManifest,
            warnings: uniqueValues([
              ...arrayValue(currentStagingManifest.warnings),
              ...arrayValue(providerResult.warnings),
              `Rebuilt from verified raw authority after scored providers were unavailable for ${start} through ${end}.`,
            ]),
            refreshAttempt: {
              forcedVerifiedRawRecovery: true,
              attemptedAt,
              start,
              end,
              sources: providerResult.sources,
              restoredGenerationId: acceptedRawRecovery.validated.receipt.generationId,
            },
            sourceAuthorityEvidence,
          }
          await writeFile(stagingManifestPath, `${JSON.stringify(currentStagingManifest, null, 2)}\n`)
          console.warn(`No current Oracle or Leaguepedia source files were downloaded for ${start} through ${end}; rebuilding from verified raw authority.`)
        } catch (error) {
          acceptedRawRecovery = undefined
          metrics.recordStage('raw-recovery-validation', {
            durationMs: 0,
            result: 'failed',
            output: { reason: errorMessage(error) },
          })
        }
      }
      if (!acceptedRawRecovery) {
        const healthFingerprint = createSourceHealthFingerprint(currentStagingManifest)
        const evidence = prepareRankingSourceAuthorityEvidence({
          mode: 'stale-source-preservation',
          runId,
          attemptedAt,
          providerResult,
          requestedCoverage: { start, end },
          authority: null,
          outage: {
            reason: recoveryAuthorized ? 'verified-raw-authority-rejected' : outageReason,
            attemptedCoverage: { start, end },
            providerResult,
          },
          restoredBaseline: null,
          compatibility: null,
        })
        const sourceAuthorityEvidence = {
          evidence: evidence.evidence,
          evidenceDigest: evidence.evidenceDigest,
          bytes: evidence.bytes,
        }
        metrics.setEvidence({ sourceAuthorityEvidence })
        const state = createStaleSourceState({
          previousState,
          previousManifest,
          stagingManifest: currentStagingManifest,
          start,
          end,
          window,
          mergeExistingRaw,
          restoreResult,
          healthFingerprint,
          sourceAuthorityEvidence,
          reason: recoveryAuthorized ? 'verified-raw-authority-rejected' : outageReason,
        })
        refreshState = state
        terminalResult = 'stale-source'
        canonicalMetrics = aggregateMetrics(inheritedMetrics, metrics, { result: terminalResult })
        state.lastRun = canonicalMetrics
        await mkdir(dirname(statePath), { recursive: true })
        await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)
        console.warn(`No current Oracle or Leaguepedia source files were downloaded for ${start} through ${end}; preserving existing ranking artifacts.`)
        return {
          changed: false,
          status: 'stale-source',
          reason: state.reason,
          healthFingerprint,
          previousFingerprint: previousState?.fingerprint,
          sourceAuthorityEvidenceDigest: evidence.evidenceDigest,
        }
      }
    } else {
      const evidence = prepareRankingSourceAuthorityEvidence({
        mode: 'fresh-ingestion',
        runId,
        attemptedAt: new Date(wallNow()).toISOString(),
        providerResult: sourceProviderResult(currentStagingManifest, 'available'),
        requestedCoverage: { start, end },
        authority: null,
        outage: null,
        restoredBaseline: null,
        compatibility: null,
      })
      const sourceAuthorityEvidence = {
        evidence: evidence.evidence,
        evidenceDigest: evidence.evidenceDigest,
        bytes: evidence.bytes,
      }
      metrics.setEvidence({ sourceAuthorityEvidence })
      currentStagingManifest.sourceAuthorityEvidence = sourceAuthorityEvidence
      await writeFile(stagingManifestPath, `${JSON.stringify(currentStagingManifest, null, 2)}\n`)
    }
    const stagingManifestForRun = currentStagingManifest

    const hashingStarted = monotonicNow()
    const fingerprint = await createSourceFingerprint(stagingManifestForRun)
    metrics.recordStage('hashing', {
      durationMs: monotonicNow() - hashingStarted,
      output: { fileCount: fingerprint.files.length },
    })
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
        sources: stagingManifestForRun?.sources ?? {},
        warnings: arrayValue(stagingManifestForRun?.warnings),
        sourceAuthorityEvidence: stagingManifestForRun.sourceAuthorityEvidence,
        crunch: {
          skipped: true,
          reason: 'unchanged-source-data',
        },
        publish: {
          skipped: true,
          reason: 'unchanged-source-data',
        },
      }
      refreshState = state
      terminalResult = 'unchanged'
      canonicalMetrics = aggregateMetrics(inheritedMetrics, metrics, { result: terminalResult })
      state.lastRun = canonicalMetrics
      await mkdir(dirname(statePath), { recursive: true })
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)
      console.log(`No source-data changes detected for ${start} through ${end}; skipping crunch.`)
      return {
        changed: false,
        fingerprint: fingerprint.fingerprint,
        healthFingerprint: fingerprint.healthFingerprint,
        previousFingerprint: previousState?.fingerprint,
        sourceAuthorityEvidenceDigest: stagingManifestForRun.sourceAuthorityEvidence?.evidenceDigest,
      }
    }

    const stagedManifestForRawDir = rewriteManifestPaths(stagingManifestForRun, stagingDir, rawDir)
    const effectiveMergeExistingRaw = mergeExistingRaw && !acceptedRawRecovery
    const finalManifest = effectiveMergeExistingRaw
      ? mergeRawManifests(previousManifest, stagedManifestForRawDir)
      : stagedManifestForRawDir

    if (effectiveMergeExistingRaw) {
      await mkdir(rawDir, { recursive: true })
      await cp(stagingDir, rawDir, { recursive: true, force: true })
    } else {
      await rm(rawDir, { recursive: true, force: true })
      await mkdir(dirname(rawDir), { recursive: true })
      await rename(stagingDir, rawDir)
    }
    await writeFile(manifestPath, `${JSON.stringify(finalManifest, null, 2)}\n`)
    metrics.recordStage('fingerprint-import', {
      durationMs: 0,
      output: {
        sourceFileCount: Object.values(finalManifest.files ?? {}).flatMap((paths) => arrayValue(paths)).length,
        changed,
      },
    })

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
      mergeExistingRaw: effectiveMergeExistingRaw,
      restoredRaw: restoreResult,
      files: fingerprint.files,
      sources: stagingManifestForRun?.sources ?? {},
      warnings: arrayValue(stagingManifestForRun?.warnings),
      sourceAuthorityEvidence: stagingManifestForRun.sourceAuthorityEvidence,
      crunch: skipCrunch
        ? { skipped: true }
        : {
            skipped: false,
            output,
            publicDataDir,
          },
    }
    refreshState = state

    const refreshMode = metrics.snapshot().mode
    const incrementalEnabled = Boolean(env.RANKING_REFRESH_FENCING_TOKEN)
      && (refreshMode === 'gated'
        || (refreshMode === 'shadow' && env.RANKING_INCREMENTAL_SHADOW_ENABLED === 'true'))
    if (!skipCrunch && incrementalEnabled && bucketConfig.enabled && bucketClient) {
      const rawAuthorityStarted = monotonicNow()
      const activeRaw = await readActiveRawSourceAuthority({ config: bucketConfig, client: bucketClient })
      metrics.recordStage('raw-authority-read', {
        durationMs: monotonicNow() - rawAuthorityStarted,
        result: activeRaw.found ? 'completed' : 'not-applicable',
        output: {
          found: activeRaw.found,
          rssBytes: process.memoryUsage().rss,
          maxRssBytes: process.resourceUsage().maxRSS * 1024,
        },
      })
      const rawWorkerStarted = monotonicNow()
      const rawWorker = await runRawSourceWorker({
        action: 'prepare',
        manifestPath,
        rawDir,
        importerVersion: RANKING_INCREMENTAL_IMPORTER_VERSION,
        generatedAt: finalManifest.generatedAt ?? new Date().toISOString(),
        objectDir: resolve(rawWorkerDir, 'prepared-objects'),
        ...(activeRaw.found ? { previousReceipt: activeRaw.receipt } : {}),
      }, rawWorkerDir)
      rawSourceGeneration = hydrateFileBackedRawSourceGeneration(rawWorker.generation)
      manifestPath = rawWorker.manifestPath
      metrics.recordStage('raw-prepare', {
        durationMs: Number(rawWorker.prepareMs) || monotonicNow() - rawWorkerStarted,
        output: {
          objectCount: rawSourceGeneration.objects.length,
          rssBytes: process.memoryUsage().rss,
          maxRssBytes: process.resourceUsage().maxRSS * 1024,
          childMaxRssBytes: rawWorker.childMaxRssBytes,
          childTotalMs: rawWorker.totalMs,
          sourceAuthorityEvidenceDigest: stagingManifestForRun.sourceAuthorityEvidence?.evidenceDigest,
        },
      })
      metrics.recordStage('raw-materialization', {
        durationMs: Number(rawWorker.materializeMs) || 0,
        output: {
          rssBytes: process.memoryUsage().rss,
          maxRssBytes: process.resourceUsage().maxRSS * 1024,
          childMaxRssBytes: rawWorker.childMaxRssBytes,
        },
      })
    }
    if (!skipCrunch && incrementalEnabled) {
      const checkpointRestoreStarted = monotonicNow()
      if (bucketConfig.enabled && bucketClient) {
        try {
          const [activeState, activePublic] = await Promise.all([
            readActiveIncrementalState({ config: bucketConfig, client: bucketClient, checkpointLimit: 1 }),
            readActiveContentAddressedGeneration({ config: bucketConfig, client: bucketClient, verifyArtifacts: false }),
          ])
          if (activeState.found && activePublic.found
            && activeState.manifest.generationId === activePublic.active.generationId) {
            restoredIncremental = {
              stateManifest: activeState.manifest,
              canonicalLedger: activeState.canonicalLedger,
              checkpoints: activeState.checkpoints,
              publicManifest: activePublic.manifest,
              rootArtifact: activePublic.rootArtifact,
              artifacts: activePublic.artifacts,
              loadArtifacts: activePublic.loadArtifacts,
              loadCheckpoints: activeState.loadCheckpoints,
            }
          }
        } catch (error) {
          metrics.recordStage('checkpoint-validation', {
            durationMs: 0,
            result: 'failed',
            output: { reason: errorMessage(error) },
          })
        }
      }
      metrics.recordStage('checkpoint-restore', {
        durationMs: monotonicNow() - checkpointRestoreStarted,
        result: restoredIncremental ? 'completed' : 'not-applicable',
        output: {
          found: Boolean(restoredIncremental),
          candidateCount: restoredIncremental?.checkpoints.length ?? 0,
          rssBytes: process.memoryUsage().rss,
        },
      })
      const crunchStarted = monotonicNow()
      incrementalBuild = await buildRankingIncrementally({
        mode: metrics.snapshot().mode,
        cause: metrics.snapshot().cause,
        enabled: true,
        manifestPath,
        output,
        publicDataDir,
        reconciliationOutput,
        restored: restoredIncremental,
        diagnosticPath: resolve(rawDir, 'incremental-diagnostic.json'),
        env,
        ...(rawSourceGeneration ? { sourceReceiptDigest: rawSourceGeneration.sourceReceiptDigest } : {}),
      })
      providerAvailableAt = incrementalBuild.metrics.providerAvailableAt ?? null
      metrics.recordWork({
        fullBuilds: incrementalBuild.action === 'publish-full' ? 1 : 0,
        incrementalBuilds: incrementalBuild.action === 'publish-incremental' ? 1 : 0,
      })
      metrics.recordStage('classification', {
        durationMs: 0,
        output: {
          classification: incrementalBuild.metrics.classification,
          addedCount: incrementalBuild.metrics.addedCount,
          changedCount: incrementalBuild.metrics.changedCount,
          removedCount: incrementalBuild.metrics.removedCount,
          canonicalRows: incrementalBuild.metrics.canonicalRows,
          canonicalBytes: incrementalBuild.metrics.canonicalBytes,
        },
      })
      metrics.recordStage('checkpoint-validation', {
        durationMs: 0,
        result: incrementalBuild.metrics.fallbackReason ? 'failed' : 'completed',
        output: {
          candidateCount: incrementalBuild.metrics.candidateCount,
          rejectedCandidates: incrementalBuild.metrics.rejectedCandidates,
          selectedBoundary: incrementalBuild.metrics.selectedBoundary,
          fallbackReason: incrementalBuild.metrics.fallbackReason,
        },
      })
      metrics.recordStage('replay', {
        durationMs: monotonicNow() - crunchStarted,
        result: incrementalBuild.action === 'no-change' ? 'not-applicable' : 'completed',
        output: {
          replayFromUtcDate: incrementalBuild.metrics.replayFromUtcDate,
          replayedMatchCount: incrementalBuild.metrics.replayedMatchCount,
          suffixRows: incrementalBuild.metrics.suffixRows,
          suffixDates: incrementalBuild.metrics.suffixDates,
          rssBytes: process.memoryUsage().rss,
        },
      })
      metrics.recordStage('external-causal-recompute', {
        durationMs: 0,
        result: incrementalBuild.action === 'no-change' ? 'not-applicable' : 'completed',
      })
      for (const stage of incrementalBuild.metrics.playerLifecycleStages ?? []) {
        metrics.recordStage(stage.name, stage)
      }
      metrics.recordStage('dependency-materialization', {
        durationMs: 0,
        result: incrementalBuild.action === 'publish-incremental' ? 'completed' : 'not-applicable',
        output: {
          changedPaths: incrementalBuild.metrics.changedPaths,
          reusedPaths: incrementalBuild.metrics.reusedPaths,
          removedPaths: incrementalBuild.metrics.removedPaths,
          semanticBytes: incrementalBuild.metrics.semanticBytes,
          compressedBytes: incrementalBuild.metrics.compressedBytes,
          materializedScopeCount: incrementalBuild.metrics.materializedScopeCount,
        },
      })
      metrics.recordStage('semantic-parity', {
        durationMs: 0,
        result: incrementalBuild.metrics.parity === null && incrementalBuild.metrics.stateParity === null
          ? 'not-applicable'
          : incrementalBuild.metrics.parity === true && incrementalBuild.metrics.stateParity === true ? 'completed' : 'failed',
        output: {
          parity: incrementalBuild.metrics.parity,
          stateParity: incrementalBuild.metrics.stateParity,
          checkpointParity: incrementalBuild.metrics.stateParityReport?.checkpointEqual ?? null,
          semanticReport: incrementalBuild.metrics.semanticParityReport ?? null,
          stateReport: incrementalBuild.metrics.stateParityReport ?? null,
        },
      })
      metrics.setCheckpoint({
        applicable: incrementalBuild.metrics.classification !== 'no-change',
        classification: incrementalBuild.metrics.classification,
        selectedBoundary: incrementalBuild.metrics.selectedBoundary,
        replayFromUtcDate: incrementalBuild.metrics.replayFromUtcDate,
        replayedMatchCount: incrementalBuild.metrics.replayedMatchCount,
        candidateCount: incrementalBuild.metrics.candidateCount,
        rejectedCandidates: incrementalBuild.metrics.rejectedCandidates,
        fallbackReason: incrementalBuild.metrics.fallbackReason,
      })
      metrics.recordStage('crunch', {
        durationMs: monotonicNow() - crunchStarted,
        output: { incremental: incrementalBuild.action === 'publish-incremental', fullSnapshotWritten: incrementalBuild.metrics.fullSnapshotWritten },
      })
    } else if (!skipCrunch) {
      const crunchStarted = monotonicNow()
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
      metrics.recordStage('crunch', { durationMs: monotonicNow() - crunchStarted })
      metrics.recordWork({ fullBuilds: 1, incrementalBuilds: 0 })
    }

    inheritedMetrics = await readRefreshMetrics(metricsPath) ?? inheritedMetrics
    for (const stage of inheritedMetrics?.stages ?? []) {
      if (stage.result !== 'not-applicable') metrics.recordStage(stage.name, stage)
    }

    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)

    if (incrementalBuild?.action === 'no-change') {
      state.crunch = { skipped: true, reason: 'canonical-ledger-unchanged' }
      state.publish = { skipped: true, reason: 'canonical-ledger-unchanged' }
      terminalResult = 'unchanged'
      canonicalMetrics = aggregateMetrics(inheritedMetrics, metrics, {
        result: terminalResult,
        freshness: { providerAvailableAt, publishedAt: null },
      })
      state.lastRun = canonicalMetrics
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)
      return { changed: false, status: 'canonical-no-change', fingerprint: fingerprint.fingerprint }
    }

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
        const browserManifest = incrementalBuild?.rootManifest
          ?? incrementalBuild?.build?.publicPlan.manifest
          ?? incrementalBuild?.patch?.changedArtifacts?.find((artifact) => artifact.logicalPath === '/data/ranking-summary.json')?.value
          ?? await readJson(resolve(publicDataDir, 'ranking-summary.json'))
        const generationId = env.RANKING_REFRESH_FENCING_TOKEN
          ? stringArg(browserManifest?.artifactMeta?.runId)
          : undefined
        publishedGenerationId = generationId
        if (rawSourceGeneration && generationId) rawSourceGeneration = finalizeRawSourceGeneration(rawSourceGeneration, generationId)
        let incrementalState
        if (incrementalBuild && generationId && bucketClient) {
          const stateStarted = monotonicNow()
          incrementalState = await persistIncrementalStateBuild({
            state: incrementalBuild.state,
            generationId,
            baseGenerationId: restoredIncremental?.stateManifest.generationId ?? null,
            baseRunId: restoredIncremental?.stateManifest.runId ?? null,
            config: bucketConfig,
            client: bucketClient,
          })
          metrics.recordStage('state-persistence', {
            durationMs: monotonicNow() - stateStarted,
            output: {
              uploadedBytes: incrementalState.uploadedBytes,
              objectCount: incrementalState.objectCount,
              ledgerBytes: incrementalState.ledgerBytes,
              ledgerCompressedBytes: incrementalState.ledgerCompressedBytes,
              checkpointCount: incrementalState.checkpointCount,
              rssBytes: process.memoryUsage().rss,
            },
          })
          releasePersistedIncrementalInputs(incrementalBuild, restoredIncremental)
          restoredIncremental = undefined
        }
        const fencingToken = env.RANKING_REFRESH_FENCING_TOKEN
          ? Number(env.RANKING_REFRESH_FENCING_TOKEN)
          : undefined
        const leaseAuthority = env.RANKING_REFRESH_LEASE_OWNER && env.RANKING_REFRESH_FENCING_TOKEN
          ? {
              key: env.RANKING_REFRESH_LEASE_KEY ?? 'ops/refresh-lease.json',
              lease: {
                owner: env.RANKING_REFRESH_LEASE_OWNER,
                fencingToken,
              },
              promotionEtag: env.RANKING_REFRESH_PROMOTION_ETAG,
            }
          : undefined
        const auditCause = env.RANKING_REFRESH_CAUSE ?? (env.RANKING_FORCE_REFRESH === 'true' ? 'manual-force' : 'pending-match')
        const stagedAudit = await invokeFullAuditStageIfEligible({
          cause: auditCause,
          result: incrementalBuild?.action,
          fullSnapshotPath: output,
          fullSnapshotDescriptor: incrementalBuild?.build?.fullSnapshotDescriptor,
          generationId,
          fencingToken,
          stateManifestAuthority: incrementalState?.authority,
          rawReceiptAuthority: rawSourceGeneration,
        }, async () => {
          const auditStarted = monotonicNow()
          const staged = await stageAuditSnapshot({
            fullSnapshotPath: output,
            snapshotDescriptor: incrementalBuild.build.fullSnapshotDescriptor,
            generationId,
            fencingToken,
            stateManifestAuthority: incrementalState.authority,
            rawReceiptAuthority: rawSourceGeneration,
            publicManifest: browserManifest,
            config: bucketConfig,
            client: bucketClient,
          })
          metrics.recordStage('full-audit-object', {
            durationMs: monotonicNow() - auditStarted,
            output: {
              status: staged.status,
              key: staged.reference?.key ?? staged.key,
              bytes: staged.reference?.bytes ?? staged.bytes,
              compressedBytes: staged.reference?.compressedBytes ?? staged.compressedBytes,
              rssBytes: process.memoryUsage().rss,
            },
          })
          return staged
        })
        const bucketPublish = await uploadRankingArtifacts({
          publicDataDir: incrementalBuild?.build?.publicDataDir ?? publicDataDir,
          rawDir,
          fullSnapshotPath: incrementalBuild?.action === 'publish-incremental' ? undefined : output,
          manifestPath,
          statePath,
          config: bucketConfig,
          client: bucketClient,
          uploadFullSnapshot: env.RANKING_BUCKET_UPLOAD_FULL_SNAPSHOT === 'true',
          ...(incrementalBuild?.action === 'publish-incremental' ? { publicArtifactPatch: incrementalBuild.patch } : {}),
          ...(incrementalState ? { stateManifestAuthority: incrementalState.authority } : {}),
          ...(rawSourceGeneration ? { rawSourceGeneration } : {}),
          generationId,
          fencingToken,
          leaseAuthority,
          refreshTelemetry: async (promotion) => {
            await invokeFullAuditReceiptIfEligible({
              cause: auditCause,
              result: incrementalBuild?.action,
              fullSnapshotPath: output,
              fullSnapshotDescriptor: incrementalBuild?.build?.fullSnapshotDescriptor,
              generationId,
              fencingToken,
              promotion,
              stateManifestAuthority: incrementalState?.authority,
              rawReceiptAuthority: rawSourceGeneration,
              stagedAudit,
            }, async () => {
              const auditStarted = monotonicNow()
              const auditReceipt = await publishAuditReceipt({
                cause: auditCause,
                generationId,
                fencingToken,
                promotion,
                publicManifest: browserManifest,
                stateManifestAuthority: incrementalState.authority,
                rawReceiptAuthority: rawSourceGeneration,
                stagedSnapshot: stagedAudit,
                leaseAuthority,
                config: bucketConfig,
                client: bucketClient,
              })
              metrics.recordStage('full-audit-receipt', {
                durationMs: monotonicNow() - auditStarted,
                output: { status: auditReceipt.status, key: auditReceipt.key, bytes: auditReceipt.bytes, rssBytes: process.memoryUsage().rss },
              })
              return auditReceipt
            })
            const own = completeRefreshMetrics(metrics.snapshot({
              result: promotion?.completed ? 'completed' : 'no-promotion',
              freshness: { providerAvailableAt, publishedAt: promotion?.promotedAt ?? null },
            }))
            const aggregated = inheritedMetrics ? mergeRefreshMetrics(inheritedMetrics, own) : own
            return promotion?.etag && env.RANKING_REFRESH_LEASE_OWNER && env.RANKING_REFRESH_FENCING_TOKEN
              ? {
                  ...aggregated,
                  coordination: {
                    owner: env.RANKING_REFRESH_LEASE_OWNER,
                    fencingToken: Number(env.RANKING_REFRESH_FENCING_TOKEN),
                    etag: promotion.etag,
                  },
                }
              : aggregated
          },
          monotonicNow,
          onStage: (name, stage) => {
            metrics.recordStage(name, {
              ...stage,
              output: { ...(stage.output ?? {}), rssBytes: process.memoryUsage().rss },
            })
            if (name === 'artifact-upload' || name === 'raw-synchronization') {
              metrics.recordWork({
                uploads: Number.isFinite(stage.output?.uploadedCount) ? stage.output.uploadedCount : null,
                objectsWritten: Number.isFinite(stage.output?.uploadedCount) ? stage.output.uploadedCount : null,
                bytesWritten: Number.isFinite(stage.output?.uploadedBytes) ? stage.output.uploadedBytes : null,
              })
            }
            if (name === 'promotion' && stage.output?.promotedAt) completedPromotionAt = stage.output.promotedAt
            if (name === 'promotion' && stage.output?.etag) completedPromotionEtag = stage.output.etag
          },
          refreshStateForUpload: ({ bucket, prefix, artifactCount, uploadedCount, uploadedBytes, unchangedCount, unchangedBytes, skipped, refreshTelemetry, storage }) => {
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
              ...(storage ? { storage } : {}),
            }
            state.lastRun = refreshTelemetry
            return state
          },
        })
        publishedBucket = bucketPublish
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
          ...(bucketPublish.storage ? { storage: bucketPublish.storage } : {}),
        }
        state.lastRun = bucketPublish.refreshTelemetry
        canonicalMetrics = bucketPublish.refreshTelemetry
        const optionalSkippedMessage = bucketPublish.skipped?.length ? `; skipped ${bucketPublish.skipped.length} optional artifact(s)` : ''
        console.log(`Uploaded ${bucketPublish.uploadedCount} ranking artifact(s) (${bucketPublish.uploadedBytes} bytes); reused ${bucketPublish.unchangedCount} unchanged artifact(s) (${bucketPublish.unchangedBytes} bytes) in Railway bucket prefix ${bucketPublish.prefix || '(root)'}${optionalSkippedMessage}.`)
      }
    } else if (!skipCrunch) {
      state.bucket = {
        enabled: false,
        skipped: true,
      }
    }

    state.lastRun ??= completeRefreshMetrics(metrics.snapshot({ result: 'completed' }))
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)
    console.log(`Source data changed; refreshed ranking artifacts for ${start} through ${end}.`)
    return {
      changed: true,
      fingerprint: fingerprint.fingerprint,
      healthFingerprint: fingerprint.healthFingerprint,
      previousFingerprint: previousState?.fingerprint,
      ...(publishedGenerationId ? { generationId: publishedGenerationId } : {}),
      ...(incrementalBuild ? {
        incrementalAction: incrementalBuild.action,
        incrementalMetrics: incrementalBuild.metrics,
      } : {}),
      ...(rawSourceGeneration ? { sourceReceiptDigest: rawSourceGeneration.sourceReceiptDigest } : {}),
      ...(stagingManifestForRun.sourceAuthorityEvidence?.evidenceDigest
        ? { sourceAuthorityEvidenceDigest: stagingManifestForRun.sourceAuthorityEvidence.evidenceDigest }
        : {}),
      ...(publishedBucket ? { bucketPublish: publishedBucket } : {}),
    }
  } catch (error) {
    refreshError = error
    metrics.recordProcessResource({
      processKey: `${runId}:raw-source-subprocess`,
      cpuSeconds: error?.telemetry?.cpuSeconds ?? null,
      memoryGbSeconds: error?.telemetry?.memoryGbSeconds ?? null,
      peakRssBytes: error?.telemetry?.peakRssBytes ?? null,
      sampleCount: error?.telemetry?.sampleCount ?? 0,
    })
    const failedManifest = await readJsonIfExists(stagingManifestPath)
    if (failedManifest?.fetchTelemetry) {
      metrics.recordWork({
        providerRequests: finiteOrNull(failedManifest.fetchTelemetry.requests),
        providerRetries: finiteOrNull(failedManifest.fetchTelemetry.retryCount),
      })
    }
    canonicalMetrics = aggregateMetrics(inheritedMetrics, metrics, {
      result: 'failed',
      error,
      freshness: { providerAvailableAt, publishedAt: completedPromotionAt ?? null },
    })
    if (completedPromotionEtag && env.RANKING_REFRESH_LEASE_OWNER && env.RANKING_REFRESH_FENCING_TOKEN) {
      canonicalMetrics = {
        ...canonicalMetrics,
        coordination: {
          owner: env.RANKING_REFRESH_LEASE_OWNER,
          fencingToken: Number(env.RANKING_REFRESH_FENCING_TOKEN),
          etag: completedPromotionEtag,
        },
      }
    }
    try {
      const state = refreshState ?? await readJsonIfExists(statePath) ?? { schemaVersion: 1, status: 'failed' }
      state.lastRun = canonicalMetrics
      await mkdir(dirname(statePath), { recursive: true })
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)
    } catch (stateError) {
      console.warn(`Unable to persist failed refresh telemetry: ${errorMessage(stateError)}`)
    }
    throw error
  } finally {
    if (metricsPath) {
      if (canonicalMetrics) {
        await writeRefreshMetrics(metricsPath, canonicalMetrics)
      } else {
        let own = completeRefreshMetrics(metrics.snapshot({
          result: refreshError ? 'failed' : terminalResult,
          error: refreshError,
          freshness: { providerAvailableAt, publishedAt: completedPromotionAt ?? null },
        }))
        if (completedPromotionEtag && env.RANKING_REFRESH_LEASE_OWNER && env.RANKING_REFRESH_FENCING_TOKEN) {
          own = {
            ...own,
            coordination: {
              owner: env.RANKING_REFRESH_LEASE_OWNER,
              fencingToken: Number(env.RANKING_REFRESH_FENCING_TOKEN),
              etag: completedPromotionEtag,
            },
          }
        }
        const existing = await readRefreshMetrics(metricsPath)
        await writeRefreshMetrics(metricsPath, existing ? mergeRefreshMetrics(existing, own) : own)
      }
    }
    const temporaryPublicDir = incrementalBuild?.build?.publicDataDir
    if (temporaryPublicDir && temporaryPublicDir !== publicDataDir) {
      await rm(temporaryPublicDir, { recursive: true, force: true })
    }
    await rm(stagingDir, { recursive: true, force: true })
    await rm(rawWorkerDir, { recursive: true, force: true })
  }
}

export async function invokeFullAuditStageIfEligible(input, invoke) {
  const raw = input.rawReceiptAuthority
  const eligible = (input.cause === 'daily-audit' || input.cause === 'manual-force')
    && input.result === 'publish-full'
    && typeof input.fullSnapshotPath === 'string'
    && Boolean(input.fullSnapshotDescriptor)
    && typeof input.generationId === 'string'
    && Number.isSafeInteger(input.fencingToken)
    && Boolean(input.stateManifestAuthority?.key && input.stateManifestAuthority?.digest)
    && Boolean((raw?.reference ?? raw?.receiptReference)?.key && raw?.receipt)
  return eligible ? invoke() : undefined
}

export async function invokeFullAuditReceiptIfEligible(input, invoke) {
  return input.stagedAudit && isFullAuditEligible(input) ? invoke() : undefined
}

function aggregateMetrics(inherited, metrics, options) {
  const own = completeRefreshMetrics(metrics.snapshot(options))
  return inherited ? completeRefreshMetrics(mergeRefreshMetrics(inherited, own)) : own
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

async function attemptOptionalRawRestore(options) {
  try {
    return await restoreRawFromBucketIfMissing(options)
  } catch (error) {
    return {
      restored: false,
      reason: 'verified-authority-invalid',
      error: errorMessage(error),
    }
  }
}

async function restoreRawFromBucketIfMissing({ rawDir, manifestPath, hasUsableLocalRawBaseline, config, client, rawWorkerDir }) {
  if (hasUsableLocalRawBaseline) {
    return {
      restored: false,
      reason: 'local-baseline-present',
    }
  }

  const activeRaw = await readActiveRawSourceAuthority({ config, client })
  if (activeRaw.found) {
    if (typeof activeRaw.streamObjectToFile !== 'function') throw new Error('Active raw authority cannot stream objects for isolated restore')
    const objectFiles = await stageRawAuthorityObjectFiles(activeRaw, resolve(rawWorkerDir, 'restore-objects'))
    const stagedAuthority = {
      ...activeRaw,
      objectResolver: (reference) => {
        const path = objectFiles[reference.key]
        return path ? readFile(path) : undefined
      },
    }
    await validateRawSourceAuthority(stagedAuthority, {
      importerVersion: RANKING_INCREMENTAL_IMPORTER_VERSION,
    })
    const materialized = await runRawSourceWorker({
      action: 'restore',
      receipt: activeRaw.receipt,
      objectFiles,
      destinationDir: rawDir,
      generatedAt: new Date().toISOString(),
    }, rawWorkerDir)
    if (resolve(materialized.manifestPath) !== resolve(manifestPath)) {
      await writeFileAtomically(manifestPath, await readFile(materialized.manifestPath))
    }
    return {
      restored: true,
      mode: activeRaw.receipt.storageMode,
      generationId: activeRaw.receipt.generationId,
      manifestRestored: true,
      sourceReceiptDigest: activeRaw.receipt.sourceReceiptDigest,
      childMaxRssBytes: materialized.childMaxRssBytes,
      childDurationMs: materialized.restoreMs,
    }
  }
  return {
    restored: false,
    reason: activeRaw.reason ?? 'verified-authority-missing',
  }
}

async function restoreVerifiedRawRecovery({
  config,
  client,
  stagingDir,
  rawWorkerDir,
  generatedAt,
  importerVersion,
}) {
  const activeRaw = await readActiveRawSourceAuthority({ config, client })
  if (!activeRaw.found) throw new Error(`Verified raw source authority is unavailable: ${activeRaw.reason}`)
  if (typeof activeRaw.streamObjectToFile !== 'function') throw new Error('Active raw authority cannot stream objects for isolated recovery')
  const objectFiles = await stageRawAuthorityObjectFiles(activeRaw, resolve(rawWorkerDir, 'recovery-objects'))
  const stagedAuthority = {
    ...activeRaw,
    objectResolver: (reference) => {
      const path = objectFiles[reference.key]
      return path ? readFile(path) : undefined
    },
  }
  const validated = await validateRawSourceAuthority(stagedAuthority, { importerVersion })
  const materialized = await runRawSourceWorker({
    action: 'restore',
    receipt: validated.receipt,
    objectFiles,
    destinationDir: stagingDir,
    generatedAt,
  }, rawWorkerDir)
  if (materialized.sourceReceiptDigest !== validated.receipt.sourceReceiptDigest) {
    throw new Error('Recovered raw materialization lost source receipt provenance')
  }
  return { validated, materialized }
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
  sourceAuthorityEvidence,
  reason,
}) {
  return {
    schemaVersion: 1,
    status: 'stale-source',
    reason,
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
    sourceAuthorityEvidence,
    crunch: {
      skipped: true,
      reason,
    },
    publish: {
      skipped: true,
      reason,
    },
  }
}

export function sourceProviderResult(manifest, forcedStatus) {
  const sources = manifest?.sources ?? {}
  const warnings = arrayValue(manifest?.warnings)
  const sourceRecords = Object.values(sources)
    .filter((source) => typeof source === 'object' && source !== null)
  const failed = sourceRecords.some((source) => ['failed', 'error', 'unavailable'].includes(source.status)
    || ['failedThisRun', 'failedCount', 'failureCount'].some((field) => Number(source[field]) > 0))
  return {
    status: forcedStatus ?? (failed ? 'unavailable' : 'no-data'),
    sources,
    warnings,
  }
}

async function readValidProviderManifest(path, providerCommandError, expected) {
  let value
  try {
    value = await readJson(path)
  } catch (manifestError) {
    if (providerCommandError) throw providerCommandError
    throw manifestError
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1
    || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)
    || !value.sources || typeof value.sources !== 'object' || Array.isArray(value.sources)) {
    if (providerCommandError) throw providerCommandError
    throw new Error('Provider downloader emitted an invalid manifest')
  }
  if (providerCommandError) {
    try {
      await assertCanonicalDownloaderOutageManifest(value, expected)
    } catch {
      throw providerCommandError
    }
  }
  return value
}

async function assertCanonicalDownloaderOutageManifest(value, { start, end, stagingDir }) {
  if (value.start !== start || value.end !== end || !isIsoDate(value.start) || !isIsoDate(value.end)
    || value.start > value.end || !isIsoTimestamp(value.generatedAt)
    || (value.status !== undefined && value.status !== 'failed')) {
    throw new Error('Provider outage manifest coverage is invalid')
  }
  if (!Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== 'string')) {
    throw new Error('Provider outage manifest warnings are invalid')
  }
  const fileGroups = {
    oracle: ['oracleCsv', 'primary'],
    leaguepedia: ['leaguepediaJson', 'backup-gap-fill'],
    lolesports: ['lolEsportsJson', 'schedule-results-reference'],
  }
  if (Object.keys(value.files).sort().join(',') !== ['leaguepediaJson', 'lolEsportsJson', 'oracleCsv'].sort().join(',')) {
    throw new Error('Provider outage manifest file groups are invalid')
  }
  const root = resolve(stagingDir)
  const rootPrefix = `${root}${sep}`
  const allPaths = []
  for (const [provider, [fileGroup, role]] of Object.entries(fileGroups)) {
    const paths = value.files[fileGroup]
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string' || path.length === 0)) {
      throw new Error(`Provider outage manifest ${fileGroup} is invalid`)
    }
    for (const path of paths) {
      const resolvedPath = resolve(root, path)
      if (resolvedPath !== root && !resolvedPath.startsWith(rootPrefix)) {
        throw new Error(`Provider outage manifest ${fileGroup} escapes staging`)
      }
      await access(resolvedPath, fsConstants.R_OK)
      allPaths.push(resolvedPath)
    }
    const source = value.sources[provider]
    assertCanonicalDownloaderSource(source, { provider, role, downloadedCount: paths.length })
  }
  if (new Set(allPaths).size !== allPaths.length || manifestHasCurrentMatchSourceFiles(value)) {
    throw new Error('Provider outage manifest files are duplicate or contain current match data')
  }
  const telemetry = value.fetchTelemetry
  if (!isRecord(telemetry)
    || !isNonNegativeInteger(telemetry.requests)
    || !isNonNegativeInteger(telemetry.retryCount)
    || !Array.isArray(telemetry.retries)
    || !Array.isArray(telemetry.attempts)
    || telemetry.retryCount !== telemetry.retries.length
    || (telemetry.elapsedMs !== undefined && (!Number.isFinite(telemetry.elapsedMs) || telemetry.elapsedMs < 0))) {
    throw new Error('Provider outage manifest fetch telemetry is invalid')
  }
}

function assertCanonicalDownloaderSource(source, { provider, role, downloadedCount }) {
  if (!isRecord(source) || source.role !== role
    || !['downloaded', 'partial', 'failed', 'skipped', 'unavailable'].includes(source.status)
    || !isNonNegativeInteger(source.downloadedCount) || source.downloadedCount !== downloadedCount
    || !isNonNegativeInteger(source.downloadedThisRun) || source.downloadedThisRun !== downloadedCount
    || !isNonNegativeInteger(source.failedCount)
    || !isNonNegativeInteger(source.failedThisRun)
    || !Array.isArray(source.failures)
    || source.failedCount !== source.failures.length
    || source.failedThisRun !== source.failures.length
    || typeof source.skipped !== 'boolean'
    || typeof source.required !== 'boolean') {
    throw new Error(`Provider outage manifest ${provider} source record is invalid`)
  }
  for (const failure of source.failures) {
    if (!isRecord(failure) || typeof failure.source !== 'string' || failure.source.length === 0
      || typeof failure.error !== 'string' || failure.error.length === 0
      || (failure.url !== undefined && (typeof failure.url !== 'string' || failure.url.length === 0))) {
      throw new Error(`Provider outage manifest ${provider} failure record is invalid`)
    }
  }
  const hasDownloads = downloadedCount > 0
  const hasFailures = source.failures.length > 0
  const expectedStatus = source.skipped
    ? 'skipped'
    : hasDownloads && hasFailures ? 'partial'
      : hasDownloads ? 'downloaded'
        : hasFailures ? 'failed' : 'unavailable'
  if (source.status !== expectedStatus) throw new Error(`Provider outage manifest ${provider} status is inconsistent`)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  try {
    return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
  } catch {
    return false
  }
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string') return false
  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
}

async function writeFileAtomically(path, bytes) {
  const temporary = `${resolve(path)}.${process.pid}.${Date.now()}.tmp`
  await mkdir(dirname(resolve(path)), { recursive: true })
  await writeFile(temporary, bytes, { flag: 'wx' })
  await rename(temporary, resolve(path))
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

async function stageRawAuthorityObjectFiles(authority, destinationDir) {
  const references = [
    ...authority.receipt.oracle.flatMap((source) => [source.baseline, ...source.deltas]),
    ...authority.receipt.leaguepedia.map((source) => source.object),
    ...authority.receipt.lolesports.map((source) => source.object),
  ]
  const unique = new Map(references.map((reference) => [reference.key, reference]))
  await rm(destinationDir, { recursive: true, force: true })
  await mkdir(destinationDir, { recursive: true })
  const objectFiles = {}
  for (const [key, reference] of unique) {
    const path = resolve(destinationDir, reference.sha256)
    await authority.streamObjectToFile(reference, path)
    objectFiles[key] = path
  }
  return objectFiles
}

async function runRawSourceWorker(input, workerDir) {
  await mkdir(workerDir, { recursive: true })
  const nonce = `${input.action}-${process.pid}-${Date.now()}`
  const inputPath = resolve(workerDir, `${nonce}.input.json`)
  const outputPath = resolve(workerDir, `${nonce}.output.json`)
  await writeFile(inputPath, `${JSON.stringify(input)}\n`, { flag: 'wx' })
  const stderr = []
  try {
    await new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [
        ...rawSourceWorkerExecArgv(process.execArgv),
        resolve('scripts/raw-source-worker.mjs'),
        inputPath,
        outputPath,
      ], { stdio: ['ignore', 'ignore', 'pipe'] })
      child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
      child.on('error', rejectRun)
      child.on('exit', (code) => {
        if (code === 0) resolveRun()
        else rejectRun(new Error(`Raw source worker ${input.action} exited with ${code}: ${Buffer.concat(stderr).toString('utf8')}`))
      })
    })
    const output = await readJson(outputPath)
    if (output?.action !== input.action || !Number.isSafeInteger(output.childMaxRssBytes) || output.childMaxRssBytes <= 0) {
      throw new Error(`Raw source worker ${input.action} produced an invalid descriptor`)
    }
    return output
  } finally {
    await rm(inputPath, { force: true })
    await rm(outputPath, { force: true })
  }
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

function finiteOrNull(value) {
  return Number.isFinite(value) ? Number(value) : null
}

function parseAffectedIds(value) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed.map(String)
  } catch {
    // Accept a compact comma-separated fallback for manual runs.
  }
  return String(value).split(',').map((entry) => entry.trim()).filter(Boolean)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function uniqueValues(values) {
  return Array.from(new Set(values.filter((value) => value !== undefined && value !== null)))
}
