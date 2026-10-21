import { compareCodeUnits } from '../../../../shared/codeUnitOrder.mjs'
import type { Region } from '../../types.ts'
import { currentTopTierRegionForLeague, isMajorRegionPowerRegion, majorRegionPowerRegions } from '../evidence/competitionTaxonomy.ts'
import type { InternationalTournamentFamilyId } from '../evidence/internationalTournaments.ts'
import type { PublicTeamDirectory, PublicTournamentMovementShard } from './publishedTypes.ts'

const TIER_ONE_FAMILIES = ['worlds', 'msi', 'ewc'] as const satisfies readonly InternationalTournamentFamilyId[]

/** Worlds, MSI and EWC. First Stand does not count. */
export type TierOneInternationalFamily = (typeof TIER_ONE_FAMILIES)[number]

export type RegionInternationalYear = {
  season: number
  /** Series against teams from other regions only. */
  wins: number
  losses: number
  ties: number
  /** (wins + ties / 2) / series. null when the region played no series against other regions that year. */
  winRate: number | null
}

export type RegionInternationalTimeline = {
  /** `absent` lists the tier-1 events of the season that the published data does not have. */
  seasons: { season: number; events: TierOneInternationalFamily[]; absent: TierOneInternationalFamily[]; inProgress: boolean }[]
  regions: { region: Region; years: RegionInternationalYear[] }[]
  unresolvedSeries: number
}

export function isTierOneInternationalFamily(family: InternationalTournamentFamilyId): family is TierOneInternationalFamily {
  return (TIER_ONE_FAMILIES as readonly string[]).includes(family)
}

/**
 * Series records between regions at Worlds, MSI and EWC, one row per season.
 * Each side counts its own series, so a series between two regions counts once
 * for each. A series inside one region says nothing about regional strength.
 */
export function regionInternationalTimeline({
  generatedAt,
  directory,
  events,
}: {
  generatedAt: string
  directory: PublicTeamDirectory
  events: { family: TierOneInternationalFamily; season: number; shard: PublicTournamentMovementShard }[]
}): RegionInternationalTimeline {
  const regionByTeamId = new Map(directory.teams.flatMap((team) => {
    const region = currentTopTierRegionForLeague(team.league, team.region)
    return isMajorRegionPowerRegion(region) ? [[team.teamId, region] as const] : []
  }))
  const records = new Map<string, { wins: number; losses: number; ties: number }>()
  const unresolved = new Set<string>()

  for (const { season, shard } of events) {
    const teamIdByName = new Map(shard.teams.map((team) => [team.team, team.teamId]))
    for (const team of shard.teams) {
      const region = regionByTeamId.get(team.teamId)
      team.points.forEach(([, , , context], index) => {
        if (!context?.result) return
        const opponentId = context.opponent === undefined ? undefined : teamIdByName.get(context.opponent)
        const opponentRegion = opponentId === undefined ? undefined : regionByTeamId.get(opponentId)
        if (!region || !opponentRegion) {
          unresolved.add(`${shard.id}|${context.seriesId ?? `${team.teamId}|${index}`}`)
          return
        }
        if (opponentRegion === region) return
        const key = `${season}|${region}`
        const record = records.get(key) ?? { wins: 0, losses: 0, ties: 0 }
        if (context.result === 'W') record.wins += 1
        else if (context.result === 'L') record.losses += 1
        else record.ties += 1
        records.set(key, record)
      })
    }
  }

  const seasons = [...new Set(events.map((event) => event.season))].sort((left, right) => left - right)
  const inProgressSeason = Number(generatedAt.slice(0, 4))
  return {
    seasons: seasons.map((season) => {
      const families = events
        .filter((event) => event.season === season)
        .toSorted((left, right) => compareCodeUnits(left.shard.startDate, right.shard.startDate))
        .map((event) => event.family)
      return {
        season,
        events: families,
        absent: TIER_ONE_FAMILIES.filter((family) => !families.includes(family)),
        inProgress: season === inProgressSeason,
      }
    }),
    regions: majorRegionPowerRegions.map((region) => ({
      region,
      years: seasons.map((season) => {
        const { wins, losses, ties } = records.get(`${season}|${region}`) ?? { wins: 0, losses: 0, ties: 0 }
        const series = wins + losses + ties
        return { season, wins, losses, ties, winRate: series > 0 ? (wins + ties / 2) / series : null }
      }),
    })),
    unresolvedSeries: unresolved.size,
  }
}

/** The published rule for which matches enter the rating run, as the manifest states it. */
export function publishedRatedMatchRule(parameters: unknown) {
  const universe = isRecord(parameters) ? parameters.ratingUniverse : undefined
  return isRecord(universe) && typeof universe.sideRule === 'string' ? universe.sideRule : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
