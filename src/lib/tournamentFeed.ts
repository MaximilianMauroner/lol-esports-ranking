/** A schedule reference feed. It never supplies scored ranking inputs. */
export const TOURNAMENT_FEED_VERSION = 1

export type TournamentCompetition = 'lcs' | 'lec' | 'lpl' | 'lck' | 'worlds' | 'msi' | 'first-stand'
export type TournamentSeriesStatus = 'upcoming' | 'live' | 'completed' | 'postponed' | 'cancelled' | 'unknown'

export type TournamentSeries = {
  id: string
  eventId: string
  startTime: string | null
  stage: string | null
  status: TournamentSeriesStatus
  sourceState: string
  bestOf: number | null
  teams: Array<{ id: string | null; name: string | null; code: string | null; gameWins: number | null; outcome: string | null }>
  vodUrls: string[]
}

export type TournamentEvent = {
  id: string
  sourceTournamentId: string
  competition: TournamentCompetition
  label: string
  season: string
  series: TournamentSeries[]
}

export type TournamentFeed = {
  version: 1
  source: 'lolesports-persisted-site-api'
  unsupportedApi: true
  dataMode?: 'synthetic-fixture'
  fetchedAt: string
  sourceUpdatedAt: string | null
  coverage: { start: string; end: string; complete: boolean; warnings: string[] }
  events: TournamentEvent[]
}

type JsonRecord = Record<string, unknown>
type Observation = { event: JsonRecord; detail?: JsonRecord }

/** Only explicit league identities enter the feed; teams are never region-filtered. */
export function competitionForLeague(league: unknown): TournamentCompetition | null {
  const record = asRecord(league)
  const slug = str(record?.slug).trim().toLowerCase()
  const name = str(record?.name).trim().toLowerCase()
  const slugCompetition = competitionForSlug(slug)
  const nameCompetition = competitionForName(name)
  if (nameCompetition && slug && (!slugCompetition || slugCompetition !== nameCompetition)) return null
  return slugCompetition ?? nameCompetition
}

/** A known name cannot override a different or unidentified source slug. */
export function conflictingLeagueIdentity(league: unknown): boolean {
  const record = asRecord(league)
  const slug = str(record?.slug).trim().toLowerCase()
  const nameCompetition = competitionForName(str(record?.name).trim().toLowerCase())
  return Boolean(nameCompetition && slug && competitionForSlug(slug) !== nameCompetition)
}

function competitionForSlug(slug: string): TournamentCompetition | null {
  if (['lcs', 'lec', 'lpl', 'lck'].includes(slug)) return slug as TournamentCompetition
  if (slug === 'worlds') return 'worlds'
  if (slug === 'msi') return 'msi'
  if (slug === 'first_stand' || slug === 'first-stand') return 'first-stand'
  return null
}

function competitionForName(name: string): TournamentCompetition | null {
  if (['lcs', 'lec', 'lpl', 'lck'].includes(name)) return name as TournamentCompetition
  if (/\bworld championship\b/.test(name)) return 'worlds'
  if (name === 'mid-season invitational') return 'msi'
  if (name === 'first stand') return 'first-stand'
  return null
}

