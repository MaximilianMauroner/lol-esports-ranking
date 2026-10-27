import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TeamHistoryArtifactState } from '../src/browser/rankings/usePublicArtifacts.ts'
import { mergeCommunityMatchSources } from '../src/domains/rankings/internal/evidence/communitySources.ts'
import { seriesRatingChange } from '../src/views/matches/seriesOutcome.ts'
import { resolveCanonicalSeries } from '../src/domains/rankings/internal/evidence/seriesResolver.ts'
import { createMatchHistoryArtifacts, createStaticRankingData, createStaticRankingSummaryData, createTeamHistory, createTeamHistoryArtifacts, teamStandingKey } from '../src/domains/rankings/internal/projections/snapshot.ts'
import { recordedSeriesForecastLookup } from '../src/domains/rankings/internal/published/recordedSeriesForecast.ts'
import { parsePublicMatchHistoryPage, parsePublicRankingShard, parsePublicTeamHistoryShard } from '../src/domains/rankings/internal/published/schema.ts'
import { deriveUpsetHeadline } from '../src/domains/rankings/internal/queries/rankingFlair.ts'
import { buildRankingModel } from '../src/domains/rankings/internal/replay/model.ts'
import type { MatchRecord, MatchRosterSnapshot, PregamePrediction, PublicRecentMatch, Role, StaticRankingData, TeamHistorySeries, TeamProfile } from '../src/domains/rankings/types.ts'
import { SeriesTable } from '../src/views/matches/SeriesLedger.tsx'
import { RecentMatches } from '../src/views/rankings/RecentMatches.tsx'
import { chartPointFromHistoryPoint } from '../src/views/rankings/teamHistoryChart.ts'

const teams: Record<string, TeamProfile> = {
  Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
  Beta: { name: 'Beta', code: 'BET', region: 'LCK', league: 'LCK' },
}
const targetDate = '2026-01-10'

function roster(prefix: string, won: boolean, observedAt: string): MatchRosterSnapshot {
  return {
    sourceProvider: 'oracles-elixir', teamId: prefix, observedAt, completeness: 'complete-five-role',
    players: (['Top', 'Jungle', 'Mid', 'Bot', 'Support'] as Role[]).map(role => ({
      id: `${prefix}-${role}`, name: `${prefix} ${role}`, role,
      stats: { side: prefix === 'beta' ? 'red' : 'blue', won, kills: won ? 6 : 1, deaths: won ? 1 : 6,
        assists: won ? 9 : 2, damageShare: 0.2, earnedGoldShare: 0.2, vspm: 1 },
    })),
  }
}

function game(id: string, date: string, winner = 'Alpha', alpha = 'main'): MatchRecord {
  const won = winner === 'Alpha'
  return {
    id, sourceProvider: 'oracles-elixir', sourceGameId: id, dataCompleteness: 'scoreboard-game-stats',
    date, datetimeUtc: `${date}T10:00:00Z`, gameCompletedAtUtc: `${date}T11:00:00Z`, season: 2026,
    event: 'LCK 2026 Cup', phase: 'Groups', region: 'LCK', league: 'LCK', patch: '26.1', bestOf: 1, tier: 'regional-regular',
    teamA: 'Alpha', teamB: 'Beta', teamASide: 'blue', teamBSide: 'red', winner,
    teamAKills: won ? 25 : 5, teamBKills: won ? 5 : 25, teamAGold: won ? 62000 : 54000, teamBGold: won ? 54000 : 62000,
    teamARoster: roster(alpha, won, date), teamBRoster: roster('beta', !won, date),
  }
}

function fixture({ crossMidnight = false, betaWins = false } = {}) {
  const history = ['02', '04', '06', '08'].map((day, index) => game(`h${index + 1}`, `2026-01-${day}`, 'Alpha', index === 3 ? 'academy' : 'main'))
  const games = [1, 2].map(number => ({
    ...game(`public-${number}`, targetDate, betaWins || number === 2 ? 'Beta' : 'Alpha'),
    sourceMatchId: 'public-series', gameNumber: number, bestOf: 2,
    datetimeUtc: number === 2 && crossMidnight ? '2026-01-11T00:10:00Z' : `${targetDate}T${8 + number * 2}:00:00Z`,
    gameCompletedAtUtc: number === 2 && crossMidnight ? '2026-01-11T01:10:00Z' : `${targetDate}T${9 + number * 2}:00:00Z`,
  }))
  return createStaticRankingData({ matches: [...history, ...games], teams, rosters: {}, generatedAt: '2026-01-12T00:00:00Z' })
}

