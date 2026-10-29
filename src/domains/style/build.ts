import type { MatchRecord, MatchRosterSnapshot, PlayerGameStats } from '../rankings/types.ts'
import { compareCodeUnits } from '../../shared/codeUnitOrder.mjs'
import { PLAYER_METRICS, TEAM_METRICS, type PlayerMetricKey, type TeamMetricKey } from './metrics.ts'
import {
  DEFINITION_VERSION, ROLES, SAMPLE_RULES, STYLE_SCOPES, STYLE_VERSION, playerKey,
  type ObservedMean, type PlayerStyleRow, type ScopeProfiles, type StyleProfileArtifact, type TeamStyleRow,
} from './model.ts'

type Total = { sum: number; games: number }
type Accumulated<T> = { row: T; totals: Map<string, Total> }
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0
const integer = (value: unknown): value is number => nonnegative(value) && Number.isSafeInteger(value)
const share = (value: unknown): value is number => nonnegative(value) && value <= 1
const leagueName = (value: string | undefined) => value?.trim() || null

function complete(roster: MatchRosterSnapshot | undefined): roster is MatchRosterSnapshot {
  return Boolean(roster?.sourceProvider === 'oracles-elixir' && roster.completeness === 'complete-five-role'
    && roster.players.length === 5 && new Set(roster.players.map(player => player.id)).size === 5
    && ROLES.every(role => roster.players.filter(player => player.role === role).length === 1)
    && roster.players.every(player => player.id?.trim() && player.name?.trim() && player.stats))
}
function add(totals: Map<string, Total>, key: string, value: number | undefined) {
  if (value === undefined) return
  const total = totals.get(key) ?? { sum: 0, games: 0 }
  total.sum += value
  total.games++
  totals.set(key, total)
}
function means<K extends string>(totals: Map<string, Total>, keys: readonly K[]): Partial<Record<K, ObservedMean>> {
  const observed: Partial<Record<K, ObservedMean>> = {}
  for (const key of keys) {
    const total = totals.get(key)
    if (total) observed[key] = { mean: total.sum / total.games, games: total.games }
  }
  return observed
}
function playerValues(stats: PlayerGameStats, minutes: number | undefined): Partial<Record<PlayerMetricKey, number>> {
  const values: Partial<Record<PlayerMetricKey, number>> = {}
  for (const key of ['goldDiffAt15', 'xpDiffAt15', 'csDiffAt15'] as const) {
    if (finite(stats[key])) values[key] = stats[key]
  }
  if (minutes !== undefined) {
    for (const key of ['damagePerMinute', 'csPerMinute', 'wardsPlacedPerMinute', 'wardsClearedPerMinute', 'vspm'] as const) {
      if (nonnegative(stats[key])) values[key] = stats[key]
    }
    if (integer(stats.deaths)) values.deathsPerMinute = stats.deaths / minutes
  }
  if (share(stats.killParticipation)) values.killParticipation = stats.killParticipation
  if (share(stats.damageShare) && share(stats.earnedGoldShare)) values.damageGoldShareGap = stats.damageShare - stats.earnedGoldShare
  return values
}

