import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  applyOracleDelta,
  decodeRawObject,
  materializeRawSourceReceipt,
  ORACLE_GAME_INVENTORY_DIGEST_SCHEME,
  oracleGameInventory,
  parseOracleBaseline,
  parseOracleCsv,
  parseOracleDelta,
  parseRawSourceReceipt,
  prepareNarrowSourceObject,
  prepareOracleBaseline,
  prepareOracleBaselineFromSource,
  prepareOracleMutationChain,
  prepareOracleMutationChainFromInventory,
  prepareRawObject,
  prepareRawSourceReceipt,
  rawObjectReferenceFor,
  reconstructRawSourceReceipt,
  type CanonicalOracleSource,
  type PreparedRawObject,
  type RawObjectReference,
  type RawReceiptNarrowSource,
} from '../scripts/raw-source-storage.mjs'
import { importRankingSourceData } from '../scripts/ranking-source-import.ts'

const IMPORTER_VERSION = 'community-source-import-v1'
const ORACLE_FILE = '2026_LoL_esports_match_data_from_OraclesElixir.csv'
const HEADER = [
  'gameid', 'date', 'year', 'league', 'split', 'playoffs', 'patch', 'position', 'side',
  'teamname', 'result', 'kills', 'totalgold', 'playerid', 'playername',
]

type GameFixture = {
  gameId: string
  date: string
  league?: string
  blue?: string
  red?: string
  winner?: 'blue' | 'red'
  blueKills?: number
  redKills?: number
}

function oracleCsv(games: GameFixture[]) {
  return `${[HEADER, ...games.flatMap(gameRows)].map(csvRow).join('\n')}\n`
}

function gameRows({
  gameId,
  date,
  league = 'LCK',
  blue = 'T1',
  red = 'Gen.G',
  winner = 'blue',
  blueKills = 18,
  redKills = 11,
}: GameFixture) {
  const common = [gameId, date, date.slice(0, 4), league, 'Spring', '0', '26.1']
  const resultFor = (side: 'blue' | 'red') => side === winner ? '1' : '0'
  const teamRow = (side: 'blue' | 'red', name: string, kills: number, gold: number) => [
    ...common, 'team', side, name, resultFor(side), String(kills), String(gold), '', '',
  ]
  const playerRows = (side: 'blue' | 'red', name: string, kills: number, gold: number) =>
    ['top', 'jng', 'mid', 'bot', 'sup'].map((position, index) => [
      ...common,
      position,
      side,
      name,
      resultFor(side),
      String(index === 2 ? kills : 0),
      String(Math.floor(gold / 5)),
      `${gameId}-${side}-${position}`,
      `${name} ${position}`,
    ])
  return [
    teamRow('blue', blue, blueKills, 65_000),
    ...playerRows('blue', blue, blueKills, 65_000),
    teamRow('red', red, redKills, 59_000),
    ...playerRows('red', red, redKills, 59_000),
  ]
}

function csvRow(values: string[]) {
  return values.map((value) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value).join(',')
}

function addPrepared(store: Map<string, Buffer>, item: { prepared: PreparedRawObject }) {
  const reference = rawObjectReferenceFor(item.prepared)
  store.set(reference.key, item.prepared.compressed)
}

function oracleReceipt(source: CanonicalOracleSource, baseline: RawObjectReference, deltas: RawObjectReference[]) {
  return {
    sourceFileName: source.sourceFileName,
    headerDigest: source.headerDigest,
    digestScheme: ORACLE_GAME_INVENTORY_DIGEST_SCHEME,
    effectiveOracleDigest: source.digest,
    gameInventory: oracleGameInventory(source),
    baseline,
    deltas,
  }
}

function narrowReceipt(item: ReturnType<typeof prepareNarrowSourceObject>): RawReceiptNarrowSource {
  return {
    sourceFileName: item.value.sourceFileName,
    contentSha256: item.value.contentSha256,
    object: item.reference,
  }
}

