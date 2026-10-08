import type { EventTier, MatchRecord, MatchRosterSnapshot, PublishedRatingScale } from '../types'
import { conditionalOutcomeProblem, unavailablePowerPreview, type ConditionalSeriesOutcome, type PowerPreviewUnavailable } from './conditionalPowerPreview'
import { eventKFactorForMatch, eventWeightForMatch } from './eventWeighting'
import { materializeRankingModel, replayRatingDates, type RatingReplayContext } from './model'
import { transparentGprModelMetadata } from './modelConfig'
import type { PregamePlayerRatingEdge } from './playerModel'
import { publishedRating } from './publishedRatingArtifacts'
import { ratingScaleFromUnknown } from './ratingCalculations'
import type { RatingRunState } from './ratingRunState'
import { rosterBasisByTeam } from './rosters'
import { resolveCanonicalSeries } from './seriesResolver'
import type { TournamentSeries } from './tournamentFeed'

/** Internal, offline inputs. This is not a new public artifact or a publication API. */
export type ConditionalPowerReplayBasis = {
  modelVersion: string
  modelConfigHash: string
  preStateId: string
  ratingScale: PublishedRatingScale
  context: RatingReplayContext
  state: RatingRunState
  sourceTeamIds: [string, string]
  teamNames: [string, string]
  event: { id: string; name: string; league: string; phase: string; tier: EventTier }
}

type ReplayInput = {
  series: TournamentSeries
  outcome: ConditionalSeriesOutcome
  now: number
  basis: ConditionalPowerReplayBasis | null
  games: readonly MatchRecord[] | null
  playerEdges: ReadonlyMap<string, PregamePlayerRatingEdge> | null
}

export type ConditionalPowerReplay = PowerPreviewUnavailable | {
  status: 'ready'
  hypothetical: true
  teams: Array<{ team: string; before: number; after: number; delta: number }>
  provenance: {
    modelVersion: string; modelConfigHash: string; preStateId: string
    ratingScale: PublishedRatingScale; matchId: string; eventId: string; canonicalSeriesId: string
    bestOf: number; outcome: ConditionalSeriesOutcome; ratingDataAsOf: string
    eventK: number; eventWeight: number
  }
  assumptions: string[]
  pinnedInputs: ReplayInput
}

