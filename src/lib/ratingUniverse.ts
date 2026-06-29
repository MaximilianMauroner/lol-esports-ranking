import { isRatedTeamLeague } from '../data/regionTaxonomy'
import type { MatchRecord, TeamProfile } from '../types'
import { homeLeagueForMatch } from './matchContext'
import { deriveTeamProfilesFromMatches } from './teamProfiles'

export type PublishedRatingUniverseInput = {
  matches: MatchRecord[]
  teams: Record<string, TeamProfile>
}

export function filterPublishedRatingUniverseInput(
  matches: MatchRecord[],
  teams: Record<string, TeamProfile>,
): PublishedRatingUniverseInput {
  const universeMatches = filterPublishedRatingUniverseMatches(matches, teams)
  return {
    matches: universeMatches,
    teams: filterPublishedRatingUniverseTeams(universeMatches, teams),
  }
}

export function filterPublishedRatingUniverseMatches(
  matches: MatchRecord[],
  teams: Record<string, TeamProfile>,
) {
  return matches.filter((match) => matchBelongsToPublishedRatingUniverse(match, teams))
}

export function matchBelongsToPublishedRatingUniverse(match: MatchRecord, teams: Record<string, TeamProfile>) {
  return sideBelongsToPublishedRatingUniverse(match, 'A', teams)
    && sideBelongsToPublishedRatingUniverse(match, 'B', teams)
}

function sideBelongsToPublishedRatingUniverse(
  match: MatchRecord,
  side: 'A' | 'B',
  teams: Record<string, TeamProfile>,
) {
  return isRatedTeamLeague(homeLeagueForMatch(match, side, teams))
}

function filterPublishedRatingUniverseTeams(
  matches: MatchRecord[],
  teams: Record<string, TeamProfile>,
) {
  const activeTeamNames = new Set(matches.flatMap((match) => [match.teamA, match.teamB]))
  const ratedFallbackProfiles = Object.fromEntries(
    Object.entries(teams).filter(([, profile]) => isRatedTeamLeague(profile.league)),
  )
  const derivedProfiles = deriveTeamProfilesFromMatches(matches, ratedFallbackProfiles)
  const universeTeams: Record<string, TeamProfile> = {}

  for (const teamName of activeTeamNames) {
    const profile = derivedProfiles[teamName] ?? teams[teamName]
    if (profile && isRatedTeamLeague(profile.league)) {
      universeTeams[teamName] = profile
    }
  }

  return universeTeams
}
