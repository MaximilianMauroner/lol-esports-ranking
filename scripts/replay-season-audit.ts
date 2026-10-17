import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { importOraclesElixirCsv } from '../src/lib/importers/oraclesElixir.ts'
import { importLeaguepediaSnapshot } from '../src/lib/importers/leaguepedia.ts'
import { mergeCommunityMatchSources } from '../src/lib/importers/communitySources.ts'
import { resolveCanonicalSeries } from '../src/lib/seriesResolver.ts'
import { compareCodeUnits } from '../src/lib/codeUnitOrder.mjs'
import type { MatchRecord } from '../src/types.ts'
import type { PublicMatchHistoryEntry } from '../src/lib/publicArtifacts/schema.ts'

const evidence = '.agents/artifacts/season-2026-audit'
const fixture = JSON.parse(await readFile(`${evidence}/oracle/replay-input.json`, 'utf8'))
const baselineRoot = process.argv[2]
if (!baselineRoot) throw new Error('Pass an unchanged baseline checkout as the first argument')
const baselineModule = (path: string) => import(pathToFileURL(resolve(baselineRoot, path)).href)
const [oracle, leaguepedia, merger, resolver] = await Promise.all([
  baselineModule('src/lib/importers/oraclesElixir.ts'),
  baselineModule('src/lib/importers/leaguepedia.ts'),
  baselineModule('src/lib/importers/communitySources.ts'),
  baselineModule('src/lib/seriesResolver.ts'),
])
const before = merger.mergeCommunityMatchSources({
  oracleMatches: oracle.importOraclesElixirCsv(fixture.oracleCsv).matches,
  leaguepediaMatches: leaguepedia.importLeaguepediaSnapshot(fixture.leaguepedia).matches,
})
const after = mergeCommunityMatchSources({
  oracleMatches: importOraclesElixirCsv(fixture.oracleCsv).matches,
  leaguepediaMatches: importLeaguepediaSnapshot(fixture.leaguepedia).matches,
})
const outcomes = (matches: typeof after) => matches.map((match) => ({
  id: match.id, date: match.date, teamA: match.teamA, teamB: match.teamB, winner: match.winner,
  kills: [match.teamAKills, match.teamBKills], gold: [match.teamAGold, match.teamBGold],
})).sort((a, b) => compareCodeUnits(a.id, b.id))
assert.deepEqual(outcomes(after), outcomes(before))
const published = JSON.parse(await readFile(`${evidence}/public/matches.json`, 'utf8')) as PublicMatchHistoryEntry[]
const publishedMatches: MatchRecord[] = published.map((game) => ({
  id: game.id, sourceProvider: game.source.provider as MatchRecord['sourceProvider'],
  sourceGameId: game.source.gameId, sourceMatchId: game.source.matchId,
  officialMatchId: game.seriesId.startsWith('official-match\u0000') ? game.seriesId.split('\u0000')[1] : undefined,
  date: game.date, datetimeUtc: game.datetimeUtc, season: Number(game.date.slice(0, 4)),
  event: game.event, league: game.league, phase: game.phase, region: game.region,
  patch: game.patch, bestOf: game.bestOf, bestOfBasis: 'provider', gameNumber: game.gameNumber,
  tier: 'regional-regular', teamA: game.teamA.name, teamB: game.teamB.name,
  winner: game.winnerId === game.teamA.id ? game.teamA.name : game.teamB.name,
  teamAKills: 0, teamBKills: 0, teamAGold: 0, teamBGold: 0,
}))
const overnight = publishedMatches.filter((game) => game.date >= '2026-10-15'
  && [game.teamA, game.teamB].includes('FURIA') && [game.teamA, game.teamB].includes('MVK Esports'))
assert.equal(overnight.length, 3)
const priorOvernight = resolver.resolveCanonicalSeries(overnight)
const fixedOvernight = resolveCanonicalSeries(overnight)
assert.equal(priorOvernight.length, 2)
assert.equal(fixedOvernight.length, 1)
assert.deepEqual([fixedOvernight[0].winsA, fixedOvernight[0].winsB], [0, 3])
const summary = {
  description: fixture.description,
  knownDuplicatePairs: fixture.knownDuplicatePairs,
  groups: fixture.groups,
  beforeGames: before.length,
  afterGames: after.length,
  beforeSeries: resolver.resolveCanonicalSeries(before).length,
  afterSeries: resolveCanonicalSeries(after).length,
  publishedGames: publishedMatches.length,
  priorPublishedSeries: resolver.resolveCanonicalSeries(publishedMatches).length,
  fixedPublishedSeries: resolveCanonicalSeries(publishedMatches).length,
  publishedOvernightBefore: priorOvernight.map((series: { winsA: number; winsB: number }) => [series.winsA, series.winsB]),
  publishedOvernightAfter: [fixedOvernight[0].winsA, fixedOvernight[0].winsB],
  gameFactsPreserved: true,
  productionRepairCertified: false,
}
await writeFile(`${evidence}/partial-replay.json`, `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify(summary, null, 2))
