import type { TargetDataset } from "../../domains/dps/datasets.ts";
import type { SampleComparison, SimulationResult, Target } from "../../domains/dps/types.ts";

export interface TargetSummaryStat {
  p25: number;
  median: number;
  p75: number;
}

export interface LabDataset extends TargetDataset {
  count: number;
  summary: Record<string, TargetSummaryStat>;
}

export interface CohortPayload {
  dataset: LabDataset;
}

export interface BreakpointPoint {
  armor: number;
  bonusHealth: number;
  a: number;
  b: number;
  delta: number;
}

/** Everything one completed comparison renders from. */
export interface LabResult {
  dataset: LabDataset;
  target: Target;
  a: SimulationResult;
  b: SimulationResult;
  comparison: SampleComparison;
  breakpoints: BreakpointPoint[];
  assumptions: string;
  /** Warnings emitted by the engine for the two simulated builds. */
  modelWarnings: string[];
}

export interface DraftRow {
  key: string;
  label: string;
  detail: string;
  delta: number | null;
  outcome: "a" | "b" | "tie";
  /** Weighted share of that group's decided samples taken by build A. */
  share: number;
  count: number;
  decided: number;
}

export interface ComparisonLabels {
  a: string;
  b: string;
  /** Compact names for chips, tiles and table headers. */
  shortA: string;
  shortB: string;
  singleItem: boolean;
}
