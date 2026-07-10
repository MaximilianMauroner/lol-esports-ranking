import { canonicalTeamNameFor } from '../data/teamIdentity'
import type {
  MatchRecord,
  SeriesFormat,
  SeriesFormatBasis,
  SeriesFormatConfidence,
  SeriesState,
} from '../types'
import { normalizedBestOf } from './matchFormat'

export type CanonicalSeries = {
  id: string
  date: string
  startTime?: string
  teamA: string
  teamB: string
  games: MatchRecord[]
  finalMatch: MatchRecord
  format: SeriesFormat
  formatBasis: SeriesFormatBasis
  formatConfidence: SeriesFormatConfidence
  winsA: number
  winsB: number
  outcomeA: 0 | 0.5 | 1
  state: SeriesState
}

export function resolveCanonicalSeries(matches: readonly MatchRecord[]): CanonicalSeries[] {
  const grouped = new Map<string, MatchRecord[]>()
  for (const match of matches) {
    const id = canonicalSeriesId(match)
    grouped.set(id, [...(grouped.get(id) ?? []), match])
  }

  return [...grouped.entries()]
    .map(([id, games]) => buildCanonicalSeries(id, games))
    .sort(compareCanonicalSeries)
}

export function canonicalSeriesForMatches(matches: readonly MatchRecord[]) {
  const byMatchId = new Map<string, CanonicalSeries>()
  for (const series of resolveCanonicalSeries(matches)) {
    for (const match of series.games) byMatchId.set(match.id, series)
  }
  return byMatchId
}

export function canonicalSeriesOutcomeForTeam(series: CanonicalSeries, team: string) {
  const canonicalTeam = canonicalTeamNameFor(team)
  if (canonicalTeam === series.teamA) return series.outcomeA
  if (canonicalTeam === series.teamB) return (1 - series.outcomeA) as 0 | 0.5 | 1
  return undefined
}

export function compareCanonicalSeries(left: CanonicalSeries, right: CanonicalSeries) {
  return left.date.localeCompare(right.date)
    || (left.startTime ?? '').localeCompare(right.startTime ?? '')
    || left.id.localeCompare(right.id)
}

function buildCanonicalSeries(id: string, inputGames: MatchRecord[]): CanonicalSeries {
  const games = inputGames.toSorted(compareSeriesGames)
  const firstMatch = games[0]
  const finalMatch = games.at(-1)
  if (!firstMatch || !finalMatch) throw new Error('Cannot resolve an empty canonical series')

  const teams = [...new Set(games.flatMap((match) => [
    canonicalTeamNameFor(match.teamA),
    canonicalTeamNameFor(match.teamB),
  ]))].sort((left, right) => left.localeCompare(right))
  const [teamA, teamB] = teams
  if (!teamA || !teamB || teams.length !== 2) {
    throw new Error(`Canonical series ${id} must contain exactly two teams`)
  }

  const winsA = games.filter((match) => canonicalTeamNameFor(match.winner) === teamA).length
  const winsB = games.filter((match) => canonicalTeamNameFor(match.winner) === teamB).length
  const resolvedFormat = resolveSeriesFormat(games, winsA, winsB)
  const state = seriesState(resolvedFormat.format, winsA, winsB, games.length)
  const outcomeA = winsA === winsB ? 0.5 : winsA > winsB ? 1 : 0

  return {
    id,
    date: firstMatch.date,
    ...(earliestStartTime(games) ? { startTime: earliestStartTime(games) } : {}),
    teamA,
    teamB,
    games,
    finalMatch,
    ...resolvedFormat,
    winsA,
    winsB,
    outcomeA,
    state,
  }
}

function canonicalSeriesId(match: MatchRecord) {
  const provider = match.sourceProvider ?? 'unknown'
  if (match.officialMatchId) return joinKey('official-match', match.officialMatchId)
  if (match.sourceMatchId) return joinKey('source-match', provider, sourceSeriesId(match.sourceMatchId))
  const sourceGameSeriesId = sourceGameSeriesIdFor(match)
  if (sourceGameSeriesId) return joinKey('source-game-series', provider, sourceGameSeriesId)

  const teams = [canonicalTeamNameFor(match.teamA), canonicalTeamNameFor(match.teamB)]
    .sort((left, right) => left.localeCompare(right))
  const fallbackBase = joinKey('fallback', match.date, provider, match.event, match.phase, ...teams)
  if (normalizedBestOf(match.bestOf) === 1 && match.bestOfBasis !== 'fallback') {
    return joinKey(fallbackBase, match.id)
  }
  return fallbackBase
}

