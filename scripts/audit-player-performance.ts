import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { importOraclesElixirCsv } from '../src/lib/importers/oraclesElixir.ts'
import { sourcePipelineVersion, transparentGprModelMetadata } from '../src/lib/modelConfig.ts'
import { createPlayerPerformanceAccumulator, playerPerformanceMetricKeys, playerPerformancePolicy, recordPlayerPerformance, type PlayerPerformanceAccumulator } from '../src/lib/playerPerformance.ts'
import type { MatchRecord } from '../src/types.ts'

/** Coverage is counted before ranking eligibility, not inferred from header presence. */
export function auditPlayerPerformance(matches: readonly MatchRecord[]) {
  const seen = new Set<string>()
  const groups = new Map<string, { season: number; league: string; games: number; playerRows: number; metrics: PlayerPerformanceAccumulator }>()
  for (const match of matches) {
    if (match.sourceProvider !== 'oracles-elixir') continue
    if (seen.has(match.id)) throw new Error(`Duplicate Oracle game in audit: ${match.id}`)
    seen.add(match.id)
    const key = JSON.stringify([match.season, match.league])
    const group = groups.get(key) ?? { season: match.season, league: match.league ?? 'Unknown', games: 0, playerRows: 0, metrics: createPlayerPerformanceAccumulator() }
    group.games += 1
    for (const roster of [match.teamARoster, match.teamBRoster]) {
      for (const player of roster?.players ?? []) {
        group.playerRows += 1
        recordPlayerPerformance(group.metrics, player.stats)
      }
    }
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => a.season - b.season || a.league.localeCompare(b.league)).map((group) => ({
    season: group.season,
    league: group.league,
    gameCount: group.games,
    playerRows: group.playerRows,
    metrics: Object.fromEntries(playerPerformanceMetricKeys.map((key) => [key, {
      observed: group.metrics[key].games,
      missing: group.playerRows - group.metrics[key].games,
    }])),
  }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = process.argv.slice(2)
  if (!paths.length) throw new Error('Usage: pnpm performance:audit <oracle.csv> [oracle.csv ...]')
  const sources = []
  const matches: MatchRecord[] = []
  for (const path of paths) {
    const fileName = resolve(path)
    const csv = await readFile(fileName, 'utf8')
    const imported = importOraclesElixirCsv(csv, { sourceFileName: fileName })
    matches.push(...imported.matches)
    sources.push({ fileName, sha256: createHash('sha256').update(csv).digest('hex'), importedGames: imported.matches.length })
  }
  console.log(JSON.stringify({
    artifactKind: 'player-performance-coverage-audit',
    generatedAt: new Date().toISOString(),
    population: 'normalized-oracle-roster-rows-before-ranking-eligibility',
    modelVersion: transparentGprModelMetadata.version,
    modelConfigHash: transparentGprModelMetadata.configHash,
    importerVersion: sourcePipelineVersion,
    policy: playerPerformancePolicy,
    sources,
    groups: auditPlayerPerformance(matches),
  }, null, 2))
}
