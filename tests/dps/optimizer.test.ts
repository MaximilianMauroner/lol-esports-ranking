import { describe, expect, test } from "vitest";
import { ITEMS } from "../../src/domains/dps/items.ts";
import {
  canonicalBuildIdentity,
  canonicalBuildKey,
  canonicalizeBuild,
  generateCandidateBuilds,
  generateLegalBuilds,
  isLegalBuild,
  OPTIMIZER_COVERAGE,
  OPTIMIZER_ELIGIBLE_ITEM_IDS,
  OPTIMIZER_EXCLUDED_ITEM_IDS,
  OPTIMIZER_MODELED_NO_EFFECT_ITEM_IDS,
  optimizerContinuationForObjective,
  optimizerEligibleItemIds,
  resolveOptimizerEligibility,
  sameBuildIdentity,
  validateBuild,
} from "../../src/domains/dps/optimizer.ts";

describe("optimizer build identity", () => {
  test("is order-insensitive without mutating the source build", () => {
    const build = { name: "UI order", itemIds: [3085, 3006, 3031] };
    expect(canonicalBuildKey(build)).toBe("3006,3031,3085");
    expect(canonicalBuildIdentity([3031, 3085, 3006])).toBe("3006,3031,3085");
    expect(sameBuildIdentity(build, { name: "Different label", itemIds: [3006, 3031, 3085] })).toBe(
      true,
    );
    expect(build.itemIds).toEqual([3085, 3006, 3031]);
    expect(canonicalizeBuild(build)).toEqual({
      name: "UI order",
      itemIds: [3006, 3031, 3085],
    });
  });

  test("does not collapse duplicate IDs into a legal identity", () => {
    expect(canonicalBuildKey([3031, 3031, 3085])).toBe("3031,3031,3085");
    expect(sameBuildIdentity([3031, 3031], [3031])).toBe(false);
  });
});

describe("optimizer eligibility", () => {
  test("uses the curated mechanics catalog and reports unknown or repeated input", () => {
    const result = resolveOptimizerEligibility([3031, 3032, 3031, 999999]);
    expect(result.eligibleItemIds).toEqual([3031, 3032]);
    expect(result.duplicateItemIds).toEqual([3031]);
    expect(result.unsupportedItemIds).toEqual([999999]);
    expect(result.excludedUnsupportedItemIds).toEqual([]);
    expect(result.excludedPartialItemIds).toEqual([]);
    expect(optimizerEligibleItemIds()).toEqual(OPTIMIZER_ELIGIBLE_ITEM_IDS);
    expect(OPTIMIZER_COVERAGE).toHaveLength(Object.keys(ITEMS).length);
    expect(OPTIMIZER_COVERAGE.filter((item) => item.status === "trusted")).toHaveLength(17);
    expect(
      OPTIMIZER_COVERAGE.filter((item) => item.status === "excluded-unsupported"),
    ).toHaveLength(0);
    expect(
      OPTIMIZER_COVERAGE.filter((item) => item.status === "trusted").map((item) => item.id),
    ).toEqual([
      2512, 2523, 3006, 3008, 3026, 3031, 3032, 3033, 3036, 3046, 3072, 3085, 3095, 3139, 3153,
      3302, 6672,
    ]);
    expect(OPTIMIZER_COVERAGE.map((item) => `${item.id}:${item.name}`)).toEqual([
      "2512:Fiendhunter Bolts",
      "2523:Hexoptics C44",
      "3006:Berserker's Greaves",
      "3008:Gluttonous Greaves",
      "3026:Guardian Angel",
      "3031:Infinity Edge",
      "3032:Yun Tal Wildarrows",
      "3033:Mortal Reminder",
      "3036:Lord Dominik's Regards",
      "3046:Phantom Dancer",
      "3072:Bloodthirster",
      "3085:Runaan's Hurricane",
      "3095:Stormrazor",
      "3139:Mercurial Scimitar",
      "3153:Blade of The Ruined King",
      "3302:Terminus",
      "6672:Kraken Slayer",
    ]);
    expect(OPTIMIZER_EXCLUDED_ITEM_IDS).toEqual([]);
    expect(OPTIMIZER_MODELED_NO_EFFECT_ITEM_IDS).toEqual([3008]);
    expect(resolveOptimizerEligibility([3008, 999999]).eligibleItemIds).toEqual([3008]);
    expect(resolveOptimizerEligibility([3008, 999999]).excludedUnsupportedItemIds).toEqual([]);
  });
});

describe("optimizer objective handoff", () => {
  test("uses the same continuation semantics in Compare as in optimization", () => {
    expect(optimizerContinuationForObjective("sustained-dps", false)).toBe(true);
    expect(optimizerContinuationForObjective("burst-damage", true)).toBe(false);
    expect(optimizerContinuationForObjective("fixed-window-damage", false)).toBe(false);
    expect(optimizerContinuationForObjective("ttk", true)).toBe(true);
  });
});

