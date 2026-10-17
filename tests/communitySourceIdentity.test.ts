import assert from 'node:assert/strict'
import test from 'node:test'
import { importOraclesElixirCsv } from '../src/lib/importers/oraclesElixir.ts'
import { importLeaguepediaSnapshot } from '../src/lib/importers/leaguepedia.ts'
import { mergeCommunityMatchSources } from '../src/lib/importers/communitySources.ts'
import { resolveCanonicalSeries } from '../src/lib/seriesResolver.ts'

// Team-row fields from the January 15 Gen.G versus DRX source excerpts.
const oracleCsv = [
  'gameid,date,year,league,split,playoffs,game,patch,position,side,teamname,result,kills,totalgold,gamelength',
  'LOLTMNT03_336244,2026-01-15 08:05:23,2026,LCK,Cup,0,1,16.01,team,Blue,Kiwoom DRX,0,7,52005,1783',
  'LOLTMNT03_336244,2026-01-15 08:05:23,2026,LCK,Cup,0,1,16.01,team,Red,Gen.G,1,16,60101,1783',
  'LOLTMNT03_336246,2026-01-15 08:56:47,2026,LCK,Cup,0,2,16.01,team,Blue,Gen.G,1,34,57965,1469',
  'LOLTMNT03_336246,2026-01-15 08:56:47,2026,LCK,Cup,0,2,16.01,team,Red,Kiwoom DRX,0,5,39238,1469',
].join('\n')

const leaguepediaGames = [
  { id: 'LCK/2026 Season/Cup_Week 1_3_1', date: '2026-01-15', datetimeUtc: '2026-01-15 08:05:00',
    event: 'LCK/2026 Season/Cup', patch: '26.01', teamA: 'DRX', teamB: 'Gen.G', winner: 'Gen.G',
    teamAKills: 7, teamBKills: 16, teamAGold: 52005, teamBGold: 60101 },
  { id: 'LCK/2026 Season/Cup_Week 1_3_2', date: '2026-01-15', datetimeUtc: '2026-01-15 08:56:00',
    event: 'LCK/2026 Season/Cup', patch: '26.01', teamA: 'Gen.G', teamB: 'DRX', winner: 'Gen.G',
    teamAKills: 34, teamBKills: 5, teamAGold: 57965, teamBGold: 39238 },
]

function importedSources(csv = oracleCsv) {
  return {
    oracleMatches: importOraclesElixirCsv(csv).matches,
    leaguepediaMatches: importLeaguepediaSnapshot({ matches: leaguepediaGames }).matches,
  }
}

for (const revised of [false, true]) {
  test(`source excerpts resolve to one 2-0 series with synthetic gold revision ${revised}`, () => {
    const sources = importedSources(revised ? oracleCsv.replace('57965', '57966') : oracleCsv)
    const merged = mergeCommunityMatchSources(sources)
    assert.equal(merged.length, 2)
    assert.ok(merged.every((match) => match.sourceProvider === 'oracles-elixir'))
    assert.deepEqual(merged.map((match) => match.sourceMatchId), leaguepediaGames.map((game) => game.id))
    assert.equal(merged[1].teamAGold, revised ? 57966 : 57965)
    const series = resolveCanonicalSeries(merged)
    assert.equal(series.length, 1)
    assert.equal(series[0].games.length, 2)
    assert.equal(series[0].format, 3)
    assert.equal(series[0].state, 'completed')
    assert.equal(series[0].teamA, 'Gen.G')
    assert.deepEqual([series[0].winsA, series[0].winsB], [2, 0])
  })
}

test('Oracle imports only integer game slots from one through five', () => {
  for (const raw of ['1', '2', '3', '4', '5', '', '0', '6', '1.5', 'NaN']) {
    const csv = oracleCsv.replaceAll(',0,1,16.01,', `,0,${raw},16.01,`)
    const [match] = importOraclesElixirCsv(csv).matches
    assert.equal(match.gameNumber, /^[1-5]$/.test(raw) ? Number(raw) : undefined, raw)
  }
})

