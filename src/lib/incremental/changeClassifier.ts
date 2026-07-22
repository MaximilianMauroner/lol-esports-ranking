import type { MatchRecord } from '../../types'
import {
  CANONICAL_MATCH_LEDGER_SCHEMA_VERSION,
  assertUtcDate,
  compareCodeUnits,
  stableDigest,
  type CanonicalMatchLedger,
  type CanonicalMatchLedgerContext,
  type CanonicalMatchLedgerRow,
  type RankingChangeClassification,
  type RankingCompatibility,
} from './types'

export function canonicalMatchLedgerKey(match: MatchRecord) {
  const identity = match.officialGameId
    ? `official-game:${match.officialGameId}`
    : match.sourceGameId
      ? `source-game:${match.sourceProvider ?? 'unknown'}:${match.sourceGameId}`
      : match.sourceMatchId
        ? `source-match:${match.sourceProvider ?? 'unknown'}:${match.sourceMatchId}:${match.gameNumber ?? 0}`
        : `canonical-match:${match.id}`
  return identity
}

/**
 * Captures every imported match field in both semantic channels. Keeping the
 * channels separate allows later schema versions to narrow artifact-only
 * metadata without accidentally omitting a scoring input today.
 */
export function buildCanonicalMatchLedger(
  matches: readonly MatchRecord[],
  context: CanonicalMatchLedgerContext,
): CanonicalMatchLedger {
  assertCompatibility(context)
  const rows = matches.map((match): CanonicalMatchLedgerRow => {
    assertUtcDate(match.date)
    const key = canonicalMatchLedgerKey(match)
    const teamContext = context.teams
      ? {
          teamA: context.teams[match.teamA],
          teamB: context.teams[match.teamB],
        }
      : undefined
    return {
      key,
      utcDate: match.date,
      scoringDigest: stableDigest({ match, teamContext }),
      artifactDigest: stableDigest({ match, teamContext }),
      scheduleReceiptIdentity: context.scheduleReceiptIdentity,
      contextReceiptIdentity: context.contextReceiptIdentity,
      provenanceReceiptIdentity: context.provenanceReceiptIdentity,
      match,
    }
  }).sort(compareLedgerRows)
  const duplicate = rows.find((row, index) => row.key === rows[index - 1]?.key)
  if (duplicate) throw new Error(`Duplicate canonical match ledger key ${duplicate.key}`)
  const compatibility = compatibilityFrom(context)
  return {
    schemaVersion: CANONICAL_MATCH_LEDGER_SCHEMA_VERSION,
    compatibility,
    scheduleReceiptIdentity: context.scheduleReceiptIdentity,
    contextReceiptIdentity: context.contextReceiptIdentity,
    provenanceReceiptIdentity: context.provenanceReceiptIdentity,
    rows,
    digest: stableDigest({
      compatibility,
      scheduleReceiptIdentity: context.scheduleReceiptIdentity,
      contextReceiptIdentity: context.contextReceiptIdentity,
      provenanceReceiptIdentity: context.provenanceReceiptIdentity,
      rows: rows.map((row) => ({
        key: row.key,
        utcDate: row.utcDate,
        scoringDigest: row.scoringDigest,
        artifactDigest: row.artifactDigest,
        scheduleReceiptIdentity: row.scheduleReceiptIdentity,
        contextReceiptIdentity: row.contextReceiptIdentity,
        provenanceReceiptIdentity: row.provenanceReceiptIdentity,
      })),
    }),
  }
}

