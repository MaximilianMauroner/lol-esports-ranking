import type { DeservedStandingPlayerResumeLedger, EventTier, Role } from '../types'
import {
  buildCausalPrefixSummary,
  causalInputRow,
  reconcileCausalPrefix,
  type CausalInputRow,
  type CausalPrefixSummary,
} from './causalRecompute'

export type DssPlayerResumeSeriesPlayer = {
  id: string
  role: Role
  share: number
}

export type DssPlayerResumeSeriesInput = {
  seriesKey: string
  date: string
  season: number
  splitId?: string
  event: string
  tier: EventTier
  team: string
  weightedSeriesValue: number
  players: DssPlayerResumeSeriesPlayer[]
  international?: boolean
}

export type DssPlayerResumeCreditEntry = {
  playerId: string
  role: Role
  team: string
  seriesKey: string
  date: string
  season: number
  splitId?: string
  event: string
  tier: EventTier
  weightedSeriesValue: number
  contributionShare: number
  resumeCredit: number
  international: boolean
}

export type BuildDssPlayerResumeLedgerOptions = {
  currentSeason?: number
  currentSplitId?: string
  uncertaintyFor?: (playerId: string, entries: DssPlayerResumeCreditEntry[]) => number
}

export type DssPlayerResumeLedgerModel = {
  ledgers: DeservedStandingPlayerResumeLedger[]
  creditEntries: DssPlayerResumeCreditEntry[]
  currentSeason?: number
  currentSplitId?: string
}

export function buildDssPlayerResumeLedgers(
  series: DssPlayerResumeSeriesInput[],
  options: BuildDssPlayerResumeLedgerOptions = {},
): DssPlayerResumeLedgerModel {
  const creditEntries = playerResumeCreditEntries(series)
  const currentSeason = options.currentSeason ?? latestSeason(creditEntries)
  const currentSplitId = options.currentSplitId ?? latestSplitId(creditEntries, currentSeason)
  const uncertaintyFor = options.uncertaintyFor ?? defaultUncertaintyFor
  const entriesByPlayer = groupBy(creditEntries, (entry) => entry.playerId)
  const ledgers = Array.from(entriesByPlayer.entries())
    .map(([playerId, entries]) => playerResumeLedgerFor(playerId, entries, {
      currentSeason,
      currentSplitId,
      uncertaintyFor,
    }))
    .sort((left, right) => right.careerResumeCredit - left.careerResumeCredit || left.playerId.localeCompare(right.playerId))

  return {
    ledgers,
    creditEntries,
    ...(currentSeason === undefined ? {} : { currentSeason }),
    ...(currentSplitId === undefined ? {} : { currentSplitId }),
  }
}

export function playerResumeCausalInputs(
  series: readonly DssPlayerResumeSeriesInput[],
  contextInputs: readonly CausalInputRow[] = [],
) {
  return [
    ...series.map((entry) => causalInputRow(`series:${entry.seriesKey}:${entry.team}`, entry.date, entry)),
    ...contextInputs,
  ]
}

export function buildDssPlayerResumeCausalSummary({
  prefixSeries,
  processedThroughUtcDate,
  contextInputs = [],
}: {
  prefixSeries: readonly DssPlayerResumeSeriesInput[]
  processedThroughUtcDate: string
  contextInputs?: readonly CausalInputRow[]
}) {
  return buildCausalPrefixSummary({
    surface: 'player-resume-ledger',
    processedThroughUtcDate,
    inputs: playerResumeCausalInputs(prefixSeries, contextInputs),
  })
}

export function reconcileDssPlayerResumeCausality({
  summary,
  freshSeries,
  contextInputs = [],
  availableProcessedThroughUtcDates = [],
}: {
  summary: CausalPrefixSummary
  freshSeries: readonly DssPlayerResumeSeriesInput[]
  contextInputs?: readonly CausalInputRow[]
  availableProcessedThroughUtcDates?: readonly string[]
}) {
  if (summary.surface !== 'player-resume-ledger') {
    throw new Error('Expected player-resume-ledger causal summary')
  }
  return reconcileCausalPrefix({
    summary,
    freshInputs: playerResumeCausalInputs(freshSeries, contextInputs),
    availableProcessedThroughUtcDates,
  })
}

