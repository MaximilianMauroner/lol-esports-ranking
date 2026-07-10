import { cappedLeagueRatingForTier, leaguePriorFor, leagueTierFor } from '../data/leagueTiers'
import type {
  LeagueStrength,
  LeagueTierName,
  MatchRecord,
  PlayerAppearanceFlag,
  PlayerAppearanceSummary,
  PlayerDiagnostics,
  PlayerGameStats,
  PlayerIndividualResidual,
  PlayerProfile,
  PlayerStanding,
  Role,
  RosterPlayerAppearance,
  Side,
  SourceTrace,
  TeamProfile,
} from '../types'
import { executionIndexFromStats } from './executionResidual'
import {
  eventWeightContextForMatches,
  eventWeightForMatch,
  type EventWeightContext,
} from './eventWeighting'
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
const playerPregameEdgeSoftCap = 40
const playerPregameEdgeCap = 70
const playerPregameEdgeOverflowMultiplier = 0.4
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
const individualResidualMetricVersion = 'individual-residual-v0'
const individualResidualStrengthProxyWeight = 0.28
const individualResidualScoreScale = 100
const individualResidualMinimumRankedGames = minimumRankedSourcedPlayerGames
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
  playerPregameEdgeSoftCap,
  playerPregameEdgeCap,
  playerPregameEdgeOverflowMultiplier,
  playerPregameMinCoverage,
  playerPregameMinGames,
  minimumRankedSourcedPlayerGames,
  baseRoleShares,
  playerImpactWeights,
  playerImpactMultiplierBounds,
  sourcedPerformanceWeights,
  individualResidualMetricVersion,
  individualResidualStrengthProxyWeight,
  individualResidualScoreScale,
  individualResidualMinimumRankedGames,
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
  eventWeightContext?: EventWeightContext
}

export function buildPlayerModel(
  matches: MatchRecord[],
  rosters: Record<string, PlayerProfile[]>,
  context: PlayerRatingContext = {},
): PlayerStanding[] {
  const resolvedContext = {
    ...context,
    eventWeightContext: context.eventWeightContext ?? eventWeightContextForMatches(matches),
  }
  if (hasObservedPlayerStats(matches)) {
    return buildSourcedPlayerModel(matches, resolvedContext)
  }

  return buildStaticRosterPlayerModel(matches, rosters, resolvedContext.eventWeightContext)
}

function buildStaticRosterPlayerModel(
  matches: MatchRecord[],
  rosters: Record<string, PlayerProfile[]>,
  eventWeightContext: EventWeightContext,
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
      const eventWeight = eventWeightForMatch(match, eventWeightContext)
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
  const residualControlModel = buildIndividualResidualControlModel(sortedMatches, context, leagueRatings)

  for (const dateMatches of matchesByDate(sortedMatches)) {
    for (const match of dateMatches) {
      registerSourcedRosters(match, state, context, leagueRatings)
    }
    applySourcedPlayerUpdates(dateMatches, state, new Map(state.ratings), context, leagueRatings, latestRosterByTeam, residualControlModel)
  }

  for (const roster of latestRosterByTeam.values()) {
    const shares = playerSharesForRoster(roster, state.ratings, state.forms)
    for (const player of roster) {
      finalShares.set(player.id, shares.get(player.id) ?? fallbackPlayerShare(player))
    }
  }

  const players = Array.from(state.ratings.entries())
    .map(([id, rating]): PlayerStanding | null => {
      const profile = state.profiles.get(id)
      if (!profile) return null
      const history = histories.get(id) ?? []
      const playerShare = finalShares.get(id) ?? fallbackPlayerShare(profile)
      const league = leagueForProfile(profile, context)
      const rolePowerRating = publishedPlayerRating(rating, league, leagueRatings)
      return {
        id,
        name: profile.name,
        team: profile.team,
        role: profile.role,
        games: history.length,
        ratingBasis: 'sourced-player-stats' as const,
        rating: rolePowerRating,
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
        diagnostics: diagnosticsSummaryFor(id, state),
        individualResidual: individualResidualSummaryFor(id, profile, rolePowerRating, state),
      }
    })
    .filter((player): player is PlayerStanding => player !== null)
    .filter((player) => player.games > 0)

  return assignPlayerRanks(players)
}

