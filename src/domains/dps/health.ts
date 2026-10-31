import { growthAtLevel } from "./math.ts";

export interface BonusHealthEstimate {
  value: number | null;
  status: "derived" | "missing-static" | "clamped";
}

export function deriveBonusHealth(
  actualHealthMax: number,
  level: number,
  baseHealth: number,
  healthPerLevel: number,
): number {
  const estimatedBase = baseHealth + growthAtLevel(healthPerLevel, level);
  return Math.max(0, actualHealthMax - estimatedBase);
}

export function deriveBonusHealthEstimate(
  actualHealthMax: number,
  level: number,
  baseHealth: number | undefined,
  healthPerLevel: number | undefined,
): BonusHealthEstimate {
  if (!Number.isFinite(baseHealth) || !Number.isFinite(healthPerLevel)) {
    return { value: null, status: "missing-static" };
  }
  const raw = actualHealthMax - (baseHealth! + growthAtLevel(healthPerLevel!, level));
  return raw < 0 ? { value: 0, status: "clamped" } : { value: raw, status: "derived" };
}
