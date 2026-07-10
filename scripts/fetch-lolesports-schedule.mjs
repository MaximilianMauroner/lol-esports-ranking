import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const publicPersistedApiKey = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z'
const defaultPersistedBaseUrl = 'https://esports-api.lolesports.com/persisted/gw'

const args = parseArgs(process.argv.slice(2))
const persistedBaseUrl = args.baseUrl ?? args['base-url'] ?? defaultPersistedBaseUrl
const locale = args.locale ?? 'en-US'
const start = args.start ?? offsetDate(-14)
const end = args.end ?? offsetDate(30)
const output = resolve(args.output ?? `data/raw/lolesports/schedule-${start}_to_${end}.json`)
const olderPages = numberArg(args.olderPages ?? args['older-pages'], 4)
const newerPages = numberArg(args.newerPages ?? args['newer-pages'], 1)
const detailLimit = numberArg(args.detailLimit ?? args['detail-limit'], 250)
const detailDelayMs = numberArg(args.detailDelayMs ?? args['detail-delay-ms'], 250)
const fetchDetails = !isFalse(args.details)
const userAgent = args.userAgent ?? 'lol-esports-power-index-local/0.1 (unsupported lolesports reference cache)'
const warnings = [
  'LoL Esports persisted APIs are public site endpoints, not a supported official data API. Cache responses and use them as reference metadata only.',
]

const schedulePages = []
const initialPage = await fetchSchedulePage()
schedulePages.push(pageCacheEntry('initial', undefined, initialPage))

await fetchDirectionalPages({
  direction: 'older',
  pageLimit: olderPages,
  firstToken: pageToken(initialPage, 'older'),
})
await fetchDirectionalPages({
  direction: 'newer',
  pageLimit: newerPages,
  firstToken: pageToken(initialPage, 'newer'),
})

const events = uniqueEvents(schedulePages.flatMap((page) => page.events))
const selectedEvents = events.filter((event) => eventWithinRange(event, start, end))
const eventDetails = []

if (fetchDetails) {
  const detailEvents = selectedEvents.slice(0, detailLimit)
  if (selectedEvents.length > detailEvents.length) {
    warnings.push(`LoL Esports event-detail fetch limited to ${detailLimit} of ${selectedEvents.length} schedule events. Increase --detail-limit to cache more game IDs.`)
  }

  for (const event of detailEvents) {
    const id = event.match?.id ?? event.id
    if (!id) continue
    try {
      eventDetails.push({ id, event: await fetchEventDetails(id) })
      if (detailDelayMs > 0) await sleep(detailDelayMs)
    } catch (error) {
      warnings.push(`LoL Esports getEventDetails failed for ${id}: ${errorMessage(error)}`)
    }
  }
} else {
  warnings.push('LoL Esports event-detail fetch skipped, so cached records may not include per-game IDs.')
}

warnIfWindowIsPartial(events, start, end, warnings)

await mkdir(dirname(output), { recursive: true })
await writeFile(
  output,
  `${JSON.stringify({
    source: `${persistedBaseUrl}/getSchedule`,
    fetchedAt: new Date().toISOString(),
    locale,
    start,
    end,
    unsupportedApi: true,
    pageLimits: {
      olderPages,
      newerPages,
      detailLimit,
    },
    events: selectedEvents,
    schedulePages,
    eventDetails,
    warnings,
  }, null, 2)}\n`,
)

console.log(`Wrote ${selectedEvents.length} LoL Esports schedule events and ${eventDetails.length} event-detail records to ${output}`)
if (warnings.length > 0) {
  for (const warning of warnings) console.warn(`Warning: ${warning}`)
}

async function fetchDirectionalPages({ direction, pageLimit, firstToken }) {
  let token = firstToken
  for (let index = 0; index < pageLimit && token; index += 1) {
    const page = await fetchSchedulePage(token)
    schedulePages.push(pageCacheEntry(direction, token, page))
    token = pageToken(page, direction)
    await sleep(250)
  }
}

async function fetchSchedulePage(pageTokenValue) {
  const url = persistedUrl('getSchedule')
  url.searchParams.set('hl', locale)
  if (pageTokenValue) url.searchParams.set('pageToken', pageTokenValue)
  return persistedJson(url)
}

async function fetchEventDetails(id) {
  const url = persistedUrl('getEventDetails')
  url.searchParams.set('hl', locale)
  url.searchParams.set('id', id)
  const response = await persistedJson(url)
  return response?.data?.event
}

async function persistedJson(url) {
  const response = await fetch(url, {
    headers: {
      'x-api-key': publicPersistedApiKey,
      'user-agent': userAgent,
    },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`)
  return response.json()
}

function persistedUrl(path) {
  return new URL(`${persistedBaseUrl}/${path}`)
}

function pageCacheEntry(direction, requestedPageToken, response) {
  const schedule = response?.data?.schedule ?? {}
  return {
    direction,
    requestedPageToken,
    updated: schedule.updated,
    pages: schedule.pages,
    events: Array.isArray(schedule.events) ? schedule.events : [],
  }
}

function pageToken(page, direction) {
  return page?.data?.schedule?.pages?.[direction]
}

function uniqueEvents(values) {
  const eventsById = new Map()
  for (const event of values) {
    const id = event?.match?.id ?? event?.id
    const key = id || `${event?.startTime ?? 'unknown'}:${event?.league?.slug ?? 'unknown'}:${event?.blockName ?? 'unknown'}`
    if (!eventsById.has(key)) eventsById.set(key, event)
  }
  return Array.from(eventsById.values()).sort((left, right) => String(left?.startTime ?? '').localeCompare(String(right?.startTime ?? '')))
}

function eventWithinRange(event, startDate, endDate) {
  const date = String(event?.startTime ?? '').slice(0, 10)
  return date >= startDate && date <= endDate
}

function warnIfWindowIsPartial(events, startDate, endDate, targetWarnings) {
  const dates = events.map((event) => String(event?.startTime ?? '').slice(0, 10)).filter(Boolean).sort()
  const earliest = dates[0]
  const latest = dates.at(-1)
  if (earliest && earliest > startDate) {
    targetWarnings.push(`LoL Esports schedule cache starts at ${earliest}, after requested start ${startDate}; increase --older-pages for a wider reference window.`)
  }
  if (latest && latest < endDate) {
    targetWarnings.push(`LoL Esports schedule cache ends at ${latest}, before requested end ${endDate}; increase --newer-pages for a wider reference window.`)
  }
}

function offsetDate(days) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function numberArg(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback
}

function isFalse(value) {
  return value === false || value === 'false'
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function parseArgs(rawArgs) {
  const parsed = {}
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = rawArgs[index + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = true
      parsed[toCamelCase(key)] = true
    } else {
      parsed[key] = next
      parsed[toCamelCase(key)] = next
      index += 1
    }
  }
  return parsed
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
}
