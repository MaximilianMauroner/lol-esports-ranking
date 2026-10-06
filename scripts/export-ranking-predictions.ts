import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildEvaluationData } from '../src/lib/rankingEvaluationData'

void (async () => {
  const [rootArg, manifestArg, outputArg, scoreStart = '2025-01-01'] = process.argv.slice(2)
  if (!rootArg || !manifestArg || !outputArg) {
    throw new Error('Usage: export-ranking-predictions <root> <manifest> <output>')
  }

  const root = resolve(rootArg)
  const sourceModule: typeof import('./ranking-source-import') = await import(pathToFileURL(`${root}/scripts/ranking-source-import.ts`).href)
  const modelModule: typeof import('../src/lib/model') = await import(pathToFileURL(`${root}/src/lib/model.ts`).href)
  const tournamentModule: typeof import('../src/lib/internationalTournaments') = await import(pathToFileURL(`${root}/src/lib/internationalTournaments.ts`).href)
  const source = await sourceModule.importRankingSourceData({ manifestPath: resolve(manifestArg) })
  const matches = source.matches
  if (!matches.length || source.dataMode === 'no-data' || matches.some((match) => match.sourceProvider === 'seed')) {
    throw new Error('Accuracy export requires real nonempty source data')
  }
  const generatedAt = source.manifest?.generatedAt ?? new Date().toISOString()
  const instances = tournamentModule.deriveTournamentInstances({
    matches,
    scheduleReferences: source.tournamentScheduleReferences,
    generatedAt,
  })
  const lifecycles = new Map(instances.map((instance) => [instance.id, {
    status: instance.status,
    boundaryDate: instance.boundaryDate,
    ratedThroughDate: instance.ratedThroughDate,
    dataLag: instance.dataLag,
    resultCoverageComplete: instance.resultCoverageComplete,
  }]))
  const model = modelModule.buildRankingModel(matches, source.teams, { tournamentLifecycles: lifecycles })
  const scoredMatches = matches.filter((match) => match.date >= scoreStart).toSorted((a, b) => a.id.localeCompare(b.id))
  const sourceIdentity = createHash('sha256').update(JSON.stringify(scoredMatches)).digest('hex')
  const data = buildEvaluationData(matches, model.predictions, { sourceIdentity, scoreStart })
  await writeFile(resolve(outputArg), `${JSON.stringify({ ...data,
    provenance: { trainingSourceIdentity: createHash('sha256').update(JSON.stringify(matches)).digest('hex'),
      manifestIdentity: createHash('sha256').update(await readFile(resolve(manifestArg))).digest('hex'),
      coverage: { start: source.manifest?.start, end: source.manifest?.end },
      importedGames: source.importedMatches.length, ratedGames: matches.length,
      warnings: source.manifest?.warnings ?? [],
      tournamentLifecycles: instances.map((item) => ({ id: item.id, status: item.status, resultCoverageComplete: item.resultCoverageComplete })) } })}\n`)
})()
