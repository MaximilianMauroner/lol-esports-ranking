import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { importOraclesElixirCsv } from '../scripts/rankings/providers/oraclesElixir.ts'
import { importLeaguepediaSnapshot, type LeaguepediaSnapshot } from '../scripts/rankings/providers/leaguepedia.ts'
import { mergeCommunityMatchSources } from '../src/domains/rankings/internal/evidence/communitySources.ts'
import { resolveCanonicalSeries } from '../src/domains/rankings/internal/evidence/seriesResolver.ts'
import { createMatchHistoryArtifacts, createStaticRankingData, snapshotKey } from '../src/domains/rankings/internal/projections/snapshot.ts'
import type { MatchRecord } from '../src/domains/rankings/types.ts'
import { knownTeamIdentities, resolveCompetitionHomeLeagues } from '../src/domains/rankings/evidence.ts'
import { importLolEsportsScheduleSnapshot } from '../scripts/rankings/providers/lolEsports.ts'

const fixtures = new URL('./fixtures/result-only-series-identity/', import.meta.url)
const read = (name: string) => readFileSync(new URL(name, fixtures), 'utf8')
const oracle = importOraclesElixirCsv(read('physical-oracle.csv'))
const cargo: LeaguepediaSnapshot = JSON.parse(read('case-cargo.json'))
const midnightCargo: LeaguepediaSnapshot = JSON.parse(read('midnight-cargo.json'))
const cargoGames = [...cargo.matches!, ...midnightCargo.matches!]
const cases: Array<{ name: string; date: string; teams: string[]; ids: string[]; wins: number[]; format: number; season: string }> = JSON.parse(read('cases.json'))
const cargoStems = [
  'Demacia Cup 2025_Semifinals_1', 'Demacia Cup 2025_Semifinals_2', 'Demacia Cup 2025_Finals_1',
  'LPL/2026 Season/Split 3_Week 3_7', 'LCP/2026 Season/Split 3_Round 5_1',
  ...cases.slice(5).map(({ name }) => name),
]

test('retained Worlds league aliases join the complete sweep and keep the rematch separate', () => {
  const oracleMatches = importOraclesElixirCsv(read('worlds-oracle.csv')).matches
  const leaguepediaMatches = importLeaguepediaSnapshot(JSON.parse(read('worlds-cargo.json'))).matches
  const references = importLolEsportsScheduleSnapshot(JSON.parse(read('worlds-schedule.json'))).events
  assert.equal(oracleMatches.length, 3)
  assert.equal(references.length, 2)
  assert.ok(oracleMatches.every(({ league }) => league === 'WLDs'))
  assert.ok(leaguepediaMatches.every(({ league }) => league === 'Worlds'))
  for (const withReferences of [false, true]) for (const reverse of [false, true]) {
    const inputs = { oracleMatches: structuredClone(reverse ? [...oracleMatches].reverse() : oracleMatches),
      leaguepediaMatches: structuredClone(reverse ? [...leaguepediaMatches].reverse() : leaguepediaMatches),
      lolEsportsReferences: withReferences ? references : [] }
    const merged = mergeCommunityMatchSources(inputs)
    assert.equal(merged.length, 3)
    const series = resolveCanonicalSeries(merged)
    assert.equal(series.length, 1)
    assert.deepEqual([series[0].date, series[0].teamA, series[0].teamB, series[0].winsA, series[0].winsB, series[0].format, series[0].state],
      ['2026-10-15', 'FURIA', 'MVK Esports', 0, 3, 5, 'completed'])
    for (const match of merged) {
      const original = oracleMatches.find(({ id }) => id === match.id)!
      assert.equal(match.gameCompletedAtUtc, original.gameCompletedAtUtc)
      assert.deepEqual(match.teamARoster, original.teamARoster)
      assert.deepEqual(match.teamBRoster, original.teamBRoster)
      assert.equal(match.winner, original.winner)
      if (withReferences) assert.equal(match.officialMatchId, '115660588583040710')
      else assert.equal(match.datetimeUtc, original.datetimeUtc)
    }
  }
})

function sourcesFor(index: number, swapCargoSides = false) {
  const fixture = cases[index]
  return {
    oracleMatches: oracle.matches.filter((match) => fixture.ids.includes(match.id)),
    leaguepediaMatches: importLeaguepediaSnapshot({ matches: cargoGames
      .filter((game) => String(game.id).replace(/_[1-5]$/, '') === cargoStems[index])
      .map((game) => swapCargoSides ? { ...game, teamA: game.teamB, teamB: game.teamA } : game) }).matches,
  }
}

function retainedFacts(match: MatchRecord) {
  const metadata = new Set(['date', 'season', 'sourceMatchId', 'gameNumber', 'event', 'phase', 'region', 'league', 'tier', 'bestOf', 'bestOfBasis'])
  return Object.fromEntries(Object.entries(match).filter(([key]) => !metadata.has(key)))
}

