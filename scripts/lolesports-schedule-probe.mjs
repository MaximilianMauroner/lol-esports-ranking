const PUBLIC_API_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z'
const DEFAULT_BASE_URL = 'https://esports-api.lolesports.com/persisted/gw'

export async function fetchScheduleProbe({
  fetcher = fetch,
  baseUrl = DEFAULT_BASE_URL,
  locale = 'en-US',
  watermark,
  now = new Date(),
  recoveryHours = 48,
  maxOlderPages = 16,
  requestTimeoutMs = 15_000,
} = {}) {
  const checkedAt = new Date(now).toISOString()
  const targetWatermark = watermark
    ? new Date(watermark).toISOString()
    : new Date(new Date(now).getTime() - recoveryHours * 60 * 60_000).toISOString()
  const pages = []
  let token
  let reachedWatermark = false

  for (let pageIndex = 0; pageIndex <= maxOlderPages; pageIndex += 1) {
    const response = await persistedJson('getSchedule', {
      fetcher,
      baseUrl,
      locale,
      pageToken: token,
      requestTimeoutMs,
    })
    const schedule = response?.data?.schedule ?? {}
    const events = Array.isArray(schedule.events) ? schedule.events : []
    pages.push(events)
    const earliest = eventTimes(events).at(0)
    if (earliest && earliest <= targetWatermark) {
      reachedWatermark = true
      break
    }
    token = schedule.pages?.older
    if (!token) {
      reachedWatermark = true
      break
    }
  }

  const rawEvents = uniqueRawEvents(pages.flat())
  const normalized = rawEvents.map(normalizeScheduleEvent).filter(Boolean)
  const candidates = normalized.filter((event) => terminalState(event.state) && !finalWinner(event.teams))
  const details = new Map()

  for (const candidate of candidates) {
    try {
      const response = await persistedJson('getEventDetails', {
        fetcher,
        baseUrl,
        locale,
        id: candidate.matchId,
        requestTimeoutMs,
      })
      const detail = response?.data?.event
      if (detail) details.set(candidate.matchId, detail)
    } catch {
      // Candidate stays uncertain; a later probe retries without triggering scored providers.
    }
  }

  const events = rawEvents
    .map((event) => normalizeScheduleEvent(mergeEventDetail(event, details)))
    .filter(Boolean)
  const times = eventTimes(rawEvents)

  return {
    checkedAt,
    targetWatermark,
    coverageStart: times.at(0) ?? null,
    coverageEnd: times.at(-1) ?? null,
    coverageComplete: reachedWatermark,
    pageCount: pages.length,
    events,
  }
}

export function normalizeScheduleEvent(value) {
  const event = objectValue(value)
  const match = objectValue(event?.match)
  const matchId = stringValue(match?.id) || stringValue(event?.id)
  if (!event || !match || !matchId) return undefined
  const startTime = stringValue(event.startTime)
  const teams = arrayValue(match.teams).map(normalizeTeam).filter(Boolean)
  return {
    matchId,
    state: stringValue(event.state),
    startTime: startTime || undefined,
    teams,
  }
}

async function persistedJson(path, { fetcher, baseUrl, locale, pageToken, id, requestTimeoutMs }) {
  const url = new URL(`${baseUrl}/${path}`)
  url.searchParams.set('hl', locale)
  if (pageToken) url.searchParams.set('pageToken', pageToken)
  if (id) url.searchParams.set('id', id)
  const response = await fetcher(url, {
    headers: {
      'x-api-key': PUBLIC_API_KEY,
      'user-agent': 'lol-esports-power-index-trigger/1.0 (unsupported reference probe)',
    },
    signal: AbortSignal.timeout(requestTimeoutMs),
  })
  if (!response.ok) {
    const retryAfter = response.headers?.get?.('retry-after')
    throw new Error(`HTTP ${response.status} from ${path}${retryAfter ? `; retry-after=${retryAfter}` : ''}`)
  }
  return response.json()
}

function mergeEventDetail(eventValue, details) {
  const event = objectValue(eventValue)
  const matchId = stringValue(event?.match?.id) || stringValue(event?.id)
  const detail = objectValue(details.get(matchId))
  const detailMatch = objectValue(detail?.match)
  if (!detailMatch) return event
  return {
    ...event,
    state: stringValue(detail.state) || event.state,
    match: {
      ...event.match,
      ...detailMatch,
      teams: arrayValue(detailMatch.teams).length > 0 ? detailMatch.teams : event.match?.teams,
    },
  }
}

function normalizeTeam(value) {
  const team = objectValue(value)
  if (!team) return undefined
  const id = stringValue(team.id)
  const name = stringValue(team.name)
  if (!id && !name) return undefined
  const result = objectValue(team.result)
  return {
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(Number.isFinite(result?.gameWins) ? { gameWins: Number(result.gameWins) } : {}),
    ...(stringValue(result?.outcome) ? { outcome: stringValue(result.outcome).toLowerCase() } : {}),
  }
}

function uniqueRawEvents(values) {
  return [...new Map(values.map((event) => [stringValue(event?.match?.id) || stringValue(event?.id), event]).filter(([id]) => id)).values()]
}

function eventTimes(events) {
  return events.map((event) => stringValue(event?.startTime)).filter(Boolean).sort()
}

function finalWinner(teams) {
  return teams.find((team) => team.outcome === 'win')
    ?? (teams.length === 2 && teams.every((team) => Number.isFinite(team.gameWins)) && teams[0].gameWins !== teams[1].gameWins
      ? teams.toSorted((left, right) => right.gameWins - left.gameWins)[0]
      : undefined)
}

function terminalState(value) {
  return /^(?:complete|completed)$/i.test(value ?? '')
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function arrayValue(value) {
  return Array.isArray(value) ? value : []
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : ''
}
