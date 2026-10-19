import { compareCodeUnits } from '../src/shared/codeUnitOrder.mjs'
import {
  TOURNAMENT_FEED_VERSION,
  normalizeStatus,
  type TournamentCompetition,
  type TournamentEvent,
  type TournamentFeed,
  type TournamentSeries,
} from '../src/domains/tournaments/read.ts'
import { fetchWithRetry } from './provider-fetch-retry.mjs'

/** Leaguepedia content is CC BY-SA 3.0; the hub links the source page and licence. */
export const LEAGUEPEDIA_CARGO_EXPORT_URL = 'https://lol.fandom.com/wiki/Special:CargoExport'
const USER_AGENT = 'lol-esports-power-index-tournaments/1.0 (https://lol.lab4code.com)'
const PAGE_SIZE = 500
const MAX_PAGES = 4
const DAYS_BACK = 14
const DAYS_AHEAD = 45
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

const FIELDS = [
  'MS.MatchId=MatchId', 'MS.OverviewPage=OverviewPage', 'MS.Team1=Team1', 'MS.Team2=Team2',
  'MS.Team1Score=Team1Score', 'MS.Team2Score=Team2Score', 'MS.Winner=Winner', 'MS.DateTime_UTC=DateTimeUTC',
  'MS.HasTime=HasTime', 'MS.BestOf=BestOf', 'MS.Tab=Tab', 'MS.IsNullified=IsNullified',
  'T.Name=TournamentName', 'T.League=League', 'T.Region=Region', 'T.Year=Year',
]
/** Tier-1 leagues and their promotion events, plus international secondary events. Showmatches are excluded. */
const EVENT_FILTER = '(T.TournamentLevel = "Primary" OR (T.TournamentLevel = "Secondary" AND T.Region = "International"))'

const LEAGUE_COMPETITIONS: Record<string, TournamentCompetition> = {
  'League of Legends Championship Series': 'lcs',
  'LoL EMEA Championship': 'lec',
  'Tencent LoL Pro League': 'lpl',
  'LoL Champions Korea': 'lck',
  'World Championship': 'worlds',
  'Mid-Season Invitational': 'msi',
  'First Stand': 'first-stand',
}
const INTERNATIONAL: ReadonlySet<TournamentCompetition> = new Set(['worlds', 'msi', 'first-stand'])

type Row = Record<string, unknown>
type Health = { checkedAt: string; complete: boolean; warnings: string[] }

export async function collectLeaguepediaTournamentFeed(options: {
  fetcher?: typeof fetch
  baseUrl?: string
  now?: Date
  /** Deadline for one page, including retries and the response body. */
  pageTimeoutMs?: number
} = {}): Promise<TournamentFeed> {
  const now = options.now ?? new Date()
  const fetcher = options.fetcher ?? fetch
  const pageTimeoutMs = options.pageTimeoutMs ?? 30_000
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const coverageStart = new Date(dayStart - DAYS_BACK * DAY_MS).toISOString()
  const coverageEnd = new Date(dayStart + (DAYS_AHEAD + 1) * DAY_MS - 1).toISOString()
  const rows: Row[] = []
  const warnings: string[] = []
  let malformed = 0
  for (let page = 0; ; page += 1) {
    if (page === MAX_PAGES) {
      warnings.push(`Leaguepedia page limit reached after ${rows.length} series.`)
      break
    }
    const url = new URL(options.baseUrl ?? LEAGUEPEDIA_CARGO_EXPORT_URL)
    for (const [key, value] of Object.entries({
      tables: 'MatchSchedule=MS,Tournaments=T',
      join_on: 'MS.OverviewPage=T.OverviewPage',
      fields: FIELDS.join(','),
      where: `${scheduleWindow(coverageStart, coverageEnd)} AND ${EVENT_FILTER}`,
      order_by: 'MS.DateTime_UTC ASC, MS.MatchId ASC',
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
      format: 'json',
    })) url.searchParams.set(key, value)
    // fetchWithRetry stops its own deadline once headers arrive; this signal also bounds the body read.
    const deadline = AbortSignal.timeout(pageTimeoutMs)
    const response = await fetchWithRetry(url, { headers: { 'user-agent': USER_AGENT } }, {
      fetcher: (input, init) => fetcher(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline }),
      maxAttempts: 3, maxElapsedMs: pageTimeoutMs,
    })
    if (!response.ok) throw new Error(`Leaguepedia returned HTTP ${response.status}`)
    const body: unknown = await response.json()
    if (!Array.isArray(body)) throw new Error('Leaguepedia returned an unexpected schedule response')
    const pageRows = body.filter(isRow)
    malformed += body.length - pageRows.length
    rows.push(...pageRows)
    if (body.length < PAGE_SIZE) break
  }
  if (malformed) warnings.push(`${malformed} malformed Leaguepedia rows were omitted; schedule coverage is unknown.`)
  return normalizeLeaguepediaSchedule(rows, { now, coverageStart, coverageEnd, warnings })
}