function outputs(data: StaticRankingData, team = 'Alpha') {
  const snapshot = parsePublicRankingShard(createStaticRankingSummaryData(data).snapshots[data.defaultSnapshotKey])
  const standing = snapshot.standings.find(standing => standing.team === team)!
  const shard = parsePublicTeamHistoryShard(createTeamHistoryArtifacts(data).shards[data.defaultSnapshotKey])
  const series = shard.series[teamStandingKey(standing)]!
  const canonical = resolveCanonicalSeries(data.matches).find(series => series.games.some(game => game.id === 'public-1'))!
  const match = standing.recentMatches.find(match => match.seriesId === canonical.id)!
  const point = series.points.find(point => point[3]?.opponent === (team === 'Alpha' ? 'Beta' : 'Alpha') && point[3]?.bestOf === 2)!
  return { snapshot, standing, series, match, point }
}

function firstPrediction(data: StaticRankingData) {
  return data.replayEvidence.predictions.find(prediction => prediction.id === 'public-1')!
}

function render(matches: PublicRecentMatch[], series?: TeamHistorySeries, historyState: TeamHistoryArtifactState = { status: 'loading' }) {
  return renderToStaticMarkup(createElement(RecentMatches, { matches, series, standings: [], historyState }))
}

test('public summary and both history producers use the recorded Bo2 win value and preserve the result ledger', () => {
  const data = fixture()
  const before = structuredClone(data)
  const prediction = firstPrediction(data)
  const { standing, series, match, point } = outputs(data)
  assert.equal(prediction.teamASeriesWinProbability, 0.4099)
  assert.equal(prediction.teamAExpectedSeriesPoints, 0.6402)
  assert.equal(match.expectedWinProbability, 0.4099)
  assert.equal(point[3]?.model?.e, match.expectedWinProbability)
  assert.deepEqual(point[3]?.model?.forecastSource, match.forecastSource)
  assert.equal(match.forecastSource?.predictionId, prediction.id)
  assert.equal(match.forecastSource?.basis, 'latest-corrected-prior-replay')
  assert.equal(chartPointFromHistoryPoint(point).detail?.model?.expectedWinProbability, 0.4099)
  assert.equal(chartPointFromHistoryPoint(point).detail?.model?.residual, undefined)
  assert.equal(createTeamHistory(data).series[teamStandingKey(standing)]?.points.at(-1)?.[3]?.model?.e, 0.4099)
  assert.equal(match.matchImpact, point[3]?.delta)
  assert.match(render([match]), /Replay win 41%/)
  assert.match(render([match], { ...series, points: [point] }), /Replay win 41%/)
  assert.match(render([match]), /from earlier match dates/)
  assert.doesNotMatch(render([match]), /Pregame expected|predictionId|latest-corrected/)
  assert.deepEqual(data, before)
})

test('team B uses its recorded Bo2 win probability without complementing A', () => {
  const data = fixture()
  const prediction = firstPrediction(data)
  const { match, point } = outputs(data, 'Beta')
  assert.notEqual(prediction.teamBSeriesWinProbability, 1 - prediction.teamASeriesWinProbability)
  assert.equal(match.expectedWinProbability, prediction.teamBSeriesWinProbability)
  assert.equal(point[3]?.model?.e, prediction.teamBSeriesWinProbability)
})

test('the canonical first game wins over array order, later predictions and a cross-midnight final', () => {
  const data = fixture({ crossMidnight: true })
  const first = firstPrediction(data)
  const later = data.replayEvidence.predictions.find(prediction => prediction.id === 'public-2')!
  later.teamASeriesWinProbability = 0.97
  later.teamBSeriesWinProbability = 0.02
  data.matches.reverse()
  data.replayEvidence.predictions.reverse()
  const { match, point } = outputs(data)
  assert.equal(match.games, 2)
  assert.equal(match.date, targetDate)
  const rawFinal = data.matches.find(game => game.id === 'public-2')!
  rawFinal.date = '2026-01-11'
  assert.equal(outputs(data).match.expectedWinProbability, first.teamASeriesWinProbability)
  assert.equal(match.expectedWinProbability, first.teamASeriesWinProbability)
  assert.equal(point[3]?.model?.e, first.teamASeriesWinProbability)
  assert.equal(point[3]?.model?.forecastSource?.predictionId, first.id)
})

