import { eventTierConfig } from '../data/rankingConfig'
import { cappedLeagueRatingForTier, leaguePriorFor, leagueTierFor } from '../data/leagueTiers'
import type {
  LeagueStrength,
  LeagueTierName,
  MatchRecord,
  PlayerAppearanceFlag,
  PlayerAppearanceSummary,
  PlayerProfile,
  PlayerStanding,
  Role,
  RosterPlayerAppearance,
  SourceTrace,
  TeamProfile,
} from '../types'
import { executionIndexFromStats } from './executionResidual'
import { homeLeagueForMatch } from './matchContext'

const initialPlayerRating = 100
const sourcedPlayerKFactor = 8
const playerRatingScale = 80
const playerLeagueAnchorRating = 1500
const playerLeagueBaselineCoefficient = 0.2
const playerLeagueBaselineBounds = {
  min: 50,
  max: 110,
} as const
const playerLeagueSignalMultiplierByTier: Record<LeagueTierName, number> = {
  'tier-one': 1,
  'tier-two': 0.9,
  'tier-three': 0.65,
  emerging: 0.35,
  unknown: 0.25,
} as const
const playerPregameEdgeCoefficient = 2.5
const playerPregameEdgeCap = 40
const playerPregameMinCoverage = 0.6
const playerPregameMinGames = 1
const minimumRankedSourcedPlayerGames = 20
const thinAppearanceSampleGames = 5
export const baseRoleShares: Record<Role, number> = {
  Top: 0.18,
  Jungle: 0.22,
  Mid: 0.22,
  Bot: 0.2,
  Support: 0.18,
}
const playerImpactWeights = {
  objectiveImpactZ: 0.12,
  awardResidualZ: 0.06,
  recentFormZ: 0.04,
} as const
const playerImpactMultiplierBounds = {
  min: 0.7,
  max: 1.45,
} as const
const sourcedPerformanceWeights = {
  win: 0.38,
  damageShare: 0.2,
  earnedGoldShare: 0.18,
  kda: 0.14,
  vision: 0.1,
} as const
const roleStatBaselines: Record<Role, { damageShare: number; earnedGoldShare: number; kda: number; vspm: number }> = {
  Top: { damageShare: 0.23, earnedGoldShare: 0.21, kda: 3, vspm: 0.9 },
  Jungle: { damageShare: 0.16, earnedGoldShare: 0.18, kda: 3.4, vspm: 1.2 },
  Mid: { damageShare: 0.25, earnedGoldShare: 0.22, kda: 3.6, vspm: 1 },
  Bot: { damageShare: 0.28, earnedGoldShare: 0.25, kda: 3.8, vspm: 0.8 },
  Support: { damageShare: 0.08, earnedGoldShare: 0.13, kda: 3.2, vspm: 2.4 },
}

export const playerModelParameters = {
  initialPlayerRating,
  sourcedPlayerKFactor,
  playerRatingScale,
  playerLeagueAnchorRating,
  playerLeagueBaselineCoefficient,
  playerLeagueBaselineBounds,
  playerLeagueSignalMultiplierByTier,
  playerPregameEdgeCoefficient,
  playerPregameEdgeCap,
  playerPregameMinCoverage,
  playerPregameMinGames,
  minimumRankedSourcedPlayerGames,
  baseRoleShares,
  playerImpactWeights,
  playerImpactMultiplierBounds,
  sourcedPerformanceWeights,
  roleStatBaselines,
} as const

export type PregamePlayerRatingEdge = {
  teamAAdjustment: number
  teamBAdjustment: number
  teamACoverage: number
  teamBCoverage: number
}

type PlayerRatingContext = {
  teams?: Record<string, TeamProfile>
  leagueStrengths?: LeagueStrength[]
}

export function buildPlayerModel(
  matches: MatchRecord[],
  rosters: Record<string, PlayerProfile[]>,
  context: PlayerRatingContext = {},
): PlayerStanding[] {
  if (hasObservedPlayerStats(matches)) {
    return buildSourcedPlayerModel(matches, context)
  }

  return buildStaticRosterPlayerModel(matches, rosters)
}

