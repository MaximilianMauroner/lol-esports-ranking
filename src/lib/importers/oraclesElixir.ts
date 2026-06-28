import type { MatchRecord, MatchRosterSnapshot, Region, Role, RosterCompleteness, RosterPlayerAppearance, TeamProfile } from '../../types'
import { canonicalTeamNameFor, regionForLeague, teamCodeFor, teamIdentityFor } from '../../data/teamIdentity'

type CsvRecord = Record<string, string>

const exactOraclePlayerIdAliases: Record<string, string> = {
  // Oracle split the same MVK/MGN top-laner across 2025/2026 LCP rows.
  'oe:player:fa6ab005227d25bf19d02ca58f00cab': 'oe:player:75019a36fdf85666fbd9396ae4fc7ec',
  // Oracle split the same New Meta top-laner across adjacent 2026 LJL splits.
  'oe:player:ec32405553073660d757af1100d45b7': 'oe:player:0a86dddc699c7e6fe7f1e43153a5cbe',
}

export type OracleImportResult = {
  matches: MatchRecord[]
  teams: Record<string, TeamProfile>
  source: {
    name: string
    url?: string
    fileName?: string
    retrievedAt: string
    gameCount: number
    attribution: string
  }
}

export function importOraclesElixirCsv(
  csvText: string,
  options: {
    sourceUrl?: string
    sourceFileName?: string
    retrievedAt?: string
  } = {},
): OracleImportResult {
  const records = parseCsv(csvText)
  const byGame = new Map<string, CsvRecord[]>()

  for (const record of records) {
    const gameId = value(record, 'gameid')
    if (!gameId) continue
    byGame.set(gameId, [...(byGame.get(gameId) ?? []), record])
  }

  const matches: MatchRecord[] = []
  const teams: Record<string, TeamProfile> = {}

  for (const [gameId, rows] of byGame.entries()) {
    const match = normalizeGame(gameId, rows, options)
    if (!match) continue
    matches.push(match)

    upsertTeam(teams, match.teamA, match.teamAHomeLeague ?? 'Unknown', match.teamARegion ?? 'International')
    upsertTeam(teams, match.teamB, match.teamBHomeLeague ?? 'Unknown', match.teamBRegion ?? 'International')
  }

  return {
    matches: matches.sort((a, b) => a.date.localeCompare(b.date)),
    teams,
    source: {
      name: "Oracle's Elixir CSV",
      url: options.sourceUrl,
      fileName: options.sourceFileName,
      retrievedAt: options.retrievedAt ?? new Date().toISOString(),
      gameCount: matches.length,
      attribution: "Aggregated by Oracle's Elixir / Tim Sevenhuysen. Subject to Riot game-data policies.",
    },
  }
}

