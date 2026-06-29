import { effectiveLeagueRating, leaguePriorFor, leagueTierFor } from '../data/leagueTiers'
import type {
  EventSummary,
  FactorBreakdown,
  LeagueStrengthHistoryPoint,
  LeagueStrength,
  MatchRecord,
  PregamePrediction,
  Region,
  RosterBasis,
  SeasonSummary,
  TeamHistoryPoint,
  TeamProfile,
  TeamStanding,
} from '../types'
import { evaluateTeamEligibility, matchLevelEligibilityHistory } from './eligibility'
import { ensureLeague } from './leagueRatings'
import { homeLeagueForMatch, matchesByDate } from './matchContext'
import { buildEventSummaries, buildLeagueStrengths, buildSeasonSummaries } from './modelSummaries'
import { buildPregamePlayerRatingEdges } from './playerModel'
import {
  applyCompletedPlacementResiduals,
  startEventTrackersForDate,
} from './placementResiduals'
import { applyContextDecayToRatingChannels } from './ratingContext'
import {
  applyMomentumBoundaryDecay,
  clamp,
  emptyRatingUpdateLedger,
  leagueAdjustment,
  publishedLeagueAnchorContextAdjustment,
  publishedRosterPriorOffset,
  ratingComponents,
  ratingFromComponents,
} from './ratingCalculations'
import { createRatingRunState, ensureMatchRunEntities } from './ratingRunState'
import { emitPregamePredictionsForDate, processRatingSeriesForDate } from './ratingSeriesEngine'
import { applyRosterContinuityForDate, roundedContinuity } from './rosterContinuityRating'
import { rosterBasisByTeam } from './rosters'
import { sideAdjustmentsFromSamples } from './sideAdjustments'
import {
  directHeadToHeadContextConfig,
  initialLeagueRating,
  initialTeamRating,
  leagueEloWeight,
  maximumUncertainty,
  normalPatchTeamRetention,
  recencyDecayDays,
  recencyFloor,
  recencyRange,
  seasonStartLeagueRetention,
  seasonStartTeamRetention,
  splitBreakLeagueRetention,
  splitBreakMinimumGapDays,
  splitBreakTeamRetention,
} from './modelConfig'

export { buildPlayerModel } from './playerModel'
export { factorLabel, transparentGprModelMetadata } from './modelConfig'

