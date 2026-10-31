import type { AbilityRanks } from "./types.ts";

export type SkillKey = keyof AbilityRanks;

export interface SkillBounds {
  min: number;
  max: number;
}

/** Legal rank ceilings for a champion at a given level. Rank 0 means not learned yet. */
export function skillBounds(level: number): Record<SkillKey, SkillBounds> {
  const normalized = Math.max(1, Math.min(18, Math.round(level)));
  return {
    q: { min: 0, max: Math.min(5, normalized) },
    w: { min: 0, max: Math.min(5, normalized) },
    e: { min: 0, max: Math.min(5, normalized) },
    r: { min: 0, max: normalized >= 16 ? 3 : normalized >= 11 ? 2 : normalized >= 6 ? 1 : 0 },
  };
}

export function isLegalSkillRanks(ranks: AbilityRanks, level: number): boolean {
  const bounds = skillBounds(level);
  const values = [ranks.q, ranks.w, ranks.e, ranks.r];
  return (
    values.every((value) => Number.isInteger(value) && value >= 0) &&
    ranks.q <= bounds.q.max &&
    ranks.w <= bounds.w.max &&
    ranks.e <= bounds.e.max &&
    ranks.r <= bounds.r.max &&
    values.reduce((sum, value) => sum + value, 0) <= Math.max(1, Math.round(level))
  );
}

/** A deterministic legal fallback: Q first, then W, then E, with normal ultimate breakpoints. */
export function defaultSkillRanks(level: number): AbilityRanks {
  const normalized = Math.max(1, Math.min(18, Math.round(level)));
  const ranks: AbilityRanks = { q: 0, w: 0, e: 0, r: 0 };
  for (let point = 1; point <= normalized; point += 1) {
    if (point === 6 || point === 11 || point === 16) {
      ranks.r += 1;
    } else if (ranks.q < 5) {
      ranks.q += 1;
    } else if (ranks.w < 5) {
      ranks.w += 1;
    } else if (ranks.e < 5) {
      ranks.e += 1;
    }
  }
  return ranks;
}

export function clampSkillRanks(ranks: AbilityRanks, level: number): AbilityRanks {
  const bounds = skillBounds(level);
  const next: AbilityRanks = {
    q: clamp(ranks.q, bounds.q.max),
    w: clamp(ranks.w, bounds.w.max),
    e: clamp(ranks.e, bounds.e.max),
    r: clamp(ranks.r, bounds.r.max),
  };
  while (next.q + next.w + next.e + next.r > Math.max(1, Math.round(level))) {
    const key = (["e", "w", "q", "r"] as const).find((candidate) => next[candidate] > 0);
    if (!key) break;
    next[key] -= 1;
  }
  return next;
}

export function tryAdjustSkillRank(
  ranks: AbilityRanks,
  level: number,
  key: SkillKey,
  delta: number,
): AbilityRanks | null {
  const candidate = { ...ranks, [key]: ranks[key] + Math.sign(delta) };
  return isLegalSkillRanks(candidate, level) ? candidate : null;
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, Number.isFinite(value) ? Math.round(value) : 0));
}
