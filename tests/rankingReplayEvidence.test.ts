import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { createReplayEvidence, buildRankingModel, createStaticRankingData } from '../src/domains/rankings/build.ts'
import { readReplayEvidence, replayPregameWinRate, type ReplayEvidence } from '../src/domains/rankings/published-read.ts'
import { createPublicArtifactWritePlan, PUBLIC_ARTIFACT_PATHS } from '../src/domains/rankings/artifact-write.ts'
import { artifactReferences, assertReferenceClosure } from '../src/domains/rankings/internal/published/logicalReferences.mjs'
import { createGenerationManifest, prepareSemanticArtifact } from '../scripts/public-artifact-storage.mjs'
import { compareStoredReplayPolicy } from '../tools/calibration/lib/rankingEvaluation.ts'
import { buildEvaluationData } from '../tools/calibration/lib/rankingEvaluationData.ts'
import { readReplayEvidenceFiles } from '../tools/calibration/lib/replayEvidenceFiles.ts'
import { scoreRankingReplay } from '../tools/calibration/score-ranking-replay.ts'
import { sampleMatches, teams } from './fixtures/rankingFixtures.ts'
import type { MatchRecord } from '../src/domains/rankings/types.ts'

const generatedAt = '2026-07-01T00:00:00.000Z'
const replayPath = '/data/evaluation/replay-predictions.json'
function actualReplay(matches: MatchRecord[] = structuredClone(sampleMatches.slice(0, 2))) {
  const model = buildRankingModel(matches, { ...teams })
  return { matches, predictions: model.predictions, model: { version: model.predictions[0].modelVersion,
    configHash: model.predictions[0].modelConfigHash }, dataMode: 'seeded-sample' as const }
}
function syntheticEvidence() {
  const replay = actualReplay(sampleMatches.map((match) => ({ ...match, sourceProvider: 'oracles-elixir', sourceFileName: 'synthetic-replay-fixture' })))
  return createReplayEvidence({ ...replay, dataMode: 'scheduled-public-data' })
}
function score(evidence: ReplayEvidence) {
  return compareStoredReplayPolicy(evidence, { scoreStart: '2026-01-01', recentStart: '2026-05-01' }, 100)
}

test('actual replay coverage rejects missing scored, empty, warmup, extra, and duplicate predictions before filtering', () => {
  const replay = actualReplay()
  const build = (predictions = replay.predictions, matches = replay.matches, scoreStart = '2026-01-24') =>
    buildEvaluationData({ matches, teams, tournamentLifecycles: null }, predictions, { sourceIdentity: 'synthetic', scoreStart })
  assert.equal(build().rows.length, 1)
  for (const predictions of [[], replay.predictions.slice(0, 1), replay.predictions.slice(1),
    [...replay.predictions, { ...replay.predictions[0], id: 'extra' }]]) assert.throws(() => build(predictions), /coverage differs/)
  assert.throws(() => build([replay.predictions[0], replay.predictions[0]]), /Duplicate prediction/)
  assert.throws(() => build(replay.predictions, [replay.matches[0], replay.matches[0]]), /Duplicate source/)
  const unresolved = actualReplay([{ ...replay.matches[0], winner: '' }, replay.matches[1]])
  const evidence = createReplayEvidence(unresolved)
  assert.equal(evidence.coverage.unresolvedOutcomeGames, 1)
  assert.equal(evidence.coverage.predictedGames, 2)
  assert.throws(() => createReplayEvidence({ ...unresolved, predictions: unresolved.predictions.slice(1) }), /coverage differs/)
})

test('actual Bo2 replay round trips game forecasts and preserves the draw probability', () => {
  const template = sampleMatches[0]
  const matches: MatchRecord[] = [
    { ...template, id: 'synthetic-bo2-1', bestOf: 2, bestOfBasis: 'official', sourceMatchId: 'synthetic-bo2', gameNumber: 1 },
    { ...template, id: 'synthetic-bo2-2', bestOf: 2, bestOfBasis: 'official', sourceMatchId: 'synthetic-bo2', gameNumber: 2, winner: template.teamB },
  ]
  const replay = actualReplay(matches)
  const evidence = readReplayEvidence(JSON.parse(JSON.stringify(createReplayEvidence(replay))))
  assert.equal(evidence.predictions.length, 2)
  for (const prediction of evidence.predictions) {
    assert.equal(prediction.bestOf, 2)
    assert.ok(prediction.teamASeriesWinProbability + prediction.teamBSeriesWinProbability < 1)
    assert.equal(prediction.teamAGameWinProbability + prediction.teamBGameWinProbability, 1)
  }
  const exported = buildEvaluationData({ matches, teams, tournamentLifecycles: null }, replay.predictions, { sourceIdentity: 'synthetic-bo2' })
  assert.equal(exported.rows.length, 2)
  assert.equal(exported.seriesExport.rows.length, 0)
})