function receiptFor({
  source,
  baseline,
  deltas,
  leaguepedia = [],
  lolesports = [],
}: {
  source: CanonicalOracleSource
  baseline: RawObjectReference
  deltas: RawObjectReference[]
  leaguepedia?: RawReceiptNarrowSource[]
  lolesports?: RawReceiptNarrowSource[]
}) {
  return prepareRawSourceReceipt({
    generationId: 'generation-2026-07-22',
    importerVersion: IMPORTER_VERSION,
    coverage: { start: '2026-01-01', end: '2026-12-31' },
    sourceReceiptInputs: { providerPolicy: 'oracle-primary', request: { year: 2026 } },
    oracle: [oracleReceipt(source, baseline, deltas)],
    leaguepedia,
    lolesports,
  }).receipt
}

function resolverFor(store: Map<string, Buffer>) {
  return (reference: RawObjectReference) => store.get(reference.key)
}

test('raw objects are canonical, deterministic gzip objects and fail closed when corrupt', () => {
  const left = prepareRawObject({ b: [2, 1], a: { z: true, y: 'value' } })
  const right = prepareRawObject({ a: { y: 'value', z: true }, b: [2, 1] })
  const reference = rawObjectReferenceFor(left)

  assert.equal(left.digest, right.digest)
  assert.deepEqual(left.compressed, right.compressed)
  assert.deepEqual(decodeRawObject(reference, left.compressed), left.value)
  assert.throws(() => decodeRawObject(reference, Buffer.from('not-gzip')), /compressed byte length|gzip is corrupt/)
  assert.throws(
    () => decodeRawObject({ ...reference, sha256: '0'.repeat(64), key: `raw/objects/sha256/${'0'.repeat(64)}` }, left.compressed),
    /semantic digest mismatch/,
  )
})

test('append deltas reconstruct and materialize importer-equivalent legacy source files', async () => {
  const baselineGames: GameFixture[] = [
    { gameId: 'lck-1', date: '2026-01-10' },
    { gameId: 'lck-2', date: '2026-01-11', blue: 'Gen.G', red: 'T1', winner: 'red' },
  ]
  const appendedGames = [...baselineGames, { gameId: 'lck-3', date: '2026-01-12', blue: 'T1', red: 'Gen.G' }]
  const baseline = prepareOracleBaseline({ csv: oracleCsv(baselineGames), sourceFileName: ORACLE_FILE, importerVersion: IMPORTER_VERSION })
  const chain = prepareOracleMutationChainFromInventory({
    previousReceipt: oracleReceipt(baseline.source, baseline.reference, []),
    importerVersion: IMPORTER_VERSION,
    nextCsv: oracleCsv(appendedGames),
  })
  const leaguepediaContent = JSON.stringify({ source: 'fixture', fetchedAt: '2026-07-22T00:00:00.000Z', matches: [] })
  const lolesportsContent = JSON.stringify({ source: 'fixture', fetchedAt: '2026-07-22T00:00:00.000Z', events: [] })
  const leaguepedia = prepareNarrowSourceObject({ provider: 'leaguepedia', sourceFileName: 'leaguepedia.json', content: leaguepediaContent, importerVersion: IMPORTER_VERSION })
  const lolesports = prepareNarrowSourceObject({ provider: 'lolesports', sourceFileName: 'lolesports.json', content: lolesportsContent, importerVersion: IMPORTER_VERSION })
  const store = new Map<string, Buffer>()
  addPrepared(store, baseline)
  chain.deltas.forEach((delta) => addPrepared(store, delta))
  addPrepared(store, leaguepedia)
  addPrepared(store, lolesports)
  const receipt = receiptFor({
    source: chain.source,
    baseline: baseline.reference,
    deltas: chain.deltas.map((delta) => delta.reference),
    leaguepedia: [narrowReceipt(leaguepedia)],
    lolesports: [narrowReceipt(lolesports)],
  })
  const materializedDir = await mkdtemp(join(tmpdir(), 'raw-source-materialized-'))
  const legacyDir = await mkdtemp(join(tmpdir(), 'raw-source-legacy-'))

  try {
    const materialized = await materializeRawSourceReceipt({
      receipt,
      objectResolver: resolverFor(store),
      destinationDir: materializedDir,
      generatedAt: '2026-07-22T00:00:00.000Z',
    })
    await writeLegacyFixture(legacyDir, oracleCsv(appendedGames), leaguepediaContent, lolesportsContent)
    const [actual, expected] = await Promise.all([
      importRankingSourceData({ manifestPath: materialized.manifestPath }),
      importRankingSourceData({ manifestPath: join(legacyDir, 'manifest.json') }),
    ])

    assert.deepEqual(actual.importedMatches, expected.importedMatches)
    assert.deepEqual(actual.matches, expected.matches)
    assert.deepEqual(actual.teams, expected.teams)
    assert.deepEqual(actual.tournamentScheduleReferences, expected.tournamentScheduleReferences)
    assert.equal(await readFile(join(materializedDir, 'leaguepedia/leaguepedia.json'), 'utf8'), leaguepediaContent)
    assert.equal(await readFile(join(materializedDir, 'lolesports/lolesports.json'), 'utf8'), lolesportsContent)
    assert.deepEqual(materialized.manifest.files, {
      oracleCsv: [`oracles-elixir/${ORACLE_FILE}`],
      leaguepediaJson: ['leaguepedia/leaguepedia.json'],
      lolEsportsJson: ['lolesports/lolesports.json'],
    })
    assert.equal(chain.mutations.length, 1)
    assert.deepEqual(chain.mutations[0].partition, { utcDate: '2026-01-12', league: 'LCK' })
    assert.equal(chain.mutations[0].operation, 'add')
  } finally {
    await Promise.all([rm(materializedDir, { recursive: true }), rm(legacyDir, { recursive: true })])
  }
})

