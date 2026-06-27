import { canonicalTeamNameFor, regionForLeague, teamCodeFor, teamIdentityFor } from '../data/teamIdentity'
import { leagueTierFor } from '../data/leagueTiers'
import type { MatchRecord, Region, TeamProfile } from '../types'

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
      if (identity) {
        merged[teamName] = identity
        continue
      }
      merged[teamName] = preferProfile(merged[teamName], { ...profile, name: teamName })
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
    const identity = teamIdentityFor(teamName)
    if (identity) {
      profiles[teamName] = identity
      continue
    }

    const observed = bestObservedLeague(observations.get(teamName))
    if (observed) {
      profiles[teamName] = {
        name: teamName,
        code: fallbackProfiles[teamName]?.code ?? teamCodeFor(teamName),
        region: observed.region,
        league: observed.league,
      }
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
  if (!homeLeague || isUnknownLeague(homeLeague) || isCompetitionOnlyLeague(homeLeague)) return

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

function profileScore(profile: TeamProfile) {
  if (profile.league === 'Unknown' || profile.region === 'International' || isCompetitionOnlyLeague(profile.league)) return 0
  return leagueProfileScore(profile.league)
}

function leagueProfileScore(league: string) {
  const tier = leagueTierFor(league).tier
  if (tier === 'tier-one') return 5
  if (tier === 'tier-two') return 4
  if (tier === 'tier-three') return 3
  if (tier === 'emerging') return 2
  return 1
}

function isCompetitionOnlyLeague(league: string) {
  const normalized = league.trim().toUpperCase()
  return normalized === 'MSI'
    || normalized === 'WORLDS'
    || normalized === 'WORLD'
    || normalized === 'WLD'
    || normalized === 'WLDS'
    || normalized === 'FST'
    || normalized === 'EWC'
    || normalized === 'ASI'
    || normalized === 'AC'
    || normalized === 'DCUP'
    || normalized === 'KESPA'
    || normalized === 'EM'
    || normalized === 'LTA'
    || normalized === 'EMEA MASTERS'
    || normalized.includes('WORLD CHAMPIONSHIP')
    || normalized.includes('MID-SEASON INVITATIONAL')
    || normalized.includes('FIRST STAND')
    || normalized.includes('ESPORTS WORLD CUP')
    || normalized.includes('ASIA MASTER')
    || normalized.includes('ASIA MASTERS')
}

function isUnknownLeague(league: string) {
  return league.trim().toUpperCase() === 'UNKNOWN'
}