function buildStaticRosterPlayerModel(
  matches: MatchRecord[],
  rosters: Record<string, PlayerProfile[]>,
): PlayerStanding[] {
  const ratings = new Map<string, number>()
  const profiles = new Map<string, PlayerProfile>()
  const forms = new Map<string, string[]>()
  const histories = new Map<string, PlayerStanding['history']>()
  const finalShares = new Map<string, PlayerShare>()
  const sortedMatches = matches.toSorted((a, b) => a.date.localeCompare(b.date))

  for (const roster of Object.values(rosters)) {
    for (const player of roster) {
      ratings.set(player.id, initialPlayerRating)
      profiles.set(player.id, player)
      forms.set(player.id, [])
      histories.set(player.id, [])
    }
  }

  for (const match of sortedMatches) {
    for (const team of [match.teamA, match.teamB]) {
      const roster = rosters[team]
      if (!roster) continue
      const won = match.winner === team
      const isTeamA = match.teamA === team
      const killsFor = isTeamA ? match.teamAKills : match.teamBKills
      const killsAgainst = isTeamA ? match.teamBKills : match.teamAKills
      const goldFor = isTeamA ? match.teamAGold : match.teamBGold
      const goldAgainst = isTeamA ? match.teamBGold : match.teamAGold
      const objectivesFor = teamObjectiveCount(match, isTeamA ? 'A' : 'B')
      const objectivesAgainst = teamObjectiveCount(match, isTeamA ? 'B' : 'A')
      const dominance = executionIndexFromStats(killsFor, killsAgainst, goldFor, goldAgainst, objectivesFor, objectivesAgainst)
      const eventWeight = eventTierConfig[match.tier].weight
      const shares = playerSharesForRoster(roster, ratings, forms)

      for (const player of roster) {
        const rating = ratings.get(player.id) ?? initialPlayerRating
        const playerShare = shares.get(player.id) ?? fallbackPlayerShare(player)
        const shareMultiplier = playerShare.playerShare / 0.2
        const delta = Number((((won ? 1.6 : -1.1) * eventWeight + dominance * 5) * shareMultiplier).toFixed(1))
        const nextRating = Number((rating + delta).toFixed(1))
        finalShares.set(player.id, playerShare)
        ratings.set(player.id, nextRating)
        forms.set(player.id, [...(forms.get(player.id) ?? []), won ? 'W' : 'L'].slice(-5))
        histories.set(player.id, [
          ...(histories.get(player.id) ?? []),
          { date: match.date, event: match.event, rating: nextRating, delta },
        ])
      }
    }
  }

  for (const roster of Object.values(rosters)) {
    const shares = playerSharesForRoster(roster, ratings, forms)
    for (const player of roster) {
      finalShares.set(player.id, shares.get(player.id) ?? fallbackPlayerShare(player))
    }
  }

  return Array.from(ratings.entries())
    .map(([id, rating]): PlayerStanding | null => {
      const profile = profiles.get(id)
      if (!profile) return null
      const history = histories.get(id) ?? []
      const playerShare = finalShares.get(id) ?? fallbackPlayerShare(profile)
      return {
        id,
        name: profile.name,
        team: profile.team,
        role: profile.role,
        games: history.length,
        ratingBasis: 'seeded-demo-rosters' as const,
        rating: Number(rating.toFixed(1)),
        delta: Number((history.at(-1)?.delta ?? 0).toFixed(1)),
        rank: 0,
        baseShare: roundShare(playerShare.baseShare),
        playerShare: roundShare(playerShare.playerShare),
        impactMultiplier: Number(playerShare.impactMultiplier.toFixed(2)),
        availability: roundShare(playerShare.availability),
        roleCertainty: roundShare(playerShare.roleCertainty),
        impactDrivers: {
          objectiveImpactZ: Number(playerShare.impactDrivers.objectiveImpactZ.toFixed(2)),
          awardResidualZ: Number(playerShare.impactDrivers.awardResidualZ.toFixed(2)),
          recentFormZ: Number(playerShare.impactDrivers.recentFormZ.toFixed(2)),
        },
        form: forms.get(id) ?? [],
        history,
      }
    })
    .filter((player): player is PlayerStanding => player !== null)
    .sort((a, b) => b.rating - a.rating)
    .map((player, index) => ({ ...player, rank: index + 1 }))
}

