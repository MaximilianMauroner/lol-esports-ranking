export type RankingRefreshOutcome =
  | 'unchanged'
  | 'latest-append'
  | 'same-day-insertion'
  | 'historical-correction'
  | 'metadata-only'
  | 'stale-source'
  | 'no-data'
  | 'forced-verified-raw-rebuild'
  | 'parity-failure'
  | 'full-invalidation'

export type RankingRefreshOutcomeContract = {
  requiredInputs: string[]
  optionalArtifacts: string[]
  allowedWrites: string[]
  authorityAdvancement:
    | 'never'
    | 'after-successful-publication'
    | 'after-successful-clean-full-publication'
  reconciliationBehavior: 'not-consumed' | 'required-before-completion' | 'omitted'
  auditEligibility: 'ineligible' | 'clean-full-replay-only'
  retryState: 'none' | 'pending-provider-backoff' | 'pending-publication-on-failure'
}

export type RankingRefreshObservation = {
  sourceResult: 'unchanged' | 'completed' | 'stale-source'
  providerStatus: 'usable' | 'failed'
  force: boolean
  rawRecoveryAuthorized: boolean
  verifiedRawAuthority: boolean
  dataMode: 'scheduled-public-data' | 'no-data' | null
  rankingChangeKind:
    | 'no-change'
    | 'metadata-only'
    | 'latest-append'
    | 'same-day-insertion'
    | 'historical-correction'
    | 'full-invalidation'
    | null
  buildAction: 'no-change' | 'publish-incremental' | 'publish-full' | null
  parity: boolean | null
  fallbackReason: string | null
}

export const RANKING_REFRESH_OUTCOMES: readonly RankingRefreshOutcome[]
export const RANKING_REFRESH_OUTCOME_MATRIX: Readonly<
  Record<RankingRefreshOutcome, Readonly<RankingRefreshOutcomeContract>>
>
export function normalizeRankingRefreshOutcome(
  value: unknown,
): { outcome: RankingRefreshOutcome; contract: Readonly<RankingRefreshOutcomeContract> }
export function parseRankingRefreshOutcomeMatrix(
  value: unknown,
): Record<RankingRefreshOutcome, RankingRefreshOutcomeContract>
