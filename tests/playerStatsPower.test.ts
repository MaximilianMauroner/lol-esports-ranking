import assert from 'node:assert/strict'
import test from 'node:test'
import { eventTierConfig } from '../src/domains/rankings/internal/policy/rankingConfig.ts'
import { statsPowerPolicy } from '../src/domains/rankings/internal/policy/statsPowerPolicy.ts'
import { eventWeightForMatch } from '../src/domains/rankings/internal/replay/eventWeighting.ts'
import { buildPregamePlayerRatingEdges } from '../src/domains/rankings/internal/players/playerModel.ts'
import { buildPlayerStatsPower } from '../src/domains/rankings/internal/players/playerStatsPower.ts'
import { playerBaselineForLeague, playerSignalMultiplierForLeague } from '../src/domains/rankings/internal/policy/playerPolicy.ts'
import { parsePublicPlayerDirectory } from '../src/domains/rankings/internal/published/schema.ts'
import { createPlayerDirectory, createStaticRankingData, snapshotKey } from '../src/domains/rankings/internal/projections/snapshot.ts'
import { buildPlayerModel, buildRankingModel } from '../src/domains/rankings/internal/replay/model.ts'
import type { MatchRecord, MatchRosterSnapshot, PlayerGameStats, PlayerStanding, PlayerStatsPower, Role, TeamProfile } from '../src/domains/rankings/types.ts'

const roles: Role[] = ['Top', 'Jungle', 'Mid', 'Bot', 'Support']
const noRatings = new Map<string, number>()

const teams: Record<string, TeamProfile> = {
  Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
  Beta: { name: 'Beta', code: 'BET', region: 'LCK', league: 'LCK' },
  Cedar: { name: 'Cedar', code: 'CED', region: 'LCK', league: 'LCK CL' },
  Dune: { name: 'Dune', code: 'DUN', region: 'LCK', league: 'LCK CL' },
  Ember: { name: 'Ember', code: 'EMB', region: 'LCK', league: 'LCK' },
  Frost: { name: 'Frost', code: 'FRO', region: 'LCK', league: 'LCK' },
  Omega: { name: 'Omega', code: 'OME', region: 'LPL', league: 'LPL' },
}

type Lineup = {
  team: string
  ids?: Partial<Record<Role, string>>
  stats?: Partial<Record<Role, Partial<PlayerGameStats>>>
}

const ahead = { goldDiffAt15: 300, xpDiffAt15: 200, csDiffAt15: 10 }
const behind = { goldDiffAt15: -300, xpDiffAt15: -200, csDiffAt15: -10 }

function evenEdge(team: string, lead: boolean, ids?: Lineup['ids']): Lineup {
  const lane = lead ? ahead : behind
  return {
    team,
    ids,
    stats: {
      Top: lane, Mid: lane, Bot: lane,
      Jungle: { ...lane, killParticipation: lead ? 0.6 : 0.4 },
      Support: { killParticipation: lead ? 0.6 : 0.4, wardsPlacedPerMinute: lead ? 1.2 : 0.8, wardsClearedPerMinute: lead ? 0.35 : 0.25 },
    },
  }
}

function game(id: string, date: string, a: Lineup, b: Lineup, overrides: Partial<MatchRecord> = {}): MatchRecord {
  const match: MatchRecord = {
    id, sourceProvider: 'oracles-elixir', sourceGameId: id, dataCompleteness: 'complete',
    date, season: Number(date.slice(0, 4)), event: `${teams[a.team]!.league} 2026 Split`, phase: 'Regular season',
    region: 'LCK', league: teams[a.team]!.league, patch: '26.1', bestOf: 1, tier: 'regional-regular',
    teamA: a.team, teamB: b.team, winner: a.team, teamAKills: 15, teamBKills: 10, teamAGold: 60_000, teamBGold: 55_000,
    teamAHomeLeague: teams[a.team]!.league, teamBHomeLeague: teams[b.team]!.league,
    ...overrides,
  }
  match.teamARoster = roster(match, a, 'blue')
  match.teamBRoster = roster(match, b, 'red')
  return match
}

