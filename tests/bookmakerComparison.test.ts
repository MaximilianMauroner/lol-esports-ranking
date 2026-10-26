import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { compareBookmakerForecasts, parseBookmakerComparison } from '../tools/calibration/lib/bookmaker-comparison.ts'

const fixture = JSON.parse(await readFile(new URL('./fixtures/bookmakerComparison.json', import.meta.url), 'utf8'))
function evaluate(data = structuredClone(fixture)) {
  return compareBookmakerForecasts(parseBookmakerComparison(data.config, data.forecasts, data.results, data.quotes))
}

test('common cohort keeps all exclusions, maps swapped outcomes, and removes overround', () => {
  const result = evaluate()
  assert.deepEqual(result.counts, { universe: 8, paired: 2, excluded: 6, eventClusters: 1, inputForecasts: 9, inputResults: 8, inputQuotes: 8 })
  assert.deepEqual(result.paired.map(row => row.seriesId), ['paired-away', 'paired-home'])
  assert.equal(result.model.count, result.bookmaker.count)
  assert.equal(result.paired[0].bookmakerProbability, 2 / 3)
  assert.equal(result.paired[0].overround, 0)
  assert.equal(result.paired[0].homeWon, false)
  const data = structuredClone(fixture)
  data.quotes.find((q: { quoteId: string }) => q.quoteId === 'quote-paired-home').outcomes = [{ teamId: 'team-away', decimalOdds: 2.5 }, { teamId: 'team-home', decimalOdds: 1.5 }]
  const row = evaluate(data).paired.find(row => row.seriesId === 'paired-home')!
  assert.ok(Math.abs(row.overround - 1 / 15) < 1e-12)
  assert.ok(Math.abs(row.bookmakerProbability - 0.625) < 1e-12)
  assert.ok(Math.abs(row.modelMinusBookmaker.brier - (0.09 - 0.375 ** 2)) < 1e-12)
  const exclusions = Object.fromEntries(result.denominator.map(row => [row.seriesId, row.reasons]))
  assert.deepEqual(exclusions.duplicate, ['duplicate-series-forecast'])
  assert.deepEqual(exclusions.missing, ['missing-quote'])
  assert.deepEqual(exclusions.incomplete, ['quote-incomplete-odds'])
  for (const sid of ['stale', 'wrong-event', 'future-only']) assert.deepEqual(exclusions[sid], ['no-eligible-quote'])
  assert.ok(result.quoteAudit.find(row => row.seriesId === 'wrong-event')!.reasons.includes('quote-identity-mismatch'))
  assert.ok(result.quoteAudit.find(row => row.seriesId === 'stale')!.reasons.includes('quote-stale'))
  assert.equal(result.calibration.model.reduce((sum, row) => sum + row.count, 0), 2)
  assert.deepEqual(result.eventClusters[0].seriesIds, ['paired-away', 'paired-home'])
  assert.equal(result.freshEvidenceClaim, false)
  assert.equal(result.portfolioProfitClaim, false)
})

test('future odds and outcome order cannot alter the paired scores', () => {
  const before = evaluate()
  const data = structuredClone(fixture)
  const future = data.quotes.find((q: { quoteId: string }) => q.quoteId === 'future-mutation')
  future.outcomes = [{ teamId: 'changed', decimalOdds: null }]
  for (const quote of data.quotes) quote.outcomes.reverse()
  const after = evaluate(data)
  assert.deepEqual(after, before)
})

test('a quote at the cutoff, late observation, or ambiguous revision cannot enter', () => {
  for (const mutation of ['at-cutoff', 'observed-late', 'ambiguous']) {
    const data = structuredClone(fixture)
    const quote = data.quotes.find((q: { quoteId: string }) => q.quoteId === 'quote-paired-home')
    const cutoff = data.config.series[0].decisionCutoff
    if (mutation === 'at-cutoff') quote.quotedAt = quote.observedAt = cutoff
    if (mutation === 'observed-late') quote.observedAt = cutoff + 1
    if (mutation === 'ambiguous') data.quotes.push({ ...quote, quoteId: 'same-time-different-revision', outcomes: [{ teamId: 'team-home', decimalOdds: 2 }, { teamId: 'team-away', decimalOdds: 2 }] })
    const result = evaluate(data)
    assert.equal(result.counts.paired, 1)
    assert.ok(result.denominator.find(row => row.seriesId === 'paired-home')!.reasons.includes(mutation === 'ambiguous' ? 'ambiguous-simultaneous-quotes' : 'no-eligible-quote'))
  }
})

