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
    const dependencyMatch: MatchRecord = {
      ...match,
      teamARoster: undefined,
      teamBRoster: undefined,
    }
    return {
      key,
      utcDate: match.date,
      scoringDigest: stableDigest({ match, teamContext }),
      artifactDigest: stableDigest({ match, teamContext }),
      scheduleReceiptIdentity: context.scheduleReceiptIdentity,
      contextReceiptIdentity: context.contextReceiptIdentity,
      provenanceReceiptIdentity: context.provenanceReceiptIdentity,
      ...(context.providerAvailableAtForMatch?.(match) ? { providerAvailableAt: context.providerAvailableAtForMatch(match) } : {}),
      // Digests above bind the full scored input, including player/roster rows.
      // The persisted dependency projection needs match scope fields, not the
      // large raw roster payloads, and must not alias the live source object.
      match: dependencyMatch,
    }
  }).sort(compareLedgerRows)
  const duplicate = rows.find((row, index) => row.key === rows[index - 1]?.key)
  if (duplicate) throw new Error(`Duplicate canonical match ledger key ${duplicate.key}`)
  const compatibility = compatibilityFrom(context)
  const scheduleCausalRows = [...(context.scheduleCausalRows ?? [])].sort(compareScheduleRows)
  return {
    schemaVersion: CANONICAL_MATCH_LEDGER_SCHEMA_VERSION,
    compatibility,
    scheduleReceiptIdentity: context.scheduleReceiptIdentity,
    contextReceiptIdentity: context.contextReceiptIdentity,
    provenanceReceiptIdentity: context.provenanceReceiptIdentity,
    scheduleCausalRows,
    rows,
    digest: stableDigest({
      compatibility,
      scheduleReceiptIdentity: context.scheduleReceiptIdentity,
      contextReceiptIdentity: context.contextReceiptIdentity,
      provenanceReceiptIdentity: context.provenanceReceiptIdentity,
      scheduleCausalRows,
      rows: rows.map((row) => ({
        key: row.key,
        utcDate: row.utcDate,
        scoringDigest: row.scoringDigest,
        artifactDigest: row.artifactDigest,
        scheduleReceiptIdentity: row.scheduleReceiptIdentity,
        contextReceiptIdentity: row.contextReceiptIdentity,
        provenanceReceiptIdentity: row.provenanceReceiptIdentity,
        providerAvailableAt: row.providerAvailableAt,
      })),
    }),
  }
}