test('raw receipt restore swaps atomically, prunes orphans, and preserves prior authority on corruption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raw-source-atomic-restore-'))
  const destination = join(root, 'raw')
  const baseline = prepareOracleBaseline({
    csv: oracleCsv([{ gameId: 'atomic-1', date: '2026-01-10' }]),
    sourceFileName: ORACLE_FILE,
    importerVersion: IMPORTER_VERSION,
  })
  const store = new Map<string, Buffer>()
  addPrepared(store, baseline)
  const receipt = receiptFor({ source: baseline.source, baseline: baseline.reference, deltas: [] })
  try {
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, 'orphan.txt'), 'obsolete')
    await writeFile(join(destination, 'manifest.json'), '{"authority":"old"}\n')
    const restored = await materializeRawSourceReceipt({
      receipt,
      objectResolver: resolverFor(store),
      destinationDir: destination,
      generatedAt: '2026-07-22T00:00:00.000Z',
    })
    await assert.rejects(access(join(destination, 'orphan.txt')), { code: 'ENOENT' })
    const manifestBeforeFailure = await readFile(restored.manifestPath, 'utf8')
    const csvBeforeFailure = await readFile(join(destination, 'oracles-elixir', ORACLE_FILE), 'utf8')
    const corrupt = new Map(store)
    corrupt.set(baseline.reference.key, Buffer.from('corrupt'))

    await assert.rejects(
      materializeRawSourceReceipt({
        receipt,
        objectResolver: resolverFor(corrupt),
        destinationDir: destination,
        generatedAt: '2026-07-23T00:00:00.000Z',
      }),
      /compressed byte length|gzip is corrupt/,
    )
    assert.equal(await readFile(restored.manifestPath, 'utf8'), manifestBeforeFailure)
    assert.equal(await readFile(join(destination, 'oracles-elixir', ORACLE_FILE), 'utf8'), csvBeforeFailure)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ordered deltas support correction, delete, and date/league moves with prior digests', async () => {
  const before: GameFixture[] = [
    { gameId: 'correct-me', date: '2026-02-01' },
    { gameId: 'delete-me', date: '2026-02-02', blue: 'Gen.G', red: 'T1' },
    { gameId: 'move-me', date: '2026-02-03' },
  ]
  const after: GameFixture[] = [
    { gameId: 'correct-me', date: '2026-02-01', winner: 'red', blueKills: 8, redKills: 20 },
    { gameId: 'move-me', date: '2026-03-04', league: 'MSI' },
  ]
  const baseline = prepareOracleBaseline({ csv: oracleCsv(before), sourceFileName: ORACLE_FILE, importerVersion: IMPORTER_VERSION })
  const previousReceipt = oracleReceipt(baseline.source, baseline.reference, [])
  const chain = prepareOracleMutationChainFromInventory({
    previousReceipt,
    importerVersion: IMPORTER_VERSION,
    nextCsv: oracleCsv(after),
  })
  const previousDigests = new Map(baseline.source.games.map((game) => [game.gameId, game.digest]))
  const byId = new Map(chain.mutations.map((mutation) => [mutation.gameId, mutation]))
  const correction = byId.get('correct-me')
  const deletion = byId.get('delete-me')
  const move = byId.get('move-me')

  assert.equal(correction?.operation, 'replace')
  assert.equal(deletion?.operation, 'delete')
  assert.equal(move?.operation, 'replace')
  assert.ok(correction && 'expectedPreviousDigest' in correction)
  assert.ok(deletion && 'expectedPreviousDigest' in deletion)
  assert.equal(correction.expectedPreviousDigest, previousDigests.get('correct-me'))
  assert.equal(deletion.expectedPreviousDigest, previousDigests.get('delete-me'))
  assert.deepEqual(move?.partition, { utcDate: '2026-03-04', league: 'MSI' })
  assert.equal(chain.deltas[0]?.value.previousOracleDigest, previousReceipt.effectiveOracleDigest)
  for (let index = 1; index < chain.deltas.length; index += 1) {
    assert.equal(chain.deltas[index]?.value.previousOracleDigest, chain.deltas[index - 1]?.value.nextOracleDigest)
  }
  assert.equal(chain.deltas.at(-1)?.value.nextOracleDigest, chain.source.digest)

  const store = new Map<string, Buffer>()
  addPrepared(store, baseline)
  chain.deltas.forEach((delta) => addPrepared(store, delta))
  const reconstructed = await reconstructRawSourceReceipt(
    receiptFor({ source: chain.source, baseline: baseline.reference, deltas: chain.deltas.map((delta) => delta.reference) }),
    resolverFor(store),
  )
  assert.equal(reconstructed.oracle[0].source.digest, parseOracleCsv(oracleCsv(after), { sourceFileName: ORACLE_FILE, importerVersion: IMPORTER_VERSION }).digest)
})