test('latest incomplete quote does not fall back to an older complete quote', () => {
  const data = structuredClone(fixture)
  const quote = data.quotes.find((q: { quoteId: string }) => q.quoteId === 'quote-paired-home')
  data.quotes.push({ ...quote, quoteId: 'latest-incomplete', observedAt: quote.observedAt + 1, outcomes: [] })
  assert.equal(evaluate(data).counts.paired, 1)
})

test('latest known schedule excludes superseded forecasts without using future revisions', () => {
  for (const timing of ['later', 'simultaneous', 'older', 'future']) {
    const data = structuredClone(fixture)
    const quote = data.quotes.find((q: { quoteId: string }) => q.quoteId === 'quote-paired-home')
    const series = data.config.series.find((s: { seriesId: string }) => s.seriesId === 'paired-home')
    const observedAt = timing === 'future' ? series.decisionCutoff : quote.observedAt + (timing === 'later' ? 1 : timing === 'older' ? -1 : 0)
    data.quotes.push({ ...quote, quoteId: 'changed-schedule', scheduleRevision: 'schedule-2', scheduledStartAt: quote.scheduledStartAt + 3600000, quotedAt: Math.min(quote.quotedAt, observedAt), observedAt })
    const row = evaluate(data).denominator.find(row => row.seriesId === 'paired-home')!
    assert.equal(row.included, timing === 'older' || timing === 'future', timing)
    assert.equal(row.reasons.includes('schedule-changed-before-cutoff'), timing === 'later' || timing === 'simultaneous', timing)
  }
})

test('calibration fit must precede freezing and avoid every evaluation series', () => {
  for (const mutation of ['other-evaluation-series', 'late-fit']) {
    const data = structuredClone(fixture)
    data.forecasts[0].calibrationFit = { startsAt: 0, endsAt: mutation === 'late-fit' ? data.config.frozenAt : data.config.frozenAt - 1, seriesIds: [mutation === 'other-evaluation-series' ? 'paired-away' : 'training-series'] }
    assert.ok(evaluate(data).denominator.find(row => row.seriesId === 'paired-home')!.reasons.includes('calibration-overlaps-evaluation'))
  }
})

test('simple Elo receipts require their separate model identity and fixed transform', () => {
  const data = structuredClone(fixture)
  data.config.candidateId = 'simple-elo-v1'
  for (const forecast of data.forecasts) {
    forecast.modelKind = 'simple-elo'
    forecast.candidateId = 'simple-elo-v1'
    forecast.parentCandidateId = null
    forecast.calibrationFit = null
    forecast.calibratorVersion = 'simple-elo-identity-v1'
    forecast.seriesConversionVersion = 'simple-elo-independent-series-v1'
  }
  assert.equal(evaluate(data).counts.paired, 2)
  for (const [key, value] of Object.entries({ modelKind: 'unknown', candidateId: 'disguised-ranking', parentCandidateId: 'ranking-parent', calibratorVersion: 'temperature-v1:game-before-series:T=1', seriesConversionVersion: 'latent-logit-mixture-v1:dependence=0' })) {
    const invalid = structuredClone(data)
    invalid.forecasts[0][key] = value
    assert.throws(() => evaluate(invalid), /modelKind|simple Elo/)
  }
  const reserved = structuredClone(fixture)
  reserved.forecasts[0].candidateId = 'simple-elo-v1'
  assert.throws(() => evaluate(reserved), /Reserved simple Elo/)
})

test('missing results and forecasts remain in the denominator and late results are not scored', () => {
  const data = structuredClone(fixture)
  data.results = data.results.filter((r: { seriesId: string }) => r.seriesId !== 'paired-home')
  data.forecasts = data.forecasts.filter((r: { seriesId: string }) => r.seriesId !== 'paired-home')
  data.results.find((r: { seriesId: string }) => r.seriesId === 'paired-away').resultAvailableAt = data.config.scoringAsOf + 1
  const result = evaluate(data)
  assert.equal(result.counts.universe, 8)
  assert.equal(result.counts.paired, 0)
  assert.equal(result.model.brier, null)
  assert.deepEqual(result.denominator.find(row => row.seriesId === 'paired-home')!.reasons, ['missing-forecast', 'missing-result'])
  assert.deepEqual(result.denominator.find(row => row.seriesId === 'paired-away')!.reasons, ['result-not-available-for-scoring'])
})