export function classifyRankingChange(
  previous: CanonicalMatchLedger,
  current: CanonicalMatchLedger,
  compatibility: RankingCompatibility = current.compatibility,
): RankingChangeClassification {
  const incompatibilities = compatibilityDifferences(previous, current, compatibility)
  if (incompatibilities.length > 0) {
    return result('full-invalidation', {
      reasons: incompatibilities,
      earliestChangedUtcDate: earliestDate(previous.rows, current.rows),
      requiresFullReplay: true,
    })
  }

  const previousByKey = new Map(previous.rows.map((row) => [row.key, row]))
  const currentByKey = new Map(current.rows.map((row) => [row.key, row]))
  const added = current.rows.filter((row) => !previousByKey.has(row.key))
  const removed = previous.rows.filter((row) => !currentByKey.has(row.key))
  const changed = current.rows.filter((row) => {
    const before = previousByKey.get(row.key)
    return before && (
      before.utcDate !== row.utcDate
      || before.scoringDigest !== row.scoringDigest
      || before.artifactDigest !== row.artifactDigest
    )
  })
  const receiptsChanged = previous.scheduleReceiptIdentity !== current.scheduleReceiptIdentity
    || previous.contextReceiptIdentity !== current.contextReceiptIdentity
    || previous.provenanceReceiptIdentity !== current.provenanceReceiptIdentity

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return receiptsChanged
      ? result('metadata-only', { reasons: ['receipt-identity-changed'] })
      : result('no-change')
  }

  const affectedDates = [
    ...added.map((row) => row.utcDate),
    ...removed.map((row) => row.utcDate),
    ...changed.flatMap((row) => [row.utcDate, previousByKey.get(row.key)?.utcDate].filter(isString)),
  ].sort(compareCodeUnits)
  const earliestChangedUtcDate = affectedDates[0]
  const previousLatestDate = previous.rows.map((row) => row.utcDate).sort(compareCodeUnits).at(-1)
  const onlyAdds = removed.length === 0 && changed.length === 0
  const isLatestAppend = onlyAdds && added.every((row) => !previousLatestDate || row.utcDate > previousLatestDate)
  const isSameDayInsertion = onlyAdds && added.every((row) => previous.rows.some((before) => before.utcDate === row.utcDate))
  const kind = isLatestAppend
    ? 'latest-append'
    : isSameDayInsertion
      ? 'same-day-insertion'
      : 'historical-correction'
  const reasons = [
    ...(added.length > 0 ? ['match-added'] : []),
    ...(removed.length > 0 ? ['match-deleted'] : []),
    ...(changed.some((row) => previousByKey.get(row.key)?.utcDate !== row.utcDate) ? ['match-date-moved'] : []),
    ...(changed.some((row) => previousByKey.get(row.key)?.scoringDigest !== row.scoringDigest) ? ['scoring-input-changed'] : []),
    ...(changed.some((row) => previousByKey.get(row.key)?.artifactDigest !== row.artifactDigest) ? ['artifact-input-changed'] : []),
    ...(receiptsChanged ? ['receipt-identity-changed'] : []),
  ]
  return result(kind, {
    earliestChangedUtcDate,
    addedKeys: added.map((row) => row.key),
    removedKeys: removed.map((row) => row.key),
    changedKeys: changed.map((row) => row.key),
    reasons,
  })
}

function result(
  kind: RankingChangeClassification['kind'],
  values: Partial<Omit<RankingChangeClassification, 'kind'>> = {},
): RankingChangeClassification {
  return {
    kind,
    addedKeys: values.addedKeys ?? [],
    removedKeys: values.removedKeys ?? [],
    changedKeys: values.changedKeys ?? [],
    reasons: values.reasons ?? [],
    requiresWholeUtcDateReplay: kind !== 'no-change' && kind !== 'metadata-only',
    requiresFullReplay: values.requiresFullReplay ?? false,
    ...(values.earliestChangedUtcDate ? { earliestChangedUtcDate: values.earliestChangedUtcDate } : {}),
  }
}

function compatibilityDifferences(
  previous: CanonicalMatchLedger,
  current: CanonicalMatchLedger,
  expected: RankingCompatibility,
) {
  const keys = Object.keys(expected) as (keyof RankingCompatibility)[]
  return keys.flatMap((key) => {
    const values = [previous.compatibility[key], current.compatibility[key], expected[key]]
    return values.every((value) => value === values[0]) ? [] : [`${key}-changed`]
  })
}

function compatibilityFrom(context: CanonicalMatchLedgerContext): RankingCompatibility {
  return {
    modelVersion: context.modelVersion,
    modelConfigHash: context.modelConfigHash,
    importerVersion: context.importerVersion,
    identityTaxonomyHash: context.identityTaxonomyHash,
  }
}

function assertCompatibility(context: CanonicalMatchLedgerContext) {
  for (const [key, value] of Object.entries(context)) {
    if (key === 'teams') continue
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Canonical ledger ${key} must be non-empty`)
  }
}

function compareLedgerRows(left: CanonicalMatchLedgerRow, right: CanonicalMatchLedgerRow) {
  return compareCodeUnits(left.utcDate, right.utcDate)
    || compareCodeUnits(left.match.datetimeUtc ?? '', right.match.datetimeUtc ?? '')
    || (left.match.gameNumber ?? 0) - (right.match.gameNumber ?? 0)
    || compareCodeUnits(left.key, right.key)
}

function earliestDate(...groups: readonly CanonicalMatchLedgerRow[][]) {
  return groups.flat().map((row) => row.utcDate).sort(compareCodeUnits)[0]
}

function isString(value: string | undefined): value is string {
  return value !== undefined
}
