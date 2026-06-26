import type { MatchRecord, Region, TeamProfile } from '../../types'
import { regionForLeague, teamIdentityFor } from '../../data/teamIdentity'

type CsvRecord = Record<string, string>

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

  const blueTeam = value(blue, 'teamname')
  const redTeam = value(red, 'teamname')
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

  return {
    id: `oe-${gameId}`,
    sourceProvider: 'oracles-elixir',
    sourceGameId: gameId,
    sourceUrl: options.sourceUrl || value(first, 'url'),
    sourceFileName: options.sourceFileName,
    dataCompleteness: value(first, 'datacompleteness') || undefined,
    date: normalizeDate(value(first, 'date')),
    season: year || new Date().getUTCFullYear(),
    event: event || league,
    phase: playoffs ? 'Playoffs' : 'Regular season',
    region: leagueToRegion(league),
    league,
    teamAHomeLeague: blueIdentity?.league ?? homeLeague,
    teamBHomeLeague: redIdentity?.league ?? homeLeague,
    teamARegion: blueIdentity?.region ?? homeRegion,
    teamBRegion: redIdentity?.region ?? homeRegion,
    teamASide: 'blue',
    teamBSide: 'red',
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

function upsertTeam(teams: Record<string, TeamProfile>, teamName: string, league: string, region: Region) {
  const identity = teamIdentityFor(teamName)
  if (identity) {
    teams[teamName] = identity
    return
  }

  const current = teams[teamName]
  if (!current) {
    teams[teamName] = {
      name: teamName,
      code: makeTeamCode(teamName),
      region,
      league,
    }
    return
  }

  if (current.league === 'Unknown' && league !== 'Unknown') {
    teams[teamName] = { ...current, league, region }
  }
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

function sum(rows: CsvRecord[], key: string) {
  return rows.reduce((total, row) => total + numberValue(row, key), 0)
}

function normalizeDate(valueToNormalize: string) {
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
  return normalized.includes('MSI') || normalized.includes('WORLD') || normalized === 'WLD' || normalized === 'WLDs'.toUpperCase()
}

function inferTier(league: string, event: string, playoffs: boolean): MatchRecord['tier'] {
  const text = `${league} ${event}`.toLowerCase()
  if (text.includes('world') && playoffs) return 'worlds-playoffs'
  if (text.includes('world')) return 'worlds-main'
  if (text.includes('msi') && playoffs) return 'msi-bracket'
  if (text.includes('msi')) return 'msi-play-in'
  if (text.includes('emea masters') || text.includes('minor')) return 'minor-international'
  if (playoffs) return 'major-playoffs'
  return 'regional-regular'
}

function bestOfForGame(row: CsvRecord, playoffs: boolean) {
  const explicit = numberValue(row, 'bestof') || numberValue(row, 'best_of') || numberValue(row, 'matchgames')
  if ([1, 2, 3, 5].includes(explicit)) return explicit
  return playoffs ? 5 : 1
}

function makeTeamCode(teamName: string) {
  return teamName
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 4)
    .toUpperCase()
}

function gameLengthSeconds(raw: string) {
  if (!raw) return undefined
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw))
  const [minutes, seconds] = raw.split(':').map(Number)
  if (Number.isFinite(minutes) && Number.isFinite(seconds)) return minutes * 60 + seconds
  return undefined
}
