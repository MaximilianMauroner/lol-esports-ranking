import type { PublicTeamHistoryAttributionKey } from './publicArtifacts/schema'
import type { TeamHistorySeries } from './snapshot'
import { isMatchChartPointDetail, type ChartAttributionEntry, type ChartModelDetail, type ChartPoint, type ChartPointDetail } from './chartPoints'
import { groupEntriesByDate } from './timelineCompaction'
import { POWER_COMPONENT_LABELS } from './ratingComponentLabels'

type TeamHistoryPoint = TeamHistorySeries['points'][number]
type TeamHistoryContext = NonNullable<TeamHistoryPoint[3]>
type TeamHistoryModelContext = NonNullable<TeamHistoryContext['model']>

const ATTRIBUTION_LABELS: Record<PublicTeamHistoryAttributionKey, Pick<ChartAttributionEntry, 'key' | 'label'>> = {
  s: { key: 'stable', label: POWER_COMPONENT_LABELS.stable },
  l: { key: 'league', label: POWER_COMPONENT_LABELS.league },
  p: { key: 'placement', label: 'Placement' },
  f: { key: 'form', label: POWER_COMPONENT_LABELS.form },
  r: { key: 'roster', label: POWER_COMPONENT_LABELS.roster },
  u: { key: 'uncertainty', label: 'Confidence' },
}
const COMPONENT_LABELS: Pick<ChartAttributionEntry, 'key' | 'label'>[] = [
  { key: 'league', label: POWER_COMPONENT_LABELS.league },
  { key: 'stable', label: POWER_COMPONENT_LABELS.stable },
  { key: 'roster', label: POWER_COMPONENT_LABELS.roster },
  { key: 'form', label: POWER_COMPONENT_LABELS.form },
  { key: 'context', label: POWER_COMPONENT_LABELS.context },
]

export function chartPointFromHistoryPoint(point: TeamHistoryPoint): ChartPoint {
  return {
    t: Date.parse(point[0]),
    y: point[1],
    detail: chartPointDetailFromHistoryPoint(point),
  }
}

export function chartPointDetailFromHistoryPoint(point: TeamHistoryPoint): ChartPointDetail | undefined {
  const context = point[3]
  if (!context) return undefined
  const model = chartModelDetailFromHistoryPoint(context.model, context.result)
  return {
    kind: context.kind ?? 'match',
    adjustmentReason: context.adjustmentReason,
    event: context.event,
    opponent: context.opponent,
    result: context.result,
    wins: context.wins,
    losses: context.losses,
    games: context.games,
    bestOf: context.bestOf,
    delta: context.delta,
    ...(model ? { model } : {}),
    sourceProvider: context.sourceProvider,
  }
}

export function dailyChartPointsFromHistoryPoints(points: TeamHistoryPoint[]): ChartPoint[] {
  return withVisibleDeltas(dailyHistoryGroups(points).map((group) => {
    const latest = group.points.at(-1)!
    return {
      t: Date.parse(group.date),
      y: latest[1],
      detail: chartPointDetailFromHistoryGroup(group.points),
    }
  }))
}

export function withVisibleDeltas(points: ChartPoint[]): ChartPoint[] {
  let previous: ChartPoint | undefined
  return points.map((point) => {
    const previousPoint = previous
    const visibleDelta = previousPoint ? roundOne(point.y - previousPoint.y) : undefined
    previous = point
    if (typeof visibleDelta !== 'number') return point
    return {
      ...point,
      detail: detailWithVisibleDelta(point.detail, previousPoint?.detail, visibleDelta),
    }
  })
}

