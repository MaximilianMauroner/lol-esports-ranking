import { compareCodeUnits } from './types'

export type SemanticArtifactIdentity = {
  digest: string
  generationId?: string
  provenanceDigest?: string
}

export type SemanticArtifactMap = Readonly<Record<string, SemanticArtifactIdentity>>

export type SemanticArtifactMismatch =
  | { kind: 'missing'; logicalPath: string; expected: SemanticArtifactIdentity }
  | { kind: 'unexpected'; logicalPath: string; actual: SemanticArtifactIdentity }
  | { kind: 'digest-mismatch'; logicalPath: string; expected: SemanticArtifactIdentity; actual: SemanticArtifactIdentity }
  | { kind: 'generation-provenance-mismatch'; logicalPath: string; expected: SemanticArtifactIdentity; actual: SemanticArtifactIdentity }

export type SemanticArtifactParityReport = {
  equal: boolean
  comparedLogicalPathCount: number
  mismatches: SemanticArtifactMismatch[]
}

export function compareSemanticArtifactMaps(
  expected: SemanticArtifactMap,
  actual: SemanticArtifactMap,
): SemanticArtifactParityReport {
  const logicalPaths = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort(compareCodeUnits)
  const mismatches: SemanticArtifactMismatch[] = []
  for (const logicalPath of logicalPaths) {
    const expectedIdentity = expected[logicalPath]
    const actualIdentity = actual[logicalPath]
    if (!actualIdentity && expectedIdentity) {
      mismatches.push({ kind: 'missing', logicalPath, expected: expectedIdentity })
    } else if (!expectedIdentity && actualIdentity) {
      mismatches.push({ kind: 'unexpected', logicalPath, actual: actualIdentity })
    } else if (expectedIdentity && actualIdentity && expectedIdentity.digest !== actualIdentity.digest) {
      mismatches.push({ kind: 'digest-mismatch', logicalPath, expected: expectedIdentity, actual: actualIdentity })
    } else if (expectedIdentity && actualIdentity && (
      expectedIdentity.generationId !== actualIdentity.generationId
      || expectedIdentity.provenanceDigest !== actualIdentity.provenanceDigest
    )) {
      mismatches.push({
        kind: 'generation-provenance-mismatch',
        logicalPath,
        expected: expectedIdentity,
        actual: actualIdentity,
      })
    }
  }
  return { equal: mismatches.length === 0, comparedLogicalPathCount: logicalPaths.length, mismatches }
}

export function changedSemanticArtifactPaths(
  previous: SemanticArtifactMap,
  current: SemanticArtifactMap,
) {
  return compareSemanticArtifactMaps(previous, current).mismatches
    .map((mismatch) => mismatch.logicalPath)
    .sort(compareCodeUnits)
}