function assignPlayerRanks(players: PlayerStanding[]) {
  const rolePowerSorted = players.toSorted((a, b) => b.rating - a.rating)
  const rolePowerRanks = new Map(rolePowerSorted.map((player, index) => [player.id, index + 1]))
  const residualSorted = players
    .filter((player) =>
      player.individualResidual
      && player.individualResidual.sampleGames >= individualResidualMinimumRankedGames,
    )
    .toSorted((left, right) =>
      (right.individualResidual?.score ?? -Infinity) - (left.individualResidual?.score ?? -Infinity)
      || right.games - left.games
      || left.name.localeCompare(right.name),
    )
  const residualRanks = new Map(residualSorted.map((player, index) => [player.id, index + 1]))

  return rolePowerSorted
    .sort((a, b) => b.rating - a.rating)
    .map((player, index) => {
      const rolePowerRank = rolePowerRanks.get(player.id) ?? index + 1
      const residualRank = residualRanks.get(player.id)
      return {
        ...player,
        rank: index + 1,
        individualResidual: player.individualResidual
          ? {
              ...player.individualResidual,
              rank: residualRank,
              rolePowerRank,
              rankDelta: residualRank ? rolePowerRank - residualRank : undefined,
            }
          : undefined,
      }
    })
}

export function buildPregamePlayerRatingEdges(
  matches: MatchRecord[],
  context: PlayerRatingContext = {},
): Map<string, PregamePlayerRatingEdge> {
  const resolvedContext = {
    ...context,
    eventWeightContext: context.eventWeightContext ?? eventWeightContextForMatches(matches),
  }
  const state = createSourcedPlayerState(false)
  const edges = new Map<string, PregamePlayerRatingEdge>()
  const leagueRatings = leagueRatingsFor(resolvedContext.leagueStrengths)
  const sortedMatches = matches.toSorted((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))

  for (const dateMatches of matchesByDate(sortedMatches)) {
    const dateStartRatings = new Map(state.ratings)
    const dateStartGames = new Map(state.games)

    for (const match of dateMatches) {
      const teamAEdge = playerEdgeForRoster(
        match.teamARoster,
        dateStartRatings,
        dateStartGames,
        leagueForSide(match, 'A', resolvedContext),
        leagueRatings,
      )
      const teamBEdge = playerEdgeForRoster(
        match.teamBRoster,
        dateStartRatings,
        dateStartGames,
        leagueForSide(match, 'B', resolvedContext),
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
      registerSourcedRosters(match, state, resolvedContext, leagueRatings)
    }
    applySourcedPlayerUpdates(dateMatches, state, dateStartRatings, resolvedContext, leagueRatings)
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
  diagnostics?: Map<string, PlayerDiagnosticsAccumulator>
  individualResiduals?: Map<string, PlayerIndividualResidualAccumulator>
}

type PlayerAppearanceAccumulator = {
  teamGames: Map<string, { team: string; games: number; latestObservedAt?: string; latestObservedEvent?: string }>
  roleGames: Map<Role, number>
}

type DiagnosticAverageAccumulator = {
  total: number
  games: number
  missing: number
}

type PlayerDiagnosticsAccumulator = {
  sampleGames: number
  wins: number
  losses: number
  noWinStatScore: DiagnosticAverageAccumulator
  sameRoleMatchupDiff: DiagnosticAverageAccumulator
  damageShare: DiagnosticAverageAccumulator
  earnedGoldShare: DiagnosticAverageAccumulator
  kda: DiagnosticAverageAccumulator
  visionScore: DiagnosticAverageAccumulator
  vspm: DiagnosticAverageAccumulator
}

type IndividualResidualControlModel = {
  global: DiagnosticAverageAccumulator
  role: Map<Role, DiagnosticAverageAccumulator>
  roleLeague: Map<string, DiagnosticAverageAccumulator>
  roleSide: Map<string, DiagnosticAverageAccumulator>
  rolePatch: Map<string, DiagnosticAverageAccumulator>
  roleTier: Map<string, DiagnosticAverageAccumulator>
}

type PlayerIndividualResidualAccumulator = {
  sampleGames: number
  adjustedSameRoleDiff: DiagnosticAverageAccumulator
  expectedNoWinStatScore: DiagnosticAverageAccumulator
  opponentStrengthProxy: DiagnosticAverageAccumulator
  noWinStatScore: DiagnosticAverageAccumulator
  sameRoleMatchupDiff: DiagnosticAverageAccumulator
  wins: number
  losses: number
  leagueGames: Map<string, number>
  sideGames: Map<Side, number>
  patchGames: Map<string, number>
  eventTierGames: Map<MatchRecord['tier'], number>
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
    diagnostics: includeAuditFields ? new Map() : undefined,
    individualResiduals: includeAuditFields ? new Map() : undefined,
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
  residualControlModel?: IndividualResidualControlModel,
) {
  for (const match of matches) {
    for (const { side, team, opponent, roster, opponentRoster, opponentSide } of teamRosterEntries(match)) {
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
        const opponentPlayer = opponentRoster.players.find((candidate) => candidate.role === player.role)
        if (!opponentPlayer?.stats) continue
        const rating = preUpdateRatings.get(player.id) ?? leagueBaseline
        const opponentRating = preUpdateRatings.get(opponentPlayer.id) ?? opponentLeagueBaseline
        const expected = expectedPlayerScore(rating, opponentRating)
        const performance = playerPerformance(player, opponentPlayer)
        const eventWeight = eventWeightForMatch(match, context.eventWeightContext)
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
            opponent,
            playerTeam: team,
            result: player.stats.won ? 'W' : 'L',
            bestOf: match.bestOf,
            teamKills: side === 'A' ? match.teamAKills : match.teamBKills,
            opponentKills: side === 'A' ? match.teamBKills : match.teamAKills,
            source: sourceTraceFor(match),
            rating: nextPublishedRating,
            delta: Number((nextPublishedRating - currentPublishedRating).toFixed(1)),
          },
        ])
        state.sources?.set(player.id, sourceTraceFor(match))
        recordPlayerDiagnostics(player.id, player, opponentPlayer, state)
        recordIndividualResidual(
          player.id,
          profile,
          player,
          opponentPlayer,
          match,
          league,
          opponentLeague,
          preUpdateRatings,
          leagueRatings,
          state,
          residualControlModel,
        )
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

function recordPlayerDiagnostics(
  playerId: string,
  player: RosterPlayerAppearance,
  opponent: RosterPlayerAppearance,
  state: SourcedPlayerState,
) {
  if (!state.diagnostics) return
  const stats = player.stats
  const current = state.diagnostics.get(playerId) ?? createPlayerDiagnosticsAccumulator()
  current.sampleGames += 1
  if (stats?.won) current.wins += 1
  else current.losses += 1

  recordDiagnosticValue(current.damageShare, stats?.damageShare)
  recordDiagnosticValue(current.earnedGoldShare, stats?.earnedGoldShare)
  recordDiagnosticValue(current.kda, stats ? kdaFor(stats) : undefined)
  recordDiagnosticValue(current.visionScore, stats?.visionScore)
  recordDiagnosticValue(current.vspm, stats?.vspm)

  const noWinScore = noWinStatScoreFor(player)
  const opponentNoWinScore = noWinStatScoreFor(opponent)
  recordDiagnosticValue(current.noWinStatScore, noWinScore)
  recordDiagnosticValue(
    current.sameRoleMatchupDiff,
    noWinScore === undefined || opponentNoWinScore === undefined ? undefined : noWinScore - opponentNoWinScore,
  )

  state.diagnostics.set(playerId, current)
}

function createPlayerDiagnosticsAccumulator(): PlayerDiagnosticsAccumulator {
  return {
    sampleGames: 0,
    wins: 0,
    losses: 0,
    noWinStatScore: createDiagnosticAverageAccumulator(),
    sameRoleMatchupDiff: createDiagnosticAverageAccumulator(),
    damageShare: createDiagnosticAverageAccumulator(),
    earnedGoldShare: createDiagnosticAverageAccumulator(),
    kda: createDiagnosticAverageAccumulator(),
    visionScore: createDiagnosticAverageAccumulator(),
    vspm: createDiagnosticAverageAccumulator(),
  }
}

function createDiagnosticAverageAccumulator(): DiagnosticAverageAccumulator {
  return { total: 0, games: 0, missing: 0 }
}

function recordDiagnosticValue(accumulator: DiagnosticAverageAccumulator, value: number | undefined) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    accumulator.total += value
    accumulator.games += 1
    return
  }
  accumulator.missing += 1
}

