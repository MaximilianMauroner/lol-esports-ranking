import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { importOraclesElixirCsv } from '../scripts/rankings/providers/oraclesElixir.ts'
import { importLeaguepediaSnapshot } from '../scripts/rankings/providers/leaguepedia.ts'
import { importRankingSourceData } from '../scripts/rankings/source-input.ts'
import { mergeCommunityMatchSources } from '../src/domains/rankings/internal/evidence/communitySources.ts'
import { resolveCanonicalSeries } from '../src/domains/rankings/internal/evidence/seriesResolver.ts'
import { createStaticRankingData } from '../src/domains/rankings/internal/projections/snapshot.ts'

const header = 'gameid,date,year,league,split,playoffs,game,patch,position,side,teamname,result,kills,totalgold,gamelength'
function oracleRows(id: string, date: string, season: number, slot: number) {
  return [
    `${id},${date},${season},LCK,Cup,1,${slot},25.24,team,Blue,Gen.G,1,${19 + slot},${59000 + slot * 1000},1500`,
    `${id},${date},${season},LCK,Cup,1,${slot},25.24,team,Red,DRX,0,${4 + slot},${39000 + slot * 1000},1500`,
  ]
}
function cargoGame(slot: number) {
  return {
    id: `LCK/2025 Season/Cup_Finals_1_${slot}`, event: 'LCK/2025 Season/Cup',
    date: slot === 1 ? '2025-12-31' : '2026-01-01',
    datetimeUtc: slot === 1 ? '2025-12-31 23:10:00' : slot === 2 ? '2026-01-01 00:00:00' : '2026-01-01 00:50:00',
    teamA: 'Gen.G', teamB: 'DRX', winner: 'Gen.G', bestOf: 5,
    teamAKills: slot < 3 ? 19 + slot : 0, teamBKills: slot < 3 ? 4 + slot : 0,
    teamAGold: slot < 3 ? 59000 + slot * 1000 : 0, teamBGold: slot < 3 ? 39000 + slot * 1000 : 0,
  }
}

for (const missing of ['oracle', 'cargo'] as const) {
  for (const exactStats of [false, true]) {
    test(`cross-season scoreboard ${exactStats ? 'exact statistics' : 'slot proof'} with missing ${missing} clock`, () => {
      const date = missing === 'oracle' ? '2026-01-15' : '2026-01-15 08:00:00'
      const oracleMatches = importOraclesElixirCsv([header, ...oracleRows('clockless', date, 2027, 1)].join('\n')).matches
      const leaguepediaMatches = importLeaguepediaSnapshot({ matches: [{
        ...cargoGame(1), id: 'LCK/2027 Season/Cup_Week 1_1_1', event: 'LCK/2027 Season/Cup',
        date: '2026-01-15', datetimeUtc: missing === 'cargo' ? undefined : '2026-01-15 08:00:00',
        teamAGold: exactStats ? 60000 : 60001,
      }] }).matches
      const inputs = { oracleMatches, leaguepediaMatches }
      const original = structuredClone(inputs)
      assert.equal(leaguepediaMatches[0].dataCompleteness, 'scoreboard-game-stats')
      const merged = mergeCommunityMatchSources(inputs)
      assert.equal(merged.length, exactStats ? 1 : 2)
      assert.equal(merged.find(({ id }) => id === 'oe-clockless')?.sourceMatchId,
        exactStats ? 'LCK/2027 Season/Cup_Week 1_1_1' : undefined)
      assert.deepEqual(inputs, original)
    })
  }
}

for (const competition of [
  { oracle: 'KeSPA Cup', cargo: '2026 LoL KeSPA Cup', imported: 'KeSPA' },
  { oracle: 'DCGI', cargo: '2026 Demacia Cup Global Invitational', imported: 'DCup' },
]) {
  test(`event-name inference does not establish a new ${competition.oracle} slot identity`, () => {
    const oracleMatches = importOraclesElixirCsv([header,
      ...oracleRows('distinct-label', '2026-01-15 08:00:00', 2026, 1)
        .map((row) => row.replace(',LCK,', `,${competition.oracle},`)),
    ].join('\n')).matches
    const leaguepediaMatches = importLeaguepediaSnapshot({ matches: [{
      ...cargoGame(1), id: `${competition.cargo}_Round 1_1_1`, event: competition.cargo,
      date: '2026-01-15', datetimeUtc: '2026-01-15 08:00:00', teamAGold: 60001,
    }] }).matches
    assert.equal(leaguepediaMatches[0].league, competition.imported)
    const merged = mergeCommunityMatchSources({ oracleMatches, leaguepediaMatches })
    assert.equal(merged.length, 2)
    assert.equal(merged.find(({ id }) => id === 'oe-distinct-label')?.sourceMatchId, undefined)
  })
}

