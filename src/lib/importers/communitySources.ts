import type { MatchRecord } from '../../types'
import { eventTierRank } from '../../data/competitionTaxonomy'
import { canonicalTeamNameFor } from '../../data/teamIdentity'
import { tournamentFamilyForEvent } from '../internationalTournaments'
import type { LolEsportsReferenceEvent } from './lolEsports'

export function mergeCommunityMatchSources({
  oracleMatches,
  leaguepediaMatches,
  lolEsportsReferences = [],
}: {
  oracleMatches: MatchRecord[]
  leaguepediaMatches: MatchRecord[]
  lolEsportsReferences?: LolEsportsReferenceEvent[]
}) {
  const merged: MatchRecord[] = []
  const seen = new Map<string, MatchRecord>()
  const oracleOutcomeMatches = new Map<string, MatchRecord[]>()
  const oracleStatOutcomeMatches = new Map<string, MatchRecord[]>()
  const seenOracleGames = new Set<string>()

  for (const match of oracleMatches) {
    const retainedMatch = { ...match }
    const duplicateKeys = oracleGameDuplicateKeys(retainedMatch)
    if (duplicateKeys.some((key) => seenOracleGames.has(key))) continue
    duplicateKeys.forEach((key) => seenOracleGames.add(key))
    merged.push(retainedMatch)
    for (const key of matchKeys(retainedMatch)) seen.set(key, retainedMatch)
    appendMatch(oracleOutcomeMatches, matchOutcomeKey(retainedMatch), retainedMatch)
    appendMatch(oracleStatOutcomeMatches, matchStatOutcomeKey(retainedMatch), retainedMatch)
  }

  for (const match of leaguepediaMatches) {
    const oracleStatDuplicate = consumeOracleDuplicate(oracleStatOutcomeMatches, matchStatOutcomeKey(match))
    if (oracleStatDuplicate) {
      enrichRetainedOracleMatch(oracleStatDuplicate, match)
      registerMatchKeys(seen, match, oracleStatDuplicate)
      continue
    }

    const seenDuplicate = matchKeys(match).map((key) => seen.get(key)).find((candidate): candidate is MatchRecord => Boolean(candidate))
    if (seenDuplicate) {
      enrichRetainedOracleMatch(seenDuplicate, match)
      registerMatchKeys(seen, match, seenDuplicate)
      continue
    }

    if (isResultOnlyGapFill(match)) {
      const oracleOutcomeDuplicate = consumeOracleDuplicate(oracleOutcomeMatches, matchOutcomeKey(match))
      if (oracleOutcomeDuplicate) {
        enrichRetainedOracleMatch(oracleOutcomeDuplicate, match)
        registerMatchKeys(seen, match, oracleOutcomeDuplicate)
        continue
      }
    }

    merged.push(match)
    for (const key of matchKeys(match)) seen.set(key, match)
  }

  const reconciled = reconcileSharedSeriesGames(merged)
  enrichWithLolEsportsReferences(reconciled, lolEsportsReferences)
  return reconciled.sort((a, b) => a.date.localeCompare(b.date))
}

function registerMatchKeys(seen: Map<string, MatchRecord>, match: MatchRecord, retained: MatchRecord) {
  for (const key of matchKeys(match)) seen.set(key, retained)
}

function reconcileSharedSeriesGames(matches: MatchRecord[]) {
  const groups = new Map<string, MatchRecord[]>()
  const ungrouped: MatchRecord[] = []

  for (const match of matches) {
    const identity = sharedSeriesIdentity(match)
    if (!identity) {
      ungrouped.push(match)
      continue
    }
    groups.set(identity.key, [...(groups.get(identity.key) ?? []), match])
  }

  const reconciled = [...ungrouped]
  for (const group of groups.values()) {
    if (new Set(group.map((match) => match.sourceProvider)).size < 2) {
      reconciled.push(...group)
      continue
    }

    const strongestBestOf = Math.max(...group.map((match) => match.bestOf))
    const seriesReference = group.find((match) => match.sourceProvider === 'oracles-elixir') ?? group[0]
    const byGame = new Map<number, MatchRecord>()
    for (const match of group) {
      const gameNumber = sharedSeriesIdentity(match)?.gameNumber
      if (!gameNumber) {
        reconciled.push(match)
        continue
      }
      const current = byGame.get(gameNumber)
      if (!current || richerMatch(match, current)) byGame.set(gameNumber, match)
    }

    for (const match of byGame.values()) {
      const identity = sharedSeriesIdentity(match)
      if (!identity) continue
      reconciled.push({
        ...match,
        sourceMatchId: identity.seriesId,
        event: seriesReference.event,
        phase: seriesReference.phase,
        region: seriesReference.region,
        league: seriesReference.league,
        tier: seriesReference.tier,
        bestOf: strongestBestOf,
        bestOfBasis: strongestBestOf > match.bestOf ? 'provider' : match.bestOfBasis,
      })
    }
  }
  return reconciled
}

