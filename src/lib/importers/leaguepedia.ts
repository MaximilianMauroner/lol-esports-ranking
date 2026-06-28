import type { MatchRecord, Region, TeamProfile } from '../../types'
import { canonicalTeamNameFor, cleanDisplayName, regionForLeague, teamCodeFor, teamIdentityFor } from '../../data/teamIdentity'

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
  const date = normalizeDate(text(game.date) || text(game.datetimeUtc))
  if (!sourceGameId || !teamA || !teamB || !winner || !date) return null

  const league = inferLeague(event)
  const phase = inferPhase(`${event} ${text(game.id)}`)
  const season = yearFromDate(date)
  const teamAHomeLeague = teamHomeLeague(game, 'A', teamA, league)
  const teamBHomeLeague = teamHomeLeague(game, 'B', teamB, league)
  const teamARegion = teamRegion(game, 'A', teamAHomeLeague)
  const teamBRegion = teamRegion(game, 'B', teamBHomeLeague)

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

function yearFromDate(date: string) {
  const parsed = Number(date.slice(0, 4))
  return Number.isFinite(parsed) ? parsed : new Date().getUTCFullYear()
}

function inferLeague(event: string) {
  return leagueInferenceRules.find((rule) => rule.patterns.some((pattern) => pattern.test(event)))?.league ?? 'Unknown'
}

