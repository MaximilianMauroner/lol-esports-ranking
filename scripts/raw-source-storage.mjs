import { createHash } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { gunzipSync, gzipSync } from 'node:zlib'
import { canonicalJsonFor } from './public-artifact-storage.mjs'
import { replaceDirectory } from './replace-directory.ts'

export const RAW_SOURCE_STORAGE_MODE = 'content-addressed-raw-gzip-v2'
export const ORACLE_GAME_INVENTORY_DIGEST_SCHEME = 'oracle-game-inventory-v1'
export const RAW_SOURCE_RECEIPT_KIND = 'raw-source-generation-receipt'
export const ORACLE_BASELINE_KIND = 'oracle-complete-game-baseline'
export const ORACLE_DELTA_KIND = 'oracle-date-league-delta'
export const NARROW_SOURCE_KIND = 'raw-narrow-provider-file'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const PROVIDERS = ['leaguepedia', 'lolesports']

export function prepareRawObject(value) {
  assertRecord(value, 'raw object')
  const canonicalJson = canonicalJsonFor(value)
  const canonicalBytes = Buffer.from(canonicalJson, 'utf8')
  const digest = sha256(canonicalBytes)
  const compressed = gzipSync(canonicalBytes, { level: 9, mtime: 0 })
  return {
    value,
    canonicalJson,
    canonicalBytes,
    digest,
    bytes: canonicalBytes.byteLength,
    compressed,
    compressedBytes: compressed.byteLength,
  }
}

export function rawObjectReferenceFor(prepared) {
  assertPreparedObject(prepared)
  return {
    key: `raw/objects/sha256/${prepared.digest}`,
    sha256: prepared.digest,
    bytes: prepared.bytes,
    compressedBytes: prepared.compressedBytes,
    storageEncoding: 'gzip',
  }
}

export function decodeRawObject(reference, compressed) {
  const parsedReference = parseRawObjectReference(reference, 'raw object reference')
  const bytes = Buffer.from(compressed ?? [])
  if (bytes.byteLength !== parsedReference.compressedBytes) throw new Error('Raw object compressed byte length mismatch')
  let canonicalBytes
  try { canonicalBytes = gunzipSync(bytes) } catch (error) {
    throw new Error('Raw object gzip is corrupt', { cause: error })
  }
  if (canonicalBytes.byteLength !== parsedReference.bytes || sha256(canonicalBytes) !== parsedReference.sha256) {
    throw new Error('Raw object semantic digest mismatch')
  }
  let value
  try { value = JSON.parse(canonicalBytes.toString('utf8')) } catch (error) {
    throw new Error('Raw object JSON is corrupt', { cause: error })
  }
  if (canonicalJsonFor(value) !== canonicalBytes.toString('utf8')) throw new Error('Raw object is not canonical JSON')
  return value
}

export function parseOracleCsv(csv, { sourceFileName, importerVersion }) {
  assertFileName(sourceFileName, 'Oracle sourceFileName')
  assertNonEmptyString(importerVersion, 'Oracle importerVersion')
  const rows = parseCsv(String(csv))
  const header = rows.shift()
  if (!header || header.length === 0) throw new Error('Oracle CSV header is missing')
  assertUniqueStrings(header, 'Oracle CSV header')
  const indexes = Object.fromEntries(header.map((name, index) => [name.trim().toLowerCase(), index]))
  for (const required of ['gameid', 'date', 'league', 'side']) {
    if (indexes[required] === undefined) throw new Error(`Oracle CSV header is missing ${required}`)
  }
  const byGame = new Map()
  for (const [rowIndex, row] of rows.entries()) {
    if (row.length === 1 && row[0] === '') continue
    if (row.length !== header.length) throw new Error(`Oracle CSV row ${rowIndex + 2} has ${row.length} fields; expected ${header.length}`)
    const gameId = row[indexes.gameid]?.trim()
    const date = normalizeOracleDate(row[indexes.date])
    const league = row[indexes.league]?.trim()
    if (!gameId || !date || !league) throw new Error(`Oracle CSV row ${rowIndex + 2} has incomplete game identity`)
    const current = byGame.get(gameId) ?? { gameId, date, league, sourceOrder: byGame.size, rows: [] }
    if (current.date !== date || current.league !== league) throw new Error(`Oracle game ${gameId} has ambiguous date or league`)
    current.rows.push(row)
    byGame.set(gameId, current)
  }
  const games = [...byGame.values()].map((game) => parseOracleGame(game, header, indexes))
    .sort(compareGames)
  if (games.length === 0) throw new Error('Oracle CSV contains no complete games')
  const source = {
    sourceFileName,
    importerVersion,
    header,
    headerDigest: sha256(Buffer.from(canonicalJsonFor(header))),
    games,
  }
  return { ...source, digest: oracleSourceDigest(source) }
}

export function prepareOracleBaseline({ csv, sourceFileName, importerVersion }) {
  return prepareOracleBaselineFromSource(parseOracleCsv(csv, { sourceFileName, importerVersion }))
}

export function prepareOracleBaselineFromSource(source) {
  const parsed = parseOracleSource(source, 'Oracle baseline source')
  const value = {
    artifactKind: ORACLE_BASELINE_KIND,
    schemaVersion: 1,
    importerVersion: parsed.importerVersion,
    sourceFileName: parsed.sourceFileName,
    header: parsed.header,
    headerDigest: parsed.headerDigest,
    oracleDigest: parsed.digest,
    games: parsed.games,
  }
  const prepared = prepareRawObject(value)
  return { source: parsed, value, prepared, reference: rawObjectReferenceFor(prepared) }
}

