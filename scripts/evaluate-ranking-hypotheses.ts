import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createRatingReplayContext, replayRatingDates, materializeRankingModel, makeDisplayRatings, makeDirectHeadToHeadContextAdjustments } from '../src/lib/model'
import { buildEvaluationData, evaluationHomeLeague } from '../src/lib/rankingEvaluationData'
import { compareEvaluationExports, readEvaluationExport, summarizeEvaluation, type EvaluationRow } from '../src/lib/rankingEvaluation'
import { neutralWinProbability } from '../src/lib/winProbability'
import { effectiveLeagueRating, leaguePriorFor } from '../src/data/leagueTiers'
import { transparentGprModelMetadata } from '../src/lib/modelConfig'
import type { MatchRecord, TeamProfile } from '../src/types'
import { importRankingSourceData } from './ranking-source-import'
import { seriesScoreLikelihood } from './lib/ranking-experiments'
import { fitHierarchicalLeagues } from './lib/hierarchical-leagues'
import { resolveCanonicalSeries } from '../src/lib/seriesResolver'
import { ablatedBoardRating, boardLayerNames } from './lib/public-board-ablation'
import { latentTeamBandSimulation, leagueRecoverySimulation } from './lib/ranking-simulations'

const [manifestArg, predictionsArg, outputArg] = process.argv.slice(2)
if (!manifestArg || !predictionsArg || !outputArg) throw new Error('Usage: evaluate-ranking-hypotheses <manifest> <predictions> <output>')
const source = await importRankingSourceData({ manifestPath: resolve(manifestArg) })
const data = readEvaluationExport(JSON.parse(await readFile(predictionsArg, 'utf8')))
const policyHash = createHash('sha256')
for (const file of ['scripts/evaluate-ranking-hypotheses.ts', 'scripts/lib/public-board-ablation.ts', 'scripts/lib/hierarchical-leagues.ts', 'scripts/lib/ranking-simulations.ts']) {
  policyHash.update(file).update(await readFile(file))
}
const policyIdentity = policyHash.digest('hex')
const sourceIdentity = createHash('sha256').update(JSON.stringify(source.matches.filter((match) => match.date >= '2025-01-01').toSorted((a, b) => a.id.localeCompare(b.id)))).digest('hex')
if (data.modelConfigHash !== transparentGprModelMetadata.configHash) throw new Error('Hypothesis model differs from prediction export')
if (sourceIdentity !== data.sourceIdentity) throw new Error('Hypothesis source differs from prediction export')
const rowById = new Map(data.rows.map((row) => [row.id, row]))
const seriesScores = [0, .5, 1].map((dependence) => {
  const scores = resolveCanonicalSeries(source.matches).filter((series) => series.state === 'completed').flatMap((series) => {
    const first = rowById.get(series.games[0].id)
    if (!first) return []
    const outcomes = series.games.map((match): 0 | 1 => match.winner === series.teamA ? 1 : 0)
    const preSeries = first.teamA === series.teamA ? first.probability : 1 - first.probability
    const conditional = series.games.map((match) => {
      const row = rowById.get(match.id)!
      return row.teamA === series.teamA ? row.probability : 1 - row.probability
    })
    return [{ id: series.id, eventId: first.eventId, format: series.format,
      preSeries: seriesScoreLikelihood(series.winsA, series.winsB, outcomes.map(() => preSeries), series.format, dependence),
      conditional: seriesScoreLikelihood(series.winsA, series.winsB, conditional, series.format, dependence) }]
  })
  return { dependence, count: scores.length, scores,
    preSeriesMeanPathLogLoss: scores.reduce((sum, score) => sum + score.preSeries.logLoss, 0) / scores.length,
    conditionalMeanPathLogLoss: scores.reduce((sum, score) => sum + score.conditional.logLoss, 0) / scores.length }
})