const invalidAuthority: Record<string, (predictions: PregamePrediction[]) => PregamePrediction[]> = {
  'missing first game': predictions => predictions.filter(prediction => prediction.id !== 'public-1'),
  'duplicate first game': predictions => [...predictions, { ...predictions.find(prediction => prediction.id === 'public-1')! }],
  'wrong series': predictions => predictions.map(prediction => prediction.id === 'public-1' ? { ...prediction, seriesId: 'other-series' } : prediction),
  'missing series': predictions => predictions.map(prediction => prediction.id === 'public-1' ? { ...prediction, seriesId: undefined } : prediction),
  'wrong team': predictions => predictions.map(prediction => prediction.id === 'public-1' ? { ...prediction, teamA: 'Gamma' } : prediction),
  'ambiguous team': predictions => predictions.map(prediction => prediction.id === 'public-1' ? { ...prediction, teamA: prediction.teamB } : prediction),
  'invalid probability': predictions => predictions.map(prediction => prediction.id === 'public-1' ? { ...prediction, teamASeriesWinProbability: NaN } : prediction),
}

for (const [name, change] of Object.entries(invalidAuthority)) {
  test(`${name} omits public forecasts without residual fallback`, () => {
    const data = fixture()
    const expectedImpact = outputs(data).match.matchImpact
    const unchanged = structuredClone(data.snapshots)
    data.replayEvidence.predictions = change(data.replayEvidence.predictions)
    const { match, point } = outputs(data)
    assert.equal(match.expectedWinProbability, undefined)
    assert.equal(match.forecastSource, undefined)
    assert.equal(point[3]?.model?.e, undefined)
    assert.equal(point[3]?.model?.forecastSource, undefined)
    assert.equal(chartPointFromHistoryPoint(point).detail?.model?.expectedWinProbability, undefined)
    assert.equal(match.matchImpact, expectedImpact)
    assert.deepEqual(data.snapshots, unchanged)
    assert.doesNotMatch(render([match]), /Replay win|>Upset<|>Miss</)
  })
}

test('lookup checks exact team and opponent identity and accepts reversed prediction orientation', () => {
  const data = fixture()
  const prediction = firstPrediction(data)
  const lookup = recordedSeriesForecastLookup(data.matches, data.replayEvidence.predictions)
  assert.equal(lookup(prediction.seriesId, 'Alpha', 'Gamma'), undefined)
  assert.equal(lookup(undefined, 'Alpha', 'Beta'), undefined)
  assert.equal(lookup('unknown', 'Alpha', 'Beta'), undefined)
  const swapped = data.replayEvidence.predictions.map(value => value.id === prediction.id ? {
    ...value, teamA: value.teamB, teamB: value.teamA,
    teamASeriesWinProbability: value.teamBSeriesWinProbability, teamBSeriesWinProbability: value.teamASeriesWinProbability,
  } : value)
  data.replayEvidence.predictions = swapped
  assert.equal(outputs(data).match.expectedWinProbability, prediction.teamASeriesWinProbability)
})

for (const status of ['loading', 'missing'] as const) {
  test(`unmarked legacy summary is hidden while history is ${status}`, () => {
    const { match } = outputs(fixture())
    const legacy = { ...match, result: 'W' as const, expectedWinProbability: 0.1, forecastSource: undefined }
    const state: TeamHistoryArtifactState = status === 'loading' ? { status } : { status, message: 'History unavailable.' }
    const markup = render([legacy], undefined, state)
    assert.doesNotMatch(markup, /Replay win|>Upset<|>Miss</)
    assert.match(markup, /Recorded match impact/)
    assert.match(render([match], undefined, state), /Replay win 41%/)
  })
}