/**
 * Leaguepedia reports results, not live state. A series counts as live from its
 * scheduled start until a result is entered, for at most best-of + 2 hours.
 */
export function normalizeLeaguepediaSchedule(rows: readonly Row[], input: {
  now: Date
  coverageStart: string
  coverageEnd: string
  warnings?: string[]
}): TournamentFeed {
  const warnings = [...(input.warnings ?? [])]
  const events = new Map<string, TournamentEvent>()
  const seen = new Map<string, string>()
  let withheld = 0
  let invalidTimes = 0
  for (const row of rows) {
    const matchId = text(row.MatchId)
    const page = text(row.OverviewPage)
    if (!matchId || !page) {
      withheld += 1
      continue
    }
    const serialized = JSON.stringify(row)
    if (seen.has(matchId)) {
      if (seen.get(matchId) !== serialized) warnings.push(`Leaguepedia returned conflicting rows for ${matchId}; the first row is shown.`)
      continue
    }
    seen.set(matchId, serialized)
    const timed = Number(row.HasTime) === 1
    const startTime = timed ? cargoIso(row.DateTimeUTC) : null
    if (timed && !startTime) invalidTimes += 1
    const bestOf = positiveInteger(row.BestOf)
    const winner = Number(row.Winner)
    const sourceState = seriesState(row, startTime, bestOf, input.now)
    const teams = ([[row.Team1, row.Team1Score, 1], [row.Team2, row.Team2Score, 2]] as const).map(([value, score, slot]) => {
      const name = text(value)
      const known = name && name !== 'TBD' ? name : null
      return {
        id: known, name: known, code: null, gameWins: nonnegativeInteger(score),
        outcome: sourceState === 'completed' ? (winner === slot ? 'win' : 'loss') : null,
      }
    })
    const series: TournamentSeries = {
      id: matchId, eventId: page, startTime, stage: text(row.Tab) || null,
      status: normalizeStatus(sourceState), sourceState, bestOf, teams, vodUrls: [],
    }
    const event = events.get(page)
    if (event) {
      event.series.push(series)
      continue
    }
    const league = LEAGUE_COMPETITIONS[text(row.League)] ?? null
    const competition = league && INTERNATIONAL.has(league) && text(row.Region) !== 'International' ? null : league
    events.set(page, {
      id: page, sourceTournamentId: page, competition,
      label: text(row.TournamentName) || page,
      season: positiveInteger(row.Year)?.toString() ?? startTime?.slice(0, 4) ?? input.coverageStart.slice(0, 4),
      series: [series],
    })
  }
  if (withheld) warnings.push(`${withheld} Leaguepedia rows lack a match or tournament page and were withheld.`)
  if (invalidTimes) warnings.push(`${invalidTimes} timed Leaguepedia rows have an invalid start time and are shown undated; their window coverage is unknown.`)
  for (const event of events.values()) {
    event.series.sort((a, b) => compareCodeUnits(a.startTime ?? '', b.startTime ?? '') || compareCodeUnits(a.id, b.id))
  }
  return {
    version: TOURNAMENT_FEED_VERSION, source: 'leaguepedia-cargo', unsupportedApi: false,
    fetchedAt: input.now.toISOString(), sourceUpdatedAt: null,
    coverage: { start: input.coverageStart, end: input.coverageEnd, complete: warnings.length === 0, warnings },
    events: [...events.values()].sort((a, b) => compareCodeUnits(a.series[0]?.startTime ?? '', b.series[0]?.startTime ?? '') || compareCodeUnits(a.id, b.id)),
  }
}

