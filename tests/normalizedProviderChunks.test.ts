import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { createNormalizedOracleChunks } from '../scripts/normalized-provider-chunks.mjs'
import {
  loadIncrementalCommunityImports,
  promoteIncrementalState,
  type ProviderAuthorities,
} from '../scripts/incremental-provider-state.ts'
import { createCrunchCompatibility } from '../src/lib/incremental/compatibility.ts'

const header = 'gameid,date,year,league,split,playoffs,patch,position,side,teamname,result,kills,totalgold'
const game = (id: string, date: string, blueKills = 18) => [
  `${id},${date},${date.slice(0, 4)},LCK,Spring,0,26.1,team,Blue,Gen.G,1,${blueKills},65000`,
  `${id},${date},${date.slice(0, 4)},LCK,Spring,0,26.1,team,Red,T1,0,12,59000`,
]

test('normalized Oracle chunks are deterministic and isolate append/correction by calendar month', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-normalized-chunks-'))
  const rawDir = resolve(root, 'raw')
  const sourcePath = resolve(rawDir, 'oracles-elixir', '2026.csv')
  await mkdir(dirname(sourcePath), { recursive: true })
  await writeFile(sourcePath, [header, ...game('jan', '2026-01-10'), ...game('feb', '2026-02-10')].join('\n'))
  const manifest = { files: { oracleCsv: [sourcePath] } }
  const firstStaging = resolve(root, 'stage-1')
  const first = await createNormalizedOracleChunks({ manifest, rawDir, stagingDir: firstStaging })
  assert.deepEqual(first.diagnostics, {
    strategy: 'streaming-external-sort',
    sortBufferBytes: 32 * 1024 * 1024,
    peakParsedRowsRetained: 1,
    partitions: 2,
  })
  assert.deepEqual(first.chunks.map((chunk) => chunk.logicalId), [
    'normalized/oracles-elixir/2026-01.csv',
    'normalized/oracles-elixir/2026-02.csv',
  ])
  const januaryDigest = first.chunks[0]?.digest
  const februaryDigest = first.chunks[1]?.digest

  await writeFile(sourcePath, [header, ...game('jan', '2026-01-10'), ...game('feb', '2026-02-10'), ...game('feb-append', '2026-02-17')].join('\n'))
  const appended = await createNormalizedOracleChunks({ manifest, rawDir, stagingDir: resolve(root, 'stage-2') })
  assert.equal(appended.chunks[0]?.digest, januaryDigest)
  assert.notEqual(appended.chunks[1]?.digest, februaryDigest)

  await writeFile(sourcePath, [header, ...game('jan', '2026-01-10', 19), ...game('feb', '2026-02-10'), ...game('feb-append', '2026-02-17')].join('\n'))
  const corrected = await createNormalizedOracleChunks({ manifest, rawDir, stagingDir: resolve(root, 'stage-3') })
  assert.notEqual(corrected.chunks[0]?.digest, appended.chunks[0]?.digest)
  assert.equal(corrected.chunks[1]?.digest, appended.chunks[1]?.digest)
  const january = await readFile(resolve(root, 'stage-3', 'normalized/oracles-elixir/2026-01.csv'), 'utf8')
  assert.equal(january.split('\n')[0], header)
})

test('normalized Oracle chunks stream quoted records and reject duplicate identity conflicts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-normalized-streaming-'))
  const rawDir = resolve(root, 'raw')
  const sourcePath = resolve(rawDir, 'oracles-elixir', '2026.csv')
  await mkdir(dirname(sourcePath), { recursive: true })
  const quotedHeader = 'gameid,date,position,side,playerid,notes'
  await writeFile(sourcePath, [
    quotedHeader,
    'later,2026-01-20,team,Blue,,"line one\nline two"',
    'earlier,2026-01-10,team,Blue,,plain',
    'earlier,2026-01-10,team,Blue,,plain',
  ].join('\n'))
  const manifest = { files: { oracleCsv: [sourcePath] } }
  const normalized = await createNormalizedOracleChunks({ manifest, rawDir, stagingDir: resolve(root, 'stage') })
  assert.equal(normalized.chunks[0]?.rows, 2)
  const contents = await readFile(resolve(root, 'stage', 'normalized/oracles-elixir/2026-01.csv'), 'utf8')
  assert.match(contents, /"line one\nline two"/)
  assert.ok(contents.indexOf('earlier') < contents.indexOf('later'))

  await writeFile(sourcePath, [
    quotedHeader,
    'same,2026-01-10,team,Blue,,first',
    'same,2026-01-10,team,Blue,,second',
  ].join('\n'))
  await assert.rejects(
    createNormalizedOracleChunks({ manifest, rawDir, stagingDir: resolve(root, 'conflict-stage') }),
    /Conflicting Oracle row identity/,
  )
})

