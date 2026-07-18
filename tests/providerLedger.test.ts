import assert from 'node:assert/strict'
import test from 'node:test'
import { scanOracleCsv } from '../src/lib/incremental/oracleScanner.ts'
import { processProviderFile, type ProviderFileFingerprint } from '../src/lib/incremental/providerLedger.ts'
import { sha256Hex } from '../src/lib/incremental/hash.ts'
import { decodePrivateState, encodePrivateState } from '../src/lib/incremental/canonicalCodec.ts'

const firstGame = [
  'g1,2026-01-10,2026,LCK,Spring,0,26.1,team,Blue,Gen.G,1,18,65000',
  'g1,2026-01-10,2026,LCK,Spring,0,26.1,team,Red,T1,0,12,59000',
]
const secondGame = [
  'g2,2026-01-17,2026,LCK,Spring,0,26.1,team,Blue,T1,1,19,66000',
  'g2,2026-01-17,2026,LCK,Spring,0,26.1,team,Red,Gen.G,0,10,58000',
]
const header = 'gameid,date,year,league,split,playoffs,patch,position,side,teamname,result,kills,totalgold'
const retrievedAt = '2026-07-18T00:00:00.000Z'

test('compatible unchanged files read and parse zero content bytes', async () => {
  const contents = [header, ...firstGame].join('\n')
  const fingerprint = oracleFingerprint(contents)
  const initial = scanOracleCsv({ contents, fingerprint, retrievedAt })
  let reads = 0
  const result = await processProviderFile({
    fingerprint,
    previous: initial.ledger,
    readContents: async () => {
      reads += 1
      return contents
    },
    normalize: (next, previous) => scanOracleCsv({ contents: next, fingerprint, previous, retrievedAt }),
    now: '2026-07-18T00:00:00.000Z',
  })
  assert.equal(reads, 0)
  assert.equal(result.status, 'reused')
  assert.deepEqual(result.metrics, { bytesScanned: 0, rowsParsed: 0, observationsNormalized: 0, observationsReused: 1 })
})

test('Oracle append and corrections normalize only changed raw game groups', () => {
  const original = [header, ...firstGame].join('\n')
  const first = scanOracleCsv({ contents: original, fingerprint: oracleFingerprint(original), retrievedAt })
  const appended = [header, ...firstGame, ...secondGame].join('\n')
  const second = scanOracleCsv({ contents: appended, fingerprint: oracleFingerprint(appended), previous: first.ledger, retrievedAt })
  assert.equal(second.metrics.observationsReused, 1)
  assert.equal(second.metrics.observationsNormalized, 1)

  const corrected = appended.replace(',18,65000', ',17,64500')
  const third = scanOracleCsv({ contents: corrected, fingerprint: oracleFingerprint(corrected), previous: second.ledger, retrievedAt })
  assert.equal(third.metrics.observationsReused, 1)
  assert.equal(third.metrics.observationsNormalized, 1)
  assert.equal(third.ledger.observations[0]?.kind, 'match')
  if (third.ledger.observations[0]?.kind === 'match') assert.equal(third.ledger.observations[0].payload.teamAKills, 17)
})

test('deletions require authoritative replacement before emitting tombstones', async () => {
  const original = [header, ...firstGame, ...secondGame].join('\n')
  const previous = scanOracleCsv({ contents: original, fingerprint: oracleFingerprint(original), retrievedAt }).ledger
  const reduced = [header, ...secondGame].join('\n')
  const fingerprint = oracleFingerprint(reduced)
  const normalize = (contents: string) => scanOracleCsv({ contents, fingerprint, previous, retrievedAt })
  const ambiguous = await processProviderFile({
    fingerprint,
    previous,
    readContents: async () => reduced,
    normalize,
    now: '2026-07-18T00:00:00.000Z',
  })
  assert.equal(ambiguous.status, 'fallback')
  assert.match(ambiguous.fallback?.kind === 'dependency-unknown' ? ambiguous.fallback.dependency : '', /ambiguous-provider-deletion/)
  assert.equal(ambiguous.tombstones.length, 0)

  const authoritative = await processProviderFile({
    fingerprint,
    previous,
    authoritativeReplacement: true,
    readContents: async () => reduced,
    normalize,
    now: '2026-07-18T00:00:00.000Z',
  })
  assert.equal(authoritative.status, 'changed')
  assert.deepEqual(authoritative.tombstones.map((entry) => entry.observationId), ['oracles-elixir:game:g1'])
})

test('private state encoding is bijective for tag-like user data and undefined', () => {
  const value = {
    __rankingPrivateUndefinedV1: true,
    nested: undefined,
    tagLike: { tag: 'undefined', value: ['array', null] },
    values: [undefined, null, false, 'undefined', Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0],
  }
  assert.deepEqual(decodePrivateState(encodePrivateState(value)), value)
})

function oracleFingerprint(contents: string): ProviderFileFingerprint & { provider: 'oracles-elixir' } {
  return {
    provider: 'oracles-elixir',
    fileId: '2026.csv',
    byteLength: new TextEncoder().encode(contents).length,
    contentHash: sha256Hex(contents),
  }
}