test('equal-count loaded history requires its own provenance and cannot borrow summary authority', () => {
  const { match, point, series } = outputs(fixture())
  const legacy = structuredClone(point)
  legacy[3]!.model!.forecastSource = undefined
  legacy[3]!.model!.e = 0.1
  legacy[3]!.result = 'W'
  const markup = render([match], { ...series, points: [legacy] })
  assert.doesNotMatch(markup, /Replay win|>Upset<|>Miss</)
  const chart = chartPointFromHistoryPoint(legacy)
  assert.equal(chart.detail?.model?.expectedWinProbability, undefined)
  assert.equal(chart.detail?.model?.residual, undefined)
  legacy[3]!.model!.r = 0.123
  assert.equal(chartPointFromHistoryPoint(legacy).detail?.model?.residual, 0.123)
})

test('old public artifacts keep unmarked values readable without granting forecast evidence', () => {
  const data = fixture()
  const { snapshot, standing, match, series, point } = outputs(data)
  match.forecastSource = undefined
  point[3]!.model!.forecastSource = undefined
  assert.equal(parsePublicRankingShard(snapshot).standings.find(value => value.team === standing.team)?.recentMatches.at(-1)?.expectedWinProbability, 0.4099)
  assert.equal(series.points.at(-1)?.[3]?.model?.e, 0.4099)
  assert.doesNotMatch(render([match]), /Replay win/)
  const shard = createTeamHistoryArtifacts(data).shards[data.defaultSnapshotKey]
  for (const value of Object.values(shard.series)) {
    for (const point of value.points) {
      if (point[3]?.model) point[3].model.forecastSource = undefined
    }
  }
  assert.equal(parsePublicTeamHistoryShard(shard).series[teamStandingKey(standing)]?.points.at(-1)?.[3]?.model?.e, 0.4099)
})

test('public readers reject malformed forecast provenance while retaining unmarked legacy fields', () => {
  for (const source of [
    { basis: 'latest-corrected-prior-replay', predictionId: '' },
    { basis: 'result-residual', predictionId: 'public-1' },
  ]) {
    const { snapshot, match } = outputs(fixture())
    Object.assign(match, { forecastSource: source })
    assert.throws(() => parsePublicRankingShard(snapshot), /forecastSource/)
    const data = fixture()
    const shard = createTeamHistoryArtifacts(data).shards[data.defaultSnapshotKey]
    const point = Object.values(shard.series)[0]!.points.at(-1)!
    Object.assign(point[3]!.model!, { forecastSource: source })
    assert.throws(() => parsePublicTeamHistoryShard(shard), /forecastSource/)
  }
})

test('rolling upset assembly and headline use recorded Bo2 B probability and reject legacy candidates', () => {
  const data = fixture({ betaWins: true })
  const { snapshot, standing } = outputs(data, 'Beta')
  const candidate = standing.rollingMovement?.biggestUpsetWin
  assert.ok(candidate)
  assert.equal(candidate.forecastSource?.predictionId, 'public-1')
  assert.equal(candidate.expectedWinProbability, firstPrediction(data).teamBSeriesWinProbability)
  const headline = deriveUpsetHeadline(snapshot.standings, snapshot.rollingWindow)
  assert.equal(headline?.winner, 'Beta')
  assert.match(headline?.headline ?? '', /replay win estimate/)
  assert.doesNotMatch(headline?.headline ?? '', /pre-match/)
  assert.equal(headline?.expectedWinProbability, candidate.expectedWinProbability)
  for (const value of snapshot.standings) {
    const upset = value.rollingMovement?.biggestUpsetWin
    if (upset) upset.forecastSource = undefined
  }
  assert.equal(deriveUpsetHeadline(snapshot.standings, snapshot.rollingWindow), null)
})

test('rolling assembly skips a win without canonical forecast authority', () => {
  const matches = fixture({ betaWins: true }).matches
  const ranking = buildRankingModel(matches, teams)
  ranking.predictions.find(prediction => prediction.id === 'public-1')!.seriesId = undefined
  const data = createStaticRankingData({ matches, teams, rosters: {}, precomputedGlobalRanking: ranking })
  const { snapshot, standing, match } = outputs(data, 'Beta')
  assert.equal(match.expectedWinProbability, undefined)
  assert.equal(standing.rollingMovement?.biggestUpsetWin, undefined)
  assert.equal(deriveUpsetHeadline(snapshot.standings, snapshot.rollingWindow), null)
})