export function parseOracleBaseline(value, { importerVersion } = {}) {
  assertExactKeys(value, ['artifactKind', 'schemaVersion', 'importerVersion', 'sourceFileName', 'header', 'headerDigest', 'oracleDigest', 'games'], 'Oracle baseline')
  if (value.artifactKind !== ORACLE_BASELINE_KIND || value.schemaVersion !== 1) throw new Error('Unsupported Oracle baseline schema')
  const source = parseOracleSource(value, 'Oracle baseline')
  if (importerVersion !== undefined && source.importerVersion !== importerVersion) throw new Error('Oracle baseline importer version mismatch')
  if (source.digest !== value.oracleDigest) throw new Error('Oracle baseline digest mismatch')
  return source
}

export function prepareOracleMutationChain({ previousSource, nextCsv, nextSource }) {
  const previous = parseOracleSource(previousSource, 'previous Oracle source')
  const next = nextSource
    ? parseOracleSource(nextSource, 'next Oracle source')
    : parseOracleCsv(nextCsv, { sourceFileName: previous.sourceFileName, importerVersion: previous.importerVersion })
  assertOracleCompatibility(previous, next)
  const previousById = new Map(previous.games.map((game) => [game.gameId, game]))
  const nextById = new Map(next.games.map((game) => [game.gameId, game]))
  const mutations = []
  for (const game of previous.games) {
    const replacement = nextById.get(game.gameId)
    if (!replacement) {
      mutations.push({ partition: partitionFor(game), operation: 'delete', gameId: game.gameId, expectedPreviousDigest: game.digest })
    } else if (replacement.digest !== game.digest) {
      mutations.push({ partition: partitionFor(replacement), operation: 'replace', gameId: game.gameId, expectedPreviousDigest: game.digest, game: replacement })
    }
  }
  for (const game of next.games) {
    if (!previousById.has(game.gameId)) mutations.push({ partition: partitionFor(game), operation: 'add', gameId: game.gameId, game })
  }
  mutations.sort(comparePartitionedMutations)
  let current = previous
  const deltas = []
  for (const [partitionKey, grouped] of groupBy(mutations, (entry) => partitionKeyFor(entry.partition))) {
    const partition = parsePartition(grouped[0].partition, `Oracle delta partition ${partitionKey}`)
    const valueWithoutNext = {
      artifactKind: ORACLE_DELTA_KIND,
      schemaVersion: 1,
      importerVersion: previous.importerVersion,
      sourceFileName: previous.sourceFileName,
      header: previous.header,
      headerDigest: previous.headerDigest,
      partition,
      previousOracleDigest: current.digest,
      mutations: grouped.map(rawMutationFor),
    }
    const applied = applyOracleDeltaValue(current, { ...valueWithoutNext, nextOracleDigest: 'pending' }, { verifyNextDigest: false })
    const value = { ...valueWithoutNext, nextOracleDigest: applied.digest }
    const parsedValue = parseOracleDelta(value, { importerVersion: previous.importerVersion, sourceFileName: previous.sourceFileName, headerDigest: previous.headerDigest })
    const prepared = prepareRawObject(parsedValue)
    deltas.push({ value: parsedValue, prepared, reference: rawObjectReferenceFor(prepared) })
    current = applied
  }
  if (current.digest !== next.digest) throw new Error('Oracle mutation chain does not reconstruct the requested source')
  return { source: current, deltas, mutations }
}

export function prepareOracleMutationChainFromInventory({ previousReceipt, importerVersion, nextCsv, nextSource }) {
  const previous = parseOracleInventoryAuthority(previousReceipt, importerVersion)
  const next = nextSource
    ? parseOracleSource(nextSource, 'next Oracle source')
    : parseOracleCsv(nextCsv, { sourceFileName: previous.sourceFileName, importerVersion })
  if (next.sourceFileName !== previous.sourceFileName) throw new Error('Oracle source filename mismatch')
  if (next.importerVersion !== importerVersion) throw new Error('Oracle source importer version mismatch')
  if (next.headerDigest !== previous.headerDigest) throw new Error('Oracle source header mismatch')
  const previousById = new Map(previous.gameInventory.map((game) => [game.gameId, game]))
  const nextById = new Map(next.games.map((game) => [game.gameId, game]))
  const mutations = []
  for (const game of previous.gameInventory) {
    const replacement = nextById.get(game.gameId)
    if (!replacement) {
      mutations.push({ partition: partitionFor(game), operation: 'delete', gameId: game.gameId, expectedPreviousDigest: game.digest })
    } else if (replacement.digest !== game.digest) {
      mutations.push({ partition: partitionFor(replacement), operation: 'replace', gameId: game.gameId, expectedPreviousDigest: game.digest, game: replacement })
    }
  }
  for (const game of next.games) {
    if (!previousById.has(game.gameId)) mutations.push({ partition: partitionFor(game), operation: 'add', gameId: game.gameId, game })
  }
  mutations.sort(comparePartitionedMutations)
  let currentInventory = previous.gameInventory
  let currentDigest = previous.effectiveOracleDigest
  const deltas = []
  for (const [partitionKey, grouped] of groupBy(mutations, (entry) => partitionKeyFor(entry.partition))) {
    const partition = parsePartition(grouped[0].partition, `Oracle delta partition ${partitionKey}`)
    const valueWithoutNext = {
      artifactKind: ORACLE_DELTA_KIND,
      schemaVersion: 1,
      importerVersion,
      sourceFileName: previous.sourceFileName,
      header: next.header,
      headerDigest: previous.headerDigest,
      partition,
      previousOracleDigest: currentDigest,
      mutations: grouped.map(rawMutationFor),
    }
    currentInventory = applyInventoryMutations(currentInventory, grouped)
    const nextOracleDigest = oracleSourceDigestFromInventory({
      sourceFileName: previous.sourceFileName,
      importerVersion,
      headerDigest: previous.headerDigest,
      gameInventory: currentInventory,
    })
    const value = { ...valueWithoutNext, nextOracleDigest }
    const parsedValue = parseOracleDelta(value, { importerVersion, sourceFileName: previous.sourceFileName, headerDigest: previous.headerDigest })
    const prepared = prepareRawObject(parsedValue)
    deltas.push({ value: parsedValue, prepared, reference: rawObjectReferenceFor(prepared) })
    currentDigest = nextOracleDigest
  }
  if (currentDigest !== next.digest || canonicalJsonFor(currentInventory) !== canonicalJsonFor(oracleGameInventory(next))) {
    throw new Error('Oracle inventory mutation chain does not reconstruct the requested source')
  }
  return { source: next, deltas, mutations, gameInventory: currentInventory }
}

