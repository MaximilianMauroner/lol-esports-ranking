import type { MatchRecord } from '../../types'

export function mergeCommunityMatchSources({
  oracleMatches,
  leaguepediaMatches,
}: {
  oracleMatches: MatchRecord[]
  leaguepediaMatches: MatchRecord[]
}) {
  const merged: MatchRecord[] = []
  const seen = new Set<string>()

  for (const match of oracleMatches) {
    merged.push(match)
    for (const key of matchKeys(match)) seen.add(key)
  }

  for (const match of leaguepediaMatches) {
    if (matchKeys(match).some((key) => seen.has(key))) continue
    merged.push(match)
    for (const key of matchKeys(match)) seen.add(key)
  }

  return merged.sort((a, b) => a.date.localeCompare(b.date))
}

function matchKeys(match: MatchRecord) {
  const teamStats = [
    teamStatKey(match.teamA, match.teamAKills, match.teamAGold),
    teamStatKey(match.teamB, match.teamBKills, match.teamBGold),
  ].sort().join('::')
  const teams = [normalizeName(match.teamA), normalizeName(match.teamB)].sort().join('::')
  const sourceProvider = match.sourceProvider ?? 'unknown'
  const keys = [
    match.sourceGameId ? `game:${normalizeName(match.sourceGameId)}` : '',
    match.sourceMatchId ? `${sourceProvider}:match:${normalizeName(match.sourceMatchId)}` : '',
    `${match.date}::${normalizeName(match.event)}::${normalizeName(match.winner)}::${normalizeName(match.patch)}::${teamStats}::${match.gameLengthSeconds ?? 'unknown-length'}`,
  ].filter(Boolean)
  if (sourceProvider !== 'leaguepedia-cargo' || isResultOnlyGapFill(match)) {
    keys.push(`${match.date}::${teams}::${normalizeName(match.winner)}::result-only-gapfill`)
  }
  return keys
}

function normalizeName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function teamStatKey(team: string, kills: number, gold: number) {
  return `${normalizeName(team)}:${kills}:${gold}`
}

function isResultOnlyGapFill(match: MatchRecord) {
  return match.dataCompleteness === 'match-result-only' || (match.teamAKills === 0 && match.teamBKills === 0 && match.teamAGold === 0 && match.teamBGold === 0)
}