test('actual same-day series retain emitted probabilities and report unverified within-day lineup timing', () => {
  const template = sampleMatches[0]
  const roster = (team: string, side: 'blue' | 'red'): NonNullable<MatchRecord['teamARoster']> => ({
    sourceProvider: 'oracles-elixir', teamId: team, observedAt: template.date, completeness: 'complete-five-role',
    players: (['Top', 'Jungle', 'Mid', 'Bot', 'Support'] as const).map((role) => ({
      id: `${team}-${role}`, name: `${team} ${role}`, role,
      stats: { side, won: side === 'blue', kills: 3, deaths: 2, assists: 5, damageShare: .2, earnedGoldShare: .2, vspm: 1 },
    })),
  })
  const matches: MatchRecord[] = ['first', 'second'].map((id) => ({ ...template,
    id: `synthetic-same-day-${id}`, sourceProvider: 'oracles-elixir', sourceMatchId: `synthetic-same-day-${id}`,
    teamARoster: roster(template.teamA, 'blue'), teamBRoster: roster(template.teamB, 'red'), bestOf: 1,
  }))
  const replay = actualReplay(matches)
  assert.equal(replay.predictions[1].teamALineupEvidenceBasis, 'prior-observed')
  assert.equal(replay.predictions[1].teamALineupObservedAt, template.date)
  const data = createStaticRankingData({ matches, teams: { ...teams }, rosters: {}, generatedAt,
    dataMode: 'scheduled-public-data', source: 'Synthetic fixture, not official LoL Esports data' })
  assert.deepEqual(data.replayEvidence.predictions, replay.predictions)
  const exported = buildEvaluationData({ matches, teams, tournamentLifecycles: null }, replay.predictions, { sourceIdentity: 'synthetic-same-day' })
  assert.equal(exported.rows.length, 2)
  const report = compareStoredReplayPolicy(data.replayEvidence, { scoreStart: template.date, recentStart: template.date }, 100)
  assert.equal(report.lineup.A.age['same-UTC-date'].current.count, 1)
  assert.equal(report.informationAvailability.playerSignalOrdering, 'prior-canonical-series;within-date-availability-unverified')
  assert.equal(report.publishedAccuracyClaim, false)
})

test('lineup evidence keeps unrecorded, unavailable, prior-observed, dates and freshness distinct', () => {
  const evidence = syntheticEvidence()
  const first = evidence.predictions[0]
  first.teamALineupEvidenceBasis = 'prior-observed'
  first.teamALineupObservedAt = '2025-01-01'
  first.teamALineupFreshnessWeight = .01
  first.teamBLineupEvidenceBasis = 'pregame-confirmed'
  first.teamBLineupObservedAt = undefined
  first.segments = first.segments.filter((segment) => segment !== 'unknown-lineup')
  first.dataCutoff = undefined
  const next = evidence.predictions[1]
  next.teamALineupEvidenceBasis = undefined
  next.teamALineupObservedAt = undefined
  const saved = readReplayEvidence(JSON.parse(JSON.stringify(evidence)))
  assert.equal(saved.predictions[0].teamALineupEvidenceBasis, 'prior-observed')
  assert.equal(saved.predictions[0].teamALineupFreshnessWeight, .01)
  assert.equal(saved.predictions[0].dataCutoff, undefined)
  assert.equal(saved.predictions[0].teamBLineupObservedAt, undefined)
  assert.equal(saved.predictions[1].teamALineupEvidenceBasis, undefined)
  assert.equal(score(saved).lineup.A.basis.unrecorded.sides, 1)
  for (const observedAt of ['2026-01-18', '2026-02-30']) {
    assert.throws(() => readReplayEvidence({ ...saved, predictions: [{ ...saved.predictions[0], teamALineupObservedAt: observedAt }, ...saved.predictions.slice(1)] }), /observation|date/)
  }
  assert.throws(() => readReplayEvidence({ ...saved, predictions: [{ ...saved.predictions[0], dataCutoff: first.date }, ...saved.predictions.slice(1)] }), /cutoff/)
})