export function parseOracleDelta(value, compatibility = {}) {
  assertExactKeys(value, ['artifactKind', 'schemaVersion', 'importerVersion', 'sourceFileName', 'header', 'headerDigest', 'partition', 'previousOracleDigest', 'nextOracleDigest', 'mutations'], 'Oracle delta')
  if (value.artifactKind !== ORACLE_DELTA_KIND || value.schemaVersion !== 1) throw new Error('Unsupported Oracle delta schema')
  assertNonEmptyString(value.importerVersion, 'Oracle delta importerVersion')
  assertFileName(value.sourceFileName, 'Oracle delta sourceFileName')
  if (!Array.isArray(value.header) || value.header.length === 0 || value.header.some((entry) => typeof entry !== 'string')) throw new Error('Oracle delta header is invalid')
  assertUniqueStrings(value.header, 'Oracle delta header')
  assertDigest(value.headerDigest, 'Oracle delta headerDigest')
  if (sha256(Buffer.from(canonicalJsonFor(value.header))) !== value.headerDigest) throw new Error('Oracle delta header digest mismatch')
  assertDigest(value.previousOracleDigest, 'Oracle delta previousOracleDigest')
  assertDigest(value.nextOracleDigest, 'Oracle delta nextOracleDigest')
  const partition = parsePartition(value.partition, 'Oracle delta partition')
  if (compatibility.importerVersion && value.importerVersion !== compatibility.importerVersion) throw new Error('Oracle delta importer version mismatch')
  if (compatibility.sourceFileName && value.sourceFileName !== compatibility.sourceFileName) throw new Error('Oracle delta source filename mismatch')
  if (compatibility.headerDigest && value.headerDigest !== compatibility.headerDigest) throw new Error('Oracle delta header mismatch')
  if (!Array.isArray(value.mutations) || value.mutations.length === 0) throw new Error('Oracle delta mutations must be non-empty')
  const seen = new Set()
  const mutations = value.mutations.map((mutation, index) => {
    const parsed = parseMutation(mutation, partition, value.header, `Oracle delta mutation ${index}`)
    if (seen.has(parsed.gameId)) throw new Error(`Oracle delta has duplicate or ambiguous mutation for ${parsed.gameId}`)
    seen.add(parsed.gameId)
    return parsed
  })
  if (!isSorted(mutations, compareMutations)) throw new Error('Oracle delta mutations are not canonically ordered')
  return {
    artifactKind: value.artifactKind,
    schemaVersion: value.schemaVersion,
    importerVersion: value.importerVersion,
    sourceFileName: value.sourceFileName,
    header: [...value.header],
    headerDigest: value.headerDigest,
    partition,
    previousOracleDigest: value.previousOracleDigest,
    nextOracleDigest: value.nextOracleDigest,
    mutations,
  }
}

export function applyOracleDelta(source, delta) {
  const current = parseOracleSource(source, 'Oracle source')
  return applyParsedOracleDelta(current, delta)
}

function applyParsedOracleDelta(current, delta) {
  const parsed = parseOracleDelta(delta, current)
  return applyOracleDeltaValue(current, parsed)
}

export function prepareNarrowSourceObject({ provider, sourceFileName, content, importerVersion }) {
  if (!PROVIDERS.includes(provider)) throw new Error(`Unsupported narrow raw provider ${provider}`)
  assertFileName(sourceFileName, `${provider} sourceFileName`)
  assertNonEmptyString(importerVersion, `${provider} importerVersion`)
  const text = typeof content === 'string' ? content : Buffer.from(content ?? []).toString('utf8')
  const value = {
    artifactKind: NARROW_SOURCE_KIND,
    schemaVersion: 1,
    provider,
    importerVersion,
    sourceFileName,
    contentSha256: sha256(Buffer.from(text)),
    content: text,
  }
  const prepared = prepareRawObject(value)
  return { value, prepared, reference: rawObjectReferenceFor(prepared) }
}

export function parseNarrowSourceObject(value, { provider, importerVersion } = {}) {
  assertExactKeys(value, ['artifactKind', 'schemaVersion', 'provider', 'importerVersion', 'sourceFileName', 'contentSha256', 'content'], 'narrow raw source')
  if (value.artifactKind !== NARROW_SOURCE_KIND || value.schemaVersion !== 1 || !PROVIDERS.includes(value.provider)) {
    throw new Error('Unsupported narrow raw source schema')
  }
  assertFileName(value.sourceFileName, 'narrow raw sourceFileName')
  assertNonEmptyString(value.importerVersion, 'narrow raw importerVersion')
  assertDigest(value.contentSha256, 'narrow raw contentSha256')
  if (typeof value.content !== 'string' || sha256(Buffer.from(value.content)) !== value.contentSha256) throw new Error('Narrow raw source content digest mismatch')
  if (provider && value.provider !== provider) throw new Error('Narrow raw source provider mismatch')
  if (importerVersion && value.importerVersion !== importerVersion) throw new Error('Narrow raw source importer version mismatch')
  return value
}