function normalizeGame(
  gameId: string,
  rows: CsvRecord[],
  options: { sourceUrl?: string; sourceFileName?: string },
): MatchRecord | null {
  const first = rows[0]
  if (!first) return null

  const teamRows = rows.filter((row) => value(row, 'position').toLowerCase() === 'team')
  const sides = teamRows.length >= 2 ? teamRows : aggregateTeamRows(rows)
  const blue = sides.find((row) => value(row, 'side').toLowerCase() === 'blue') ?? sides[0]
  const red = sides.find((row) => value(row, 'side').toLowerCase() === 'red') ?? sides[1]
  if (!blue || !red) return null

  const blueTeam = canonicalTeamNameFor(value(blue, 'teamname'))
  const redTeam = canonicalTeamNameFor(value(red, 'teamname'))
  if (!blueTeam || !redTeam) return null

  const blueResult = numberValue(blue, 'result')
  const redResult = numberValue(red, 'result')
  const winner = blueResult === 1 ? blueTeam : redResult === 1 ? redTeam : ''
  if (!winner) return null

  const league = value(first, 'league') || 'Unknown'
  const year = numberValue(first, 'year') || yearFromDate(value(first, 'date'))
  const split = value(first, 'split')
  const event = [league, year || undefined, split].filter(Boolean).join(' ')
  const playoffs = numberValue(first, 'playoffs') === 1
  const patch = value(first, 'patch')
  const blueIdentity = teamIdentityFor(blueTeam)
  const redIdentity = teamIdentityFor(redTeam)
  const homeLeague = competitionOnlyLeague(league) ? undefined : league
  const homeRegion = homeLeague ? leagueToRegion(homeLeague) : undefined
  const blueHomeLeague = importedSideHomeLeague(league, homeLeague, blueIdentity)
  const redHomeLeague = importedSideHomeLeague(league, homeLeague, redIdentity)
  const blueRegion = importedSideRegion(league, homeRegion, blueHomeLeague, blueIdentity)
  const redRegion = importedSideRegion(league, homeRegion, redHomeLeague, redIdentity)
  const date = normalizeDate(value(first, 'date'))

  return {
    id: `oe-${gameId}`,
    sourceProvider: 'oracles-elixir',
    sourceGameId: gameId,
    sourceUrl: options.sourceUrl || value(first, 'url'),
    sourceFileName: options.sourceFileName,
    dataCompleteness: value(first, 'datacompleteness') || undefined,
    date,
    season: year || new Date().getUTCFullYear(),
    event: event || league,
    phase: playoffs ? 'Playoffs' : 'Regular season',
    region: leagueToRegion(league),
    league,
    teamAHomeLeague: blueHomeLeague,
    teamBHomeLeague: redHomeLeague,
    teamARegion: blueRegion,
    teamBRegion: redRegion,
    teamASide: 'blue',
    teamBSide: 'red',
    teamARoster: rosterForSide(rows, 'blue', date),
    teamBRoster: rosterForSide(rows, 'red', date),
    patch,
    bestOf: bestOfForGame(first, playoffs),
    tier: inferTier(league, event, playoffs),
    teamA: blueTeam,
    teamB: redTeam,
    winner,
    teamAKills: numberValue(blue, 'kills') || numberValue(blue, 'teamkills') || 0,
    teamBKills: numberValue(red, 'kills') || numberValue(red, 'teamkills') || 0,
    teamAGold: numberValue(blue, 'totalgold') || numberValue(blue, 'earnedgold') || 0,
    teamBGold: numberValue(red, 'totalgold') || numberValue(red, 'earnedgold') || 0,
    teamATowers: numberValue(blue, 'towers'),
    teamBTowers: numberValue(red, 'towers'),
    teamADragons: numberValue(blue, 'dragons'),
    teamBDragons: numberValue(red, 'dragons'),
    teamABarons: numberValue(blue, 'barons'),
    teamBBarons: numberValue(red, 'barons'),
    gameLengthSeconds: gameLengthSeconds(value(first, 'gamelength')),
  }
}

function rosterForSide(rows: CsvRecord[], side: string, observedAt: string): MatchRosterSnapshot | undefined {
  const sideRows = rows.filter((row) => value(row, 'side').toLowerCase() === side.toLowerCase() && value(row, 'position').toLowerCase() !== 'team')
  const players: RosterPlayerAppearance[] = []
  const seenRoles = new Set<Role>()

  for (const row of sideRows) {
    const role = roleForOraclePosition(value(row, 'position'))
    const name = value(row, 'playername')
    const id = canonicalOraclePlayerIdFor(row)
    if (!role || !id || seenRoles.has(role)) continue
    players.push({
      id,
      name: name || id,
      role,
      stats: playerStatsFor(row, side),
    })
    seenRoles.add(role)
  }

  if (players.length === 0) return undefined

  return {
    sourceProvider: 'oracles-elixir',
    teamId: value(sideRows[0] ?? {}, 'teamid') || undefined,
    observedAt,
    completeness: rosterCompleteness(players),
    players: players.sort((left, right) => roleOrder(left.role) - roleOrder(right.role)),
  }
}

function canonicalOraclePlayerIdFor(row: CsvRecord) {
  const sourceId = value(row, 'playerid')
  if (sourceId) return exactOraclePlayerIdAliases[sourceId] ?? sourceId
  return unresolvedPlayerIdFor(row)
}

function playerStatsFor(row: CsvRecord, side: string) {
  return {
    side: side.toLowerCase() === 'blue' ? 'blue' as const : 'red' as const,
    champion: value(row, 'champion') || undefined,
    won: numberValue(row, 'result') === 1,
    kills: numberValue(row, 'kills'),
    deaths: numberValue(row, 'deaths'),
    assists: numberValue(row, 'assists'),
    totalGold: optionalNumberValue(row, 'totalgold'),
    earnedGold: optionalNumberValue(row, 'earnedgold'),
    damageShare: optionalNumberValue(row, 'damageshare'),
    earnedGoldShare: optionalNumberValue(row, 'earnedgoldshare'),
    visionScore: optionalNumberValue(row, 'visionscore'),
    vspm: optionalNumberValue(row, 'vspm'),
    gpr: optionalNumberValue(row, 'gpr'),
  }
}