function buildSourcedPlayerModel(matches: MatchRecord[], context: PlayerRatingContext): PlayerStanding[] {
  const state = createSourcedPlayerState(true)
  const histories = state.histories ?? new Map<string, PlayerStanding['history']>()
  const finalShares = new Map<string, PlayerShare>()
  const latestRosterByTeam = new Map<string, PlayerProfile[]>()
  const leagueRatings = leagueRatingsFor(context.leagueStrengths)
  const sortedMatches = matches.toSorted((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))

  for (const dateMatches of matchesByDate(sortedMatches)) {
    for (const match of dateMatches) {
      registerSourcedRosters(match, state, context, leagueRatings)
    }
    applySourcedPlayerUpdates(dateMatches, state, new Map(state.ratings), context, leagueRatings, latestRosterByTeam)
  }

  for (const roster of latestRosterByTeam.values()) {
    const shares = playerSharesForRoster(roster, state.ratings, state.forms)
    for (const player of roster) {
      finalShares.set(player.id, shares.get(player.id) ?? fallbackPlayerShare(player))
    }
  }

  return Array.from(state.ratings.entries())
    .map(([id, rating]): PlayerStanding | null => {
      const profile = state.profiles.get(id)
      if (!profile) return null
      const history = histories.get(id) ?? []
      const playerShare = finalShares.get(id) ?? fallbackPlayerShare(profile)
      const league = leagueForProfile(profile, context)
      return {
        id,
        name: profile.name,
        team: profile.team,
        role: profile.role,
        games: history.length,
        ratingBasis: 'sourced-player-stats' as const,
        rating: publishedPlayerRating(rating, league, leagueRatings),
        delta: Number((history.at(-1)?.delta ?? 0).toFixed(1)),
        rank: 0,
        baseShare: roundShare(playerShare.baseShare),
        playerShare: roundShare(playerShare.playerShare),
        impactMultiplier: Number(playerShare.impactMultiplier.toFixed(2)),
        availability: roundShare(playerShare.availability),
        roleCertainty: roundShare(playerShare.roleCertainty),
        impactDrivers: {
          objectiveImpactZ: Number(playerShare.impactDrivers.objectiveImpactZ.toFixed(2)),
          awardResidualZ: Number(playerShare.impactDrivers.awardResidualZ.toFixed(2)),
          recentFormZ: Number(playerShare.impactDrivers.recentFormZ.toFixed(2)),
        },
        form: state.forms.get(id) ?? [],
        history,
        source: state.sources?.get(id),
        appearance: appearanceSummaryFor(id, profile, state),
      }
    })
    .filter((player): player is PlayerStanding => player !== null)
    .filter((player) => player.games > 0)
    .sort((a, b) => b.rating - a.rating)
    .map((player, index) => ({ ...player, rank: index + 1 }))
}

export function buildPregamePlayerRatingEdges(
  matches: MatchRecord[],
  context: PlayerRatingContext = {},
): Map<string, PregamePlayerRatingEdge> {
  const state = createSourcedPlayerState(false)
  const edges = new Map<string, PregamePlayerRatingEdge>()
  const leagueRatings = leagueRatingsFor(context.leagueStrengths)
  const sortedMatches = matches.toSorted((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))

  for (const dateMatches of matchesByDate(sortedMatches)) {
    const dateStartRatings = new Map(state.ratings)
    const dateStartGames = new Map(state.games)

    for (const match of dateMatches) {
      const teamAEdge = playerEdgeForRoster(
        match.teamARoster,
        dateStartRatings,
        dateStartGames,
        leagueForSide(match, 'A', context),
        leagueRatings,
      )
      const teamBEdge = playerEdgeForRoster(
        match.teamBRoster,
        dateStartRatings,
        dateStartGames,
        leagueForSide(match, 'B', context),
        leagueRatings,
      )
      edges.set(match.id, {
        teamAAdjustment: teamAEdge.adjustment,
        teamBAdjustment: teamBEdge.adjustment,
        teamACoverage: teamAEdge.coverage,
        teamBCoverage: teamBEdge.coverage,
      })
    }

    for (const match of dateMatches) {
      registerSourcedRosters(match, state, context, leagueRatings)
    }
    applySourcedPlayerUpdates(dateMatches, state, dateStartRatings, context, leagueRatings)
  }

  return edges
}

function hasObservedPlayerStats(matches: MatchRecord[]) {
  return matches.some((match) =>
    [match.teamARoster, match.teamBRoster].some((roster) => roster?.players.some((player) => player.stats)),
  )
}