export function normalizeTournamentFeed(input: {
  observations: Observation[]
  fetchedAt: string
  coverageStart: string
  coverageEnd: string
  coverageComplete: boolean
  warnings?: string[]
}): TournamentFeed {
  const warnings = [...(input.warnings ?? [])]
  const byMatch = new Map<string, Observation>()
  const conflicts = new Set<string>()
  let missingMatchId = 0
  for (const observation of input.observations) {
    const matchId = str(asRecord(observation.event.match)?.id) || str(observation.event.id)
    if (!matchId) {
      if (competitionForLeague(observation.event.league ?? observation.detail?.league)) missingMatchId += 1
      continue
    }
    const previous = byMatch.get(matchId)
    if (previous && JSON.stringify(previous.event) !== JSON.stringify(observation.event)) {
      // A page has no per-row revision. A conflict cannot be ordered safely.
      conflicts.add(matchId)
      continue
    }
    byMatch.set(matchId, { event: observation.event, detail: observation.detail ?? previous?.detail })
  }
  if (conflicts.size) warnings.push(`Conflicting overlapping source rows for ${[...conflicts].sort().join(', ')}; coverage is incomplete.`)
  if (missingMatchId) warnings.push(`${missingMatchId} allowed source rows lack a match ID and were withheld.`)

  const grouped = new Map<string, TournamentEvent>()
  let missingIdentity = 0
  for (const [matchId, observation] of byMatch) {
    if (conflicts.has(matchId)) continue
    const raw = observation.event
    const detail = observation.detail
    const competition = competitionForLeague(raw.league ?? detail?.league)
    if (!competition) continue
    const startTime = validDate(raw.startTime)
    const season = startTime?.slice(0, 4)
    const sourceTournamentId = str(asRecord(detail?.tournament)?.id)
    if (!season || !sourceTournamentId) {
      missingIdentity += 1
      continue
    }
    const id = ['worlds', 'msi', 'first-stand'].includes(competition)
      ? `${competition}:${season}`
      : `${competition}:${season}:${sourceTournamentId}`
    const rawMatch = asRecord(raw.match)
    const detailMatch = asRecord(detail?.match)
    const rawTeams = array(rawMatch?.teams)
    const detailTeams = array(detailMatch?.teams)
    const teams = (rawTeams.length ? rawTeams : detailTeams).slice(0, 2).map((teamValue) => {
      const team = asRecord(teamValue)
      const matchingDetail = detailTeams.map(asRecord).find((candidate) => candidate && (str(candidate.id) && str(candidate.id) === str(team?.id) || str(candidate.name) && str(candidate.name) === str(team?.name)))
      const result = asRecord(team?.result)
      const detailResult = asRecord(matchingDetail?.result)
      return {
        id: str(team?.id) || str(matchingDetail?.id) || null,
        name: str(team?.name) || str(matchingDetail?.name) || null,
        code: str(team?.code) || str(matchingDetail?.code) || null,
        gameWins: nonnegativeInteger(result?.gameWins) ?? nonnegativeInteger(detailResult?.gameWins),
        outcome: str(result?.outcome) || str(detailResult?.outcome) || null,
      }
    })
    const sourceState = str(raw.state)
    let status = normalizeStatus(sourceState)
    if (status === 'completed' && !confirmedSeriesResult(teams)) {
      status = 'unknown'
      warnings.push(`Match ${matchId} has a terminal source state without a confirmed result.`)
    }
    const bestOf = nonnegativeInteger(asRecord(rawMatch?.strategy)?.count) ?? nonnegativeInteger(asRecord(detailMatch?.strategy)?.count)
    const vodUrls = array(detailMatch?.games).flatMap((game) => array(asRecord(game)?.vods).map(vodUrl))
      .filter((url): url is string => Boolean(url))
    const series: TournamentSeries = {
      id: matchId, eventId: id, startTime, stage: str(raw.blockName) || null, status, sourceState,
      bestOf: bestOf && bestOf > 0 ? bestOf : null, teams, vodUrls: [...new Set(vodUrls)],
    }
    const existing = grouped.get(id)
    if (existing) existing.series.push(series)
    else grouped.set(id, {
      id, sourceTournamentId, competition,
      label: `${competitionLabel(competition)} ${season}`,
      season, series: [series],
    })
  }
  if (missingIdentity) warnings.push(`${missingIdentity} allowed series lack a source tournament ID or valid start time and were withheld.`)
  for (const event of grouped.values()) event.series.sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? '') || a.id.localeCompare(b.id))
  return {
    version: TOURNAMENT_FEED_VERSION,
    source: 'lolesports-persisted-site-api', unsupportedApi: true,
    fetchedAt: input.fetchedAt, sourceUpdatedAt: null,
    coverage: { start: input.coverageStart, end: input.coverageEnd, complete: input.coverageComplete && !conflicts.size && !missingMatchId && !missingIdentity, warnings },
    events: [...grouped.values()].sort((a, b) => (a.series[0]?.startTime ?? '').localeCompare(b.series[0]?.startTime ?? '') || a.id.localeCompare(b.id)),
  }
}

/** Failed or partial reads leave the prior published data intact. */
export function reconcileTournamentFeed(previous: TournamentFeed | null, candidate: TournamentFeed): TournamentFeed {
  if (!candidate.coverage.complete) {
    if (!previous) return candidate
    return { ...previous, coverage: { ...previous.coverage, warnings: [...previous.coverage.warnings, ...candidate.coverage.warnings, `Latest source check at ${candidate.fetchedAt} was incomplete; showing last complete observation.`] } }
  }
  if (previous && candidate.fetchedAt < previous.fetchedAt) return previous
  return candidate
}

