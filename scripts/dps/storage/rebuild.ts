export interface CompactRowCounts {
  levels: number;
  targets: number;
  scenarios: number;
}

export interface RebuildComparison {
  countMismatch: boolean;
  checksumMissing: boolean;
  checksumMismatch: boolean;
}

export function compareRebuiltProjection(
  expected: CompactRowCounts,
  actual: CompactRowCounts,
  expectedChecksum: string,
  actualChecksum: string | null,
): RebuildComparison {
  return {
    countMismatch:
      expected.levels !== actual.levels ||
      expected.targets !== actual.targets ||
      expected.scenarios !== actual.scenarios,
    checksumMissing: actualChecksum === null,
    checksumMismatch: actualChecksum !== null && actualChecksum !== expectedChecksum,
  };
}
