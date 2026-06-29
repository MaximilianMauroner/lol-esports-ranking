import type { LeagueStrength, LeagueTierName, Region, TeamEligibility } from '../types'
import type { PublicTeamStanding } from './publicArtifacts/schema'
import { currentTopTierRegionForLeague, isMajorRegionPowerRegion } from '../data/regionTaxonomy'

export type RegionStrength = {
  region: Region | string
  rank: number
  /** Composite power score for the region's flagship competitive league layer. */
  score: number
  /** Rating of the single strongest team in the region. */
  topTeamRating: number
  /** Teams in the flagship league layer used for the region score. */
  teamCount: number
  /** All teams currently mapped into this broad region ecosystem. */
  ecosystemTeamCount: number
  /** Leagues in the flagship league layer used for the region score. */
  leagueCount: number
  /** All leagues currently mapped into this broad region ecosystem. */
  ecosystemLeagueCount: number
  /** League names used for the region score and its representative-team analysis. */
  flagshipLeagues: string[]
  /** Mean league connectivity (0-1): how well the region's results tie into the global graph. */
  connectivity: number
  internationalWins: number
  internationalLosses: number
  internationalWinRate?: number
  expectedWins?: number
  winsOverExpected?: number
  opponentAdjustedWinRate?: number
  averageOpponentRating?: number
  flagshipLeague?: string
  tier?: LeagueTierName
  topTeams: RegionTopTeam[]
}

export type RegionTopTeam = {
  team: string
  code?: string
  rating: number
  rank?: number
}

type RegionStanding = Pick<PublicTeamStanding, 'team' | 'code' | 'region' | 'league' | 'rating' | 'rank'> & {
  eligibility?: TeamEligibility
}

export type RegionPowerTeamInput = Pick<PublicTeamStanding, 'team' | 'code' | 'region' | 'league'>

const TIER_RANK: Record<LeagueTierName, number> = {
  'tier-one': 0,
  'tier-two': 1,
  'tier-three': 2,
  emerging: 3,
  unknown: 4,
}

/**
 * Aggregates per-region competitive strength from a snapshot's flagship league
 * layer. Lower-tier ecosystems remain visible through ecosystem counts, but do
 * not dilute a major region's power score.
 */
export function deriveRegionStrength(
  leagues: LeagueStrength[],
  standings: RegionStanding[],
  { includeInternational = false }: { includeInternational?: boolean } = {},
): RegionStrength[] {
  const leaguesByRegion = groupBy(leagues, (league) => regionPowerRegionFor(league.league, league.region, includeInternational))
  const teamsByRegion = groupBy(standings, (team) => regionPowerRegionFor(team.league, team.region, includeInternational))
  const regionNames = new Set<string>(leaguesByRegion.keys())

  const rows: RegionStrength[] = []
  for (const region of regionNames) {
    if (!includeInternational && region === 'International') continue
    const ecosystemLeagues = leaguesByRegion.get(region) ?? []
    const flagshipLeagues = flagshipLeaguesFor(ecosystemLeagues)
    const flagshipLeagueNames = new Set(flagshipLeagues.map((league) => league.league))
    const ecosystemTeams = teamsByRegion.get(region) ?? []
    const regionTeams = ecosystemTeams
      .filter((team) => teamBelongsToRegionPowerLeagues(region, flagshipLeagueNames, team))
      .slice()
      .sort((left, right) => ratingOf(right) - ratingOf(left))
    const rankedRegionTeams = regionTeams.filter((team) => team.eligibility?.eligible !== false)

    const internationalWins = sum(flagshipLeagues, (league) => league.wins)
    const internationalLosses = sum(flagshipLeagues, (league) => league.losses)
    const internationalMatches = internationalWins + internationalLosses
    const expectedWins = sum(flagshipLeagues, (league) => league.expectedWins)
    const winsOverExpected = internationalMatches > 0 ? internationalWins - expectedWins : undefined
    const averageOpponentRating = weightedMean(
      flagshipLeagues,
      (league) => league.averageOpponentRating,
      (league) => league.internationalMatches,
    )
    const opponentAdjustedWinRate = internationalMatches > 0 && winsOverExpected !== undefined
      ? clamp((winsOverExpected + internationalMatches * 0.5) / internationalMatches, 0, 1)
      : undefined

    const flagship = flagshipLeagues
      .slice()
      .sort(byFlagship)[0]

    rows.push({
      region,
      rank: 0,
      score: weightedLeagueScore(flagshipLeagues),
      topTeamRating: rankedRegionTeams.length > 0 ? ratingOf(rankedRegionTeams[0]) : 0,
      teamCount: regionTeams.length,
      ecosystemTeamCount: ecosystemTeams.length,
      leagueCount: flagshipLeagues.length,
      ecosystemLeagueCount: ecosystemLeagues.length,
      flagshipLeagues: [...flagshipLeagueNames],
      connectivity: mean(flagshipLeagues, (league) => league.connectivity),
      internationalWins,
      internationalLosses,
      internationalWinRate: internationalMatches > 0 ? internationalWins / internationalMatches : undefined,
      expectedWins: internationalMatches > 0 ? Number(expectedWins.toFixed(2)) : undefined,
      winsOverExpected: winsOverExpected === undefined ? undefined : Number(winsOverExpected.toFixed(2)),
      opponentAdjustedWinRate: opponentAdjustedWinRate === undefined ? undefined : Number(opponentAdjustedWinRate.toFixed(3)),
      averageOpponentRating: averageOpponentRating === undefined ? undefined : Number(averageOpponentRating.toFixed(1)),
      flagshipLeague: flagship?.league,
      tier: flagship?.tier,
      topTeams: rankedRegionTeams.map((team) => ({
        team: team.team,
        code: team.code,
        rating: ratingOf(team),
        rank: team.rank,
      })),
    })
  }

  return rows
    .sort((left, right) => right.score - left.score || (right.winsOverExpected ?? 0) - (left.winsOverExpected ?? 0) || right.topTeamRating - left.topTeamRating)
    .map((row, index) => ({ ...row, rank: index + 1 }))
}

