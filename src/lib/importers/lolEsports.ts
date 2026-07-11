export type LolEsportsScheduleSnapshot = {
  source?: string
  fetchedAt?: string
  locale?: string
  start?: string
  end?: string
  unsupportedApi?: boolean
  events?: unknown[]
  schedulePages?: unknown[]
  eventDetails?: unknown[] | Record<string, unknown>
  warnings?: string[]
}

export type LolEsportsReferenceTeam = {
  id?: string
  name: string
  code?: string
  image?: string
  side?: 'blue' | 'red'
  gameWins?: number
  outcome?: string
  record?: {
    wins?: number
    losses?: number
  }
}

export type LolEsportsReferenceGame = {
  id: string
  number?: number
  state?: string
  teams: Array<{
    id?: string
    side?: 'blue' | 'red'
  }>
}

export type LolEsportsReferenceEvent = {
  sourceProvider: 'lol-esports-api'
  matchId: string
  tournamentId?: string
  leagueId?: string
  leagueName?: string
  leagueSlug?: string
  startTime?: string
  date?: string
  state?: string
  type?: string
  blockName?: string
  strategy?: {
    type?: string
    count?: number
  }
  teams: LolEsportsReferenceTeam[]
  gameIds: string[]
  games: LolEsportsReferenceGame[]
}

export type LolEsportsReferenceImportResult = {
  events: LolEsportsReferenceEvent[]
  source: {
    name: string
    url?: string
    fileName?: string
    retrievedAt: string
    eventCount: number
    gameCount: number
    attribution: string
    start?: string
    end?: string
    coverageStartComplete: boolean
    coverageEndComplete: boolean
    unsupportedApi: true
  }
}

export function importLolEsportsScheduleSnapshot(
  snapshot: LolEsportsScheduleSnapshot,
  options: {
    sourceUrl?: string
    sourceFileName?: string
    retrievedAt?: string
  } = {},
): LolEsportsReferenceImportResult {
  const detailsByMatchId = eventDetailsByMatchId(snapshot)
  const events = uniqueEventsByMatchId(scheduleEvents(snapshot)
    .map((event) => normalizeEvent(event, detailsByMatchId))
    .filter((event): event is LolEsportsReferenceEvent => Boolean(event)))
    .sort((left, right) => (left.startTime ?? '').localeCompare(right.startTime ?? '') || left.matchId.localeCompare(right.matchId))

  return {
    events,
    source: {
      name: 'LoL Esports schedule API',
      url: options.sourceUrl ?? snapshot.source ?? 'https://esports-api.lolesports.com/persisted/gw/getSchedule',
      fileName: options.sourceFileName,
      retrievedAt: options.retrievedAt ?? snapshot.fetchedAt ?? new Date().toISOString(),
      eventCount: events.length,
      gameCount: events.reduce((total, event) => total + event.gameIds.length, 0),
      attribution: 'Schedule, result, event, and game IDs from LoL Esports site persisted APIs. These endpoints are unsupported and must stay cached/reference-only.',
      start: snapshot.start,
      end: snapshot.end,
      coverageStartComplete: !(snapshot.warnings ?? []).some((warning) => /schedule cache starts at/i.test(warning)),
      coverageEndComplete: !(snapshot.warnings ?? []).some((warning) => /schedule cache ends at/i.test(warning)),
      unsupportedApi: true,
    },
  }
}

function uniqueEventsByMatchId(events: LolEsportsReferenceEvent[]) {
  return [...new Map(events.map((event) => [event.matchId, event])).values()]
}

function scheduleEvents(snapshot: LolEsportsScheduleSnapshot) {
  const directEvents = arrayValue(snapshot.events)
  const pageEvents = arrayValue(snapshot.schedulePages).flatMap((page) => {
    const pageRecord = objectValue(page)
    if (!pageRecord) return []
    const pageDirectEvents = arrayValue(pageRecord.events)
    if (pageDirectEvents.length > 0) return pageDirectEvents
    return arrayValue(objectPath(pageRecord, ['data', 'schedule', 'events']))
  })
  const rawScheduleEvents = arrayValue(objectPath(snapshot, ['data', 'schedule', 'events']))
  return [...directEvents, ...pageEvents, ...rawScheduleEvents]
}

function eventDetailsByMatchId(snapshot: LolEsportsScheduleSnapshot) {
  const details = new Map<string, Record<string, unknown>>()
  const sourceDetails = snapshot.eventDetails

  if (Array.isArray(sourceDetails)) {
    for (const detail of sourceDetails) {
      const event = detailEventRecord(detail)
      const id = stringValue(event?.id)
      if (event && id) details.set(id, event)
    }
  } else {
    const detailRecord = objectValue(sourceDetails)
    for (const [id, detail] of Object.entries(detailRecord ?? {})) {
      const event = detailEventRecord(detail) ?? objectValue(detail)
      if (event) details.set(stringValue(event.id) || id, event)
    }
  }

  return details
}

function detailEventRecord(detail: unknown) {
  const record = objectValue(detail)
  if (!record) return undefined
  return objectValue(record.event) ?? objectValue(objectPath(record, ['data', 'event']))
}