function sharedSeriesIdentity(match: MatchRecord) {
  for (const value of [match.sourceMatchId, match.sourceGameId]) {
    if (!value) continue
    const parsed = value.match(/^(.*?)[_-](?:game[_-]?)?([1-5])$/i)
    if (!parsed?.[1] || !parsed[2]) continue
    const teams = [normalizeTeamName(match.teamA), normalizeTeamName(match.teamB)].sort().join('::')
    return {
      key: `${match.date}::${teams}::${normalizeText(parsed[1])}`,
      seriesId: parsed[1],
      gameNumber: Number(parsed[2]),
    }
  }
  return undefined
}

function richerMatch(candidate: MatchRecord, current: MatchRecord) {
  if (candidate.sourceProvider === current.sourceProvider) return false
  return candidate.sourceProvider === 'oracles-elixir'
}

function enrichWithLolEsportsReferences(matches: MatchRecord[], references: LolEsportsReferenceEvent[]) {
  if (references.length === 0 || matches.length === 0) return
  const bo1ReferencesByOutcome = uniqueReferenceMap(references.filter((reference) => strategyCount(reference) <= 1), referenceOutcomeKeys)
  const seriesReferencesByTeams = uniqueReferenceMap(references, referenceTeamKeys)

  for (const match of matches) {
    const bo1Reference = bo1ReferencesByOutcome.get(matchOutcomeKey(match))
    if (bo1Reference) {
      enrichWithLolEsportsReference(match, bo1Reference, { includeGameId: bo1Reference.gameIds.length === 1 })
      continue
    }

    const seriesReference = seriesReferencesByTeams.get(matchTeamDateKey(match))
    if (seriesReference && strategyCount(seriesReference) > 1) {
      enrichWithLolEsportsReference(match, seriesReference, { includeGameId: false })
    }
  }
}

function enrichWithLolEsportsReference(
  match: MatchRecord,
  reference: LolEsportsReferenceEvent,
  options: { includeGameId: boolean },
) {
  match.officialEventId = reference.matchId
  match.officialMatchId = reference.matchId
  match.officialScheduleState = reference.state
  match.datetimeUtc = reference.startTime ?? match.datetimeUtc
  const officialBestOf = reference.strategy?.count
  if (officialBestOf !== undefined && [1, 2, 3, 5].includes(officialBestOf)) {
    match.bestOf = officialBestOf
    match.bestOfBasis = 'official'
  }
  if (options.includeGameId) match.officialGameId = reference.gameIds[0]
}

function uniqueReferenceMap(
  references: LolEsportsReferenceEvent[],
  keysFor: (reference: LolEsportsReferenceEvent) => string[],
) {
  const referencesByKey = new Map<string, LolEsportsReferenceEvent | undefined>()
  for (const reference of references) {
    for (const key of keysFor(reference)) {
      if (!key) continue
      referencesByKey.set(key, referencesByKey.has(key) ? undefined : reference)
    }
  }
  for (const [key, reference] of referencesByKey.entries()) {
    if (!reference) referencesByKey.delete(key)
  }
  return referencesByKey as Map<string, LolEsportsReferenceEvent>
}

function referenceOutcomeKeys(reference: LolEsportsReferenceEvent) {
  const winner = referenceWinner(reference)
  if (!winner) return []
  return referenceTeamKeys(reference).map((key) => `${key}::${normalizeTeamName(winner)}`)
}

function referenceTeamKeys(reference: LolEsportsReferenceEvent) {
  if (!reference.date || reference.teams.length < 2) return []
  const teams = reference.teams
    .map((team) => normalizeTeamName(team.name))
    .filter(Boolean)
    .sort()
    .join('::')
  return teams ? [`${reference.date}::${teams}`] : []
}

function matchTeamDateKey(match: MatchRecord) {
  const teams = [normalizeTeamName(match.teamA), normalizeTeamName(match.teamB)].sort().join('::')
  return `${match.date}::${teams}`
}

