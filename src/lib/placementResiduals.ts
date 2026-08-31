import { effectiveLeagueRating, leaguePriorFor } from '../data/leagueTiers'
import type { MatchRecord, RatingUpdateLedger, TeamProfile } from '../types'
import { eventWeightMultiplierForMatch, type EventWeightContext } from './eventWeighting'
import { homeLeagueForMatch } from './matchContext'
import { tournamentInstanceForEvent, type TournamentLifecycleStatus } from './internationalTournaments'
import { resolveCanonicalSeries, type CanonicalSeries } from './seriesResolver'
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
  lifecycle?: PlacementTournamentLifecycle
  placementAudit?: PlacementResidualAudit
}

export type PlacementResidualAudit = {
  recognizedSeries: number
  totalSeries: number
  recognizedPhaseCoverage: number
  actualPointPool: number
  expectedPointPool: number
  centeredDeltaTotal: number
  skipReason?: 'insufficient-phase-coverage' | 'unresolved-terminal-final'
}

export type NormalizedTournamentPhase =
  | 'final'
  | 'upper-final'
  | 'lower-final'
  | 'semifinal'
  | 'quarterfinal'
  | 'knockout'
  | 'swiss'
  | 'group'
  | 'play-in'
  | 'participation'
  | 'unknown'

export type PlacementTournamentLifecycle = {
  status: TournamentLifecycleStatus
  boundaryDate: string
  ratedThroughDate: string
  dataLag: boolean
  resultCoverageComplete: boolean
}