function normalizeEvent(eventValue: unknown, detailsByMatchId: Map<string, Record<string, unknown>>): LolEsportsReferenceEvent | undefined {
  const event = objectValue(eventValue)
  if (!event) return undefined
  const match = objectValue(event.match)
  const matchId = stringValue(match?.id) || stringValue(event.id)
  if (!match || !matchId) return undefined

  const detail = detailsByMatchId.get(matchId)
  const detailMatch = objectValue(detail?.match)
  const league = objectValue(detail?.league) ?? objectValue(event.league)
  const detailTournament = objectValue(detail?.tournament)
  const games = normalizeGames(arrayValue(detailMatch?.games))
  const scheduleTeams = normalizeTeams(arrayValue(match.teams))
  const detailTeams = normalizeTeams(arrayValue(detailMatch?.teams))
  const startTime = optionalString(event.startTime)
  const date = startTime?.slice(0, 10)
  const strategy = normalizeStrategy(objectValue(match.strategy) ?? objectValue(detailMatch?.strategy))

  return {
    sourceProvider: 'lol-esports-api',
    matchId,
    ...optionalEntry('tournamentId', optionalString(detailTournament?.id)),
    ...optionalEntry('leagueId', optionalString(league?.id)),
    ...optionalEntry('leagueName', optionalString(league?.name)),
    ...optionalEntry('leagueSlug', optionalString(league?.slug)),
    ...optionalEntry('startTime', startTime),
    ...optionalEntry('date', date),
    ...optionalEntry('state', optionalString(event.state)),
    ...optionalEntry('type', optionalString(event.type)),
    ...optionalEntry('blockName', optionalString(event.blockName)),
    ...(strategy ? { strategy } : {}),
    teams: mergeTeams(scheduleTeams, detailTeams),
    gameIds: games.map((game) => game.id),
    games,
  }
}

function normalizeStrategy(strategy: Record<string, unknown> | undefined) {
  if (!strategy) return undefined
  const type = optionalString(strategy.type)
  const count = numberValue(strategy.count)
  if (!type && count === undefined) return undefined
  return {
    ...optionalEntry('type', type),
    ...optionalEntry('count', count),
  }
}

function normalizeTeams(values: unknown[]) {
  return values
    .map((value): LolEsportsReferenceTeam | undefined => {
      const team = objectValue(value)
      const name = stringValue(team?.name)
      const id = stringValue(team?.id)
      if (!team || (!name && !id)) return undefined
      const result = objectValue(team.result)
      const record = objectValue(team.record)
      return {
        ...optionalEntry('id', id || undefined),
        name,
        ...optionalEntry('code', optionalString(team.code)),
        ...optionalEntry('image', optionalString(team.image)),
        ...optionalEntry('side', sideValue(team.side)),
        ...optionalEntry('gameWins', numberValue(result?.gameWins)),
        ...optionalEntry('outcome', optionalString(result?.outcome)),
        ...(record
          ? {
              record: {
                ...optionalEntry('wins', numberValue(record.wins)),
                ...optionalEntry('losses', numberValue(record.losses)),
              },
            }
          : {}),
      }
    })
    .filter((team): team is LolEsportsReferenceTeam => Boolean(team))
}

function mergeTeams(scheduleTeams: LolEsportsReferenceTeam[], detailTeams: LolEsportsReferenceTeam[]) {
  if (detailTeams.length === 0) return scheduleTeams
  if (scheduleTeams.length === 0) return detailTeams
  return scheduleTeams.map((team) => {
    const detailTeam = detailTeams.find((candidate) => candidate.id === team.id || candidate.name === team.name)
    return {
      ...(detailTeam ?? {}),
      ...team,
    }
  })
}

function normalizeGames(values: unknown[]) {
  return values
    .map((value): LolEsportsReferenceGame | undefined => {
      const game = objectValue(value)
      const id = stringValue(game?.id)
      if (!game || !id) return undefined
      return {
        id,
        number: numberValue(game.number),
        state: stringValue(game.state),
        teams: arrayValue(game.teams)
          .map((teamValue): LolEsportsReferenceGame['teams'][number] => {
            const team = objectValue(teamValue)
            return {
              ...optionalEntry('id', optionalString(team?.id)),
              ...optionalEntry('side', sideValue(team?.side)),
            }
          })
          .filter((team) => team.id || team.side),
      }
    })
    .filter((game): game is LolEsportsReferenceGame => Boolean(game))
}

function objectPath(value: unknown, path: string[]) {
  let current = value
  for (const key of path) {
    const record = objectValue(current)
    if (!record) return undefined
    current = record[key]
  }
  return current
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function optionalString(value: unknown) {
  const text = stringValue(value)
  return text || undefined
}

function optionalEntry<Key extends string, Value>(key: Key, value: Value | undefined) {
  return value === undefined ? {} : { [key]: value } as Record<Key, Value>
}

function sideValue(value: unknown): 'blue' | 'red' | undefined {
  const side = stringValue(value).toLowerCase()
  if (side === 'blue' || side === 'red') return side
  return undefined
}