test('a compacted baseline reconstructs the same effective source without old deltas', async () => {
  const initial = prepareOracleBaseline({
    csv: oracleCsv([{ gameId: 'compact-1', date: '2026-04-01' }]),
    sourceFileName: ORACLE_FILE,
    importerVersion: IMPORTER_VERSION,
  })
  const chain = prepareOracleMutationChain({
    previousSource: initial.source,
    nextCsv: oracleCsv([
      { gameId: 'compact-1', date: '2026-04-01', winner: 'red' },
      { gameId: 'compact-2', date: '2026-04-02' },
    ]),
  })
  const compacted = prepareOracleBaselineFromSource(chain.source)
  const store = new Map<string, Buffer>()
  addPrepared(store, compacted)
  const reconstructed = await reconstructRawSourceReceipt(
    receiptFor({ source: chain.source, baseline: compacted.reference, deltas: [] }),
    resolverFor(store),
  )

  assert.equal(reconstructed.oracle[0].source.digest, chain.source.digest)
  assert.deepEqual(reconstructed.oracle[0].source.games, chain.source.games)
})

test('schema, compatibility, duplicate, missing, corrupt, and chain errors fail closed', async () => {
  const baseline = prepareOracleBaseline({
    csv: oracleCsv([
      { gameId: 'guard-1', date: '2026-05-01' },
      { gameId: 'guard-2', date: '2026-05-02' },
    ]),
    sourceFileName: ORACLE_FILE,
    importerVersion: IMPORTER_VERSION,
  })
  const chain = prepareOracleMutationChain({
    previousSource: baseline.source,
    nextCsv: oracleCsv([
      { gameId: 'guard-1', date: '2026-05-01', winner: 'red' },
      { gameId: 'guard-2', date: '2026-05-02' },
    ]),
  })
  const receipt = receiptFor({ source: chain.source, baseline: baseline.reference, deltas: chain.deltas.map((delta) => delta.reference) })
  const store = new Map<string, Buffer>()
  addPrepared(store, baseline)
  chain.deltas.forEach((delta) => addPrepared(store, delta))

  await assert.rejects(reconstructRawSourceReceipt(receipt, () => undefined), /missing/)
  const corruptStore = new Map(store)
  corruptStore.set(baseline.reference.key, Buffer.alloc(baseline.reference.compressedBytes))
  await assert.rejects(reconstructRawSourceReceipt(receipt, resolverFor(corruptStore)), /gzip is corrupt|semantic digest mismatch/)

  assert.throws(() => parseOracleBaseline({ ...baseline.value, games: [...baseline.value.games, baseline.value.games[0]] }), /duplicate|canonically ordered/)
  assert.throws(() => parseOracleBaseline(baseline.value, { importerVersion: 'future-importer-v2' }), /importer version mismatch/)
  assert.throws(() => prepareOracleMutationChain({
    previousSource: baseline.source,
    nextCsv: oracleCsv([{ gameId: 'guard-1', date: '2026-05-01' }]).replace('totalgold', 'earnedgold'),
  }), /header mismatch/)

  const firstDelta = chain.deltas[0].value
  assert.throws(() => parseOracleDelta({ ...firstDelta, mutations: [...firstDelta.mutations, firstDelta.mutations[0]] }), /duplicate|canonically ordered/)
  assert.throws(() => applyOracleDelta(baseline.source, {
    ...firstDelta,
    mutations: firstDelta.mutations.map((mutation) => mutation.operation === 'replace'
      ? { ...mutation, expectedPreviousDigest: '0'.repeat(64) }
      : mutation),
  }), /prior digest mismatch/)

  assert.throws(
    () => parseRawSourceReceipt({ ...receipt, oracle: [{ ...receipt.oracle[0], effectiveOracleDigest: '0'.repeat(64) }] }),
    /inventory digest mismatch/,
  )
  const legacyOracle = Object.fromEntries(
    Object.entries(receipt.oracle[0]).filter(([key]) => key !== 'digestScheme' && key !== 'gameInventory'),
  )
  assert.throws(
    () => parseRawSourceReceipt({ ...receipt, storageMode: 'content-addressed-raw-gzip-v1', oracle: [legacyOracle] }),
    /Unsupported raw source receipt schema/,
  )
  assert.throws(
    () => parseRawSourceReceipt({ ...receipt, oracle: [legacyOracle] }),
    /missing: digestScheme, gameInventory/,
  )
  assert.throws(() => parseRawSourceReceipt({ ...receipt, schemaVersion: 2 }), /Unsupported raw source receipt schema/)
})

