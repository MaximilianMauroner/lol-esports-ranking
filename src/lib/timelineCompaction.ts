export type TimelineResult = 'W' | 'L'

export type TimelineSourceTrace = {
  provider?: string
  gameId?: string
  matchId?: string
  fileName?: string
  url?: string
  bestOf?: number
}

export type TimelineGroup<T> = {
  key: string
  entries: T[]
}

export type TimelineResultSummary = {
  wins: number
  losses: number
  games: number
  result?: TimelineResult
}

export type TimelineSourceSummary = {
  sourceProvider?: string
  sourceGameId?: string
  sourceMatchId?: string
  sourceFileName?: string
  sourceUrl?: string
  sourceGameIds?: string[]
}

export function timelineGroupKey(parts: Array<string | number | undefined | null>) {
  return parts.map((part) => String(part ?? '')).join('\u0000')
}

export function groupAdjacentTimelineEntries<T>(
  entries: T[],
  keyFor: (entry: T) => string,
): TimelineGroup<T>[] {
  const groups: TimelineGroup<T>[] = []

  for (const entry of entries) {
    const key = keyFor(entry)
    const current = groups.at(-1)
    if (current?.key === key) {
      current.entries.push(entry)
      continue
    }
    groups.push({ key, entries: [entry] })
  }

  return groups
}

export function groupTimelineEntriesByKey<T>(
  entries: T[],
  keyFor: (entry: T) => string,
): TimelineGroup<T>[] {
  const groups = new Map<string, T[]>()
  for (const entry of entries) {
    const key = keyFor(entry)
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  return Array.from(groups.entries()).map(([key, groupEntries]) => ({ key, entries: groupEntries }))
}

export function groupEntriesByDate<T>(
  entries: T[],
  dateFor: (entry: T) => string | undefined,
) {
  const byDate = new Map<string, T[]>()
  for (const entry of entries) {
    const date = dateFor(entry)
    if (!date) continue
    const dateEntries = byDate.get(date) ?? []
    dateEntries.push(entry)
    byDate.set(date, dateEntries)
  }
  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, dateEntries]) => ({ date, entries: dateEntries }))
}

export function summarizeTimelineResults<T>(
  entries: T[],
  resultFor: (entry: T) => TimelineResult | undefined,
): TimelineResultSummary {
  const wins = entries.filter((entry) => resultFor(entry) === 'W').length
  const losses = entries.filter((entry) => resultFor(entry) === 'L').length
  const result = wins === losses ? undefined : wins > losses ? 'W' : 'L'
  return { wins, losses, games: wins + losses, ...(result ? { result } : {}) }
}

export function isResolvedTimelineResult(summary: Pick<TimelineResultSummary, 'wins' | 'losses'>) {
  return summary.wins !== summary.losses
}

export function inferBestOfForScore(wins: number, losses: number, explicit?: number) {
  const games = wins + losses
  if (games <= 0) return explicit
  const requiredWins = Math.max(wins, losses)
  const inferred = wins === losses ? games : Math.max(games, requiredWins * 2 - 1)
  if (typeof explicit !== 'number' || !Number.isFinite(explicit)) return inferred

  const explicitGames = Math.trunc(explicit)
  const winsNeeded = Math.floor(explicitGames / 2) + 1
  return games <= explicitGames && requiredWins >= winsNeeded ? explicitGames : inferred
}

export function timelineSourceSummary<T>(
  entries: T[],
  sourceFor: (entry: T) => TimelineSourceTrace | undefined,
): TimelineSourceSummary {
  const latest = entries.at(-1)
  const latestSource = latest ? sourceFor(latest) : undefined
  const sourceGameIds = uniqueValues(
    entries
      .map((entry) => sourceFor(entry)?.gameId)
      .filter((value): value is string => Boolean(value)),
  )

  return omitUndefined({
    sourceProvider: latestSource?.provider,
    sourceGameId: sourceGameIds.at(-1),
    sourceMatchId: latestSource?.matchId,
    sourceFileName: latestSource?.fileName,
    sourceUrl: latestSource?.url,
    ...(sourceGameIds.length > 1 ? { sourceGameIds } : {}),
  }) ?? {}
}

export function uniqueValues<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined)
  return entries.length > 0 ? Object.fromEntries(entries) as T : undefined
}