export function recomputeDssPlayerResumeCausalState(
  series: DssPlayerResumeSeriesInput[],
  options: BuildDssPlayerResumeLedgerOptions = {},
) {
  return buildDssPlayerResumeLedgers(series, options)
}

export function playerResumeCreditEntries(series: DssPlayerResumeSeriesInput[]): DssPlayerResumeCreditEntry[] {
  return series.flatMap((entry) => {
    const international = entry.international ?? isInternationalTier(entry.tier)
    return entry.players.map((player) => {
      const resumeCredit = entry.weightedSeriesValue * player.share
      return {
        playerId: player.id,
        role: player.role,
        team: entry.team,
        seriesKey: entry.seriesKey,
        date: entry.date,
        season: entry.season,
        ...(entry.splitId === undefined ? {} : { splitId: entry.splitId }),
        event: entry.event,
        tier: entry.tier,
        weightedSeriesValue: entry.weightedSeriesValue,
        contributionShare: player.share,
        resumeCredit,
        international,
      }
    })
  })
}

function playerResumeLedgerFor(
  playerId: string,
  entries: DssPlayerResumeCreditEntry[],
  {
    currentSeason,
    currentSplitId,
    uncertaintyFor,
  }: Required<Pick<BuildDssPlayerResumeLedgerOptions, 'uncertaintyFor'>> & Pick<BuildDssPlayerResumeLedgerOptions, 'currentSeason' | 'currentSplitId'>,
): DeservedStandingPlayerResumeLedger {
  const currentSeasonEntries = currentSeason === undefined
    ? []
    : entries.filter((entry) => entry.season === currentSeason)
  const currentSplitEntries = currentSplitId === undefined
    ? currentSeasonEntries.filter((entry) => entry.splitId === undefined)
    : currentSeasonEntries.filter((entry) => entry.splitId === currentSplitId)

  return {
    playerId,
    careerResumeCredit: sumResume(entries),
    currentSeasonResumeCredit: sumResume(currentSeasonEntries),
    currentSplitResumeCredit: sumResume(currentSplitEntries),
    internationalResumeCredit: sumResume(entries.filter((entry) => entry.international)),
    roleResumeCredit: roleResumeCredit(entries),
    uncertainty: uncertaintyFor(playerId, entries),
  }
}

function latestSeason(entries: DssPlayerResumeCreditEntry[]) {
  const seasons = entries.map((entry) => entry.season).filter((season) => Number.isFinite(season))
  if (seasons.length === 0) return undefined
  return Math.max(...seasons)
}

function latestSplitId(entries: DssPlayerResumeCreditEntry[], currentSeason: number | undefined) {
  if (currentSeason === undefined) return undefined
  const latestEntry = entries
    .filter((entry) => entry.season === currentSeason && entry.splitId)
    .sort((left, right) => right.date.localeCompare(left.date))[0]
  return latestEntry?.splitId
}

function roleResumeCredit(entries: DssPlayerResumeCreditEntry[]) {
  const credits: Partial<Record<Role, number>> = {}
  for (const entry of entries) {
    credits[entry.role] = (credits[entry.role] ?? 0) + entry.resumeCredit
  }
  return credits
}

function sumResume(entries: DssPlayerResumeCreditEntry[]) {
  return entries.reduce((sum, entry) => sum + entry.resumeCredit, 0)
}

function isInternationalTier(tier: EventTier) {
  return tier === 'worlds-playoffs'
    || tier === 'worlds-main'
    || tier === 'msi-bracket'
    || tier === 'msi-play-in'
    || tier === 'minor-international'
}

function groupBy<T, K extends string>(items: T[], keyFor: (item: T) => K) {
  const groups = new Map<K, T[]>()
  for (const item of items) {
    const key = keyFor(item)
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }
  return groups
}

function defaultUncertaintyFor() {
  return 0
}
