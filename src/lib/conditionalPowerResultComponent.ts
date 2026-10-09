import { effectiveLeagueRating } from '../data/leagueTiers'
import { conditionalOutcomeProblem, unavailablePowerPreview, type ConditionalSeriesOutcome } from './conditionalPowerPreview'
import { conditionalPowerBasisProblem, type ConditionalPowerReplayBasis } from './conditionalPowerReplay'
import { eventKFactorForMatch, eventWeightForMatch } from './eventWeighting'
import { materializeRankingModel } from './model'
import { isInternationalMatch, powerRating } from './ratingCalculations'
import { publishedRating } from './publishedRatingArtifacts'
import { calculateSeriesResultUpdate, seriesStrengthSignal } from './seriesResultUpdate'
import { tournamentEventStateVersion } from './tournamentForecast'
import type { TournamentSeries } from './tournamentFeed'
import { stableResultAssumptions } from './conditionalPowerResultReceipts'
import { teamIdFor } from './publicArtifacts/schema'

/** Producer-side only: apply the production stable result update to detached snapshot state. */
export function evaluateConditionalPowerResultComponent(input: {
  series: TournamentSeries
  outcome: ConditionalSeriesOutcome
  now: number
  basis: ConditionalPowerReplayBasis | null
}) {
  const { series, outcome, basis } = input
  const problem = conditionalOutcomeProblem(series, outcome, input.now)
  if (problem) return problem
  if (!basis) return unavailablePowerPreview('missing-pre-state', 'An exact pinned producer state is required for a result component.')
  const basisProblem = conditionalPowerBasisProblem(basis)
  if (basisProblem) return basisProblem
  if (series.eventId !== basis.event.id || series.teams.some((team, index) => team.id !== basis.sourceTeamIds[index])) {
    return unavailablePowerPreview('identity-mismatch', 'The source participants and event must match the pinned producer basis.')
  }
  if (series.bestOf !== 1 && series.bestOf !== 3 && series.bestOf !== 5) {
    return unavailablePowerPreview('unsupported-format', 'A verified decisive format is required.')
  }
  const metadata = {
    date: new Date(series.startTime!).toISOString().slice(0, 10),
    event: basis.event.name, league: basis.event.league, phase: basis.event.phase,
    tier: basis.event.tier, region: basis.event.region,
  }
  if (metadata.date <= basis.state.processedThroughUtcDate!) {
    return unavailablePowerPreview('stale-pre-state', 'The snapshot must precede the scheduled series UTC date.')
  }
  try {
    // Materialization applies pending historical placement evidence at the snapshot boundary.
    // Use that same finalized baseline for the result input and both public endpoints.
    const baselineState = structuredClone(basis.state)
    const before = materializeRankingModel({ context: structuredClone(basis.context), state: baselineState })
    const finalizedBasis = { ...basis, state: baselineState }
    const home = resultTeam(basis.teamNames[0], finalizedBasis)
    const away = resultTeam(basis.teamNames[1], finalizedBasis)
    if (!home || !away) {
      return unavailablePowerPreview('missing-result-state', 'Raw team and league strength, counts, priors, momentum, uncertainty and roster continuity must all be explicit.')
    }
    const winsNeeded = (series.bestOf + 1) / 2
    const winsA = outcome.winner === 'home' ? winsNeeded : outcome.loserWins
    const winsB = outcome.winner === 'away' ? winsNeeded : outcome.loserWins
    const eventK = eventKFactorForMatch(metadata, basis.state.eventWeightContext)
    const result = calculateSeriesResultUpdate({
      teams: [home, away], bestOf: series.bestOf,
      observedOutcomeA: Number(outcome.winner === 'home'), observedOutcomeB: Number(outcome.winner === 'away'),
      strengthSignal: seriesStrengthSignal(winsA + winsB, series.bestOf, winsA, winsB),
      eventK, international: isInternationalMatch(metadata),
    })
    const nextState = structuredClone(baselineState)
    nextState.ratings.set(home.team, home.rawRating + result.seriesDeltaA)
    nextState.ratings.set(away.team, away.rawRating + result.seriesDeltaB)
    const after = materializeRankingModel({ context: structuredClone(basis.context), state: nextState })
    const teams = basis.teamNames.map((team, index) => {
      const previous = before.standings.find((standing) => standing.team === team)
      const next = after.standings.find((standing) => standing.team === team)
      const sourceTeamId = basis.sourceTeamIds[index]
      if (!sourceTeamId || !previous || !next || !Number.isFinite(previous.rating) || !Number.isFinite(next.rating)) throw new Error('The participant projection is unavailable')
      const previousPoints = publishedRating(previous.rating, basis.ratingScale)
      const nextPoints = publishedRating(next.rating, basis.ratingScale)
      return { sourceTeamId, teamId: teamIdFor(previous), team, before: previousPoints, after: nextPoints, delta: nextPoints - previousPoints }
    })
    return {
      status: 'partial' as const, scope: 'stable-team-result' as const, hypothetical: true as const,
      teams, outcome: structuredClone(outcome), fullDelta: 'unavailable' as const,
      provenance: {
        matchId: series.id, eventId: series.eventId, eventStateVersion: tournamentEventStateVersion(series),
        preStateId: basis.preStateId, processedThroughUtcDate: basis.state.processedThroughUtcDate!,
        modelVersion: basis.modelVersion, modelConfigHash: basis.modelConfigHash, ratingScale: structuredClone(basis.ratingScale),
        event: structuredClone(basis.event), eventK, eventWeight: eventWeightForMatch(metadata, basis.state.eventWeightContext),
      },
      assumptions: [...stableResultAssumptions],
    }
  } catch (error) {
    return unavailablePowerPreview('result-component-rejected', error instanceof Error ? error.message : 'The isolated result projection failed.')
  }
}

function resultTeam(team: string, { state, context }: ConditionalPowerReplayBasis) {
  const league = context.teams[team]?.league
  if (!league || league === 'Unknown') return null
  const rawRating = state.ratings.get(team)
  const rawLeagueScore = state.leagueScores.get(league)
  const leagueCount = state.leagueMatchCounts.get(league)
  const rosterPriorOffset = state.rosterPriorOffsets.get(team)
  const momentum = state.momentums.get(team)
  const uncertainty = state.uncertainties.get(team)
  const continuity = state.currentRosterContinuity.get(team)
  if (rawRating === undefined || rawLeagueScore === undefined || leagueCount === undefined
    || rosterPriorOffset === undefined || momentum === undefined || uncertainty === undefined || continuity === undefined
    || ![rawRating, rawLeagueScore, leagueCount, rosterPriorOffset, momentum, uncertainty, continuity].every(Number.isFinite)
    || !Number.isInteger(leagueCount) || leagueCount < 0 || continuity < 0 || continuity > 1) return null
  return {
    team, league, rawRating,
    currentPowerRating: powerRating(rawRating, effectiveLeagueRating(league, rawLeagueScore, leagueCount)) + rosterPriorOffset + momentum,
    uncertainty, rosterContinuity: continuity,
  }
}

export type ConditionalPowerResultComponent = ReturnType<typeof evaluateConditionalPowerResultComponent>