test('full Oracle excerpts preserve the original team facts and include observed player evidence', () => {
  const excerpt = importOraclesElixirCsv(read('case-oracle.csv')).matches
  for (const original of excerpt) {
    const full = oracle.matches.find(({ id }) => id === original.id)!
    for (const key of ['sourceGameId', 'date', 'season', 'datetimeUtc', 'gameCompletedAtUtc', 'gameNumber',
      'teamA', 'teamB', 'winner', 'teamAKills', 'teamBKills', 'teamAGold', 'teamBGold', 'gameLengthSeconds'] as const) {
      assert.equal(full[key], original[key], `${original.id} ${key}`)
    }
  }
  assert.equal(oracle.matches.length, 21)
  assert.ok(oracle.matches.every((match) => match.teamARoster?.players.length === 5 && match.teamBRoster?.players.length === 5))
})

for (const [index, fixture] of cases.entries()) {
  test(`retained ${fixture.name} resolves to one complete physical series`, () => {
    let canonical: ReturnType<typeof resolveCanonicalSeries> | undefined
    for (const swapSides of [false, true]) {
      const sources = sourcesFor(index, swapSides)
      const original = structuredClone(sources)
      assert.equal(sources.leaguepediaMatches.length, fixture.ids.length)
      assert.ok(sources.leaguepediaMatches.every((match) => match.dataCompleteness === 'match-result-only'))
      for (const reverseOracle of [false, true]) for (const reverseCargo of [false, true]) {
        const merged = mergeCommunityMatchSources({
          oracleMatches: reverseOracle ? [...sources.oracleMatches].reverse() : sources.oracleMatches,
          leaguepediaMatches: reverseCargo ? [...sources.leaguepediaMatches].reverse() : sources.leaguepediaMatches,
        })
        assert.deepEqual(merged.map(({ id }) => id).sort(), fixture.ids)
        for (const match of merged) {
          const originalMatch = [...sources.oracleMatches, ...sources.leaguepediaMatches].find(({ id }) => id === match.id)!
          assert.deepEqual(retainedFacts(match), retainedFacts(originalMatch))
          assert.equal(match.date, fixture.date)
          assert.equal(String(match.season), fixture.season)
        }
        const series = resolveCanonicalSeries(merged)
        assert.equal(series.length, 1)
        assert.deepEqual(series[0].games.map(({ id }) => id).sort(), fixture.ids)
        assert.equal(series[0].date, fixture.date)
        assert.deepEqual([series[0].teamA, series[0].teamB], fixture.teams)
        assert.deepEqual([series[0].winsA, series[0].winsB], fixture.wins)
        assert.equal(series[0].format, fixture.format)
        assert.equal(series[0].state, 'completed')
        if (!swapSides) {
          canonical ??= series
          assert.deepEqual(series, canonical)
        }
        assert.deepEqual(sources, original)
      }
    }
  })
}

test('proven Demacia sweeps share Oracle competition metadata and stay out of bounded year views', () => {
  const prior = importOraclesElixirCsv(read('home-league-oracle.csv'))
  const merged = resolveCompetitionHomeLeagues([
    ...prior.matches, ...cases.flatMap((_, index) => mergeCommunityMatchSources(sourcesFor(index))),
  ])
  const data = createStaticRankingData({ matches: merged, teams: { ...oracle.teams, ...knownTeamIdentities }, rosters: {}, generatedAt: '2026-08-18T00:00:00Z' })
  const history = createMatchHistoryArtifacts(data)
  const demaciaIds = new Set(cases.slice(0, 3).flatMap(({ ids }) => ids))
  const publicDemaciaIds = new Set(merged.filter(({ id }) => demaciaIds.has(id)).map((match) => match.sourceGameId ?? match.id))
  const allKey = snapshotKey({ season: 'All', event: 'All', region: 'All' })
  const allGames = Object.values(history.pages[allKey]).flatMap(({ matches }) => matches)
  assert.equal(allGames.filter(({ id }) => publicDemaciaIds.has(id)).length, 9)
  for (const [index, fixture] of cases.slice(0, 3).entries()) {
    const reference = sourcesFor(index).oracleMatches[0]
    const series = resolveCanonicalSeries(merged.filter(({ id }) => fixture.ids.includes(id)))
    assert.equal(series.length, 1)
    assert.deepEqual([series[0].winsA, series[0].winsB, series[0].format, series[0].state], [3, 0, 5, 'completed'])
    const publicIds = new Set(series[0].games.map((match) => match.sourceGameId ?? match.id))
    const entries = allGames.filter(({ id }) => publicIds.has(id))
    assert.equal(entries.length, 3)
    assert.equal(new Set(entries.map(({ seriesId }) => seriesId)).size, 1)
    assert.ok(entries.every((entry) => entry.bestOf === 5 && entry.seriesState === 'completed'))
    const final = entries.find(({ gameNumber }) => gameNumber === 3)!
    assert.deepEqual([final.seriesWinsA, final.seriesWinsB], [3, 0])
    for (const game of series[0].games) {
      for (const key of ['season', 'event', 'league', 'region', 'tier'] as const) assert.equal(game[key], reference[key])
    }
  }
  for (const year of ['2025', '2026']) {
    const key = snapshotKey({ season: year, event: 'All', region: 'All' })
    const games = Object.values(history.pages[key] ?? {}).flatMap(({ matches }) => matches)
    assert.ok(games.every(({ id }) => !publicDemaciaIds.has(id)))
  }
  assert.equal(data.snapshots[snapshotKey({ season: '2026', event: 'All', region: 'All' })].matchCount, 19)
  assert.deepEqual(data.filterOptions.seasons, ['All', '2026', '2025'])
})
