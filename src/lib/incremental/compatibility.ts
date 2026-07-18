import { stableHash } from './hash'
import { PRIVATE_CRUNCH_SCHEMA_VERSION, type IncrementalFallbackReason } from './types'

export type CrunchCompatibility = {
  schemaVersion: typeof PRIVATE_CRUNCH_SCHEMA_VERSION
  dependencies: Record<string, string>
  hash: string
}

export function createCrunchCompatibility(dependencies: Record<string, unknown>): CrunchCompatibility {
  const hashes = Object.fromEntries(
    Object.entries(dependencies)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, stableHash(value)]),
  )
  return {
    schemaVersion: PRIVATE_CRUNCH_SCHEMA_VERSION,
    dependencies: hashes,
    hash: stableHash({ schemaVersion: PRIVATE_CRUNCH_SCHEMA_VERSION, dependencies: hashes }),
  }
}

export function compatibilityFallback(
  expected: CrunchCompatibility,
  actual: CrunchCompatibility | undefined,
): IncrementalFallbackReason | undefined {
  if (!actual || actual.schemaVersion !== expected.schemaVersion) {
    return {
      kind: 'private-schema-incompatible',
      expected: expected.schemaVersion,
      ...(actual ? { actual: actual.schemaVersion } : {}),
    }
  }
  const computedActualHash = stableHash({ schemaVersion: actual.schemaVersion, dependencies: actual.dependencies })
  if (actual.hash !== computedActualHash) {
    return {
      kind: 'compatibility-hash-mismatch',
      dependency: 'compatibility-envelope',
      expected: computedActualHash,
      actual: actual.hash,
    }
  }
  const dependencyKeys = [...new Set([
    ...Object.keys(expected.dependencies),
    ...Object.keys(actual.dependencies),
  ])].sort()
  for (const dependency of dependencyKeys) {
    const expectedHash = expected.dependencies[dependency]
    const actualHash = actual.dependencies[dependency]
    if (expectedHash === undefined) {
      return {
        kind: 'compatibility-hash-mismatch',
        dependency,
        expected: '<absent>',
        actual: actualHash,
      }
    }
    if (actualHash !== expectedHash) {
      return {
        kind: 'compatibility-hash-mismatch',
        dependency,
        expected: expectedHash,
        ...(actualHash ? { actual: actualHash } : {}),
      }
    }
  }
  return undefined
}
