import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { importRankingSourceData } from '../../scripts/rankings/source-input.ts'
import {
  buildRatingCheckpointEventContract, createRatingReplayContext, encodeRatingCheckpointEnvelope,
  materializeRankingModel, replayRatingDates, stableDigest, stableJson, transparentGprModelMetadata,
  type SeriesPassCapture,
} from '../../src/domains/rankings/build.ts'
import { numberBits, runSeriesPassShadow, sha256 } from './series-pass-shadow.ts'

const PINNED = {
  rawFiles: [
    { bytes: 48355282, sha256: 'd770bd62e744bc9be86e1e0a55f73769a6dc9b4f7cbb7534d9aeb6849a08f227' },
    { bytes: 69931, sha256: 'b0dfdb62b383948f59efc02ad2c87e0bb8d0a307f133348929e04b2f8fdb8b0b' },
  ],
  preparedMatchesTeamsSha256: 'cf8819316a4679edb8ad545095440dc8ed6687fcea52bd40ddbcfe658a37d6c2',
  importer: { importerVersion: 'community-source-import-v1', identityTaxonomyHash: 'fnv1a64-80e6a738dbc9d2a4', rawLedgerPrefixHash: 'fnv1a64-317f66c498134811' },
  sourcePipelineVersion: 'canonical-identity-stat-dedupe-clock-corroboration-feasible-series-player-performance-home-league-code-unit-order-v23',
  modelVersion: 'transparent-power-index-v0.2.0', modelConfigHash: 'fnv1a-5eebb6ce',
  checkpointSha256: '3decc95c896b509f38cfb13ed7f18e6dd2cd66f0b196f1852fdbaade7a65d45a',
  rankingOutputSha256: '5ac9c232a264ee88c7a27892132a63d92ab619ce64a94de04c4d615a0a1346fc',
}

async function binaryIdentity(path: string) {
  const binary = resolve(path)
  assert.equal(binary, resolve('worker/target/debug/ranking-refresh'), "Use this worktree's fresh debug binary")
  const details = await stat(binary)
  const sources = git('ls-files', 'worker').split('\n').filter(Boolean)
  for (const source of sources) assert(details.mtimeMs >= (await stat(source)).mtimeMs, `Native binary predates ${source}`)
  return { path: binary, bytes: details.size, sha256: sha256(await readFile(binary)), modifiedAt: details.mtime.toISOString() }
}

async function fileIdentity(path: string) {
  const size = (await stat(path)).size
  assert(size > 0 && size <= 64 << 20, `Retained source exceeds bounds: ${path}`)
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length
    assert(bytes <= 64 << 20, 'Retained source grew beyond bounds')
    hash.update(chunk)
  }
  assert.equal(bytes, size, 'Retained source size changed')
  return { path: resolve(path), bytes, sha256: hash.digest('hex') }
}
function git(...args: string[]) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 20 }).trim()
}

