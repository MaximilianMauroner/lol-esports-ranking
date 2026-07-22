import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { manifestWithResolvedFiles } from './local-data-manifest.js'
import { replaceDirectory } from './replace-directory.ts'
import {
  materializeRawSourceReceipt,
  ORACLE_GAME_INVENTORY_DIGEST_SCHEME,
  oracleGameInventory,
  prepareNarrowSourceObject,
  prepareOracleBaseline,
  prepareOracleBaselineFromSource,
  prepareOracleMutationChainFromInventory,
  prepareRawObject,
  prepareRawSourceReceipt,
  parseRawSourceReceipt,
  rawObjectReferenceFor,
} from './raw-source-storage.mjs'

// Bound restore work without re-uploading the full baseline on ordinary refreshes.
export const RAW_ORACLE_MAX_DELTAS = 32

export async function prepareRawSourceGeneration({
  manifestPath,
  rawDir = dirname(resolve(manifestPath)),
  generationId = 'pending_raw_generation',
  importerVersion,
  previousAuthority,
}) {
  const manifest = manifestWithResolvedFiles(JSON.parse(await readFile(resolve(manifestPath), 'utf8')), resolve(rawDir))
  const previousReceipts = new Map((previousAuthority?.receipt.oracle ?? []).map((entry) => [entry.sourceFileName, entry]))
  const objects = new Map()
  const oracle = []
  const verifiedSourceFiles = []

  for (const path of uniquePaths(manifest.files?.oracleCsv)) {
    const csv = await readFile(path, 'utf8')
    const sourceFileName = basename(path)
    const priorReceipt = previousReceipts.get(sourceFileName)
    if (priorReceipt) {
      const chain = prepareOracleMutationChainFromInventory({
        previousReceipt: priorReceipt,
        importerVersion,
        nextCsv: csv,
      })
      const inheritedDeltas = [...priorReceipt.deltas, ...chain.deltas.map((delta) => delta.reference)]
      const shouldRebaseline = inheritedDeltas.length > RAW_ORACLE_MAX_DELTAS
      const baseline = shouldRebaseline ? prepareOracleBaselineFromSource(chain.source) : undefined
      if (baseline) objects.set(baseline.prepared.digest, baseline.prepared)
      else for (const delta of chain.deltas) objects.set(delta.prepared.digest, delta.prepared)
      oracle.push({
        sourceFileName,
        headerDigest: chain.source.headerDigest,
        digestScheme: priorReceipt.digestScheme,
        effectiveOracleDigest: chain.source.digest,
        gameInventory: chain.gameInventory,
        baseline: baseline?.reference ?? priorReceipt.baseline,
        deltas: baseline ? [] : inheritedDeltas,
      })
      verifiedSourceFiles.push({
        provider: 'oracle',
        sourceFileName,
        sourcePath: path,
        contentSha256: sha256(csv),
        headerDigest: chain.source.headerDigest,
        effectiveOracleDigest: chain.source.digest,
      })
    } else {
      const baseline = prepareOracleBaseline({ csv, sourceFileName, importerVersion })
      objects.set(baseline.prepared.digest, baseline.prepared)
      oracle.push({
        sourceFileName,
        headerDigest: baseline.source.headerDigest,
        digestScheme: ORACLE_GAME_INVENTORY_DIGEST_SCHEME,
        effectiveOracleDigest: baseline.source.digest,
        gameInventory: oracleGameInventory(baseline.source),
        baseline: baseline.reference,
        deltas: [],
      })
      verifiedSourceFiles.push({
        provider: 'oracle',
        sourceFileName,
        sourcePath: path,
        contentSha256: sha256(csv),
        headerDigest: baseline.source.headerDigest,
        effectiveOracleDigest: baseline.source.digest,
      })
    }
  }

  const prepareNarrow = async (provider, paths) => Promise.all(uniquePaths(paths).map(async (path) => {
    const prepared = prepareNarrowSourceObject({
      provider,
      sourceFileName: basename(path),
      content: await readFile(path),
      importerVersion,
    })
    objects.set(prepared.prepared.digest, prepared.prepared)
    verifiedSourceFiles.push({
      provider,
      sourceFileName: prepared.value.sourceFileName,
      sourcePath: path,
      contentSha256: prepared.value.contentSha256,
    })
    return {
      sourceFileName: prepared.value.sourceFileName,
      contentSha256: prepared.value.contentSha256,
      object: prepared.reference,
    }
  }))
  const leaguepedia = await prepareNarrow('leaguepedia', manifest.files?.leaguepediaJson)
  const lolesports = await prepareNarrow('lolesports', manifest.files?.lolEsportsJson)
  const sourceReceiptInputs = {
    generatedAt: manifest.generatedAt,
    refreshWindow: manifest.refreshWindow,
    sources: manifest.sources ?? {},
    warnings: manifest.warnings ?? [],
  }
  return finalizeRawSourceGeneration({
    generationId,
    importerVersion,
    coverage: { start: manifest.start, end: manifest.end },
    sourceReceiptInputs,
    oracle,
    leaguepedia,
    lolesports,
    objects: [...objects.values()],
    verifiedSourceFiles,
    inheritedObjectResolver: previousAuthority?.objectResolver,
  }, generationId)
}

