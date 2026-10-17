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

function midnightSweep(firstDate: string, nextDate: string, seriesId = '2026Worlds_PlayIn_Round1_1') {
  return importLeaguepediaSnapshot({ matches: [1, 2, 3].map((game) => ({
    id: `${seriesId}_${game}`,
    date: game === 1 ? firstDate : nextDate,
    datetimeUtc: `${game === 1 ? firstDate : nextDate} ${game === 1 ? '23:30' : game === 2 ? '00:30' : '01:30'}:00`,
    event: 'Worlds 2026 Play-In',
    bestOf: 5,
    teamA: game === 2 ? 'MGN Vikings Esports' : 'FURIA',
    teamB: game === 2 ? 'FURIA' : 'MGN Vikings Esports',
    winner: 'MGN Vikings Esports',
    teamAKills: 10 + game,
    teamBKills: 20 + game,
    teamAGold: 50000 + game,
    teamBGold: 60000 + game,
  })) }).matches.map((match) => ({ ...match, sourceMatchId: match.sourceGameId }))
}

for (const [firstDate, nextDate] of [['2026-10-15', '2026-10-16'], ['2026-12-31', '2027-01-01']]) {
  test(`explicit source series remains one 0-3 sweep across ${firstDate} and ${nextDate}`, () => {
    const games = midnightSweep(firstDate, nextDate)
    for (const ordered of [games, [...games].reverse()]) {
      const series = resolveCanonicalSeries(ordered)
      assert.equal(series.length, 1)
      assert.equal(series[0].date, firstDate)
      assert.equal(series[0].teamA, 'FURIA')
      assert.equal(series[0].games.length, 3)
      assert.deepEqual([series[0].winsA, series[0].winsB], [0, 3])
      assert.equal(series[0].state, 'completed')
    }
  })
}

test('distinct explicit series IDs keep rematches and seasons separate', () => {
  const games = [
    ...midnightSweep('2026-10-15', '2026-10-16'),
    ...midnightSweep('2026-10-15', '2026-10-16', '2026Worlds_PlayIn_Round1_2'),
    ...midnightSweep('2025-10-15', '2025-10-16', '2025Worlds_PlayIn_Round1_1'),
  ]
  const series = resolveCanonicalSeries(games)
  assert.equal(series.length, 3)
  assert.ok(series.every((item) => item.games.length === 3 && item.winsA === 0 && item.winsB === 3))
})

test('games without source IDs retain fallback date grouping', () => {
  const games = midnightSweep('2026-10-15', '2026-10-16')
    .map((match) => ({ ...match, sourceMatchId: undefined, sourceGameId: undefined }))
  const series = resolveCanonicalSeries(games)
  assert.deepEqual(series.map((item) => item.date), ['2026-10-15', '2026-10-16'])
  assert.deepEqual(series.map((item) => item.games.length), [1, 2])
})

function mixedOfficialSourceSweep() {
  const gameIds = ['LOLTMNT02_478715', 'LOLTMNT02_478718', 'LOLTMNT02_478726']
  const times = ['2026-10-15T23:00:00Z', '2026-10-16T00:06:03.000Z', '2026-10-16T01:01:24.000Z']
  return midnightSweep('2026-10-15', '2026-10-16', '2026 Season World Championship/Play-In_Round 1_2')
    .map((match, index) => ({
      ...match,
      id: gameIds[index],
      sourceProvider: 'oracles-elixir' as const,
      sourceGameId: gameIds[index],
      datetimeUtc: times[index],
      teamA: 'FURIA',
      teamB: 'MVK Esports',
      winner: 'MVK Esports',
      bestOf: index === 0 ? 5 : 3,
      officialMatchId: index === 0 ? '115660588583040710' : undefined,
    }))
}

test('mixed official and full source series identities resolve the pinned FURIA sweep as one 0-3', () => {
  const games = mixedOfficialSourceSweep()
  const original = structuredClone(games)
  for (const ordered of [games, [...games].reverse()]) {
    const series = resolveCanonicalSeries(ordered)
    assert.equal(series.length, 1)
    assert.equal(series[0].id, 'official-match\u0000115660588583040710')
    assert.equal(series[0].date, '2026-10-15')
    assert.equal(series[0].teamA, 'FURIA')
    assert.equal(series[0].teamB, 'MVK Esports')
    assert.equal(series[0].games.length, 3)
    assert.deepEqual([series[0].winsA, series[0].winsB], [0, 3])
    assert.equal(series[0].format, 5)
    assert.equal(series[0].state, 'completed')
    assert.deepEqual(games, original)
  }
})

test('conflicting official identities do not absorb source-only games or join official matches', () => {
  const games = mixedOfficialSourceSweep()
  games[1].officialMatchId = 'different-official-match'
  for (const ordered of [games, [...games].reverse(), [games[1], games[2], games[0]]]) {
    const series = resolveCanonicalSeries(ordered)
    assert.equal(series.length, 3)
    assert.ok(series.every((item) => item.games.length === 1))
    assert.equal(series.find((item) => item.games[0].id === games[2].id)?.id,
      'source-match\u00002026 Season World Championship/Play-In_Round 1_2\u0000FURIA\u0000MVK Esports')
    assert.equal(games[2].officialMatchId, undefined)
  }
})

test('official identity inheritance stays within the source series and canonical team pair', () => {
  const games = mixedOfficialSourceSweep()
  const otherSeries = { ...games[1], id: 'other-series', sourceMatchId: '2026 Season World Championship/Play-In_Round 1_3_2' }
  const otherTeams = { ...games[2], id: 'other-teams', teamA: 'Gen.G' }
  const series = resolveCanonicalSeries([...games, otherSeries, otherTeams])
  assert.equal(series.length, 3)
  assert.equal(series.find((item) => item.id === 'official-match\u0000115660588583040710')?.games.length, 3)
  assert.ok(series.filter((item) => item.id !== 'official-match\u0000115660588583040710')
    .every((item) => item.games.length === 1 && item.id.startsWith('source-match\u0000')))
})