/** Runs only on clones. The caller supplies every hypothetical game input; no statistics are synthesized. */
export function evaluateConditionalPowerReplay(input: ReplayInput): ConditionalPowerReplay {
  const problem = conditionalOutcomeProblem(input.series, input.outcome, input.now)
  if (problem) return problem
  if (!input.basis) return unavailablePowerPreview('missing-pre-state', 'A pinned internal pre-series state is required; public Power and forecast receipts are insufficient.')
  const basis = structuredClone(input.basis)
  if (basis.modelVersion !== transparentGprModelMetadata.version || basis.modelConfigHash !== transparentGprModelMetadata.configHash) {
    return unavailablePowerPreview('model-mismatch', 'The pinned model/config must match the production evaluator in this revision.')
  }
  if (!ratingScaleFromUnknown(basis.ratingScale)) return unavailablePowerPreview('missing-scale', 'A valid public rating scale is required.')
  if (!basis.preStateId || !basis.state.processedThroughUtcDate || basis.context.lastDate !== basis.state.processedThroughUtcDate) {
    return unavailablePowerPreview('missing-pre-state', 'A dated, identified complete UTC-boundary state is required.')
  }
  if (basis.event.id !== input.series.eventId || basis.sourceTeamIds.some((id, index) => id !== input.series.teams[index]?.id)) {
    return unavailablePowerPreview('identity-mismatch', 'The pinned event and source participants must match the upcoming series.')
  }
  if (basis.teamNames[0] === basis.teamNames[1] || basis.teamNames.some((team) => !hasTeamState(basis, team))) {
    return unavailablePowerPreview('missing-pre-state', 'Both participants need explicit team, league, roster and numeric rating state.')
  }
  if (!input.games?.length || !input.playerEdges) return unavailablePowerPreview('missing-future-inputs', 'Complete hypothetical game inputs and explicit player prior edges are required.')
  const games = structuredClone([...input.games])
  const playerEdges = new Map(structuredClone([...input.playerEdges]))
  const invalid = scenarioProblem(input, basis, games, playerEdges)
  if (invalid) return invalid
  try {
    const before = materializeRankingModel({ context: basis.context, state: structuredClone(basis.state) })
    const context: RatingReplayContext = {
      ...basis.context,
      authoritativeMatches: [...basis.context.authoritativeMatches, ...games],
      lastDate: games[0]!.date,
      pregamePlayerRatingEdges: new Map([...basis.context.pregamePlayerRatingEdges, ...playerEdges]),
      teamRosterBasis: rosterBasisByTeam([...basis.context.authoritativeMatches, ...games]),
    }
    const state = replayRatingDates({ context, state: structuredClone(basis.state), replayMatches: games })
    const after = materializeRankingModel({ context, state })
    const teams = basis.teamNames.map((team) => {
      const previous = before.standings.find((row) => row.team === team)
      const next = after.standings.find((row) => row.team === team)
      if (!previous || !next || !Number.isFinite(previous.rating) || !Number.isFinite(next.rating)) throw new Error('Participant projection is unavailable')
      const beforePower = publishedRating(previous.rating, basis.ratingScale)
      const afterPower = publishedRating(next.rating, basis.ratingScale)
      return { team, before: beforePower, after: afterPower, delta: afterPower - beforePower }
    })
    return {
      status: 'ready', hypothetical: true, teams,
      provenance: {
        modelVersion: basis.modelVersion, modelConfigHash: basis.modelConfigHash, preStateId: basis.preStateId,
        ratingScale: basis.ratingScale, matchId: input.series.id, eventId: input.series.eventId,
        canonicalSeriesId: resolveCanonicalSeries(games)[0]!.id, bestOf: input.series.bestOf!, outcome: structuredClone(input.outcome),
        ratingDataAsOf: basis.state.processedThroughUtcDate,
        eventK: eventKFactorForMatch(games.at(-1)!, basis.state.eventWeightContext),
        eventWeight: eventWeightForMatch(games.at(-1)!, basis.state.eventWeightContext),
      },
      assumptions: [
        'Hypothetical calculation, not a published forecast or an actual rating impact.',
        'Supplied lineups, patch, sides, game order, time, statistics and player prior edges are held fixed.',
        'The pinned event context and lifecycle are held fixed; this series is the only new evidence on its UTC date.',
        'Uses one production series result update and the full standing projection in public Power points.',
        'Other future series, changed model inputs and future tournament placements are not predicted. Tournament simulations retain frozen strength.',
      ],
      pinnedInputs: structuredClone(input),
    }
  } catch (error) {
    return unavailablePowerPreview('replay-rejected', error instanceof Error ? error.message : 'The isolated production replay rejected the inputs.')
  }
}

function hasTeamState(basis: ConditionalPowerReplayBasis, team: string) {
  const league = basis.context.teams[team]?.league
  const state = basis.state
  return Boolean(league && league !== 'Unknown' && completeRoster(state.lastRosterByTeam.get(team))
    && state.histories.has(team) && state.forms.has(team) && state.factorSums.has(team)
    && basis.context.teamRosterBasis.get(team) === 'sourced'
    && state.teamLastRatedDates.get(team) && state.lastPatchByTeam.get(team)
    && Number.isFinite(state.teamLastSeasons.get(team))
    && state.leagueLastRatedDates.get(league) && Number.isFinite(state.leagueLastSeasons.get(league))
    && [state.ratings, state.executionRatings, state.rosterPriorOffsets, state.momentums, state.uncertainties, state.wins, state.losses]
      .every((map) => Number.isFinite(map.get(team)))
    && [state.leagueScores, state.leagueMatchCounts, state.leagueWins, state.leagueLosses, state.leagueExpectedWins, state.leagueOpponentRatingSums]
      .every((map) => Number.isFinite(map.get(league))))
}

