import type { MatchRecord, Region, TeamProfile } from '../../types'
import {
  inferEventTier,
  inferLeagueFromEvent,
  regionForCompetitionSide,
  regionForLeague,
  resolveHomeLeagueForCompetition,
} from '../../data/competitionTaxonomy'
import { canonicalTeamNameFor, cleanDisplayName, teamCodeFor, teamIdentityFor } from '../../data/teamIdentity'

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
  const teamA = canonicalTeamNameFor(text(game.teamA))
  const teamB = canonicalTeamNameFor(text(game.teamB))
  const winner = canonicalTeamNameFor(text(game.winner))
  const event = text(game.event) || 'Leaguepedia event'
  const rawDatetimeUtc = text(game.datetimeUtc)
  const date = normalizeDate(text(game.date) || rawDatetimeUtc)
  if (!sourceGameId || !teamA || !teamB || !winner || !date) return null

  const league = inferLeague(event)
  const phase = inferPhase(`${event} ${text(game.id)}`)
  const season = yearFromDate(date)
  const teamAHomeLeague = teamHomeLeague(game, 'A', teamA, league)
  const teamBHomeLeague = teamHomeLeague(game, 'B', teamB, league)
  const teamARegion = teamRegion(game, 'A', teamAHomeLeague, league)
  const teamBRegion = teamRegion(game, 'B', teamBHomeLeague, league)
  const format = bestOfForGame(game, phase)

  return {
    id: `leaguepedia-${sourceGameId}`,
    sourceProvider: 'leaguepedia-cargo',
    sourceGameId,
    sourceUrl: options.sourceUrl ?? 'https://lol.fandom.com/wiki/Help:Leaguepedia_API',
    sourceFileName: options.sourceFileName,
    dataCompleteness: hasScoreboardStats(game) ? 'scoreboard-game-stats' : 'match-result-only',
    date,
    datetimeUtc: normalizeDatetimeUtc(rawDatetimeUtc),
    season,
    event,
    phase,
    region: regionForLeague(league),
    league,
    teamAHomeLeague,
    teamBHomeLeague,
    teamARegion,
    teamBRegion,
    patch: text(game.patch),
    bestOf: format.bestOf,
    bestOfBasis: format.basis,
    tier: inferEventTier({ league, event, phase }),
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

  if (current.league === 'Unknown' && league !== 'Unknown') {
    teams[teamName] = candidate
  }
}

function hasScoreboardStats(game: LeaguepediaGame) {
  return [game.teamAKills, game.teamBKills, game.teamAGold, game.teamBGold].some((value) => numberOrZero(value) > 0)
}

function text(value: unknown) {
  return typeof value === 'string' ? cleanDisplayName(value) : ''
}

function numberOrZero(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value !== 'string' || value.trim() === '') return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizeDate(valueToNormalize: string) {
  if (!valueToNormalize) return ''
  const sourceDate = valueToNormalize.match(/^\d{4}-\d{2}-\d{2}/)?.[0]
  if (sourceDate) return sourceDate
  const parsed = Date.parse(valueToNormalize)
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10)
  return valueToNormalize.slice(0, 10)
}

function normalizeDatetimeUtc(valueToNormalize: string) {
  if (!valueToNormalize) return undefined
  const parsed = Date.parse(valueToNormalize)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

function yearFromDate(date: string) {
  const parsed = Number(date.slice(0, 4))
  return Number.isFinite(parsed) ? parsed : new Date().getUTCFullYear()
}

function inferLeague(event: string) {
  return inferLeagueFromEvent(event)
}

function teamHomeLeague(game: LeaguepediaGame, side: 'A' | 'B', teamName: string, competitionLeague: string) {
  const explicitHomeLeague =
    side === 'A'
      ? text(game.teamAHomeLeague)
      : text(game.teamBHomeLeague)
  const explicitLeague = side === 'A' ? text(game.teamALeague) : text(game.teamBLeague)
  const identity = teamIdentityFor(teamName)
  return resolveHomeLeagueForCompetition({
    competitionLeague,
    explicitHomeLeague,
    explicitLeague,
    identityLeague: identity?.league,
    unknownLeague: 'Unknown',
  }) ?? 'Unknown'
}

function teamRegion(game: LeaguepediaGame, side: 'A' | 'B', homeLeague: string, competitionLeague: string): Region {
  const explicit = side === 'A' ? text(game.teamARegion) : text(game.teamBRegion)
  return regionForCompetitionSide({
    explicitRegion: explicit,
    homeLeague,
    competitionLeague,
    missingRegion: 'International',
  }) ?? 'International'
}

function inferPhase(event: string) {
  const textValue = event.toLowerCase()
  if (
    textValue.includes('playoff')
    || textValue.includes('bracket')
    || textValue.includes('knockout')
    || /(^|[^a-z0-9])(grand[\s_-]+)?finals?([^a-z0-9]|$)/.test(textValue)
    || /(^|[^a-z0-9])semi[\s_-]*finals?([^a-z0-9]|$)/.test(textValue)
    || /(^|[^a-z0-9])quarter[\s_-]*finals?([^a-z0-9]|$)/.test(textValue)
  ) return 'Playoffs'
  if (textValue.includes('play-in') || textValue.includes('play in')) return 'Play-in'
  if (textValue.includes('swiss')) return 'Swiss'
  return 'Regular season'
}

function bestOfForGame(game: LeaguepediaGame, phase: string) {
  const explicit = numberOrZero(game.bestOf) || numberOrZero(game.matchBestOf) || numberOrZero(game.gamesInMatch)
  if ([1, 2, 3, 5].includes(explicit)) return { bestOf: explicit, basis: 'provider' as const }
  return { bestOf: phase === 'Playoffs' ? 5 : 1, basis: 'fallback' as const }
}

function makeTeamCode(teamName: string) {
  return teamCodeFor(teamName)
}
