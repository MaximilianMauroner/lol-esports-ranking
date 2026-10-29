export type DamageType = "physical" | "magic" | "true";
export type ActionKind = "AA" | "Q" | "W" | "R" | "E";

export interface AbilityRanks {
  q: number;
  w: number;
  e: number;
  r: number;
}

export interface Build {
  name: string;
  itemIds: number[];
}

/**
 * Objectives the optimizer can rank once it is connected to the simulator.
 *
 * The first slice only defines the domain contract; scoring and cohort
 * evaluation remain separate from candidate generation.
 */
export type OptimizerObjective = "sustained-dps" | "fixed-window-damage" | "burst-damage" | "ttk";
export type OptimizerMetric = "dps" | "damage" | "ttk";

/** The allowed boot policies for a generated full build. */
export type OptimizerBootRule = "required" | "optional" | "forbidden";

/**
 * Coverage is about the declared single-target damage scope, not whether an
 * item is complete in the game. A trusted item is safe for exhaustive search;
 * `modeled-no-effect` records mechanics which cannot change this scenario.
 */
export type OptimizerCoverageStatus = "trusted" | "excluded-unsupported";
export type OptimizerCoverageScope = "damage-modeled" | "modeled-no-effect";

export interface OptimizerCoverageItem {
  id: number;
  name: string;
  status: OptimizerCoverageStatus;
  scope: OptimizerCoverageScope;
  reason: string;
}

export interface OptimizerConstraints {
  /** Exact number of completed items in each generated build. */
  slotCount: number;
  /** Defaults to the optimizer's realistic six-slot policy. */
  bootRule?: OptimizerBootRule;
  /** Compatibility shorthand for callers that only need a boolean rule. */
  requireBoots?: boolean;
  /** Legal completed builds contain at most one boot item. */
  maxBoots?: number;
  /** Optional total completed-item budget. */
  maxGold?: number;
  /** Optional lower bound for staged/equal-budget searches. */
  minGold?: number;
  /** Items that must be present in every candidate. */
  requiredItemIds?: readonly number[];
  /** Items that must not be present in any candidate. */
  excludedItemIds?: readonly number[];
}

export interface OptimizerGenerationOptions {
  /** Explicit curated item pool. Omitted means the domain catalog allowlist. */
  eligibleItemIds?: readonly number[];
  constraints?: Partial<OptimizerConstraints>;
  /**
   * Experimental escape hatch for tests/research using catalog items whose
   * material mechanics are not in trusted coverage. Production searches leave
   * this false so partial items cannot enter by accident.
   */
  allowPartialItems?: boolean;
}

export interface OptimizerCandidate extends Build {
  /** Stable identity derived only from the canonical item IDs. */
  identity: string;
  goldTotal: number;
}

export interface OptimizerEligibility {
  eligibleItemIds: number[];
  unsupportedItemIds: number[];
  excludedUnsupportedItemIds: number[];
  /** @deprecated Use excludedUnsupportedItemIds. */
  excludedPartialItemIds: number[];
  duplicateItemIds: number[];
}

export type BuildValidationReason =
  | "wrong-slot-count"
  | "unsupported-item"
  | "ineligible-item"
  | "duplicate-item"
  | "boots-required"
  | "boots-forbidden"
  | "too-many-boots"
  | "required-item-missing"
  | "excluded-item"
  | "above-max-gold"
  | "below-min-gold";

export interface BuildValidation {
  legal: boolean;
  reasons: BuildValidationReason[];
  totalGold: number;
  bootCount: number;
}

export interface OptimizerEvaluationContext {
  base: Omit<SimulationInput, "build" | "target">;
  targets: readonly Target[];
  objective: OptimizerObjective;
  candidateOptions?: OptimizerGenerationOptions;
}

export interface OptimizerTargetEvaluation {
  target: Target;
  result: SimulationResult;
  weight: number;
}

export interface OptimizerBuildEvaluation {
  candidate: OptimizerCandidate;
  objective: OptimizerObjective;
  /** The objective's primary value; null means no TTK sample killed. */
  score: number | null;
  weightedDamage: number;
  weightedDps: number;
  totalWeight: number;
  killCoverage: number;
  censoredCoverage: number;
  killedCount: number;
  censoredCount: number;
  meanTtk: number | null;
  warnings: string[];
  rows: OptimizerTargetEvaluation[];
}

export interface OptimizerRankedBuild extends Omit<OptimizerBuildEvaluation, "rows"> {
  rank: number;
}

