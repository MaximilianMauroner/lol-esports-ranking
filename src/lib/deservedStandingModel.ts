import type { DeservedStandingTeamComponents, MatchRecord } from '../types'
import {
  deservedStandingModelParameters,
  dssCurrentRosterValidity,
  dssSeriesLedgerEntriesForMatches,
  dssTeamComponentsFromSeries,
  dssWeightedSeriesFromLedgerEntry,
  type DssSeriesLedgerEntry,
  type DssSeriesLedgerOptions,
} from './deservedStanding'

export type DeservedStandingModelOptions = DssSeriesLedgerOptions & {
  baseScoreFor?: (team: string, entries: DssSeriesLedgerEntry[]) => number | undefined
  rosterValidityFor?: (entry: DssSeriesLedgerEntry) => number
  standardOpponentReferenceStrengthFor?: (entry: DssSeriesLedgerEntry) => number
  stagePointsFor?: (team: string, entries: DssSeriesLedgerEntry[]) => number
  incomingPlayerBridgeCreditFor?: (team: string, entries: DssSeriesLedgerEntry[]) => number
  uncertaintyFor?: (team: string, entries: DssSeriesLedgerEntry[]) => number | undefined
}

export type DeservedStandingTeamSummary = {
  team: string
  rank: number
  dss: number
  conservativeDss?: number
  wins: number
  losses: number
  expectedWins: number
  winsAboveExpectation: number
  gameDifferentialAboveExpectation: number
  currentRosterValidity: number
  seriesCount: number
  components: DeservedStandingTeamComponents
  ledgerEntries: DssSeriesLedgerEntry[]
}

export type DeservedStandingModel = {
  teams: DeservedStandingTeamSummary[]
  ledgerEntries: DssSeriesLedgerEntry[]
}

export function buildDeservedStandingModel(
  matches: MatchRecord[],
  options: DeservedStandingModelOptions = {},
): DeservedStandingModel {
  const ledgerEntries = dssSeriesLedgerEntriesForMatches(matches, {
    referenceStrengthFor: options.referenceStrengthFor ?? defaultReferenceStrength,
    contextAdjustmentFor: options.contextAdjustmentFor,
  })
  const entriesByTeam = groupBy(ledgerEntries, (entry) => entry.team)
  const teams = Array.from(entriesByTeam.entries())
    .map(([team, entries]) => teamSummaryFor(team, entries, options))
    .sort((left, right) => right.dss - left.dss || right.winsAboveExpectation - left.winsAboveExpectation || left.team.localeCompare(right.team))
    .map((team, index) => ({ ...team, rank: index + 1 }))

  return {
    teams,
    ledgerEntries,
  }
}

function teamSummaryFor(
  team: string,
  entries: DssSeriesLedgerEntry[],
  options: DeservedStandingModelOptions,
): DeservedStandingTeamSummary {
  const weightedSeries = entries.map((entry) => dssWeightedSeriesFromLedgerEntry(entry, {
    rosterValidity: options.rosterValidityFor?.(entry) ?? 1,
    standardOpponentReferenceStrength: options.standardOpponentReferenceStrengthFor?.(entry)
      ?? deservedStandingModelParameters.baseScore,
  }))
  const uncertainty = options.uncertaintyFor?.(team, entries)
  const components = dssTeamComponentsFromSeries({
    series: weightedSeries,
    stagePoints: options.stagePointsFor?.(team, entries) ?? 0,
    incomingPlayerBridgeCredit: options.incomingPlayerBridgeCreditFor?.(team, entries) ?? 0,
    uncertainty,
    baseScore: options.baseScoreFor?.(team, entries),
  })
  const wins = entries.filter((entry) => entry.observedSeriesResult > 0.5).length
  const losses = entries.filter((entry) => entry.observedSeriesResult < 0.5).length
  const expectedWins = entries.reduce((sum, entry) => sum + entry.expectedSeriesResult, 0)
  const gameDifferentialAboveExpectation = entries.reduce((sum, entry) => {
    return sum + entry.observedGameWinRate - entry.expectedGameWinRate
  }, 0)

  return {
    team,
    rank: 0,
    dss: components.dss,
    ...(components.conservativeDss === undefined ? {} : { conservativeDss: components.conservativeDss }),
    wins,
    losses,
    expectedWins,
    winsAboveExpectation: wins - expectedWins,
    gameDifferentialAboveExpectation,
    currentRosterValidity: dssCurrentRosterValidity(weightedSeries),
    seriesCount: entries.length,
    components,
    ledgerEntries: entries,
  }
}

function defaultReferenceStrength() {
  return deservedStandingModelParameters.baseScore
}

function groupBy<T>(items: T[], keyFor: (item: T) => string) {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = keyFor(item)
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }
  return groups
}
