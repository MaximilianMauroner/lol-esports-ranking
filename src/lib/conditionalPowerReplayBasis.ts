import { eventTierConfig } from '../data/rankingConfig'
import type { MatchRecord, MatchRosterSnapshot, TeamProfile } from '../types'
import { digestCausalValue } from './causalRecompute'
import { unavailablePowerPreview, type PowerPreviewUnavailable } from './conditionalPowerPreview'
import { conditionalPowerBasisProblem, hasUniqueConditionalPowerGameAliases, hasUniqueConditionalPowerSeriesAliases, type ConditionalPowerReplayBasis } from './conditionalPowerReplay'
import { createRatingReplayContext, replayRatingDates } from './model'
import type { PlacementTournamentLifecycle } from './placementResiduals'
import { decodeRatingCheckpoint, encodeRatingCheckpoint, type RatingCheckpointIdentity } from './ratingCheckpoint'
import { buildRatingCheckpointEventContract } from './ratingCheckpointInventory'
import { canonicalSeriesOutcomeForTeam, resolveCanonicalSeries, type CanonicalSeries } from './seriesResolver'

type BasisSource = Omit<ConditionalPowerReplayBasis, 'context' | 'state' | 'preStateId'> & {
  /** The producer must identify the complete immutable prefix, including its terminal UTC date. */
  corpusIdentity: RatingCheckpointIdentity
  processedThroughUtcDate: string
  historicalMatches: readonly MatchRecord[]
  teams: Record<string, TeamProfile>
  tournamentLifecycles: ReadonlyMap<string, PlacementTournamentLifecycle>
}

export type PreparedConditionalPowerReplayBasis = PowerPreviewUnavailable | {
  status: 'ready'
  basis: ConditionalPowerReplayBasis
  provenance: {
    corpusIdentity: RatingCheckpointIdentity
    processedThroughUtcDate: string
    payloadDigest: string
    contextDigest: string
    historicalUnavailablePlayerPriorGameIds: string[]
  }
  assumptions: string[]
}

/** Offline only. Reconstructs state from a supplied corpus; never reads a provider or persists a checkpoint. */
export function prepareConditionalPowerReplayBasis(input: BasisSource): PreparedConditionalPowerReplayBasis {
  try {
    const source = structuredClone(input)
    const matches = source.historicalMatches
    if (!(source.tournamentLifecycles instanceof Map)) {
      return unavailablePowerPreview('missing-event-context', 'Supply an explicit tournament lifecycle map. Missing lifecycle evidence cannot become an empty map.')
    }
    if (!isUtcDate(source.processedThroughUtcDate) || !matches.length
      || matches.some((match) => !isUtcDate(match.date) || match.date > source.processedThroughUtcDate)
      || !matches.some((match) => match.date === source.processedThroughUtcDate)) {
      return unavailablePowerPreview('missing-pre-state', 'Supply a nonempty identified historical prefix through a complete real UTC date, with no future records.')
    }
    if (!hasUniqueConditionalPowerGameAliases(matches)) {
      return unavailablePowerPreview('duplicate-game-alias', 'Every historical raw, official and source game alias must belong to one record. Conflicting records cannot be dropped or given invented identities.')
    }
    for (const match of matches) {
      if (match.datetimeUtc === undefined) continue
      const timestamp = typeof match.datetimeUtc === 'string' ? Date.parse(match.datetimeUtc) : NaN
      if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== match.date) {
        return unavailablePowerPreview('incomplete-historical-inputs', 'Every supplied historical timestamp must be valid and match its actual UTC replay date. Date-only records may omit the timestamp.')
      }
      // Production orders timestamp strings. Normalize known clocks before constructing a detached state.
      match.datetimeUtc = new Date(timestamp).toISOString()
    }
    if (matches.some((match) => !completeHistoricalGame(match, source.teams))) {
      return unavailablePowerPreview('incomplete-historical-inputs', 'Historical team profiles, event/format, patch, sides, five-role lineups and performance statistics must be explicit. This adapter cannot reconstruct them from public points.')
    }
    if (resolveCanonicalSeries(matches).some((series) => !completeHistoricalSeries(series))) {
      return unavailablePowerPreview('incomplete-historical-inputs', 'Every historical series must have consistent event scoring metadata and supplied event IDs, a verified format and a legal decisive final score within one UTC replay date. Conflicting, ongoing, unknown or cross-date series cannot establish complete historical coverage.')
    }
    if (!hasUniqueConditionalPowerSeriesAliases(matches)) {
      return unavailablePowerPreview('duplicate-series-alias', 'Historical official, source and production-normalized series aliases must have one canonical series owner. Conflicting series cannot be dropped, merged or given invented identities.')
    }
    const context = createRatingReplayContext(matches, source.teams, { tournamentLifecycles: source.tournamentLifecycles })
    const state = replayRatingDates({ context, replayMatches: context.authoritativeMatches })
    const eventContract = buildRatingCheckpointEventContract(context.authoritativeMatches, context.eventWeightContext, context.tournamentLifecycles)
    // Reuse the production checkpoint schema/digest checks, without saving or loading a real artifact.
    const checkpoint = decodeRatingCheckpoint(encodeRatingCheckpoint(state, source.corpusIdentity, {
      processedThroughUtcDate: source.processedThroughUtcDate,
      processedThroughMatchId: state.previousMatch!.id,
    }, eventContract), source.corpusIdentity)
    const contextDigest = digestCausalValue(context)
    const basis: ConditionalPowerReplayBasis = {
      modelVersion: source.modelVersion, modelConfigHash: source.modelConfigHash, ratingScale: source.ratingScale,
      sourceTeamIds: source.sourceTeamIds, teamNames: source.teamNames, event: source.event,
      preStateId: JSON.stringify({ ...source.corpusIdentity, payloadDigest: checkpoint.metadata.payloadDigest, contextDigest }),
      context, state: checkpoint.state,
    }
    const problem = conditionalPowerBasisProblem(basis)
    if (problem) return problem
    const historicalUnavailablePlayerPriorGameIds = [...context.pregamePlayerRatingEdges]
      .filter(([, edge]) => edge.teamAEvidenceBasis === 'unavailable' || edge.teamBEvidenceBasis === 'unavailable')
      .map(([id]) => id)
    return {
      status: 'ready', basis,
      provenance: {
        corpusIdentity: source.corpusIdentity, processedThroughUtcDate: source.processedThroughUtcDate,
        payloadDigest: checkpoint.metadata.payloadDigest, contextDigest, historicalUnavailablePlayerPriorGameIds,
      },
      assumptions: [
        'The caller identifies this supplied corpus as the complete immutable historical prefix. This adapter does not certify provider completeness or fetch missing evidence.',
        'The state and full replay context are pinned to detect later input changes. These digests do not certify the supplied corpus or identities as producer truth.',
        'Historical state and causal player edges are reconstructed with the current production model, including its documented initial priors. No historical state is inferred from published Power.',
        `${historicalUnavailablePlayerPriorGameIds.length} historical games have unavailable pregame player priors in the production replay. Their identities are listed in provenance; future player priors must still be supplied explicitly.`,
        'The supplied tournament lifecycle map is held fixed. Future lineups, patch, sides, timing and statistics remain required by the evaluator.',
      ],
    }
  } catch (error) {
    return unavailablePowerPreview('basis-rejected', error instanceof Error ? error.message : 'The production replay could not prepare this historical basis.')
  }
}