test('unknown-data enum boundaries reject values that only coerce to an allowed value', () => {
  const evidence = syntheticEvidence()
  assert.throws(() => readReplayEvidence({ ...evidence, dataMode: ['scheduled-public-data'] }), /data mode/)
  assert.throws(() => readReplayEvidence({ ...evidence, predictions: [
    { ...evidence.predictions[0], teamALineupEvidenceBasis: ['unavailable'] }, ...evidence.predictions.slice(1),
  ] }), /evidence basis/)
  assert.throws(() => readReplayEvidence({ ...evidence, predictions: [
    { ...evidence.predictions[0], bestOf: '1' }, ...evidence.predictions.slice(1),
  ] }), /format/)
})

test('fixed fallback uses stored pregame records with paired cohorts and explicit empty unknown-lineup metrics', () => {
  const evidence = syntheticEvidence()
  const known = evidence.predictions[2]
  known.teamALineupEvidenceBasis = 'prior-observed'; known.teamBLineupEvidenceBasis = 'prior-observed'
  known.segments = known.segments.filter((segment) => segment !== 'unknown-lineup')
  const report = score(evidence)
  assert.equal(report.fallback.candidateId, 'unknown-lineup-stored-pregame-win-rate-v1')
  assert.equal(report.fallback.productionState, 'unchanged')
  assert.equal(report.global.fallback.status, 'evaluated')
  if (report.global.fallback.status !== 'evaluated') return
  const expected = evidence.predictions.map((prediction) => {
    const actual = Number(prediction.actualWinner === prediction.teamA)
    const probability = prediction.segments.includes('unknown-lineup') ? replayPregameWinRate(prediction)! : prediction.teamAGameWinProbability
    return (probability - actual) ** 2 - (prediction.teamAGameWinProbability - actual) ** 2
  }).reduce((sum, value) => sum + value, 0) / evidence.predictions.length
  assert.ok(Math.abs(report.global.fallback.global.brierDelta! - expected) < 1e-12)
  assert.equal(report.global.fallback.global.confidence95.status, 'unavailable')
  assert.deepEqual(report, score(evidence))
  const unrecorded = structuredClone(evidence)
  unrecorded.predictions[0].teamALineupEvidenceBasis = undefined
  unrecorded.predictions[0].teamBLineupEvidenceBasis = 'unavailable'
  const unrecordedReport = score(unrecorded)
  assert.equal(unrecordedReport.global.fallback.status, 'unavailable')
  assert.equal(unrecordedReport.fallback.status, 'unavailable')
  assert.ok(unrecordedReport.fallback.missingEvidenceIds.includes(unrecorded.predictions[0].id))
  assert.equal(unrecordedReport.fallback.changedGames, null)
  const missing = structuredClone(evidence)
  missing.predictions[0].teamAPregameWins = undefined
  const unavailable = score(missing)
  assert.equal(unavailable.global.fallback.status, 'unavailable')
  assert.equal(unavailable.global.controls.pregameWinRate.status, 'unavailable-for-some-games')
  assert.equal(unavailable.global.controls.pregameWinRate.current.count, unavailable.global.controls.pregameWinRate.control.count)
  for (const prediction of evidence.predictions) {
    prediction.teamALineupEvidenceBasis = 'prior-observed'; prediction.teamBLineupEvidenceBasis = 'prior-observed'
    prediction.segments = prediction.segments.filter((segment) => segment !== 'unknown-lineup')
  }
  const empty = score(evidence).lineupCategories['unknown-lineup']
  assert.equal(empty.current.count, 0)
  assert.equal(empty.current.brier, null)
  assert.equal(empty.fallback.status, 'evaluated')
  if (empty.fallback.status === 'evaluated') assert.equal(empty.fallback.global.confidence95.status, 'unavailable')
})