function referenceWinner(reference: LolEsportsReferenceEvent) {
  const explicitWinner = reference.teams.find((team) => team.outcome === 'win')?.name
  if (explicitWinner) return explicitWinner
  const [leader, runnerUp] = reference.teams
    .filter((team) => typeof team.gameWins === 'number')
    .sort((left, right) => (right.gameWins ?? 0) - (left.gameWins ?? 0))
  if (!leader || !runnerUp || leader.gameWins === runnerUp.gameWins) return undefined
  return leader.name
}

function strategyCount(reference: LolEsportsReferenceEvent) {
  return reference.strategy?.count ?? reference.gameIds.length
}

function consumeOracleDuplicate(matches: Map<string, MatchRecord[]>, key: string) {
  const candidates = matches.get(key) ?? []
  return candidates.shift()
}

function enrichRetainedOracleMatch(retainedMatch: MatchRecord, duplicateMatch: MatchRecord) {
  if (retainedMatch.sourceProvider !== 'oracles-elixir' || duplicateMatch.sourceProvider !== 'leaguepedia-cargo') return
  mergeFormatProvenance(retainedMatch, duplicateMatch)
  if (!retainedMatch.sourceMatchId
    && retainedMatch.region === 'International'
    && duplicateMatch.region === 'International'
    && sharedSeriesIdentity(duplicateMatch)) {
    retainedMatch.sourceMatchId = duplicateMatch.sourceGameId
  }
  if (
    (isQualifierMetadata(duplicateMatch) && retainedMatch.tier !== 'qualifier')
    || isRegionalFinalMislabel(retainedMatch, duplicateMatch)
  ) {
    retainedMatch.event = duplicateMatch.event
    retainedMatch.phase = duplicateMatch.phase
    retainedMatch.tier = duplicateMatch.tier
    retainedMatch.sourceMatchId = duplicateMatch.sourceGameId
    return
  }

  if (!hasStrongerCompetitionMetadata(retainedMatch, duplicateMatch)) return
  retainedMatch.phase = duplicateMatch.phase
  retainedMatch.tier = duplicateMatch.tier
  retainedMatch.sourceMatchId = duplicateMatch.sourceGameId
}

function mergeFormatProvenance(retainedMatch: MatchRecord, duplicateMatch: MatchRecord) {
  const basisRank = { fallback: 0, provider: 1, official: 2 } as const
  const retainedRank = retainedMatch.bestOfBasis ? basisRank[retainedMatch.bestOfBasis] : 1
  const duplicateRank = duplicateMatch.bestOfBasis ? basisRank[duplicateMatch.bestOfBasis] : 1
  if (duplicateRank < retainedRank) return
  if (duplicateRank === retainedRank && duplicateMatch.bestOf <= retainedMatch.bestOf) return
  retainedMatch.bestOf = duplicateMatch.bestOf
  retainedMatch.bestOfBasis = duplicateMatch.bestOfBasis
}

function isRegionalFinalMislabel(retainedMatch: MatchRecord, duplicateMatch: MatchRecord) {
  return /\b(?:wlds|worlds|world championship)\b/i.test(retainedMatch.event)
    && /\bregional finals?\b/i.test(`${duplicateMatch.event} ${duplicateMatch.phase}`)
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
    `${match.date}::${canonicalEventKey(match)}::${normalizeTeamName(match.winner)}::${normalizeText(match.patch)}::${teamStats}::${match.gameLengthSeconds ?? 'unknown-length'}`,
  ].filter(Boolean)
  if (sourceProvider !== 'leaguepedia-cargo' || isResultOnlyGapFill(match)) {
    keys.push(`${match.date}::${teams}::${normalizeTeamName(match.winner)}::result-only-gapfill`)
  }
  return keys
}

function oracleGameDuplicateKeys(match: MatchRecord) {
  const teams = [normalizeTeamName(match.teamA), normalizeTeamName(match.teamB)].sort().join('::')
  const stats = [
    teamStatKey(match.teamA, match.teamAKills, match.teamAGold),
    teamStatKey(match.teamB, match.teamBKills, match.teamBGold),
  ].sort().join('::')
  return [
    match.sourceGameId ? `source-game:${normalizeText(match.sourceGameId)}` : '',
    `fingerprint:${match.date}::${canonicalEventKey(match)}::${teams}::${normalizeTeamName(match.winner)}::${stats}::${match.gameLengthSeconds ?? 'unknown-length'}::${normalizeText(match.patch)}`,
  ].filter(Boolean)
}

function canonicalEventKey(match: MatchRecord) {
  const family = tournamentFamilyForEvent(match.event)
  return family ? `${family}:${match.season}` : normalizeText(match.event)
}

function matchOutcomeKey(match: MatchRecord) {
  return `${matchTeamDateKey(match)}::${normalizeTeamName(match.winner)}`
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
