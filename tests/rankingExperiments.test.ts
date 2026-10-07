import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { applySearchValues, readSearchValues, searchParameters, searchTrials, seriesPathLikelihood, seriesScoreLikelihood } from '../scripts/lib/ranking-experiments.ts'
import { boundedStageExpectations } from '../src/lib/placementResiduals.ts'
import { simulatedLeagueRows } from '../scripts/lib/ranking-simulations.ts'
import { fitHierarchicalLeagues } from '../scripts/lib/hierarchical-leagues.ts'
import { ablatedBoardRating } from '../scripts/lib/public-board-ablation.ts'
import { effectiveLeagueRating, leaguePriorFor } from '../src/data/leagueTiers.ts'
import { buildEvaluationData } from '../src/lib/rankingEvaluationData.ts'
import { createRatingReplayContext, materializeRankingModel, replayRatingDates } from '../src/lib/model.ts'
import { sampleMatches, teams } from './fixtures/rankingFixtures.ts'

test('seeded bounded search reproduces each trial and fails closed on edited definitions', async () => {
  const files = new Map(await Promise.all([...new Set(searchParameters.map((parameter) => parameter.file))]
    .map(async (file) => [file, await readFile(file, 'utf8')] as const)))
  const baseline = readSearchValues(files)
  const trials = searchTrials(baseline, 334462, 24)
  assert.deepEqual(trials, searchTrials(baseline, 334462, 24))
  assert.notDeepEqual(trials, searchTrials(baseline, 334463, 24))
  for (const trial of trials) assert.deepEqual(readSearchValues(applySearchValues(files, trial.parameters)), trial.parameters)
  assert.throws(() => applySearchValues(files, { ...baseline, momentumCap: Infinity }))
  const duplicate = new Map(files)
  duplicate.set('src/lib/modelConfig.ts', `${duplicate.get('src/lib/modelConfig.ts')}\nconst momentumCap = 40`)
  assert.throws(() => applySearchValues(duplicate, baseline))
})

test('legal stopping paths form a distribution, ties are symmetric and prefixes remain incomplete', () => {
  for (const bestOf of [1, 2, 3, 5] as const) {
    const paths: Array<Array<0 | 1>> = []
    const visit = (path: Array<0 | 1>) => {
      if (path.length) {
        const score = seriesPathLikelihood(path, path.map(() => .65), bestOf, .7)
        if (score.complete) { paths.push(path); return }
      }
      visit([...path, 0]); visit([...path, 1])
    }
    visit([])
    assert.ok(Math.abs(paths.reduce((total, path) => total + seriesPathLikelihood(path, path.map(() => .65), bestOf, .7).likelihood, 0) - 1) < 1e-12)
  }
  assert.equal(seriesPathLikelihood([1], [.5], 3).complete, false)
  assert.throws(() => seriesPathLikelihood([1, 1, 0], [.5, .5, .5], 3))
  assert.equal(seriesPathLikelihood([1, 0], [.5, .5], 2, .7).gradient, 0)
  assert.ok(seriesPathLikelihood([1, 1], [.6, .4], 3).gradient > 0)
})

test('placement pool expectations cannot exceed champion attainment and preserve feasible mass', () => {
  const weights = [11, 1, 1, 1]
  const old = weights.map((weight) => weight * 24 / 14)
  assert.ok(old[0] > 11)
  const bounded = boundedStageExpectations(weights, 24, 1, 11)
  assert.equal(bounded[0], 11)
  assert.ok(bounded.every((value) => value >= 1 && value <= 11))
  assert.equal(bounded.reduce((a, b) => a + b, 0), 24)
  assert.deepEqual(boundedStageExpectations(weights, 4, 1, 11), [1, 1, 1, 1])
  assert.deepEqual(boundedStageExpectations(weights, 44, 1, 11), [11, 11, 11, 11])
  assert.throws(() => boundedStageExpectations(weights, 45, 1, 11))
  assert.throws(() => boundedStageExpectations(weights, 24.1, 1, 11))
  assert.throws(() => boundedStageExpectations(weights, 24, 1, Number.MAX_SAFE_INTEGER))
})

test('binary-grid placement expectations conserve a fractional allocation when league grouping changes sum order', () => {
  const expected = boundedStageExpectations([4.764705882352941, 1, 3.176470588235294, 5.352941176470588, 1.5882352941176472], 16, 1, 11)
  assert.ok(expected.every((value) => value >= 1 && value <= 11))
  assert.equal(expected.reduce((total, value) => total + value, 0), 16)
  assert.equal((expected[0] + expected[3]) + (expected[1] + expected[2] + expected[4]), 16)
})

