import type { MatchRecord } from '../../types'
import {
  buildCausalPrefixSummary,
  reconcileCausalPrefix,
  type CausalContextIdentity,
  type CausalInputRow,
  type CausalPrefixSummary,
  type CausalRecomputeDecision,
  type CausalSurfaceId,
} from '../causalRecompute'
import type { EventWeightContext } from '../eventWeighting'
import type { PlacementTournamentLifecycle } from '../placementResiduals'
import { buildRatingCheckpointEventContract, type RatingCheckpointEventContract } from '../ratingCheckpointInventory'
import { compareCodeUnits, stableDigest } from './types'

export const REQUIRED_EXTERNAL_CAUSAL_SURFACES = [
  'sourced-player',
  'dss-team',
  'dss-region',
  'roster-era',
  'player-resume-ledger',
] as const satisfies readonly CausalSurfaceId[]

export type ExternalCausalSurfaceInput = {
  surface: CausalSurfaceId
  inputs: readonly CausalInputRow[]
  contextIdentity?: CausalContextIdentity
  earliestRecomputeUtcDate?: string
}

export type ExternalCausalBundle = {
  schemaVersion: 1
  processedThroughUtcDate: string
  eventContract: RatingCheckpointEventContract
  surfaces: Record<CausalSurfaceId, CausalPrefixSummary>
  digest: string
}

export type ExternalCausalReconciliation =
  | {
      status: 'ready'
      decisions: CausalRecomputeDecision[]
    }
  | {
      status: 'replay-required'
      replayFromUtcDate: string
      resumeAfterUtcDate?: string
      requiresFullReplay: boolean
      reasons: string[]
      decisions: CausalRecomputeDecision[]
    }

export function buildExternalCausalBundle({
  prefixMatches,
  processedThroughUtcDate,
  eventWeightContext,
  tournamentLifecycles = new Map(),
  surfaces,
}: {
  prefixMatches: readonly MatchRecord[]
  processedThroughUtcDate: string
  eventWeightContext: EventWeightContext
  tournamentLifecycles?: ReadonlyMap<string, PlacementTournamentLifecycle>
  surfaces: readonly ExternalCausalSurfaceInput[]
}): ExternalCausalBundle {
  const bySurface = new Map(surfaces.map((surface) => [surface.surface, surface]))
  const summaries = Object.fromEntries(REQUIRED_EXTERNAL_CAUSAL_SURFACES.map((surface) => {
    const input = bySurface.get(surface)
    if (!input?.contextIdentity) {
      throw new Error(`External causal proof is required for ${surface}`)
    }
    return [surface, buildCausalPrefixSummary({
      surface,
      processedThroughUtcDate,
      inputs: input.inputs,
      contextIdentity: input.contextIdentity,
    })]
  })) as Record<CausalSurfaceId, CausalPrefixSummary>
  const eventContract = buildRatingCheckpointEventContract(
    prefixMatches.filter((match) => match.date <= processedThroughUtcDate),
    eventWeightContext,
    tournamentLifecycles,
  )
  return {
    schemaVersion: 1,
    processedThroughUtcDate,
    eventContract,
    surfaces: summaries,
    digest: stableDigest({ processedThroughUtcDate, eventContract, summaries }),
  }
}

