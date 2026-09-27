import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProviderFetchTelemetry, fetchWithRetry } from './provider-fetch-retry.mjs'
import { competitionForLeague, isTournamentFeed, normalizeTournamentFeed } from '../src/lib/tournamentFeed'

const BASE_URL = 'https://esports-api.lolesports.com/persisted/gw'
const PUBLIC_SITE_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z'
type Row = Record<string, unknown>
type Fetcher = typeof fetch

/** Bounded window query. Both cursors are required for future discovery. */
export async function collectTournamentFeed(options: {
  fetcher?: Fetcher
  baseUrl?: string
  now?: Date
  daysBack?: number
  daysAhead?: number
  maxPagesPerDirection?: number
  maxDetails?: number
} = {}) {
  const now = options.now ?? new Date()
  const fetchedAt = now.toISOString()
  const utcDayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const start = new Date(utcDayStart - (options.daysBack ?? 14) * 86_400_000).toISOString()
  const end = new Date(utcDayStart + ((options.daysAhead ?? 45) + 1) * 86_400_000 - 1).toISOString()
  const maxPages = options.maxPagesPerDirection ?? 8
  const maxDetails = options.maxDetails ?? 120
  const telemetry = createProviderFetchTelemetry()
  const request = async (path: string, params: Record<string, string> = {}): Promise<Row> => {
    const url = new URL(`${options.baseUrl ?? BASE_URL}/${path}`)
    url.searchParams.set('hl', 'en-US')
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    const response = await fetchWithRetry(url, {
      headers: { 'x-api-key': PUBLIC_SITE_KEY, 'user-agent': 'lol-esports-power-index-tournament-reference/0.1' },
      signal: AbortSignal.timeout(15_000),
    }, { fetcher: options.fetcher, telemetry, maxAttempts: 3, maxElapsedMs: 30_000 })
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${path}`)
    const body: unknown = await response.json()
    const parsed = record(body)
    if (!parsed) throw new Error(`Malformed ${path} response`)
    return parsed
  }
  const pages: Row[] = []
  const first = await request('getSchedule')
  const firstSchedule = schedule(first)
  pages.push(firstSchedule)
  const warnings: string[] = []
  let complete = true
  for (const direction of ['older', 'newer'] as const) {
    let token = str(record(firstSchedule.pages)?.[direction])
    const seen = new Set<string>()
    let reachedBoundary = boundaryReached(firstSchedule, direction, start, end)
    for (let index = 0; token && !reachedBoundary && index < maxPages; index += 1) {
      if (seen.has(token)) { complete = false; warnings.push(`Repeated ${direction} page token.`); break }
      seen.add(token)
      const next = schedule(await request('getSchedule', { pageToken: token }))
      pages.push(next)
      reachedBoundary = boundaryReached(next, direction, start, end)
      token = str(record(next.pages)?.[direction])
    }
    if (token && !reachedBoundary) {
      complete = false
      warnings.push(`${direction} page limit reached before the requested window boundary.`)
    }
  }
  const malformedCursors = pages.reduce((count, page) => count + (['older', 'newer'] as const).filter((direction) => {
    const cursor = record(page.pages)?.[direction]
    return cursor !== undefined && cursor !== null && typeof cursor !== 'string'
  }).length, 0)
  if (malformedCursors) {
    complete = false
    warnings.push(`${malformedCursors} malformed page cursors were treated as missing; schedule coverage is unknown.`)
  }
  const malformedRows = pages.reduce((count, page) => count + (page.events as unknown[]).filter((item) => !record(item)).length, 0)
  if (malformedRows) {
    complete = false
    warnings.push(`${malformedRows} malformed schedule rows were omitted; their window coverage is unknown.`)
  }
  const sourceRows = pages.flatMap((page) => rows(page.events))
  const missingLeagues = sourceRows.filter((row) => !hasLeagueIdentity(row.league))
  if (missingLeagues.length) {
    complete = false
    warnings.push(`${missingLeagues.length} schedule rows lack a valid league identity; their competition coverage is unknown.`)
  }
  const allowedRows = sourceRows.filter((row) => competitionForLeague(row.league))
  const missingStates = allowedRows.filter((row) => !str(row.state).trim())
  if (missingStates.length) {
    complete = false
    warnings.push(`${missingStates.length} allowed schedule rows lack a source state.`)
  }
  const invalidTimes = allowedRows.filter((row) => eventTime(row.startTime) === null)
  if (invalidTimes.length) {
    complete = false
    warnings.push(`${invalidTimes.length} allowed schedule rows have missing or invalid start times; their window coverage is unknown.`)
  }
  const windowStartMs = Date.parse(start)
  const windowEndMs = Date.parse(end)
  const withinWindow = allowedRows.filter((row) => {
    const time = eventTime(row.startTime)
    return time !== null && time >= windowStartMs && time <= windowEndMs
  })
  const matchIds = [...new Set(withinWindow.map((row) => str(record(row.match)?.id) || str(row.id)).filter(Boolean))]
  const details = new Map<string, Row>()
  if (matchIds.length > maxDetails) {
    complete = false
    warnings.push(`Event detail limit ${maxDetails} covers only ${maxDetails} of ${matchIds.length} allowed series.`)
  }
  for (const id of matchIds.slice(0, maxDetails)) {
    try {
      const detail = record(record((await request('getEventDetails', { id })).data)?.event)
      if (detail) details.set(id, detail)
      else { complete = false; warnings.push(`Missing event detail for match ${id}.`) }
    } catch (error) {
      complete = false
      warnings.push(`Event detail unavailable for match ${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const observations = withinWindow.map((event) => ({
    event,
    detail: details.get(str(record(event.match)?.id) || str(event.id)),
  }))
  return { feed: normalizeTournamentFeed({ observations, fetchedAt, coverageStart: start, coverageEnd: end, coverageComplete: complete, warnings }), requests: telemetry.requests, retries: telemetry.retries.length }
}

function record(value: unknown): Row | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : null }
function rows(value: unknown): Row[] { return Array.isArray(value) ? value.filter((item): item is Row => Boolean(record(item))) : [] }
function str(value: unknown): string { return typeof value === 'string' ? value : '' }
function hasLeagueIdentity(value: unknown): boolean {
  const league = record(value)
  return Boolean(league && [league.slug, league.name].some((part) => str(part).trim())
    && [league.slug, league.name].every((part) => part == null || typeof part === 'string'))
}
function eventTime(value: unknown): number | null {
  const text = str(value)
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(text)
  if (!parts) return null
  const [, year, month, day, hour, minute, second] = parts
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > daysInMonth
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null
  const time = Date.parse(text)
  return Number.isFinite(time) ? time : null
}
function schedule(body: Row): Row {
  const value = record(record(body.data)?.schedule)
  if (!value || !Array.isArray(value.events) || !record(value.pages)) throw new Error('Malformed getSchedule response')
  return value
}
function boundaryReached(page: Row, direction: 'older' | 'newer', start: string, end: string) {
  const times = rows(page.events).map((row) => eventTime(row.startTime)).filter((time): time is number => time !== null).sort((a, b) => a - b)
  return direction === 'older' ? Boolean(times.length && times[0]! <= Date.parse(start)) : Boolean(times.length && times.at(-1)! >= Date.parse(end))
}

async function main() {
  if (process.env.TOURNAMENT_COLLECTOR_ENABLED !== '1') throw new Error('Set TOURNAMENT_COLLECTOR_ENABLED=1 for an explicit local/staging collection.')
  const output = resolve(process.argv[2] ?? 'public/data/tournaments/feed.json')
  const lock = `${output}.lock`
  await mkdir(dirname(output), { recursive: true })
  const releaseLock = await acquireCollectorLock(lock)
  try {
    const priorRaw = await readFile(output, 'utf8').catch(() => '')
    const parsedPrior: unknown = priorRaw ? JSON.parse(priorRaw) : null
    if (parsedPrior && !isTournamentFeed(parsedPrior)) throw new Error('Existing tournament feed failed schema validation; restore a known-good feed before collecting.')
    const prior = isTournamentFeed(parsedPrior) ? parsedPrior : null
    try {
      const result = await collectTournamentFeed()
      await publishTournamentFeed(output, prior, result.feed)
      await writeHealth(output, { checkedAt: new Date().toISOString(), complete: result.feed.coverage.complete, requests: result.requests, retries: result.retries, warnings: result.feed.coverage.warnings })
      console.log(`Tournament reference check: ${result.feed.events.length} events, ${result.requests} requests, complete=${result.feed.coverage.complete}`)
    } catch (error) {
      await writeHealth(output, { checkedAt: new Date().toISOString(), complete: false, warnings: [error instanceof Error ? error.message : String(error)] })
      throw error
    }
  } finally {
    await releaseLock()
  }
}

export async function publishTournamentFeed(output: string, prior: ReturnType<typeof normalizeTournamentFeed> | null, candidate: ReturnType<typeof normalizeTournamentFeed>) {
  if (!candidate.coverage.complete) return false
  if (prior && JSON.stringify({ ...candidate, fetchedAt: '' }) === JSON.stringify({ ...prior, fetchedAt: '' })) return false
  await writeFile(`${output}.tmp`, `${JSON.stringify(candidate, null, 2)}\n`)
  await rename(`${output}.tmp`, output)
  return true
}

/** A dead local owner can be reclaimed; a live or remote owner cannot. */
export async function acquireCollectorLock(lock: string) {
  const token = randomUUID()
  try {
    await mkdir(lock)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const lockInfo = await stat(lock)
    const owner = await readFile(`${lock}/owner.json`, 'utf8').then((raw) => JSON.parse(raw) as { host?: string; pid?: number; token?: string; startedAt?: string }).catch(() => null)
    const ageMs = Date.now() - (owner?.startedAt ? Date.parse(owner.startedAt) : lockInfo.mtimeMs)
    if (!Number.isFinite(ageMs) || ageMs < 60_000 || owner && (owner.host !== hostname() || !Number.isInteger(owner.pid) || processAlive(owner.pid!))) {
      throw new Error(`Tournament collector lock is held: ${lock}`, { cause: error })
    }
    const moved = `${lock}.stale-${token}`
    await rename(lock, moved)
    const movedInfo = await stat(moved)
    if (movedInfo.ino !== lockInfo.ino) throw new Error(`Tournament collector lock changed during stale recovery: ${lock}`, { cause: error })
    await rm(moved, { recursive: true, force: true })
    await mkdir(lock)
  }
  await writeFile(`${lock}/owner.json`, JSON.stringify({ host: hostname(), pid: process.pid, token, startedAt: new Date().toISOString() }))
  return async () => {
    const owner = await readFile(`${lock}/owner.json`, 'utf8').then((raw) => JSON.parse(raw) as { token?: string }).catch(() => null)
    if (owner?.token === token) await rm(lock, { recursive: true, force: true })
  }
}

function processAlive(pid: number) {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

async function writeHealth(output: string, health: object) {
  await writeFile(`${output}.health.json.tmp`, `${JSON.stringify(health, null, 2)}\n`)
  await rename(`${output}.health.json.tmp`, `${output}.health.json`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main()
