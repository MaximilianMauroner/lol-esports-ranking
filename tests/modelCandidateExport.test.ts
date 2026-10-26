import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { importRankingSourceData } from '../scripts/rankings/source-input.ts'
import { rankingSourceProvenance } from '../scripts/rankings/source-provenance.ts'
import { sampleMatches } from './fixtures/rankingFixtures.ts'

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const entry = resolve('tools/calibration/export-model-candidate.ts')
const baselineEntry = resolve('scripts/rankings/export-pregame-series.ts')
const cutoff = Date.parse('2026-02-10T10:00:00Z')

async function fixture(directory: string) {
  const manifestPath = join(directory, 'manifest.json')
  const requestsPath = join(directory, 'requests.json')
  const candidatePath = join(directory, 'candidate.json')
  await writeFile(join(directory, 'raw.json'), JSON.stringify({ fetchedAt: '2026-02-09T00:00:00Z',
    matches: sampleMatches.slice(0, 2).map((match, index) => ({ ...match, id: `candidate-game-${index}`,
      sourceProvider: 'leaguepedia-cargo', sourceGameId: `source-${index}` })) }))
  await writeFile(manifestPath, JSON.stringify({ generatedAt: '2026-02-09T00:00:00Z', files: { leaguepediaJson: ['raw.json'] } }))
  const source = await importRankingSourceData({ manifestPath })
  await writeFile(requestsPath, JSON.stringify({ evidenceMode: 'synthetic', availability: 'verified',
    observations: source.matches.map(match => ({ gameId: match.id, observedAt: Date.parse(match.date) + 3600_000,
      resultAvailableAt: Date.parse(match.date) + 3600_000 })), requests: [{
      seriesId: 'candidate-series', eventId: 'candidate-event', homeTeamId: 'gen', awayTeamId: 't1',
      homeSourceTeam: 'Gen.G', awaySourceTeam: 'T1', bestOf: 3, scheduleRevision: 'revision-1',
      scheduledStartAt: cutoff + 7200_000, scheduleObservedAt: cutoff - 1000, scheduleProvider: 'lolesports-schedule',
      asOf: cutoff, validUntil: cutoff + 7000_000, event: 'LCK 2026 Spring', patch: '26.1', season: 2026,
      league: 'LCK', region: 'LCK', tier: 'regional-regular',
    }] }))
  const candidate = { candidateId: 'baseline', parentCandidateId: null, calibrationFit: null,
    transform: { temperature: 1, calibrationOrder: 'game-before-series', dependence: 0 } }
  await writeFile(candidatePath, JSON.stringify(candidate))
  return { manifestPath, requestsPath, candidatePath, candidate }
}

function run(entryPath: string, files: Awaited<ReturnType<typeof fixture>>, output: string) {
  execFileSync(process.execPath, ['--import', 'tsx', entryPath, files.manifestPath, files.requestsPath, files.candidatePath, output],
    { cwd: process.cwd(), timeout: 60_000, stdio: 'pipe' })
}

test('candidate CLI runs bounded source overrides with retained provenance and unchanged root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'model-candidate-'))
  try {
    const files = await fixture(directory)
    const direct = join(directory, 'direct.jsonl')
    const baseline = join(directory, 'baseline.jsonl')
    run(baselineEntry, files, direct)
    run(entry, files, baseline)
    const directReceipt = JSON.parse(await readFile(direct, 'utf8'))
    const baselineReceipt = JSON.parse(await readFile(baseline, 'utf8'))
    delete directReceipt.generatedAt
    delete baselineReceipt.generatedAt
    assert.deepEqual(baselineReceipt, directReceipt)
    assert.equal(await readFile(`${baseline}.states.jsonl`, 'utf8'), await readFile(`${direct}.states.jsonl`, 'utf8'))
    await assert.rejects(stat(`${baseline}.source`), { code: 'ENOENT' })

    const modelParameters = { recencyHalfLifeDays: 240, momentumGameDecay: 0.75, winProbabilityUncertaintyScale: 400 }
    await writeFile(files.candidatePath, JSON.stringify({ ...files.candidate, candidateId: 'changed', parentCandidateId: 'baseline', modelParameters }))
    const before = await rankingSourceProvenance(process.cwd())
    const changed = join(directory, 'changed.jsonl')
    run(entry, files, changed)
    const receipt = JSON.parse(await readFile(changed, 'utf8'))
    const sidecar = JSON.parse(await readFile(`${changed}.manifest.json`, 'utf8'))
    assert.notEqual(receipt.homeSeriesWinProbability, baselineReceipt.homeSeriesWinProbability)
    assert.notEqual(receipt.modelStateHash, baselineReceipt.modelStateHash)
    assert.notEqual(receipt.sourceHash, baselineReceipt.sourceHash)
    assert.deepEqual(sidecar.modelParameters, modelParameters)
    assert.deepEqual(sidecar.baseSourceDigests, before.sourceDigests)
    assert.deepEqual(await rankingSourceProvenance(process.cwd()), before)
    assert.equal(sidecar.sourceHash, receipt.sourceHash)
    assert.equal(sidecar.sourceHash, sha256(JSON.stringify(sidecar.sourceDigests)))
    for (const source of sidecar.sourceDigests) assert.equal(sha256(await readFile(join(sidecar.sourceRoot, source.path))), source.sha256)
    assert.equal(sha256(await readFile(join(sidecar.sourceRoot, 'pnpm-lock.yaml'))), receipt.dependencyLockHash)
    const config = sidecar.sourceDigests.find((source: { path: string }) => source.path.endsWith('/modelConfig.ts'))
    assert.ok(config)
    assert.notEqual(config.sha256, before.sourceDigests.find(source => source.path === config.path)?.sha256)
    const configPath = join(sidecar.sourceRoot, config.path)
    assert.equal((await stat(configPath)).mode & 0o222, 0)
    await chmod(configPath, 0o644)
    await writeFile(configPath, 'tampered source')
    assert.notEqual((await rankingSourceProvenance(sidecar.sourceRoot, process.cwd())).sourceHash, receipt.sourceHash)
    assert.throws(() => run(entry, files, changed), /Command failed/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('candidate CLI rejects unknown, nonnumeric and out-of-bounds parameters before replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'invalid-model-candidate-'))
  try {
    const files = await fixture(directory)
    const output = join(directory, 'invalid.jsonl')
    for (const modelParameters of [{ madeUp: 1 }, { momentumCap: 101 }, { momentumCap: 29 }, { momentumCap: '50' }, [], null]) {
      await writeFile(files.candidatePath, JSON.stringify({ ...files.candidate, modelParameters }))
      assert.throws(() => run(entry, files, output), /model parameter|outside bounds|modelParameters/)
      await assert.rejects(stat(output), { code: 'ENOENT' })
      await assert.rejects(stat(`${output}.source`), { code: 'ENOENT' })
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
