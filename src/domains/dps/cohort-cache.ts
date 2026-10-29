/** Enough headroom to return the full current Yunara level corpus (1,330 vectors). */
export const MAX_LEVEL_COHORT_TARGETS = 2_000;

export interface ManualCohortTarget {
  health: number;
  armor: number;
  magicResist: number;
  bonusHealth: number;
  level: number;
}

export interface CohortRequestKeyInput {
  targetMode: "realistic" | "manual";
  region: string;
  rank: string;
  phase: string;
  role: string;
  targetChampion: string;
  level: number;
  manual: ManualCohortTarget;
}

/**
 * Only server/cohort inputs belong in this key. Optimizer objective, slot
 * constraints, combo controls, ranks, and Yun Tal stacks intentionally stay
 * out so those local searches reuse the already fetched target cohort.
 */
export function cohortRequestKey(input: CohortRequestKeyInput): string {
  return JSON.stringify({
    targetMode: input.targetMode,
    region: input.region,
    rank: input.rank,
    phase: input.phase,
    role: input.role,
    targetChampion: input.targetChampion,
    level: input.level,
    manual: input.manual,
  });
}
