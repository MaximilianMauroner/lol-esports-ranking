import { describe, expect, test } from "vitest";
import { cohortRequestKey, type CohortRequestKeyInput } from "../../src/domains/dps/cohort-cache.ts";

const cohort = (): CohortRequestKeyInput => ({
  targetMode: "realistic",
  region: "EUW1",
  rank: "ALL",
  phase: "yunara-level",
  role: "ALL",
  targetChampion: "",
  level: 13,
  manual: { health: 2200, armor: 100, magicResist: 60, bonusHealth: 500, level: 13 },
});

describe("optimizer cohort request reuse", () => {
  test("local optimizer changes keep one fetched cohort while filters fetch again", () => {
    const requests: string[] = [];
    let cachedKey = "";
    const load = (input: CohortRequestKeyInput) => {
      const key = cohortRequestKey(input);
      if (key !== cachedKey) {
        cachedKey = key;
        requests.push(key);
      }
    };

    const base = cohort();
    // These are all optimizer-local inputs and intentionally do not belong in
    // CohortRequestKeyInput: objective, slots, combo, legal ranks, and Yun Tal
    // stacks are evaluated against the same target vectors.
    const optimizerLocalVariants = [
      { objective: "sustained-dps" },
      { objective: "burst-damage", slotCount: 3 },
      { objective: "ttk", actions: ["R", "Q"], ranks: { q: 5, w: 5, e: 2, r: 2 } },
      { objective: "fixed-window-damage", yunTalStacks: 75, slotCount: 5 },
    ];
    optimizerLocalVariants.forEach(() => load(base));
    expect(requests).toHaveLength(1);

    load({ ...base, level: 16 });
    load({ ...base, level: 16, role: "TOP" });
    load({ ...base, level: 16, role: "TOP", targetChampion: "Ornn" });
    expect(requests).toHaveLength(4);
  });

  test("manual target values are part of the cohort identity", () => {
    const base = cohort();
    expect(cohortRequestKey(base)).not.toBe(
      cohortRequestKey({
        ...base,
        targetMode: "manual",
        manual: { ...base.manual, armor: 200 },
      }),
    );
  });
});
