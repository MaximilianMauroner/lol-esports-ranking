import type { PublicRollingWindow, PublicTournamentMovementIndexEntry, PublicTournamentMovementShard, PublicTournamentMovementTeam } from '../../types'
import type { RankingSummaryStanding } from '../../types'
import { compareCodeUnits } from '../../../../shared/codeUnitOrder.mjs'
import { compareRecord, teamKey } from '../../../../shared/display'
import { displayRegionPowerScore, type RegionStrength } from '../projections/regionStrength'
import {
  deriveRankingFlair,
  deriveTierLabels,
  deriveTournamentMovementPicks,
  type RankingMovementPick,
  type RankingTierLabel,
  type RankingUpsetHeadline,
} from './rankingFlair'
import {
  effectiveTournamentStatus,
  projectTournamentStandings,
  teamMatchesTournamentFilter,
  tournamentFilterOptionsForStandings,
  tournamentIdFromFilter,
  type TournamentFilterOption,
  type TournamentFilterValue,
  type TournamentInstanceId,
  type TournamentLifecycleStatus,
} from '../evidence/internationalTournaments'

export const SORT_KEYS = ['rank', 'rating', 'wins'] as const
export const SORT_DIRECTIONS = ['ascending', 'descending'] as const
export const ELIGIBILITY_FILTERS = ['ranked', 'all'] as const
export const TIER_FILTERS = ['All', 'S', 'A', 'B', 'C'] as const

export type SortKey = typeof SORT_KEYS[number]
export type SortDirection = typeof SORT_DIRECTIONS[number]
export type EligibilityFilter = typeof ELIGIBILITY_FILTERS[number]
export type TierFilter = typeof TIER_FILTERS[number]

export type RankingEvidence = {
  standings: readonly RankingSummaryStanding[]
  regions: readonly RegionStrength[]
  requestedTournamentFilter: TournamentFilterValue
  tournamentEntries: readonly PublicTournamentMovementIndexEntry[]
  tournamentShard?: PublicTournamentMovementShard
  latestMatchDate?: string
  rollingWindow?: PublicRollingWindow
}

export type RankingUniverse = {
  standings: readonly RankingSummaryStanding[]
  rankedStandings: readonly RankingSummaryStanding[]
  tierFor: (team: RankingSummaryStanding) => RankingTierLabel | undefined
  regionOptions: readonly string[]
  tournamentOptions: readonly TournamentFilterOption[]
  tournamentFilter: TournamentFilterValue
  exactTournamentId?: TournamentInstanceId
  tournament?: PublicTournamentMovementShard
  movementByTeamId: ReadonlyMap<string, PublicTournamentMovementTeam>
  rollingWindow?: PublicRollingWindow
}

export type RankingBoardSelection = {
  region: string
  tier: TierFilter
  eligibility: EligibilityFilter
  search: string
  sortKey: SortKey
  sortDirection: SortDirection
  pageSize: number
  requestedPage: number
}

export type BoardMovement =
  | {
      kind: 'tournament'
      status: TournamentLifecycleStatus
      riser?: PublicTournamentMovementTeam
      faller?: PublicTournamentMovementTeam
    }
  | {
      kind: 'scope'
      riser: RankingMovementPick | null
      faller: RankingMovementPick | null
      upset: RankingUpsetHeadline | null
    }

export type RankingBoard = {
  rows: readonly RankingSummaryStanding[]
  visibleRows: readonly RankingSummaryStanding[]
  rankedRows: readonly RankingSummaryStanding[]
  page: { current: number; count: number; start: number; end: number }
  tierCounts: readonly { tier: RankingTierLabel; count: number }[]
  scopeScoreRanks: ReadonlyMap<string, number>
  activeFilterCount: number
  unrankedOnTournamentBoard: number
  showsWholeTournamentField: boolean
  movement: BoardMovement
  disclosure: {
    regionFilter: string
    tournamentFilter: TournamentFilterValue
    tableTeamCount: number
    scopeTeamCount: number
    hiddenFromRankedCount: number
  }
}

export function deriveRankingUniverse(evidence: RankingEvidence): RankingUniverse {
  const { standings: scopeStandings, latestMatchDate } = evidence
  const tournamentOptions = tournamentFilterOptionsForStandings(scopeStandings, evidence.tournamentEntries, latestMatchDate)
  const tournamentFilter = tournamentOptions.some((option) => option.value === evidence.requestedTournamentFilter) ? evidence.requestedTournamentFilter : 'All'
  const exactTournamentId = tournamentIdFromFilter(tournamentFilter)
  const shard = evidence.tournamentShard
  const tournament = shard && shard.id === exactTournamentId
    ? { ...shard, status: effectiveTournamentStatus(shard, latestMatchDate) }
    : undefined
  const standings = tournament ? projectTournamentStandings(scopeStandings, tournament) : scopeStandings
  const ranked = standings.filter((team) => team.eligibility?.eligible)
  const tierByTeam = new Map(deriveTierLabels(ranked).map((assignment) => [assignment.team.toLocaleLowerCase('en'), assignment.tier]))
  const powerByRegion = new Map(evidence.regions.map((entry) => [entry.region, displayRegionPowerScore(entry)]))
  const presentRegions = Array.from(new Set(scopeStandings.map((team) => team.region).filter(Boolean)))
  return {
    standings,
    rankedStandings: ranked.toSorted(compareTeamRank),
    tierFor: (team) => tierByTeam.get(team.team.toLocaleLowerCase('en')),
    regionOptions: ['All', ...presentRegions.sort((left, right) => (powerByRegion.get(right) ?? -Infinity) - (powerByRegion.get(left) ?? -Infinity) || compareCodeUnits(left, right))],
    tournamentOptions,
    tournamentFilter,
    exactTournamentId,
    tournament,
    movementByTeamId: new Map((tournament?.teams ?? []).map((team) => [team.teamId, team])),
    rollingWindow: evidence.rollingWindow,
  }
}

