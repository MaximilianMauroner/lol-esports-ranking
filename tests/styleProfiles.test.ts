import assert from 'node:assert/strict'
import test from 'node:test'
import { buildStyleProfiles } from '../src/domains/style/build.ts'
import { buildStyleCohorts, parseStyleProfileArtifact, playerKey, styleMeasures, stylePopulation, type PlayerStyleRow } from '../src/domains/style/profile.ts'
import { styleGame as game } from './styleProfileFixtures.ts'

const hash = 'a'.repeat(64)

test('canonical identities, roles, transfers, scopes and deterministic latest labels survive input reversal', () => {
  const old = game('old', 2025)
  const next = game('next')
  next.datetimeUtc = '2026-06-01T14:00:00Z'
  next.teamA = next.winner = 'Renamed'
  next.teamARoster!.players[0].role = 'Support'
  next.teamARoster!.players[4].role = 'Top'
  const earlier = game('earlier')
  earlier.datetimeUtc = '2026-06-01T10:00:00Z'
  const artifact = buildStyleProfiles([next, earlier, old], hash)
  assert.deepEqual(artifact, buildStyleProfiles([old, earlier, next], hash))
  const all = artifact.scopes.all
  assert.equal(all.teams.find(t => t.id === 'a')?.name, 'Renamed')
  assert.equal(all.teams.find(t => t.id === 'a')?.league, 'LCK')
  assert.equal(all.players.filter(p => p.name === 'Same name').length, 3)
  assert.equal(all.players.find(p => playerKey(p) === 'a-0|Support')?.games, 1)
  assert.equal(all.players.find(p => playerKey(p) === 'a-0|Top')?.games, 2)
  assert.equal(artifact.scopes['season:2025'].countedGames, 1)
  assert.equal(artifact.scopes['season:2026'].countedGames, 2)
  assert.deepEqual(parseStyleProfileArtifact(JSON.parse(JSON.stringify(artifact))), artifact)
})

test('missing values stay absent and measured zero remains available, including full five-player gold totals', () => {
  const g = game()
  delete g.teamARoster!.players[1].stats!.goldDiffAt15
  delete g.teamADragons
  g.teamARoster!.players[0].stats!.damageShare = 1.2
  g.teamARoster!.players[0].stats!.deaths = 0.5
  const a = buildStyleProfiles([g], hash).scopes.all
  assert.equal(a.teams[0].observed.fullTeamGoldDiffAt15, undefined)
  assert.equal(a.teams[1].observed.fullTeamGoldDiffAt15?.mean, 50)
  assert.equal(a.teams[0].observed.towersPerGame?.mean, 0)
  assert.equal(a.teams[0].observed.dragonsPerGame, undefined)
  assert.equal(a.players[0].observed.damageGoldShareGap, undefined)
  assert.equal(a.players[0].observed.deathsPerMinute, undefined)
  assert.equal(a.players[1].observed.deathsPerMinute?.mean, 0)
  assert.equal(a.players[0].observed.killParticipation?.mean, 0)
  assert.equal(a.players[0].observed.csPerMinute?.mean, 0)
})

test('rates require valid duration, deaths and shares, and duration boundaries use recorded results', () => {
  for (const seconds of [599, 5401, NaN]) {
    const g = game()
    g.gameLengthSeconds = seconds
    const scope = buildStyleProfiles([g], hash).scopes.all
    assert.equal(scope.teams[0].observed.gameMinutes, undefined)
    assert.equal(scope.players[0].observed.deathsPerMinute, undefined)
    assert.equal(scope.players[0].observed.damagePerMinute, undefined)
    assert.deepEqual(scope.teams[0].durationWins, {})
  }
  const games = [600, 1499, 1500, 2099, 2100, 5400].map((seconds, i) => ({ ...game(String(i)), gameLengthSeconds: seconds }))
  const team = buildStyleProfiles(games, hash).scopes.all.teams[0]
  assert.deepEqual(team.durationWins, { under25: [2, 2], '25to35': [2, 2], '35plus': [2, 2] })
})

test('incomplete pairs and other providers are excluded and never supply placeholder zeros', () => {
  const partial = game('partial')
  partial.teamBRoster!.players.pop()
  const foreign = { ...game('foreign'), sourceProvider: 'leaguepedia-cargo' as const }
  const unknownTeam = game('unknown')
  delete unknownTeam.teamARoster!.teamId
  const scope = buildStyleProfiles([game(), partial, foreign, unknownTeam], hash).scopes.all
  assert.equal(scope.countedGames, 1)
  assert.equal(scope.excludedGames, 3)
  assert.deepEqual(scope.excludedByReason, { 'other-provider': 1, 'incomplete-pair': 1, 'missing-team-id': 1 })
  assert.equal(scope.players[0].games, 1)
  assert.throws(() => buildStyleProfiles([game(), game()], hash), /Duplicate/)
})