export async function verifyRetainedSeriesPassShadow({ oracleCsvPath, leaguepediaJsonPath, binaryPath, outputDir }: {
  oracleCsvPath: string
  leaguepediaJsonPath: string
  binaryPath: string
  outputDir: string
}) {
  assert.equal(git('status', '--porcelain'), '', 'Retained proof requires a clean Git tree. Commit source first.')
  const sourceRevision = git('rev-parse', 'HEAD')
  const rawFiles = await Promise.all([fileIdentity(oracleCsvPath), fileIdentity(leaguepediaJsonPath)])
  assert.deepEqual(rawFiles.map(({ bytes, sha256 }) => ({ bytes, sha256 })), PINNED.rawFiles, 'Retained input identity differs')
  const binaryBefore = await binaryIdentity(binaryPath)
  const sourceTree = git('rev-parse', 'HEAD^{tree}')
  const modelBefore = structuredClone(transparentGprModelMetadata)
  assert.equal(modelBefore.version, PINNED.modelVersion)
  assert.equal(modelBefore.configHash, PINNED.modelConfigHash)
  assert.equal(modelBefore.parameters.sourcePipelineVersion, PINNED.sourcePipelineVersion)
  assert(rawFiles.reduce((sum, file) => sum + file.bytes, 0) <= 64 << 20, 'Selected retained files exceed 64 MiB')
  const source = await importRankingSourceData({ oracleCsvPaths: [oracleCsvPath], leaguepediaJsonPaths: [leaguepediaJsonPath] })
  assert(source.matches.length > 0, 'No retained rating inputs')
  const preparedDigest = sha256(stableJson({ matches: source.matches, teams: source.teams }))
  const identity = {
    importerVersion: 'community-source-import-v1',
    identityTaxonomyHash: stableDigest(source.teams),
    rawLedgerPrefixHash: stableDigest(source.matches),
  }
  assert.equal(preparedDigest, PINNED.preparedMatchesTeamsSha256, 'Prepared retained input differs')
  assert.deepEqual(identity, PINNED.importer, 'Retained importer identity differs')
  const identitiesBefore = { rawFiles, preparedDigest, importer: identity, sourceRevision, sourceTree,
    model: modelBefore, binary: binaryBefore }
  const replay = (onSeriesPassDate?: (date: SeriesPassCapture) => void) => {
    const context = createRatingReplayContext(structuredClone(source.matches), structuredClone(source.teams))
    const state = replayRatingDates({ context, replayMatches: context.authoritativeMatches, onSeriesPassDate })
    assert(state.previousMatch && state.processedThroughUtcDate, 'Retained replay has no terminal checkpoint')
    const checkpoint = encodeRatingCheckpointEnvelope(state, identity, {
      processedThroughUtcDate: state.processedThroughUtcDate,
      processedThroughMatchId: state.previousMatch.id,
    }, buildRatingCheckpointEventContract(context.authoritativeMatches, context.eventWeightContext, context.tournamentLifecycles))
    const output = materializeRankingModel({ context, state })
    return { checkpoint, output }
  }
  const baseline = replay()
  const captures: SeriesPassCapture[] = []
  const observed = replay((capture) => captures.push(capture))
  assert.deepStrictEqual(captures.flatMap((capture) => capture.frame.authoritativeMatchIds).sort(),
    source.matches.map((match) => match.officialGameId ?? match.sourceGameId ?? match.id).sort(),
    'Capture must cover every authoritative retained match exactly once')
  assert.deepStrictEqual(observed.checkpoint, baseline.checkpoint, 'Observer changed terminal checkpoint')
  assert.deepStrictEqual(observed.output, baseline.output, 'Observer changed materialized rankings')
  assert.equal(sha256(stableJson({ matches: source.matches, teams: source.teams })), preparedDigest, 'Replay changed prepared source')
  const native = await runSeriesPassShadow({ captures, binaryPath, outputDir })
  assert.deepEqual(await Promise.all([fileIdentity(oracleCsvPath), fileIdentity(leaguepediaJsonPath)]), rawFiles, 'Retained source changed')
  assert.equal(git('rev-parse', 'HEAD'), sourceRevision, 'Git revision changed during proof')
  assert.equal(git('status', '--porcelain'), '', 'Source changed during proof')
  const identitiesAfter = {
    rawFiles: await Promise.all([fileIdentity(oracleCsvPath), fileIdentity(leaguepediaJsonPath)]),
    preparedDigest: sha256(stableJson({ matches: source.matches, teams: source.teams })),
    importer: { importerVersion: 'community-source-import-v1', identityTaxonomyHash: stableDigest(source.teams), rawLedgerPrefixHash: stableDigest(source.matches) },
    sourceRevision: git('rev-parse', 'HEAD'), sourceTree: git('rev-parse', 'HEAD^{tree}'),
    model: structuredClone(transparentGprModelMetadata), binary: await binaryIdentity(binaryPath),
  }
  assert.deepEqual(identitiesAfter, identitiesBefore, 'Proof identities changed during execution')
  const checkpointSha256 = sha256(stableJson(baseline.checkpoint))
  const rankingSha256 = sha256(stableJson(baseline.output))
  assert.equal(checkpointSha256, PINNED.checkpointSha256, 'Unchanged Node checkpoint differs from first-unit proof')
  assert.equal(rankingSha256, PINNED.rankingOutputSha256, 'Unchanged Node ranking output differs from first-unit proof')
  const captureBytes = JSON.stringify(captures, (_key, value: unknown) => typeof value === 'number' ? { binary64: numberBits(value) } : value)
  await writeFile(join(outputDir, 'captures.json'), captureBytes, { flag: 'wx' })
  const proof = {
    schema: 'retained-series-pass-proof-v1', status: 'passed',
    sourceRevision, sourceTree, dirty: false, rawFiles, identitiesBefore, identitiesAfter,
    preparedMatchesTeamsSha256: preparedDigest,
    source: source.source, sourceMode: source.dataMode, externalSources: source.externalSources,
    importer: identity,
    sourcePipelineVersion: transparentGprModelMetadata.parameters.sourcePipelineVersion,
    model: transparentGprModelMetadata,
    node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch,
    rust: execFileSync('rustc', ['--version', '--verbose'], { encoding: 'utf8' }).trim(),
    cargoLockSha256: sha256(await readFile('worker/Cargo.lock')),
    retained: {
      importedGames: source.importedMatches.length, ratedGames: source.matches.length, teams: Object.keys(source.teams).length,
      gamesWithRosters: source.matches.filter((match) => match.teamARoster && match.teamBRoster).length,
      internationalGames: source.matches.filter((match) => match.region === 'International').length,
      firstDate: captures[0]?.frame.utcDate, lastDate: captures.at(-1)?.frame.utcDate,
      ...native,
    },
    checkpoint: { exact: true, historicalBaselineMatched: true, baselineSha256: sha256(stableJson(baseline.checkpoint)), observedSha256: sha256(stableJson(observed.checkpoint)) },
    rankingOutput: { exact: true, historicalBaselineMatched: true, baselineSha256: sha256(stableJson(baseline.output)), observedSha256: sha256(stableJson(observed.output)) },
    captureSha256: sha256(captureBytes),
    syntheticSeries: 0,
    scope: 'Native numeric series state pass on independent complete-date frames. Node retains date preparation, predictions, full histories and ranks, trackers, previousMatch, date commit, replay, checkpoints, materialization and publication.',
  }
  await writeFile(join(outputDir, 'proof.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
  return proof
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  assert.equal(args.length, 8, 'Usage: --oracle <csv> --leaguepedia <json> --binary <executable> --output-dir <new-directory>')
  const options = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    assert(['--oracle', '--leaguepedia', '--binary', '--output-dir'].includes(args[index]) && !options.has(args[index]), 'Invalid proof option')
    options.set(args[index], args[index + 1])
  }
  const proof = await verifyRetainedSeriesPassShadow({
    oracleCsvPath: options.get('--oracle')!, leaguepediaJsonPath: options.get('--leaguepedia')!,
    binaryPath: options.get('--binary')!, outputDir: resolve(options.get('--output-dir')!),
  })
  console.log(JSON.stringify(proof.retained, null, 2))
}