function profileForAppearance(player: RosterPlayerAppearance, team: string): PlayerProfile {
  return {
    id: player.id,
    name: player.name,
    team,
    role: player.role,
  }
}

type SourcedPlayerState = {
  ratings: Map<string, number>
  games: Map<string, number>
  profiles: Map<string, PlayerProfile>
  forms: Map<string, string[]>
  histories?: Map<string, PlayerStanding['history']>
  sources?: Map<string, SourceTrace>
  appearances?: Map<string, PlayerAppearanceAccumulator>
}

type PlayerAppearanceAccumulator = {
  teamGames: Map<string, { team: string; games: number; latestObservedAt?: string; latestObservedEvent?: string }>
  roleGames: Map<Role, number>
}

function createSourcedPlayerState(includeAuditFields: boolean): SourcedPlayerState {
  return {
    ratings: new Map(),
    games: new Map(),
    profiles: new Map(),
    forms: new Map(),
    histories: includeAuditFields ? new Map() : undefined,
    sources: includeAuditFields ? new Map() : undefined,
    appearances: includeAuditFields ? new Map() : undefined,
  }
}

function matchesByDate(matches: MatchRecord[]) {
  const groups: MatchRecord[][] = []
  for (const match of matches) {
    const current = groups.at(-1)
    if (current?.[0]?.date === match.date) current.push(match)
    else groups.push([match])
  }
  return groups
}

function registerSourcedRosters(
  match: MatchRecord,
  state: SourcedPlayerState,
  context: PlayerRatingContext,
  leagueRatings: Map<string, number>,
) {
  for (const { side, team, roster } of teamRosterEntries(match)) {
    if (!roster) continue
    const rosterProfiles = roster.players.map((player) => profileForAppearance(player, team))
    const leagueBaseline = playerBaselineForLeague(leagueForSide(match, side, context), leagueRatings)
    for (const profile of rosterProfiles) {
      ensureSourcedPlayer(profile, state, leagueBaseline)
    }
  }
}

function applySourcedPlayerUpdates(
  matches: MatchRecord[],
  state: SourcedPlayerState,
  preUpdateRatings: Map<string, number>,
  context: PlayerRatingContext,
  leagueRatings: Map<string, number>,
  latestRosterByTeam?: Map<string, PlayerProfile[]>,
) {
  for (const match of matches) {
    for (const { side, team, roster, opponentRoster, opponentSide } of teamRosterEntries(match)) {
      if (!roster || !opponentRoster || !isCompleteSourcedMatchup(roster, opponentRoster)) continue
      latestRosterByTeam?.set(team, roster.players.map((player) => profileForAppearance(player, team)))
      const league = leagueForSide(match, side, context)
      const opponentLeague = leagueForSide(match, opponentSide, context)
      const leagueBaseline = playerBaselineForLeague(league, leagueRatings)
      const opponentLeagueBaseline = playerBaselineForLeague(opponentLeague, leagueRatings)
      for (const player of roster.players) {
        if (!player.stats) continue
        const profile = profileForAppearance(player, team)
        ensureSourcedPlayer(profile, state, leagueBaseline)
        const opponent = opponentRoster.players.find((candidate) => candidate.role === player.role)
        if (!opponent?.stats) continue
        const rating = preUpdateRatings.get(player.id) ?? leagueBaseline
        const opponentRating = preUpdateRatings.get(opponent.id) ?? opponentLeagueBaseline
        const expected = expectedPlayerScore(rating, opponentRating)
        const performance = playerPerformance(player, opponent)
        const eventWeight = eventTierConfig[match.tier].weight
        const delta = Number((sourcedPlayerKFactor * eventWeight * (performance - expected)).toFixed(1))
        const currentRating = state.ratings.get(player.id) ?? rating
        const nextRating = Number((currentRating + delta).toFixed(1))
        const currentPublishedRating = publishedPlayerRating(currentRating, league, leagueRatings)
        const nextPublishedRating = publishedPlayerRating(nextRating, league, leagueRatings)
        state.ratings.set(player.id, nextRating)
        state.profiles.set(player.id, profile)
        state.games.set(player.id, (state.games.get(player.id) ?? 0) + 1)
        state.forms.set(player.id, [...(state.forms.get(player.id) ?? []), player.stats.won ? 'W' : 'L'].slice(-5))
        state.histories?.set(player.id, [
          ...(state.histories.get(player.id) ?? []),
          {
            date: match.date,
            event: match.event,
            rating: nextPublishedRating,
            delta: Number((nextPublishedRating - currentPublishedRating).toFixed(1)),
          },
        ])
        state.sources?.set(player.id, sourceTraceFor(match))
        recordRatedAppearance(player.id, profile, match, state)
      }
    }
  }
}

