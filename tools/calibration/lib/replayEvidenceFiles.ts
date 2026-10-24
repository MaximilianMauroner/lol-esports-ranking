import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { canonicalTeamNameFor } from '../../../src/domains/rankings/evidence.ts'
import { summarizePredictions } from '../../../src/domains/rankings/build.ts'
import { readReplayEvidence, requireReplayDate, type ReplayEvidence } from '../../../src/domains/rankings/published-read.ts'
import { hydrateArchive, ARCHIVE_PAGE_BYTES } from '../../../src/domains/rankings/internal/published/archive.mjs'
import { assertCanonicalPublicLogicalPath, canonicalPublicLogicalPath } from '../../../src/domains/rankings/internal/published/logicalPath.mjs'
import { artifactReferences, assertReferenceClosure } from '../../../src/domains/rankings/internal/published/logicalReferences.mjs'
import { canonicalJsonFor } from '../../../scripts/public-artifact-storage.mjs'
import { readEvaluationExport } from './rankingEvaluation.ts'
import { requireEvaluationGeneratedAt } from './rankingEvaluationData.ts'

const rootPath = '/data/ranking-summary.json'
const replayPath = '/data/evaluation/replay-predictions.json'

export type ReplayEvidenceInput =
  | { kind: 'published-generation'; generationManifestPath: string; objectsDirectory: string }
  | { kind: 'local-build'; publicDataDirectory: string }
  | { kind: 'retained-local-replay'; exportPath: string }

type ObjectReference = { sha256: string; bytes: number; encoding: 'gzip' }

