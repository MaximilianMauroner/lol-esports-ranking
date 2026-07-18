import type { TeamProfile, MatchRecord } from '../../types'
import type { LolEsportsReferenceEvent } from '../importers/lolEsports'
import type { OracleImportResult } from '../importers/oraclesElixir'
import type { LeaguepediaImportResult } from '../importers/leaguepedia'
import type { LolEsportsReferenceImportResult } from '../importers/lolEsports'
import { stableHash } from './hash'
import type { IncrementalFallbackReason } from './types'

export const PROVIDER_LEDGER_SCHEMA_VERSION = 1 as const

export type ProviderId = 'oracles-elixir' | 'leaguepedia-cargo' | 'lol-esports-api'

export type ProviderFileFingerprint = {
  provider: ProviderId
  fileId: string
  byteLength: number
  contentHash: string
}

type ObservationBase = {
  id: string
  provider: ProviderId
  fileId: string
  groupHash: string
  payloadHash: string
  date?: string
}

export type MatchProviderObservation = ObservationBase & {
  kind: 'match'
  provider: 'oracles-elixir' | 'leaguepedia-cargo'
  payload: MatchRecord
}

export type ScheduleProviderObservation = ObservationBase & {
  kind: 'schedule'
  provider: 'lol-esports-api'
  payload: LolEsportsReferenceEvent
}

export type ProviderObservation = MatchProviderObservation | ScheduleProviderObservation

export type ProviderTombstone = {
  schemaVersion: typeof PROVIDER_LEDGER_SCHEMA_VERSION
  observationId: string
  provider: ProviderId
  deletedAt: string
  reason: 'authoritative-file-replacement'
}

export type ProviderPartitionIndex = {
  schemaVersion: typeof PROVIDER_LEDGER_SCHEMA_VERSION
  provider: ProviderId
  partitions: Record<string, string[]>
}

export type ProviderFileLedger = {
  schemaVersion: typeof PROVIDER_LEDGER_SCHEMA_VERSION
  fingerprint: ProviderFileFingerprint
  observations: ProviderObservation[]
  teams: Record<string, TeamProfile>
  source: OracleImportResult['source'] | LeaguepediaImportResult['source'] | LolEsportsReferenceImportResult['source']
}

export type ProviderScanMetrics = {
  bytesScanned: number
  rowsParsed: number
  observationsNormalized: number
  observationsReused: number
}

export type ProviderFileResult = {
  status: 'reused' | 'changed' | 'fallback'
  ledger: ProviderFileLedger
  tombstones: ProviderTombstone[]
  metrics: ProviderScanMetrics
  fallback?: IncrementalFallbackReason
}

export async function processProviderFile({
  fingerprint,
  previous,
  authoritativeReplacement = false,
  readContents,
  normalize,
  now,
}: {
  fingerprint: ProviderFileFingerprint
  previous?: ProviderFileLedger
  authoritativeReplacement?: boolean
  readContents: () => Promise<string>
  normalize: (contents: string, previous?: ProviderFileLedger) => Omit<ProviderFileResult, 'status' | 'tombstones' | 'fallback'>
  now: string
}): Promise<ProviderFileResult> {
  if (previous && compatibleFingerprint(previous.fingerprint, fingerprint)) {
    return {
      status: 'reused',
      ledger: previous,
      tombstones: [],
      metrics: { bytesScanned: 0, rowsParsed: 0, observationsNormalized: 0, observationsReused: previous.observations.length },
    }
  }

  const contents = await readContents()
  const normalized = normalize(contents, previous)
  const previousIds = new Set(previous?.observations.map((observation) => observation.id) ?? [])
  const nextIds = new Set(normalized.ledger.observations.map((observation) => observation.id))
  const deletedIds = [...previousIds].filter((id) => !nextIds.has(id)).sort()
  if (deletedIds.length > 0 && !authoritativeReplacement && previous) {
    return {
      status: 'fallback',
      ledger: previous,
      tombstones: [],
      metrics: normalized.metrics,
      fallback: { kind: 'dependency-unknown', dependency: `ambiguous-provider-deletion:${fingerprint.fileId}` },
    }
  }

  return {
    status: 'changed',
    ...normalized,
    tombstones: deletedIds.map((observationId) => ({
      schemaVersion: PROVIDER_LEDGER_SCHEMA_VERSION,
      observationId,
      provider: fingerprint.provider,
      deletedAt: now,
      reason: 'authoritative-file-replacement',
    })),
  }
}

export function compatibleFingerprint(left: ProviderFileFingerprint, right: ProviderFileFingerprint): boolean {
  return left.provider === right.provider
    && left.fileId === right.fileId
    && left.byteLength === right.byteLength
    && left.contentHash === right.contentHash
}

export function observationIdForMatch(provider: MatchProviderObservation['provider'], match: MatchRecord): string {
  const naturalId = match.sourceGameId ?? match.officialGameId ?? match.id
  if (!naturalId) throw new Error(`${provider} match observation lacks a natural provider identity`)
  return `${provider}:game:${naturalId}`
}

export function observationIdForSchedule(event: LolEsportsReferenceEvent): string {
  if (!event.matchId) throw new Error('LoL Esports observation lacks a match ID')
  return `lol-esports-api:match:${event.matchId}`
}

export function matchObservation({
  provider,
  fileId,
  groupHash,
  match,
}: {
  provider: MatchProviderObservation['provider']
  fileId: string
  groupHash: string
  match: MatchRecord
}): MatchProviderObservation {
  return {
    id: observationIdForMatch(provider, match),
    kind: 'match',
    provider,
    fileId,
    groupHash,
    payloadHash: stableHash(match),
    date: match.date,
    payload: match,
  }
}

export function scheduleObservation(fileId: string, event: LolEsportsReferenceEvent): ScheduleProviderObservation {
  return {
    id: observationIdForSchedule(event),
    kind: 'schedule',
    provider: 'lol-esports-api',
    fileId,
    groupHash: stableHash(event),
    payloadHash: stableHash(event),
    date: event.date,
    payload: event,
  }
}

export function buildProviderPartitionIndex(
  provider: ProviderId,
  observations: ProviderObservation[],
): ProviderPartitionIndex {
  const partitions: Record<string, string[]> = {}
  for (const observation of observations) {
    const partition = observation.date?.slice(0, 7) ?? 'unknown'
    partitions[partition] = [...(partitions[partition] ?? []), observation.id].sort()
  }
  return { schemaVersion: PROVIDER_LEDGER_SCHEMA_VERSION, provider, partitions }
}