function diagnosticsSummaryFor(playerId: string, state: SourcedPlayerState): PlayerDiagnostics | undefined {
  const diagnostics = state.diagnostics?.get(playerId)
  if (!diagnostics || diagnostics.sampleGames === 0) return undefined
  return {
    sourceProvider: 'oracles-elixir',
    scope: 'rated-complete-role-matchups',
    sampleGames: diagnostics.sampleGames,
    wins: diagnostics.wins,
    losses: diagnostics.losses,
    winRate: diagnostics.sampleGames > 0 ? roundDiagnostic(diagnostics.wins / diagnostics.sampleGames, 3) : null,
    noWinStatScore: diagnosticAverage(diagnostics.noWinStatScore, diagnostics.sampleGames, 3),
    sameRoleMatchupDiff: diagnosticAverage(diagnostics.sameRoleMatchupDiff, diagnostics.sampleGames, 3),
    damageShare: diagnosticAverage(diagnostics.damageShare, diagnostics.sampleGames, 3),
    earnedGoldShare: diagnosticAverage(diagnostics.earnedGoldShare, diagnostics.sampleGames, 3),
    kda: diagnosticAverage(diagnostics.kda, diagnostics.sampleGames, 2),
    visionScore: diagnosticAverage(diagnostics.visionScore, diagnostics.sampleGames, 1),
    vspm: diagnosticAverage(diagnostics.vspm, diagnostics.sampleGames, 2),
  }
}

