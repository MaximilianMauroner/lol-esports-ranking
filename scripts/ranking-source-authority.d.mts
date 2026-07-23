import type { RawObjectReference, RawSourceReceipt } from './raw-source-storage.mjs'

export type RankingSourceAuthorityEvidenceMode =
  | 'fresh-ingestion'
  | 'stale-source-preservation'
  | 'forced-verified-raw-recovery'

export type RankingSourceAuthorityEvidence = {
  artifactKind: 'ranking-source-authority-evidence'
  schemaVersion: 1
  mode: RankingSourceAuthorityEvidenceMode
  runId: string
  attemptedAt: string
  providerResult: {
    status: 'available' | 'unavailable' | 'no-data'
    sources: Record<string, unknown>
    warnings: string[]
  }
  requestedCoverage: { start: string; end: string }
  authority: null | {
    generationId: string
    importerVersion: string
    coverage: { start: string; end: string }
    sourceReceiptDigest: string
    rawIdentityDigest: string
    receiptSchemaVersion: 1
    storageMode: string
    receiptReference: RawObjectReference
  }
  outage: null | {
    reason: string
    attemptedCoverage: { start: string; end: string }
    providerResult: RankingSourceAuthorityEvidence['providerResult']
  }
  restoredBaseline: null | {
    generationId: string
    sourceReceiptDigest: string
    rawIdentityDigest: string
    coverage: { start: string; end: string }
  }
  compatibility: null | {
    importerVersion: string
    receiptSchemaVersion: 1
    storageMode: string
  }
}

export type RawSourceAuthority = {
  found: true
  receipt: RawSourceReceipt
  receiptReference: RawObjectReference
  objectResolver: (reference: RawObjectReference) => Promise<Buffer | Uint8Array | undefined>
}

export const RANKING_SOURCE_AUTHORITY_EVIDENCE_KIND: 'ranking-source-authority-evidence'
export const RANKING_SOURCE_AUTHORITY_EVIDENCE_MODES: readonly RankingSourceAuthorityEvidenceMode[]

export function prepareRankingSourceAuthorityEvidence(
  input: Omit<RankingSourceAuthorityEvidence, 'artifactKind' | 'schemaVersion'>,
): { evidence: RankingSourceAuthorityEvidence; evidenceDigest: string; bytes: number }
export function parseRankingSourceAuthorityEvidence(value: unknown): RankingSourceAuthorityEvidence
export function rankingSourceAuthorityEvidenceDigest(value: unknown): string
export function parseRankingSourceAuthorityEvidenceEnvelope(value: unknown): {
  evidence: RankingSourceAuthorityEvidence
  evidenceDigest: string
  bytes: number
}
export function validateRawSourceAuthority(
  authority: RawSourceAuthority,
  options?: { importerVersion?: string; requiredCoverage?: { start: string; end: string } },
): Promise<{
  receipt: RawSourceReceipt
  receiptReference: RawObjectReference
  reconstructed: {
    receipt: RawSourceReceipt
    oracle: unknown[]
    leaguepedia: unknown[]
    lolesports: unknown[]
  }
  identity: NonNullable<RankingSourceAuthorityEvidence['authority']>
}>
export function authorityIdentityFor(
  validated: { identity: NonNullable<RankingSourceAuthorityEvidence['authority']> },
): NonNullable<RankingSourceAuthorityEvidence['authority']>