export function buildRankingModel(
  matches: MatchRecord[],
  teams: Record<string, TeamProfile>,
): {
  standings: TeamStanding[]
  leagues: LeagueStrength[]
  events: EventSummary[]
  seasons: SeasonSummary[]
  regions: Region[]
  leagueHistory: LeagueStrengthHistoryPoint[]
  predictions: PregamePrediction[]
} {
  const sortedMatches = matches.toSorted((a, b) => a.date.localeCompare(b.date))
  const pregamePlayerRatingEdges = buildPregamePlayerRatingEdges(sortedMatches, { teams })
  const teamRosterBasis = rosterBasisByTeam(sortedMatches)
  const state = createRatingRunState(sortedMatches, teams)
  const {
    ratings,
    previousDisplayRatings,
    momentums,
    rosterPriorOffsets,
    latestRatingUpdates,
    leaguePlacementDeltas,
    wins,
    losses,
    forms,
    histories,
    factorSums,
    factorCounts,
    leagueScores,
    previousLeagueScores,
    uncertainties,
    leagueWins,
    leagueLosses,
    leagueExpectedWins,
    leagueOpponentRatingSums,
    leagueForms,
    leagueMatchCounts,
    leagueLastEvents,
    leagueLastUpdated,
    leagueHistory,
    predictions,
    currentRosterContinuity,
    eventTrackers,
  } = state
  const lastDate = sortedMatches.at(-1)?.date ?? new Date().toISOString().slice(0, 10)

  for (const team of Object.keys(teams)) {
    ensureLeague(teams[team]?.league ?? 'Unknown', state.leagueScores, state.previousLeagueScores, state.leagueWins, state.leagueLosses, state.leagueExpectedWins, state.leagueOpponentRatingSums, state.leagueForms, state.leagueMatchCounts)
  }

  for (const dateMatches of matchesByDate(sortedMatches)) {
    const firstMatch = dateMatches[0]
    if (!firstMatch) continue

    applyCompletedPlacementResiduals({
      cutoffDate: firstMatch.date,
      eventTrackers: state.eventTrackers,
      teams,
      ratings: state.ratings,
      leagueScores: state.leagueScores,
      previousLeagueScores: state.previousLeagueScores,
      leagueLastEvents: state.leagueLastEvents,
      leagueLastUpdated: state.leagueLastUpdated,
      leaguePlacementDeltas: state.leaguePlacementDeltas,
      latestRatingUpdates: state.latestRatingUpdates,
    })

    applyContextDecayToRatingChannels(
      firstMatch,
      state.previousMatch,
      teams,
      [state.ratings, state.executionRatings],
      state.leagueScores,
      {
        initialTeamRating,
        recencyFloor,
        recencyRange,
        recencyDecayDays,
        normalPatchTeamRetention,
        splitBreakTeamRetention,
        seasonStartTeamRetention,
        splitBreakLeagueRetention,
        seasonStartLeagueRetention,
        splitBreakMinimumGapDays,
      },
    )
    applyMomentumBoundaryDecay(firstMatch, state.previousMatch, state.momentums)

    for (const match of dateMatches) {
      ensureMatchRunEntities(state, match, teams)
      ensureLeague(homeLeagueForMatch(match, 'A', teams), state.leagueScores, state.previousLeagueScores, state.leagueWins, state.leagueLosses, state.leagueExpectedWins, state.leagueOpponentRatingSums, state.leagueForms, state.leagueMatchCounts)
      ensureLeague(homeLeagueForMatch(match, 'B', teams), state.leagueScores, state.previousLeagueScores, state.leagueWins, state.leagueLosses, state.leagueExpectedWins, state.leagueOpponentRatingSums, state.leagueForms, state.leagueMatchCounts)
    }

    applyRosterContinuityForDate(dateMatches, state.ratings, state.executionRatings, state.uncertainties, state.lastRosterByTeam, state.currentRosterContinuity)
    startEventTrackersForDate(dateMatches, state.eventTrackers, teams, state.ratings, state.momentums, state.rosterPriorOffsets, state.uncertainties, state.leagueScores, state.leagueMatchCounts)

    const sideAdjustments = sideAdjustmentsFromSamples(state.sideAdjustmentSamples)
    emitPregamePredictionsForDate({
      matches: dateMatches,
      teams,
      state,
      pregamePlayerRatingEdges,
      sideAdjustments,
    })

    processRatingSeriesForDate({
      matches: dateMatches,
      teams,
      state,
      sideAdjustments,
      lastDate,
    })
  }

  applyCompletedPlacementResiduals({
    cutoffDate: undefined,
    eventTrackers,
    teams,
    ratings,
    leagueScores,
    previousLeagueScores,
    leagueLastEvents,
    leagueLastUpdated,
    leaguePlacementDeltas,
    latestRatingUpdates,
  })

  const preliminaryDisplayRatings = makeDisplayRatings(ratings, teams, leagueScores, leagueMatchCounts, rosterPriorOffsets, momentums, uncertainties, wins, losses, teamRosterBasis)
  const directHeadToHeadContextAdjustments = makeDirectHeadToHeadContextAdjustments({
    displayRatings: preliminaryDisplayRatings,
    teams,
    histories,
    uncertainties,
    wins,
    losses,
    teamRosterBasis,
    lastDate,
  })
  const displayRatings = makeDisplayRatings(ratings, teams, leagueScores, leagueMatchCounts, rosterPriorOffsets, momentums, uncertainties, wins, losses, teamRosterBasis, directHeadToHeadContextAdjustments)
  const currentRanks = makeRankMap(displayRatings)
  const previousRankMap = makeRankMap(previousDisplayRatings)
  const leagues = buildLeagueStrengths(
    teams,
    leagueScores,
    previousLeagueScores,
    leagueWins,
    leagueLosses,
    leagueExpectedWins,
    leagueOpponentRatingSums,
    leagueForms,
    leagueMatchCounts,
    leagueLastEvents,
    leagueLastUpdated,
    { initialLeagueRating, leagueEloWeight },
  )

  const standings = Array.from(displayRatings.entries())
    .map(([team, displayRating]) => {
      const profile = teams[team] ?? { name: team, code: team.slice(0, 3).toUpperCase(), region: 'International' as Region, league: 'Unknown' }
      const baseRating = ratings.get(team) ?? initialTeamRating
      const leagueTier = leagueTierFor(profile.league)
      const leagueScore = effectiveLeagueRating(profile.league, leagueScores.get(profile.league) ?? leagueTier.priorRating, leagueMatchCounts.get(profile.league) ?? 0)
      const previousLeagueScore = effectiveLeagueRating(profile.league, previousLeagueScores.get(profile.league) ?? leagueTier.priorRating, leagueMatchCounts.get(profile.league) ?? 0)
      const currentLeagueAdjustment = leagueAdjustment(baseRating, leagueScore)
      const rosterPriorOffset = publishedRosterPriorOffset(
        rosterPriorOffsets.get(team) ?? 0,
        wins.get(team) ?? 0,
        losses.get(team) ?? 0,
      )
      const uncertainty = Math.round(uncertainties.get(team) ?? maximumUncertainty)
      const contextAdjustment = publishedLeagueAnchorContextAdjustment({
        leagueScore,
        teamRating: baseRating,
        wins: wins.get(team) ?? 0,
        losses: losses.get(team) ?? 0,
        uncertainty,
        rosterBasis: teamRosterBasis.get(team),
      }) + (directHeadToHeadContextAdjustments.get(team) ?? 0)
      const components = ratingComponents({
        teamRating: baseRating,
        leagueScore,
        rosterPriorOffset,
        momentum: momentums.get(team) ?? 0,
        contextAdjustment,
        uncertainty,
      })
      const priorDisplayRating = previousDisplayRatings.get(team) ?? initialTeamRating
      const factors = averageFactors(factorSums.get(team), factorCounts.get(team) ?? 0)
      const history = histories.get(team) ?? []
      const recentEvents = Array.from(new Set(history.slice(-4).map((point) => point.event))).reverse()
      const eligibilityHistory = matchLevelEligibilityHistory(history)
      const rank = currentRanks.get(team) ?? 999
      const previousRank = previousRankMap.get(team) ?? rank

      return {
        team,
        code: profile.code,
        region: profile.region,
        league: profile.league,
        rosterBasis: teamRosterBasis.get(team) ?? 'unknown',
        rosterContinuity: roundedContinuity(currentRosterContinuity.get(team)),
        baseRating: Math.round(baseRating),
        leagueScore: Math.round(leagueScore),
        leagueAdjustment: currentLeagueAdjustment,
        leagueDelta: Math.round(leagueScore - previousLeagueScore),
        ratingComponents: components,
        ratingUpdate: latestRatingUpdates.get(team) ?? emptyRatingUpdateLedger(),
        rating: Math.round(displayRating),
        previousRating: Math.round(priorDisplayRating),
        delta: Math.round(displayRating - priorDisplayRating),
        rank,
        previousRank,
        movement: previousRank - rank,
        wins: wins.get(team) ?? 0,
        losses: losses.get(team) ?? 0,
        confidence: confidenceFor(history, displayRating, standingsSpread(displayRatings)),
        uncertainty,
        form: forms.get(team) ?? [],
        strongestFactor: strongestFactor(factors),
        eligibility: evaluateTeamEligibility({
          history: eligibilityHistory,
          lastDate,
          uncertainty,
          leagueTier: leagueTier.tier,
          leagueInternationalMatches: leagueMatchCounts.get(profile.league) ?? 0,
          isDevelopmentalTeam: isDevelopmentalTeamName(team),
        }),
        factors,
        history,
        recentEvents,
      }
    })
    .sort((a, b) => Number(b.eligibility.eligible) - Number(a.eligibility.eligible) || b.rating - a.rating)
    .map((standing, index) => ({ ...standing, rank: index + 1 }))

  return {
    standings,
    leagues,
    events: buildEventSummaries(sortedMatches, histories),
    seasons: buildSeasonSummaries(sortedMatches, standings),
    regions: Array.from(new Set(standings.map((standing) => standing.region))).sort(),
    leagueHistory,
    predictions,
  }
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

type DirectHeadToHeadContextInput = {
  displayRatings: Map<string, number>
  teams: Record<string, TeamProfile>
  histories: Map<string, TeamHistoryPoint[]>
  uncertainties: Map<string, number>
  wins: Map<string, number>
  losses: Map<string, number>
  teamRosterBasis: Map<string, RosterBasis>
  lastDate: string
}

function makeDirectHeadToHeadContextAdjustments({
  displayRatings,
  teams,
  histories,
  uncertainties,
  wins,
  losses,
  teamRosterBasis,
  lastDate,
}: DirectHeadToHeadContextInput) {
  const latestSeriesByPair = new Map<string, { winner: string, loser: string, date: string }>()

  for (const [team, history] of histories.entries()) {
    for (const point of history) {
      if (point.result !== 'W') continue
      if (point.ratingUpdate.updateUnit !== 'series-atomic') continue
      if ((point.source.bestOf ?? 1) < directHeadToHeadContextConfig.minimumBestOf) continue
      if (daysBetween(point.date, lastDate) > directHeadToHeadContextConfig.maxDays) continue

      const opponent = point.opponent
      const teamProfile = teams[team]
      const opponentProfile = teams[opponent]
      if (!teamProfile || !opponentProfile) continue
      if (teamProfile.league !== opponentProfile.league) continue

      const pairKey = [team, opponent].sort((a, b) => a.localeCompare(b)).join('\u0000')
      const current = latestSeriesByPair.get(pairKey)
      if (!current || point.date > current.date) {
        latestSeriesByPair.set(pairKey, { winner: team, loser: opponent, date: point.date })
      }
    }
  }

  const adjustments = new Map<string, number>()
  for (const { winner, loser } of latestSeriesByPair.values()) {
    if (!canUseDirectHeadToHeadContext(winner, uncertainties, wins, losses, teamRosterBasis)) continue
    if (!canUseDirectHeadToHeadContext(loser, uncertainties, wins, losses, teamRosterBasis)) continue

    const winnerRating = displayRatings.get(winner)
    const loserRating = displayRatings.get(loser)
    if (winnerRating === undefined || loserRating === undefined) continue

    const gap = loserRating - winnerRating
    if (gap <= 0 || gap > directHeadToHeadContextConfig.maxRatingGap) continue

    const adjustment = Math.min(
      directHeadToHeadContextConfig.maxAdjustment,
      gap / 2 + directHeadToHeadContextConfig.overtakeMargin,
    )
    addCappedDirectHeadToHeadAdjustment(adjustments, winner, adjustment)
    addCappedDirectHeadToHeadAdjustment(adjustments, loser, -adjustment)
  }

  return adjustments
}

function canUseDirectHeadToHeadContext(
  team: string,
  uncertainties: Map<string, number>,
  wins: Map<string, number>,
  losses: Map<string, number>,
  teamRosterBasis: Map<string, RosterBasis>,
) {
  if (teamRosterBasis.get(team) !== 'sourced') return false
  if ((wins.get(team) ?? 0) + (losses.get(team) ?? 0) < directHeadToHeadContextConfig.minimumGames) return false
  return (uncertainties.get(team) ?? maximumUncertainty) <= directHeadToHeadContextConfig.maxUncertainty
}

function addCappedDirectHeadToHeadAdjustment(adjustments: Map<string, number>, team: string, adjustment: number) {
  const next = (adjustments.get(team) ?? 0) + adjustment
  adjustments.set(team, Number(clamp(
    next,
    -directHeadToHeadContextConfig.maxAdjustment,
    directHeadToHeadContextConfig.maxAdjustment,
  ).toFixed(1)))
}

function daysBetween(date: string, lastDate: string) {
  return Math.max(0, Math.floor((Date.parse(lastDate) - Date.parse(date)) / 86_400_000))
}

function makeDisplayRatings(
  ratings: Map<string, number>,
  teams: Record<string, TeamProfile>,
  leagueScores: Map<string, number>,
  leagueMatchCounts: Map<string, number>,
  rosterPriorOffsets: Map<string, number>,
  momentums: Map<string, number>,
  uncertainties: Map<string, number>,
  wins: Map<string, number>,
  losses: Map<string, number>,
  teamRosterBasis: Map<string, RosterBasis>,
  directHeadToHeadContextAdjustments = new Map<string, number>(),
) {
  return new Map(
    Array.from(ratings.entries()).map(([team, rating]) => {
      const league = teams[team]?.league ?? 'Unknown'
      const leagueScore = effectiveLeagueRating(league, leagueScores.get(league) ?? leaguePriorFor(league), leagueMatchCounts.get(league) ?? 0)
      const uncertainty = uncertainties.get(team) ?? maximumUncertainty
      return [team, ratingFromComponents(ratingComponents({
        teamRating: rating,
        leagueScore,
        rosterPriorOffset: publishedRosterPriorOffset(
          rosterPriorOffsets.get(team) ?? 0,
          wins.get(team) ?? 0,
          losses.get(team) ?? 0,
        ),
        momentum: momentums.get(team) ?? 0,
        contextAdjustment: publishedLeagueAnchorContextAdjustment({
          leagueScore,
          teamRating: rating,
          wins: wins.get(team) ?? 0,
          losses: losses.get(team) ?? 0,
          uncertainty,
          rosterBasis: teamRosterBasis.get(team),
        }) + (directHeadToHeadContextAdjustments.get(team) ?? 0),
        uncertainty,
      }))]
    }),
  )
}

function confidenceFor(history: TeamHistoryPoint[], rating: number, spread: number) {
  const volume = clamp(history.length / 12, 0, 1)
  const recent = history.slice(-5).length / 5
  const separation = clamp(spread / Math.max(Math.abs(rating - 1500), 80), 0, 1)
  return Math.round((0.45 * volume + 0.35 * recent + 0.2 * separation) * 100)
}

export function isDevelopmentalTeamName(team: string) {
  return /\b(?:academy|challengers?|youth)\b/i.test(team)
}

function standingsSpread(ratings: Map<string, number>) {
  const values = Array.from(ratings.values())
  return Math.max(...values) - Math.min(...values)
}