for (const scenario of [
  { name: 'calendar years', years: [2025, 2026], season: 2025 },
  { name: 'past competitive season', years: [2025, 2025], season: 2025 },
  { name: 'next competitive season', years: [2026, 2026], season: 2026 },
  { name: 'future competitive season', years: [2027, 2027], season: 2027 },
]) {
  test(`New Year ${scenario.name} is independent of Oracle file and Cargo row order`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ranking-source-years-'))
    try {
      const paths = [join(dir, 'prior.csv'), join(dir, 'next.csv')]
      await Promise.all(paths.map((path, index) => writeFile(path, [header, ...oracleRows(
        `new-year-${index}`, index === 0 ? '2025-12-31 23:10:00' : '2026-01-01 00:00:00', scenario.years[index], index + 1,
      )].join('\n'))))
      const cargoPath = join(dir, 'cargo.json')
      let canonical: unknown
      for (const reverseCargo of [false, true]) {
        const matches = [1, 2, 3].map(cargoGame)
        await writeFile(cargoPath, JSON.stringify({ matches: reverseCargo ? matches.reverse() : matches }))
        for (const reverseFiles of [false, true]) {
          const data = await importRankingSourceData({ oracleCsvPaths: reverseFiles ? [...paths].reverse() : paths,
            leaguepediaJsonPaths: [cargoPath] })
          assert.equal(data.matches.length, 3)
          assert.ok(data.matches.every((match) => match.date === '2025-12-31' && match.season === scenario.season))
          const series = resolveCanonicalSeries(data.matches)
          assert.equal(series.length, 1)
          assert.deepEqual([series[0].winsA, series[0].winsB, series[0].format, series[0].state], [3, 0, 5, 'completed'])
          const sorted = [...data.matches].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
          canonical ??= sorted
          assert.deepEqual(sorted, canonical)
          const published = createStaticRankingData({ matches: data.matches, teams: data.teams, rosters: {}, generatedAt: '2026-01-02T00:00:00Z' })
          assert.equal(published.snapshots['2025__All__All']?.matchCount ?? 0, scenario.season === 2025 ? 3 : 0)
          assert.equal(published.snapshots['2026__All__All']?.matchCount ?? 0, 0)
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

test('a calendar-aligned series with only a later Oracle game uses its start year', () => {
  const oracleMatches = importOraclesElixirCsv([header, ...oracleRows('late', '2026-01-01 00:00:00', 2026, 2)].join('\n')).matches
  const leaguepediaMatches = importLeaguepediaSnapshot({ matches: [1, 2, 3].map(cargoGame) }).matches
  const merged = mergeCommunityMatchSources({ oracleMatches, leaguepediaMatches })
  assert.equal(merged.length, 3)
  assert.ok(merged.every((match) => match.date === '2025-12-31' && match.season === 2025))
})

for (const nextSeason of [2026, 2027]) test(`conflicting explicit Oracle seasons 2024 and ${nextSeason} are preserved in either row order`, () => {
  const oracleMatches = importOraclesElixirCsv([header,
    ...oracleRows('prior', '2025-12-31 23:10:00', 2024, 1),
    ...oracleRows('next', '2026-01-01 00:00:00', nextSeason, 2),
  ].join('\n')).matches
  const leaguepediaMatches = importLeaguepediaSnapshot({ matches: [1, 2, 3].map(cargoGame) }).matches
  for (const reverse of [false, true]) {
    const merged = mergeCommunityMatchSources({ oracleMatches: reverse ? [...oracleMatches].reverse() : oracleMatches, leaguepediaMatches })
    assert.equal(merged.find(({ id }) => id === 'oe-prior')?.season, 2024)
    assert.equal(merged.find(({ id }) => id === 'oe-next')?.season, nextSeason)
    assert.equal(merged.find(({ sourceProvider }) => sourceProvider === 'leaguepedia-cargo')?.season, 2026)
  }
})