test('ambiguous recorded prediction IDs block public assembly', () => {
  const matches = fixture({ betaWins: true }).matches
  const ranking = buildRankingModel(matches, teams)
  ranking.predictions.push({ ...ranking.predictions.find(prediction => prediction.id === 'public-1')! })
  assert.throws(() => createStaticRankingData({ matches, teams, rosters: {}, precomputedGlobalRanking: ranking }), /Duplicate prediction identities/)
})

test('tournament movement receives recorded replay prediction authority', () => {
  const matches = fixture().matches.map(match => match.id.startsWith('public-')
    ? { ...match, event: 'MSI 2026', league: 'MSI', region: 'International' as const, tier: 'msi-bracket' as const } : match)
  const data = createStaticRankingData({ matches, teams, rosters: {}, generatedAt: '2026-01-12T00:00:00Z' })
  const tournament = Object.values(data.tournamentMovements)[0]!
  assert.ok(tournament)
  for (const team of tournament.teams) {
    const point = team.points.find(point => point[3]?.bestOf === 2)
    assert.ok(point)
    const prediction = firstPrediction(data)
    assert.equal(point[3]?.model?.forecastSource?.predictionId, prediction.id)
    assert.equal(point[3]?.model?.e, team.team === 'Alpha' ? prediction.teamASeriesWinProbability : prediction.teamBSeriesWinProbability)
  }
})

test('canonical series identity remains the forecast join when events and opponents repeat', () => {
  const data = fixture()
  const series = resolveCanonicalSeries(data.matches).find(series => series.games[0]?.id === 'public-1')!
  assert.equal(outputs(data).match.seriesId, series.id)
  const prior = data.replayEvidence.predictions.find(prediction => prediction.id === 'h4')!
  prior.teamASeriesWinProbability = 0.99
  assert.equal(outputs(data).match.forecastSource?.predictionId, 'public-1')
  assert.equal(outputs(data).match.expectedWinProbability, 0.4099)
})

test('source ingestion normalizes a raw cross-midnight series before public assembly', () => {
  const raw = fixture({ crossMidnight: true }).matches.map(match => match.id === 'public-2'
    ? { ...match, date: '2026-01-11' } : match)
  const matches = mergeCommunityMatchSources({ oracleMatches: raw, leaguepediaMatches: [] })
  const data = createStaticRankingData({ matches, teams, rosters: {}, generatedAt: '2026-01-12T00:00:00Z' })
  const { match, point } = outputs(data)
  assert.equal(match.games, 2)
  assert.equal(match.result, 'T')
  assert.equal(data.matches.find(game => game.id === 'public-2')?.date, targetDate)
  assert.equal(match.forecastSource?.predictionId, 'public-1')
  assert.equal(point[3]?.model?.e, match.expectedWinProbability)
})

test('the match archive uses recorded probabilities for both Bo2 sides and hides unmarked legacy values', () => {
  const data = fixture({ betaWins: true })
  const pages = createMatchHistoryArtifacts(data).pages[data.defaultSnapshotKey]
  const match = Object.values(pages).flatMap(page => page.matches).find(match => match.id === 'public-2')!
  const prediction = firstPrediction(data)
  assert.equal(match.impact.expectedTeamA, prediction.teamASeriesWinProbability)
  assert.equal(match.impact.expectedTeamB, prediction.teamBSeriesWinProbability)
  assert.equal(match.impact.forecastSource?.predictionId, prediction.id)
  const page = Object.values(pages).find(page => page.matches.some(value => value.id === match.id))!
  assert.doesNotThrow(() => parsePublicMatchHistoryPage(page))
  const markup = renderToStaticMarkup(createElement(SeriesTable, {
    series: [{ id: match.seriesId, summary: match, games: [match] }], expanded: new Set<string>(), onToggle: () => {}, publication: 'test',
  }))
  assert.match(markup, /13% replay win/)
  assert.doesNotMatch(markup, /pre-match/)
  const change = seriesRatingChange(match)
  assert.equal(change.kind, 'applied')
  if (change.kind !== 'applied') return
  assert.equal(change.chanceSide, 'B')
  assert.equal(change.chance, prediction.teamBSeriesWinProbability)
  assert.equal(change.upset, true)
  const legacy = { ...match, impact: { ...match.impact, forecastSource: undefined } }
  const legacyChange = seriesRatingChange(legacy)
  assert.equal(legacyChange.kind, 'applied')
  assert.equal(legacyChange.kind === 'applied' ? legacyChange.chance : undefined, undefined)
  assert.equal(legacyChange.kind === 'applied' && legacyChange.upset, false)
  const legacyPage = structuredClone(page)
  const legacyEntry = legacyPage.matches.find(value => value.id === match.id)!
  legacyEntry.impact.forecastSource = undefined
  legacyEntry.impact.expectedTeamA = -0.14
  assert.doesNotThrow(() => parsePublicMatchHistoryPage(legacyPage))
})