function roster(match: MatchRecord, lineup: Lineup, side: PlayerGameStats['side']): MatchRosterSnapshot {
  return {
    sourceProvider: 'oracles-elixir', completeness: 'complete-five-role', observedAt: match.date,
    players: roles.map((role) => {
      const id = lineup.ids?.[role] ?? `${lineup.team}-${role}`
      return {
        id, name: id, role,
        stats: { side, won: match.winner === lineup.team, kills: 2, deaths: 2, assists: 4, damageShare: 0.2, earnedGoldShare: 0.2, vspm: 1, ...lineup.stats?.[role] },
      }
    }),
  }
}

function day(index: number, month = 3) {
  return `2026-${String(month + Math.floor(index / 28)).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}`
}

function series(prefix: string, count: number, a: (index: number) => Lineup, b: (index: number) => Lineup, overrides: (index: number) => Partial<MatchRecord> = () => ({})) {
  return Array.from({ length: count }, (_, index) => game(`${prefix}-${index}`, day(index), a(index), b(index), overrides(index)))
}

function players(matches: MatchRecord[]) {
  return buildPlayerModel(matches, {}, { teams })
}

function power(standings: PlayerStanding[], id: string): PlayerStatsPower {
  const summary = standings.find((player) => player.id === id)?.statsPower
  assert.ok(summary, `${id} must carry Stats Power`)
  return summary
}

