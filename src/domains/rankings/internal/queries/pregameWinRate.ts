import type { PregamePrediction } from '../../types.ts'

export function pregameWinRateProbabilityFor(prediction: PregamePrediction) {
  const teamAGames = (prediction.teamAPregameWins ?? 0) + (prediction.teamAPregameLosses ?? 0)
  const teamBGames = (prediction.teamBPregameWins ?? 0) + (prediction.teamBPregameLosses ?? 0)
  const teamAWinRate = ((prediction.teamAPregameWins ?? 0) + 1) / (teamAGames + 2)
  const teamBWinRate = ((prediction.teamBPregameWins ?? 0) + 1) / (teamBGames + 2)
  return teamAWinRate + teamBWinRate === 0 ? 0.5 : teamAWinRate / (teamAWinRate + teamBWinRate)
}