function sourceSeriesId(value: string) {
  return value.replace(/(?:[_-](?:game[_-]?)?[1-5])$/i, '')
}

function sourceGameSeriesIdFor(match: MatchRecord) {
  if (!match.sourceGameId) return undefined
  if (/(?:[_-]game[_-]?[1-5])$/i.test(match.sourceGameId)) {
    return sourceSeriesId(match.sourceGameId)
  }
  if (normalizedBestOf(match.bestOf) > 1 && /[_-][1-5]$/.test(match.sourceGameId)) {
    return sourceSeriesId(match.sourceGameId)
  }
  return undefined
}

function resolveSeriesFormat(games: MatchRecord[], winsA: number, winsB: number): {
  format: SeriesFormat
  formatBasis: SeriesFormatBasis
  formatConfidence: SeriesFormatConfidence
} {
  const official = strongestExplicitFormat(games, 'official')
  if (official) return formatResult(official, 'official', 'high', winsA, winsB)

  const provider = strongestExplicitFormat(games, 'provider', true)
  if (provider) return formatResult(provider, 'provider', 'high', winsA, winsB)

  const proven = scoreProvenFormat(winsA, winsB)
  if (proven > 1) return { format: proven, formatBasis: 'score-inferred', formatConfidence: 'medium' }

  const fallback = Math.max(...games.map((match) => normalizedBestOf(match.bestOf))) as SeriesFormat
  return { format: fallback, formatBasis: 'fallback', formatConfidence: 'low' }
}

function strongestExplicitFormat(
  games: MatchRecord[],
  basis: MatchRecord['bestOfBasis'],
  includeUnlabelled = false,
) {
  const formats = games
    .filter((match) => match.bestOfBasis === basis || (includeUnlabelled && match.bestOfBasis === undefined))
    .map((match) => normalizedBestOf(match.bestOf))
  return formats.length > 0 ? Math.max(...formats) as SeriesFormat : undefined
}

function formatResult(
  explicit: SeriesFormat,
  formatBasis: Extract<SeriesFormatBasis, 'official' | 'provider'>,
  formatConfidence: SeriesFormatConfidence,
  winsA: number,
  winsB: number,
) {
  const proven = scoreProvenFormat(winsA, winsB)
  if (proven > explicit) {
    return { format: proven, formatBasis: 'score-inferred' as const, formatConfidence: 'high' as const }
  }
  return { format: explicit, formatBasis, formatConfidence }
}

function scoreProvenFormat(winsA: number, winsB: number): SeriesFormat {
  const maximumWins = Math.max(winsA, winsB)
  if (maximumWins >= 3) return 5
  if (maximumWins >= 2) return 3
  return 1
}

function seriesState(format: SeriesFormat, winsA: number, winsB: number, games: number): SeriesState {
  if (games === 0) return 'scheduled'
  if (format === 2 && winsA === 1 && winsB === 1) return 'completed'
  if (format === 1 && games > 1) return 'unknown'
  const winsNeeded = Math.floor(format / 2) + 1
  if (Math.max(winsA, winsB) >= winsNeeded) return 'completed'
  return 'ongoing'
}

function compareSeriesGames(left: MatchRecord, right: MatchRecord) {
  return (left.datetimeUtc ?? '9999').localeCompare(right.datetimeUtc ?? '9999')
    || gameNumberFor(left) - gameNumberFor(right)
    || (left.officialGameId ?? '').localeCompare(right.officialGameId ?? '')
    || (left.sourceGameId ?? '').localeCompare(right.sourceGameId ?? '')
    || left.id.localeCompare(right.id)
}

function earliestStartTime(games: MatchRecord[]) {
  return games
    .map((match) => match.datetimeUtc)
    .filter((value): value is string => Boolean(value))
    .sort()[0]
}

function gameNumberFor(match: MatchRecord) {
  if (match.gameNumber !== undefined) return match.gameNumber
  for (const value of [match.officialGameId, match.sourceGameId, match.sourceMatchId, match.id]) {
    const parsed = value?.match(/(?:game[_-]?|[_-])([1-5])$/i)?.[1]
    if (parsed) return Number(parsed)
  }
  return Number.MAX_SAFE_INTEGER
}

function joinKey(...parts: string[]) {
  return parts.join('\u0000')
}