function diagnosticAverage(
  accumulator: DiagnosticAverageAccumulator,
  sampleGames: number,
  decimals: number,
): PlayerDiagnostics['damageShare'] {
  return {
    value: accumulator.games > 0 ? roundDiagnostic(accumulator.total / accumulator.games, decimals) : null,
    games: accumulator.games,
    missing: Math.max(accumulator.missing, sampleGames - accumulator.games),
  }
}

function buildIndividualResidualControlModel(
  matches: MatchRecord[],
  context: PlayerRatingContext,
  leagueRatings: Map<string, number>,
): IndividualResidualControlModel {
  const model: IndividualResidualControlModel = {
    global: createDiagnosticAverageAccumulator(),
    role: new Map(),
    roleLeague: new Map(),
    roleSide: new Map(),
    rolePatch: new Map(),
    roleTier: new Map(),
  }

  for (const match of matches) {
    for (const { side, roster, opponentRoster } of teamRosterEntries(match)) {
      if (!roster || !opponentRoster || !isCompleteSourcedMatchup(roster, opponentRoster)) continue
      const league = leagueForSide(match, side, context)
      for (const player of roster.players) {
        const noWinScore = noWinStatScoreFor(player)
        if (noWinScore === undefined) continue
        recordDiagnosticValue(model.global, noWinScore)
        recordDiagnosticValue(controlBucket(model.role, player.role), noWinScore)
        recordDiagnosticValue(controlBucket(model.roleLeague, residualControlKey(player.role, league)), noWinScore)
        recordDiagnosticValue(controlBucket(model.roleSide, residualControlKey(player.role, player.stats?.side ?? 'unknown')), noWinScore)
        recordDiagnosticValue(controlBucket(model.rolePatch, residualControlKey(player.role, patchBucket(match.patch))), noWinScore)
        recordDiagnosticValue(controlBucket(model.roleTier, residualControlKey(player.role, match.tier)), noWinScore)
      }
    }
  }

  if (model.global.games === 0) {
    recordDiagnosticValue(model.global, 0.5)
  }

  // Touch league ratings here so the model signature makes the league-strength dependency explicit.
  void leagueRatings

  return model
}

