import type { MatchRecord } from '../../types'
import { eventTierRank } from '../../data/competitionTaxonomy'
import { canonicalTeamNameFor } from '../../data/teamIdentity'

export function mergeCommunityMatchSources({
  oracleMatches,
  leaguepediaMatches,
}: {
  oracleMatches: MatchRecord[]
  leaguepediaMatches: MatchRecord[]
}) {
  const merged: MatchRecord[] = []
  const seen = new Map<string, MatchRecord>()
  const oracleOutcomeMatches = new Map<string, MatchRecord[]>()
  const oracleStatOutcomeMatches = new Map<string, MatchRecord[]>()

  for (const match of oracleMatches) {
    const retainedMatch = { ...match }
    merged.push(retainedMatch)
    for (const key of matchKeys(retainedMatch)) seen.set(key, retainedMatch)
    appendMatch(oracleOutcomeMatches, matchOutcomeKey(retainedMatch), retainedMatch)
    appendMatch(oracleStatOutcomeMatches, matchStatOutcomeKey(retainedMatch), retainedMatch)
  }

  for (const match of leaguepediaMatches) {
    const oracleStatDuplicate = consumeOracleDuplicate(oracleStatOutcomeMatches, matchStatOutcomeKey(match))
    if (oracleStatDuplicate) {
      enrichRetainedOracleMatch(oracleStatDuplicate, match)
      continue
    }

    const seenDuplicate = matchKeys(match).map((key) => seen.get(key)).find((candidate): candidate is MatchRecord => Boolean(candidate))
    if (seenDuplicate) {
      enrichRetainedOracleMatch(seenDuplicate, match)
      continue
    }

    if (isResultOnlyGapFill(match)) {
      const oracleOutcomeDuplicate = consumeOracleDuplicate(oracleOutcomeMatches, matchOutcomeKey(match))
      if (oracleOutcomeDuplicate) {
        enrichRetainedOracleMatch(oracleOutcomeDuplicate, match)
        continue
      }
    }

    merged.push(match)
    for (const key of matchKeys(match)) seen.set(key, match)
  }

  return merged.sort((a, b) => a.date.localeCompare(b.date))
}

function consumeOracleDuplicate(matches: Map<string, MatchRecord[]>, key: string) {
  const candidates = matches.get(key) ?? []
  return candidates.shift()
}

function enrichRetainedOracleMatch(retainedMatch: MatchRecord, duplicateMatch: MatchRecord) {
  if (retainedMatch.sourceProvider !== 'oracles-elixir' || duplicateMatch.sourceProvider !== 'leaguepedia-cargo') return
  if (isQualifierMetadata(duplicateMatch) && retainedMatch.tier !== 'qualifier') {
    retainedMatch.event = duplicateMatch.event
    retainedMatch.phase = duplicateMatch.phase
    retainedMatch.tier = duplicateMatch.tier
    retainedMatch.sourceMatchId = duplicateMatch.sourceGameId
    return
  }

  if (!hasStrongerCompetitionMetadata(retainedMatch, duplicateMatch)) return
  retainedMatch.phase = duplicateMatch.phase
  retainedMatch.tier = duplicateMatch.tier
  if (duplicateMatch.bestOf > retainedMatch.bestOf) retainedMatch.bestOf = duplicateMatch.bestOf
  retainedMatch.sourceMatchId = duplicateMatch.sourceGameId
}

function isQualifierMetadata(match: MatchRecord) {
  return match.tier === 'qualifier' && /\bqualifier/i.test(`${match.event} ${match.phase}`)
}

function hasStrongerCompetitionMetadata(retainedMatch: MatchRecord, duplicateMatch: MatchRecord) {
  if (eventTierRank(duplicateMatch.tier) <= eventTierRank(retainedMatch.tier)) return false
  if (duplicateMatch.region === 'International' && retainedMatch.region !== 'International') return false
  return duplicateMatch.region === 'International' || retainedMatch.region === 'International'
}

function matchKeys(match: MatchRecord) {
  const teamStats = [
    teamStatKey(match.teamA, match.teamAKills, match.teamAGold),
    teamStatKey(match.teamB, match.teamBKills, match.teamBGold),
  ].sort().join('::')
  const teams = [normalizeTeamName(match.teamA), normalizeTeamName(match.teamB)].sort().join('::')
  const sourceProvider = match.sourceProvider ?? 'unknown'
  const keys = [
    match.sourceGameId ? `game:${normalizeText(match.sourceGameId)}` : '',
    match.sourceMatchId ? `${sourceProvider}:match:${normalizeText(match.sourceMatchId)}` : '',
    `${match.date}::${normalizeText(match.event)}::${normalizeTeamName(match.winner)}::${normalizeText(match.patch)}::${teamStats}::${match.gameLengthSeconds ?? 'unknown-length'}`,
  ].filter(Boolean)
  if (sourceProvider !== 'leaguepedia-cargo' || isResultOnlyGapFill(match)) {
    keys.push(`${match.date}::${teams}::${normalizeTeamName(match.winner)}::result-only-gapfill`)
  }
  return keys
}

function matchOutcomeKey(match: MatchRecord) {
  const teams = [normalizeTeamName(match.teamA), normalizeTeamName(match.teamB)].sort().join('::')
  return `${match.date}::${teams}::${normalizeTeamName(match.winner)}`
}

function matchStatOutcomeKey(match: MatchRecord) {
  const teamStats = [
    teamStatKey(match.teamA, match.teamAKills, match.teamAGold),
    teamStatKey(match.teamB, match.teamBKills, match.teamBGold),
  ].sort().join('::')
  return `${matchOutcomeKey(match)}::${teamStats}`
}

function normalizeTeamName(value: string) {
  return canonicalTeamNameFor(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

function teamStatKey(team: string, kills: number, gold: number) {
  return `${normalizeTeamName(team)}:${kills}:${gold}`
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function appendMatch(matches: Map<string, MatchRecord[]>, key: string, match: MatchRecord) {
  matches.set(key, [...(matches.get(key) ?? []), match])
}

function isResultOnlyGapFill(match: MatchRecord) {
  return match.dataCompleteness === 'match-result-only' || (match.teamAKills === 0 && match.teamBKills === 0 && match.teamAGold === 0 && match.teamBGold === 0)
}