function unresolvedPlayerIdFor(row: CsvRecord) {
  const name = value(row, 'playername')
  if (!name) return ''
  const team = value(row, 'teamid') || canonicalTeamNameFor(value(row, 'teamname')) || value(row, 'teamname') || 'unknown-team'
  return `oe:player:unresolved:${stableHash(`${normalizeIdentityPart(name)}\u0000${normalizeIdentityPart(team)}`)}`
}

function normalizeIdentityPart(valueToNormalize: string) {
  return valueToNormalize.trim().toLowerCase().replace(/\s+/g, ' ')
}

function stableHash(input: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function roleForOraclePosition(position: string): Role | undefined {
  switch (position.trim().toLowerCase()) {
    case 'top':
      return 'Top'
    case 'jng':
    case 'jun':
    case 'jungle':
      return 'Jungle'
    case 'mid':
      return 'Mid'
    case 'bot':
    case 'adc':
      return 'Bot'
    case 'sup':
    case 'support':
      return 'Support'
    default:
      return undefined
  }
}

function rosterCompleteness(players: RosterPlayerAppearance[]): RosterCompleteness {
  const roles = new Set(players.map((player) => player.role))
  return players.length === 5 && ['Top', 'Jungle', 'Mid', 'Bot', 'Support'].every((role) => roles.has(role as Role))
    ? 'complete-five-role'
    : 'partial'
}

function roleOrder(role: Role) {
  return ['Top', 'Jungle', 'Mid', 'Bot', 'Support'].indexOf(role)
}

function upsertTeam(teams: Record<string, TeamProfile>, teamName: string, league: string, region: Region) {
  const identity = teamIdentityFor(teamName)
  const hasSourcedLeague = league !== 'Unknown'
  const candidate = {
    name: teamName,
    code: identity?.code ?? makeTeamCode(teamName),
    region,
    league,
  }

  const current = teams[teamName]
  if (!current) {
    teams[teamName] = candidate
    return
  }

  if ((current.league === 'Unknown' || teamIdentityFor(teamName)?.league === current.league) && hasSourcedLeague) {
    teams[teamName] = candidate
  }
}

function importedSideHomeLeague(competitionLeague: string, homeLeague: string | undefined, identity: TeamProfile | undefined) {
  if (homeLeague) return homeLeague
  return shouldUseIdentityForCompetitionFallback(competitionLeague) ? identity?.league : undefined
}

function importedSideRegion(
  competitionLeague: string,
  homeRegion: Region | undefined,
  homeLeague: string | undefined,
  identity: TeamProfile | undefined,
): Region | undefined {
  if (homeRegion) return homeRegion
  if (homeLeague && homeLeague !== 'Unknown') return leagueToRegion(homeLeague)
  return shouldUseIdentityForCompetitionFallback(competitionLeague) ? identity?.region : undefined
}

function shouldUseIdentityForCompetitionFallback(league: string) {
  return competitionOnlyLeague(league) && league.trim().toUpperCase() !== 'LTA'
}

function aggregateTeamRows(rows: CsvRecord[]) {
  const sides = new Map<string, CsvRecord[]>()
  for (const row of rows) {
    const side = value(row, 'side')
    const position = value(row, 'position').toLowerCase()
    if (!side || position === 'team') continue
    sides.set(side, [...(sides.get(side) ?? []), row])
  }

  return Array.from(sides.entries()).map(([side, sideRows]) => {
    const first = sideRows[0] ?? {}
    return {
      ...first,
      side,
      position: 'team',
      kills: sum(sideRows, 'kills').toString(),
      earnedgold: sum(sideRows, 'earnedgold').toString(),
      totalgold: sum(sideRows, 'totalgold').toString(),
      towers: value(first, 'towers'),
      dragons: value(first, 'dragons'),
      barons: value(first, 'barons'),
      result: value(first, 'result'),
      teamname: value(first, 'teamname'),
    }
  })
}

function parseCsv(input: string): CsvRecord[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    const next = input[index + 1]

    if (char === '"' && inQuotes && next === '"') {
      field += '"'
      index += 1
      continue
    }

    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }

    if (char === ',' && !inQuotes) {
      row.push(field)
      field = ''
      continue
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') index += 1
      row.push(field)
      field = ''
      if (row.some((cell) => cell.length > 0)) rows.push(row)
      row = []
      continue
    }

    field += char
  }

  row.push(field)
  if (row.some((cell) => cell.length > 0)) rows.push(row)

  const [headers = [], ...body] = rows
  const normalizedHeaders = headers.map((header) => header.trim().toLowerCase())

  return body.map((cells) =>
    Object.fromEntries(normalizedHeaders.map((header, index) => [header, cells[index]?.trim() ?? ''])),
  )
}

