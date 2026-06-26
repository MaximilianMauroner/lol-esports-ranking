import type { MatchRecord, Region, TeamProfile } from '../../types'
import { regionForLeague, teamIdentityFor } from '../../data/teamIdentity'

export type LeaguepediaSnapshot = {
  source?: string
  fetchedAt?: string
  start?: string
  end?: string
  matches?: LeaguepediaGame[]
}

type LeaguepediaGame = {
  id?: unknown
  date?: unknown
  datetimeUtc?: unknown
  event?: unknown
  patch?: unknown
  teamA?: unknown
  teamB?: unknown
  teamALeague?: unknown
  teamBLeague?: unknown
  teamAHomeLeague?: unknown
  teamBHomeLeague?: unknown
  teamARegion?: unknown
  teamBRegion?: unknown
  bestOf?: unknown
  matchBestOf?: unknown
  gamesInMatch?: unknown
  winner?: unknown
  loser?: unknown
  teamAKills?: unknown
  teamBKills?: unknown
  teamAGold?: unknown
  teamBGold?: unknown
}

export type LeaguepediaImportResult = {
  matches: MatchRecord[]
  teams: Record<string, TeamProfile>
  source: {
    name: string
    url?: string
    fileName?: string
    retrievedAt: string
    gameCount: number
    attribution: string
    start?: string
    end?: string
  }
}

export function importLeaguepediaSnapshot(
  snapshot: LeaguepediaSnapshot,
  options: {
    sourceUrl?: string
    sourceFileName?: string
    retrievedAt?: string
  } = {},
): LeaguepediaImportResult {
  const matches: MatchRecord[] = []
  const teams: Record<string, TeamProfile> = {}

  for (const game of Array.isArray(snapshot.matches) ? snapshot.matches : []) {
    const match = normalizeGame(game, options)
    if (!match) continue
    matches.push(match)

    upsertTeam(teams, match.teamA, match.teamAHomeLeague ?? 'Unknown', match.teamARegion ?? 'International')
    upsertTeam(teams, match.teamB, match.teamBHomeLeague ?? 'Unknown', match.teamBRegion ?? 'International')
  }

  return {
    matches: matches.sort((a, b) => a.date.localeCompare(b.date)),
    teams,
    source: {
      name: 'Leaguepedia Cargo ScoreboardGames',
      url: options.sourceUrl,
      fileName: options.sourceFileName,
      retrievedAt: options.retrievedAt ?? snapshot.fetchedAt ?? new Date().toISOString(),
      gameCount: matches.length,
      attribution: 'Sourced from Leaguepedia Cargo / Leaguepedia contributors under the wiki data terms.',
      start: snapshot.start,
      end: snapshot.end,
    },
  }
}

