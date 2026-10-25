import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRankingModel } from '../src/domains/rankings/internal/replay/model.ts'
import { withSeriesStartDates } from '../src/domains/rankings/internal/evidence/seriesResolver.ts'
import { mergeCommunityMatchSources } from '../src/domains/rankings/internal/evidence/communitySources.ts'
import type { MatchRecord, PlayerGameStats, PregamePrediction, Role, TeamProfile } from '../src/domains/rankings/types.ts'

const roles: Role[] = ['Top', 'Jungle', 'Mid', 'Bot', 'Support']
const teams: Record<string, TeamProfile> = {
  Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
  Beta: { name: 'Beta', code: 'BET', region: 'LCK', league: 'LCK' },
}
const strongEvidence: Partial<PlayerGameStats> = { kills: 10, deaths: 1, assists: 10, damageShare: 0.8, earnedGoldShare: 0.8, vspm: 4 }
const weakEvidence: Partial<PlayerGameStats> = { kills: 0, deaths: 8, assists: 0, damageShare: 0.05, earnedGoldShare: 0.05, vspm: 0 }

test('own-game and future performance changes cannot change a public pregame forecast', () => {
  const baseline = [...history(), match('target', 20), match('future', 21)]
  for (const id of ['target', 'future']) {
    const observed = structuredClone(baseline)
    const row = observed.find((candidate) => candidate.id === id)!
    for (const player of row.teamARoster!.players) Object.assign(player.stats!, strongEvidence)
    for (const player of row.teamBRoster!.players) Object.assign(player.stats!, weakEvidence)
    assert.deepEqual(forecast(observed, 'target'), forecast(baseline, 'target'))
  }
})

test('same-date performance and roster changes cannot change another midnight forecast', () => {
  const baseline = [...history(), match('early', 20), match('target', 20)]
  baseline.at(-2)!.datetimeUtc = '2026-01-20T01:00:00Z'
  baseline.at(-1)!.datetimeUtc = '2026-01-20T20:00:00Z'
  const observed = structuredClone(baseline)
  const early = observed.at(-2)!
  for (const player of early.teamARoster!.players) {
    player.id = `substitute-${player.role}`
    Object.assign(player.stats!, strongEvidence)
  }
  for (const player of early.teamBRoster!.players) Object.assign(player.stats!, weakEvidence)
  const before = forecast(baseline, 'target')
  const after = forecast(observed, 'target')
  assert.deepEqual(after, before)
  assert.equal(after.teamALineupObservedAt, '2026-01-12')
  assert.equal(after.teamAPlayerRatingCoverage, 1)
  const nextDay = forecast([...observed, match('next-date', 21)], 'next-date')
  assert.equal(nextDay.teamALineupObservedAt, '2026-01-20')
  assert.notEqual(nextDay.teamAPlayerRatingAdjustment, after.teamAPlayerRatingAdjustment)
})

test('a multi-day series freezes its player edge at the start and releases evidence after its last observation', () => {
  const first = match('spanning-first', 13)
  const last = match('spanning-last', 15)
  for (const row of [first, last]) {
    row.officialMatchId = 'spanning-series'
    row.bestOf = 3
    row.bestOfBasis = 'official'
    row.datetimeUtc = `${row.date}T12:00:00Z`
  }
  const baseline = withSeriesStartDates([...history(), first, match('between', 14), last, match('end-date', 15), match('after', 16)])
  const changed = structuredClone(baseline)
  const finalGame = changed.find((row) => row.id === 'spanning-last')!
  for (const player of finalGame.teamARoster!.players) Object.assign(player.stats!, strongEvidence)
  for (const player of finalGame.teamBRoster!.players) Object.assign(player.stats!, weakEvidence)
  const before = buildRankingModel(baseline, teams).predictions
  const after = buildRankingModel(changed, teams).predictions
  const edge = (rows: PregamePrediction[], id: string) => playerEvidence(rows.find((row) => row.id === id)!)
  assert.deepEqual(edge(after, 'spanning-first'), edge(after, 'spanning-last'))
  for (const id of ['spanning-first', 'spanning-last', 'between', 'end-date']) assert.deepEqual(edge(after, id), edge(before, id))
  assert.notDeepEqual(edge(after, 'after'), edge(before, 'after'))
})

test('overnight completion excludes postgame evidence at midnight and admits it on the next date', () => {
  const overnight = match('overnight', 20)
  overnight.datetimeUtc = '2026-01-20T23:50:00Z'
  overnight.gameLengthSeconds = 1800
  overnight.gameCompletedAtUtc = '2026-01-21T00:20:00Z'
  const baseline = [...history(), overnight, match('midnight', 21), match('next-midnight', 22)]
  const changed = structuredClone(baseline)
  const completed = changed.find(row => row.id === 'overnight')!
  for (const player of completed.teamARoster!.players) Object.assign(player.stats!, strongEvidence)
  for (const player of completed.teamBRoster!.players) Object.assign(player.stats!, weakEvidence)
  const beforeMidnight = forecast(baseline, 'midnight')
  const afterMidnight = forecast(changed, 'midnight')
  assert.deepEqual(playerEvidence(afterMidnight), playerEvidence(beforeMidnight))
  assert.equal(afterMidnight.teamALineupObservedAt, '2026-01-12')
  assert.notDeepEqual(playerEvidence(forecast(changed, 'next-midnight')), playerEvidence(forecast(baseline, 'next-midnight')))
})

