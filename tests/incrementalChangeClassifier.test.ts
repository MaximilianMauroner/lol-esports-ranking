import assert from 'node:assert/strict'
import test from 'node:test'
import type { MatchRecord } from '../src/types.ts'
import { buildCanonicalMatchLedger, classifyRankingChange } from '../src/lib/incremental/changeClassifier.ts'
import type { CanonicalMatchLedgerContext } from '../src/lib/incremental/types.ts'

const context: CanonicalMatchLedgerContext = {
  modelVersion: 'model-v1',
  modelConfigHash: 'config-v1',
  importerVersion: 'importer-v1',
  identityTaxonomyHash: 'taxonomy-v1',
  scheduleReceiptIdentity: 'schedule-v1',
  contextReceiptIdentity: 'context-v1',
  provenanceReceiptIdentity: 'provenance-v1',
}

test('canonical ledger uses provider priority, deterministic ordering, and rejects collisions', () => {
  const matches = [
    match({ id: 'canonical', sourceGameId: 'provider-game', officialGameId: 'official-game', date: '2026-01-02' }),
    match({ id: 'fallback', sourceGameId: 'source-only', officialGameId: undefined, date: '2026-01-01' }),
  ]
  const ledger = buildCanonicalMatchLedger(matches, context)
  assert.deepEqual(ledger.rows.map((row) => row.key), [
    'source-game:oracles-elixir:source-only',
    'official-game:official-game',
  ])
  assert.equal(ledger.rows.every((row) => row.scoringDigest === row.artifactDigest), true)
  assert.throws(() => buildCanonicalMatchLedger([matches[0]!, { ...matches[0]!, id: 'duplicate' }], context), /Duplicate/)
})

test('classifier exhaustively distinguishes receipts, append, insertion, correction, deletion, date move, and invalidation', () => {
  const first = match({ id: 'first', date: '2026-01-01' })
  const second = match({ id: 'second', date: '2026-01-02' })
  const previous = buildCanonicalMatchLedger([first, second], context)
  assert.equal(classifyRankingChange(previous, buildCanonicalMatchLedger([first, second], context)).kind, 'no-change')

  const metadata = buildCanonicalMatchLedger([first, second], { ...context, provenanceReceiptIdentity: 'provenance-v2' })
  assert.equal(classifyRankingChange(previous, metadata).kind, 'metadata-only')

  const scheduleBaseContext = { ...context, scheduleReceiptIdentity: 'schedule-causal-v1', scheduleCausalRows: [{ key: 'schedule-1', utcDate: '2026-01-02', digest: 'open' }] }
  const scheduleBase = buildCanonicalMatchLedger([first, second], scheduleBaseContext)
  const scheduleTransition = buildCanonicalMatchLedger([first, second], {
    ...scheduleBaseContext,
    scheduleReceiptIdentity: 'schedule-causal-v2',
    scheduleCausalRows: [{ key: 'schedule-1', utcDate: '2026-01-02', digest: 'completed' }],
  })
  assert.equal(classifyRankingChange(scheduleBase, scheduleTransition).kind, 'historical-correction')
  const scheduleAppend = buildCanonicalMatchLedger([first, second], {
    ...scheduleBaseContext,
    scheduleReceiptIdentity: 'schedule-causal-v3',
    scheduleCausalRows: [...scheduleBaseContext.scheduleCausalRows, { key: 'schedule-2', utcDate: '2026-02-01', digest: 'future' }],
  })
  assert.equal(classifyRankingChange(scheduleBase, scheduleAppend).kind, 'latest-append')

  const appended = match({ id: 'third', date: '2026-01-03' })
  const appendDecision = classifyRankingChange(previous, buildCanonicalMatchLedger([first, second, appended], context))
  assert.equal(appendDecision.kind, 'latest-append')
  assert.equal(appendDecision.earliestChangedUtcDate, '2026-01-03')

  const inserted = match({ id: 'inserted', date: '2026-01-02' })
  assert.equal(
    classifyRankingChange(previous, buildCanonicalMatchLedger([first, second, inserted], context)).kind,
    'same-day-insertion',
  )

  const corrected = { ...first, winner: first.teamB }
  const correctionDecision = classifyRankingChange(previous, buildCanonicalMatchLedger([corrected, second], context))
  assert.equal(correctionDecision.kind, 'historical-correction')
  assert.deepEqual(correctionDecision.reasons, ['scoring-input-changed', 'artifact-input-changed'])

  const deletionDecision = classifyRankingChange(previous, buildCanonicalMatchLedger([second], context))
  assert.equal(deletionDecision.kind, 'historical-correction')
  assert.deepEqual(deletionDecision.reasons, ['match-deleted'])

  const moved = { ...first, date: '2026-01-03' }
  const moveDecision = classifyRankingChange(previous, buildCanonicalMatchLedger([moved, second], context))
  assert.equal(moveDecision.kind, 'historical-correction')
  assert.equal(moveDecision.earliestChangedUtcDate, '2026-01-01')
  assert.equal(moveDecision.reasons.includes('match-date-moved'), true)

  const incompatibleContext = { ...context, modelConfigHash: 'config-v2' }
  const invalidation = classifyRankingChange(
    previous,
    buildCanonicalMatchLedger([first, second], incompatibleContext),
    incompatibleContext,
  )
  assert.equal(invalidation.kind, 'full-invalidation')
  assert.equal(invalidation.requiresFullReplay, true)
})

function match(overrides: Partial<MatchRecord>): MatchRecord {
  return {
    id: 'match',
    sourceProvider: 'oracles-elixir',
    sourceGameId: overrides.id ?? 'match',
    date: '2026-01-01',
    season: 2026,
    event: 'LCK 2026',
    phase: 'Regular season',
    region: 'LCK',
    league: 'LCK',
    patch: '26.1',
    bestOf: 1,
    tier: 'regional-regular',
    teamA: 'Alpha',
    teamB: 'Beta',
    winner: 'Alpha',
    teamAKills: 10,
    teamBKills: 5,
    teamAGold: 60_000,
    teamBGold: 55_000,
    ...overrides,
  }
}
