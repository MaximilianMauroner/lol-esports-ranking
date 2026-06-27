import { effectiveLeagueRating, leagueConnectivity, leagueTierFor } from '../data/leagueTiers'
import type { EventSummary, LeagueStrength, MatchRecord, Region, SeasonSummary, TeamHistoryPoint, TeamProfile, TeamStanding } from '../types'

export function buildLeagueStrengths(
  teams: Record<string, TeamProfile>,
  leagueScores: Map<string, number>,
  previousLeagueScores: Map<string, number>,
  leagueWins: Map<string, number>,
  leagueLosses: Map<string, number>,
  leagueExpectedWins: Map<string, number>,
  leagueOpponentRatingSums: Map<string, number>,
  leagueForms: Map<string, string[]>,
  leagueMatchCounts: Map<string, number>,
  leagueLastEvents: Map<string, string>,
  leagueLastUpdated: Map<string, string>,
  {
    initialLeagueRating,
    leagueEloWeight,
  }: {
    initialLeagueRating: number
    leagueEloWeight: number
  },
): LeagueStrength[] {
  const regionsByLeague = new Map<string, Region>()
  for (const team of Object.values(teams)) {
    regionsByLeague.set(team.league, team.region)
  }

  return Array.from(regionsByLeague.entries())
    .map(([league, region]) => {
      const tier = leagueTierFor(league)
      const internationalMatches = leagueMatchCounts.get(league) ?? 0
      const rawScore = leagueScores.get(league) ?? tier.priorRating
      const previousRawScore = previousLeagueScores.get(league) ?? tier.priorRating
      const score = effectiveLeagueRating(league, rawScore, internationalMatches)
      const previousScore = effectiveLeagueRating(league, previousRawScore, internationalMatches)
      const wins = leagueWins.get(league) ?? 0
      const losses = leagueLosses.get(league) ?? 0
      const expectedWins = leagueExpectedWins.get(league) ?? 0
      const winsOverExpected = wins - expectedWins
      const averageOpponentRating = internationalMatches > 0
        ? (leagueOpponentRatingSums.get(league) ?? 0) / internationalMatches
        : undefined
      const opponentAdjustedWinRate = internationalMatches > 0
        ? clamp((winsOverExpected + internationalMatches * 0.5) / internationalMatches, 0, 1)
        : undefined

      return {
        league,
        region,
        tier: tier.tier,
        priorScore: tier.priorRating,
        rawScore: Math.round(rawScore),
        connectivity: Number(leagueConnectivity(internationalMatches).toFixed(3)),
        score: Number(score.toFixed(1)),
        adjustment: Math.round((score - initialLeagueRating) * leagueEloWeight),
        delta: Number((score - previousScore).toFixed(1)),
        wins,
        losses,
        expectedWins: internationalMatches > 0 ? Number(expectedWins.toFixed(2)) : undefined,
        winsOverExpected: internationalMatches > 0 ? Number(winsOverExpected.toFixed(2)) : undefined,
        opponentAdjustedWinRate: opponentAdjustedWinRate === undefined ? undefined : Number(opponentAdjustedWinRate.toFixed(3)),
        averageOpponentRating: averageOpponentRating === undefined ? undefined : Number(averageOpponentRating.toFixed(1)),
        internationalMatches,
        form: leagueForms.get(league) ?? [],
        lastEvent: leagueLastEvents.get(league),
        lastUpdated: leagueLastUpdated.get(league),
      }
    })
    .sort((a, b) => b.score - a.score)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function buildEventSummaries(matches: MatchRecord[], histories: Map<string, TeamHistoryPoint[]>): EventSummary[] {
  const events = new Map<string, MatchRecord[]>()
  for (const match of matches) {
    events.set(match.event, [...(events.get(match.event) ?? []), match])
  }

  return Array.from(events.entries())
    .map(([event, eventMatches]) => {
      const impact = eventMatches.reduce((sum, match) => {
        const teamHistory = histories.get(match.winner) ?? []
        const point = teamHistory.find((entry) => entry.date === match.date && entry.event === match.event)
        return sum + Math.abs(point?.delta ?? 0)
      }, 0)
      const participation = new Map<string, number>()
      for (const match of eventMatches) {
        participation.set(match.teamA, (participation.get(match.teamA) ?? 0) + 1)
        participation.set(match.teamB, (participation.get(match.teamB) ?? 0) + 1)
      }
      const topTeams = Array.from(participation.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([team]) => team)

      return {
        event,
        season: eventMatches[0]?.season ?? 0,
        tier: eventMatches[0]?.tier ?? 'regional-regular',
        region: eventMatches[0]?.region ?? 'International',
        matches: eventMatches.length,
        ratingImpact: Math.round(impact),
        topTeams,
        startDate: eventMatches[0]?.date ?? '',
        endDate: eventMatches.at(-1)?.date ?? '',
        sourceBreakdown: eventSourceBreakdown(eventMatches),
      }
    })
    .sort((a, b) => b.startDate.localeCompare(a.startDate))
}

export function buildSeasonSummaries(matches: MatchRecord[], standings: TeamStanding[]): SeasonSummary[] {
  const seasons = new Map<number, MatchRecord[]>()
  for (const match of matches) {
    seasons.set(match.season, [...(seasons.get(match.season) ?? []), match])
  }

  return Array.from(seasons.entries())
    .map(([season, seasonMatches]) => {
      const eventCount = new Set(seasonMatches.map((match) => match.event)).size
      const seasonTeams = new Set(seasonMatches.flatMap((match) => [match.teamA, match.teamB]))
      const rankedSeasonTeams = standings.filter((standing) => seasonTeams.has(standing.team))
      const mostImproved = maxBy(rankedSeasonTeams, (standing) => standing.delta)?.team ?? 'Unknown'

      return {
        season,
        matches: seasonMatches.length,
        events: eventCount,
        topTeam: rankedSeasonTeams[0]?.team ?? 'Unknown',
        mostImproved,
        startDate: seasonMatches[0]?.date ?? '',
        endDate: seasonMatches.at(-1)?.date ?? '',
      }
    })
    .sort((a, b) => b.season - a.season)
}

function eventSourceBreakdown(matches: MatchRecord[]) {
  const byProvider = new Map<string, number>()
  for (const match of matches) {
    const provider = match.sourceProvider ?? 'unknown'
    byProvider.set(provider, (byProvider.get(provider) ?? 0) + 1)
  }
  return Array.from(byProvider.entries())
    .map(([provider, matchCount]) => ({ provider, matchCount }))
    .sort((left, right) => left.provider.localeCompare(right.provider))
}

function maxBy<T>(items: T[], score: (item: T) => number) {
  let best: T | undefined
  let bestScore = Number.NEGATIVE_INFINITY
  for (const item of items) {
    const itemScore = score(item)
    if (itemScore > bestScore) {
      best = item
      bestScore = itemScore
    }
  }
  return best
}
