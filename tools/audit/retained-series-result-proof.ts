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
  type SeriesResultDateBatch,
} from '../../src/domains/rankings/build.ts'
import { numberBits, runSeriesResultShadow, sha256 } from './series-result-shadow.ts'

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

export async function verifyRetainedSeriesResultShadow({ oracleCsvPath, leaguepediaJsonPath, binaryPath, outputDir }: {
  oracleCsvPath: string
  leaguepediaJsonPath: string
  binaryPath: string
  outputDir: string
}) {
  assert.equal(git('status', '--porcelain'), '', 'Retained proof requires a clean Git tree. Commit source first.')
  const sourceRevision = git('rev-parse', 'HEAD')
  const rawFiles = await Promise.all([fileIdentity(oracleCsvPath), fileIdentity(leaguepediaJsonPath)])
  assert(rawFiles.reduce((sum, file) => sum + file.bytes, 0) <= 64 << 20, 'Selected retained files exceed 64 MiB')
  const source = await importRankingSourceData({ oracleCsvPaths: [oracleCsvPath], leaguepediaJsonPaths: [leaguepediaJsonPath] })
  assert(source.matches.length > 0, 'No retained rating inputs')
  const preparedDigest = sha256(stableJson({ matches: source.matches, teams: source.teams }))
  const identity = {
    importerVersion: 'community-source-import-v1',
    identityTaxonomyHash: stableDigest(source.teams),
    rawLedgerPrefixHash: stableDigest(source.matches),
  }
  const replay = (onSeriesResultDate?: (date: SeriesResultDateBatch) => void) => {
    const context = createRatingReplayContext(structuredClone(source.matches), structuredClone(source.teams))
    const state = replayRatingDates({ context, replayMatches: context.authoritativeMatches, onSeriesResultDate })
    assert(state.previousMatch && state.processedThroughUtcDate, 'Retained replay has no terminal checkpoint')
    const checkpoint = encodeRatingCheckpointEnvelope(state, identity, {
      processedThroughUtcDate: state.processedThroughUtcDate,
      processedThroughMatchId: state.previousMatch.id,
    }, buildRatingCheckpointEventContract(context.authoritativeMatches, context.eventWeightContext, context.tournamentLifecycles))
    const output = materializeRankingModel({ context, state })
    return { checkpoint, output }
  }
  const baseline = replay()
  const dates: SeriesResultDateBatch[] = []
  const observed = replay((date) => dates.push(date))
  assert.deepStrictEqual(dates.flatMap((date) => date.authoritativeMatchIds).sort(),
    source.matches.map((match) => match.officialGameId ?? match.sourceGameId ?? match.id).sort(),
    'Capture must cover every authoritative retained match exactly once')
  assert.deepStrictEqual(observed.checkpoint, baseline.checkpoint, 'Observer changed terminal checkpoint')
  assert.deepStrictEqual(observed.output, baseline.output, 'Observer changed materialized rankings')
  assert.equal(sha256(stableJson({ matches: source.matches, teams: source.teams })), preparedDigest, 'Replay changed prepared source')
  const native = await runSeriesResultShadow({ dates, binaryPath, outputDir })
  assert.deepEqual(await Promise.all([fileIdentity(oracleCsvPath), fileIdentity(leaguepediaJsonPath)]), rawFiles, 'Retained source changed')
  assert.equal(git('rev-parse', 'HEAD'), sourceRevision, 'Git revision changed during proof')
  assert.equal(git('status', '--porcelain'), '', 'Source changed during proof')
  const captureBytes = JSON.stringify(dates, (_key, value: unknown) => typeof value === 'number' ? { binary64: numberBits(value) } : value)
  await writeFile(join(outputDir, 'captures.json'), captureBytes, { flag: 'wx' })
  const proof = {
    schema: 'retained-series-result-proof-v1', status: 'passed',
    sourceRevision, dirty: false, rawFiles,
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
      firstDate: dates[0]?.utcDate, lastDate: dates.at(-1)?.utcDate,
      ...native,
    },
    checkpoint: { exact: true, baselineSha256: sha256(stableJson(baseline.checkpoint)), observedSha256: sha256(stableJson(observed.checkpoint)) },
    rankingOutput: { exact: true, baselineSha256: sha256(stableJson(baseline.output)), observedSha256: sha256(stableJson(observed.output)) },
    captureSha256: sha256(captureBytes),
    syntheticSeries: 0,
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
  const proof = await verifyRetainedSeriesResultShadow({
    oracleCsvPath: options.get('--oracle')!, leaguepediaJsonPath: options.get('--leaguepedia')!,
    binaryPath: options.get('--binary')!, outputDir: resolve(options.get('--output-dir')!),
  })
  console.log(JSON.stringify(proof.retained, null, 2))
}