function controlBucket<K>(map: Map<K, DiagnosticAverageAccumulator>, key: K) {
  const current = map.get(key) ?? createDiagnosticAverageAccumulator()
  map.set(key, current)
  return current
}

function residualControlBaseline(
  model: IndividualResidualControlModel,
  role: Role,
  league: string,
  side: Side | undefined,
  patch: string,
  tier: MatchRecord['tier'],
) {
  const fallback = diagnosticMean(model.role.get(role)) ?? diagnosticMean(model.global) ?? 0.5
  const components = [
    { value: fallback, weight: 0.35 },
    { value: diagnosticMean(model.roleLeague.get(residualControlKey(role, league))) ?? fallback, weight: 0.25 },
    { value: diagnosticMean(model.roleSide.get(residualControlKey(role, side ?? 'unknown'))) ?? fallback, weight: 0.1 },
    { value: diagnosticMean(model.rolePatch.get(residualControlKey(role, patchBucket(patch)))) ?? fallback, weight: 0.15 },
    { value: diagnosticMean(model.roleTier.get(residualControlKey(role, tier))) ?? fallback, weight: 0.15 },
  ]
  const totalWeight = components.reduce((total, component) => total + component.weight, 0)
  return components.reduce((total, component) => total + component.value * component.weight, 0) / totalWeight
}

function diagnosticMean(accumulator: DiagnosticAverageAccumulator | undefined) {
  if (!accumulator || accumulator.games === 0) return undefined
  return accumulator.total / accumulator.games
}

function residualControlKey(...parts: Array<string | number>) {
  return parts.join('\u0000')
}

function patchBucket(patch: string) {
  const [major, minor] = patch.split('.')
  if (!major) return 'unknown'
  return minor ? `${major}.${minor}` : major
}