test('declared slots require unique candidates in both source directions', () => {
  for (const ambiguousProvider of ['oracle', 'leaguepedia']) {
    const sources = importedSources(oracleCsv.replace('57965', '57966'))
    if (ambiguousProvider === 'oracle') {
      sources.oracleMatches.push(...importOraclesElixirCsv(oracleCsv
        .replaceAll('LOLTMNT03_336246', 'opaque-rematch')
        .replace('57965', '57967')).matches.slice(1))
    } else {
      sources.leaguepediaMatches.push(...importLeaguepediaSnapshot({ matches: [
        { ...leaguepediaGames[1], id: 'LCK/2026 Season/Cup_Rematch_2' },
      ] }).matches)
    }
    const merged = mergeCommunityMatchSources(sources)
    assert.equal(merged.length, 4, ambiguousProvider)
    assert.ok(merged.filter((match) => match.sourceProvider === 'oracles-elixir' && match.sourceGameId !== 'LOLTMNT03_336244')
      .every((match) => match.sourceMatchId === undefined))
  }
})

test('slot links preserve exact-stat reservations in either input order', () => {
  const sources = importedSources()
  const [exact] = importOraclesElixirCsv(oracleCsv.replaceAll('LOLTMNT03_336246', 'opaque-extra')
    .replace('57965', '57966')).matches.slice(1)
  for (const oracleMatches of [[exact, ...sources.oracleMatches], [...sources.oracleMatches, exact]]) {
    for (const leaguepediaMatches of [sources.leaguepediaMatches, [...sources.leaguepediaMatches].reverse()]) {
      const merged = mergeCommunityMatchSources({ oracleMatches, leaguepediaMatches })
      assert.equal(merged.length, 3)
      assert.equal(merged.find((match) => match.sourceGameId === 'LOLTMNT03_336246')?.sourceMatchId, leaguepediaGames[1].id)
      assert.equal(merged.find((match) => match.sourceGameId === 'opaque-extra')?.sourceMatchId, undefined)
    }
  }
})

test('different winners, competitions, missing slots, and distant clocks do not establish slot links', () => {
  for (const mismatch of ['winner', 'competition', 'oracle-slot', 'leaguepedia-slot', 'clock']) {
    const sources = importedSources(oracleCsv.replace('57965', '57966'))
    if (mismatch === 'winner') sources.leaguepediaMatches[1].winner = 'DRX'
    if (mismatch === 'competition') sources.leaguepediaMatches[1].league = 'LPL'
    if (mismatch === 'oracle-slot') sources.oracleMatches[1].gameNumber = undefined
    if (mismatch === 'leaguepedia-slot') sources.leaguepediaMatches[1].sourceGameId = 'opaque-leaguepedia'
    if (mismatch === 'clock') sources.leaguepediaMatches[1].datetimeUtc = '2026-01-15T16:00:00Z'
    const merged = mergeCommunityMatchSources(sources)
    assert.equal(merged.length, 3, mismatch)
    assert.equal(merged.find((match) => match.sourceGameId === 'LOLTMNT03_336246')?.sourceMatchId, undefined, mismatch)
  }
})

test('a result-only row cannot supply a slot-based series identity', () => {
  const sources = importedSources(oracleCsv.replace('57965', '57966'))
  sources.leaguepediaMatches[1] = importLeaguepediaSnapshot({ matches: [{ ...leaguepediaGames[1],
    teamAKills: 0, teamBKills: 0, teamAGold: 0, teamBGold: 0,
  }] }).matches[0]
  const merged = mergeCommunityMatchSources(sources)
  assert.equal(merged.length, 2)
  assert.equal(merged.find((match) => match.sourceGameId === 'LOLTMNT03_336246')?.sourceMatchId, undefined)
})
