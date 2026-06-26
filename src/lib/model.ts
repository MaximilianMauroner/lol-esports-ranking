import { eventTierConfig } from '../data/rankingConfig'
import type {
  EventSummary,
  FactorBreakdown,
  LeagueStrength,
  MatchRecord,
  PlayerProfile,
  PlayerStanding,
  Region,
  Role,
  SeasonSummary,
  TeamHistoryPoint,
  TeamProfile,
  TeamStanding,
} from '../types'

const initialTeamRating = 1500
const initialLeagueRating = 1500
const teamEloWeight = 0.8
const leagueEloWeight = 0.2
const initialPlayerRating = 100
const recencyFloor = 0.62
const recencyRange = 0.38
const recencyDecayDays = 180
const normalPatchTeamRetention = 0.985
const splitBreakTeamRetention = 0.92
const seasonStartTeamRetention = 0.8
const splitBreakLeagueRetention = 0.97
const seasonStartLeagueRetention = 0.94
const sideAdjustmentShrinkageGames = 24
const minimumUncertainty = 30
const maximumUncertainty = 140
const executionCap = 0.25
const executionWeights = {
  kills: 0.14,
  gold: 0.72,
  objectives: 0.14,
} as const
const baseRoleShares: Record<Role, number> = {
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
const transparentGprModelVersion = 'transparent-gpr-v0.4.0'
const transparentGprModelParameters = {
  initialTeamRating,
  initialLeagueRating,
  teamEloWeight,
  leagueEloWeight,
  initialPlayerRating,
  recencyFloor,
  recencyRange,
  recencyDecayDays,
  normalPatchTeamRetention,
  splitBreakTeamRetention,
  seasonStartTeamRetention,
  splitBreakLeagueRetention,
  seasonStartLeagueRetention,
  sideAdjustmentShrinkageGames,
  minimumUncertainty,
  maximumUncertainty,
  executionCap,
  executionWeights,
  baseRoleShares,
  playerImpactWeights,
  playerImpactMultiplierBounds,
  eventKFactors: Object.fromEntries(Object.entries(eventTierConfig).map(([tier, config]) => [tier, config.kFactor])),
  leagueKFactors: Object.fromEntries(Object.entries(eventTierConfig).map(([tier, config]) => [tier, config.leagueKFactor])),
} as const
const transparentGprModelConfigHash = stableHash(transparentGprModelParameters)
export const transparentGprModelMetadata = {
  name: 'Transparent GPR',
  version: transparentGprModelVersion,
  configHash: transparentGprModelConfigHash,
  parameters: transparentGprModelParameters,
} as const

const factorLabels: Record<keyof FactorBreakdown, string> = {
  context: 'Context',
  recency: 'Recency',
  execution: 'Result signal',
  opponent: 'Opponent',
  league: 'League strength',
}

export function factorLabel(key: keyof FactorBreakdown) {
  return factorLabels[key]
}

export function buildRankingModel(
  matches: MatchRecord[],
  teams: Record<string, TeamProfile>,
): {
  standings: TeamStanding[]
  leagues: LeagueStrength[]
  events: EventSummary[]
  seasons: SeasonSummary[]
  regions: Region[]
} {
  const sortedMatches = matches.toSorted((a, b) => a.date.localeCompare(b.date))
  const ratings = new Map<string, number>()
  const previousDisplayRatings = new Map<string, number>()
  const wins = new Map<string, number>()
  const losses = new Map<string, number>()
  const forms = new Map<string, string[]>()
  const histories = new Map<string, TeamHistoryPoint[]>()
  const factorSums = new Map<string, FactorBreakdown>()
  const factorCounts = new Map<string, number>()
  const leagueScores = new Map<string, number>()
  const previousLeagueScores = new Map<string, number>()
  const uncertainties = new Map<string, number>()
  const leagueWins = new Map<string, number>()
  const leagueLosses = new Map<string, number>()
  const leagueForms = new Map<string, string[]>()
  const leagueMatchCounts = new Map<string, number>()
  const leagueLastEvents = new Map<string, string>()
  const leagueLastUpdated = new Map<string, string>()
  const lastDate = sortedMatches.at(-1)?.date ?? new Date().toISOString().slice(0, 10)
  const sideAdjustments = buildSideAdjustments(sortedMatches)
  let previousMatch: MatchRecord | undefined

  for (const team of Object.keys(teams)) {
    ratings.set(team, initialTeamRating)
    previousDisplayRatings.set(team, initialTeamRating)
    uncertainties.set(team, maximumUncertainty)
    wins.set(team, 0)
    losses.set(team, 0)
    forms.set(team, [])
    histories.set(team, [])
    factorSums.set(team, { context: 0, recency: 0, execution: 0, opponent: 0, league: 0.5 })
    factorCounts.set(team, 0)
    ensureLeague(teams[team]?.league ?? 'Unknown', leagueScores, previousLeagueScores, leagueWins, leagueLosses, leagueForms, leagueMatchCounts)
  }

  for (const match of sortedMatches) {
    applyContextDecay(match, previousMatch, teams, ratings, leagueScores)
    ensureTeam(match.teamA, teams, ratings, previousDisplayRatings, wins, losses, forms, histories, factorSums, factorCounts)
    ensureTeam(match.teamB, teams, ratings, previousDisplayRatings, wins, losses, forms, histories, factorSums, factorCounts)
    if (!uncertainties.has(match.teamA)) uncertainties.set(match.teamA, maximumUncertainty)
    if (!uncertainties.has(match.teamB)) uncertainties.set(match.teamB, maximumUncertainty)

    const ratingA = ratings.get(match.teamA) ?? initialTeamRating
    const ratingB = ratings.get(match.teamB) ?? initialTeamRating
    const leagueA = homeLeagueForMatch(match, 'A', teams)
    const leagueB = homeLeagueForMatch(match, 'B', teams)
    ensureLeague(leagueA, leagueScores, previousLeagueScores, leagueWins, leagueLosses, leagueForms, leagueMatchCounts)
    ensureLeague(leagueB, leagueScores, previousLeagueScores, leagueWins, leagueLosses, leagueForms, leagueMatchCounts)
    const leagueScoreA = leagueScores.get(leagueA) ?? initialLeagueRating
    const leagueScoreB = leagueScores.get(leagueB) ?? initialLeagueRating
    const powerRatingA = powerRating(ratingA, leagueScoreA)
    const powerRatingB = powerRating(ratingB, leagueScoreB)
    const sideAdjustmentA = sideAdjustmentFor(match, 'A', sideAdjustments)
    const sideAdjustmentB = sideAdjustmentFor(match, 'B', sideAdjustments)
    const effectiveRatingA = powerRatingA + sideAdjustmentA
    const effectiveRatingB = powerRatingB + sideAdjustmentB
    const eventK = eventTierConfig[match.tier].kFactor
    const gameK = gameKFor(match)
    const recency = recencyWeight(match.date, lastDate)
    const expectedA = expectedScore(effectiveRatingA, effectiveRatingB)
    const expectedB = 1 - expectedA
    const aWon = match.winner === match.teamA
    const deltaA = Math.round(gameK * recency * ((aWon ? 1 : 0) - expectedA))
    const deltaB = Math.round(gameK * recency * ((aWon ? 0 : 1) - expectedB))

    previousDisplayRatings.set(match.teamA, powerRatingA)
    previousDisplayRatings.set(match.teamB, powerRatingB)
    ratings.set(match.teamA, ratingA + deltaA)
    ratings.set(match.teamB, ratingB + deltaB)
    uncertainties.set(match.teamA, nextUncertainty(uncertainties.get(match.teamA) ?? maximumUncertainty, match, leagueA, leagueB))
    uncertainties.set(match.teamB, nextUncertainty(uncertainties.get(match.teamB) ?? maximumUncertainty, match, leagueB, leagueA))
    const leagueDelta = updateLeagueStrengthForMatch({
      match,
      leagueA,
      leagueB,
      leagueScoreA,
      leagueScoreB,
      aWon,
      recency,
      leagueScores,
      previousLeagueScores,
      leagueWins,
      leagueLosses,
      leagueForms,
      leagueMatchCounts,
      leagueLastEvents,
      leagueLastUpdated,
    })
    const updatedLeagueScoreA = leagueScores.get(leagueA) ?? initialLeagueRating
    const updatedLeagueScoreB = leagueScores.get(leagueB) ?? initialLeagueRating
    const updatedLeagueAdjustmentA = leagueAdjustment(ratingA + deltaA, updatedLeagueScoreA)
    const updatedLeagueAdjustmentB = leagueAdjustment(ratingB + deltaB, updatedLeagueScoreB)
    const updatedPowerRatingA = powerRating(ratingA + deltaA, updatedLeagueScoreA)
    const updatedPowerRatingB = powerRating(ratingB + deltaB, updatedLeagueScoreB)

    updateRecord(match.teamA, aWon, wins, losses, forms)
    updateRecord(match.teamB, !aWon, wins, losses, forms)
    addFactors(match.teamA, {
      context: normalize(eventK, 12, 34),
      recency,
      execution: aWon ? 1 : 0,
      opponent: normalize(effectiveRatingB, 1350, 1700),
      league: normalize(leagueScoreA + Math.max(0, leagueDelta.deltaA), 1440, 1560),
    }, factorSums, factorCounts)
    addFactors(match.teamB, {
      context: normalize(eventK, 12, 34),
      recency,
      execution: aWon ? 0 : 1,
      opponent: normalize(effectiveRatingA, 1350, 1700),
      league: normalize(leagueScoreB + Math.max(0, leagueDelta.deltaB), 1440, 1560),
    }, factorSums, factorCounts)
    appendHistory(match, match.teamA, match.teamB, updatedPowerRatingA, ratingA + deltaA, updatedLeagueAdjustmentA, sideAdjustmentA, updatedPowerRatingA - powerRatingA, aWon, histories)
    appendHistory(match, match.teamB, match.teamA, updatedPowerRatingB, ratingB + deltaB, updatedLeagueAdjustmentB, sideAdjustmentB, updatedPowerRatingB - powerRatingB, !aWon, histories)
    previousMatch = match
  }

  const displayRatings = makeDisplayRatings(ratings, teams, leagueScores)
  const currentRanks = makeRankMap(displayRatings)
  const previousRankMap = makeRankMap(previousDisplayRatings)
  const leagues = buildLeagueStrengths(teams, leagueScores, previousLeagueScores, leagueWins, leagueLosses, leagueForms, leagueMatchCounts, leagueLastEvents, leagueLastUpdated)

  const standings = Array.from(displayRatings.entries())
    .map(([team, displayRating]) => {
      const profile = teams[team] ?? { name: team, code: team.slice(0, 3).toUpperCase(), region: 'International' as Region, league: 'Unknown' }
      const baseRating = ratings.get(team) ?? initialTeamRating
      const leagueScore = leagueScores.get(profile.league) ?? initialLeagueRating
      const currentLeagueAdjustment = leagueAdjustment(baseRating, leagueScore)
      const priorDisplayRating = previousDisplayRatings.get(team) ?? initialTeamRating
      const factors = averageFactors(factorSums.get(team), factorCounts.get(team) ?? 0)
      const history = histories.get(team) ?? []
      const recentEvents = Array.from(new Set(history.slice(-4).map((point) => point.event))).reverse()
      const rank = currentRanks.get(team) ?? 999
      const previousRank = previousRankMap.get(team) ?? rank

      return {
        team,
        code: profile.code,
        region: profile.region,
        league: profile.league,
        baseRating: Math.round(baseRating),
        leagueScore: Math.round(leagueScore),
        leagueAdjustment: currentLeagueAdjustment,
        leagueDelta: Math.round(leagueScore - (previousLeagueScores.get(profile.league) ?? initialLeagueRating)),
        rating: Math.round(displayRating),
        previousRating: Math.round(priorDisplayRating),
        delta: Math.round(displayRating - priorDisplayRating),
        rank,
        previousRank,
        movement: previousRank - rank,
        wins: wins.get(team) ?? 0,
        losses: losses.get(team) ?? 0,
        confidence: confidenceFor(history, displayRating, standingsSpread(displayRatings)),
        uncertainty: Math.round(uncertainties.get(team) ?? maximumUncertainty),
        form: forms.get(team) ?? [],
        strongestFactor: strongestFactor(factors),
        factors,
        history,
        recentEvents,
      }
    })
    .sort((a, b) => b.rating - a.rating)
    .map((standing, index) => ({ ...standing, rank: index + 1 }))

  return {
    standings,
    leagues,
    events: buildEventSummaries(sortedMatches, histories),
    seasons: buildSeasonSummaries(sortedMatches, standings),
    regions: Array.from(new Set(standings.map((standing) => standing.region))).sort(),
  }
}

export function buildPlayerModel(
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
      const dominance = executionIndex(killsFor, killsAgainst, goldFor, goldAgainst, objectivesFor, objectivesAgainst)
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
    .map(([id, rating]) => {
      const profile = profiles.get(id)
      if (!profile) return null
      const history = histories.get(id) ?? []
      const playerShare = finalShares.get(id) ?? fallbackPlayerShare(profile)
      return {
        id,
        name: profile.name,
        team: profile.team,
        role: profile.role,
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

function ensureTeam(
  team: string,
  teams: Record<string, TeamProfile>,
  ratings: Map<string, number>,
  previousDisplayRatings: Map<string, number>,
  wins: Map<string, number>,
  losses: Map<string, number>,
  forms: Map<string, string[]>,
  histories: Map<string, TeamHistoryPoint[]>,
  factorSums: Map<string, FactorBreakdown>,
  factorCounts: Map<string, number>,
) {
  if (ratings.has(team)) return
  ratings.set(team, initialTeamRating)
  previousDisplayRatings.set(team, initialTeamRating)
  wins.set(team, 0)
  losses.set(team, 0)
  forms.set(team, [])
  histories.set(team, [])
  factorSums.set(team, { context: 0, recency: 0, execution: 0, opponent: 0, league: 0.5 })
  factorCounts.set(team, 0)
  if (!teams[team]) {
    teams[team] = { name: team, code: team.slice(0, 3).toUpperCase(), region: 'International', league: 'Unknown' }
  }
}

function homeLeagueForMatch(match: MatchRecord, side: 'A' | 'B', teams: Record<string, TeamProfile>) {
  const teamName = side === 'A' ? match.teamA : match.teamB
  return (side === 'A' ? match.teamAHomeLeague : match.teamBHomeLeague) ?? teams[teamName]?.league ?? 'Unknown'
}

function buildSideAdjustments(matches: MatchRecord[]) {
  const samples = new Map<string, { blueWins: number; total: number }>()

  for (const match of matches) {
    const blueWon = blueSideWon(match)
    if (blueWon === undefined) continue
    for (const key of [match.patch || 'all', 'all']) {
      const current = samples.get(key) ?? { blueWins: 0, total: 0 }
      samples.set(key, {
        blueWins: current.blueWins + (blueWon ? 1 : 0),
        total: current.total + 1,
      })
    }
  }

  return new Map(
    Array.from(samples.entries()).map(([key, sample]) => {
      const blueWins = sample.blueWins + 0.5
      const redWins = sample.total - sample.blueWins + 0.5
      const rawEdge = (400 / Math.log(10)) * Math.log(blueWins / redWins)
      const shrinkage = sample.total / (sample.total + sideAdjustmentShrinkageGames)
      return [key, rawEdge * shrinkage]
    }),
  )
}

function blueSideWon(match: MatchRecord) {
  if (match.teamASide === 'blue') return match.winner === match.teamA
  if (match.teamBSide === 'blue') return match.winner === match.teamB
  return undefined
}

function sideAdjustmentFor(match: MatchRecord, team: 'A' | 'B', sideAdjustments: Map<string, number>) {
  const side = team === 'A' ? match.teamASide : match.teamBSide
  if (!side) return 0
  const blueEdge = sideAdjustments.get(match.patch) ?? sideAdjustments.get('all') ?? 0
  return side === 'blue' ? blueEdge / 2 : -blueEdge / 2
}

function expectedScore(ratingA: number, ratingB: number) {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400))
}

function executionIndex(killsFor: number, killsAgainst: number, goldFor: number, goldAgainst: number, objectivesFor = 0, objectivesAgainst = 0) {
  const killScore = (killsFor - killsAgainst) / Math.max(killsFor + killsAgainst, 1)
  const goldScore = (goldFor - goldAgainst) / Math.max(goldFor + goldAgainst, 1)
  const objectiveTotal = Math.max(objectivesFor + objectivesAgainst, 1)
  const objectiveScore = (objectivesFor - objectivesAgainst) / objectiveTotal
  return clamp(killScore * executionWeights.kills + goldScore * executionWeights.gold + objectiveScore * executionWeights.objectives, -executionCap, executionCap)
}

function recencyWeight(date: string, lastDate: string) {
  const days = Math.max(0, (Date.parse(lastDate) - Date.parse(date)) / 86_400_000)
  return Number((recencyFloor + recencyRange * Math.exp(-days / recencyDecayDays)).toFixed(3))
}

function applyContextDecay(
  match: MatchRecord,
  previousMatch: MatchRecord | undefined,
  teams: Record<string, TeamProfile>,
  ratings: Map<string, number>,
  leagueScores: Map<string, number>,
) {
  if (!previousMatch) return

  if (match.season !== previousMatch.season) {
    regressAllTeamRatings(teams, ratings, leagueScores, seasonStartTeamRetention)
    regressAllLeagueRatings(leagueScores, seasonStartLeagueRetention)
    return
  }

  if (splitLabel(match.event) !== splitLabel(previousMatch.event)) {
    regressAllTeamRatings(teams, ratings, leagueScores, splitBreakTeamRetention)
    regressAllLeagueRatings(leagueScores, splitBreakLeagueRetention)
    return
  }

  if (match.patch && previousMatch.patch && match.patch !== previousMatch.patch) {
    regressTeamTowardLeague(match.teamA, teams, ratings, leagueScores, normalPatchTeamRetention)
    regressTeamTowardLeague(match.teamB, teams, ratings, leagueScores, normalPatchTeamRetention)
  }
}

function regressAllTeamRatings(
  teams: Record<string, TeamProfile>,
  ratings: Map<string, number>,
  leagueScores: Map<string, number>,
  retention: number,
) {
  for (const team of ratings.keys()) {
    regressTeamTowardLeague(team, teams, ratings, leagueScores, retention)
  }
}

function regressTeamTowardLeague(
  team: string,
  teams: Record<string, TeamProfile>,
  ratings: Map<string, number>,
  leagueScores: Map<string, number>,
  retention: number,
) {
  const rating = ratings.get(team) ?? initialTeamRating
  const league = teams[team]?.league ?? 'Unknown'
  const leagueMean = leagueScores.get(league) ?? initialLeagueRating
  ratings.set(team, leagueMean + retention * (rating - leagueMean))
}

function regressAllLeagueRatings(leagueScores: Map<string, number>, retention: number) {
  for (const [league, rating] of leagueScores.entries()) {
    leagueScores.set(league, initialLeagueRating + retention * (rating - initialLeagueRating))
  }
}

function splitLabel(eventName: string) {
  const match = eventName.match(/\b(Winter|Spring|Summer|Fall|Autumn)\b/i)
  return match?.[1]?.toLowerCase() ?? eventName.toLowerCase()
}

function nextUncertainty(current: number, match: MatchRecord, league: string, opponentLeague: string) {
  const contextSignal = normalize(eventTierConfig[match.tier].kFactor, 12, 34) * 8
  const crossLeagueSignal = league !== opponentLeague && isInternationalMatch(match) ? 7 : 0
  return clamp(current - 5 - contextSignal - crossLeagueSignal, minimumUncertainty, maximumUncertainty)
}

function normalize(value: number, min: number, max: number) {
  return clamp((value - min) / (max - min), 0, 1)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function updateRecord(
  team: string,
  won: boolean,
  wins: Map<string, number>,
  losses: Map<string, number>,
  forms: Map<string, string[]>,
) {
  if (won) wins.set(team, (wins.get(team) ?? 0) + 1)
  else losses.set(team, (losses.get(team) ?? 0) + 1)
  forms.set(team, [...(forms.get(team) ?? []), won ? 'W' : 'L'].slice(-5))
}

function addFactors(
  team: string,
  next: FactorBreakdown,
  factorSums: Map<string, FactorBreakdown>,
  factorCounts: Map<string, number>,
) {
  const current = factorSums.get(team) ?? { context: 0, recency: 0, execution: 0, opponent: 0, league: 0.5 }
  factorSums.set(team, {
    context: current.context + next.context,
    recency: current.recency + next.recency,
    execution: current.execution + next.execution,
    opponent: current.opponent + next.opponent,
    league: current.league + next.league,
  })
  factorCounts.set(team, (factorCounts.get(team) ?? 0) + 1)
}

function appendHistory(
  match: MatchRecord,
  team: string,
  opponent: string,
  rating: number,
  baseRating: number,
  teamLeagueAdjustment: number,
  sideAdjustment: number,
  delta: number,
  won: boolean,
  histories: Map<string, TeamHistoryPoint[]>,
) {
  const snapshotRanks = makeRankMap(new Map([[team, rating], [opponent, rating - delta]]))
  histories.set(team, [
    ...(histories.get(team) ?? []),
    {
      date: match.date,
      event: match.event,
      opponent,
      rating: Math.round(rating),
      baseRating: Math.round(baseRating),
      leagueAdjustment: teamLeagueAdjustment,
      sideAdjustment,
      rank: snapshotRanks.get(team) ?? 1,
      delta: Math.round(delta),
      tier: match.tier,
      result: won ? 'W' : 'L',
      source: {
        provider: match.sourceProvider,
        gameId: match.sourceGameId,
        matchId: match.sourceMatchId,
        url: match.sourceUrl,
        fileName: match.sourceFileName,
        completeness: match.dataCompleteness,
      },
    },
  ])
}

function averageFactors(sum?: FactorBreakdown, count = 0): FactorBreakdown {
  if (!sum || count === 0) return { context: 0, recency: 0, execution: 0, opponent: 0, league: 0.5 }
  return {
    context: Number((sum.context / count).toFixed(3)),
    recency: Number((sum.recency / count).toFixed(3)),
    execution: Number((sum.execution / count).toFixed(3)),
    opponent: Number((sum.opponent / count).toFixed(3)),
    league: Number((sum.league / count).toFixed(3)),
  }
}

function strongestFactor(factors: FactorBreakdown): keyof FactorBreakdown {
  let strongest: keyof FactorBreakdown = 'context'
  let strongestValue = Number.NEGATIVE_INFINITY
  for (const [factor, value] of Object.entries(factors) as [keyof FactorBreakdown, number][]) {
    if (value > strongestValue) {
      strongest = factor
      strongestValue = value
    }
  }
  return strongest
}

function makeRankMap(ratings: Map<string, number>) {
  return new Map(
    Array.from(ratings.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([team], index) => [team, index + 1]),
  )
}

function makeDisplayRatings(
  ratings: Map<string, number>,
  teams: Record<string, TeamProfile>,
  leagueScores: Map<string, number>,
) {
  return new Map(
    Array.from(ratings.entries()).map(([team, rating]) => {
      const league = teams[team]?.league ?? 'Unknown'
      return [team, powerRating(rating, leagueScores.get(league) ?? initialLeagueRating)]
    }),
  )
}

function ensureLeague(
  league: string,
  leagueScores: Map<string, number>,
  previousLeagueScores: Map<string, number>,
  leagueWins: Map<string, number>,
  leagueLosses: Map<string, number>,
  leagueForms: Map<string, string[]>,
  leagueMatchCounts: Map<string, number>,
) {
  if (leagueScores.has(league)) return
  leagueScores.set(league, initialLeagueRating)
  previousLeagueScores.set(league, initialLeagueRating)
  leagueWins.set(league, 0)
  leagueLosses.set(league, 0)
  leagueForms.set(league, [])
  leagueMatchCounts.set(league, 0)
}

function powerRating(teamRating: number, leagueRating: number) {
  return teamRating * teamEloWeight + leagueRating * leagueEloWeight
}

function leagueAdjustment(teamRating: number, leagueRating: number) {
  return Math.round(powerRating(teamRating, leagueRating) - teamRating)
}

function gameKFor(match: MatchRecord) {
  return eventTierConfig[match.tier].kFactor / Math.sqrt(normalizedBestOf(match.bestOf))
}

function normalizedBestOf(bestOf: number) {
  return [1, 2, 3, 5].includes(bestOf) ? bestOf : 1
}

function isInternationalMatch(match: MatchRecord) {
  return match.region === 'International' || ['worlds-playoffs', 'worlds-main', 'msi-bracket', 'msi-play-in', 'minor-international'].includes(match.tier)
}

function updateLeagueStrengthForMatch({
  match,
  leagueA,
  leagueB,
  leagueScoreA,
  leagueScoreB,
  aWon,
  recency,
  leagueScores,
  previousLeagueScores,
  leagueWins,
  leagueLosses,
  leagueForms,
  leagueMatchCounts,
  leagueLastEvents,
  leagueLastUpdated,
}: {
  match: MatchRecord
  leagueA: string
  leagueB: string
  leagueScoreA: number
  leagueScoreB: number
  aWon: boolean
  recency: number
  leagueScores: Map<string, number>
  previousLeagueScores: Map<string, number>
  leagueWins: Map<string, number>
  leagueLosses: Map<string, number>
  leagueForms: Map<string, string[]>
  leagueMatchCounts: Map<string, number>
  leagueLastEvents: Map<string, string>
  leagueLastUpdated: Map<string, string>
}) {
  const leagueKFactor = eventTierConfig[match.tier].leagueKFactor
  if (leagueA === leagueB || leagueA === 'Unknown' || leagueB === 'Unknown' || leagueKFactor === 0 || !isInternationalMatch(match)) {
    return { deltaA: 0, deltaB: 0 }
  }

  const expectedLeagueA = expectedScore(leagueScoreA, leagueScoreB)
  const expectedLeagueB = 1 - expectedLeagueA
  const k = leagueKFactor / Math.sqrt(normalizedBestOf(match.bestOf))
  const deltaA = Math.round(k * recency * ((aWon ? 1 : 0) - expectedLeagueA))
  const deltaB = Math.round(k * recency * ((aWon ? 0 : 1) - expectedLeagueB))

  previousLeagueScores.set(leagueA, leagueScoreA)
  previousLeagueScores.set(leagueB, leagueScoreB)
  leagueScores.set(leagueA, leagueScoreA + deltaA)
  leagueScores.set(leagueB, leagueScoreB + deltaB)
  updateLeagueRecord(leagueA, aWon, match, leagueWins, leagueLosses, leagueForms, leagueMatchCounts, leagueLastEvents, leagueLastUpdated)
  updateLeagueRecord(leagueB, !aWon, match, leagueWins, leagueLosses, leagueForms, leagueMatchCounts, leagueLastEvents, leagueLastUpdated)

  return { deltaA, deltaB }
}

function updateLeagueRecord(
  league: string,
  won: boolean,
  match: MatchRecord,
  leagueWins: Map<string, number>,
  leagueLosses: Map<string, number>,
  leagueForms: Map<string, string[]>,
  leagueMatchCounts: Map<string, number>,
  leagueLastEvents: Map<string, string>,
  leagueLastUpdated: Map<string, string>,
) {
  if (won) leagueWins.set(league, (leagueWins.get(league) ?? 0) + 1)
  else leagueLosses.set(league, (leagueLosses.get(league) ?? 0) + 1)
  leagueForms.set(league, [...(leagueForms.get(league) ?? []), won ? 'W' : 'L'].slice(-6))
  leagueMatchCounts.set(league, (leagueMatchCounts.get(league) ?? 0) + 1)
  leagueLastEvents.set(league, match.event)
  leagueLastUpdated.set(league, match.date)
}

function buildLeagueStrengths(
  teams: Record<string, TeamProfile>,
  leagueScores: Map<string, number>,
  previousLeagueScores: Map<string, number>,
  leagueWins: Map<string, number>,
  leagueLosses: Map<string, number>,
  leagueForms: Map<string, string[]>,
  leagueMatchCounts: Map<string, number>,
  leagueLastEvents: Map<string, string>,
  leagueLastUpdated: Map<string, string>,
): LeagueStrength[] {
  const regionsByLeague = new Map<string, Region>()
  for (const team of Object.values(teams)) {
    regionsByLeague.set(team.league, team.region)
  }

  return Array.from(regionsByLeague.entries())
    .map(([league, region]) => {
      const score = leagueScores.get(league) ?? initialLeagueRating
      const previousScore = previousLeagueScores.get(league) ?? initialLeagueRating

      return {
        league,
        region,
        score: Math.round(score),
        adjustment: Math.round((score - initialLeagueRating) * leagueEloWeight),
        delta: Math.round(score - previousScore),
        wins: leagueWins.get(league) ?? 0,
        losses: leagueLosses.get(league) ?? 0,
        internationalMatches: leagueMatchCounts.get(league) ?? 0,
        form: leagueForms.get(league) ?? [],
        lastEvent: leagueLastEvents.get(league),
        lastUpdated: leagueLastUpdated.get(league),
      }
    })
    .sort((a, b) => b.score - a.score)
}

function confidenceFor(history: TeamHistoryPoint[], rating: number, spread: number) {
  const volume = clamp(history.length / 12, 0, 1)
  const recent = history.slice(-5).length / 5
  const separation = clamp(spread / Math.max(Math.abs(rating - 1500), 80), 0, 1)
  return Math.round((0.45 * volume + 0.35 * recent + 0.2 * separation) * 100)
}

function standingsSpread(ratings: Map<string, number>) {
  const values = Array.from(ratings.values())
  return Math.max(...values) - Math.min(...values)
}

function buildEventSummaries(matches: MatchRecord[], histories: Map<string, TeamHistoryPoint[]>): EventSummary[] {
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

function buildSeasonSummaries(matches: MatchRecord[], standings: TeamStanding[]): SeasonSummary[] {
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

function stableHash(value: unknown) {
  const input = stableStringify(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