async function localBuild(root: string, large = false) {
  const matches = sampleMatches.map((match) => ({ ...match, sourceProvider: 'oracles-elixir' as const, sourceFileName: 'synthetic-replay-fixture' }))
  if (large) for (let index = 0; index < 300; index++) matches.push({ ...matches[index % 5], id: `synthetic-extra-${index}` })
  const data = createStaticRankingData({ matches, teams: { ...teams }, rosters: {}, generatedAt,
    dataMode: 'scheduled-public-data', source: 'Synthetic fixture, not official LoL Esports data' })
  const plan = createPublicArtifactWritePlan(data)
  for (const write of plan.writes) {
    await mkdir(join(root, ...write.relativePath.split('/').slice(0, -1)), { recursive: true })
    await writeFile(join(root, write.relativePath), write.contents)
  }
  return { data, plan }
}
async function saveGeneration(root: string, plan: ReturnType<typeof createPublicArtifactWritePlan>) {
  const objects = join(root, 'objects', 'sha256')
  await mkdir(objects, { recursive: true })
  const entries = []
  let archiveChildren = 0
  for (const write of plan.writes) {
    const prepared = prepareSemanticArtifact(write.value)
    for (const object of [prepared, ...prepared.children ?? []]) await writeFile(join(objects, object.digest), object.compressed)
    archiveChildren += prepared.children?.length ?? 0
    entries.push({ logicalPath: `/data/${write.relativePath}`, digest: prepared.digest, bytes: prepared.bytes })
  }
  const generationId = plan.manifest.artifactMeta!.runId
  const manifest = createGenerationManifest({ generationId, rootManifest: plan.manifest, entries })
  const path = join(root, 'generation-manifest.json')
  await writeFile(path, JSON.stringify(manifest))
  return { objects, path, manifest, archiveChildren }
}