test('strict schemas, canonical identities, labels and one-series grouping cannot be bypassed', () => {
  const unknown = structuredClone(fixture)
  unknown.forecasts[0].extra = true
  assert.throws(() => evaluate(unknown), /forecast fields/)
  const duplicate = structuredClone(fixture)
  duplicate.config.series.push(duplicate.config.series[0])
  assert.throws(() => evaluate(duplicate), /Duplicate config series/)
  const labels = structuredClone(fixture)
  labels.forecasts[0].evidenceMode = 'retrospective'
  assert.ok(evaluate(labels).denominator.find(row => row.seriesId === 'paired-home')!.reasons.includes('forecast-evidence-mode-mismatch'))
  const identity = structuredClone(fixture)
  identity.results[0].homeTeamId = 'alias-home'
  identity.results[0].winnerTeamId = 'alias-home'
  assert.ok(evaluate(identity).denominator.find(row => row.seriesId === 'paired-home')!.reasons.includes('result-identity-mismatch'))
  const duplicateResult = structuredClone(fixture)
  duplicateResult.results.push(duplicateResult.results[0])
  assert.ok(evaluate(duplicateResult).denominator.find(row => row.seriesId === 'paired-home')!.reasons.includes('duplicate-series-result'))
})

test('retrospective receipts remain retrospective; prospective receipts must exist at cutoff', () => {
  for (const mode of ['retrospective', 'prospective']) {
    const data = structuredClone(fixture)
    data.config.evidenceMode = mode
    for (const row of [...data.forecasts, ...data.results, ...data.quotes]) row.evidenceMode = mode
    data.forecasts[0].generatedAt = data.config.series[0].decisionCutoff + 1000
    const result = evaluate(data)
    assert.equal(result.evidenceMode, mode)
    assert.equal(result.counts.paired, mode === 'retrospective' ? 2 : 1)
    assert.equal(result.freshEvidenceClaim, false)
  }
})

test('the real CLI hashes the actual bytes, produces stable content, and refuses overwrite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bookmaker-comparison-'))
  try {
    const paths = ['config.json', 'forecasts.jsonl', 'results.json', 'quotes.json'].map(name => join(directory, name))
    const contents = [JSON.stringify(fixture.config), fixture.forecasts.map((row: unknown) => JSON.stringify(row)).join('\n') + '\n', JSON.stringify(fixture.results), JSON.stringify(fixture.quotes)]
    await Promise.all(paths.map((path, i) => writeFile(path, contents[i])))
    const cli = new URL('../tools/calibration/compare-bookmaker-forecasts.ts', import.meta.url).pathname
    const run = (output: string) => execFileSync(process.execPath, ['--import', 'tsx', cli, ...paths, output], { encoding: 'utf8', stdio: 'pipe' })
    const output = join(directory, 'receipt.json')
    const started = Date.now()
    assert.match(run(output), /Compared 2\/8 series \(synthetic\)/)
    const receipt = JSON.parse(await readFile(output, 'utf8'))
    assert.ok(receipt.generatedAt >= started && receipt.generatedAt <= Date.now())
    assert.equal(receipt.inputs.config.sha256, createHash('sha256').update(contents[0]).digest('hex'))
    const nextPath = join(directory, 'again.json')
    run(nextPath)
    const again = JSON.parse(await readFile(nextPath, 'utf8'))
    delete receipt.generatedAt
    delete again.generatedAt
    assert.deepEqual(again, receipt)
    assert.throws(() => run(output), /EEXIST/)
    const mutated = structuredClone(fixture.quotes)
    mutated.find((q: { quoteId: string }) => q.quoteId === 'future-mutation').outcomes[0].decimalOdds = 100
    await writeFile(paths[3], JSON.stringify(mutated))
    const mutationPath = join(directory, 'mutation.json')
    run(mutationPath)
    const mutation = JSON.parse(await readFile(mutationPath, 'utf8'))
    assert.notEqual(mutation.inputs.quotes.sha256, receipt.inputs.quotes.sha256)
    assert.notEqual(mutation.comparisonHash, receipt.comparisonHash)
    assert.deepEqual(mutation.paired, receipt.paired)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
