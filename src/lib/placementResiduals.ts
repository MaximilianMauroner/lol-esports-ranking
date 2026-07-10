import { effectiveLeagueRating, leaguePriorFor } from '../data/leagueTiers'
import type { MatchRecord, RatingUpdateLedger, TeamProfile } from '../types'
import { eventWeightMultiplierForMatch, type EventWeightContext } from './eventWeighting'
import { homeLeagueForMatch } from './matchContext'
import {
  initialTeamRating,
  maximumUncertainty,
  minorPlacementResidualCap,
  minorPlacementResidualK,
  msiPlacementResidualCap,
  msiPlacementResidualK,
  worldsPlacementResidualCap,
  worldsPlacementResidualK,
} from './modelConfig'
import {
  clamp,
  emptyRatingUpdateLedger,
  ratingComponents,
  ratingFromComponents,
  roundedRatingUpdateLedger,
} from './ratingCalculations'

type PlacementEventTracker = {
  event: string
  season: number
  tier: MatchRecord['tier']
  startDate: string
  endDate: string
  participants: Set<string>
  teamLeagues: Map<string, string>
  preEventPowers: Map<string, number>
  matches: MatchRecord[]
  eventWeightMultiplier: number
  started: boolean
  applied: boolean
}

export function buildEventTrackers(
  matches: MatchRecord[],
  eventWeightContext?: EventWeightContext,
) {
  const trackers = new Map<string, PlacementEventTracker>()
  for (const match of matches) {
    if (!placementResidualConfigFor(match)) continue
    const eventWeightMultiplier = eventWeightMultiplierForMatch(match, eventWeightContext)
    const key = eventTrackerKey(match)
    const tracker = trackers.get(key) ?? {
      event: match.event,
      season: match.season,
      tier: match.tier,
      startDate: match.date,
      endDate: match.date,
      participants: new Set<string>(),
      teamLeagues: new Map<string, string>(),
      preEventPowers: new Map<string, number>(),
      matches: [],
      eventWeightMultiplier,
      started: false,
      applied: false,
    }
    tracker.startDate = tracker.startDate < match.date ? tracker.startDate : match.date
    tracker.endDate = tracker.endDate > match.date ? tracker.endDate : match.date
    tracker.participants.add(match.teamA)
    tracker.participants.add(match.teamB)
    tracker.tier = strongestPlacementTier(tracker.tier, match.tier)
    tracker.eventWeightMultiplier = Math.min(tracker.eventWeightMultiplier, eventWeightMultiplier)
    trackers.set(key, tracker)
  }
  return trackers
}

export function startEventTrackersForDate(
  matches: MatchRecord[],
  trackers: Map<string, PlacementEventTracker>,
  teams: Record<string, TeamProfile>,
  ratings: Map<string, number>,
  momentums: Map<string, number>,
  rosterPriorOffsets: Map<string, number>,
  uncertainties: Map<string, number>,
  leagueScores: Map<string, number>,
  leagueMatchCounts: Map<string, number>,
) {
  for (const match of matches) {
    const tracker = trackers.get(eventTrackerKey(match))
    if (!tracker || tracker.started) continue
    tracker.started = true
    for (const team of tracker.participants) {
      const league = teams[team]?.league ?? 'Unknown'
      const leagueScore = effectiveLeagueRating(league, leagueScores.get(league) ?? leaguePriorFor(league), leagueMatchCounts.get(league) ?? 0)
      tracker.preEventPowers.set(team, ratingFromComponents(ratingComponents({
        teamRating: ratings.get(team) ?? initialTeamRating,
        leagueScore,
        rosterPriorOffset: rosterPriorOffsets.get(team) ?? 0,
        momentum: momentums.get(team) ?? 0,
        contextAdjustment: 0,
        uncertainty: uncertainties.get(team) ?? maximumUncertainty,
      })))
    }
  }
}

export function trackMatchForPlacement(trackers: Map<string, PlacementEventTracker>, match: MatchRecord, teams: Record<string, TeamProfile>) {
  const tracker = trackers.get(eventTrackerKey(match))
  if (!tracker) return
  tracker.matches.push(match)
  tracker.teamLeagues.set(match.teamA, homeLeagueForMatch(match, 'A', teams))
  tracker.teamLeagues.set(match.teamB, homeLeagueForMatch(match, 'B', teams))
}