export function buildEventTrackers(
  matches: MatchRecord[],
  eventWeightContext?: EventWeightContext,
  tournamentLifecycles: ReadonlyMap<string, PlacementTournamentLifecycle> = new Map(),
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
      lifecycle: tournamentLifecycles.get(key),
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
    const lifecycle = tracker.lifecycle
    if (
      !lifecycle
      || lifecycle.status !== 'completed'
      || lifecycle.dataLag
      || !lifecycle.resultCoverageComplete
      || lifecycle.ratedThroughDate < lifecycle.boundaryDate
      || tracker.endDate < lifecycle.boundaryDate
    ) continue
    const config = placementResidualConfigFor(tracker)
    if (!config) {
      tracker.applied = true
      continue
    }

    const series = resolveCanonicalSeries(tracker.matches)
    const phaseAudit = tournamentPhaseAudit(series)
    tracker.placementAudit = {
      ...phaseAudit,
      actualPointPool: 0,
      expectedPointPool: 0,
      centeredDeltaTotal: 0,
    }
    if (phaseAudit.recognizedPhaseCoverage < 0.9) {
      tracker.placementAudit.skipReason = 'insufficient-phase-coverage'
      tracker.applied = true
      continue
    }
    if (!hasResolvedTerminalFinal(series)) {
      tracker.placementAudit.skipReason = 'unresolved-terminal-final'
      tracker.applied = true
      continue
    }

    const actual = actualStagePointsByLeague(tracker, teams, series)
    const actualPointPool = sumMapValues(actual)
    const expected = expectedStagePointsByLeague(tracker, teams, config, actualPointPool)
    const expectedPointPool = sumMapValues(expected)
    const representatives = representativesByLeague(tracker, teams)
    const leagues = [...new Set([...actual.keys(), ...expected.keys()])].filter((league) => league !== 'Unknown')
    const k = config.k * tracker.eventWeightMultiplier
    const cap = config.cap * tracker.eventWeightMultiplier
    const rawDeltas = new Map(leagues.map((league) => {
      const representativeCount = representatives.get(league) ?? 1
      const residual = (actual.get(league) ?? 0) - (expected.get(league) ?? 0)
      return [league, k * residual / Math.sqrt(Math.max(1, representativeCount))]
    }))
    const centeredDeltas = centeredCappedDeltas(rawDeltas, cap)
    tracker.placementAudit = {
      ...phaseAudit,
      actualPointPool,
      expectedPointPool,
      centeredDeltaTotal: Number(sumMapValues(centeredDeltas).toFixed(6)),
    }

    for (const [league, delta] of centeredDeltas) {
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

export function eventTrackerKey(match: MatchRecord) {
  return tournamentInstanceForEvent(match.event, match.season)?.id ?? `${match.season}\u0000${match.event}`
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

function actualStagePointsByLeague(
  tracker: PlacementEventTracker,
  teams: Record<string, TeamProfile>,
  series: CanonicalSeries[],
) {
  const teamPoints = new Map<string, number>()
  for (const entry of series) {
    const points = stagePointsForSeries(entry)
    teamPoints.set(entry.teamA, Math.max(teamPoints.get(entry.teamA) ?? 0, points.teamA))
    teamPoints.set(entry.teamB, Math.max(teamPoints.get(entry.teamB) ?? 0, points.teamB))
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
  actualPointPool: number,
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

  const rawTeamPoints = powers.map((entry, index) => {
    const contenderShare = softmaxWeights[index] / totalWeight
    return {
      ...entry,
      points: config.baseStagePoints + contenderShare * (config.maxStagePoints - config.baseStagePoints),
    }
  })
  const rawExpectedPool = rawTeamPoints.reduce((total, entry) => total + entry.points, 0) || 1
  const poolScale = actualPointPool / rawExpectedPool

  rawTeamPoints.forEach((entry) => {
    const league = tracker.teamLeagues.get(entry.team) ?? teams[entry.team]?.league ?? 'Unknown'
    const expectedPoints = entry.points * poolScale
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

function stagePointsForSeries(series: CanonicalSeries) {
  const match = series.finalMatch
  const phase = normalizeTournamentPhase(match.phase)
  const participantPoints = phase === 'final' ? 8
    : phase === 'upper-final' || phase === 'lower-final' || phase === 'semifinal' ? 5
      : phase === 'quarterfinal' || phase === 'knockout' ? 3
        : 1
  if (phase !== 'final') return { teamA: participantPoints, teamB: participantPoints }
  return {
    teamA: series.outcomeA === 1 ? 11 : 8,
    teamB: series.outcomeA === 0 ? 11 : 8,
  }
}

export function normalizeTournamentPhase(input: string): NormalizedTournamentPhase {
  const phase = input.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  if (!phase) return 'unknown'
  if (/\bgrand final\b/.test(phase) || /^(?:the )?finals?$/.test(phase)) return 'final'
  if (/\bupper (?:bracket )?finals?\b/.test(phase)) return 'upper-final'
  if (/\blower (?:bracket )?finals?\b/.test(phase)) return 'lower-final'
  if (/\bsemi ?finals?\b/.test(phase)) return 'semifinal'
  if (/\bquarter ?finals?\b/.test(phase)) return 'quarterfinal'
  if (/\b(?:knockout|elimination|bracket)\b/.test(phase) || /\b(?:upper|lower) round\b/.test(phase)) return 'knockout'
  if (/\bswiss\b/.test(phase)) return 'swiss'
  if (/\b(?:group|main) stage\b/.test(phase) || /^groups?$/.test(phase)) return 'group'
  if (/\bplay[ -]?in\b/.test(input.toLowerCase())) return 'play-in'
  if (/\b(?:round|stage)\s*(?:of\s*)?\d+\b/.test(phase) || /^round\s+\w+$/.test(phase)) return 'participation'
  return 'unknown'
}

function tournamentPhaseAudit(series: CanonicalSeries[]) {
  const recognizedSeries = series.filter((entry) => normalizeTournamentPhase(entry.finalMatch.phase) !== 'unknown').length
  return {
    recognizedSeries,
    totalSeries: series.length,
    recognizedPhaseCoverage: series.length === 0 ? 0 : recognizedSeries / series.length,
  }
}

function hasResolvedTerminalFinal(series: CanonicalSeries[]) {
  return series.some((entry) => normalizeTournamentPhase(entry.finalMatch.phase) === 'final' && entry.state === 'completed')
}

function centeredCappedDeltas(rawDeltas: Map<string, number>, cap: number) {
  if (rawDeltas.size < 2) return new Map(Array.from(rawDeltas.keys(), (league) => [league, 0]))
  const entries = [...rawDeltas.entries()]
  let low = Math.min(...entries.map(([, value]) => value - cap))
  let high = Math.max(...entries.map(([, value]) => value + cap))
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const offset = (low + high) / 2
    const total = entries.reduce((sum, [, value]) => sum + clamp(value - offset, -cap, cap), 0)
    if (total > 0) low = offset
    else high = offset
  }
  const offset = (low + high) / 2
  const rounded = new Map(entries.map(([league, value]) => [league, Number(clamp(value - offset, -cap, cap).toFixed(1))]))
  let remainingTenths = Math.round(-sumMapValues(rounded) * 10)
  const direction = Math.sign(remainingTenths)
  for (const [league, value] of [...rounded.entries()].sort((left, right) => Math.abs(right[1]) - Math.abs(left[1]))) {
    if (remainingTenths === 0) break
    const adjusted = Number((value + direction * 0.1).toFixed(1))
    if (Math.abs(adjusted) > cap + 1e-9) continue
    rounded.set(league, adjusted)
    remainingTenths -= direction
  }
  return rounded
}

function sumMapValues(values: ReadonlyMap<string, number>) {
  return [...values.values()].reduce((total, value) => total + value, 0)
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
