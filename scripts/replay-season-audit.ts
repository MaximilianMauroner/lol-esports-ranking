import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { importOraclesElixirCsv } from '../src/lib/importers/oraclesElixir.ts'
import { importLeaguepediaSnapshot } from '../src/lib/importers/leaguepedia.ts'
import { mergeCommunityMatchSources } from '../src/lib/importers/communitySources.ts'
import { resolveCanonicalSeries } from '../src/lib/seriesResolver.ts'

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
})).sort((a, b) => a.id.localeCompare(b.id))
assert.deepEqual(outcomes(after), outcomes(before))
const summary = {
  description: fixture.description,
  knownDuplicatePairs: fixture.knownDuplicatePairs,
  groups: fixture.groups,
  beforeGames: before.length,
  afterGames: after.length,
  beforeSeries: resolver.resolveCanonicalSeries(before).length,
  afterSeries: resolveCanonicalSeries(after).length,
  gameFactsPreserved: true,
  productionRepairCertified: false,
}
await writeFile(`${evidence}/partial-replay.json`, `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify(summary, null, 2))
