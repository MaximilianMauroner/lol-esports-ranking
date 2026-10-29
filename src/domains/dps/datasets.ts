import type { AbilityRanks, Target } from "./types.ts";
import type { SkillKey } from "./skills.ts";
import type { ProgressionAggregateResult } from "./progression.ts";

export interface TargetDataset {
  targets: Target[];
  provenance: "riot" | "fixture";
  phase: string;
  fallbackLevel: number;
  note: string;
  distinctMatchCount: number;
  snapshotCount: number;
  availableDistinctMatchCount: number;
  availableSnapshotCount: number;
  truncated: boolean;
  sampleLimitPerMatch: number;
  uniqueChampions: string[];
  uniqueRoles: string[];
  knownRankCount: number;
  collection: { earliest: string | null; latest: string | null };
}

export interface TargetFilters {
  region?: string;
  role?: string;
  champion?: string;
  rank?: string;
  phase?: string;
  limit?: number;
}

export interface ProgressionApiResponse extends ProgressionAggregateResult {
  patch: string;
  dataVersion: string;
  champion: "Yunara";
  provenance: "riot" | "fixture";
  note: string;
  dedupeRule: string;
  requestedLevel: number;
  exactLevel: ProgressionAggregateResult["levels"][number];
  sourceObservationCount: number;
  skill: SkillProgression;
}

export interface SkillProgression {
  requestedLevel: number;
  ranks: AbilityRanks;
  order: SkillKey[];
  sampleCount: number;
  levelsUsed: number[];
  provenance: "timeline" | "legal-fallback";
  note: string;
}