export function applyCompletedPlacementResiduals({
  cutoffDate,
  eventTrackers,
  teams,
  ratings,
  leagueScores,
  previousLeagueScores,
  leagueLastEvents,
  leagueLastUpdated,
  leaguePlacementDeltas,
  latestRatingUpdates,
}: {
  cutoffDate?: string
  eventTrackers: Map<string, PlacementEventTracker>
  teams: Record<string, TeamProfile>
  ratings: Map<string, number>
  leagueScores: Map<string, number>
  previousLeagueScores: Map<string, number>
  leagueLastEvents: Map<string, string>
  leagueLastUpdated: Map<string, string>
  leaguePlacementDeltas: Map<string, number>
  latestRatingUpdates: Map<string, RatingUpdateLedger>
}) {
  for (const tracker of eventTrackers.values()) {
    if (tracker.applied || !tracker.started || tracker.matches.length === 0) continue
    if (cutoffDate !== undefined && tracker.endDate >= cutoffDate) continue
    const config = placementResidualConfigFor(tracker)
    if (!config) {
      tracker.applied = true
      continue
    }

    const actual = actualStagePointsByLeague(tracker, teams)
    const expected = expectedStagePointsByLeague(tracker, teams, config)
    const representatives = representativesByLeague(tracker, teams)
    const leagues = new Set([...actual.keys(), ...expected.keys()])

    for (const league of leagues) {
      if (league === 'Unknown') continue
      const representativeCount = representatives.get(league) ?? 1
      const residual = (actual.get(league) ?? 0) - (expected.get(league) ?? 0)
      const k = config.k * tracker.eventWeightMultiplier
      const cap = config.cap * tracker.eventWeightMultiplier
      const delta = Number(clamp(k * residual / Math.sqrt(Math.max(1, representativeCount)), -cap, cap).toFixed(1))
      if (Math.abs(delta) < 0.05) continue
      const currentScore = leagueScores.get(league) ?? leaguePriorFor(league)
      previousLeagueScores.set(league, currentScore)
      leagueScores.set(league, currentScore + delta)
      leagueLastEvents.set(league, tracker.event)
      leagueLastUpdated.set(league, tracker.endDate)
      leaguePlacementDeltas.set(league, Number(((leaguePlacementDeltas.get(league) ?? 0) + delta).toFixed(1)))

      for (const team of teamsForLeague(league, teams, ratings, tracker)) {
        const current = latestRatingUpdates.get(team) ?? emptyRatingUpdateLedger()
        latestRatingUpdates.set(team, roundedRatingUpdateLedger({
          ...current,
          leaguePlacementDelta: current.leaguePlacementDelta + delta,
        }))
      }
    }

    tracker.applied = true
  }
}

function eventTrackerKey(match: MatchRecord) {
  return `${match.season}\u0000${match.event}`
}

function teamsForLeague(
  league: string,
  teams: Record<string, TeamProfile>,
  ratings: Map<string, number>,
  tracker: PlacementEventTracker,
) {
  const names = new Set<string>()
  for (const [team, profile] of Object.entries(teams)) {
    if (profile.league === league && ratings.has(team)) names.add(team)
  }
  for (const [team, teamLeague] of tracker.teamLeagues.entries()) {
    if (teamLeague === league) names.add(team)
  }
  return names
}

function actualStagePointsByLeague(tracker: PlacementEventTracker, teams: Record<string, TeamProfile>) {
  const teamPoints = new Map<string, number>()
  for (const match of tracker.matches) {
    const points = stagePointsForMatch(match)
    teamPoints.set(match.teamA, Math.max(teamPoints.get(match.teamA) ?? 0, points.teamA))
    teamPoints.set(match.teamB, Math.max(teamPoints.get(match.teamB) ?? 0, points.teamB))
  }
  const byLeague = new Map<string, number>()
  for (const [team, points] of teamPoints.entries()) {
    const league = tracker.teamLeagues.get(team) ?? teams[team]?.league ?? 'Unknown'
    byLeague.set(league, (byLeague.get(league) ?? 0) + points)
  }
  return byLeague
}