const cutoffs = ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30']
const layerNames = boardLayerNames
const boardRows = new Map(layerNames.map((name) => [name, [] as EvaluationRow[]]))
const hierarchyRows = new Map([['tierPriors', [] as EvaluationRow[]], ['flatPriors', [] as EvaluationRow[]], ['weakPriors', [] as EvaluationRow[]]])
const priorBoardRows: EvaluationRow[] = []
const cutReports = []
for (const cutoff of cutoffs) {
  const prior = source.matches.filter((match) => match.date <= cutoff)
  const teams = priorTeams(prior, source.teams)
  const context = createRatingReplayContext(prior, teams)
  const state = replayRatingDates({ context, replayMatches: prior })
  const model = materializeRankingModel({ context, state })
  const preHeadToHead = makeDisplayRatings(state.ratings, teams, state.leagueScores, state.leagueMatchCounts, state.rosterPriorOffsets,
    state.momentums, state.uncertainties, state.wins, state.losses, context.teamRosterBasis)
  const headToHead = makeDirectHeadToHeadContextAdjustments({ displayRatings: preHeadToHead, teams, histories: state.histories,
    uncertainties: state.uncertainties, wins: state.wins, losses: state.losses, teamRosterBasis: context.teamRosterBasis, lastDate: context.lastDate })
  const boardRating = (standing: typeof model.standings[number], layer: typeof layerNames[number]) => ablatedBoardRating(standing, { teamRating: state.ratings.get(standing.team)!,
    leagueScore: effectiveLeagueRating(standing.league, state.leagueScores.get(standing.league) ?? leaguePriorFor(standing.league), state.leagueMatchCounts.get(standing.league) ?? 0),
    rosterOffset: state.rosterPriorOffsets.get(standing.team) ?? 0, momentum: state.momentums.get(standing.team) ?? 0,
    uncertainty: state.uncertainties.get(standing.team)!, headToHead: headToHead.get(standing.team) ?? 0 }, layer)
  const standings = new Map(model.standings.map((standing) => [standing.team, standing]))
  const laterDate = new Date(`${cutoff}T00:00:00Z`)
  laterDate.setUTCDate(laterDate.getUTCDate() + 30)
  const through = laterDate.toISOString().slice(0, 10)
  const forward = data.rows.filter((row) => row.date > cutoff && row.date <= through && standings.has(row.teamA) && standings.has(row.teamB))
  const priorData = buildEvaluationData(prior, model.predictions, { sourceIdentity })
  // One league effect per season. Domestic members define its center.
  const seasonRows = priorData.rows.filter((row) => row.date.slice(0, 4) === cutoff.slice(0, 4))
  const leagues = [...new Set(seasonRows.flatMap((row) => [row.leagueA, row.leagueB]))].filter((league) => league !== 'Unknown')
  const anchor = leagues.includes('LCK') ? 'LCK' : leagues.sort()[0]
  const priors = new Map(leagues.map((league) => [league, (leaguePriorFor(league) - 1500) * Math.LN10 / 400]))
  const fits = [
    { name: 'tierPriors', fit: fitHierarchicalLeagues(seasonRows, priors, anchor) },
    { name: 'flatPriors', fit: fitHierarchicalLeagues(seasonRows, new Map(leagues.map((league) => [league, 0])), anchor) },
    { name: 'weakPriors', fit: fitHierarchicalLeagues(seasonRows, priors, anchor, .5) },
  ]
  for (const row of forward) {
    const a = standings.get(row.teamA)!; const b = standings.get(row.teamB)!
    for (const layer of layerNames) boardRows.get(layer)!.push({ ...row, probability: neutralWinProbability(
      { ...a, rating: boardRating(a, layer) }, { ...b, rating: boardRating(b, layer) }).teamAGameWinProbability })
    if (row.leagueA !== 'Unknown' && row.leagueB !== 'Unknown' && priors.has(row.leagueA) && priors.has(row.leagueB)) {
      priorBoardRows.push({ ...row, probability: neutralWinProbability(a, b).teamAGameWinProbability })
      for (const { name, fit } of fits) hierarchyRows.get(name)!.push({ ...row, probability: fit.probability(row.teamA, row.leagueA, row.teamB, row.leagueB) })
    }
  }
  const ranks = Object.fromEntries(layerNames.map((layer) => {
    const ordered = model.standings.toSorted((a, b) => boardRating(b, layer) - boardRating(a, layer) || a.team.localeCompare(b.team))
    return [layer, ordered.map((standing, index) => ({ team: standing.team, rank: index + 1, score: boardRating(standing, layer) }))]
  }))
  cutReports.push({ cutoff, through, games: forward.length, sourceMembership: 'explicit-prior-match-only', ranks,
    hierarchy: fits.map(({ name, fit }) => ({ name, leagues: fit.leagues, excluded: fit.excluded, uncertaintyPolicy: fit.uncertaintyPolicy })) })
  console.log(`Completed prior board/league cutoff ${cutoff}: ${forward.length} forward games`)
}
const exportRows = (rows: EvaluationRow[], name: string) => ({ ...data, modelVersion: name,
  modelConfigHash: createHash('sha256').update(JSON.stringify({ base: data.modelConfigHash, name, cutoffs, policyIdentity })).digest('hex'), rows })
const current = exportRows(boardRows.get('current')!, 'prior-public-board')
await writeFile(outputArg, `${JSON.stringify({ status: 'exploratory; fixed prior boards; neutral forecasts; no automatic adoption',
  sourceIdentity, provenance: { baseModelVersion: data.modelVersion, baseModelConfigHash: data.modelConfigHash,
    policyIdentity, cutoffs, forwardDays: 30, temporalPolicy: data.temporalPolicy }, seriesScores, cutReports,
  simulations: { hierarchy: leagueRecoverySimulation(), teamBands: latentTeamBandSimulation(source.matches[0], Object.values(source.teams)[0]) },
  board: Object.fromEntries([...boardRows].map(([name, rows]) => [name, { summary: summarizeEvaluation(rows), comparison: compareEvaluationExports(current, exportRows(rows, name)) }])),
  hierarchy: Object.fromEntries([...hierarchyRows].map(([name, rows]) => [name, compareEvaluationExports(exportRows(priorBoardRows, 'prior-public-board'), exportRows(rows, name))])) }, null, 2)}\n`)

function priorTeams(matches: MatchRecord[], profiles: Record<string, TeamProfile>) {
  const result: Record<string, TeamProfile> = {}
  for (const match of matches.toSorted((a, b) => a.date.localeCompare(b.date))) for (const side of ['A', 'B'] as const) {
    const team = side === 'A' ? match.teamA : match.teamB
    result[team] = { name: team, code: profiles[team]?.code ?? team.slice(0, 3), region: side === 'A' ? match.teamARegion ?? match.region : match.teamBRegion ?? match.region,
      league: evaluationHomeLeague(match, side) }
  }
  return result
}