function recordRatedAppearance(
  playerId: string,
  profile: PlayerProfile,
  match: MatchRecord,
  state: SourcedPlayerState,
) {
  if (!state.appearances) return
  const current = state.appearances.get(playerId) ?? {
    teamGames: new Map(),
    roleGames: new Map(),
  }
  const teamRecord = current.teamGames.get(profile.team) ?? { team: profile.team, games: 0 }
  current.teamGames.set(profile.team, {
    ...teamRecord,
    games: teamRecord.games + 1,
    latestObservedAt: match.date,
    latestObservedEvent: match.event,
  })
  current.roleGames.set(profile.role, (current.roleGames.get(profile.role) ?? 0) + 1)
  state.appearances.set(playerId, current)
}

function appearanceSummaryFor(
  playerId: string,
  profile: PlayerProfile,
  state: SourcedPlayerState,
): PlayerAppearanceSummary | undefined {
  const appearance = state.appearances?.get(playerId)
  if (!appearance) return undefined
  const teamHistory = Array.from(appearance.teamGames.values())
    .sort((left, right) =>
      right.games - left.games
      || (right.latestObservedAt ?? '').localeCompare(left.latestObservedAt ?? '')
      || left.team.localeCompare(right.team),
    )
  const roleHistory = Array.from(appearance.roleGames.entries())
    .map(([role, games]) => ({ role, games }))
    .sort((left, right) => right.games - left.games || roleOrder(left.role) - roleOrder(right.role))
  const games = state.games.get(playerId) ?? teamHistory.reduce((total, team) => total + team.games, 0)
  const primaryTeam = teamHistory[0]
  const latestTeamGames = appearance.teamGames.get(profile.team)?.games ?? 0
  const roleGames = appearance.roleGames.get(profile.role) ?? 0

  return {
    primaryTeam: primaryTeam?.team ?? profile.team,
    primaryTeamGames: primaryTeam?.games ?? latestTeamGames,
    primaryTeamShare: roundShare(games > 0 ? (primaryTeam?.games ?? latestTeamGames) / games : 0),
    latestTeamGames,
    latestTeamShare: roundShare(games > 0 ? latestTeamGames / games : 0),
    roleGames,
    roleShare: roundShare(games > 0 ? roleGames / games : 0),
    teamsPlayed: teamHistory.length,
    rolesPlayed: roleHistory.length,
    teamHistory,
    roleHistory,
    flags: appearanceFlagsFor(playerId, latestTeamGames, roleGames, teamHistory.length, roleHistory.length),
  }
}

function appearanceFlagsFor(
  playerId: string,
  latestTeamGames: number,
  roleGames: number,
  teamsPlayed: number,
  rolesPlayed: number,
) {
  const flags: PlayerAppearanceFlag[] = []
  if (teamsPlayed > 1) flags.push('multi-team-career')
  if (latestTeamGames > 0 && latestTeamGames < thinAppearanceSampleGames) flags.push('thin-latest-team-sample')
  if (rolesPlayed > 1) flags.push('multi-role-career')
  if (roleGames > 0 && roleGames < thinAppearanceSampleGames) flags.push('thin-role-sample')
  if (playerId.startsWith('oe:player:unresolved:')) flags.push('unresolved-player-id')
  return flags
}

function teamRosterEntries(match: MatchRecord) {
  return [
    { side: 'A', opponentSide: 'B', team: match.teamA, roster: match.teamARoster, opponentRoster: match.teamBRoster },
    { side: 'B', opponentSide: 'A', team: match.teamB, roster: match.teamBRoster, opponentRoster: match.teamARoster },
  ] as const
}

function isCompleteSourcedMatchup(
  roster: MatchRecord['teamARoster'],
  opponentRoster: MatchRecord['teamARoster'],
) {
  if (roster?.completeness !== 'complete-five-role' || opponentRoster?.completeness !== 'complete-five-role') {
    return false
  }
  return roster.players.every((player) =>
    player.stats && opponentRoster.players.some((opponent) => opponent.role === player.role && opponent.stats),
  )
}

