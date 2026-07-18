export type ComparablePublicWrite = {
  relativePath: string
  contents: string
}

export type ComparableCrunchOutput = {
  fullSnapshot: unknown | string | Uint8Array
  publicWrites: ComparablePublicWrite[]
}

export type CrunchParityResult =
  | { equal: true }
  | {
      equal: false
      artifact: 'full-snapshot' | 'public-artifact'
      path: string
      byteOffset: number
      expectedByte?: number
      actualByte?: number
      expectedLength: number
      actualLength: number
      missing?: 'expected' | 'actual'
    }

export function compareCrunchOutputs(expected: ComparableCrunchOutput, actual: ComparableCrunchOutput): CrunchParityResult {
  const snapshotDifference = compareBytes(toSnapshotBytes(expected.fullSnapshot), toSnapshotBytes(actual.fullSnapshot))
  if (snapshotDifference) return { equal: false, artifact: 'full-snapshot', path: 'full-snapshot', ...snapshotDifference }

  assertUniquePaths(expected.publicWrites, 'expected')
  assertUniquePaths(actual.publicWrites, 'actual')
  const expectedWrites = expected.publicWrites.toSorted((left, right) => left.relativePath.localeCompare(right.relativePath))
  const actualWrites = actual.publicWrites.toSorted((left, right) => left.relativePath.localeCompare(right.relativePath))
  const paths = [...new Set([...expectedWrites.map((write) => write.relativePath), ...actualWrites.map((write) => write.relativePath)])].sort()
  const expectedByPath = new Map(expectedWrites.map((write) => [write.relativePath, write.contents]))
  const actualByPath = new Map(actualWrites.map((write) => [write.relativePath, write.contents]))
  for (const path of paths) {
    const expectedContents = expectedByPath.get(path)
    const actualContents = actualByPath.get(path)
    if (expectedContents === undefined || actualContents === undefined) {
      return {
        equal: false,
        artifact: 'public-artifact',
        path,
        byteOffset: 0,
        expectedLength: expectedContents === undefined ? 0 : new TextEncoder().encode(expectedContents).length,
        actualLength: actualContents === undefined ? 0 : new TextEncoder().encode(actualContents).length,
        missing: expectedContents === undefined ? 'expected' : 'actual',
      }
    }
    const difference = compareBytes(new TextEncoder().encode(expectedContents), new TextEncoder().encode(actualContents))
    if (difference) return { equal: false, artifact: 'public-artifact', path, ...difference }
  }
  return { equal: true }
}

function assertUniquePaths(writes: ComparablePublicWrite[], side: 'expected' | 'actual'): void {
  const seen = new Set<string>()
  for (const write of writes) {
    if (seen.has(write.relativePath)) throw new Error(`Duplicate ${side} public artifact path: ${write.relativePath}`)
    seen.add(write.relativePath)
  }
}

function toSnapshotBytes(value: unknown | string | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value
  const contents = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`
  return new TextEncoder().encode(contents)
}

function compareBytes(expected: Uint8Array, actual: Uint8Array) {
  const sharedLength = Math.min(expected.length, actual.length)
  for (let byteOffset = 0; byteOffset < sharedLength; byteOffset += 1) {
    if (expected[byteOffset] !== actual[byteOffset]) {
      return {
        byteOffset,
        expectedByte: expected[byteOffset],
        actualByte: actual[byteOffset],
        expectedLength: expected.length,
        actualLength: actual.length,
      }
    }
  }
  if (expected.length === actual.length) return undefined
  return {
    byteOffset: sharedLength,
    ...(sharedLength < expected.length ? { expectedByte: expected[sharedLength] } : {}),
    ...(sharedLength < actual.length ? { actualByte: actual[sharedLength] } : {}),
    expectedLength: expected.length,
    actualLength: actual.length,
  }
}