export async function readReplayEvidenceFiles(input: ReplayEvidenceInput): Promise<{ evidence: ReplayEvidence; scoreStart?: string; authority: Record<string, unknown> }> {
  if (input.kind === 'retained-local-replay') {
    const bytes = await readFile(input.exportPath)
    const saved = object(JSON.parse(bytes.toString('utf8')))
    const evidence = readReplayEvidence(saved.replayEvidence)
    const current = readEvaluationExport(saved)
    const scoreStart = requireReplayDate(saved.scoreStart)
    const source = object(saved.replaySource)
    if (source.kind !== 'retained-local-replay' || !digest(source.manifestSha256)) throw new Error('Invalid retained replay source authority')
    requireEvaluationGeneratedAt(source.manifestGeneratedAt)
    for (const key of ['coverageStart', 'coverageEnd']) if (source[key] !== null) requireReplayDate(source[key])
    const expected = evidence.sourceGames.filter((game) => game.date >= scoreStart
      && [canonicalTeamNameFor(game.teamA), canonicalTeamNameFor(game.teamB)].includes(canonicalTeamNameFor(game.winner)))
    const byId = new Map(expected.map((game) => [game.id, game]))
    const predictions = new Map(evidence.predictions.map((prediction) => [prediction.id, prediction]))
    if (current.schemaVersion !== 2 || current.target !== 'game' || current.modelVersion !== evidence.model.version
      || current.modelConfigHash !== evidence.model.configHash || current.rows.length !== expected.length) throw new Error('Saved export coverage or model differs')
    for (const row of current.rows) {
      const game = byId.get(row.id)
      if (!game || row.seriesId !== game.seriesId || row.eventId !== game.eventId || row.date !== game.date
        || row.teamA !== canonicalTeamNameFor(game.teamA) || row.teamB !== canonicalTeamNameFor(game.teamB)
        || row.leagueA !== game.leagueA || row.leagueB !== game.leagueB
        || row.actual !== Number(canonicalTeamNameFor(game.winner) === row.teamA)
        || row.probability !== predictions.get(row.id)!.teamAGameWinProbability
        || canonicalJsonFor(row.segments) !== canonicalJsonFor([...predictions.get(row.id)!.segments].sort())) throw new Error(`Saved export cohort differs for ${row.id}`)
    }
    const controls = object(saved.variants)
    if (!controls.winRate) throw new Error('Saved export offline game-record win-rate control is unavailable')
    const currentById = new Map(current.rows.map((row) => [row.id, row]))
    for (const [key, value] of Object.entries(controls)) {
      const control = readEvaluationExport(value)
      if (control.schemaVersion !== 2 || control.replayInputs !== current.replayInputs || control.sourceIdentity !== current.sourceIdentity
        || control.modelConfigHash !== current.modelConfigHash || control.target !== current.target || control.rows.length !== current.rows.length) throw new Error(`Saved control coverage differs for ${key}`)
      for (const row of control.rows) {
        const base = currentById.get(row.id)
        if (!base || canonicalJsonFor({ ...row, probability: 0 }) !== canonicalJsonFor({ ...base, probability: 0 })) throw new Error(`Saved control cohort differs for ${key}`)
      }
    }
    return { evidence, scoreStart, authority: { kind: input.kind, exportFileSha256: sha256(bytes), ...source,
      replayInputs: current.replayInputs, sourceIdentity: current.sourceIdentity,
      offlineGameRecordControls: 'retained-in-export; distinct-from-stored-pregame-record-control' } }
  }
  if (input.kind === 'local-build') {
    const root = object(JSON.parse(await readFile(join(input.publicDataDirectory, 'ranking-summary.json'), 'utf8')))
    requireReplayUrl(root)
    const bytes = await readFile(join(input.publicDataDirectory, 'evaluation/replay-predictions.json'))
    const evidence = readReplayEvidence(JSON.parse(bytes.toString('utf8')))
    verifyRoot(root, evidence)
    return { evidence, authority: { kind: input.kind, replayFileSha256: sha256(bytes),
      generatedAt: requireEvaluationGeneratedAt(root.generatedAt) } }
  }
  const manifestBytes = await readFile(input.generationManifestPath)
  const manifest = object(JSON.parse(manifestBytes.toString('utf8')))
  if (manifest.artifactKind !== 'public-artifact-generation-manifest' || (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2)
    || manifest.storageMode !== 'content-addressed-gzip-v1' || manifest.rootArtifact !== rootPath
    || typeof manifest.generationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.generationId)
    || manifest.runId !== manifest.generationId) throw new Error('Invalid saved generation manifest')
  requireEvaluationGeneratedAt(manifest.generatedAt)
  const model = object(manifest.model)
  text(model.version); text(model.configHash)
  const provenance = object(manifest.provenance)
  text(provenance.source)
  if (!Array.isArray(provenance.sourceProviders) || provenance.sourceProviders.some((provider) => typeof provider !== 'string' || !provider)) throw new Error('Invalid generation source providers')
  const load = async (reference: ObjectReference) => {
    checkReference(reference)
    const stored = await readFile(join(input.objectsDirectory, reference.sha256))
    const bytes = stored[0] === 0x1f && stored[1] === 0x8b ? gunzipSync(stored, { maxOutputLength: reference.bytes + 1 }) : stored
    if (bytes.byteLength !== reference.bytes || sha256(bytes) !== reference.sha256) throw new Error(`Saved object integrity differs for ${reference.sha256}`)
    const envelope = object(JSON.parse(bytes.toString('utf8')))
    if (envelope.artifactKind !== 'public-semantic-artifact' || envelope.schemaVersion !== 1) throw new Error('Unsupported semantic envelope')
    return object(envelope.content)
  }
  const hydrate = async (reference: ObjectReference) => object(await hydrateArchive(await load(reference), load))
  let artifacts = object(manifest.artifacts)
  validateMappings(artifacts, manifest.generationId)
  if (!Object.hasOwn(artifacts, rootPath)) throw new Error('Saved generation has no root mapping')
  if (manifest.artifactDirectory !== undefined) {
    if (manifest.schemaVersion !== 2) throw new Error('Legacy generation cannot contain an artifact directory')
    const reference = object(manifest.artifactDirectory)
    checkReference(reference, ARCHIVE_PAGE_BYTES)
    const directory = await hydrate(reference)
    if (directory.artifactKind !== 'public-artifact-directory' || directory.formatVersion !== 1) throw new Error('Invalid generation artifact directory')
    const expanded = Object.fromEntries(Object.entries(object(directory.artifacts)).map(([path, value]) => {
      const entry = object(value)
      if (entry.generationId !== undefined && entry.generationId !== manifest.generationId) throw new Error('Mixed directory generation identity')
      return [path, { ...entry, generationId: manifest.generationId }]
    }))
    validateMappings(expanded, manifest.generationId)
    for (const [path, entry] of Object.entries(artifacts)) if (canonicalJsonFor(entry) !== canonicalJsonFor(expanded[path])) throw new Error('Generation artifact directory root mapping mismatch')
    artifacts = expanded
  }
  const root = await hydrate(mapping(artifacts, rootPath))
  requireReplayUrl(root)
  assertReferenceClosure([[rootPath, artifactReferences(root)]], new Set(Object.keys(artifacts)))
  const replayIdentity = mapping(artifacts, replayPath)
  const evidence = readReplayEvidence(await hydrate(replayIdentity))
  if (root.generatedAt !== undefined && root.generatedAt !== manifest.generatedAt) throw new Error('Mixed root generation time')
  if (canonicalJsonFor(evidence.model) !== canonicalJsonFor(model) || evidence.dataMode !== provenance.dataMode
    || root.source !== provenance.source) throw new Error('Mixed saved generation provenance')
  if (!Array.isArray(root.sources)) throw new Error('Invalid ranking source providers')
  const sourceProviders = [...new Set(root.sources.map((source) => text(object(source).name)))].sort()
  const expectedProviders = [...new Set(provenance.sourceProviders)].sort()
  if (canonicalJsonFor(sourceProviders) !== canonicalJsonFor(expectedProviders)) throw new Error('Mixed saved generation source providers')
  verifyRoot(root, evidence)
  return { evidence, authority: { kind: input.kind, generationId: manifest.generationId,
    generationManifestSha256: sha256(manifestBytes), replayObjectSha256: replayIdentity.sha256,
    generatedAt: manifest.generatedAt, authenticity: 'consistent-with-supplied-saved-manifest; external-publication-receipt-not-supplied' } }
}