function playerEdgeForRoster(
  roster: MatchRecord['teamARoster'],
  ratings: Map<string, number>,
  games: Map<string, number>,
  league: string,
  leagueRatings: Map<string, number>,
) {
  if (!roster || roster.completeness !== 'complete-five-role') return { adjustment: 0, coverage: 0 }

  const leagueBaseline = playerBaselineForLeague(league, leagueRatings)
  const leagueSignalMultiplier = playerSignalMultiplierForLeague(league)
  let coverage = 0
  let weightedRatingEdge = 0

  for (const player of roster.players) {
    if ((games.get(player.id) ?? 0) < playerPregameMinGames) continue
    const roleShare = baseRoleShares[player.role]
    coverage += roleShare
    weightedRatingEdge += roleShare * ((ratings.get(player.id) ?? leagueBaseline) - leagueBaseline) * leagueSignalMultiplier
  }

  if (coverage < playerPregameMinCoverage) {
    return { adjustment: 0, coverage: roundShare(coverage) }
  }

  const weightedMeanEdge = weightedRatingEdge / coverage
  const adjustment = clamp(
    playerPregameEdgeCoefficient * weightedMeanEdge * coverage,
    -playerPregameEdgeCap,
    playerPregameEdgeCap,
  )

  return {
    adjustment: Number(adjustment.toFixed(1)),
    coverage: roundShare(coverage),
  }
}

function ensureSourcedPlayer(
  profile: PlayerProfile,
  state: SourcedPlayerState,
  initialRating: number = initialPlayerRating,
) {
  if (state.ratings.has(profile.id)) return
  state.ratings.set(profile.id, initialRating)
  state.games.set(profile.id, 0)
  state.profiles.set(profile.id, profile)
  state.forms.set(profile.id, [])
  state.histories?.set(profile.id, [])
}

function expectedPlayerScore(rating: number, opponentRating: number) {
  return 1 / (1 + 10 ** ((opponentRating - rating) / playerRatingScale))
}

function playerPerformance(player: RosterPlayerAppearance, opponent: RosterPlayerAppearance) {
  return clamp(0.5 + (rawPlayerPerformance(player) - rawPlayerPerformance(opponent)) / 2, 0, 1)
}

function rawPlayerPerformance(player: RosterPlayerAppearance) {
  const stats = player.stats
  if (!stats) return 0.5
  const baseline = roleStatBaselines[player.role]
  const kda = (stats.kills + stats.assists) / Math.max(1, stats.deaths)

  return clamp(
    sourcedPerformanceWeights.win * (stats.won ? 1 : 0)
      + sourcedPerformanceWeights.damageShare * statScore(stats.damageShare, baseline.damageShare, 0.12)
      + sourcedPerformanceWeights.earnedGoldShare * statScore(stats.earnedGoldShare, baseline.earnedGoldShare, 0.1)
      + sourcedPerformanceWeights.kda * statScore(kda, baseline.kda, 4)
      + sourcedPerformanceWeights.vision * statScore(stats.vspm, baseline.vspm, 1.8),
    0,
    1,
  )
}

function leagueRatingsFor(leagueStrengths: LeagueStrength[] | undefined) {
  return new Map((leagueStrengths ?? []).map((league) => [league.league, league.score]))
}

function leagueForSide(match: MatchRecord, side: 'A' | 'B', context: PlayerRatingContext) {
  return homeLeagueForMatch(match, side, context.teams ?? {})
}

function leagueForProfile(profile: PlayerProfile, context: PlayerRatingContext) {
  return context.teams?.[profile.team]?.league ?? 'Unknown'
}

function playerBaselineForLeague(league: string, leagueRatings: Map<string, number>) {
  const leagueRating = cappedLeagueRatingForTier(league, leagueRatings.get(league) ?? leaguePriorFor(league))
  return Number(clamp(
    initialPlayerRating + (leagueRating - playerLeagueAnchorRating) * playerLeagueBaselineCoefficient,
    playerLeagueBaselineBounds.min,
    playerLeagueBaselineBounds.max,
  ).toFixed(1))
}