describe("legal exhaustive candidate generation", () => {
  const pool = [3006, 3008, 3031, 3032, 3036];

  test("generates every three-slot one-boot combination once", () => {
    const candidates = generateLegalBuilds({
      eligibleItemIds: pool,
      allowPartialItems: true,
      constraints: { slotCount: 3, bootRule: "required" },
    });
    const identities = candidates.map((candidate) => canonicalBuildKey(candidate));

    expect(candidates).toHaveLength(6); // 2 boots × C(3 non-boots, 2)
    expect(new Set(identities).size).toBe(6);
    expect(
      candidates.every(
        (candidate) => candidate.itemIds.includes(3006) || candidate.itemIds.includes(3008),
      ),
    ).toBe(true);
    expect(
      candidates.every(
        (candidate) =>
          validateBuild(candidate, {
            eligibleItemIds: pool,
            allowPartialItems: true,
            constraints: { slotCount: 3, bootRule: "required" },
          }).legal,
      ),
    ).toBe(true);
  });

  test("applies required, excluded, duplicate, and budget constraints", () => {
    const candidates = generateCandidateBuilds({
      eligibleItemIds: [3006, 3031, 3032, 3036, 3085, 6672],
      constraints: {
        slotCount: 4,
        bootRule: "required",
        requiredItemIds: [3031, 3032],
        excludedItemIds: [3036],
        maxGold: 12_000,
      },
    });

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((candidate) => candidate.itemIds.includes(3031))).toBe(true);
    expect(candidates.every((candidate) => candidate.itemIds.includes(3032))).toBe(true);
    expect(candidates.every((candidate) => !candidate.itemIds.includes(3036))).toBe(true);
    expect(candidates.every((candidate) => candidate.goldTotal <= 12_000)).toBe(true);
    expect(candidates.map((candidate) => candidate.identity)).toEqual(
      [...candidates].map((candidate) => canonicalBuildKey(candidate)),
    );
    expect(
      isLegalBuild([3006, 3031, 3031, 3032], {
        eligibleItemIds: [3006, 3031, 3032],
        constraints: { slotCount: 4, bootRule: "required" },
      }),
    ).toBe(false);
  });

  test("supports optional and forbidden boots without weakening uniqueness", () => {
    const optional = generateLegalBuilds({
      eligibleItemIds: pool,
      allowPartialItems: true,
      constraints: { slotCount: 2, bootRule: "optional" },
    });
    const forbidden = generateLegalBuilds({
      eligibleItemIds: pool,
      allowPartialItems: true,
      constraints: { slotCount: 2, bootRule: "forbidden" },
    });

    expect(optional).toHaveLength(9); // C(5, 2), excluding the illegal two-boots pair.
    expect(forbidden).toHaveLength(3); // C(3 non-boots, 2).
    expect(forbidden.every((candidate) => !candidate.itemIds.some((id) => ITEMS[id]?.boots))).toBe(
      true,
    );
  });

  test("default full-build enumeration is exhaustive over the curated pool", () => {
    const candidates = generateLegalBuilds();
    const nonBootCount = optimizerEligibleItemIds().filter((id) => !ITEMS[id]?.boots).length;
    const bootCount = optimizerEligibleItemIds().filter((id) => ITEMS[id]?.boots).length;
    const expected = bootCount * combinationCount(nonBootCount, 5);

    expect(candidates).toHaveLength(expected);
    expect(new Set(candidates.map((candidate) => canonicalBuildKey(candidate))).size).toBe(
      expected,
    );
    expect(candidates.every((candidate) => candidate.itemIds.length === 6)).toBe(true);
    expect(
      candidates.every((candidate) =>
        candidate.itemIds.every((id) =>
          OPTIMIZER_ELIGIBLE_ITEM_IDS.some((eligibleId) => eligibleId === id),
        ),
      ),
    ).toBe(true);
    expect(
      candidates.every(
        (candidate) => candidate.itemIds.filter((id) => ITEMS[id]?.boots).length === 1,
      ),
    ).toBe(true);
  });

  test("admits every pinned catalog item without a partial-coverage escape hatch", () => {
    const requested = [3006, 3008, 3031, 3032];
    expect(optimizerEligibleItemIds(ITEMS, requested)).toEqual(requested);
    expect(
      generateLegalBuilds({
        eligibleItemIds: requested,
        constraints: { slotCount: 2, bootRule: "required" },
      }).some((build) => build.itemIds.includes(3008)),
    ).toBe(true);
  });
});

describe("optimizer synergy regressions", () => {
  test("keeps synergistic Yun Tal, crit, penetration, and on-hit choices in the search", () => {
    const candidates = generateLegalBuilds({
      eligibleItemIds: [3006, 3031, 3032, 3036, 3085, 6672],
      constraints: { slotCount: 6, bootRule: "required" },
    });
    const identity = "3006,3031,3032,3036,3085,6672";

    expect(candidates.some((candidate) => canonicalBuildKey(candidate) === identity)).toBe(true);
    expect(
      candidates.some(
        (candidate) =>
          candidate.itemIds.includes(3031) &&
          candidate.itemIds.includes(3032) &&
          candidate.itemIds.includes(3085),
      ),
    ).toBe(true);
  });

  test("retains a synergy partner even when it contributes no standalone crit stat", () => {
    const candidates = generateLegalBuilds({
      eligibleItemIds: [3006, 3031, 3032, 3085],
      constraints: { slotCount: 4, bootRule: "required" },
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.itemIds).toEqual([3006, 3031, 3032, 3085]);
  });
});

function combinationCount(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let index = 1; index <= k; index += 1) {
    result = (result * (n - k + index)) / index;
  }
  return result;
}