const leagueInferenceRules: { league: string; patterns: RegExp[] }[] = [
  { league: 'Worlds', patterns: [/\bworld championship\b/i, /\bworlds\b/i, /\bwlds?\b/i] },
  { league: 'MSI', patterns: [/\bmid-season invitational\b/i, /\bmsi\b/i] },
  { league: 'FST', patterns: [/\bfirst\s+stand\b/i, /\bfst\s+\d{4}\b/i] },
  { league: 'EWC', patterns: [/\besports\s+world\s+cup\b/i, /\bewc\s+\d{4}\b/i] },
  { league: 'Asia Master', patterns: [/\basia\s+masters?\b/i] },
  { league: 'KeSPA', patterns: [/\bkespa\b/i] },
  { league: 'DCup', patterns: [/\bdcup\b/i, /\bdemacia cup\b/i] },
  { league: 'EMEA Masters', patterns: [/\bemea masters\b/i, /\bem\s+\d{4}\b/i] },
  { league: 'LCK Academy', patterns: [/\blck\s+academy\b/i, /\blas\s+\d{4}\b/i] },
  { league: 'LCK CL', patterns: [/\blck\s*cl\b/i, /\blckc\b/i, /\blck\s+challengers?\b/i] },
  { league: 'LTA N', patterns: [/\blta\s+n(?:orth)?\b/i] },
  { league: 'LTA S', patterns: [/\blta\s+s(?:outh)?\b/i] },
  { league: 'NACL', patterns: [/\bnacl\b/i, /\bnorth american challengers league\b/i] },
  { league: 'LVP SL', patterns: [/\blvp\s+sl\b/i, /\bsuperliga(?:\s+domino's)?\b/i] },
  { league: 'PRM', patterns: [/\bprime league\b/i, /\bprm\b/i] },
  { league: 'LES', patterns: [/\bles\b/i, /\besports\s+series\s+madrid\b/i] },
  { league: 'LIT', patterns: [/\blit\b/i] },
  { league: 'EBL', patterns: [/\bebl\b/i, /\bbalkan\b/i] },
  { league: 'HLL', patterns: [/\bhll\b/i, /\bhellenic\s+legends\b/i] },
  { league: 'HC', patterns: [/\bhc\b/i, /\bhellenic\s+challengers?\s+cup\b/i] },
  { league: 'LPLOL', patterns: [/\blplol\b/i] },
  { league: 'RL', patterns: [/\brl\b/i, /\brift\s+legends\b/i] },
  { league: 'NEXO', patterns: [/\bnexo\b/i, /\bnexus\s+tour\b/i] },
  { league: 'NL', patterns: [/\bnexus\s+league\b/i, /\bnl\s+\d{4}\b/i] },
  { league: 'CCWS', patterns: [/\bccws\b/i, /\bcomedy\s+central\s+winter\s+snowdown\b/i] },
  { league: 'CT', patterns: [/\bcircuito\s+tormenta\b/i, /\bct\s+\d{4}\b/i] },
  { league: 'IC', patterns: [/\bic\s+\d{4}\b/i, /\biberian\s+cup\b/i] },
  { league: 'HW', patterns: [/\bhitpoint\s+winter\b/i, /\bhw\s+\d{4}\b/i] },
  { league: 'HM', patterns: [/\bhitpoint\b/i, /\bhm\s+\d{4}\b/i] },
  { league: 'AL', patterns: [/\barabian league\b/i, /\bal\s+\d{4}\b/i] },
  { league: 'ROL', patterns: [/\broad of legends\b/i, /\brol\s+\d{4}\b/i] },
  { league: 'CD', patterns: [/\bcircuito desafiante\b/i, /\bcd\s+\d{4}\b/i] },
  { league: 'LRN', patterns: [/\blrn\b/i, /\bliga\s+regional\s+norte\b/i] },
  { league: 'LRS', patterns: [/\blrs\b/i, /\bliga\s+regional\s+sur\b/i] },
  { league: 'LTS', patterns: [/\blts\b/i] },
  { league: 'LCK', patterns: [/\blck\b/i] },
  { league: 'LPL', patterns: [/\blpl\b/i] },
  { league: 'LEC', patterns: [/\blec\b/i] },
  { league: 'LCS', patterns: [/\blcs\b/i] },
  { league: 'LTA', patterns: [/\blta\b/i] },
  { league: 'LCP', patterns: [/\blcp\b/i] },
  { league: 'CBLOL', patterns: [/\bcblol\b/i] },
  { league: 'VCS', patterns: [/\bvcs\b/i] },
  { league: 'PCS', patterns: [/\bpcs\b/i] },
  { league: 'LLA', patterns: [/\blla\b/i] },
  { league: 'TCL', patterns: [/\btcl\b/i] },
  { league: 'LJL', patterns: [/\bljl\b/i] },
  { league: 'LCO', patterns: [/\blco\b/i] },
  { league: 'NLC', patterns: [/\bnlc\b/i] },
  { league: 'LFL2', patterns: [/\blfl2\b/i, /\blfl\s+division\s*2\b/i] },
  { league: 'LFL', patterns: [/\blfl\b/i] },
]

function teamHomeLeague(game: LeaguepediaGame, side: 'A' | 'B', teamName: string, competitionLeague: string) {
  const explicit =
    side === 'A'
      ? text(game.teamAHomeLeague) || text(game.teamALeague)
      : text(game.teamBHomeLeague) || text(game.teamBLeague)
  if (explicit) return explicit
  if (!isCompetitionOnlyHomeLeague(competitionLeague)) return competitionLeague
  if (!shouldUseIdentityForCompetitionFallback(competitionLeague)) return 'Unknown'
  const identity = teamIdentityFor(teamName)
  if (identity) return identity.league
  return 'Unknown'
}

function teamRegion(game: LeaguepediaGame, side: 'A' | 'B', homeLeague: string): Region {
  const explicit = side === 'A' ? text(game.teamARegion) : text(game.teamBRegion)
  if (isRegion(explicit)) return explicit
  if (homeLeague && homeLeague !== 'Unknown' && !isCompetitionOnlyHomeLeague(homeLeague)) return leagueToRegion(homeLeague)
  return 'International'
}

function isCompetitionOnlyHomeLeague(league: string) {
  return ['Worlds', 'MSI', 'FST', 'EWC', 'ASI', 'AC', 'Asia Master', 'KeSPA', 'DCup', 'EMEA Masters', 'LTA'].includes(league)
}

function shouldUseIdentityForCompetitionFallback(league: string) {
  return isCompetitionOnlyHomeLeague(league) && league !== 'LTA'
}

function isRegion(value: string): value is Region {
  return ['LCK', 'LPL', 'LEC', 'LCS', 'LCP', 'CBLOL', 'VCS', 'PCS', 'International'].includes(value)
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

function leagueToRegion(league: string): Region {
  return regionForLeague(league)
}

function inferTier(league: string, event: string, phase: string): MatchRecord['tier'] {
  const textValue = `${league} ${event}`.toLowerCase()
  const playoffs = phase === 'Playoffs'
  if (textValue.includes('academic esports world tournament') || textValue.includes('university esports')) return 'qualifier'
  if (textValue.includes('online qualifier') || textValue.includes('online qualifiers')) return 'qualifier'
  if (textValue.includes('dcup') || textValue.includes('demacia cup')) return playoffs ? 'major-playoffs' : 'regional-regular'
  if (textValue.includes('first stand') || /\bfst\b/.test(textValue)) return 'msi-bracket'
  if (textValue.includes('emea masters')
    || textValue.includes('minor')
    || /\bewc\b/.test(textValue)
    || textValue.includes('esports world cup')
    || textValue.includes('asia master')
    || textValue.includes('kespa')) return 'minor-international'
  if (/\bwlds?\b/.test(textValue)) return playoffs ? 'worlds-playoffs' : 'worlds-main'
  if (textValue.includes('world') && playoffs) return 'worlds-playoffs'
  if (textValue.includes('world')) return 'worlds-main'
  if (textValue.includes('msi') && playoffs) return 'msi-bracket'
  if (textValue.includes('msi')) return 'msi-play-in'
  if (playoffs) return 'major-playoffs'
  return 'regional-regular'
}

function bestOfForGame(game: LeaguepediaGame, phase: string) {
  const explicit = numberOrZero(game.bestOf) || numberOrZero(game.matchBestOf) || numberOrZero(game.gamesInMatch)
  if ([1, 2, 3, 5].includes(explicit)) return explicit
  return phase === 'Playoffs' ? 5 : 1
}

function makeTeamCode(teamName: string) {
  return teamCodeFor(teamName)
}