export function prepareRawSourceReceipt({ generationId, importerVersion, coverage, sourceReceiptInputs, oracle, leaguepedia = [], lolesports = [] }) {
  assertSafeId(generationId, 'raw receipt generationId')
  assertNonEmptyString(importerVersion, 'raw receipt importerVersion')
  const parsedCoverage = parseCoverage(coverage)
  assertRecord(sourceReceiptInputs, 'sourceReceiptInputs')
  const parsedOracle = parseOracleReceiptSources(oracle, importerVersion)
  const parsedLeaguepedia = parseNarrowReceiptSources(leaguepedia, 'leaguepedia')
  const parsedLolEsports = parseNarrowReceiptSources(lolesports, 'lolesports')
  const identity = { importerVersion, coverage: parsedCoverage, oracle: parsedOracle, leaguepedia: parsedLeaguepedia, lolesports: parsedLolEsports }
  const rawIdentityDigest = sha256(Buffer.from(canonicalJsonFor(identity)))
  const sourceReceiptDigest = sha256(Buffer.from(canonicalJsonFor({ rawIdentityDigest, sourceReceiptInputs })))
  const receipt = {
    artifactKind: RAW_SOURCE_RECEIPT_KIND,
    schemaVersion: 1,
    storageMode: RAW_SOURCE_STORAGE_MODE,
    generationId,
    importerVersion,
    coverage: parsedCoverage,
    rawIdentityDigest,
    sourceReceiptInputs,
    sourceReceiptDigest,
    oracle: parsedOracle,
    leaguepedia: parsedLeaguepedia,
    lolesports: parsedLolEsports,
  }
  const prepared = prepareRawObject(receipt)
  return { receipt, prepared, authorityDigest: prepared.digest }
}

export function parseRawSourceReceipt(value) {
  assertExactKeys(value, ['artifactKind', 'schemaVersion', 'storageMode', 'generationId', 'importerVersion', 'coverage', 'rawIdentityDigest', 'sourceReceiptInputs', 'sourceReceiptDigest', 'oracle', 'leaguepedia', 'lolesports'], 'raw source receipt')
  if (value.artifactKind !== RAW_SOURCE_RECEIPT_KIND || value.schemaVersion !== 1 || value.storageMode !== RAW_SOURCE_STORAGE_MODE) {
    throw new Error('Unsupported raw source receipt schema')
  }
  assertSafeId(value.generationId, 'raw receipt generationId')
  assertNonEmptyString(value.importerVersion, 'raw receipt importerVersion')
  const coverage = parseCoverage(value.coverage)
  assertRecord(value.sourceReceiptInputs, 'raw receipt sourceReceiptInputs')
  assertDigest(value.rawIdentityDigest, 'raw receipt rawIdentityDigest')
  assertDigest(value.sourceReceiptDigest, 'raw receipt sourceReceiptDigest')
  const oracle = parseOracleReceiptSources(value.oracle, value.importerVersion)
  const leaguepedia = parseNarrowReceiptSources(value.leaguepedia, 'leaguepedia')
  const lolesports = parseNarrowReceiptSources(value.lolesports, 'lolesports')
  const identity = { importerVersion: value.importerVersion, coverage, oracle, leaguepedia, lolesports }
  const rawIdentityDigest = sha256(Buffer.from(canonicalJsonFor(identity)))
  const sourceReceiptDigest = sha256(Buffer.from(canonicalJsonFor({ rawIdentityDigest, sourceReceiptInputs: value.sourceReceiptInputs })))
  if (rawIdentityDigest !== value.rawIdentityDigest) throw new Error('Raw source receipt identity digest mismatch')
  if (sourceReceiptDigest !== value.sourceReceiptDigest) throw new Error('Raw source receipt sourceReceiptDigest mismatch')
  return { ...value, coverage, oracle, leaguepedia, lolesports }
}

export async function reconstructRawSourceReceipt(receiptValue, objectResolver) {
  const receipt = parseRawSourceReceipt(receiptValue)
  if (typeof objectResolver !== 'function') throw new Error('Raw source object resolver is required')
  const resolvedObjects = new Map()
  const resolveObject = async (reference, label) => {
    const parsedReference = parseRawObjectReference(reference, label)
    if (resolvedObjects.has(parsedReference.key)) return resolvedObjects.get(parsedReference.key)
    let compressed
    try { compressed = await objectResolver(parsedReference) } catch (error) {
      throw new Error(`Raw source object is missing: ${parsedReference.key}`, { cause: error })
    }
    if (compressed === undefined || compressed === null) throw new Error(`Raw source object is missing: ${parsedReference.key}`)
    const value = decodeRawObject(parsedReference, compressed)
    resolvedObjects.set(parsedReference.key, value)
    return value
  }
  const oracle = []
  for (const sourceReceipt of receipt.oracle) {
    const baselineValue = await resolveObject(sourceReceipt.baseline, `Oracle baseline ${sourceReceipt.sourceFileName}`)
    let source = parseOracleBaseline(baselineValue, { importerVersion: receipt.importerVersion })
    if (source.sourceFileName !== sourceReceipt.sourceFileName || source.headerDigest !== sourceReceipt.headerDigest) {
      throw new Error(`Oracle receipt compatibility mismatch for ${sourceReceipt.sourceFileName}`)
    }
    for (const [index, reference] of sourceReceipt.deltas.entries()) {
      const deltaValue = await resolveObject(reference, `Oracle delta ${sourceReceipt.sourceFileName}[${index}]`)
      source = applyParsedOracleDelta(source, deltaValue)
    }
    if (source.digest !== sourceReceipt.effectiveOracleDigest) throw new Error(`Oracle receipt chain mismatch for ${sourceReceipt.sourceFileName}`)
    if (canonicalJsonFor(oracleGameInventory(source)) !== canonicalJsonFor(sourceReceipt.gameInventory)) {
      throw new Error(`Oracle receipt inventory mismatch for ${sourceReceipt.sourceFileName}`)
    }
    oracle.push({ sourceFileName: source.sourceFileName, csv: oracleCsvForSource(source), source })
  }
  const resolveNarrow = async (entries, provider) => Promise.all(entries.map(async (entry) => {
    const value = await resolveObject(entry.object, `${provider} ${entry.sourceFileName}`)
    const parsed = parseNarrowSourceObject(value, { provider, importerVersion: receipt.importerVersion })
    if (parsed.sourceFileName !== entry.sourceFileName || parsed.contentSha256 !== entry.contentSha256) {
      throw new Error(`${provider} receipt compatibility mismatch for ${entry.sourceFileName}`)
    }
    return parsed
  }))
  return {
    receipt,
    oracle,
    leaguepedia: await resolveNarrow(receipt.leaguepedia, 'leaguepedia'),
    lolesports: await resolveNarrow(receipt.lolesports, 'lolesports'),
  }
}

