import { buildRankingModel } from '../../src/lib/model'
import { seededRandom, type EvaluationRow } from '../../src/lib/rankingEvaluation'
import type { MatchRecord, TeamProfile } from '../../src/types'
import { fitHierarchicalLeagues } from './hierarchical-leagues'

export function simulatedLeagueRows(seed = 334462) {
  const random = seededRandom(seed)
  const offsets = new Map([['A', 0], ['B', -.5], ['C', -1.2]])
  const teams = [0, 1, 2, 3, 4].map((index) => ({ index, offset: (2 - index) * .5 }))
  const rows: EvaluationRow[] = []
  const add = (leagueA: string, indexA: number, leagueB: string, indexB: number) => {
    const p = 1 / (1 + Math.exp(offsets.get(leagueB)! + teams[indexB].offset - offsets.get(leagueA)! - teams[indexA].offset))
    rows.push({ id: `simulation-${rows.length}`, seriesId: `simulation-${rows.length}`, eventId: 'simulation', date: '2025-01-01',
      teamA: `${leagueA}${indexA}`, teamB: `${leagueB}${indexB}`, leagueA, leagueB, actual: random() < p ? 1 : 0, probability: p, segments: [] })
  }
  for (const league of offsets.keys()) for (let repeat = 0; repeat < 30; repeat += 1) for (let a = 0; a < 5; a += 1) for (let b = a + 1; b < 5; b += 1) add(league, a, league, b)
  // Only qualified leaders travel. They are not random league-average representatives.
  for (let repeat = 0; repeat < 200; repeat += 1) { add('A', 0, 'B', 0); add('B', 0, 'C', 0); add('A', 0, 'C', 0) }
  return { rows, offsets }
}

export function leagueRecoverySimulation(repetitions = 30) {
  const results = []
  for (let index = 0; index < repetitions; index += 1) {
    const { rows, offsets } = simulatedLeagueRows(334462 + index)
    const fit = fitHierarchicalLeagues(rows, new Map([...offsets.keys()].map((key) => [key, 0])), 'A')
    results.push(...fit.leagues.filter((league) => league.league !== 'A').map((league) => ({
      league: league.league, estimate: league.logitOffset, truth: offsets.get(league.league)!,
      coveredByDiagonalBand: Math.abs(league.logitOffset - offsets.get(league.league)!) <= 1.96 * league.diagonalScale,
    })))
  }
  return { simulations: repetitions, selectedEntrants: 'top domestic team only',
    meanAbsoluteError: results.reduce((sum, row) => sum + Math.abs(row.estimate - row.truth), 0) / results.length,
    diagonalBandCoverage: results.filter((row) => row.coveredByDiagonalBand).length / results.length,
    statisticalIntervalClaim: false, results }
}

export function latentTeamBandSimulation(template: MatchRecord, profile: TeamProfile, repetitions = 100) {
  const random = seededRandom(334462)
  const results = []
  for (let run = 0; run < repetitions; run += 1) {
    const logit = -.8 + 1.6 * random()
    const p = 1 / (1 + Math.exp(-logit))
    const matches = Array.from({ length: 60 }, (_, index): MatchRecord => ({ ...template,
      id: `simulation-${run}-${index}`, sourceMatchId: `simulation-${run}-${index}`, officialMatchId: `simulation-${run}-${index}`,
      date: new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10), season: 2025,
      teamA: 'SimA', teamB: 'SimB', winner: random() < p ? 'SimA' : 'SimB', bestOf: 1,
      event: 'Synthetic domestic season', phase: 'Regular Season', league: profile.league, region: profile.region, tier: 'regional-regular',
      teamAHomeLeague: profile.league, teamBHomeLeague: profile.league, teamARoster: undefined, teamBRoster: undefined,
    }))
    const model = buildRankingModel(matches, { SimA: { ...profile, name: 'SimA' }, SimB: { ...profile, name: 'SimB' } })
    const a = model.standings.find((standing) => standing.team === 'SimA')!
    const b = model.standings.find((standing) => standing.team === 'SimB')!
    const truthDifference = logit * 250 / Math.LN10
    const estimateDifference = a.baseRating - b.baseRating
    const heuristicBand = 1.96 * Math.hypot(a.uncertainty, b.uncertainty)
    results.push({ truthDifference, estimateDifference, covered: Math.abs(truthDifference - estimateDifference) <= heuristicBand })
  }
  return { simulations: repetitions, generatingModel: 'constant-logistic-neutral-team-difference',
    heuristicBandCoverage: results.filter((row) => row.covered).length / results.length,
    statisticalIntervalClaim: false, results }
}
