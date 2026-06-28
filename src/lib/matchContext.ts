import type { MatchRecord, TeamProfile } from '../types'

export function matchesByDate(matches: MatchRecord[]) {
  const groups: MatchRecord[][] = []
  for (const match of matches) {
    const previousGroup = groups.at(-1)
    if (previousGroup?.[0]?.date === match.date) {
      previousGroup.push(match)
    } else {
      groups.push([match])
    }
  }
  return groups
}

export function homeLeagueForMatch(match: MatchRecord, side: 'A' | 'B', teams: Record<string, TeamProfile>) {
  const teamName = side === 'A' ? match.teamA : match.teamB
  return (side === 'A' ? match.teamAHomeLeague : match.teamBHomeLeague) ?? teams[teamName]?.league ?? 'Unknown'
}

export function sourceTraceFor(match: MatchRecord) {
  return {
    provider: match.sourceProvider,
    gameId: match.sourceGameId,
    matchId: match.sourceMatchId,
    url: match.sourceUrl || undefined,
    fileName: match.sourceFileName,
    completeness: match.dataCompleteness,
    date: match.date,
    event: match.event,
    bestOf: match.bestOf,
  }
}
