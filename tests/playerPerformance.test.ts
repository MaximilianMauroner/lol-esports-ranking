import assert from 'node:assert/strict'
import test from 'node:test'
import { auditPlayerPerformance } from '../scripts/audit-player-performance.ts'
import { importOraclesElixirCsv } from '../src/lib/importers/oraclesElixir.ts'
import { buildPlayerModel, buildRankingModel } from '../src/lib/model.ts'
import { createPlayerPerformanceAccumulator, recordPlayerPerformance, summarizePlayerPerformance } from '../src/lib/playerPerformance.ts'
import { parsePublicPlayerDirectory } from '../src/lib/publicArtifacts/schema.ts'
import { createPlayerDirectory, createStaticRankingData, snapshotKey } from '../src/lib/snapshot.ts'
import type { MatchRecord, PlayerGameStats, Role } from '../src/types.ts'
import { sampleMatches, teams } from './fixtures/rankingFixtures.ts'

const stats: PlayerGameStats = { side: 'blue', won: true, kills: 2, deaths: 1, assists: 3 }

function importStats(overrides: Record<string, string> = {}) {
  const row = {
    gameid: 'performance-fixture', date: '2026-01-01', year: '2026', league: 'LPL',
    position: 'top', side: 'Blue', playername: 'Player', playerid: 'fixture-player',
    teamname: 'T1', result: '1', kills: '2', assists: '3', teamkills: '10',
    gamelength: '1800', golddiffat15: '-100', xpdiffat15: '0', csdiffat15: '5',
    damageshare: '0.3', earnedgoldshare: '0.2', dpm: '500', cspm: '8', wpm: '0', wcpm: '0.25',
    ...overrides,
  }
  const keys = Object.keys(row)
  const rows = [
    { ...row, position: 'team' },
    { ...row, position: 'team', side: 'Red', teamname: 'Gen.G', result: '0' },
    row,
  ]
  const csv = [keys.join(','), ...rows.map((entry) => keys.map((key) => (entry as Record<string, string>)[key]).join(','))].join('\n')
  return importOraclesElixirCsv(csv).matches[0]
}

test('Oracle imports signed differences and real zeros while excluding missing and invalid rates', () => {
  const imported = importStats().teamARoster!.players[0].stats!
  assert.equal(imported.killParticipation, 0.5)
  assert.equal(imported.goldDiffAt15, -100)
  assert.equal(imported.xpDiffAt15, 0)
  assert.equal(imported.csDiffAt15, 5)
  assert.equal(imported.wardsPlacedPerMinute, 0)
  const missing = importStats({ golddiffat15: '', xpdiffat15: ' ', csdiffat15: 'bad', dpm: 'Infinity', cspm: '-1', wpm: 'NaN', wcpm: '' }).teamARoster!.players[0].stats!
  for (const key of ['goldDiffAt15', 'xpDiffAt15', 'csDiffAt15', 'damagePerMinute', 'csPerMinute', 'wardsPlacedPerMinute', 'wardsClearedPerMinute'] as const) assert.equal(missing[key], undefined)
  assert.equal(importStats({ gamelength: '14:59' }).teamARoster!.players[0].stats!.goldDiffAt15, undefined)
})

test('KP requires valid source kills, assists, and positive team kills without impossible participation', () => {
  const cases: Record<string, string>[] = [{ teamkills: '0' }, { teamkills: '' }, { teamkills: '4' }, { kills: '' }, { assists: ' ' }, { kills: '-1' }]
  for (const fields of cases) {
    assert.equal(importStats(fields).teamARoster!.players[0].stats!.killParticipation, undefined)
  }
  assert.equal(importStats({ kills: '0', assists: '0' }).teamARoster!.players[0].stats!.killParticipation, 0)
})

test('performance averages paired observations rather than mismatched means or pooled KP', () => {
  const accumulator = createPlayerPerformanceAccumulator()
  recordPlayerPerformance(accumulator, { ...stats, damageShare: 0.3, earnedGoldShare: 0.2, killParticipation: 0.5, goldDiffAt15: 0 })
  recordPlayerPerformance(accumulator, { ...stats, damageShare: 0.9, killParticipation: 0.8, goldDiffAt15: -200 })
  recordPlayerPerformance(accumulator, { ...stats, earnedGoldShare: 0.5 })
  const summary = summarizePlayerPerformance(accumulator, 3)
  assert.deepEqual(summary.metrics.damageGoldShareGap, { value: 0.1, games: 1, missing: 2 })
  assert.deepEqual(summary.metrics.killParticipation, { value: 0.65, games: 2, missing: 1 })
  assert.deepEqual(summary.metrics.goldDiffAt15, { value: -100, games: 2, missing: 1 })
  assert.deepEqual(summary.metrics.xpDiffAt15, { value: null, games: 0, missing: 3 })
  assert.equal(summary.ratingEffect, 'none')
})