function player(id: string, deaths: number, games = 20, metricGames = games): PlayerStyleRow {
  return { id, name: id, role: 'Support', teamId: 'a', team: 'Alpha', league: 'LCK', games,
    observed: { deathsPerMinute: { mean: deaths, games: metricGames }, goldDiffAt15: { mean: 10, games: metricGames } } }
}
test('mid-rank includes ties and self, reverses survival, and keeps samples and small cohorts explicit', () => {
  const rows = [player('a', 0), player('b', 1), player('c', 1), player('d', 3)]
  const cohorts = buildStyleCohorts(rows)
  const measure = (row: PlayerStyleRow) => styleMeasures(row, cohorts).find(m => m.metric.key === 'deathsPerMinute')!
  assert.equal(measure(rows[0]).percentile, 88)
  assert.equal(measure(rows[1]).percentile, 50)
  assert.equal(measure(rows[3]).percentile, 13)
  assert.equal(styleMeasures(rows[0], cohorts)[0].percentile, 50)
  assert.equal(measure(player('few', 0, 19)).status, 'few-games')
  assert.equal(measure(player('metric-few', 0, 20, 19)).status, 'few-metric-games')
  assert.equal(styleMeasures(rows[0], buildStyleCohorts([rows[0]]))[0].status, 'small-cohort')
  assert.equal(styleMeasures(rows[0], cohorts).find(m => m.metric.key === 'csPerMinute')?.percentile, null)
})

test('strict parsing rejects broken identity, coverage, metric data, versions and sample rules', () => {
  const artifact = buildStyleProfiles([game()], hash)
  const changes = [
    (a: typeof artifact) => { a.version = 'other' as typeof a.version },
    (a: typeof artifact) => { a.scopes.all.players[0].observed.csPerMinute = { mean: Infinity, games: 1 } },
    (a: typeof artifact) => { a.scopes.all.players[0].observed.csPerMinute = { mean: 0, games: 2 } },
    (a: typeof artifact) => { a.scopes.all.players.push(a.scopes.all.players[0]) },
    (a: typeof artifact) => { a.scopes.all.teams[0].durationWins['35plus'] = [2, 1] },
    (a: typeof artifact) => { a.scopes.all.countedGames++ },
  ]
  for (const change of changes) {
    const copy = structuredClone(artifact)
    change(copy)
    assert.throws(() => parseStyleProfileArtifact(copy), /Invalid style/)
  }
  assert.throws(() => parseStyleProfileArtifact({ ...artifact, sampleRules: { ...artifact.sampleRules, minCohort: 1 } }), /Invalid style/)
  assert.throws(() => parseStyleProfileArtifact({ ...artifact, score: 50 }), /Invalid style/)
})

test('cohorts always keep roles separate and league filters include home-league international observations', () => {
  const supports = [player('s1', 0), player('s2', 1)]
  const otherRole = { ...player('mid', 9), role: 'Mid' as const }
  const measure = styleMeasures(supports[0], buildStyleCohorts([...supports, otherRole])).find(m => m.metric.key === 'deathsPerMinute')!
  assert.equal(measure.cohortSize, 2)
  assert.equal(measure.percentile, 75)
  const games = Array.from({ length: 20 }, (_, i) => game(String(i)))
  const scope = buildStyleProfiles(games, hash).scopes.all
  const home = stylePopulation(scope, { kind: 'team', league: 'LCK' })
  assert.deepEqual(home.map(t => t.id), ['a'])
  assert.equal(home[0].games, 20)
  assert.equal(styleMeasures(home[0], buildStyleCohorts(home))[0].status, 'small-cohort')
  assert.equal(styleMeasures(scope.teams[0], buildStyleCohorts(scope.teams))[0].percentile, 50)
})

test('profile year scopes follow game dates even when a source season label differs', () => {
  const g = game()
  g.season = 2027
  const artifact = buildStyleProfiles([g], hash)
  assert.equal(artifact.scopes['season:2026'].countedGames, 1)
  assert.equal(artifact.scopes['season:2025'].countedGames, 0)
  assert.equal(artifact.sampleRules.scopeBasis, 'game-date-calendar-year')
})

test('invalid optional values do not supply objective, participation or share observations', () => {
  const g = game()
  g.teamADragons = -1
  g.teamABarons = 0.5
  g.teamBKills = NaN
  g.teamARoster!.players[0].stats!.killParticipation = 1.01
  g.teamARoster!.players[0].stats!.earnedGoldShare = -0.1
  const scope = buildStyleProfiles([g], hash).scopes.all
  assert.equal(scope.teams[0].observed.dragonsPerGame, undefined)
  assert.equal(scope.teams[0].observed.baronsPerGame, undefined)
  assert.equal(scope.teams[0].observed.combinedKillsPerMinute, undefined)
  assert.equal(scope.teams[0].observed.teamKillsPerMinute?.mean, 0)
  assert.equal(scope.players[0].observed.killParticipation, undefined)
  assert.equal(scope.players[0].observed.damageGoldShareGap, undefined)
})