export async function materializeVerifiedPreparedRawSourceGeneration(generation, destinationDir, generatedAt) {
  if (typeof generatedAt !== 'string' || generatedAt.length === 0) throw new Error('Raw materialization generatedAt must be a non-empty string')
  const destination = resolve(destinationDir)
  const nextDir = `${destination}.receipt-next-${process.pid}-${Date.now()}`
  await rm(nextDir, { recursive: true, force: true })
  try {
    const files = { oracleCsv: [], leaguepediaJson: [], lolEsportsJson: [] }
    for (const source of generation.verifiedSourceFiles) {
      assertVerifiedSourceMatchesReceipt(generation, source)
      const directory = source.provider === 'oracle' ? 'oracles-elixir' : source.provider
      const fileGroup = source.provider === 'oracle'
        ? 'oracleCsv'
        : source.provider === 'leaguepedia' ? 'leaguepediaJson' : 'lolEsportsJson'
      const relativePath = `${directory}/${source.sourceFileName}`
      await mkdir(join(nextDir, directory), { recursive: true })
      await copyFileVerifyingSha256(source.sourcePath, join(nextDir, relativePath), source.contentSha256)
      files[fileGroup].push(relativePath)
    }
    const manifest = {
      schemaVersion: 1,
      generatedAt,
      start: generation.coverage.start,
      end: generation.coverage.end,
      files,
      sourceReceipt: {
        storageMode: generation.receipt.storageMode,
        generationId: generation.receipt.generationId,
        rawIdentityDigest: generation.rawIdentityDigest,
        sourceReceiptDigest: generation.sourceReceiptDigest,
      },
      sources: generation.sourceReceiptInputs.sources ?? {},
      warnings: generation.sourceReceiptInputs.warnings ?? [],
      ...(generation.sourceReceiptInputs.refreshWindow
        ? { refreshWindow: generation.sourceReceiptInputs.refreshWindow }
        : {}),
    }
    await writeFile(join(nextDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await replaceDirectory(nextDir, destination, { publishLast: 'manifest.json' })
    return { manifest, manifestPath: join(destination, 'manifest.json') }
  } catch (error) {
    await rm(nextDir, { recursive: true, force: true })
    throw error
  }
}

export function finalizeRawSourceGeneration(generation, generationId) {
  const receipt = prepareRawSourceReceipt({
    generationId,
    importerVersion: generation.importerVersion,
    coverage: generation.coverage,
    sourceReceiptInputs: generation.sourceReceiptInputs,
    oracle: generation.oracle,
    leaguepedia: generation.leaguepedia,
    lolesports: generation.lolesports,
  })
  return {
    ...generation,
    generationId,
    receipt: receipt.receipt,
    receiptPrepared: receipt.prepared,
    receiptReference: rawObjectReferenceFor(receipt.prepared),
    sourceReceiptDigest: receipt.receipt.sourceReceiptDigest,
    rawIdentityDigest: receipt.receipt.rawIdentityDigest,
  }
}

export function hydrateFileBackedRawSourceGeneration(value) {
  const receipt = parseRawSourceReceipt(value.receipt)
  if (receipt.sourceReceiptDigest !== value.sourceReceiptDigest || receipt.rawIdentityDigest !== value.rawIdentityDigest) {
    throw new Error('File-backed raw generation receipt identity mismatch')
  }
  const objects = (value.objects ?? []).map((object, index) => {
    if (typeof object?.compressedPath !== 'string') throw new Error(`File-backed raw generation object ${index} path is invalid`)
    return {
      digest: object.digest,
      bytes: object.bytes,
      compressedBytes: object.compressedBytes,
      compressedPath: resolve(object.compressedPath),
      compressedSha256: object.compressedSha256,
    }
  })
  const receiptPrepared = prepareRawObject(receipt)
  return {
    generationId: value.generationId,
    importerVersion: value.importerVersion,
    coverage: value.coverage,
    sourceReceiptInputs: value.sourceReceiptInputs,
    oracle: receipt.oracle,
    leaguepedia: receipt.leaguepedia,
    lolesports: receipt.lolesports,
    objects,
    verifiedSourceFiles: [],
    receipt,
    receiptPrepared,
    receiptReference: rawObjectReferenceFor(receiptPrepared),
    sourceReceiptDigest: receipt.sourceReceiptDigest,
    rawIdentityDigest: receipt.rawIdentityDigest,
  }
}

export async function materializePreparedRawSourceGeneration(generation, destinationDir, generatedAt) {
  const localObjects = new Map(generation.objects.map((object) => [rawObjectReferenceFor(object).key, object.compressed]))
  return materializeRawSourceReceipt({
    receipt: generation.receipt,
    destinationDir,
    generatedAt,
    objectResolver: async (reference) => localObjects.get(reference.key)
      ?? generation.inheritedObjectResolver?.(reference),
  })
}

function uniquePaths(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((path) => resolve(path)))]
}

function assertVerifiedSourceMatchesReceipt(generation, source) {
  const entries = source.provider === 'oracle'
    ? generation.oracle
    : source.provider === 'leaguepedia' ? generation.leaguepedia : generation.lolesports
  const receipt = entries.find((entry) => entry.sourceFileName === source.sourceFileName)
  if (!receipt) throw new Error(`Prepared raw source is absent from receipt: ${source.provider}/${source.sourceFileName}`)
  if (source.provider === 'oracle') {
    if (receipt.headerDigest !== source.headerDigest || receipt.effectiveOracleDigest !== source.effectiveOracleDigest) {
      throw new Error(`Prepared Oracle source proof differs from receipt: ${source.sourceFileName}`)
    }
  } else if (receipt.contentSha256 !== source.contentSha256) {
    throw new Error(`Prepared narrow source proof differs from receipt: ${source.provider}/${source.sourceFileName}`)
  }
}

async function copyFileVerifyingSha256(sourcePath, destinationPath, expectedSha256) {
  const hash = createHash('sha256')
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(createReadStream(sourcePath), verifier, createWriteStream(destinationPath, { flags: 'wx' }))
  if (hash.digest('hex') !== expectedSha256) {
    throw new Error(`Prepared raw source changed before receipt materialization: ${basename(sourcePath)}`)
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