function completeHistoricalSeries(series: CanonicalSeries) {
  const winsNeeded = (series.format + 1) / 2
  const final = series.finalMatch
  const suppliedEventIds = series.games.map((game) => game.officialEventId).filter((id) => id !== undefined)
  return series.state === 'completed' && [1, 3, 5].includes(series.format)
    && new Set(series.games.map((game) => game.date)).size === 1
    && new Set(suppliedEventIds).size <= 1
    && Math.max(series.winsA, series.winsB) === winsNeeded && Math.min(series.winsA, series.winsB) < winsNeeded
    && series.games.every((game) => game.bestOf === series.format && game.event === final.event
      && game.league === final.league && game.phase === final.phase && game.region === final.region && game.tier === final.tier)
    && canonicalSeriesOutcomeForTeam(series, series.finalMatch.winner) === 1
}

function isUtcDate(date: string) {
  const timestamp = Date.parse(date)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date
}

function completeRoster(roster: MatchRosterSnapshot | undefined, date: string) {
  return roster?.sourceProvider === 'oracles-elixir' && isUtcDate(roster.observedAt) && roster.observedAt <= date
    && roster.completeness === 'complete-five-role' && roster.players.length === 5
    && new Set(roster.players.map((player) => player.id)).size === 5
    && ['Top', 'Jungle', 'Mid', 'Bot', 'Support'].every((role) => roster.players.some((player) => player.role === role && player.id))
}

function completeHistoricalGame(match: MatchRecord, teams: Record<string, TeamProfile>) {
  return Boolean(match.id && ['oracles-elixir', 'leaguepedia-cargo', 'seed'].includes(match.sourceProvider ?? '') && match.event && match.phase && match.league && match.patch
    && match.tier in eventTierConfig && Number.isInteger(match.season) && match.season === Number(match.date.slice(0, 4))
    && [1, 3, 5].includes(match.bestOf) && ['official', 'provider'].includes(match.bestOfBasis ?? '')
    && match.teamA !== match.teamB && [match.teamA, match.teamB].includes(match.winner)
    && [match.teamA, match.teamB].every((team) => teams[team]?.name === team && teams[team]?.league && teams[team]?.league !== 'Unknown')
    && completeRoster(match.teamARoster, match.date) && completeRoster(match.teamBRoster, match.date)
    && !match.teamARoster!.players.some((player) => match.teamBRoster!.players.some((opponent) => opponent.id === player.id))
    && ['blue', 'red'].includes(match.teamASide ?? '') && ['blue', 'red'].includes(match.teamBSide ?? '') && match.teamASide !== match.teamBSide
    && [match.teamAKills, match.teamBKills, match.teamAGold, match.teamBGold, match.teamATowers, match.teamBTowers,
      match.teamADragons, match.teamBDragons, match.teamABarons, match.teamBBarons, match.gameLengthSeconds]
      .every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0))
}