async function writeLegacyFixture(directory: string, oracle: string, leaguepedia: string, lolesports: string) {
  await Promise.all([
    mkdir(join(directory, 'oracles-elixir'), { recursive: true }),
    mkdir(join(directory, 'leaguepedia'), { recursive: true }),
    mkdir(join(directory, 'lolesports'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(directory, `oracles-elixir/${ORACLE_FILE}`), oracle),
    writeFile(join(directory, 'leaguepedia/leaguepedia.json'), leaguepedia),
    writeFile(join(directory, 'lolesports/lolesports.json'), lolesports),
  ])
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-07-22T00:00:00.000Z',
    start: '2026-01-01',
    end: '2026-12-31',
    files: {
      oracleCsv: [`oracles-elixir/${ORACLE_FILE}`],
      leaguepediaJson: ['leaguepedia/leaguepedia.json'],
      lolEsportsJson: ['lolesports/lolesports.json'],
    },
    sources: {
      oracle: { status: 'downloaded', downloadedCount: 1, reusedCount: 0, failedCount: 0 },
      leaguepedia: { status: 'downloaded', downloadedCount: 1, reusedCount: 0, failedCount: 0 },
      lolesports: { status: 'downloaded', downloadedCount: 1, reusedCount: 0, failedCount: 0 },
    },
    warnings: [],
  }, null, 2)}\n`)
}
