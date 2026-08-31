import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { NormalizedTournamentInstance } from '../src/lib/internationalTournaments'
import type { MatchRecord, PregamePrediction } from '../src/types'

void (async () => {
  const [rootArg, manifestArg, outputArg] = process.argv.slice(2)
  if (!rootArg || !manifestArg || !outputArg) {
    throw new Error('Usage: export-ranking-predictions <root> <manifest> <output>')
  }

  const root = resolve(rootArg)
  const sourceModule = await import(pathToFileURL(`${root}/scripts/ranking-source-import.ts`).href)
  const modelModule = await import(pathToFileURL(`${root}/src/lib/model.ts`).href)
  const tournamentModule = await import(pathToFileURL(`${root}/src/lib/internationalTournaments.ts`).href)
  const matchContextModule = await import(pathToFileURL(`${root}/src/lib/matchContext.ts`).href)
  const source = await sourceModule.importRankingSourceData({ manifestPath: resolve(manifestArg) })
  const matches = source.matches as MatchRecord[]
  const generatedAt = source.manifest?.generatedAt ?? new Date().toISOString()
  const instances = tournamentModule.deriveTournamentInstances({
    matches,
    scheduleReferences: source.tournamentScheduleReferences,
    generatedAt,
  }) as NormalizedTournamentInstance[]
  const lifecycles = new Map(instances.map((instance) => [instance.id, {
    status: instance.status,
    boundaryDate: instance.boundaryDate,
    ratedThroughDate: instance.ratedThroughDate,
    dataLag: instance.dataLag,
    resultCoverageComplete: instance.resultCoverageComplete,
  }]))
  const model = modelModule.buildRankingModel(matches, source.teams, { tournamentLifecycles: lifecycles })
  const predictions = model.predictions as PregamePrediction[]
  const matchById = new Map(matches.map((match) => [match.id, match]))
  const rows = predictions.map((prediction) => {
    const match = matchById.get(prediction.id)
    return {
      id: prediction.id,
      seriesId: prediction.seriesId ?? prediction.source.seriesId ?? prediction.id,
      date: prediction.date,
      actual: prediction.actualWinner === prediction.teamA ? 1 : 0,
      probability: prediction.teamAGameWinProbability,
      segments: prediction.segments,
      leagueA: match ? matchContextModule.homeLeagueForMatch(match, 'A', source.teams) : 'Unknown',
      leagueB: match ? matchContextModule.homeLeagueForMatch(match, 'B', source.teams) : 'Unknown',
    }
  })
  await writeFile(resolve(outputArg), `${JSON.stringify({
    modelVersion: predictions[0]?.modelVersion,
    modelConfigHash: predictions[0]?.modelConfigHash,
    rows,
  })}\n`)
})()