export async function materializeRawSourceReceipt({ receipt, objectResolver, destinationDir, generatedAt }) {
  assertNonEmptyString(destinationDir, 'raw materialization destinationDir')
  assertNonEmptyString(generatedAt, 'raw materialization generatedAt')
  const reconstructed = await reconstructRawSourceReceipt(receipt, objectResolver)
  const destination = resolve(destinationDir)
  const nextDir = `${destination}.receipt-next-${process.pid}-${Date.now()}`
  await rm(nextDir, { recursive: true, force: true })
  try {
    const files = { oracleCsv: [], leaguepediaJson: [], lolEsportsJson: [] }
    const writeProviderFiles = async (directory, entries, contentFor, fileGroup) => {
      await mkdir(join(nextDir, directory), { recursive: true })
      for (const entry of entries) {
        const relativePath = `${directory}/${entry.sourceFileName}`
        await writeFile(join(nextDir, relativePath), contentFor(entry))
        files[fileGroup].push(relativePath)
      }
    }
    await writeProviderFiles('oracles-elixir', reconstructed.oracle, oracleContent, 'oracleCsv')
    await writeProviderFiles('leaguepedia', reconstructed.leaguepedia, narrowContent, 'leaguepediaJson')
    await writeProviderFiles('lolesports', reconstructed.lolesports, narrowContent, 'lolEsportsJson')
    const manifest = {
      schemaVersion: 1,
      generatedAt,
      start: reconstructed.receipt.coverage.start,
      end: reconstructed.receipt.coverage.end,
      files,
      sourceReceipt: {
        storageMode: RAW_SOURCE_STORAGE_MODE,
        generationId: reconstructed.receipt.generationId,
        rawIdentityDigest: reconstructed.receipt.rawIdentityDigest,
        sourceReceiptDigest: reconstructed.receipt.sourceReceiptDigest,
      },
      sources: {
        oracle: sourceStatus(reconstructed.oracle.length, 'primary'),
        leaguepedia: sourceStatus(reconstructed.leaguepedia.length, 'backup-gap-fill'),
        lolesports: sourceStatus(reconstructed.lolesports.length, 'schedule-results-reference'),
      },
      warnings: [],
    }
    await writeFile(join(nextDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await replaceDirectory(nextDir, destination, { publishLast: 'manifest.json' })
    return { ...reconstructed, manifest, manifestPath: join(destination, 'manifest.json') }
  } catch (error) {
    await rm(nextDir, { recursive: true, force: true })
    throw error
  }
}

function applyOracleDeltaValue(current, delta, { verifyNextDigest = true } = {}) {
  if (delta.previousOracleDigest !== current.digest) throw new Error('Oracle delta chain mismatch')
  const byId = new Map(current.games.map((game) => [game.gameId, game]))
  for (const mutation of delta.mutations) {
    const existing = byId.get(mutation.gameId)
    if (mutation.operation === 'add') {
      if (existing) throw new Error(`Oracle add is ambiguous because ${mutation.gameId} already exists`)
      byId.set(mutation.gameId, mutation.game)
    } else if (mutation.operation === 'replace') {
      if (!existing || existing.digest !== mutation.expectedPreviousDigest) throw new Error(`Oracle replacement prior digest mismatch for ${mutation.gameId}`)
      byId.set(mutation.gameId, mutation.game)
    } else {
      if (!existing || existing.digest !== mutation.expectedPreviousDigest) throw new Error(`Oracle deletion prior digest mismatch for ${mutation.gameId}`)
      byId.delete(mutation.gameId)
    }
  }
  const sourceWithoutDigest = { ...current, games: [...byId.values()].sort(compareGames) }
  const source = { ...sourceWithoutDigest, digest: oracleSourceDigest(sourceWithoutDigest) }
  if (verifyNextDigest && source.digest !== delta.nextOracleDigest) throw new Error('Oracle delta next digest mismatch')
  return source
}

function parseOracleSource(value, label) {
  assertRecord(value, label)
  assertFileName(value.sourceFileName, `${label} sourceFileName`)
  assertNonEmptyString(value.importerVersion, `${label} importerVersion`)
  if (!Array.isArray(value.header) || value.header.length === 0 || value.header.some((entry) => typeof entry !== 'string')) throw new Error(`${label} header is invalid`)
  assertUniqueStrings(value.header, `${label} header`)
  const headerDigest = sha256(Buffer.from(canonicalJsonFor(value.header)))
  if (value.headerDigest !== undefined && value.headerDigest !== headerDigest) throw new Error(`${label} header digest mismatch`)
  if (!Array.isArray(value.games) || value.games.length === 0) throw new Error(`${label} games must be non-empty`)
  const seen = new Set()
  const games = value.games.map((game, index) => parseOracleGame(game, value.header, undefined, `${label} game ${index}`, index))
  for (const game of games) {
    if (seen.has(game.gameId)) throw new Error(`${label} has duplicate or ambiguous game ${game.gameId}`)
    seen.add(game.gameId)
  }
  if (!isSorted(games, compareGames)) throw new Error(`${label} games are not canonically ordered`)
  const source = { sourceFileName: value.sourceFileName, importerVersion: value.importerVersion, header: [...value.header], headerDigest, games }
  return { ...source, digest: oracleSourceDigest(source) }
}

function parseOracleGame(value, header, indexes, label = 'Oracle game', fallbackSourceOrder) {
  assertRecord(value, label)
  assertNonEmptyString(value.gameId, `${label} gameId`)
  assertUtcDate(value.date, `${label} date`)
  assertNonEmptyString(value.league, `${label} league`)
  if (!Array.isArray(value.rows) || value.rows.length < 2) throw new Error(`${label} does not contain a complete game row group`)
  const sourceOrder = value.sourceOrder ?? fallbackSourceOrder
  if (!Number.isSafeInteger(sourceOrder) || sourceOrder < 0) throw new Error(`${label} sourceOrder is invalid`)
  const resolvedIndexes = indexes ?? Object.fromEntries(header.map((name, index) => [name.trim().toLowerCase(), index]))
  const sides = new Set()
  const rows = value.rows.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== header.length || row.some((field) => typeof field !== 'string')) throw new Error(`${label} row ${rowIndex} is incompatible with its header`)
    if (row[resolvedIndexes.gameid]?.trim() !== value.gameId || normalizeOracleDate(row[resolvedIndexes.date]) !== value.date || row[resolvedIndexes.league]?.trim() !== value.league) {
      throw new Error(`${label} row ${rowIndex} has inconsistent identity`)
    }
    sides.add(row[resolvedIndexes.side]?.trim().toLowerCase())
    return [...row]
  })
  if (!sides.has('blue') || !sides.has('red')) throw new Error(`${label} does not contain both sides`)
  const game = { gameId: value.gameId, date: value.date, league: value.league, sourceOrder, rows }
  return { ...game, digest: oracleGameDigest(game) }
}

