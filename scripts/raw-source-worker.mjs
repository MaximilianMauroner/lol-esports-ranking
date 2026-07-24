import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  materializePreparedRawSourceGeneration,
  materializeVerifiedPreparedRawSourceGeneration,
  prepareRawSourceGeneration,
} from './raw-source-generation.mjs'
import { parseRawSourceReceipt, rawObjectReferenceFor } from './raw-source-storage.mjs'
import { validateRawSourceAuthorityMetadata } from './ranking-source-authority.mjs'

const inputPath = process.argv[2]
const outputPath = process.argv[3]
if (!inputPath || !outputPath) throw new Error('Raw source worker requires input and output descriptor paths')

const input = JSON.parse(await readFile(resolve(inputPath), 'utf8'))
const output = input.action === 'restore' ? await restore(input) : input.action === 'prepare' ? await prepare(input) : undefined
if (!output) throw new Error(`Unsupported raw source worker action: ${String(input.action)}`)
const finalOutput = { ...output, childMaxRssBytes: Math.round(process.resourceUsage().maxRSS * 1024) }
const resolvedOutput = resolve(outputPath)
const temporaryOutput = `${resolvedOutput}.${process.pid}.tmp`
await mkdir(dirname(resolvedOutput), { recursive: true })
await writeFile(temporaryOutput, `${JSON.stringify(finalOutput)}\n`, { flag: 'wx' })
await rename(temporaryOutput, resolvedOutput)

async function restore(options) {
  const started = performance.now()
  const receipt = parseRawSourceReceipt(options.receipt)
  const validated = validateRawSourceAuthorityMetadata({
    found: true,
    receipt,
    receiptReference: options.receiptReference,
  }, {
    importerVersion: options.importerVersion,
    ...(options.requiredCoverage ? { requiredCoverage: options.requiredCoverage } : {}),
  })
  const objectFiles = new Map(Object.entries(options.objectFiles ?? {}))
  const references = rawReceiptObjectReferences(receipt)
  if (JSON.stringify([...objectFiles.keys()].sort()) !== JSON.stringify(references.map((reference) => reference.key).sort())) {
    throw new Error('Raw restore worker object file set does not match the receipt graph')
  }
  const materialized = await materializePreparedRawSourceGeneration({
    receipt,
    objects: [],
    inheritedObjectResolver: async (reference) => {
      const path = objectFiles.get(reference.key)
      if (!path) throw new Error(`Raw restore worker is missing ${reference.key}`)
      return readFile(path)
    },
  }, resolve(options.destinationDir), options.generatedAt)
  return {
    action: 'restore',
    manifestPath: materialized.manifestPath,
    sourceReceiptDigest: receipt.sourceReceiptDigest,
    generationId: receipt.generationId,
    identity: validated.identity,
    objectCount: references.length,
    receiptDigest: validated.receiptReference.sha256,
    restoreMs: performance.now() - started,
  }
}

function rawReceiptObjectReferences(receipt) {
  const references = [
    ...receipt.oracle.flatMap((source) => [source.baseline, ...source.deltas]),
    ...receipt.leaguepedia.map((source) => source.object),
    ...receipt.lolesports.map((source) => source.object),
  ]
  return [...new Map(references.map((reference) => [reference.key, reference])).values()]
}

async function prepare(options) {
  const started = performance.now()
  const objectDir = resolve(options.objectDir)
  await rm(objectDir, { recursive: true, force: true })
  try {
    const prepareStarted = performance.now()
    const previousReceipt = options.previousReceipt ? parseRawSourceReceipt(options.previousReceipt) : undefined
    const generation = await prepareRawSourceGeneration({
      manifestPath: resolve(options.manifestPath),
      rawDir: resolve(options.rawDir),
      importerVersion: options.importerVersion,
      ...(previousReceipt ? {
        previousAuthority: {
          receipt: previousReceipt,
          objectResolver: async () => { throw new Error('Inventory preparation resolved a previous raw object') },
        },
      } : {}),
    })
    const prepareMs = performance.now() - prepareStarted
    await mkdir(objectDir, { recursive: true })
    const objects = []
    for (const object of generation.objects) {
      const reference = rawObjectReferenceFor(object)
      const compressedPath = join(objectDir, object.digest)
      await writeFile(compressedPath, object.compressed, { flag: 'wx' })
      objects.push({
        digest: object.digest,
        bytes: object.bytes,
        compressedBytes: object.compressedBytes,
        compressedPath,
        compressedSha256: createHash('sha256').update(object.compressed).digest('hex'),
      })
      if (reference.sha256 !== object.digest) throw new Error('Raw worker object reference mismatch')
    }
    const materializeStarted = performance.now()
    const materialized = await materializeVerifiedPreparedRawSourceGeneration(
      generation,
      resolve(options.rawDir),
      options.generatedAt,
    )
    const materializeMs = performance.now() - materializeStarted
    return {
      action: 'prepare',
      manifestPath: materialized.manifestPath,
      prepareMs,
      materializeMs,
      totalMs: performance.now() - started,
      generation: {
        generationId: generation.generationId,
        importerVersion: generation.importerVersion,
        coverage: generation.coverage,
        sourceReceiptInputs: generation.sourceReceiptInputs,
        oracle: generation.oracle,
        leaguepedia: generation.leaguepedia,
        lolesports: generation.lolesports,
        objects,
        receipt: generation.receipt,
        sourceReceiptDigest: generation.sourceReceiptDigest,
        rawIdentityDigest: generation.rawIdentityDigest,
      },
    }
  } catch (error) {
    await rm(objectDir, { recursive: true, force: true })
    throw error
  }
}