test('hierarchy recovers league order from selected entrants and keeps disconnected leagues provisional', () => {
  const { rows } = simulatedLeagueRows()
  for (let index = 0; index < 60; index += 1) rows.push({ ...rows[0], id: `disconnected-${index}`, seriesId: `disconnected-${index}`,
    teamA: 'D0', teamB: 'D1', leagueA: 'D', leagueB: 'D', actual: 1 })
  const fit = fitHierarchicalLeagues(rows, new Map([['A', 0], ['B', 0], ['C', 0], ['D', .7]]), 'A')
  const a = fit.leagues.find((league) => league.league === 'A')!
  const b = fit.leagues.find((league) => league.league === 'B')!
  const c = fit.leagues.find((league) => league.league === 'C')!
  const d = fit.leagues.find((league) => league.league === 'D')!
  assert.ok(a.logitOffset > b.logitOffset && b.logitOffset > c.logitOffset)
  assert.ok(Math.abs(b.logitOffset + .5) < .4)
  assert.ok(d.provisional && !d.connected && d.crossGames === 0)
  assert.equal(d.logitOffset, .7)
  assert.ok(d.diagonalScale > c.diagonalScale)
  // The strongest B entrant can beat a weak A team without making B the stronger league.
  assert.ok(fit.probability('B0', 'B', 'A4', 'A') > .5)
  for (const league of ['A', 'B', 'C']) assert.ok(Math.abs(fit.teams.filter((team) => team.league === league).reduce((sum, team) => sum + team.value, 0)) < 1e-12)
  const sparse = fitHierarchicalLeagues([...rows, { ...rows[0], id: 'one-link', seriesId: 'one-link', teamA: 'D0', teamB: 'A4', leagueA: 'D', leagueB: 'A', actual: 1 }],
    new Map([['A', 0], ['B', 0], ['C', 0], ['D', .7]]), 'A').leagues.find((league) => league.league === 'D')!
  assert.ok(sparse.connected && sparse.provisional && sparse.crossGames === 1)
})

test('warm-up rows train prior state but cannot enter game, control, series or audit denominators', () => {
  const matches = [{ ...sampleMatches[0], date: '2024-12-01' }, { ...sampleMatches[1], date: '2025-01-02' }]
  const context = createRatingReplayContext(matches, { ...teams })
  const state = replayRatingDates({ context, replayMatches: matches })
  const exported = buildEvaluationData(matches, state.predictions, { sourceIdentity: 'fixture', scoreStart: '2025-01-01' })
  assert.equal(exported.rows.length, 1)
  assert.equal(exported.audit.warmupGames, 1)
  assert.equal(exported.audit.normalizedGames, 1)
  assert.ok(Object.values(exported.variants).every((variant) => variant.rows.length === 1))
  assert.ok(exported.seriesExport.rows.every((row) => row.date >= '2025-01-01'))
})

test('public composition matches its prior board and rejects a mismatched score', () => {
  const context = createRatingReplayContext(sampleMatches, { ...teams })
  const state = replayRatingDates({ context, replayMatches: sampleMatches })
  const model = materializeRankingModel({ context, state })
  for (const standing of model.standings) {
    const raw = { teamRating: state.ratings.get(standing.team)!,
      leagueScore: effectiveLeagueRating(standing.league, state.leagueScores.get(standing.league) ?? leaguePriorFor(standing.league), state.leagueMatchCounts.get(standing.league) ?? 0),
      rosterOffset: state.rosterPriorOffsets.get(standing.team) ?? 0, momentum: state.momentums.get(standing.team) ?? 0,
      uncertainty: state.uncertainties.get(standing.team)!, headToHead: 0 }
    assert.ok(Math.abs(ablatedBoardRating(standing, raw, 'current') - standing.rating) < 1e-10)
    assert.throws(() => ablatedBoardRating({ ...standing, rating: standing.rating + 1 }, raw, 'current'))
  }
})

test('evidence reduces heuristic uncertainty; time alone does not create a calibrated inactivity variance', () => {
  const matches = Array.from({ length: 20 }, (_, index) => ({ ...sampleMatches[0],
    id: `uncertainty-${index}`, officialMatchId: `uncertainty-${index}`, season: 2025,
    date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10), bestOf: 1 }))
  const context = createRatingReplayContext(matches, { ...teams })
  const state = replayRatingDates({ context, replayMatches: matches })
  const uncertainty = state.uncertainties.get(matches[0].teamA)!
  assert.ok(uncertainty < state.predictions[0].teamAUncertainty)
  const later = { ...matches[0], id: 'after-inactivity', officialMatchId: 'after-inactivity', date: '2025-12-01' }
  const extended = createRatingReplayContext([...matches, later], { ...teams })
  const resumed = replayRatingDates({ context: extended, state, replayMatches: [later] })
  assert.equal(resumed.predictions.at(-1)!.teamAUncertainty, Math.round(uncertainty))
})

test('score likelihood sums legal paths without treating missing game order as a stop violation', () => {
  assert.ok(Math.abs(seriesScoreLikelihood(2, 1, [.5, .5, .5], 3).likelihood - .25) < 1e-12)
  assert.ok(Math.abs(seriesScoreLikelihood(1, 1, [.5, .5], 2).likelihood - .5) < 1e-12)
  assert.equal(seriesScoreLikelihood(2, 2, [.5, .5, .5, .5], 5).complete, false)
  assert.throws(() => seriesScoreLikelihood(2, 2, [.5, .5, .5, .5], 3))
})