function parseMutation(value, partition, header, label) {
  assertRecord(value, label)
  const operation = value.operation
  if (!['add', 'replace', 'delete'].includes(operation)) throw new Error(`${label} operation is invalid`)
  const allowed = operation === 'add' ? ['operation', 'gameId', 'game'] : operation === 'replace' ? ['operation', 'gameId', 'expectedPreviousDigest', 'game'] : ['operation', 'gameId', 'expectedPreviousDigest']
  assertExactKeys(value, allowed, label)
  assertNonEmptyString(value.gameId, `${label} gameId`)
  if (operation === 'delete') {
    assertDigest(value.expectedPreviousDigest, `${label} expectedPreviousDigest`)
    return { operation, gameId: value.gameId, expectedPreviousDigest: value.expectedPreviousDigest }
  }
  const game = parseOracleGame(value.game, header, undefined, `${label} game`)
  if (game.gameId !== value.gameId) throw new Error(`${label} gameId differs from game`)
  if (game.date !== partition.utcDate || game.league !== partition.league) throw new Error(`${label} game differs from delta partition`)
  if (operation === 'replace') assertDigest(value.expectedPreviousDigest, `${label} expectedPreviousDigest`)
  return operation === 'add'
    ? { operation, gameId: value.gameId, game }
    : { operation, gameId: value.gameId, expectedPreviousDigest: value.expectedPreviousDigest, game }
}

function parseOracleReceiptSources(value, importerVersion) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Raw receipt Oracle sources must be non-empty')
  const seenNames = new Set()
  const parsed = value.map((entry, index) => {
    assertExactKeys(entry, ['sourceFileName', 'headerDigest', 'digestScheme', 'effectiveOracleDigest', 'gameInventory', 'baseline', 'deltas'], `raw receipt Oracle source ${index}`)
    assertFileName(entry.sourceFileName, `raw receipt Oracle source ${index} filename`)
    assertDigest(entry.headerDigest, `raw receipt Oracle source ${index} headerDigest`)
    assertDigest(entry.effectiveOracleDigest, `raw receipt Oracle source ${index} effectiveOracleDigest`)
    if (entry.digestScheme !== ORACLE_GAME_INVENTORY_DIGEST_SCHEME) throw new Error(`raw receipt Oracle source ${index} digest scheme is incompatible`)
    if (seenNames.has(entry.sourceFileName)) throw new Error(`Raw receipt has duplicate Oracle source ${entry.sourceFileName}`)
    seenNames.add(entry.sourceFileName)
    const baseline = parseRawObjectReference(entry.baseline, `raw receipt Oracle source ${index} baseline`)
    const gameInventory = parseOracleGameInventory(entry.gameInventory, `raw receipt Oracle source ${index} gameInventory`)
    const effectiveOracleDigest = oracleSourceDigestFromInventory({
      sourceFileName: entry.sourceFileName,
      importerVersion,
      headerDigest: entry.headerDigest,
      gameInventory,
    })
    if (effectiveOracleDigest !== entry.effectiveOracleDigest) throw new Error(`raw receipt Oracle source ${index} inventory digest mismatch`)
    if (!Array.isArray(entry.deltas)) throw new Error(`raw receipt Oracle source ${index} deltas must be an array`)
    const seenDeltas = new Set()
    const deltas = entry.deltas.map((reference, deltaIndex) => {
      const parsedReference = parseRawObjectReference(reference, `raw receipt Oracle source ${index} delta ${deltaIndex}`)
      if (seenDeltas.has(parsedReference.key) || parsedReference.key === baseline.key) throw new Error(`Raw receipt Oracle source ${entry.sourceFileName} has duplicate object references`)
      seenDeltas.add(parsedReference.key)
      return parsedReference
    })
    return { sourceFileName: entry.sourceFileName, headerDigest: entry.headerDigest, digestScheme: entry.digestScheme, effectiveOracleDigest, gameInventory, baseline, deltas }
  })
  parsed.sort((left, right) => left.sourceFileName.localeCompare(right.sourceFileName))
  return parsed
}