function buildScope(matches: readonly MatchRecord[]): ScopeProfiles {
  const table: ScopeProfiles = {
    through: null, countedGames: 0, excludedGames: 0,
    excludedByReason: { 'other-provider': 0, 'incomplete-pair': 0, 'missing-team-id': 0 }, players: [], teams: [],
  }
  const players = new Map<string, Accumulated<PlayerStyleRow>>()
  const teams = new Map<string, Accumulated<TeamStyleRow>>()
  for (const match of matches) {
    const a = match.teamARoster
    const b = match.teamBRoster
    const reason = match.sourceProvider !== 'oracles-elixir' ? 'other-provider'
      : !complete(a) || !complete(b) || new Set([...a.players, ...b.players].map(player => player.id)).size !== 10
        ? 'incomplete-pair' : !a.teamId?.trim() || !b.teamId?.trim() || a.teamId === b.teamId ? 'missing-team-id' : undefined
    if (reason) {
      table.excludedGames++
      table.excludedByReason[reason]++
      continue
    }
    table.countedGames++
    table.through = match.date
    const seconds = match.gameLengthSeconds
    const minutes = finite(seconds) && seconds >= SAMPLE_RULES.minGameSeconds && seconds <= SAMPLE_RULES.maxGameSeconds ? seconds / 60 : undefined
    for (const side of ['A', 'B'] as const) {
      const roster = match[`team${side}Roster`]!
      const id = roster.teamId!
      const name = match[`team${side}`]
      const homeLeague = leagueName(match[`team${side}HomeLeague`])
      const team: Accumulated<TeamStyleRow> = teams.get(id) ?? { row: { id, name, league: homeLeague, games: 0, observed: {}, durationWins: {} }, totals: new Map() }
      team.row.name = name
      if (homeLeague !== null) team.row.league = homeLeague
      team.row.games++
      const values: Partial<Record<TeamMetricKey, number>> = {}
      if (minutes !== undefined) {
        values.gameMinutes = minutes
        const kills = match[`team${side}Kills`]
        const opponentKills = match[`team${side === 'A' ? 'B' : 'A'}Kills`]
        if (integer(kills)) values.teamKillsPerMinute = kills / minutes
        if (integer(kills) && integer(opponentKills)) values.combinedKillsPerMinute = (kills + opponentKills) / minutes
        if (match.winner === match.teamA || match.winner === match.teamB) {
          const bin = minutes < 25 ? 'under25' : minutes < 35 ? '25to35' : '35plus'
          const result = team.row.durationWins[bin] ?? [0, 0]
          result[0] += Number(match.winner === name)
          result[1]++
          team.row.durationWins[bin] = result
        } else throw new Error(`Game ${match.id} has no recorded winner`)
      }
      for (const [field, key] of [['Towers', 'towersPerGame'], ['Dragons', 'dragonsPerGame'], ['Barons', 'baronsPerGame']] as const) {
        const value = match[`team${side}${field}`]
        if (integer(value)) values[key] = value
      }
      const gold = roster.players.map(player => player.stats!.goldDiffAt15)
      if (gold.every(finite)) values.fullTeamGoldDiffAt15 = gold.reduce((sum, value) => sum + value, 0)
      for (const [key, value] of Object.entries(values)) add(team.totals, key, value)
      teams.set(id, team)
      for (const appearance of roster.players) {
        const key = playerKey(appearance)
        const player: Accumulated<PlayerStyleRow> = players.get(key) ?? { row: { id: appearance.id, name: appearance.name, role: appearance.role,
          teamId: id, team: name, league: homeLeague, games: 0, observed: {} }, totals: new Map() }
        Object.assign(player.row, { name: appearance.name, teamId: id, team: name, league: homeLeague })
        player.row.games++
        for (const [metric, value] of Object.entries(playerValues(appearance.stats!, minutes))) add(player.totals, metric, value)
        players.set(key, player)
      }
    }
  }
  table.players = [...players.values()].map(({ row, totals }) => ({ ...row, observed: means(totals, PLAYER_METRICS.map(metric => metric.key)) }))
    .sort((a, b) => compareCodeUnits(playerKey(a), playerKey(b)))
  table.teams = [...teams.values()].map(({ row, totals }) => ({ ...row, observed: means(totals, TEAM_METRICS.map(metric => metric.key)) }))
    .sort((a, b) => compareCodeUnits(a.id, b.id))
  return table
}

export function buildStyleProfiles(matches: readonly MatchRecord[], sourceSha256: string): StyleProfileArtifact {
  const sorted = [...matches].sort((a, b) => compareCodeUnits(a.date, b.date)
    || compareCodeUnits(a.datetimeUtc ?? '', b.datetimeUtc ?? '') || compareCodeUnits(a.id, b.id))
  if (new Set(sorted.map(match => match.id)).size !== sorted.length) throw new Error('Duplicate style input game identity')
  const scopes = Object.fromEntries(STYLE_SCOPES.map(scope => [scope,
    buildScope(scope === 'all' ? sorted : sorted.filter(match => match.date.slice(0, 4) === scope.slice(7))),
  ])) as StyleProfileArtifact['scopes']
  return { version: STYLE_VERSION, definitionVersion: DEFINITION_VERSION, sourceSha256,
    through: sorted.at(-1)?.date ?? null, sampleRules: SAMPLE_RULES, scopes }
}