function recordIndividualResidual(
  playerId: string,
  profile: PlayerProfile,
  player: RosterPlayerAppearance,
  opponent: RosterPlayerAppearance,
  match: MatchRecord,
  league: string,
  opponentLeague: string,
  preUpdateRatings: Map<string, number>,
  leagueRatings: Map<string, number>,
  state: SourcedPlayerState,
  controlModel: IndividualResidualControlModel | undefined,
) {
  if (!state.individualResiduals || !controlModel) return
  const noWinScore = noWinStatScoreFor(player)
  const opponentNoWinScore = noWinStatScoreFor(opponent)
  if (noWinScore === undefined || opponentNoWinScore === undefined) return

  const playerBaseline = playerBaselineForLeague(league, leagueRatings)
  const opponentBaseline = playerBaselineForLeague(opponentLeague, leagueRatings)
  const rating = preUpdateRatings.get(player.id) ?? playerBaseline
  const opponentRating = preUpdateRatings.get(opponent.id) ?? opponentBaseline
  const expected = residualControlBaseline(controlModel, player.role, league, player.stats?.side, match.patch, match.tier)
  const opponentExpected = residualControlBaseline(controlModel, opponent.role, opponentLeague, opponent.stats?.side, match.patch, match.tier)
  const sameRoleDiff = noWinScore - opponentNoWinScore
  const strengthProxy = (expectedPlayerScore(rating, opponentRating) - 0.5) * individualResidualStrengthProxyWeight
  const adjustedSameRoleDiff = sameRoleDiff - ((expected - opponentExpected) + strengthProxy)
  const current = state.individualResiduals.get(playerId) ?? createPlayerIndividualResidualAccumulator()

  current.sampleGames += 1
  if (player.stats?.won) current.wins += 1
  else current.losses += 1
  recordDiagnosticValue(current.adjustedSameRoleDiff, adjustedSameRoleDiff)
  recordDiagnosticValue(current.expectedNoWinStatScore, expected)
  recordDiagnosticValue(current.opponentStrengthProxy, strengthProxy)
  recordDiagnosticValue(current.noWinStatScore, noWinScore)
  recordDiagnosticValue(current.sameRoleMatchupDiff, sameRoleDiff)
  current.leagueGames.set(league, (current.leagueGames.get(league) ?? 0) + 1)
  if (player.stats?.side) current.sideGames.set(player.stats.side, (current.sideGames.get(player.stats.side) ?? 0) + 1)
  current.patchGames.set(patchBucket(match.patch), (current.patchGames.get(patchBucket(match.patch)) ?? 0) + 1)
  current.eventTierGames.set(match.tier, (current.eventTierGames.get(match.tier) ?? 0) + 1)
  state.individualResiduals.set(playerId, current)

  void profile
}

function createPlayerIndividualResidualAccumulator(): PlayerIndividualResidualAccumulator {
  return {
    sampleGames: 0,
    wins: 0,
    losses: 0,
    adjustedSameRoleDiff: createDiagnosticAverageAccumulator(),
    expectedNoWinStatScore: createDiagnosticAverageAccumulator(),
    opponentStrengthProxy: createDiagnosticAverageAccumulator(),
    noWinStatScore: createDiagnosticAverageAccumulator(),
    sameRoleMatchupDiff: createDiagnosticAverageAccumulator(),
    leagueGames: new Map(),
    sideGames: new Map(),
    patchGames: new Map(),
    eventTierGames: new Map(),
  }
}

function individualResidualSummaryFor(
  playerId: string,
  profile: PlayerProfile,
  rolePowerRating: number,
  state: SourcedPlayerState,
): PlayerIndividualResidual | undefined {
  const residual = state.individualResiduals?.get(playerId)
  if (!residual || residual.sampleGames === 0) return undefined
  const adjusted = diagnosticAverage(residual.adjustedSameRoleDiff, residual.sampleGames, 3)
  const adjustedValue = adjusted.value ?? 0
  const confidence = roundDiagnostic(100 * Math.min(1, residual.sampleGames / 60) * (adjusted.games / residual.sampleGames), 1)
  return {
    sourceProvider: 'oracles-elixir',
    metricVersion: individualResidualMetricVersion,
    scope: 'shadow-rated-complete-role-matchups',
    score: Number(clamp(100 + adjustedValue * individualResidualScoreScale, 40, 160).toFixed(1)),
    confidence,
    sampleGames: residual.sampleGames,
    adjustedSameRoleDiff: adjusted,
    expectedNoWinStatScore: diagnosticAverage(residual.expectedNoWinStatScore, residual.sampleGames, 3),
    opponentStrengthProxy: diagnosticAverage(residual.opponentStrengthProxy, residual.sampleGames, 3),
    controls: {
      role: profile.role,
      primaryLeague: primaryMapKey(residual.leagueGames) ?? 'Unknown',
      leagueGames: Math.max(...residual.leagueGames.values(), 0),
      sideGames: Object.fromEntries(residual.sideGames.entries()),
      patchCount: residual.patchGames.size,
      eventTierCounts: Object.fromEntries(residual.eventTierGames.entries()),
    },
    explanation: {
      noWinStatScore: diagnosticAverage(residual.noWinStatScore, residual.sampleGames, 3),
      sameRoleMatchupDiff: diagnosticAverage(residual.sameRoleMatchupDiff, residual.sampleGames, 3),
      rolePowerRating,
      teamWinRate: residual.sampleGames > 0 ? roundDiagnostic(residual.wins / residual.sampleGames, 3) : null,
    },
  }
}