function publishedPlayerRating(rawRating: number, league: string, leagueRatings: Map<string, number>) {
  const baseline = playerBaselineForLeague(league, leagueRatings)
  return Number((baseline + (rawRating - baseline) * playerSignalMultiplierForLeague(league)).toFixed(1))
}

function playerSignalMultiplierForLeague(league: string) {
  return playerLeagueSignalMultiplierByTier[leagueTierFor(league).tier]
}

function statScore(value: number | undefined, baseline: number, spread: number) {
  if (value === undefined || !Number.isFinite(value)) return 0.5
  return clamp(0.5 + (value - baseline) / (2 * spread), 0.05, 0.95)
}

function sourceTraceFor(match: MatchRecord): SourceTrace {
  return {
    provider: match.sourceProvider,
    gameId: match.sourceGameId,
    matchId: match.sourceMatchId,
    url: match.sourceUrl || undefined,
    fileName: match.sourceFileName,
    completeness: match.dataCompleteness,
    date: match.date,
    event: match.event,
  }
}

type PlayerShare = {
  baseShare: number
  playerShare: number
  impactMultiplier: number
  availability: number
  roleCertainty: number
  impactDrivers: {
    objectiveImpactZ: number
    awardResidualZ: number
    recentFormZ: number
  }
}

function playerSharesForRoster(
  roster: PlayerProfile[],
  ratings: Map<string, number>,
  forms: Map<string, string[]>,
) {
  const rawShares = roster.map((player) => {
    const impact = playerImpactFor(player, ratings.get(player.id) ?? initialPlayerRating, forms.get(player.id) ?? [])
    const rawShare = baseRoleShares[player.role] * impact.impactMultiplier * impact.availability * impact.roleCertainty
    return { player, impact, rawShare }
  })
  const total = rawShares.reduce((sum, item) => sum + item.rawShare, 0) || 1

  return new Map(
    rawShares.map(({ player, impact, rawShare }) => [
      player.id,
      {
        ...impact,
        playerShare: rawShare / total,
      },
    ]),
  )
}

function playerImpactFor(player: PlayerProfile, rating: number, form: string[]): Omit<PlayerShare, 'playerShare'> {
  const signals = player.impactSignals ?? {}
  const ratingSignal = clamp((rating - initialPlayerRating) / 24, -2, 2)
  const objectiveImpactZ = clamp((signals.objectiveImpactZ ?? 0) + ratingSignal * 0.35, -3, 3)
  const awardResidualZ = clamp(signals.awardResidualZ ?? 0, -3, 3)
  const recentFormZ = clamp((signals.recentFormZ ?? 0) + formSignal(form), -3, 3)
  const availability = clamp(signals.availability ?? 1, 0, 1)
  const roleCertainty = clamp(signals.roleCertainty ?? 1, 0.5, 1)
  const impactMultiplier = clamp(
    1
      + playerImpactWeights.objectiveImpactZ * objectiveImpactZ
      + playerImpactWeights.awardResidualZ * awardResidualZ
      + playerImpactWeights.recentFormZ * recentFormZ,
    playerImpactMultiplierBounds.min,
    playerImpactMultiplierBounds.max,
  )

  return {
    baseShare: baseRoleShares[player.role],
    impactMultiplier,
    availability,
    roleCertainty,
    impactDrivers: {
      objectiveImpactZ,
      awardResidualZ,
      recentFormZ,
    },
  }
}

function fallbackPlayerShare(player: PlayerProfile): PlayerShare {
  const impact = playerImpactFor(player, initialPlayerRating, [])
  return {
    ...impact,
    playerShare: impact.baseShare,
  }
}

function formSignal(form: string[]) {
  if (form.length === 0) return 0
  const wins = form.filter((result) => result === 'W').length
  return (wins / form.length - 0.5) * 2
}

function teamObjectiveCount(match: MatchRecord, team: 'A' | 'B') {
  if (team === 'A') return (match.teamATowers ?? 0) + (match.teamADragons ?? 0) + (match.teamABarons ?? 0) * 2
  return (match.teamBTowers ?? 0) + (match.teamBDragons ?? 0) + (match.teamBBarons ?? 0) * 2
}

function roundShare(value: number) {
  return Number(value.toFixed(3))
}

function roleOrder(role: Role) {
  return ['Top', 'Jungle', 'Mid', 'Bot', 'Support'].indexOf(role)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