function completeRoster(roster: MatchRosterSnapshot | undefined) {
  return roster?.completeness === 'complete-five-role' && roster.players.length === 5
    && new Set(roster.players.map((player) => player.id)).size === 5
    && ['Top', 'Jungle', 'Mid', 'Bot', 'Support'].every((role) => roster.players.some((player) => player.role === role && player.id))
}

function scenarioProblem(input: ReplayInput, basis: ConditionalPowerReplayBasis, games: MatchRecord[], playerEdges: Map<string, PregamePlayerRatingEdge>): PowerPreviewUnavailable | null {
  const expectedDate = input.series.startTime!.slice(0, 10)
  const winsNeeded = (input.series.bestOf! + 1) / 2
  const winner = basis.teamNames[input.outcome.winner === 'home' ? 0 : 1]
  if (games.length !== winsNeeded + input.outcome.loserWins || new Set(games.map((game) => game.id)).size !== games.length) {
    return unavailablePowerPreview('invalid-score', 'Game count and unique game identities must match the selected legal score.')
  }
  if (games.some((game, index) => game.sourceProvider !== 'seed' || game.officialMatchId !== input.series.id
    || game.officialEventId !== basis.event.id || game.event !== basis.event.name || game.league !== basis.event.league
    || game.tier !== basis.event.tier || game.phase !== basis.event.phase
    || game.date !== expectedDate || game.date <= basis.state.processedThroughUtcDate!
    || game.season !== Number(expectedDate.slice(0, 4)) || game.bestOf !== input.series.bestOf || game.bestOfBasis !== 'official'
    || game.teamA !== basis.teamNames[0] || game.teamB !== basis.teamNames[1]
    || (game.teamAHomeLeague !== undefined && game.teamAHomeLeague !== basis.context.teams[game.teamA]?.league)
    || (game.teamBHomeLeague !== undefined && game.teamBHomeLeague !== basis.context.teams[game.teamB]?.league)
    || !basis.teamNames.includes(game.winner) || game.gameNumber !== index + 1
    || !game.datetimeUtc || !Number.isFinite(Date.parse(game.datetimeUtc)) || game.datetimeUtc.slice(0, 10) !== expectedDate
    || Date.parse(game.datetimeUtc) < Date.parse(input.series.startTime!)
    || (index > 0 && Date.parse(game.datetimeUtc) <= Date.parse(games[index - 1]!.datetimeUtc!)))) {
    return unavailablePowerPreview('unsupported-scenario', 'Supply one ordered, synthetic, verified-format series after the pinned boundary, with matching event and participant identities.')
  }
  if (games.filter((game) => game.winner === winner).length !== winsNeeded || games.at(-1)?.winner !== winner) {
    return unavailablePowerPreview('invalid-score', 'The selected winner must reach the winning score on the final game only.')
  }
  if (games.some((game) => !completeRoster(game.teamARoster) || !completeRoster(game.teamBRoster) || !game.patch
    || !['blue', 'red'].includes(game.teamASide ?? '') || !['blue', 'red'].includes(game.teamBSide ?? '') || game.teamASide === game.teamBSide
    || ![game.teamAKills, game.teamBKills, game.teamAGold, game.teamBGold, game.teamATowers, game.teamBTowers,
      game.teamADragons, game.teamBDragons, game.teamABarons, game.teamBBarons, game.gameLengthSeconds]
      .every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0))) {
    return unavailablePowerPreview('missing-future-inputs', 'Lineups, patch, sides, duration and every performance statistic must be explicit. Missing objectives cannot become zero.')
  }
  if (games.some((game) => {
    const edge = playerEdges.get(game.id)
    return !edge || !Number.isFinite(edge.teamAAdjustment) || !Number.isFinite(edge.teamBAdjustment)
      || edge.teamAEvidenceBasis === 'unavailable' || edge.teamBEvidenceBasis === 'unavailable'
  })) return unavailablePowerPreview('missing-player-priors', 'Explicit available player prior edges are required for every hypothetical game.')
  return null
}