/**
 * Serves the latest Leaguepedia feed from memory. Reads trigger a refresh when the
 * cached copy is due, so the source is only polled while someone views the hub.
 * A failed or incomplete check keeps the last complete feed and reports it in health.
 */
export function createTournamentFeedService(options: {
  collect?: () => Promise<TournamentFeed>
  now?: () => number
  refreshMs?: number
  retryMs?: number
} = {}) {
  const now = options.now ?? Date.now
  const collect = options.collect ?? (() => collectLeaguepediaTournamentFeed({ now: new Date(now()) }))
  const refreshMs = options.refreshMs ?? 5 * 60_000
  const retryMs = options.retryMs ?? 60_000
  let feed: TournamentFeed | null = null
  let health: Health | null = null
  let nextRefreshAt = 0
  let inflight: Promise<void> | null = null

  const refresh = async () => {
    const checkedAt = new Date(now()).toISOString()
    try {
      const candidate = await collect()
      const complete = candidate.coverage.complete
      if ((complete || !feed) && !sameContent(feed, candidate)) feed = candidate
      health = { checkedAt, complete, warnings: candidate.coverage.warnings }
      nextRefreshAt = now() + (complete ? refreshMs : retryMs)
    } catch (error) {
      health = { checkedAt, complete: false, warnings: [`Leaguepedia check failed: ${error instanceof Error ? error.message : String(error)}`] }
      nextRefreshAt = now() + retryMs
    } finally {
      inflight = null
    }
  }

  return {
    async read(): Promise<{ feed: TournamentFeed | null; health: Health | null }> {
      if (!inflight && now() >= nextRefreshAt) inflight = refresh()
      if (!feed && inflight) await inflight
      return { feed, health }
    },
  }
}

function seriesState(row: Row, startTime: string | null, bestOf: number | null, now: Date) {
  if (Number(row.IsNullified) === 1) return 'nullified'
  if (Number(row.Winner) === 1 || Number(row.Winner) === 2) return 'completed'
  if (startTime === null || now.getTime() < Date.parse(startTime)) return 'scheduled'
  const liveUntil = Date.parse(startTime) + ((bestOf ?? 3) + 2) * HOUR_MS
  return now.getTime() < liveUntil ? 'started' : 'result-missing'
}
function sameContent(previous: TournamentFeed | null, candidate: TournamentFeed) {
  return previous !== null && JSON.stringify({ ...previous, fetchedAt: '' }) === JSON.stringify({ ...candidate, fetchedAt: '' })
}
function isRow(value: unknown): value is Row { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function text(value: unknown) { return typeof value === 'string' ? value.trim() : '' }
function positiveInteger(value: unknown) { return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null }
function nonnegativeInteger(value: unknown) { return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null }
/**
 * Series inside the window, plus every series of an event that overlaps it, so
 * a running event keeps the early rounds its bracket and standings need.
 */
function scheduleWindow(start: string, end: string) {
  const inWindow = `MS.DateTime_UTC >= "${cargoTime(start)}" AND MS.DateTime_UTC <= "${cargoTime(end)}"`
  const eventOverlaps = `T.DateStart <= "${end.slice(0, 10)}" AND T.Date >= "${start.slice(0, 10)}"`
  return `((${inWindow}) OR (${eventOverlaps}))`
}
/** Cargo stores UTC as "YYYY-MM-DD HH:MM:SS". */
function cargoTime(iso: string) { return iso.slice(0, 19).replace('T', ' ') }
function cargoIso(value: unknown) {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(text(value))
  const time = match ? Date.parse(`${match[1]}T${match[2]}Z`) : Number.NaN
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}