export function normalizeStatus(source: string): TournamentSeriesStatus {
  switch (source.toLowerCase()) {
    case 'unstarted': return 'upcoming'
    case 'inprogress': return 'live'
    case 'completed': case 'complete': return 'completed'
    case 'postponed': case 'delayed': return 'postponed'
    case 'cancelled': case 'canceled': return 'cancelled'
    default: return 'unknown'
  }
}

export function groupTournamentSeries(series: readonly TournamentSeries[]) {
  const result: Record<'live' | 'upcoming' | 'results' | 'unresolved', TournamentSeries[]> = { live: [], upcoming: [], results: [], unresolved: [] }
  for (const entry of series) {
    if (entry.status === 'live') result.live.push(entry)
    else if (entry.status === 'completed' || entry.status === 'cancelled') result.results.push(entry)
    else if (entry.status === 'unknown' && /^(?:complete|completed)$/i.test(entry.sourceState)) result.unresolved.push(entry)
    else result.upcoming.push(entry)
  }
  return result
}

export function isTournamentFeed(value: unknown): value is TournamentFeed {
  const feed = asRecord(value)
  const coverage = asRecord(feed?.coverage)
  return feed?.version === TOURNAMENT_FEED_VERSION && feed.source === 'lolesports-persisted-site-api'
    && feed.unsupportedApi === true && Boolean(validDate(feed.fetchedAt))
    && (feed.dataMode === undefined || feed.dataMode === 'synthetic-fixture')
    && typeof coverage?.start === 'string' && typeof coverage.end === 'string'
    && typeof coverage.complete === 'boolean' && Array.isArray(coverage.warnings)
    && coverage.warnings.every((warning) => typeof warning === 'string')
    && Array.isArray(feed.events) && feed.events.every((eventValue) => {
      const event = asRecord(eventValue)
      return Boolean(event && str(event.id) && str(event.sourceTournamentId) && str(event.label)
        && str(event.season) && competitionForLeague({ slug: event.competition }) && Array.isArray(event.series)
        && event.series.every((seriesValue) => {
          const series = asRecord(seriesValue)
          return Boolean(series && str(series.id) && series.eventId === event.id
            && (series.startTime === null || Boolean(validDate(series.startTime)))
            && (series.stage === null || typeof series.stage === 'string')
            && (series.bestOf === null || nonnegativeInteger(series.bestOf) !== null)
            && typeof series.sourceState === 'string'
            && ['upcoming', 'live', 'completed', 'postponed', 'cancelled', 'unknown'].includes(str(series.status))
            && Array.isArray(series.teams) && series.teams.every((teamValue) => {
              const team = asRecord(teamValue)
              return Boolean(team && (team.id === null || typeof team.id === 'string')
                && (team.name === null || typeof team.name === 'string')
                && (team.code === null || typeof team.code === 'string')
                && (team.outcome === null || typeof team.outcome === 'string')
                && (team.gameWins === null || nonnegativeInteger(team.gameWins) !== null))
            })
            && Array.isArray(series.vodUrls) && series.vodUrls.every((url) => safeHttpsUrl(url) !== null))
        }))
    })
}

export function formatTournamentTime(value: string, timezone: string) {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: timezone, timeZoneName: 'short' }).format(date)
    : 'Unknown time'
}

function competitionLabel(value: TournamentCompetition) {
  return ({ lcs: 'LCS', lec: 'LEC', lpl: 'LPL', lck: 'LCK', worlds: 'Worlds', msi: 'MSI', 'first-stand': 'First Stand' })[value]
}
function confirmedSeriesResult(teams: TournamentSeries['teams']) {
  if (teams.length !== 2) return false
  const outcomes = teams.map((team) => team.outcome?.toLowerCase())
  return outcomes.includes('win') && outcomes.includes('loss')
    || teams[0]!.gameWins !== null && teams[1]!.gameWins !== null && teams[0]!.gameWins !== teams[1]!.gameWins
}
function asRecord(value: unknown): JsonRecord | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function str(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }
function validDate(value: unknown): string | null { const s = str(value); return s && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : null }
function nonnegativeInteger(value: unknown): number | null { return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null }
function safeHttpsUrl(value: unknown): string | null {
  const s = str(value)
  try { const url = new URL(s); return url.protocol === 'https:' ? url.toString() : null } catch { return null }
}
function vodUrl(value: unknown): string | null {
  const vod = asRecord(value)
  const parameter = str(vod?.parameter)
  if (str(vod?.provider).toLowerCase() === 'youtube' && /^[A-Za-z0-9_-]{11}$/.test(parameter)) {
    return `https://www.youtube.com/watch?v=${parameter}`
  }
  return safeHttpsUrl(parameter)
}