export function deriveRankingBoard(universe: RankingUniverse, selection: RankingBoardSelection): RankingBoard {
  const { tournament, tournamentFilter, exactTournamentId, tierFor } = universe
  const query = selection.search.trim().toLowerCase()
  const participantIds = tournament ? new Set(tournament.teams.map((team) => team.teamId)) : undefined
  const scopeRows = universe.standings.filter((team) => {
    if (selection.region !== 'All' && team.region !== selection.region) return false
    if (!teamMatchesTournamentFilter(team, tournamentFilter, participantIds)) return false
    if (!query) return true
    return [team.team, team.code, team.region, team.league].some((value) => value?.toLowerCase().includes(query))
  })
  const eligibleRows = scopeRows.filter((team) => team.eligibility?.eligible)
  const eligibilityFilterApplies = !exactTournamentId
  const byEligibility = selection.eligibility === 'ranked' && eligibilityFilterApplies ? eligibleRows : scopeRows
  const filtered = selection.tier === 'All' ? byEligibility : byEligibility.filter((team) => tierFor(team) === selection.tier)

  const rows = sortRows(filtered, selection.sortKey, selection.sortDirection)
  const pageCount = Math.max(1, Math.ceil(rows.length / selection.pageSize))
  const current = Math.min(selection.requestedPage, pageCount)
  const start = (current - 1) * selection.pageSize
  const visibleRows = rows.slice(start, start + selection.pageSize)

  return {
    rows,
    visibleRows,
    rankedRows: filtered.filter((team) => team.eligibility?.eligible).toSorted(compareTeamRank),
    page: { current, count: pageCount, start, end: rows.length === 0 ? 0 : start + visibleRows.length },
    tierCounts: (['S', 'A', 'B', 'C'] as const).map((tier) => ({ tier, count: eligibleRows.filter((team) => tierFor(team) === tier).length })),
    scopeScoreRanks: scoreRanks(scopeRows),
    activeFilterCount: [
      selection.search.trim() !== '',
      selection.region !== 'All',
      selection.tier !== 'All',
      tournamentFilter !== 'All',
      selection.eligibility !== 'ranked' && eligibilityFilterApplies,
    ].filter(Boolean).length,
    unrankedOnTournamentBoard: exactTournamentId ? filtered.filter((team) => !team.eligibility?.eligible).length : 0,
    showsWholeTournamentField: selection.search.trim() === '' && selection.region === 'All' && selection.tier === 'All',
    movement: boardMovement(universe, filtered),
    disclosure: {
      regionFilter: selection.region,
      tournamentFilter,
      tableTeamCount: filtered.length,
      scopeTeamCount: universe.standings.length,
      hiddenFromRankedCount: scopeRows.length - eligibleRows.length,
    },
  }
}

function boardMovement(universe: RankingUniverse, filtered: readonly RankingSummaryStanding[]): BoardMovement {
  const { tournament } = universe
  if (tournament) {
    const shown = new Set(filtered.map((team) => team.teamId))
    const { biggestRiser, biggestFaller } = deriveTournamentMovementPicks(tournament.teams.filter((team) => shown.has(team.teamId)))
    return { kind: 'tournament', status: tournament.status, riser: biggestRiser, faller: biggestFaller }
  }
  const flair = deriveRankingFlair(filtered, { tierUniverse: universe.rankedStandings, rollingWindow: universe.rollingWindow })
  return { kind: 'scope', riser: flair.movement.biggestRiser, faller: flair.movement.biggestFaller, upset: flair.upsetHeadline }
}

function sortRows(rows: readonly RankingSummaryStanding[], key: SortKey, direction: SortDirection) {
  const factor = direction === 'ascending' ? 1 : -1
  switch (key) {
    case 'rating':
      return rows.toSorted((a, b) => compareEligibility(a, b) || factor * compareScore(a, b) || compareTeamRank(a, b))
    case 'wins':
      return rows.toSorted((a, b) => compareEligibility(a, b) || factor * compareRecord(a, b) || compareTeamRank(a, b))
    default:
      return rows.toSorted((a, b) => compareEligibility(a, b) || factor * compareTeamRank(a, b))
  }
}

function scoreRanks(rows: readonly RankingSummaryStanding[]) {
  const ranks = new Map<string, number>()
  let currentRank = 0
  let previousScore: number | undefined
  rows.toSorted((a, b) => compareScore(b, a) || compareTeamRank(a, b) || compareCodeUnits(a.team, b.team)).forEach((team, index) => {
    const score = team.rating
    if (typeof score !== 'number' || !Number.isFinite(score)) return
    const roundedScore = Math.round(score)
    if (previousScore !== roundedScore) {
      currentRank = index + 1
      previousScore = roundedScore
    }
    ranks.set(teamKey(team), currentRank)
  })
  return ranks
}

function compareEligibility(a: RankingSummaryStanding, b: RankingSummaryStanding) {
  return Number(b.eligibility?.eligible ?? true) - Number(a.eligibility?.eligible ?? true)
}

function compareTeamRank(a: RankingSummaryStanding, b: RankingSummaryStanding) {
  return (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER)
}

function compareScore(a: RankingSummaryStanding, b: RankingSummaryStanding) {
  return (a.rating ?? Number.NEGATIVE_INFINITY) - (b.rating ?? Number.NEGATIVE_INFINITY)
}