export function deriveDailyRankSeries(history: Record<string, TeamHistorySeries>) {
  const updatesByDay = new Map<string, { key: string; rating: number; detail?: ChartPointDetail }[]>()
  for (const [key, series] of Object.entries(history)) {
    for (const group of dailyHistoryGroups(series.points)) {
      const latest = group.points.at(-1)!
      const rating = latest[1]
      if (!Number.isFinite(rating)) continue
      const updates = updatesByDay.get(group.date) ?? []
      updates.push({ key, rating, detail: chartPointDetailFromHistoryGroup(group.points) })
      updatesByDay.set(group.date, updates)
    }
  }

  const ratings = new Map<string, number>()
  const rankedSeries = new Map<string, ChartPoint[]>()
  const days = [...updatesByDay.keys()].sort()
  for (const day of days) {
    const dayDetails = new Map<string, ChartPointDetail>()
    for (const update of updatesByDay.get(day) ?? []) {
      ratings.set(update.key, update.rating)
      if (update.detail) dayDetails.set(update.key, update.detail)
    }
    const rankedKeys = [...ratings.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([key]) => key)
    const t = Date.parse(day)
    for (let index = 0; index < rankedKeys.length; index += 1) {
      const key = rankedKeys[index]
      const points = rankedSeries.get(key) ?? []
      const detail = dayDetails.get(key)
      points.push({ t, y: index + 1, ...(detail ? { detail } : {}) })
      rankedSeries.set(key, points)
    }
  }

  for (const [key, points] of rankedSeries) {
    rankedSeries.set(key, withRankVisibleDeltas(points))
  }
  return rankedSeries
}

function dailyHistoryGroups(points: TeamHistoryPoint[]) {
  return groupEntriesByDate(
    points.filter((point) => Number.isFinite(point[1])),
    (point) => point[0],
  ).map(({ date, entries }) => ({ date, points: entries }))
}

function chartPointDetailFromHistoryGroup(points: TeamHistoryPoint[]): ChartPointDetail | undefined {
  const details = points
    .map((point) => chartPointDetailFromHistoryPoint(point))
    .filter((detail): detail is ChartPointDetail => Boolean(detail))
  const latest = details.at(-1)
  if (!latest) return undefined
  if (details.length <= 1) return latest

  const matchDetails = details.filter(isMatchChartPointDetail)
  const matchCount = matchDetails.length
  const ledgerDelta = roundOne(matchDetails.reduce((total, detail) => total + (finiteNumber(detail.delta) ?? 0), 0))
  const model = aggregateChartModelDetails(details)
  return {
    ...latest,
    delta: matchCount > 1 ? ledgerDelta : latest.delta,
    dayMatchCount: matchCount,
    dayMatches: details,
    ...(model ? { model } : {}),
  }
}

function chartModelDetailFromHistoryPoint(
  model: TeamHistoryContext['model'],
  result?: 'W' | 'L' | 'T',
): ChartModelDetail | undefined {
  if (!model) return undefined
  const attribution = model.a
    ?.map(([key, value]) => {
      const label = ATTRIBUTION_LABELS[key]
      return label && Number.isFinite(value) ? { ...label, value } : undefined
    })
    .filter((entry): entry is ChartAttributionEntry => Boolean(entry))
  const residual = typeof model.r === 'number'
    ? model.r
    : typeof model.e === 'number'
      ? residualFromExpected(model.e, result)
      : undefined
  const detail: ChartModelDetail = {
    expectedWinProbability: model.e,
    residual,
    evidence: model.v,
    strengthSignal: model.s,
    components: chartComponentsFromHistoryPoint(model.c),
    ...(attribution?.length ? { attribution } : {}),
  }
  return omitUndefined(detail)
}

function chartComponentsFromHistoryPoint(components: TeamHistoryModelContext['c']): ChartAttributionEntry[] | undefined {
  if (!components) return undefined
  const entries = components
    .map((value, index) => {
      const label = COMPONENT_LABELS[index]
      return label && Number.isFinite(value) ? { ...label, value } : undefined
    })
    .filter((entry): entry is ChartAttributionEntry => Boolean(entry))
  return entries.length > 0 ? entries : undefined
}

function residualFromExpected(expected: number, result?: 'W' | 'L' | 'T') {
  if (!Number.isFinite(expected) || !result) return undefined
  const observed = result === 'W' ? 1 : result === 'T' ? 0.5 : 0
  return roundOptional(observed - expected, 3)
}