test('invalid share/rate observations stay unavailable and valid zero shares are preserved', () => {
  const accumulator = createPlayerPerformanceAccumulator()
  recordPlayerPerformance(accumulator, { ...stats, damageShare: 0, earnedGoldShare: 0, damagePerMinute: 0 })
  recordPlayerPerformance(accumulator, { ...stats, damageShare: 1.1, earnedGoldShare: 0.2, damagePerMinute: -3, xpDiffAt15: NaN, killParticipation: 2 })
  const { metrics } = summarizePlayerPerformance(accumulator, 2)
  assert.deepEqual(metrics.damageGoldShareGap, { value: 0, games: 1, missing: 1 })
  assert.deepEqual(metrics.damagePerMinute, { value: 0, games: 1, missing: 1 })
  assert.deepEqual(metrics.killParticipation, { value: null, games: 0, missing: 2 })
})

function sourcedMatches(observed: boolean): MatchRecord[] {
  const roles: Role[] = ['Top', 'Jungle', 'Mid', 'Bot', 'Support']
  return Array.from({ length: 24 }, (_, i) => {
    const date = `2026-01-${String(i + 1).padStart(2, '0')}`
    const match: MatchRecord = {
      ...sampleMatches[0], id: `performance-${i}`, sourceProvider: 'oracles-elixir', sourceGameId: `performance-${i}`,
      date, event: 'LCK 2026 Spring', season: 2026, winner: i % 2 ? 'T1' : 'Gen.G',
      teamA: 'Gen.G', teamB: 'T1', bestOf: 1,
    }
    for (const side of ['A', 'B'] as const) {
      const team = side === 'A' ? match.teamA : match.teamB
      match[side === 'A' ? 'teamARoster' : 'teamBRoster'] = {
        completeness: 'complete-five-role', observedAt: date, sourceProvider: 'oracles-elixir',
        players: roles.map((role) => ({
          id: `${team}-${role}`, name: `${team}-${role}`, role,
          stats: {
            ...stats, side: side === 'A' ? 'blue' : 'red', won: match.winner === team,
            damageShare: 0.2, earnedGoldShare: 0.2, vspm: 1,
            ...(observed ? { killParticipation: 0.5, goldDiffAt15: i * 10, xpDiffAt15: -i, csDiffAt15: 0, damagePerMinute: 600, csPerMinute: 7, wardsPlacedPerMinute: 1, wardsClearedPerMinute: 0.3 } : {}),
          },
        })),
      }
    }
    return match
  })
}

test('new stats affect diagnostics but never player/team ranks, residuals, or predictions', () => {
  const missing = sourcedMatches(false)
  const observed = sourcedMatches(true)
  const missingPlayers = buildPlayerModel(missing, {}, { teams })
  const observedPlayers = buildPlayerModel(observed, {}, { teams })
  const omitDiagnostics = (player: (typeof missingPlayers)[number]) => {
    const copy = { ...player }
    delete copy.diagnostics
    return copy
  }
  assert.deepEqual(observedPlayers.map(omitDiagnostics), missingPlayers.map(omitDiagnostics))
  assert.equal(observedPlayers[0].diagnostics!.performance!.metrics.goldDiffAt15.games, 24)
  assert.equal(missingPlayers[0].diagnostics!.performance!.metrics.goldDiffAt15.value, null)
  const baseline = buildRankingModel(missing, teams)
  const candidate = buildRankingModel(observed, teams)
  assert.deepEqual(candidate.predictions, baseline.predictions)
  assert.deepEqual(candidate.standings, baseline.standings)
  assert.deepEqual(candidate.leagues, baseline.leagues)
})

test('public player artifacts retain coverage in default and season scopes and reject corrupt metrics', () => {
  const data = createStaticRankingData({ matches: sourcedMatches(true), teams, rosters: {}, source: 'Explicit synthetic test fixture', generatedAt: '2026-02-01T00:00:00Z' })
  const directory = JSON.parse(JSON.stringify(createPlayerDirectory(data)))
  const parsed = parsePublicPlayerDirectory(directory)
  assert.ok(parsed.players.length > 0)
  assert.equal(parsed.players[0].diagnostics!.performance!.metrics.goldDiffAt15.games, 24)
  const scope = parsed.scopedPlayers![snapshotKey({ season: '2026', event: 'All', region: 'All' })]
  assert.equal(scope[0].diagnostics!.performance!.metrics.goldDiffAt15.games, 24)
  const withoutStats = structuredClone(directory)
  delete withoutStats.players[0].diagnostics
  assert.doesNotThrow(() => parsePublicPlayerDirectory(withoutStats))
  directory.players[0].diagnostics.performance.metrics.goldDiffAt15.missing = 1
  assert.throws(() => parsePublicPlayerDirectory(directory), /coverage must match/)
  directory.players[0].diagnostics.performance.metrics.goldDiffAt15.missing = 0
  directory.players[0].diagnostics.performance.metrics.killParticipation.value = 2
  assert.throws(() => parsePublicPlayerDirectory(directory), /participation range/)
})

test('coverage audit counts normalized observations, retains LPL-style gaps, and rejects duplicates', () => {
  const match = importStats({ golddiffat15: '', xpdiffat15: '', csdiffat15: '' })
  const [group] = auditPlayerPerformance([match])
  assert.equal(group.playerRows, 1)
  assert.deepEqual(group.metrics.goldDiffAt15, { observed: 0, missing: 1 })
  assert.deepEqual(group.metrics.killParticipation, { observed: 1, missing: 0 })
  assert.throws(() => auditPlayerPerformance([match, match]), /Duplicate Oracle game/)
})