function near(actual: number, expected: number, label: string) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} is not ${expected}`)
}

function legacy(player: PlayerStanding) {
  const rest = { ...player }
  delete rest.statsPower
  delete rest.diagnostics
  return rest
}

test('stronger lane evidence moves Stats Power order while every legacy strength output stays identical', () => {
  const build = (alphaMidLead: number) => [
    ...series('ab', 24, () => ({ team: 'Alpha', stats: { Mid: { goldDiffAt15: alphaMidLead, xpDiffAt15: alphaMidLead / 2, csDiffAt15: alphaMidLead / 50 } } }),
      () => ({ team: 'Beta', stats: { Mid: { goldDiffAt15: -alphaMidLead, xpDiffAt15: -alphaMidLead / 2, csDiffAt15: -alphaMidLead / 50 } } })),
    ...series('ef', 24, () => ({ team: 'Ember', stats: { Mid: { goldDiffAt15: 400, xpDiffAt15: 200, csDiffAt15: 8 } } }),
      () => ({ team: 'Frost', stats: { Mid: { goldDiffAt15: -400, xpDiffAt15: -200, csDiffAt15: -8 } } })),
  ]
  const weak = build(100)
  const strong = build(900)
  const weakPlayers = players(weak)
  const strongPlayers = players(strong)

  assert.ok(power(weakPlayers, 'Ember-Mid').score > power(weakPlayers, 'Alpha-Mid').score)
  assert.ok(power(strongPlayers, 'Alpha-Mid').score > power(strongPlayers, 'Ember-Mid').score)
  assert.deepEqual(strongPlayers.map(legacy), weakPlayers.map(legacy))
  assert.deepEqual(buildPregamePlayerRatingEdges(strong, { teams }), buildPregamePlayerRatingEdges(weak, { teams }))
  const weakModel = buildRankingModel(weak, teams)
  const strongModel = buildRankingModel(strong, teams)
  assert.deepEqual(strongModel.predictions, weakModel.predictions)
  assert.deepEqual(strongModel.standings, weakModel.standings)
})

test('equal standardized evidence scores the same in every role, whatever the metric units', () => {
  const matches = series('ab', 30, () => evenEdge('Alpha', true), () => evenEdge('Beta', false), () => ({ date: '2026-03-01' }))
  const standings = players(matches)
  const anchor = playerBaselineForLeague('LCK', noRatings)
  const expectedLead = 30 * Math.tanh(0.5 * 30 / 50)
  for (const role of roles) {
    const leader = power(standings, `Alpha-${role}`)
    const trailer = power(standings, `Beta-${role}`)
    near(leader.leagueAnchor, anchor, `${role} anchor`)
    near(leader.score - anchor, expectedLead, `${role} leader`)
    near(trailer.score - anchor, -expectedLead, `${role} trailer`)
  }

  const varied = (scale: number) => series('ab', 30,
    (index) => ({ team: 'Alpha', stats: { Support: { killParticipation: 0.5, wardsPlacedPerMinute: (0.6 + index / 20) * scale, wardsClearedPerMinute: 0.2 * scale }, Mid: { goldDiffAt15: (index - 10) * 25 * scale, xpDiffAt15: index, csDiffAt15: 3 } } }),
    (index) => ({ team: 'Beta', stats: { Support: { killParticipation: 0.4, wardsPlacedPerMinute: (0.9 - index / 40) * scale, wardsClearedPerMinute: (0.1 + index / 100) * scale }, Mid: { goldDiffAt15: -(index - 10) * 25 * scale, xpDiffAt15: -index, csDiffAt15: -3 } } }))
  const minutes = players(varied(1))
  const hours = players(varied(60))
  for (const id of ['Alpha-Support', 'Beta-Support', 'Alpha-Mid', 'Beta-Mid']) {
    near(power(minutes, id).score, power(hours, id).score, `${id} must not depend on metric units`)
  }
})

test('real zeros are observations, while missing and invalid values stay unavailable', () => {
  const build = (emberJungleKp: number) => [
    ...series('ab', 20, () => evenEdge('Alpha', true), () => evenEdge('Beta', false)),
    ...series('ef', 20,
      () => ({ team: 'Ember', ids: { Mid: 'zero-mid' }, stats: { Mid: { goldDiffAt15: 0, xpDiffAt15: 0, csDiffAt15: 0 }, Jungle: { ...ahead, killParticipation: emberJungleKp }, Support: { killParticipation: 0, wardsPlacedPerMinute: 0, wardsClearedPerMinute: 0 } } }),
      () => ({ team: 'Frost', ids: { Mid: 'missing-mid' }, stats: { Jungle: { ...behind }, Support: { goldDiffAt15: 500, xpDiffAt15: 500, csDiffAt15: 20 } } })),
  ]
  const sameDay = (input: MatchRecord[]) => input.map((match) => ({ ...match, date: '2026-03-01' }))
  const standings = players(sameDay(build(1.5)))
  const zero = power(standings, 'zero-mid')
  assert.deepEqual(zero.metrics.goldDiffAt15, { observed: 20, missing: 0, effectiveGames: 20 })
  assert.equal(zero.sampleGames, 20)
  assert.equal(zero.priorOnly, false)

  const missing = power(standings, 'missing-mid')
  assert.deepEqual(missing.metrics, {
    goldDiffAt15: { observed: 0, missing: 20, effectiveGames: 0 },
    xpDiffAt15: { observed: 0, missing: 20, effectiveGames: 0 },
    csDiffAt15: { observed: 0, missing: 20, effectiveGames: 0 },
  })
  assert.equal(missing.eligibleGames, 20)
  assert.equal(missing.sampleGames, 0)
  assert.equal(missing.priorOnly, true)
  assert.equal(missing.score, missing.leagueAnchor)
  assert.ok(Number.isFinite(missing.score))

  const invalidKp = power(standings, 'Ember-Jungle')
  assert.deepEqual(invalidKp.metrics.killParticipation, { observed: 0, missing: 20, effectiveGames: 0 })
  assert.equal(invalidKp.priorOnly, false, 'One unavailable optional metric keeps the other role metrics')
  assert.ok(invalidKp.score > invalidKp.leagueAnchor)
  const centeredKp = power(players(sameDay(build(0.5))), 'Ember-Jungle')
  near(invalidKp.score, centeredKp.score, 'A missing optional metric keeps its slot, like an exactly average one')

  const zeroSupport = power(standings, 'Ember-Support')
  assert.equal(zeroSupport.metrics.wardsPlacedPerMinute?.observed, 20)
  assert.ok(zeroSupport.score < zeroSupport.leagueAnchor, 'Zero ward activity is a low observation, not a missing one')
})

test('supports without support metrics stay on the league anchor and ignore lane leads', () => {
  const build = (laneLead: number) => [
    ...series('ab', 20, () => evenEdge('Alpha', true), () => evenEdge('Beta', false)),
    ...series('ef', 20,
      () => ({ team: 'Ember', stats: { Support: { goldDiffAt15: laneLead, xpDiffAt15: laneLead, csDiffAt15: laneLead / 10 } } }),
      () => ({ team: 'Frost', stats: { Support: { goldDiffAt15: -laneLead, xpDiffAt15: -laneLead, csDiffAt15: -laneLead / 10 } } })),
  ]
  const small = power(players(build(10)), 'Ember-Support')
  const large = power(players(build(2_000)), 'Ember-Support')
  assert.deepEqual(large, small)
  assert.equal(large.priorOnly, true)
  assert.equal(large.sampleGames, 0)
  assert.equal(large.score, large.leagueAnchor)
  assert.deepEqual(Object.keys(large.metrics), ['killParticipation', 'wardsPlacedPerMinute', 'wardsClearedPerMinute'])
})

test('short samples stay closer to the league anchor than long samples with the same edge', () => {
  const matches = [
    ...series('ab', 40, () => evenEdge('Alpha', true), () => evenEdge('Beta', false)),
    ...series('ef', 2, () => evenEdge('Ember', true), () => evenEdge('Frost', false)),
  ]
  const standings = players(matches)
  const long = power(standings, 'Alpha-Mid')
  const short = power(standings, 'Ember-Mid')
  near(short.leagueAnchor, long.leagueAnchor, 'same league anchor')
  assert.ok(short.score > short.leagueAnchor)
  assert.ok(long.score - long.leagueAnchor > 3 * (short.score - short.leagueAnchor))
  assert.equal(short.sampleGames, 2)
  assert.equal(long.sampleGames, 40)
})

test('opposite older and newer lines order equal raw samples by recent form, and exchanging ages reverses them', () => {
  const earlier = game('older', '2026-01-01', evenEdge('Alpha', false), evenEdge('Beta', true))
  const later = game('newer', '2026-04-01', evenEdge('Alpha', true), evenEdge('Beta', false))
  const standings = players([earlier, later])
  const improving = power(standings, 'Alpha-Mid')
  const declining = power(standings, 'Beta-Mid')
  const anchor = playerBaselineForLeague('LCK', noRatings)
  const expectedEdge = 30 * Math.tanh((1 / 6) * (1.8 / 21.8))
  near(improving.score, anchor + expectedEdge, 'one half-weight loss followed by one full-weight lead')
  near(declining.score, anchor - expectedEdge, 'opposite recent form')
  assert.equal(improving.sampleGames, 2)
  assert.equal(declining.sampleGames, 2)
  assert.deepEqual(improving.metrics.goldDiffAt15, { observed: 2, missing: 0, effectiveGames: 1.8 })
  const exchanged = players([{ ...earlier, date: later.date }, { ...later, date: earlier.date }])
  near(power(exchanged, 'Alpha-Mid').score, declining.score, 'exchanging ages reverses Alpha')
  near(power(exchanged, 'Beta-Mid').score, improving.score, 'exchanging ages reverses Beta')
})

test('a common UTC date shift preserves scores and effective samples across a daylight-saving change', () => {
  const matches = [
    game('older', '2026-01-01', evenEdge('Alpha', false), evenEdge('Beta', true)),
    game('newer', '2026-04-01', evenEdge('Alpha', true), evenEdge('Beta', false)),
  ]
  const shifted = matches.map((match) => ({
    ...match,
    date: new Date(Date.parse(`${match.date}T00:00:00Z`) + 180 * 86_400_000).toISOString().slice(0, 10),
  }))
  const original = buildPlayerStatsPower(matches, { teams }, noRatings)
  const moved = buildPlayerStatsPower(shifted, { teams }, noRatings)
  for (const [id, roles] of original) {
    for (const [role, summary] of roles) {
      const shiftedSummary = moved.get(id)!.get(role)!
      assert.deepEqual({ ...shiftedSummary, evidenceThrough: summary.evidenceThrough }, summary)
      assert.equal(shiftedSummary.evidenceThrough, shifted[1]!.date)
    }
  }
})

test('supplied history scores do not use the wall clock', (t) => {
  const history = [
    game('older', '2026-01-01', evenEdge('Alpha', false), evenEdge('Beta', true)),
    game('newer', '2026-04-01', evenEdge('Alpha', true), evenEdge('Beta', false)),
  ]
  const expected = buildPlayerStatsPower(history, { teams }, noRatings)
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-01-01T00:00:00Z') })
  assert.deepEqual(buildPlayerStatsPower(history, { teams }, noRatings), expected)
  t.mock.timers.setTime(Date.parse('2040-06-01T00:00:00Z'))
  assert.deepEqual(buildPlayerStatsPower(history, { teams }, noRatings), expected)
})

test('recency and original league weights govern anchors, signal means and effective sample shrinkage together', () => {
  const matches = [
    game('major', '2026-01-01', evenEdge('Alpha', true, { Mid: 'mover' }), evenEdge('Beta', false)),
    game('minor', '2026-04-01', evenEdge('Cedar', true, { Mid: 'mover' }), evenEdge('Dune', false)),
  ]
  const summary = power(players(matches), 'mover')
  const signal = playerSignalMultiplierForLeague('LCK CL')
  const weight = 0.5 + signal
  const anchor = (0.5 * playerBaselineForLeague('LCK', noRatings) + signal * playerBaselineForLeague('LCK CL', noRatings)) / weight
  const meanSignal = (0.5 + signal ** 2) / weight
  const effective = weight ** 2 / (0.25 + signal ** 2)
  near(summary.leagueAnchor, anchor, 'original league anchor with half-weight older game')
  near(summary.score, anchor + 30 * meanSignal * Math.tanh(0.5 * effective / (effective + 20)), 'weighted signal and shrinkage')
  assert.equal(summary.metrics.goldDiffAt15!.effectiveGames, Number(effective.toFixed(2)))
})

test('zero paired scales remain unavailable while observed counts stay raw', () => {
  const matches = series('flat', 3, () => evenEdge('Alpha', true), () => evenEdge('Beta', true))
  const summary = power(players(matches), 'Alpha-Mid')
  assert.equal(summary.priorOnly, true)
  assert.equal(summary.score, summary.leagueAnchor)
  assert.equal(summary.sampleGames, 0)
  assert.equal(summary.eligibleGames, 3)
  assert.equal(summary.metrics.goldDiffAt15!.observed, 3)
  assert.equal(summary.metrics.goldDiffAt15!.missing, 0)
  assert.ok(summary.metrics.goldDiffAt15!.effectiveGames! > 0)
})

test('each appearance keeps its own home league across transfers and international events', () => {
  const domestic = series('ab', 10, () => evenEdge('Alpha', true, { Mid: 'mover' }), () => evenEdge('Beta', false))
  const afterTransfer = series('cd', 10, () => evenEdge('Cedar', true, { Mid: 'mover' }), () => evenEdge('Dune', false), (index) => ({ date: day(index, 6) }))
  const worlds = series('worlds', 4, () => evenEdge('Alpha', true), () => evenEdge('Omega', false), (index) => ({
    date: day(index, 9), league: 'WLDs', event: 'Worlds 2026', phase: 'Swiss Stage', region: 'International', tier: 'worlds-main',
  }))
  const standings = players([...domestic, ...afterTransfer, ...worlds])

  const mover = power(standings, 'mover')
  const lck = playerBaselineForLeague('LCK', noRatings)
  const challengers = playerBaselineForLeague('LCK CL', noRatings)
  const challengerWeight = playerSignalMultiplierForLeague('LCK CL')
  assert.equal(standings.find((player) => player.id === 'mover')?.team, 'Cedar')
  const earlierWeight = 2 ** (-92 / 90)
  near(mover.leagueAnchor, (earlierWeight * lck + challengerWeight * challengers) / (earlierWeight + challengerWeight), 'transfer anchor with 92 days between equal date patterns')
  assert.equal(mover.eligibleGames, 20)
  assert.equal(mover.evidenceThrough, day(9, 6))

  const worldsOnly = power(standings, 'Omega-Mid')
  assert.notEqual(playerBaselineForLeague('WLDs', noRatings), playerBaselineForLeague('LPL', noRatings))
  near(worldsOnly.leagueAnchor, playerBaselineForLeague('LPL', noRatings), 'international home anchor')
})

test('tournament games carry more weight and weak-league domestic leads carry less', () => {
  const lead = (team: string, strong: boolean): Lineup => ({ team, stats: { Mid: strong ? { goldDiffAt15: 600, xpDiffAt15: 400, csDiffAt15: 20 } : { goldDiffAt15: -600, xpDiffAt15: -400, csDiffAt15: -20 } } })
  const worldsGame = { league: 'WLDs', event: 'Worlds 2026', phase: 'Knockout', region: 'International' as const, tier: 'worlds-playoffs' as const }
  const tournamentMatches = [
    game('alpha-domestic', '2026-04-01', lead('Alpha', false), lead('Beta', true)),
    game('alpha-worlds', '2026-10-01', lead('Alpha', true), lead('Frost', false), worldsGame),
    game('ember-domestic', '2026-04-02', lead('Ember', true), lead('Beta', false)),
    game('ember-worlds', '2026-10-02', lead('Ember', false), lead('Frost', true), worldsGame),
  ]
  const tournament = players(tournamentMatches)
  const tournamentStrong = power(tournament, 'Alpha-Mid')
  const domesticStrong = power(tournament, 'Ember-Mid')
  near(tournamentStrong.leagueAnchor, domesticStrong.leagueAnchor, 'same league anchor')
  assert.ok(tournamentStrong.score > domesticStrong.score)
  const regularOnly = players(tournamentMatches.map((match) => ({ ...match, tier: 'regional-regular' })))
  assert.ok(tournamentStrong.score > power(regularOnly, 'Alpha-Mid').score, 'Tournament weighting still adds to the recency effect')
  assert.ok(domesticStrong.score < power(regularOnly, 'Ember-Mid').score, 'Recent tournament losses keep their event weight')

  const leagues = players([
    ...series('ab', 20, () => evenEdge('Alpha', true), () => evenEdge('Beta', false)),
    ...series('cd', 20, () => evenEdge('Cedar', true), () => evenEdge('Dune', false)),
  ])
  const major = power(leagues, 'Alpha-Mid')
  const minor = power(leagues, 'Cedar-Mid')
  assert.ok(minor.score < major.score)
  assert.ok(minor.leagueAnchor < major.leagueAnchor)
  assert.ok(minor.score > minor.leagueAnchor)
  const ratio = (minor.score - minor.leagueAnchor) / (major.score - major.leagueAnchor)
  near(ratio, playerSignalMultiplierForLeague('LCK CL'), 'weak-league signal share')
})

test('outcomes never change Stats Power under fixed league and event context', () => {
  const matches = [
    ...series('ab', 20, () => evenEdge('Alpha', true), () => evenEdge('Beta', false)),
    ...series('cd', 20, () => evenEdge('Cedar', false), () => evenEdge('Dune', true)),
  ]
  const flipped = matches.map((match) => {
    const winner = match.winner === match.teamA ? match.teamB : match.teamA
    const flip = (snapshot: MatchRosterSnapshot | undefined) => snapshot && {
      ...snapshot,
      players: snapshot.players.map((player) => ({ ...player, stats: player.stats && { ...player.stats, won: !player.stats.won } })),
    }
    return { ...match, winner, teamARoster: flip(match.teamARoster), teamBRoster: flip(match.teamBRoster) }
  })
  const leagueStrengths = buildRankingModel(matches, teams).leagues
  const summaries = (input: MatchRecord[]) => buildPlayerModel(input, {}, { teams, leagueStrengths })
    .map((player) => [player.id, player.statsPower])
    .sort(([left], [right]) => String(left).localeCompare(String(right)))
  assert.deepEqual(summaries(flipped), summaries(matches))
})

test('a prefix caller fits only its supplied history', () => {
  const prefix = series('ab', 20, () => evenEdge('Alpha', true), () => evenEdge('Beta', false))
  const future = series('later', 20, () => evenEdge('Alpha', false), () => ({ team: 'Beta', stats: { Mid: { goldDiffAt15: 5_000, xpDiffAt15: 5_000, csDiffAt15: 200 } } }), (index) => ({ date: day(index, 8) }))
  const prefixOnly = power(players(prefix), 'Alpha-Mid')
  assert.equal(prefixOnly.evidenceThrough, prefix.at(-1)!.date)
  assert.equal(prefixOnly.eligibleGames, 20)
  assert.notDeepEqual(power(players([...prefix, ...future]), 'Alpha-Mid'), prefixOnly)
  assert.deepEqual(power(players(prefix), 'Alpha-Mid'), prefixOnly)
})

test('published default and season rows keep the unrounded summary, old rows still parse, and corrupt summaries fail', () => {
  const matches = series('ab', 24, () => evenEdge('Alpha', true), () => evenEdge('Beta', false))
  const data = createStaticRankingData({ matches, teams, rosters: {}, source: 'Explicit synthetic test fixture', generatedAt: '2026-05-01T00:00:00Z' })
  const directory = JSON.parse(JSON.stringify(createPlayerDirectory(data)))
  const parsed = parsePublicPlayerDirectory(structuredClone(directory))
  const seasonKey = snapshotKey({ season: '2026', event: 'All', region: 'All' })
  for (const [rows, key] of [[parsed.players, data.defaultSnapshotKey], [parsed.scopedPlayers![seasonKey]!, seasonKey]] as const) {
    const standings = data.snapshots[key]!.players
    assert.equal(rows.length, 10)
    for (const row of rows) {
      const standing = standings.find((player) => player.id === row.id)!
      assert.ok(standing.statsPower && !standing.statsPower.priorOnly)
      assert.deepEqual(row.statsPower, standing.statsPower, 'The published summary keeps the unrounded score')
      assert.equal(row.rating, standing.rating, 'Role Power stays the stored rating')
    }
  }

  const old = structuredClone(directory)
  for (const row of [...old.players, ...Object.values<Array<Record<string, unknown>>>(old.scopedPlayers).flat()]) {
    delete row.statsPower
    delete row.diagnostics
  }
  assert.doesNotThrow(() => parsePublicPlayerDirectory(old))

  type RawSummary = Record<string, unknown> & { metrics: Record<string, Record<string, unknown>> }
  const corrupt = (path: 'players' | 'season', change: (summary: RawSummary) => void, message: RegExp) => {
    const copy = structuredClone(directory)
    const row = path === 'players' ? copy.players[0] : copy.scopedPlayers['2026__All__All'][0]
    delete row.diagnostics
    change(row.statsPower)
    assert.throws(() => parsePublicPlayerDirectory(copy), message)
  }
  corrupt('players', (summary) => { summary.score = null }, /statsPower score/)
  corrupt('season', (summary) => { summary.version = 'stats-power-v0' }, /statsPower version/)
  const firstMetric = (summary: RawSummary) => summary.metrics[Object.keys(summary.metrics)[0]!]!
  corrupt('season', (summary) => { delete summary.metrics[Object.keys(summary.metrics)[0]!] }, /metrics must match the role policy/)
  corrupt('players', (summary) => { firstMetric(summary).missing = 3 }, /coverage must match eligibleGames/)
  corrupt('season', (summary) => { summary.priorOnly = true }, /statsPower priorOnly/)
  corrupt('players', (summary) => { firstMetric(summary).effectiveGames = 99 }, /effectiveGames must fit/)
  corrupt('season', (summary) => { summary.role = summary.role === 'Top' ? 'Mid' : 'Top' }, /statsPower role/)
})


test('fixed player event weights keep the production team defaults', () => {
  const minor = game('minor-weight', '2026-03-01', evenEdge('Alpha', true), evenEdge('Beta', false), {
    tier: 'minor-international', event: 'Regional cup',
  })
  near(eventWeightForMatch(minor), 23 / 14, 'production minor-international weight')
  near(eventWeightForMatch(minor, undefined, statsPowerPolicy.eventWeights), 22 / 14, 'accepted player minor-international weight')
  const worlds = { ...minor, tier: 'worlds-playoffs' as const, event: 'Worlds', league: 'Worlds' }
  near(eventWeightForMatch(worlds), 39 / 14, 'production Worlds weight')
  near(eventWeightForMatch(worlds, undefined, statsPowerPolicy.eventWeights), 39 / 14, 'player Worlds weight')
})

test('player scoring ignores ambient team event-weight changes', () => {
  const matches = [
    game('minor-lead', '2026-03-01', evenEdge('Alpha', true), evenEdge('Beta', false), { tier: 'minor-international' }),
    game('regular-loss', '2026-03-02', evenEdge('Alpha', false), evenEdge('Beta', true)),
  ]
  const expected = buildPlayerStatsPower(matches, { teams }, noRatings)
  const original = eventTierConfig['minor-international'].weight
  try {
    eventTierConfig['minor-international'].weight = original * 10
    near(eventWeightForMatch(matches[0]!), original * 10, 'ordinary team weight changes')
    assert.deepEqual(buildPlayerStatsPower(matches, { teams }, noRatings), expected)
  } finally {
    eventTierConfig['minor-international'].weight = original
  }
})