export function regionPowerLeagueNames(region: Pick<RegionStrength, 'flagshipLeagues' | 'flagshipLeague'>): string[] {
  if ((region.flagshipLeagues ?? []).length > 0) return region.flagshipLeagues
  return region.flagshipLeague ? [region.flagshipLeague] : []
}

export function isRegionPowerTeam(region: Pick<RegionStrength, 'region' | 'flagshipLeagues' | 'flagshipLeague' | 'topTeams'>, team: RegionPowerTeamInput) {
  const leagueNames = new Set(regionPowerLeagueNames(region))
  const teamRegion = regionPowerRegionFor(team.league, team.region)
  if (teamRegion !== region.region) return false
  if (leagueNames.size > 0) return Boolean(team.league && leagueNames.has(team.league))

  return region.topTeams.some((topTeam) => topTeam.team === team.team || (topTeam.code && team.code === topTeam.code))
}

function teamBelongsToRegionPowerLeagues(region: string, flagshipLeagueNames: Set<string>, team: RegionStanding) {
  if (flagshipLeagueNames.size === 0) return false
  return regionPowerRegionFor(team.league, team.region) === region && Boolean(team.league && flagshipLeagueNames.has(team.league))
}

function regionPowerRegionFor(league: string | undefined, fallbackRegion: string | undefined, includeInternational = false) {
  const region = currentTopTierRegionForLeague(league, fallbackRegion)
  if (isMajorRegionPowerRegion(region)) return region
  if (includeInternational && region === 'International') return region
  return undefined
}

function flagshipLeaguesFor(leagues: LeagueStrength[]) {
  if (leagues.length === 0) return []
  const bestTierRank = Math.min(...leagues.map((league) => TIER_RANK[league.tier]))
  return leagues.filter((league) => TIER_RANK[league.tier] === bestTierRank)
}

function byFlagship(left: LeagueStrength, right: LeagueStrength) {
  const tierDelta = TIER_RANK[left.tier] - TIER_RANK[right.tier]
  if (tierDelta !== 0) return tierDelta
  return right.internationalMatches - left.internationalMatches || right.score - left.score
}

function weightedLeagueScore(leagues: LeagueStrength[]) {
  if (leagues.length === 0) return 0
  let weightedTotal = 0
  let weightTotal = 0
  for (const league of leagues) {
    const weight = Math.max(1, league.wins + league.losses)
    weightedTotal += league.score * weight
    weightTotal += weight
  }
  return weightTotal > 0 ? weightedTotal / weightTotal : mean(leagues, (league) => league.score)
}

function ratingOf(team: RegionStanding) {
  return typeof team.rating === 'number' && Number.isFinite(team.rating) ? team.rating : 0
}

function groupBy<T>(items: T[], key: (item: T) => string | undefined) {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const group = key(item)
    if (!group) continue
    const bucket = map.get(group)
    if (bucket) bucket.push(item)
    else map.set(group, [item])
  }
  return map
}

function sum<T>(items: T[], value: (item: T) => number | undefined) {
  return items.reduce((total, item) => total + (value(item) ?? 0), 0)
}

function mean<T>(items: T[], value: (item: T) => number | undefined) {
  const values = items.map(value).filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry))
  if (values.length === 0) return 0
  return values.reduce((total, entry) => total + entry, 0) / values.length
}

function weightedMean<T>(items: T[], value: (item: T) => number | undefined, weight: (item: T) => number | undefined) {
  let weightedTotal = 0
  let weightTotal = 0
  for (const item of items) {
    const itemValue = value(item)
    if (typeof itemValue !== 'number' || !Number.isFinite(itemValue)) continue
    const itemWeight = Math.max(0, weight(item) ?? 0)
    if (itemWeight === 0) continue
    weightedTotal += itemValue * itemWeight
    weightTotal += itemWeight
  }
  return weightTotal > 0 ? weightedTotal / weightTotal : undefined
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