function value(row: CsvRecord, key: string) {
  return row[key.toLowerCase()] ?? ''
}

function numberValue(row: CsvRecord, key: string) {
  const parsed = Number(value(row, key))
  return Number.isFinite(parsed) ? parsed : 0
}

function optionalNumberValue(row: CsvRecord, key: string) {
  const raw = value(row, key)
  if (raw === '') return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

function sum(rows: CsvRecord[], key: string) {
  return rows.reduce((total, row) => total + numberValue(row, key), 0)
}

function normalizeDate(valueToNormalize: string) {
  const sourceDate = valueToNormalize.match(/^\d{4}-\d{2}-\d{2}/)?.[0]
  if (sourceDate) return sourceDate
  const parsed = Date.parse(valueToNormalize)
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10)
  return valueToNormalize.slice(0, 10)
}

function yearFromDate(date: string) {
  const parsed = Number(normalizeDate(date).slice(0, 4))
  return Number.isFinite(parsed) ? parsed : 0
}

function leagueToRegion(league: string): Region {
  return regionForLeague(league)
}

function competitionOnlyLeague(league: string) {
  const normalized = league.toUpperCase()
  return normalized.includes('MSI')
    || normalized.includes('WORLD')
    || normalized.includes('ESPORTS WORLD CUP')
    || normalized.includes('ASIA MASTER')
    || normalized.includes('ASIA MASTERS')
    || normalized.includes('EMEA MASTERS')
    || normalized === 'WLD'
    || normalized === 'WLDS'
    || normalized === 'EWC'
    || normalized === 'FST'
    || normalized === 'ASI'
    || normalized === 'AC'
    || normalized === 'DCUP'
    || normalized === 'KESPA'
    || normalized === 'EM'
    || normalized === 'LTA'
}

function inferTier(league: string, event: string, playoffs: boolean): MatchRecord['tier'] {
  const text = `${league} ${event}`.toLowerCase()
  if (text.includes('academic esports world tournament') || text.includes('university esports')) return 'qualifier'
  if (text.includes('online qualifier') || text.includes('online qualifiers')) return 'qualifier'
  if (/\bdcup\b/.test(text) || text.includes('demacia cup')) return playoffs ? 'major-playoffs' : 'regional-regular'
  if (text.includes('first stand') || /\bfst\b/.test(text)) return 'msi-bracket'
  if (text.includes('emea masters')
    || /\bem\b/.test(text)
    || text.includes('minor')
    || /\bewc\b/.test(text)
    || text.includes('esports world cup')
    || text.includes('asia master')
    || /\basi\b/.test(text)
    || /\bac\b/.test(text)
    || text.includes('kespa')) return 'minor-international'
  if (/\bwlds?\b/.test(text)) return playoffs ? 'worlds-playoffs' : 'worlds-main'
  if (text.includes('world') && playoffs) return 'worlds-playoffs'
  if (text.includes('world')) return 'worlds-main'
  if (text.includes('msi') && playoffs) return 'msi-bracket'
  if (text.includes('msi')) return 'msi-play-in'
  if (playoffs) return 'major-playoffs'
  return 'regional-regular'
}

function bestOfForGame(row: CsvRecord, playoffs: boolean) {
  const explicit = numberValue(row, 'bestof') || numberValue(row, 'best_of') || numberValue(row, 'matchgames')
  if ([1, 2, 3, 5].includes(explicit)) return explicit
  return playoffs ? 5 : 1
}

function makeTeamCode(teamName: string) {
  return teamCodeFor(teamName)
}

function gameLengthSeconds(raw: string) {
  if (!raw) return undefined
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw))
  const [minutes, seconds] = raw.split(':').map(Number)
  if (Number.isFinite(minutes) && Number.isFinite(seconds)) return minutes * 60 + seconds
  return undefined
}