export function reconcileExternalCausalBundle({
  bundle,
  authoritativeMatches,
  eventWeightContext,
  tournamentLifecycles = new Map(),
  surfaces,
  availableProcessedThroughUtcDates = [],
}: {
  bundle: ExternalCausalBundle
  authoritativeMatches: readonly MatchRecord[]
  eventWeightContext: EventWeightContext
  tournamentLifecycles?: ReadonlyMap<string, PlacementTournamentLifecycle>
  surfaces: readonly ExternalCausalSurfaceInput[]
  availableProcessedThroughUtcDates?: readonly string[]
}): ExternalCausalReconciliation {
  if (bundle.digest !== stableDigest({
    processedThroughUtcDate: bundle.processedThroughUtcDate,
    eventContract: bundle.eventContract,
    summaries: bundle.surfaces,
  })) {
    return fullReplay(bundle.processedThroughUtcDate, ['external-bundle-digest-mismatch'], [])
  }
  const freshBySurface = new Map(surfaces.map((surface) => [surface.surface, surface]))
  const decisions = REQUIRED_EXTERNAL_CAUSAL_SURFACES.map((surface) => {
    const fresh = freshBySurface.get(surface)
    return reconcileCausalPrefix({
      summary: bundle.surfaces[surface],
      freshInputs: fresh?.inputs ?? [],
      freshContextIdentity: fresh?.contextIdentity,
      availableProcessedThroughUtcDates,
      earliestRecomputeUtcDate: fresh?.earliestRecomputeUtcDate,
    })
  })

  const freshEventContract = buildRatingCheckpointEventContract(
    authoritativeMatches,
    eventWeightContext,
    tournamentLifecycles,
  )
  const eventReplayDate = changedEventReplayDate(bundle.eventContract, freshEventContract, bundle.processedThroughUtcDate)
  const replayDecisions = decisions.filter((decision) => decision.status === 'replay-required')
  const replayDates = [
    ...replayDecisions.map((decision) => decision.replayFromUtcDate),
    ...(eventReplayDate ? [eventReplayDate] : []),
  ].sort(compareCodeUnits)
  if (replayDates.length === 0) return { status: 'ready', decisions }

  const replayFromUtcDate = replayDates[0]!
  const resumeAfterUtcDate = availableProcessedThroughUtcDates
    .filter((date) => date < replayFromUtcDate)
    .sort(compareCodeUnits)
    .at(-1)
  const missingProof = replayDecisions.some((decision) => decision.reason === 'context-unproven')
  return {
    status: 'replay-required',
    replayFromUtcDate,
    ...(!missingProof && resumeAfterUtcDate ? { resumeAfterUtcDate } : {}),
    requiresFullReplay: missingProof || !resumeAfterUtcDate,
    reasons: [
      ...replayDecisions.map((decision) => `${decision.surface}:${decision.reason}`),
      ...(eventReplayDate ? ['event-contract-changed'] : []),
    ],
    decisions,
  }
}

function changedEventReplayDate(
  stored: RatingCheckpointEventContract,
  fresh: RatingCheckpointEventContract,
  boundary: string,
) {
  if (stored.eventContextFingerprint === fresh.eventContextFingerprint
    && stored.eventInventoryFingerprint === fresh.eventInventoryFingerprint) return undefined
  const storedById = new Map(stored.events.map((event) => [event.id, event]))
  const freshById = new Map(fresh.events.map((event) => [event.id, event]))
  return [...new Set([...storedById.keys(), ...freshById.keys()])]
    .flatMap((id) => {
      const before = storedById.get(id)
      const after = freshById.get(id)
      if (stableDigest(before) === stableDigest(after)) return []
      const date = [before?.startDate, after?.startDate].filter(isString).sort(compareCodeUnits)[0]
      return date && date <= boundary ? [date] : []
    })
    .sort(compareCodeUnits)[0] ?? bundleContextReplayDate(stored, fresh, boundary)
}

function bundleContextReplayDate(
  stored: RatingCheckpointEventContract,
  fresh: RatingCheckpointEventContract,
  boundary: string,
) {
  if (stored.eventContextFingerprint === fresh.eventContextFingerprint) return undefined
  return [...stored.events, ...fresh.events]
    .map((event) => event.startDate)
    .filter((date) => date <= boundary)
    .sort(compareCodeUnits)[0] ?? boundary
}

function fullReplay(
  replayFromUtcDate: string,
  reasons: string[],
  decisions: CausalRecomputeDecision[],
): ExternalCausalReconciliation {
  return { status: 'replay-required', replayFromUtcDate, requiresFullReplay: true, reasons, decisions }
}

function isString(value: string | undefined): value is string {
  return value !== undefined
}
