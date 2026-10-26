import { seriesWinnerProbability, temperatureProbability } from '../../../src/domains/rankings/forecast.ts'
import type { CalibrationFit, ForecastTransform } from '../../../src/domains/rankings/forecast.ts'
import { seriesScoreLikelihood } from './ranking-experiments.ts'

export type SeriesFitObservation = {
  seriesId: string
  eventId: string
  startsAt: number
  resultAvailableAt: number
  bestOf: 1 | 3 | 5
  winsHome: number
  winsAway: number
  gameProbability: number
}

export function fitSeriesForecast(rows: readonly SeriesFitObservation[], fitBefore: number, grid: {
  temperatures: number[]
  dependences: number[]
  calibrationOrder: ForecastTransform['calibrationOrder']
}, withheldEventIds: readonly string[] = []) {
  if (!rows.length || !Number.isSafeInteger(fitBefore) || !grid.temperatures.length || !grid.dependences.length
    || grid.temperatures.length * grid.dependences.length > 24
    || !grid.temperatures.includes(1) || !grid.dependences.includes(0)
    || !['game-before-series', 'series-after-conversion'].includes(grid.calibrationOrder)) throw new Error('Invalid bounded fit grid')
  if (new Set(rows.map(row => row.seriesId)).size !== rows.length) throw new Error('Duplicate fit series')
  for (const row of rows) {
    if (!row.seriesId || !row.eventId || ![1, 3, 5].includes(row.bestOf)
      || ![row.startsAt, row.resultAvailableAt].every(Number.isSafeInteger)
      || row.startsAt >= row.resultAvailableAt || row.resultAvailableAt >= fitBefore
      || withheldEventIds.includes(row.eventId)) throw new Error('Fit requires earlier, disjoint complete series')
    const score = seriesScoreLikelihood(row.winsHome, row.winsAway, Array<number>(row.winsHome + row.winsAway).fill(row.gameProbability), row.bestOf)
    if (!score.complete) throw new Error('Incomplete series cannot fit dependence')
  }
  const candidates = [...new Set(grid.temperatures)].flatMap(temperature => [...new Set(grid.dependences)].map(dependence => {
    const transform: ForecastTransform = { temperature, dependence, calibrationOrder: grid.calibrationOrder }
    const scores = rows.map(row => {
      const p = grid.calibrationOrder === 'game-before-series' ? temperatureProbability(row.gameProbability, temperature) : row.gameProbability
      const forward = seriesWinnerProbability(Array<number>(row.bestOf).fill(p), row.bestOf, dependence)
      const calibrated = grid.calibrationOrder === 'series-after-conversion' ? temperatureProbability(forward, temperature) : forward
      const winnerProbability = row.winsHome > row.winsAway ? calibrated : 1 - calibrated
      return { winnerLoss: -Math.log(Math.max(1e-15, winnerProbability)),
        scoreLoss: seriesScoreLikelihood(row.winsHome, row.winsAway, Array<number>(row.winsHome + row.winsAway).fill(p), row.bestOf, dependence).logLoss }
    })
    return { transform, meanWinnerLogLoss: scores.reduce((sum, score) => sum + score.winnerLoss, 0) / rows.length,
      meanScoreLogLoss: scores.reduce((sum, score) => sum + score.scoreLoss, 0) / rows.length }
  }))
  const fittedDependences = [...new Set(grid.temperatures)].map(temperature => candidates
    .filter(candidate => candidate.transform.temperature === temperature)
    .sort((a, b) => a.meanScoreLogLoss - b.meanScoreLogLoss || a.transform.dependence - b.transform.dependence)[0])
  fittedDependences.sort((a, b) => a.meanWinnerLogLoss - b.meanWinnerLogLoss
    || Math.abs(a.transform.temperature - 1) - Math.abs(b.transform.temperature - 1))
  const calibrationFit: CalibrationFit = { startsAt: Math.min(...rows.map(row => row.startsAt)), endsAt: Math.max(...rows.map(row => row.resultAvailableAt)), seriesIds: rows.map(row => row.seriesId).sort() }
  return { transform: fittedDependences[0].transform, calibrationFit, candidates, fitBefore,
    selection: 'dependence-score-likelihood-then-temperature-winner-log-loss' as const }
}
