import {
  isCompetitionOnlyLeague,
  isKnownDomesticHomeLeague,
  leagueProfileScore,
  regionForLeague,
} from '../data/competitionTaxonomy'
import { canonicalTeamNameFor, teamCodeFor, teamIdentityFor } from '../data/teamIdentity'
import type { MatchRecord, Region, TeamProfile } from '../types'

export { isCompetitionOnlyLeague, isUnknownLeague } from '../data/competitionTaxonomy'

type LeagueObservation = {
  league: string
  region: Region
  count: number
  lastObserved: string
}

export function mergeTeamProfiles(profileSources: Record<string, TeamProfile>[]) {
  const merged: Record<string, TeamProfile> = {}
  for (const source of profileSources) {
    for (const [rawTeamName, profile] of Object.entries(source)) {
      const teamName = canonicalTeamNameFor(rawTeamName)
      const identity = teamIdentityFor(teamName)
      if (identity && !isUsefulProfile(profile)) {
        merged[teamName] = identity
        continue
      }
      merged[teamName] = preferProfile(merged[teamName], { ...profile, name: teamName, code: identity?.code ?? profile.code })
    }
  }
  return merged
}

export function deriveTeamProfilesFromMatches(
  matches: MatchRecord[],
  fallbackProfiles: Record<string, TeamProfile> = {},
) {
  const teamNames = new Set(Object.keys(fallbackProfiles).map(canonicalTeamNameFor))
  const observations = new Map<string, Map<string, LeagueObservation>>()

  for (const match of matches) {
    observeTeam(match.teamA, match.teamAHomeLeague, match.teamARegion, match.date, observations, teamNames)
    observeTeam(match.teamB, match.teamBHomeLeague, match.teamBRegion, match.date, observations, teamNames)
  }

  const profiles: Record<string, TeamProfile> = {}
  for (const teamName of teamNames) {
    const observed = bestObservedLeague(observations.get(teamName))
    if (observed) {
      profiles[teamName] = {
        name: teamName,
        code: teamIdentityFor(teamName)?.code ?? fallbackProfiles[teamName]?.code ?? teamCodeFor(teamName),
        region: observed.region,
        league: observed.league,
      }
      continue
    }

    const identity = teamIdentityFor(teamName)
    if (identity) {
      profiles[teamName] = identity
      continue
    }

    profiles[teamName] = preferProfile(undefined, fallbackProfiles[teamName] ?? {
      name: teamName,
      code: teamCodeFor(teamName),
      region: 'International',
      league: 'Unknown',
    })
  }

  return profiles
}

function observeTeam(
  rawTeamName: string,
  homeLeague: string | undefined,
  homeRegion: Region | undefined,
  observedAt: string,
  observations: Map<string, Map<string, LeagueObservation>>,
  teamNames: Set<string>,
) {
  const teamName = canonicalTeamNameFor(rawTeamName)
  teamNames.add(teamName)
  if (!isKnownDomesticHomeLeague(homeLeague)) return

  const byLeague = observations.get(teamName) ?? new Map<string, LeagueObservation>()
  observations.set(teamName, byLeague)
  const current = byLeague.get(homeLeague) ?? {
    league: homeLeague,
    region: homeRegion ?? regionForLeague(homeLeague),
    count: 0,
    lastObserved: '',
  }
  byLeague.set(homeLeague, {
    ...current,
    region: homeRegion ?? current.region,
    count: current.count + 1,
    lastObserved: observedAt > current.lastObserved ? observedAt : current.lastObserved,
  })
}

function bestObservedLeague(observations: Map<string, LeagueObservation> | undefined) {
  if (!observations || observations.size === 0) return undefined
  return Array.from(observations.values()).sort(compareLeagueObservation)[0]
}

function compareLeagueObservation(left: LeagueObservation, right: LeagueObservation) {
  return right.lastObserved.localeCompare(left.lastObserved)
    || right.count - left.count
    || leagueProfileScore(right.league) - leagueProfileScore(left.league)
}

function preferProfile(current: TeamProfile | undefined, candidate: TeamProfile) {
  if (!current) return candidate
  return profileScore(candidate) > profileScore(current) ? candidate : current
}

function isUsefulProfile(profile: TeamProfile) {
  return profile.league !== 'Unknown' && profile.region !== 'International' && !isCompetitionOnlyLeague(profile.league)
}

function profileScore(profile: TeamProfile) {
  if (profile.league === 'Unknown' || profile.region === 'International' || isCompetitionOnlyLeague(profile.league)) return 0
  return leagueProfileScore(profile.league)
}
