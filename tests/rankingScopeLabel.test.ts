import assert from 'node:assert/strict'
import test from 'node:test'
import { rankingScopePeriod } from '../src/lib/rankingScopeLabel.ts'
import { publicScoreGapExplanation, estimatePublicMatchup } from '../src/lib/publicMatchup.ts'
import { publishedRatingScale } from '../src/lib/modelConfig.ts'
import type { RankingSummaryStanding } from '../src/lib/snapshot.ts'

test('full-season selection does not end at the last split checkpoint', () => {
  assert.match(rankingScopePeriod('2026'), /Dec 31, 2026/)
  assert.match(rankingScopePeriod('2025'), /Dec 31, 2025/)
  assert.match(rankingScopePeriod('2026', { id: 'split-3', season: '2026', label: 'Split 3', startDate: '2026-07-13', endDate: '2026-09-19', boundaryEvent: 'Latest', description: '' }), /Checkpoint window:.*Sep 19, 2026/)
})

test('probability copy reconciles with comparisons for the same scale and assumptions', () => {
  for (const spreadMultiplier of [1, 3.25]) {
    const model = { version: 'fixture-model', configHash: 'fixture-hash', ratingScale: { ...publishedRatingScale, spreadMultiplier } }
    const home = { team: 'Higher', rating: 1900, uncertainty: 0 } as RankingSummaryStanding
    const away = { team: 'Lower', rating: 1800, uncertainty: 0 } as RankingSummaryStanding
    const expected = Math.round(100 * estimatePublicMatchup(home, away, model).homeGameWinProbability)
    assert.ok(publicScoreGapExplanation(model).includes(`${expected}%`))
    assert.match(publicScoreGapExplanation(model), /single-game.*before uncertainty.*series odds.*fixture-model \/ fixture-hash/)
  }
})

test('calendar scope boundaries do not roll into the previous date west of UTC', () => {
  const original = process.env.TZ
  process.env.TZ = 'America/Los_Angeles'
  try {
    assert.equal(rankingScopePeriod('2026'), 'Season window: Jan 1, 2026 to Dec 31, 2026')
  } finally {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  }
})

test('published model calibration controls examples and game/series estimates', () => {
  const model = {
    version: 'calibrated-fixture', configHash: 'calibration-100',
    ratingScale: { ...publishedRatingScale, spreadMultiplier: 1 },
    parameters: { winProbabilityEloScale: 100, winProbabilityUncertaintyScale: 200, winProbabilityUncertaintyFloor: 0.2 },
  }
  const home = { team: 'Higher', rating: 1900, uncertainty: 0 } as RankingSummaryStanding
  const away = { team: 'Lower', rating: 1800, uncertainty: 0 } as RankingSummaryStanding
  const estimate = estimatePublicMatchup(home, away, model, { bestOf: 3, uncertaintyBands: true })
  assert.equal(estimate.homeGameWinProbability, 0.9091)
  assert.equal(estimate.homeSeriesWinProbability, 0.9767)
  assert.match(publicScoreGapExplanation(model), /91%/)
  const uncertain = estimatePublicMatchup({ ...home, uncertainty: 200 }, away, model, { uncertaintyBands: true })
  assert.equal(uncertain.uncertaintyPenalty, 0.2)
  assert.equal(uncertain.homeGameWinProbability, 0.5818)
  assert.equal(uncertain.uncertaintyBand?.homeGameWinProbability.estimate, 0.5818)
  assert.ok(uncertain.uncertaintyBand!.homeGameWinProbability.lower < uncertain.homeGameWinProbability)
})