function parseNarrowReceiptSources(value, provider) {
  if (!Array.isArray(value)) throw new Error(`Raw receipt ${provider} sources must be an array`)
  const seen = new Set()
  const parsed = value.map((entry, index) => {
    assertExactKeys(entry, ['sourceFileName', 'contentSha256', 'object'], `raw receipt ${provider} source ${index}`)
    assertFileName(entry.sourceFileName, `raw receipt ${provider} source ${index} filename`)
    assertDigest(entry.contentSha256, `raw receipt ${provider} source ${index} contentSha256`)
    if (seen.has(entry.sourceFileName)) throw new Error(`Raw receipt has duplicate ${provider} source ${entry.sourceFileName}`)
    seen.add(entry.sourceFileName)
    return { sourceFileName: entry.sourceFileName, contentSha256: entry.contentSha256, object: parseRawObjectReference(entry.object, `raw receipt ${provider} source ${index} object`) }
  })
  parsed.sort((left, right) => left.sourceFileName.localeCompare(right.sourceFileName))
  return parsed
}

function parseRawObjectReference(value, label) {
  assertExactKeys(value, ['key', 'sha256', 'bytes', 'compressedBytes', 'storageEncoding'], label)
  assertDigest(value.sha256, `${label} sha256`)
  if (value.key !== `raw/objects/sha256/${value.sha256}`) throw new Error(`${label} key is not canonical`)
  if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0 || !Number.isSafeInteger(value.compressedBytes) || value.compressedBytes <= 0) throw new Error(`${label} byte lengths are invalid`)
  if (value.storageEncoding !== 'gzip') throw new Error(`${label} storageEncoding must be gzip`)
  return { key: value.key, sha256: value.sha256, bytes: value.bytes, compressedBytes: value.compressedBytes, storageEncoding: 'gzip' }
}

function parsePartition(value, label) {
  assertExactKeys(value, ['utcDate', 'league'], label)
  assertUtcDate(value.utcDate, `${label} utcDate`)
  assertNonEmptyString(value.league, `${label} league`)
  return { utcDate: value.utcDate, league: value.league }
}

function parseCoverage(value) {
  assertExactKeys(value, ['start', 'end'], 'raw receipt coverage')
  assertUtcDate(value.start, 'raw receipt coverage start')
  assertUtcDate(value.end, 'raw receipt coverage end')
  if (value.start > value.end) throw new Error('Raw receipt coverage is reversed')
  return { start: value.start, end: value.end }
}

function oracleCsvForSource(source) {
  return `${[source.header, ...source.games.flatMap((game) => game.rows)].map((row) => row.map(csvCell).join(',')).join('\n')}\n`
}

function oracleSourceDigest(source) {
  return oracleSourceDigestFromInventory({
    sourceFileName: source.sourceFileName,
    importerVersion: source.importerVersion,
    headerDigest: source.headerDigest,
    gameInventory: oracleGameInventory(source),
  })
}

function oracleSourceDigestFromInventory({ sourceFileName, importerVersion, headerDigest, gameInventory }) {
  return sha256(Buffer.from(canonicalJsonFor({
    digestScheme: ORACLE_GAME_INVENTORY_DIGEST_SCHEME,
    sourceFileName,
    importerVersion,
    headerDigest,
    gameInventory,
  })))
}

export function oracleGameInventory(source) {
  return source.games.map(({ gameId, digest, date, league, sourceOrder }) => ({ gameId, digest, date, league, sourceOrder }))
}

function parseOracleInventoryAuthority(value, importerVersion) {
  assertRecord(value, 'previous Oracle inventory authority')
  assertFileName(value.sourceFileName, 'previous Oracle inventory authority sourceFileName')
  assertDigest(value.headerDigest, 'previous Oracle inventory authority headerDigest')
  assertDigest(value.effectiveOracleDigest, 'previous Oracle inventory authority effectiveOracleDigest')
  if (value.digestScheme !== ORACLE_GAME_INVENTORY_DIGEST_SCHEME) throw new Error('previous Oracle inventory digest scheme is incompatible')
  const gameInventory = parseOracleGameInventory(value.gameInventory, 'previous Oracle gameInventory')
  const effectiveOracleDigest = oracleSourceDigestFromInventory({
    sourceFileName: value.sourceFileName,
    importerVersion,
    headerDigest: value.headerDigest,
    gameInventory,
  })
  if (effectiveOracleDigest !== value.effectiveOracleDigest) throw new Error('previous Oracle inventory digest mismatch')
  return { sourceFileName: value.sourceFileName, headerDigest: value.headerDigest, effectiveOracleDigest, gameInventory }
}