function primaryMapKey<K>(map: Map<K, number>) {
  return Array.from(map.entries())
    .toSorted((left, right) => right[1] - left[1])
    .at(0)?.[0]
}

function noWinStatScoreFor(player: RosterPlayerAppearance) {
  const stats = player.stats
  if (!stats) return undefined
  const baseline = roleStatBaselines[player.role]
  const parts = [
    diagnosticScorePart(sourcedPerformanceWeights.damageShare, stats.damageShare, baseline.damageShare, 0.12),
    diagnosticScorePart(sourcedPerformanceWeights.earnedGoldShare, stats.earnedGoldShare, baseline.earnedGoldShare, 0.1),
    { weight: sourcedPerformanceWeights.kda, score: statScore(kdaFor(stats), baseline.kda, 4) },
    diagnosticScorePart(sourcedPerformanceWeights.vision, stats.vspm, baseline.vspm, 1.8),
  ].filter((part): part is { weight: number; score: number } => Boolean(part))
  const totalWeight = parts.reduce((total, part) => total + part.weight, 0)
  if (totalWeight <= 0) return undefined
  return parts.reduce((total, part) => total + part.weight * part.score, 0) / totalWeight
}

function diagnosticScorePart(weight: number, value: number | undefined, baseline: number, spread: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return { weight, score: statScore(value, baseline, spread) }
}

function teamRosterEntries(match: MatchRecord) {
  return [
    { side: 'A', opponentSide: 'B', team: match.teamA, opponent: match.teamB, roster: match.teamARoster, opponentRoster: match.teamBRoster },
    { side: 'B', opponentSide: 'A', team: match.teamB, opponent: match.teamA, roster: match.teamBRoster, opponentRoster: match.teamARoster },
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
  const adjustment = cappedPlayerPregameEdge(playerPregameEdgeCoefficient * weightedMeanEdge * coverage)

  return {
    adjustment: Number(adjustment.toFixed(1)),
    coverage: roundShare(coverage),
  }
}

function cappedPlayerPregameEdge(value: number) {
  const magnitude = Math.abs(value)
  if (magnitude <= playerPregameEdgeSoftCap) return value

  const expandedMagnitude = playerPregameEdgeSoftCap
    + (magnitude - playerPregameEdgeSoftCap) * playerPregameEdgeOverflowMultiplier
  return Math.sign(value) * Math.min(expandedMagnitude, playerPregameEdgeCap)
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

  return clamp(
    sourcedPerformanceWeights.win * (stats.won ? 1 : 0)
      + sourcedPerformanceWeights.damageShare * statScore(stats.damageShare, baseline.damageShare, 0.12)
      + sourcedPerformanceWeights.earnedGoldShare * statScore(stats.earnedGoldShare, baseline.earnedGoldShare, 0.1)
      + sourcedPerformanceWeights.kda * statScore(kdaFor(stats), baseline.kda, 4)
      + sourcedPerformanceWeights.vision * statScore(stats.vspm, baseline.vspm, 1.8),
    0,
    1,
  )
}

function kdaFor(stats: PlayerGameStats) {
  return (stats.kills + stats.assists) / Math.max(1, stats.deaths)
}

function roundDiagnostic(value: number, decimals: number) {
  return Number(value.toFixed(decimals))
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
    bestOf: match.bestOf,
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