function scopeAuthorityFixture(tournament = false) {
  const matches = [
    game('scope-h1', '2026-01-02'), game('scope-h2', '2026-01-04'), game('scope-h3', '2026-01-06'),
    ...['07', '08'].map(day => ({ ...game(`off-calendar-${day}`, `2026-01-${day}`), season: 2025, event: 'LCK 2025 Season' })),
    { ...game('scope-target', targetDate, 'Beta'), ...(tournament ? { event: 'MSI 2026', league: 'MSI', region: 'International' as const, tier: 'msi-bracket' as const } : {}) },
  ].map(match => ({ ...match, teamARoster: undefined, teamBRoster: undefined }))
  const data = createStaticRankingData({ matches, teams, rosters: {}, generatedAt: '2026-01-12T00:00:00Z' })
  const prediction = data.replayEvidence.predictions.find(value => value.id === 'scope-target')!
  const scopePrediction = buildRankingModel(matches.filter(match => match.season === 2026), teams).predictions.find(value => value.id === prediction.id)!
  assert.notEqual(prediction.teamBSeriesWinProbability, scopePrediction.teamBSeriesWinProbability)
  const seriesId = resolveCanonicalSeries(matches).find(series => series.games.some(match => match.id === prediction.id))!.id
  return { data, prediction, seriesId }
}

test('season summary, history, archive and rolling upset use one global recorded forecast', () => {
  const { data, prediction, seriesId } = scopeAuthorityFixture()
  const key = '2026__All__All'
  const summary = createStaticRankingSummaryData(data).snapshots[key]!
  const beta = summary.standings.find(standing => standing.team === 'Beta')!
  const recent = beta.recentMatches.find(match => match.seriesId === seriesId)!
  const history = createTeamHistoryArtifacts(data).shards[key]!.series[teamStandingKey(beta)]!
  const point = history.points.find(point => point[3]?.seriesId === seriesId)!
  const archive = Object.values(createMatchHistoryArtifacts(data).pages[key]!).flatMap(page => page.matches).find(match => match.id === prediction.id)!
  const upset = beta.rollingMovement?.biggestUpsetWin
  assert.ok(upset)
  assert.equal(recent.expectedWinProbability, prediction.teamBSeriesWinProbability)
  assert.equal(point[3]?.model?.e, recent.expectedWinProbability)
  assert.equal(archive.impact.expectedTeamB, recent.expectedWinProbability)
  assert.equal(upset.expectedWinProbability, recent.expectedWinProbability)
  for (const source of [recent.forecastSource, point[3]?.model?.forecastSource, archive.impact.forecastSource, upset.forecastSource]) {
    assert.deepEqual(source, { basis: 'latest-corrected-prior-replay', predictionId: prediction.id })
  }
})

test('tournament movement uses the same global recorded forecast as the match archive', () => {
  const { data, prediction, seriesId } = scopeAuthorityFixture(true)
  const movement = Object.values(data.tournamentMovements).flatMap(shard => shard.teams).find(team => team.team === 'Beta')!
  const point = movement.points.find(point => point[3]?.seriesId === seriesId)!
  assert.ok(point)
  const archive = Object.values(createMatchHistoryArtifacts(data).pages[data.defaultSnapshotKey]!).flatMap(page => page.matches).find(match => match.id === prediction.id)!
  assert.equal(archive.impact.expectedTeamB, prediction.teamBSeriesWinProbability)
  assert.equal(point[3]?.model?.e, archive.impact.expectedTeamB)
  assert.deepEqual(point[3]?.model?.forecastSource, archive.impact.forecastSource)
})