function aggregateChartModelDetails(details: ChartPointDetail[]): ChartModelDetail | undefined {
  const models = details.map((detail) => detail.model).filter((model): model is ChartModelDetail => Boolean(model))
  if (models.length === 0) return undefined
  const matchExpected = details
    .filter(isMatchChartPointDetail)
    .map((detail) => detail.model?.expectedWinProbability)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))

  const attributionByKey = new Map<ChartAttributionEntry['key'], ChartAttributionEntry>()
  for (const model of models) {
    for (const entry of model.attribution ?? []) {
      const current = attributionByKey.get(entry.key)
      attributionByKey.set(entry.key, {
        ...entry,
        value: roundOne((current?.value ?? 0) + entry.value),
      })
    }
  }
  const attribution = [...attributionByKey.values()].filter((entry) => Math.abs(entry.value) >= 0.05)
  const detail: ChartModelDetail = {
    residual: roundOptional(sumModel(models, 'residual'), 3),
    evidence: roundOptional(sumModel(models, 'evidence'), 1),
    strengthSignal: roundOptional(sumModel(models, 'strengthSignal'), 2),
    components: models.at(-1)?.components,
    expectedWinProbability: matchExpected.length === 1 ? matchExpected[0] : undefined,
    ...(attribution.length > 0 ? { attribution } : {}),
  }
  return omitUndefined(detail)
}

function sumModel(models: ChartModelDetail[], key: keyof ChartModelDetail) {
  let total = 0
  let seen = false
  for (const model of models) {
    const value = finiteNumber(model[key])
    if (typeof value !== 'number') continue
    total += value
    seen = true
  }
  return seen ? total : undefined
}

function withRankVisibleDeltas(points: ChartPoint[]): ChartPoint[] {
  let previous: ChartPoint | undefined
  return points.map((point) => {
    const previousPoint = previous
    const visibleDelta = previousPoint ? roundOne(point.y - previousPoint.y) : undefined
    previous = point
    if (typeof visibleDelta !== 'number') return point
    if (point.detail) {
      return { ...point, detail: detailWithVisibleDelta(point.detail, previousPoint?.detail, visibleDelta) }
    }
    return visibleDelta === 0 ? point : { ...point, detail: { passive: true, visibleDelta } }
  })
}

function detailWithVisibleDelta(
  detail: ChartPointDetail | undefined,
  previousDetail: ChartPointDetail | undefined,
  visibleDelta: number,
): ChartPointDetail {
  const componentAttribution = componentAttributionFrom(previousDetail?.model?.components, detail?.model?.components)
  return {
    ...(detail ?? {}),
    visibleDelta,
    ...(componentAttribution ? {
      model: {
        ...(detail?.model ?? {}),
        componentAttribution,
      },
    } : {}),
  }
}

function componentAttributionFrom(
  previous: ChartAttributionEntry[] | undefined,
  current: ChartAttributionEntry[] | undefined,
) {
  if (!previous || !current) return undefined
  const previousByKey = new Map(previous.map((entry) => [entry.key, entry.value]))
  const attribution = current
    .map((entry): ChartAttributionEntry | undefined => {
      const previousValue = previousByKey.get(entry.key)
      if (typeof previousValue !== 'number') return undefined
      const value = roundOne(entry.value - previousValue)
      return Math.abs(value) >= 0.05 ? { ...entry, value } : undefined
    })
    .filter((entry): entry is ChartAttributionEntry => Boolean(entry))
  return attribution.length > 0 ? attribution : undefined
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function roundOne(value: number) {
  const rounded = Math.round(value * 10) / 10
  return Object.is(rounded, -0) ? 0 : rounded
}

function roundOptional(value: number | undefined, decimals: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const factor = 10 ** decimals
  const rounded = Math.round(value * factor) / factor
  const normalized = Object.is(rounded, -0) ? 0 : rounded
  return Math.abs(normalized) < 0.05 ? undefined : normalized
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined)
  return entries.length > 0 ? Object.fromEntries(entries) as T : undefined
}