function expectedStagePointsByLeague(
  tracker: PlacementEventTracker,
  teams: Record<string, TeamProfile>,
  config: NonNullable<ReturnType<typeof placementResidualConfigFor>>,
) {
  const powers = Array.from(tracker.participants, (team) => ({
    team,
    power: tracker.preEventPowers.get(team) ?? initialTeamRating,
  }))
  if (powers.length === 0) return new Map<string, number>()

  const maxPower = Math.max(...powers.map((entry) => entry.power))
  const softmaxWeights = powers.map((entry) => Math.exp((entry.power - maxPower) / 400))
  const totalWeight = softmaxWeights.reduce((total, value) => total + value, 0) || 1
  const byLeague = new Map<string, number>()

  powers.forEach((entry, index) => {
    const league = tracker.teamLeagues.get(entry.team) ?? teams[entry.team]?.league ?? 'Unknown'
    const contenderShare = softmaxWeights[index] / totalWeight
    const expectedPoints = config.baseStagePoints + contenderShare * (config.maxStagePoints - config.baseStagePoints)
    byLeague.set(league, (byLeague.get(league) ?? 0) + expectedPoints)
  })

  return byLeague
}

function representativesByLeague(tracker: PlacementEventTracker, teams: Record<string, TeamProfile>) {
  const byLeague = new Map<string, Set<string>>()
  for (const team of tracker.participants) {
    const league = tracker.teamLeagues.get(team) ?? teams[team]?.league ?? 'Unknown'
    const representatives = byLeague.get(league) ?? new Set<string>()
    representatives.add(team)
    byLeague.set(league, representatives)
  }
  return new Map(Array.from(byLeague.entries()).map(([league, representatives]) => [league, representatives.size]))
}

function stagePointsForMatch(match: MatchRecord) {
  const phase = `${match.phase} ${match.event}`.toLowerCase()
  const finalPhase = /\b(grand\s+final|finals?|championship)\b/.test(phase) && !/\bsemi/.test(phase) && !/\bquarter/.test(phase)
  const semifinalPhase = /\bsemi/.test(phase)
  const quarterfinalPhase = /\bquarter/.test(phase)
  const bracketFloor = match.tier === 'worlds-playoffs' || match.tier === 'msi-bracket' ? 3 : 1
  const participantPoints = quarterfinalPhase ? 3 : semifinalPhase ? 5 : finalPhase ? 8 : bracketFloor
  if (!finalPhase) return { teamA: participantPoints, teamB: participantPoints }
  return {
    teamA: match.winner === match.teamA ? 11 : 8,
    teamB: match.winner === match.teamB ? 11 : 8,
  }
}

function placementResidualConfigFor(event: MatchRecord | PlacementEventTracker) {
  if (!isPlacementResidualEvent(event)) return undefined
  if (event.tier === 'worlds-playoffs' || event.tier === 'worlds-main' || /\bworlds?\b/i.test(event.event)) {
    return { k: worldsPlacementResidualK, cap: worldsPlacementResidualCap, baseStagePoints: 1, maxStagePoints: 11 }
  }
  if (event.tier === 'msi-bracket' || event.tier === 'msi-play-in' || /\bmsi\b/i.test(event.event)) {
    return { k: msiPlacementResidualK, cap: msiPlacementResidualCap, baseStagePoints: 1, maxStagePoints: 11 }
  }
  return { k: minorPlacementResidualK, cap: minorPlacementResidualCap, baseStagePoints: 1, maxStagePoints: 8 }
}

function isPlacementResidualEvent(event: MatchRecord | PlacementEventTracker) {
  return event.tier === 'worlds-playoffs'
    || event.tier === 'worlds-main'
    || event.tier === 'msi-bracket'
    || event.tier === 'msi-play-in'
    || event.tier === 'minor-international'
}

function strongestPlacementTier(left: MatchRecord['tier'], right: MatchRecord['tier']) {
  const order: MatchRecord['tier'][] = ['qualifier', 'regional-regular', 'major-playoffs', 'minor-international', 'msi-play-in', 'worlds-main', 'msi-bracket', 'worlds-playoffs']
  return order.indexOf(right) > order.indexOf(left) ? right : left
}
