import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { conditionalResultFromReceipt, isConditionalPowerResultLedger, type ConditionalPowerResultLedger } from '../src/lib/conditionalPowerResultReceipts'
import { createConditionalPowerResultReceipt } from '../src/lib/conditionalPowerResultReceiptBuilder'
import { forecastTournamentSeries } from '../src/lib/tournamentForecast'
import { conditionalPowerResultArtifact, publishConditionalPowerResultOffline, readConditionalPowerResultsOffline } from '../scripts/tournament-forecast-receipts'
import { conditionalPowerReceiptFixture } from './fixtures/conditionalPowerFixtures'

test('producer receipt round-trips through the public schema and contains every legal outcome', () => {
  for (const bestOf of [1, 3, 5] as const) {
    const fixture = conditionalPowerReceiptFixture(bestOf)
    const value: unknown = JSON.parse(JSON.stringify({ version: 1, receipts: [fixture.receipt] }))
    assert.ok(isConditionalPowerResultLedger(value))
    const forecast = forecastTournamentSeries(fixture.series, fixture.forecastBasis)
    if (forecast.status !== 'ready') throw new Error(forecast.detail)
    for (const output of fixture.receipt.outputs) {
      const result = conditionalResultFromReceipt({ series: fixture.series, outcome: output.outcome, now: fixture.now,
        forecast, basis: fixture.forecastBasis, ledger: value })
      assert.equal(result.status, 'partial')
      if (result.status === 'partial') assert.deepEqual(result.teams, output.teams)
    }
    assert.equal(fixture.receipt.outputs.length, bestOf + 1)
  }
})

test('public receipt validation rejects incomplete, duplicate, impossible or inconsistent outcomes', () => {
  const fixture = conditionalPowerReceiptFixture()
  const mutate = [
    (ledger: ConditionalPowerResultLedger) => { ledger.receipts[0]!.outputs.pop() },
    (ledger: ConditionalPowerResultLedger) => { ledger.receipts[0]!.outputs[1] = structuredClone(ledger.receipts[0]!.outputs[0]!) },
    (ledger: ConditionalPowerResultLedger) => { ledger.receipts[0]!.outputs[0]!.outcome.loserWins = 3 },
    (ledger: ConditionalPowerResultLedger) => { ledger.receipts[0]!.outputs[0]!.teams[0]!.delta += 1 },
    (ledger: ConditionalPowerResultLedger) => { ledger.receipts.push(structuredClone(ledger.receipts[0]!)) },
  ]
  for (const change of mutate) {
    const ledger: ConditionalPowerResultLedger = { version: 1, receipts: [structuredClone(fixture.receipt)] }
    change(ledger)
    assert.equal(isConditionalPowerResultLedger(ledger), false)
  }
})

test('generation, event, identity, model and scale changes cannot reuse a numeric receipt', () => {
  const fixture = conditionalPowerReceiptFixture()
  const forecast = forecastTournamentSeries(fixture.series, fixture.forecastBasis)
  if (forecast.status !== 'ready') throw new Error(forecast.detail)
  for (const field of ['snapshotId', 'eventStateVersion', 'identityRevision', 'modelConfigHash', 'ratingDataAsOf'] as const) {
    const receipt = structuredClone(fixture.receipt)
    receipt[field] += '-changed'
    assert.equal(conditionalResultFromReceipt({ series: fixture.series, outcome: fixture.outcome, now: fixture.now,
      forecast, basis: fixture.forecastBasis, ledger: { version: 1, receipts: [receipt] } }).status, 'unavailable')
  }
  const receipt = structuredClone(fixture.receipt)
  receipt.ratingScale.spreadMultiplier += 1
  assert.equal(conditionalResultFromReceipt({ series: fixture.series, outcome: fixture.outcome, now: fixture.now,
    forecast, basis: fixture.forecastBasis, ledger: { version: 1, receipts: [receipt] } }).status, 'unavailable')
  assert.equal(createConditionalPowerResultReceipt({ series: fixture.series, forecastBasis: fixture.forecastBasis,
    replayBasis: null, generatedAt: fixture.generatedAt }).status, 'unavailable')
})

test('offline immutable producer persists only valid receipts and leaves supplied inputs untouched', async () => {
  const fixture = conditionalPowerReceiptFixture()
  const input = { series: fixture.series, forecastBasis: fixture.forecastBasis, replayBasis: fixture.basis, generatedAt: fixture.generatedAt }
  const before = structuredClone(input)
  const root = await mkdtemp(join(tmpdir(), 'conditional-power-component-'))
  try {
    const first = await publishConditionalPowerResultOffline(root, input)
    assert.equal(first.status, 'ready')
    assert.deepEqual(await publishConditionalPowerResultOffline(root, input), first)
    const ledger = await readConditionalPowerResultsOffline(root)
    assert.deepEqual(ledger, { version: 1, receipts: [fixture.receipt] })
    const artifact = conditionalPowerResultArtifact(ledger)
    assert.equal(artifact.relativePath, 'forecasts/power-previews.json')
    assert.deepEqual(JSON.parse(artifact.contents), ledger)
    assert.deepEqual(input, before)
  } finally { await rm(root, { recursive: true, force: true }) }
})