export function parseCanonicalMatchLedger(value: unknown): CanonicalMatchLedger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Canonical match ledger must be an object')
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== CANONICAL_MATCH_LEDGER_SCHEMA_VERSION || !Array.isArray(record.rows)
    || typeof record.digest !== 'string') throw new Error('Canonical match ledger schema is invalid')
  const context = record.compatibility
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('Canonical match ledger compatibility is invalid')
  const compatibilityRecord = context as Record<string, unknown>
  const compatibility: RankingCompatibility = {
    modelVersion: requiredString(compatibilityRecord.modelVersion, 'modelVersion'),
    modelConfigHash: requiredString(compatibilityRecord.modelConfigHash, 'modelConfigHash'),
    importerVersion: requiredString(compatibilityRecord.importerVersion, 'importerVersion'),
    identityTaxonomyHash: requiredString(compatibilityRecord.identityTaxonomyHash, 'identityTaxonomyHash'),
  }
  const rows = record.rows.map((row, index): CanonicalMatchLedgerRow => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`Canonical ledger row ${index} is invalid`)
    const item = row as Record<string, unknown>
    const match = item.match
    if (!match || typeof match !== 'object' || Array.isArray(match)) throw new Error(`Canonical ledger row ${index} match is invalid`)
    return {
      key: requiredString(item.key, `rows[${index}].key`),
      utcDate: requiredString(item.utcDate, `rows[${index}].utcDate`),
      scoringDigest: requiredString(item.scoringDigest, `rows[${index}].scoringDigest`),
      artifactDigest: requiredString(item.artifactDigest, `rows[${index}].artifactDigest`),
      scheduleReceiptIdentity: requiredString(item.scheduleReceiptIdentity, `rows[${index}].scheduleReceiptIdentity`),
      contextReceiptIdentity: requiredString(item.contextReceiptIdentity, `rows[${index}].contextReceiptIdentity`),
      provenanceReceiptIdentity: requiredString(item.provenanceReceiptIdentity, `rows[${index}].provenanceReceiptIdentity`),
      ...(optionalString(item.providerAvailableAt, `rows[${index}].providerAvailableAt`) ? { providerAvailableAt: String(item.providerAvailableAt) } : {}),
      match: match as MatchRecord,
    }
  }).sort(compareLedgerRows)
  const parsed: CanonicalMatchLedger = {
    schemaVersion: CANONICAL_MATCH_LEDGER_SCHEMA_VERSION,
    compatibility,
    scheduleReceiptIdentity: requiredString(record.scheduleReceiptIdentity, 'scheduleReceiptIdentity'),
    contextReceiptIdentity: requiredString(record.contextReceiptIdentity, 'contextReceiptIdentity'),
    provenanceReceiptIdentity: requiredString(record.provenanceReceiptIdentity, 'provenanceReceiptIdentity'),
    scheduleCausalRows: parseScheduleRows(record.scheduleCausalRows),
    rows,
    digest: requiredString(record.digest, 'digest'),
  }
  const rebuilt = stableDigest({
    compatibility,
    scheduleReceiptIdentity: parsed.scheduleReceiptIdentity,
    contextReceiptIdentity: parsed.contextReceiptIdentity,
    provenanceReceiptIdentity: parsed.provenanceReceiptIdentity,
    scheduleCausalRows: parsed.scheduleCausalRows,
    rows: rows.map((row) => ({
      key: row.key, utcDate: row.utcDate, scoringDigest: row.scoringDigest, artifactDigest: row.artifactDigest,
      scheduleReceiptIdentity: row.scheduleReceiptIdentity, contextReceiptIdentity: row.contextReceiptIdentity,
      provenanceReceiptIdentity: row.provenanceReceiptIdentity,
      providerAvailableAt: row.providerAvailableAt,
    })),
  })
  if (rebuilt !== parsed.digest) throw new Error('Canonical match ledger digest mismatch')
  return parsed
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
  const scheduleChange = compareScheduleCausality(previous, current)
  const contextChanged = previous.contextReceiptIdentity !== current.contextReceiptIdentity
  const provenanceChanged = previous.provenanceReceiptIdentity !== current.provenanceReceiptIdentity

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    if (contextChanged) {
      return result('full-invalidation', {
        reasons: ['causal-context-changed'],
        earliestChangedUtcDate: earliestDate(previous.rows, current.rows),
        requiresFullReplay: true,
      })
    }
    if (scheduleChange.changed) {
      if (!scheduleChange.earliestChangedUtcDate) {
        return result('full-invalidation', { reasons: ['schedule-context-changed-without-date'], requiresFullReplay: true })
      }
      return result(scheduleChange.onlyFutureAdds ? 'latest-append' : 'historical-correction', {
        reasons: [scheduleChange.onlyFutureAdds ? 'schedule-context-appended' : 'schedule-context-changed'],
        earliestChangedUtcDate: scheduleChange.earliestChangedUtcDate,
      })
    }
    return provenanceChanged
      ? result('metadata-only', { reasons: ['provenance-receipt-changed'] })
      : result('no-change')
  }

  const affectedDates = [
    ...added.map((row) => row.utcDate),
    ...removed.map((row) => row.utcDate),
    ...changed.flatMap((row) => [row.utcDate, previousByKey.get(row.key)?.utcDate].filter(isString)),
    ...(scheduleChange.earliestChangedUtcDate ? [scheduleChange.earliestChangedUtcDate] : []),
  ].sort(compareCodeUnits)
  const earliestChangedUtcDate = affectedDates[0]
  const previousLatestDate = previous.rows.map((row) => row.utcDate).sort(compareCodeUnits).at(-1)
  const onlyAdds = removed.length === 0 && changed.length === 0 && (!scheduleChange.changed || scheduleChange.onlyFutureAdds)
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
    ...(scheduleChange.changed ? [scheduleChange.onlyFutureAdds ? 'schedule-context-appended' : 'schedule-context-changed'] : []),
    ...(contextChanged ? ['causal-context-changed'] : []),
    ...(provenanceChanged ? ['provenance-receipt-changed'] : []),
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
    if (key === 'teams' || key === 'scheduleCausalRows' || key === 'providerAvailableAtForMatch') continue
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Canonical ledger ${key} must be non-empty`)
  }
}

function compareScheduleCausality(previous: CanonicalMatchLedger, current: CanonicalMatchLedger) {
  if (previous.scheduleReceiptIdentity === current.scheduleReceiptIdentity
    && stableDigest(previous.scheduleCausalRows) === stableDigest(current.scheduleCausalRows)) {
    return { changed: false, onlyFutureAdds: false }
  }
  const before = new Map(previous.scheduleCausalRows.map((row) => [row.key, row]))
  const after = new Map(current.scheduleCausalRows.map((row) => [row.key, row]))
  const added = current.scheduleCausalRows.filter((row) => !before.has(row.key))
  const removed = previous.scheduleCausalRows.filter((row) => !after.has(row.key))
  const changed = current.scheduleCausalRows.filter((row) => {
    const prior = before.get(row.key)
    return prior && (prior.digest !== row.digest || prior.utcDate !== row.utcDate)
  })
  const dates = [
    ...added.map((row) => row.utcDate),
    ...removed.map((row) => row.utcDate),
    ...changed.flatMap((row) => [row.utcDate, before.get(row.key)?.utcDate]),
  ].filter(isString).sort(compareCodeUnits)
  const previousLatestDate = previous.scheduleCausalRows.map((row) => row.utcDate).filter(isString).sort(compareCodeUnits).at(-1)
  const onlyFutureAdds = removed.length === 0 && changed.length === 0 && added.length > 0
    && added.every((row) => row.utcDate && (!previousLatestDate || row.utcDate > previousLatestDate))
  return { changed: true, onlyFutureAdds: Boolean(onlyFutureAdds), earliestChangedUtcDate: dates[0] }
}

function parseScheduleRows(value: unknown) {
  if (!Array.isArray(value)) throw new Error('Canonical match ledger schedule causal rows are invalid')
  const rows = value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Canonical schedule row ${index} is invalid`)
    const record = entry as Record<string, unknown>
    return {
      key: requiredString(record.key, `scheduleCausalRows[${index}].key`),
      ...(optionalString(record.utcDate, `scheduleCausalRows[${index}].utcDate`) ? { utcDate: String(record.utcDate) } : {}),
      digest: requiredString(record.digest, `scheduleCausalRows[${index}].digest`),
    }
  }).sort(compareScheduleRows)
  const duplicate = rows.find((row, index) => row.key === rows[index - 1]?.key)
  if (duplicate) throw new Error(`Duplicate canonical schedule row ${duplicate.key}`)
  return rows
}

function compareScheduleRows(left: { key: string; utcDate?: string }, right: { key: string; utcDate?: string }) {
  return compareCodeUnits(left.utcDate ?? '', right.utcDate ?? '') || compareCodeUnits(left.key, right.key)
}

function optionalString(value: unknown, label: string) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a non-empty string when present`)
  return value
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

function requiredString(value: unknown, label: string) {
  if (typeof value !== 'string' || !value) throw new Error(`Canonical match ledger ${label} must be a non-empty string`)
  return value
}