test('official series start normalization preserves the final game completion cutoff', () => {
  const first = match('late-series-game-1', 20)
  const last = match('late-series-game-2', 20)
  first.datetimeUtc = '2026-01-20T22:00:00Z'
  first.gameCompletedAtUtc = '2026-01-20T22:30:00Z'
  last.datetimeUtc = '2026-01-20T23:50:00Z'
  last.gameCompletedAtUtc = '2026-01-21T00:20:00Z'
  const normalized = mergeCommunityMatchSources({
    oracleMatches: [...history(), first, last, match('midnight', 21), match('next-midnight', 22)],
    leaguepediaMatches: [],
    lolEsportsReferences: [{
      sourceProvider: 'lol-esports-api', matchId: 'late-series', date: '2026-01-20',
      startTime: '2026-01-20T22:00:00Z', strategy: { count: 3 },
      teams: [{ name: 'Alpha' }, { name: 'Beta' }], gameIds: [], games: [],
    }],
  })
  const finalGame = normalized.find(row => row.id === last.id)!
  assert.equal(finalGame.datetimeUtc, first.datetimeUtc)
  assert.equal(finalGame.gameCompletedAtUtc, '2026-01-21T00:20:00Z')
  const changed = structuredClone(normalized)
  const completed = changed.find(row => row.id === last.id)!
  for (const player of completed.teamARoster!.players) Object.assign(player.stats!, strongEvidence)
  for (const player of completed.teamBRoster!.players) Object.assign(player.stats!, weakEvidence)
  assert.deepEqual(playerEvidence(forecast(changed, 'midnight')), playerEvidence(forecast(normalized, 'midnight')))
  assert.equal(forecast(changed, 'midnight').teamALineupObservedAt, '2026-01-12')
  assert.notDeepEqual(playerEvidence(forecast(changed, 'next-midnight')), playerEvidence(forecast(normalized, 'next-midnight')))
})

test('unproven game completion cannot update forecast player state', () => {
  for (const gameCompletedAtUtc of [undefined, 'invalid']) {
    const unproven = match('unproven', 20)
    unproven.datetimeUtc = '2026-01-20T23:50:00Z'
    unproven.gameCompletedAtUtc = gameCompletedAtUtc
    unproven.gameLengthSeconds = undefined
    const baseline = [...history(), unproven, match('next-midnight', 22)]
    const changed = structuredClone(baseline)
    for (const player of changed.find(row => row.id === unproven.id)!.teamARoster!.players) Object.assign(player.stats!, strongEvidence)
    const prediction = forecast(changed, 'next-midnight')
    assert.deepEqual(playerEvidence(prediction), playerEvidence(forecast(baseline, 'next-midnight')))
    assert.equal(prediction.teamALineupObservedAt, '2026-01-12')
  }
})

function history(a: Partial<PlayerGameStats> = {}, b: Partial<PlayerGameStats> = {}) {
  return Array.from({ length: 12 }, (_, index) => match(`history-${index + 1}`, index + 1, a, b))
}

function match(id: string, day: number, a: Partial<PlayerGameStats> = {}, b: Partial<PlayerGameStats> = {}): MatchRecord {
  const date = `2026-01-${String(day).padStart(2, '0')}`
  const winner = day % 2 ? 'Alpha' : 'Beta'
  const roster = (team: string, fields: Partial<PlayerGameStats>) => ({
    completeness: 'complete-five-role' as const,
    sourceProvider: 'oracles-elixir' as const,
    observedAt: date,
    players: roles.map((role) => ({
      id: `${team}-${role}`, name: `${team}-${role}`, role,
      stats: { side: team === 'Alpha' ? 'blue' as const : 'red' as const, won: team === winner, kills: 1, deaths: 1, assists: 1, damageShare: 0.2, earnedGoldShare: 0.2, vspm: 1, ...fields },
    })),
  })
  return {
    id, sourceProvider: 'oracles-elixir', sourceGameId: id, officialMatchId: id,
    date, gameCompletedAtUtc: `${date}T12:30:00Z`, season: 2026, event: 'Synthetic LCK fixture', phase: 'Regular season', region: 'LCK', league: 'LCK',
    teamAHomeLeague: 'LCK', teamBHomeLeague: 'LCK', teamARegion: 'LCK', teamBRegion: 'LCK',
    bestOf: 1, tier: 'regional-regular', patch: '26.1', teamA: 'Alpha', teamB: 'Beta', winner,
    teamAKills: 10, teamBKills: 10, teamAGold: 60000, teamBGold: 60000,
    teamARoster: roster('Alpha', a), teamBRoster: roster('Beta', b),
  }
}

function forecast(matches: MatchRecord[], id: string) {
  const prediction = buildRankingModel(matches, teams).predictions.find((row) => row.id === id)
  assert.ok(prediction)
  return prediction
}

function playerEvidence(prediction: PregamePrediction) {
  assert.ok(prediction)
  return {
    a: prediction.teamAPlayerRatingAdjustment, b: prediction.teamBPlayerRatingAdjustment,
    coverageA: prediction.teamAPlayerRatingCoverage, coverageB: prediction.teamBPlayerRatingCoverage,
    basisA: prediction.teamALineupEvidenceBasis, basisB: prediction.teamBLineupEvidenceBasis,
    observedA: prediction.teamALineupObservedAt, observedB: prediction.teamBLineupObservedAt,
    freshnessA: prediction.teamALineupFreshnessWeight, freshnessB: prediction.teamBLineupFreshnessWeight,
  }
}