function verifyRoot(root: Record<string, unknown>, evidence: ReplayEvidence) {
  if (root.artifactKind !== 'public-ranking-manifest' || root.dataMode !== evidence.dataMode
    || canonicalJsonFor({ version: object(root.model).version, configHash: object(root.model).configHash }) !== canonicalJsonFor(evidence.model)) throw new Error('Replay evidence differs from ranking root')
  const metrics = object(object(root.walkForward).metrics)
  if (metrics.modelVersion !== evidence.model.version || metrics.modelConfigHash !== evidence.model.configHash) throw new Error('Replay metrics model differs')
  const reconstructed = summarizePredictions(evidence.predictions)
  const { modelVersion: _version, modelConfigHash: _hash, ...expected } = reconstructed
  void _version; void _hash
  for (const [key, value] of Object.entries(expected)) {
    if (canonicalJsonFor(metrics[key]) !== canonicalJsonFor(value)) throw new Error(`Stored replay metrics differ from root for ${key}`)
  }
}
function requireReplayUrl(root: Record<string, unknown>) {
  if (typeof root.replayPredictionsUrl !== 'string') throw new Error('prediction-evidence-unavailable: generation has no replay prediction evidence')
  if (canonicalPublicLogicalPath(root.replayPredictionsUrl) !== replayPath || !root.replayPredictionsUrl.startsWith(`${replayPath}`)) throw new Error('Unsupported replay evidence logical path')
}
function validateMappings(artifacts: Record<string, unknown>, generationId: string) {
  for (const [path, value] of Object.entries(artifacts)) {
    assertCanonicalPublicLogicalPath(path)
    if (canonicalPublicLogicalPath(path) !== path) throw new Error('Noncanonical generation logical path')
    const entry = object(value)
    checkReference(entry)
    if (entry.logicalPath !== path || entry.generationId !== generationId || entry.objectUrl !== `/data/objects/sha256/${entry.sha256}`
      || entry.storageEncoding !== 'gzip' || canonicalJsonFor(entry.transportEncodings) !== '["identity","gzip"]') throw new Error(`Invalid generation mapping for ${path}`)
  }
}
function mapping(artifacts: Record<string, unknown>, path: string): ObjectReference {
  const value = object(artifacts[path])
  checkReference(value)
  return value
}
function checkReference(value: Record<string, unknown> | ObjectReference, maxBytes = Number.MAX_SAFE_INTEGER): asserts value is ObjectReference & Record<string, unknown> {
  if (!digest(value.sha256) || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes)
    || value.bytes <= 0 || value.bytes > maxBytes || value.encoding !== 'gzip') throw new Error('Invalid saved object reference')
}
function digest(value: unknown) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }
function sha256(value: Uint8Array) { return createHash('sha256').update(value).digest('hex') }
function text(value: unknown) {
  if (typeof value !== 'string' || !value) throw new Error('Invalid saved generation identity')
  return value
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved replay object')
  return value as Record<string, unknown>
}