function normalizeGame(game: LeaguepediaGame, options: { sourceUrl?: string; sourceFileName?: string }): MatchRecord | null {
  const sourceGameId = text(game.id)
  const teamA = text(game.teamA)
  const teamB = text(game.teamB)
  const winner = text(game.winner)
  const event = text(game.event) || 'Leaguepedia event'
  const date = normalizeDate(text(game.date) || text(game.datetimeUtc))
  if (!sourceGameId || !teamA || !teamB || !winner || !date) return null

  const league = inferLeague(event)
  const phase = inferPhase(event)
  const season = yearFromDate(date)
  const teamAHomeLeague = teamHomeLeague(game, 'A', teamA, league)
  const teamBHomeLeague = teamHomeLeague(game, 'B', teamB, league)
  const teamARegion = teamRegion(game, 'A', teamA, teamAHomeLeague)
  const teamBRegion = teamRegion(game, 'B', teamB, teamBHomeLeague)

  return {
    id: `leaguepedia-${sourceGameId}`,
    sourceProvider: 'leaguepedia-cargo',
    sourceGameId,
    sourceUrl: options.sourceUrl ?? 'https://lol.fandom.com/wiki/Help:Leaguepedia_API',
    sourceFileName: options.sourceFileName,
    dataCompleteness: hasScoreboardStats(game) ? 'scoreboard-game-stats' : 'match-result-only',
    date,
    season,
    event,
    phase,
    region: leagueToRegion(league),
    league,
    teamAHomeLeague,
    teamBHomeLeague,
    teamARegion,
    teamBRegion,
    patch: text(game.patch),
    bestOf: bestOfForGame(game, phase),
    tier: inferTier(league, event, phase),
    teamA,
    teamB,
    winner,
    teamAKills: numberOrZero(game.teamAKills),
    teamBKills: numberOrZero(game.teamBKills),
    teamAGold: numberOrZero(game.teamAGold),
    teamBGold: numberOrZero(game.teamBGold),
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

function hasScoreboardStats(game: LeaguepediaGame) {
  return [game.teamAKills, game.teamBKills, game.teamAGold, game.teamBGold].some((value) => numberOrZero(value) > 0)
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function numberOrZero(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value !== 'string' || value.trim() === '') return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizeDate(valueToNormalize: string) {
  if (!valueToNormalize) return ''
  const parsed = Date.parse(valueToNormalize)
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10)
  return valueToNormalize.slice(0, 10)
}

function yearFromDate(date: string) {
  const parsed = Number(date.slice(0, 4))
  return Number.isFinite(parsed) ? parsed : new Date().getUTCFullYear()
}

function inferLeague(event: string) {
  const textValue = event.toLowerCase()
  if (textValue.includes('world championship') || textValue.includes('worlds')) return 'Worlds'
  if (textValue.includes('mid-season invitational') || textValue.includes('msi')) return 'MSI'
  if (textValue.includes('emea masters')) return 'EMEA Masters'
  const leagueCodes = ['LCK', 'LPL', 'LEC', 'LCS', 'LCP', 'CBLOL', 'VCS', 'PCS', 'LLA', 'TCL', 'LJL', 'LCO', 'NLC', 'LFL', 'PRM', 'LVP SL']
  const normalized = event.toUpperCase()
  return leagueCodes.find((leagueCode) => normalized.includes(leagueCode)) ?? 'Unknown'
}

function teamHomeLeague(game: LeaguepediaGame, side: 'A' | 'B', teamName: string, competitionLeague: string) {
  const explicit =
    side === 'A'
      ? text(game.teamAHomeLeague) || text(game.teamALeague)
      : text(game.teamBHomeLeague) || text(game.teamBLeague)
  if (explicit) return explicit
  const identity = teamIdentityFor(teamName)
  if (identity) return identity.league
  return isInternationalCompetition(competitionLeague) ? 'Unknown' : competitionLeague
}

function teamRegion(game: LeaguepediaGame, side: 'A' | 'B', teamName: string, homeLeague: string): Region {
  const explicit = side === 'A' ? text(game.teamARegion) : text(game.teamBRegion)
  if (isRegion(explicit)) return explicit
  const identity = teamIdentityFor(teamName)
  if (identity) return identity.region
  return leagueToRegion(homeLeague)
}

function isInternationalCompetition(league: string) {
  return ['Worlds', 'MSI'].includes(league)
}

function isRegion(value: string): value is Region {
  return ['LCK', 'LPL', 'LEC', 'LCS', 'LCP', 'CBLOL', 'VCS', 'PCS', 'International'].includes(value)
}

function inferPhase(event: string) {
  const textValue = event.toLowerCase()
  if (textValue.includes('playoff') || textValue.includes('bracket') || textValue.includes('knockout')) return 'Playoffs'
  if (textValue.includes('play-in') || textValue.includes('play in')) return 'Play-in'
  if (textValue.includes('swiss')) return 'Swiss'
  return 'Regular season'
}

function leagueToRegion(league: string): Region {
  return regionForLeague(league)
}

function inferTier(league: string, event: string, phase: string): MatchRecord['tier'] {
  const textValue = `${league} ${event}`.toLowerCase()
  const playoffs = phase === 'Playoffs'
  if (textValue.includes('world') && playoffs) return 'worlds-playoffs'
  if (textValue.includes('world')) return 'worlds-main'
  if (textValue.includes('msi') && playoffs) return 'msi-bracket'
  if (textValue.includes('msi')) return 'msi-play-in'
  if (textValue.includes('emea masters') || textValue.includes('minor')) return 'minor-international'
  if (playoffs) return 'major-playoffs'
  return 'regional-regular'
}

function bestOfForGame(game: LeaguepediaGame, phase: string) {
  const explicit = numberOrZero(game.bestOf) || numberOrZero(game.matchBestOf) || numberOrZero(game.gamesInMatch)
  if ([1, 2, 3, 5].includes(explicit)) return explicit
  return phase === 'Playoffs' ? 5 : 1
}

function makeTeamCode(teamName: string) {
  return teamName
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 4)
    .toUpperCase()
}