export interface OptimizerSearchResult {
  objective: OptimizerObjective;
  contextHash: string;
  candidateCount: number;
  evaluatedCount: number;
  rankings: OptimizerRankedBuild[];
}

export interface Target {
  id: string;
  champion: string;
  role?: string;
  rank?: string;
  health: number;
  armor: number;
  magicResist: number;
  bonusHealth: number;
  bonusHealthStatus?: "derived" | "missing-static" | "clamped" | "unknown";
  level: number;
  minute?: number;
  itemIds?: number[];
  sampleWeight?: number;
  /** Short opaque match key used only for match-balanced aggregation. */
  sourceMatchKey?: string;
  anchorEventTimestampMs?: number;
  anchorFrameDistanceMs?: number;
  provenance?: "fixture" | "riot";
}

export interface SimulationInput {
  level: number;
  ranks: AbilityRanks;
  build: Build;
  target: Target;
  durationSeconds: number;
  actions: readonly ActionKind[];
  continueAutos: boolean;
  /** Starting ranged Yun Tal Wildarrows stacks (0–125). Match-V5 does not expose this state. */
  yunTalStacks?: number;
  /** Mortal targets are the default. `uncapped` is an explicit training-dummy mode. */
  targetMode?: "mortal" | "uncapped";
  /** Yunara is ranged; cohorts do not contain positions, so 500 is the default. */
  attackDistance?: number;
  /** Energize stacks carried into this window; omitted means an uncharged item. */
  stormrazorStacks?: number;
  /** Units travelled per second for Energize generation; omitted means stationary. */
  movementUnitsPerSecond?: number;
  /** External haste/buff state, if a caller is modeling a non-item source. */
  abilityHaste?: number;
  /** External ultimate-only haste/buff state, if supplied by a caller. */
  ultimateAbilityHaste?: number;
  /** Internal performance switch; damage totals and kill state remain identical. */
  includeEvents?: boolean;
  /** Internal performance switch for callers that already render coverage assumptions. */
  includeWarnings?: boolean;
}

export interface DamageEvent {
  time: number;
  source: string;
  type: DamageType;
  raw: number;
  resistance: number;
  multiplier: number;
  /** Damage attempted after mitigation and item modifiers, before target-health capping. */
  attemptedFinal: number;
  final: number;
  /** Overkill is reported separately and is never counted in totalDamage. */
  overkill: number;
  targetHealthAfter: number;
  notes: string[];
}

export interface SimulationResult {
  build: string;
  totalDamage: number;
  dps: number;
  ttk: number | null;
  split: Record<DamageType, number>;
  sources: Record<string, number>;
  events: DamageEvent[];
  killed: boolean;
  /** True when the target was not killed before the configured window (mortal mode). */
  censored: boolean;
  overkill: number;
  targetMode: "mortal" | "uncapped";
  warnings: string[];
  stats: {
    attackDamage: number;
    attackSpeed: number;
    abilityHaste: number;
    ultimateAbilityHaste: number;
    critChance: number;
    critDamage: number;
    armorPenPercent: number;
    yunTalStacksStart: number;
    yunTalStacksEnd: number;
    yunTalCritChanceStart: number;
    yunTalCritChanceEnd: number;
    flurryActivations: number;
    fiendhunterAttacksStart: number;
    fiendhunterAttacksEnd: number;
    stormrazorStacksStart: number;
    stormrazorStacksEnd: number;
    stormrazorProcs: number;
    terminusLightStacksEnd: number;
    terminusDarkStacksEnd: number;
  };
}

export interface SampleComparison {
  metric: "damage" | "ttk";
  count: number;
  distinctMatchCount: number;
  totalWeight: number;
  /** Weighted outcome mass; ties and censored rows are neutral for winner selection. */
  weightedOutcomes: {
    a: number;
    b: number;
    tie: number;
    censored: number;
  };
  buildAWinRate: number;
  medianRelativeDelta: number;
  p25RelativeDelta: number;
  p75RelativeDelta: number;
  aWins: number;
  bWins: number;
  ties: number;
  censored: number;
  aNotKilled: number;
  bNotKilled: number;
  /** `decided` counts the rows that were not a tie or censored; a group with none has no winner. */
  byRole: Array<{ role: string; count: number; decided: number; buildAWinRate: number }>;
  byChampion: Array<{ champion: string; count: number; decided: number; buildAWinRate: number }>;
  rows: Array<{
    target: Target;
    a: SimulationResult;
    b: SimulationResult;
    relativeDelta: number;
    metricDelta: number | null;
    outcome: "a" | "b" | "tie" | "censored";
  }>;
}