function parseOracleGameInventory(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`)
  const seenIds = new Set()
  const seenOrders = new Set()
  const inventory = value.map((game, index) => {
    const gameLabel = `${label} game ${index}`
    assertExactKeys(game, ['gameId', 'digest', 'date', 'league', 'sourceOrder'], gameLabel)
    assertNonEmptyString(game.gameId, `${gameLabel} gameId`)
    assertDigest(game.digest, `${gameLabel} digest`)
    assertUtcDate(game.date, `${gameLabel} date`)
    assertNonEmptyString(game.league, `${gameLabel} league`)
    if (!Number.isSafeInteger(game.sourceOrder) || game.sourceOrder < 0) throw new Error(`${gameLabel} sourceOrder is invalid`)
    if (seenIds.has(game.gameId) || seenOrders.has(game.sourceOrder)) throw new Error(`${label} has duplicate game identity or source order`)
    seenIds.add(game.gameId)
    seenOrders.add(game.sourceOrder)
    return { gameId: game.gameId, digest: game.digest, date: game.date, league: game.league, sourceOrder: game.sourceOrder }
  })
  if (!isSorted(inventory, compareGames)) throw new Error(`${label} is not canonically ordered`)
  return inventory
}

function applyInventoryMutations(inventory, mutations) {
  const byId = new Map(inventory.map((game) => [game.gameId, game]))
  for (const mutation of mutations) {
    const existing = byId.get(mutation.gameId)
    if (mutation.operation === 'add') {
      if (existing) throw new Error(`Oracle inventory add is ambiguous because ${mutation.gameId} already exists`)
      byId.set(mutation.gameId, inventoryGameFor(mutation.game))
    } else if (mutation.operation === 'replace') {
      if (!existing || existing.digest !== mutation.expectedPreviousDigest) throw new Error(`Oracle inventory replacement prior digest mismatch for ${mutation.gameId}`)
      byId.set(mutation.gameId, inventoryGameFor(mutation.game))
    } else {
      if (!existing || existing.digest !== mutation.expectedPreviousDigest) throw new Error(`Oracle inventory deletion prior digest mismatch for ${mutation.gameId}`)
      byId.delete(mutation.gameId)
    }
  }
  return [...byId.values()].sort(compareGames)
}

function inventoryGameFor(game) {
  return { gameId: game.gameId, digest: game.digest, date: game.date, league: game.league, sourceOrder: game.sourceOrder }
}

function oracleGameDigest(game) {
  return sha256(Buffer.from(canonicalJsonFor(stripGameDigest(game))))
}

function stripGameDigest(game) {
  return { gameId: game.gameId, date: game.date, league: game.league, sourceOrder: game.sourceOrder, rows: game.rows }
}

function assertOracleCompatibility(left, right) {
  if (left.sourceFileName !== right.sourceFileName) throw new Error('Oracle source filename mismatch')
  if (left.importerVersion !== right.importerVersion) throw new Error('Oracle source importer version mismatch')
  if (left.headerDigest !== right.headerDigest) throw new Error('Oracle source header mismatch')
}

function partitionFor(game) { return { utcDate: game.date, league: game.league } }
function rawMutationFor(entry) {
  if (entry.operation === 'add') return { operation: entry.operation, gameId: entry.gameId, game: entry.game }
  if (entry.operation === 'replace') return { operation: entry.operation, gameId: entry.gameId, expectedPreviousDigest: entry.expectedPreviousDigest, game: entry.game }
  return { operation: entry.operation, gameId: entry.gameId, expectedPreviousDigest: entry.expectedPreviousDigest }
}
function partitionKeyFor(partition) { return `${partition.utcDate}\u0000${partition.league}` }
function compareGames(left, right) { return left.sourceOrder - right.sourceOrder || left.gameId.localeCompare(right.gameId) }
function compareMutations(left, right) { return left.gameId.localeCompare(right.gameId) || left.operation.localeCompare(right.operation) }
function comparePartitionedMutations(left, right) { return partitionKeyFor(left.partition).localeCompare(partitionKeyFor(right.partition)) || compareMutations(left, right) }

function groupBy(values, keyFor) {
  const groups = new Map()
  for (const value of values) groups.set(keyFor(value), [...(groups.get(keyFor(value)) ?? []), value])
  return groups
}

function parseCsv(input) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (char === '"' && quoted && input[index + 1] === '"') { field += '"'; index += 1; continue }
    if (char === '"') { quoted = !quoted; continue }
    if (char === ',' && !quoted) { row.push(field); field = ''; continue }
    if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && input[index + 1] === '\n') index += 1
      row.push(field); rows.push(row); row = []; field = ''; continue
    }
    field += char
  }
  if (quoted) throw new Error('Oracle CSV has an unterminated quoted field')
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

function normalizeOracleDate(value) {
  const text = String(value ?? '').trim()
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text)
  if (!match) return undefined
  assertUtcDate(match[1], 'Oracle game date')
  return match[1]
}

function csvCell(value) { return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value }
function sourceStatus(count, role) { return { role, status: count > 0 ? 'downloaded' : 'skipped', downloadedCount: count, reusedCount: 0, failedCount: 0 } }
function oracleContent(entry) { return entry.csv }
function narrowContent(entry) { return entry.content }

function assertPreparedObject(value) {
  assertRecord(value, 'prepared raw object')
  assertDigest(value.digest, 'prepared raw object digest')
  if (typeof value.compressedPath === 'string') {
    assertDigest(value.compressedSha256, 'Prepared file-backed raw object compressedSha256')
    if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0 || !Number.isSafeInteger(value.compressedBytes) || value.compressedBytes <= 0) {
      throw new Error('Prepared file-backed raw object lengths are invalid')
    }
    return
  }
  if (!Buffer.isBuffer(value.canonicalBytes) || !Buffer.isBuffer(value.compressed)) throw new Error('Prepared raw object bytes are invalid')
  if (value.bytes !== value.canonicalBytes.byteLength || value.compressedBytes !== value.compressed.byteLength) throw new Error('Prepared raw object lengths are invalid')
}

function assertExactKeys(value, allowed, label) {
  assertRecord(value, label)
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  const missing = allowed.filter((key) => !(key in value))
  if (unexpected.length || missing.length) throw new Error(`${label} keys are invalid; missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}`)
}

function assertRecord(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`) }
function assertNonEmptyString(value, label) { if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`) }
function assertDigest(value, label) { if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new Error(`${label} must be a SHA-256 digest`) }
function assertUtcDate(value, label) { if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) throw new Error(`${label} must be a UTC date`) }
function assertSafeId(value, label) { if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) throw new Error(`${label} is invalid`) }
function assertFileName(value, label) { assertNonEmptyString(value, label); if (basename(value) !== value || value === '.' || value === '..') throw new Error(`${label} must be a filename`) }
function assertUniqueStrings(values, label) { const normalized = values.map((entry) => entry.trim().toLowerCase()); if (new Set(normalized).size !== normalized.length) throw new Error(`${label} contains duplicate fields`) }
function isSorted(values, compare) { return values.every((value, index) => index === 0 || compare(values[index - 1], value) <= 0) }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