test('normal build publishes separate evidence with required shared reference closure and no root rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'synthetic-replay-build-'))
  try {
    const { data, plan } = await localBuild(root)
    assert.equal('replayEvidence' in plan.manifest, false)
    assert.ok(plan.manifest.replayPredictionsUrl?.startsWith(replayPath))
    const write = plan.writes.find((write) => write.relativePath === PUBLIC_ARTIFACT_PATHS.replayPredictions)!
    assert.deepEqual(readReplayEvidence(write.value).predictions, data.replayEvidence.predictions)
    assert.equal(artifactReferences(plan.manifest).includes(replayPath), true)
    const available = new Set(plan.writes.filter((write) => write.relativePath !== PUBLIC_ARTIFACT_PATHS.replayPredictions).map((write) => `/data/${write.relativePath}`))
    assert.throws(() => assertReferenceClosure([['/data/ranking-summary.json', artifactReferences(plan.manifest)]], available), /missing.*replay-predictions/)
    const read = await readReplayEvidenceFiles({ kind: 'local-build', publicDataDirectory: root })
    assert.deepEqual(read.evidence, JSON.parse(JSON.stringify(data.replayEvidence)))
    const saved = await saveGeneration(root, plan)
    const generation = await readReplayEvidenceFiles({ kind: 'published-generation', generationManifestPath: saved.path, objectsDirectory: saved.objects })
    assert.deepEqual(generation.evidence, read.evidence)
    const output = join(root, 'report.json')
    const args = ['--generation', saved.path, '--objects', saved.objects, '--score-start', '2026-01-01', '--recent-start', '2026-05-01', '--output', output]
    execFileSync(process.execPath, ['tools/calibration/score-ranking-replay.ts', ...args], { cwd: process.cwd() })
    const first = await readFile(output, 'utf8')
    execFileSync(process.execPath, ['tools/calibration/score-ranking-replay.ts', ...args], { cwd: process.cwd() })
    assert.equal(await readFile(output, 'utf8'), first)
    assert.deepEqual(JSON.parse(first), await scoreRankingReplay(args))
    const existingTemporary = `${output}.tmp-${process.pid}`
    await writeFile(existingTemporary, 'preserve existing file')
    await scoreRankingReplay(args)
    assert.equal(await readFile(existingTemporary, 'utf8'), 'preserve existing file')
    const before = await readFile(output, 'utf8')
    await assert.rejects(scoreRankingReplay(args.map((arg) => arg === '2026-05-01' ? '2026-02-30' : arg)), /date/)
    assert.equal(await readFile(output, 'utf8'), before)
    await assert.rejects(scoreRankingReplay(['--public-data-dir', root, '--score-start', '2026-01-01', '--recent-start', '2026-05-01', '--output', join(root, 'ranking-summary.json')]), /overwrite/)
    await writeFile(saved.path, JSON.stringify({ ...saved.manifest,
      provenance: { source: plan.manifest.source, dataMode: plan.manifest.dataMode, sourceProviders: ['contradictory-provider'] } }))
    await assert.rejects(readReplayEvidenceFiles({ kind: 'published-generation', generationManifestPath: saved.path, objectsDirectory: saved.objects }), /source providers/)
    await writeFile(saved.path, JSON.stringify(saved.manifest))
    await writeFile(saved.path, JSON.stringify({ ...saved.manifest, schemaVersion: '2' }))
    await assert.rejects(readReplayEvidenceFiles({ kind: 'published-generation', generationManifestPath: saved.path, objectsDirectory: saved.objects }), /generation manifest/)
    await writeFile(saved.path, JSON.stringify(saved.manifest))
    const identity = (saved.manifest.artifacts as Record<string, { sha256: string }>)[replayPath]
    await writeFile(join(saved.objects, identity.sha256), '{}')
    await assert.rejects(readReplayEvidenceFiles({ kind: 'published-generation', generationManifestPath: saved.path, objectsDirectory: saved.objects }), /integrity/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('archived evidence and artifact directories hydrate through the shared format and reject missing children', async () => {
  const root = await mkdtemp(join(tmpdir(), 'synthetic-replay-archive-'))
  try {
    const { plan } = await localBuild(root, true)
    const saved = await saveGeneration(root, plan)
    const artifacts = saved.manifest.artifacts as Record<string, Record<string, unknown>>
    const directory = prepareSemanticArtifact({ artifactKind: 'public-artifact-directory', formatVersion: 1,
      artifacts: Object.fromEntries(Object.entries(artifacts).map(([path, entry]) => {
        const { generationId: _generationId, ...identity } = entry
        void _generationId
        return [path, identity]
      })) })
    for (const object of [directory, ...directory.children ?? []]) await writeFile(join(saved.objects, object.digest), object.compressed)
    saved.manifest.artifactDirectory = { sha256: directory.digest, bytes: directory.bytes, encoding: 'gzip' }
    saved.manifest.artifacts = { '/data/ranking-summary.json': artifacts['/data/ranking-summary.json'] }
    await writeFile(saved.path, JSON.stringify(saved.manifest))
    const input = { kind: 'published-generation' as const, generationManifestPath: saved.path, objectsDirectory: saved.objects }
    const result = await readReplayEvidenceFiles(input)
    assert.equal(result.evidence.predictions.length, 305)
    const replayWrite = plan.writes.find((write) => write.relativePath === PUBLIC_ARTIFACT_PATHS.replayPredictions)!
    const replay = prepareSemanticArtifact(replayWrite.value)
    assert.ok((replay.children?.length ?? 0) > 1)
    await rm(join(saved.objects, replay.children![0].digest))
    await assert.rejects(readReplayEvidenceFiles(input), /ENOENT/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('retained generation without evidence reports unavailable and saved exports require all controls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'synthetic-replay-legacy-'))
  try {
    const { plan } = await localBuild(root)
    const old = structuredClone(plan.manifest)
    delete old.replayPredictionsUrl
    await writeFile(join(root, 'ranking-summary.json'), JSON.stringify(old))
    await assert.rejects(readReplayEvidenceFiles({ kind: 'local-build', publicDataDirectory: root }), /prediction-evidence-unavailable/)
    const replay = actualReplay(sampleMatches.map((match) => ({ ...match, sourceProvider: 'oracles-elixir', sourceFileName: 'synthetic-replay-fixture' })))
    const data = buildEvaluationData({ matches: replay.matches, teams, tournamentLifecycles: null }, replay.predictions, { sourceIdentity: 'synthetic', scoreStart: '2026-01-01' })
    const exported = { ...data, replaySource: { kind: 'retained-local-replay', manifestGeneratedAt: generatedAt,
      manifestSha256: createHash('sha256').update('synthetic').digest('hex'), coverageStart: '2026-01-01', coverageEnd: '2026-05-02' } }
    const path = join(root, 'export.json')
    await writeFile(path, JSON.stringify(exported))
    const input = { kind: 'retained-local-replay' as const, exportPath: path }
    assert.equal((await readReplayEvidenceFiles(input)).evidence.predictions.length, 5)
    for (const mutation of [
      { ...exported, rows: exported.rows.slice(1) },
      { ...exported, replayEvidence: undefined },
      { ...exported, variants: { ...exported.variants, winRate: { ...exported.variants.winRate, rows: [] } } },
    ]) {
      await writeFile(path, JSON.stringify(mutation))
      await assert.rejects(readReplayEvidenceFiles(input), /coverage|evidence-unavailable/)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