test('trusted chunk ledger reuses a virtual unchanged chunk and reads only the changed chunk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-trusted-chunks-'))
  const stateDir = resolve(root, 'state')
  const januaryPath = resolve(root, '2026-01.csv')
  const februaryPath = resolve(root, '2026-02.csv')
  const january = `${[header, ...game('jan', '2026-01-10')].join('\n')}\n`
  const february = `${[header, ...game('feb', '2026-02-10')].join('\n')}\n`
  await writeFile(januaryPath, january)
  await writeFile(februaryPath, february)
  const sourceIds = ['normalized/oracles-elixir/2026-01.csv', 'normalized/oracles-elixir/2026-02.csv']
  const input = inputFor({
    stateDir,
    paths: [januaryPath, februaryPath],
    sourceIds,
    trusted: Object.fromEntries([[sourceIds[0]!, trusted(january)], [sourceIds[1]!, trusted(february)]]),
  })
  const first = await loadIncrementalCommunityImports(input)
  assert.ok(first.promotion)
  await promoteIncrementalState(first.promotion)

  await rm(januaryPath)
  const changedFebruary = `${[header, ...game('feb', '2026-02-10'), ...game('feb-next', '2026-02-17')].join('\n')}\n`
  await writeFile(februaryPath, changedFebruary)
  const changed = await loadIncrementalCommunityImports(inputFor({
    stateDir,
    paths: [januaryPath, februaryPath],
    sourceIds,
    trusted: Object.fromEntries([[sourceIds[0]!, trusted(january)], [sourceIds[1]!, trusted(changedFebruary)]]),
  }))
  assert.equal(changed.fallback, undefined)
  assert.equal(changed.metrics.filesScanned, 1)
  assert.equal(changed.metrics.observationsReused, 2)
  assert.equal(changed.metrics.observationsNormalized, 1)
})

test('trusted chunk mismatch and unavailable cold materialization fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-trusted-chunk-failure-'))
  const path = resolve(root, 'missing.csv')
  const contents = `${[header, ...game('jan', '2026-01-10')].join('\n')}\n`
  await writeFile(path, `${contents}tamper`)
  const sourceId = 'normalized/oracles-elixir/2026-01.csv'
  const mismatch = await loadIncrementalCommunityImports(inputFor({
    stateDir: resolve(root, 'mismatch-state'),
    paths: [path],
    sourceIds: [sourceId],
    trusted: { [sourceId]: trusted(contents) },
  }))
  assert.equal(mismatch.fallback?.kind, 'checkpoint-corrupt')
  assert.match(mismatch.fallback?.kind === 'checkpoint-corrupt' ? mismatch.fallback.detail : '', /Trusted provider chunk mismatch/)

  await rm(path)
  const missing = await loadIncrementalCommunityImports(inputFor({
    stateDir: resolve(root, 'missing-state'),
    paths: [path],
    sourceIds: [sourceId],
    trusted: { [sourceId]: trusted(contents) },
  }))
  assert.equal(missing.fallback?.kind, 'checkpoint-corrupt')
  assert.match(missing.fallback?.kind === 'checkpoint-corrupt' ? missing.fallback.detail : '', /ENOENT/)
})

function trusted(contents: string) {
  return { digest: createHash('sha256').update(contents).digest('hex'), bytes: Buffer.byteLength(contents) }
}

function inputFor({
  stateDir,
  paths,
  sourceIds,
  trusted: trustedSources,
}: {
  stateDir: string
  paths: string[]
  sourceIds: string[]
  trusted: Record<string, { digest: string; bytes: number }>
}) {
  const authorities: ProviderAuthorities = {
    'oracles-elixir': { receiptId: 'trusted-test', fileSetAuthoritative: true, contentReplacementAuthoritative: true },
    'leaguepedia-cargo': { receiptId: 'none', fileSetAuthoritative: true, contentReplacementAuthoritative: true },
    'lol-esports-api': { receiptId: 'none', fileSetAuthoritative: true, contentReplacementAuthoritative: true },
  }
  return {
    stateDir,
    oracleCsvPaths: paths,
    leaguepediaJsonPaths: [],
    lolEsportsJsonPaths: [],
    oracleRetrievedAt: '2026-07-21T00:00:00.000Z',
    now: '2026-07-21T00:00:00.000Z',
    authorities,
    compatibility: createCrunchCompatibility({ pipeline: 'trusted-chunks-test' }),
    sourceIds: { 'oracles-elixir': sourceIds },
    trustedSources: { 'oracles-elixir': trustedSources },
  }
}
