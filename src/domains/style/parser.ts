import { PLAYER_METRICS, TEAM_METRICS } from './metrics.ts'
import {
  DEFINITION_VERSION, DURATION_BINS, ROLES, SAMPLE_RULES, STYLE_SCOPES, STYLE_VERSION, playerKey,
  type StyleProfileArtifact,
} from './model.ts'

function requireValue(condition: unknown, path: string): asserts condition {
  if (!condition) throw new Error(`Invalid style profiles at ${path}`)
}
function record(value: unknown, path: string): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), path)
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: readonly string[], path: string) {
  requireValue(Object.keys(value).every(key => allowed.includes(key)), path)
}
function text(value: unknown, path: string): asserts value is string {
  requireValue(typeof value === 'string' && value.trim().length > 0, path)
}
function count(value: unknown, path: string, min = 0): asserts value is number {
  requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value >= min, path)
}
function date(value: unknown, path: string) {
  requireValue(value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value), path)
}
function rows(value: unknown, kind: 'player' | 'team', path: string) {
  requireValue(Array.isArray(value), path)
  const ids = new Set<string>()
  const metricKeys = (kind === 'player' ? PLAYER_METRICS : TEAM_METRICS).map(metric => metric.key)
  let games = 0
  for (const [i, raw] of value.entries()) {
    const p = `${path}[${i}]`
    const row = record(raw, p)
    keys(row, kind === 'player'
      ? ['id', 'name', 'role', 'teamId', 'team', 'league', 'games', 'observed']
      : ['id', 'name', 'league', 'games', 'observed', 'durationWins'], p)
    text(row.id, `${p}.id`)
    text(row.name, `${p}.name`)
    count(row.games, `${p}.games`, 1)
    games += row.games
    requireValue(row.league === null || (typeof row.league === 'string' && row.league.trim().length > 0), `${p}.league`)
    if (kind === 'player') {
      requireValue(ROLES.includes(row.role as typeof ROLES[number]), `${p}.role`)
      text(row.teamId, `${p}.teamId`)
      text(row.team, `${p}.team`)
    }
    const id = kind === 'player' ? playerKey(row as unknown as Parameters<typeof playerKey>[0]) : row.id
    requireValue(!ids.has(id), `${p}.duplicateIdentity`)
    ids.add(id)
    const observed = record(row.observed, `${p}.observed`)
    keys(observed, metricKeys, `${p}.observed`)
    for (const [key, rawMean] of Object.entries(observed)) {
      const m = `${p}.observed.${key}`
      const mean = record(rawMean, m)
      keys(mean, ['mean', 'games'], m)
      requireValue(typeof mean.mean === 'number' && Number.isFinite(mean.mean), `${m}.mean`)
      count(mean.games, `${m}.games`, 1)
      requireValue(mean.games <= row.games, `${m}.games`)
      if (key === 'killParticipation') requireValue(mean.mean >= 0 && mean.mean <= 1, m)
      else if (key === 'damageGoldShareGap') requireValue(mean.mean >= -1 && mean.mean <= 1, m)
      else if (!['goldDiffAt15', 'xpDiffAt15', 'csDiffAt15', 'fullTeamGoldDiffAt15'].includes(key)) {
        requireValue(mean.mean >= 0, m)
      }
      if (key === 'gameMinutes') requireValue(mean.mean >= 10 && mean.mean <= 90, m)
    }
    if (kind === 'team') {
      const bins = record(row.durationWins, `${p}.durationWins`)
      keys(bins, DURATION_BINS.map(bin => bin.key), `${p}.durationWins`)
      let binGames = 0
      for (const [bin, result] of Object.entries(bins)) {
        requireValue(Array.isArray(result) && result.length === 2, `${p}.${bin}`)
        count(result[0], `${p}.${bin}.wins`)
        count(result[1], `${p}.${bin}.games`, 1)
        requireValue(result[0] <= result[1], `${p}.${bin}.wins`)
        binGames += result[1]
      }
      requireValue(binGames === (observed.gameMinutes as { games?: number } | undefined)?.games
        || (binGames === 0 && !observed.gameMinutes), `${p}.durationCoverage`)
    }
  }
  return games
}

export function parseStyleProfileArtifact(input: unknown): StyleProfileArtifact {
  const root = record(input, 'root')
  keys(root, ['version', 'definitionVersion', 'sourceSha256', 'through', 'sampleRules', 'scopes'], 'root')
  requireValue(root.version === STYLE_VERSION, 'version')
  requireValue(root.definitionVersion === DEFINITION_VERSION, 'definitionVersion')
  requireValue(typeof root.sourceSha256 === 'string' && /^[a-f0-9]{64}$/.test(root.sourceSha256), 'sourceSha256')
  date(root.through, 'through')
  const rules = record(root.sampleRules, 'sampleRules')
  keys(rules, Object.keys(SAMPLE_RULES), 'sampleRules')
  for (const [key, value] of Object.entries(SAMPLE_RULES)) requireValue(rules[key] === value, `sampleRules.${key}`)
  const scopes = record(root.scopes, 'scopes')
  keys(scopes, STYLE_SCOPES, 'scopes')
  for (const scope of STYLE_SCOPES) {
    const table = record(scopes[scope], scope)
    keys(table, ['through', 'countedGames', 'excludedGames', 'excludedByReason', 'players', 'teams'], scope)
    date(table.through, `${scope}.through`)
    count(table.countedGames, `${scope}.countedGames`)
    count(table.excludedGames, `${scope}.excludedGames`)
    requireValue(table.through === null ? table.countedGames === 0
      : typeof root.through === 'string' && String(table.through) <= root.through, `${scope}.through`)
    const excluded = record(table.excludedByReason, `${scope}.excludedByReason`)
    const reasons = ['other-provider', 'incomplete-pair', 'missing-team-id']
    keys(excluded, reasons, `${scope}.excludedByReason`)
    let excludedGames = 0
    for (const reason of reasons) {
      count(excluded[reason], `${scope}.${reason}`)
      excludedGames += excluded[reason]
    }
    requireValue(excludedGames === table.excludedGames, `${scope}.excludedGames`)
    requireValue(rows(table.players, 'player', `${scope}.players`) === table.countedGames * 10, `${scope}.playerCoverage`)
    requireValue(rows(table.teams, 'team', `${scope}.teams`) === table.countedGames * 2, `${scope}.teamCoverage`)
  }
  return input as StyleProfileArtifact
}
