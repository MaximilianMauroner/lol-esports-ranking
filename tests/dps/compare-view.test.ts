import { describe, expect, test } from "vitest";
import {
  breakpointGrid,
  buildDiff,
  comparisonLabels,
  groupSlices,
  sliceRow,
  sliceTier,
  slotEditorModel,
  summarizeWindow,
  traceCycles,
} from "../../src/domains/dps/compare-view.ts";
import type { DamageEvent, SampleComparison } from "../../src/domains/dps/types.ts";

function comparison(overrides: Partial<SampleComparison> = {}): SampleComparison {
  return {
    metric: "damage",
    count: 20,
    distinctMatchCount: 8,
    totalWeight: 20,
    weightedOutcomes: { a: 7, b: 5, tie: 8, censored: 0 },
    buildAWinRate: 0.58,
    medianRelativeDelta: 0,
    p25RelativeDelta: 0,
    p75RelativeDelta: 2.37,
    aWins: 7,
    bWins: 5,
    ties: 8,
    censored: 0,
    aNotKilled: 12,
    bNotKilled: 12,
    byRole: [],
    byChampion: [],
    rows: [],
    ...overrides,
  } as SampleComparison;
}

describe("buildDiff", () => {
  test("separates the shared core from the item under test", () => {
    const diff = buildDiff([6672, 3085, 3006, 3031], [6672, 3085, 3006, 3036]);
    expect(diff.shared).toEqual([6672, 3085, 3006]);
    expect(diff.onlyA).toEqual([3031]);
    expect(diff.onlyB).toEqual([3036]);
  });

  test("treats a repeated item as shared only once", () => {
    const diff = buildDiff([3031, 3031], [3031]);
    expect(diff.shared).toEqual([3031]);
    expect(diff.onlyA).toEqual([3031]);
    expect(diff.onlyB).toEqual([]);
  });
});

describe("comparisonLabels", () => {
  test("names the two items when exactly one differs per side", () => {
    const labels = comparisonLabels(buildDiff([6672, 3031], [6672, 3036]), {
      a: "Build A",
      b: "Build B",
    });
    expect(labels).toMatchObject({
      a: "Infinity Edge",
      b: "Lord Dominik's Regards",
      singleItem: true,
    });
  });

  test("falls back to build names when more than one item differs", () => {
    const labels = comparisonLabels(buildDiff([6672, 3031], [3085, 3036]), {
      a: "Kraken Slayer + Infinity Edge",
      b: "Runaan's Hurricane + Lord Dominik's Regards",
    });
    expect(labels.singleItem).toBe(false);
    expect(labels.a).toBe("Kraken Slayer + Infinity Edge");
    expect(labels.shortA).toBe("Build A");
  });
});

describe("summarizeWindow", () => {
  test("reports the weighted leader", () => {
    expect(summarizeWindow(5, comparison()).verdict).toBe("a");
  });

  test("a damage window in which both builds kill every target is not a tie between items", () => {
    const summary = summarizeWindow(
      10,
      comparison({
        weightedOutcomes: { a: 0, b: 0, tie: 20, censored: 0 },
        aWins: 0,
        bWins: 0,
        ties: 20,
        aNotKilled: 0,
        bNotKilled: 0,
      }),
    );
    expect(summary.verdict).toBe("all-killed");
  });

  test("a TTK window with no kills at all is reported as such", () => {
    const summary = summarizeWindow(
      2,
      comparison({
        metric: "ttk",
        weightedOutcomes: { a: 0, b: 0, tie: 0, censored: 20 },
        aWins: 0,
        bWins: 0,
        ties: 0,
        censored: 20,
      }),
    );
    expect(summary.verdict).toBe("no-kills");
  });
});

describe("breakpointGrid", () => {
  const points = [
    { armor: 0, bonusHealth: 0, delta: 0 },
    { armor: 0, bonusHealth: 500, delta: 0 },
    { armor: 100, bonusHealth: 0, delta: 0 },
    { armor: 100, bonusHealth: 500, delta: 0 },
    { armor: 200, bonusHealth: 0, delta: 120 },
    { armor: 200, bonusHealth: 500, delta: -60 },
  ];

  test("states the leading no-difference region once instead of printing zero rows", () => {
    const grid = breakpointGrid(points);
    expect(grid.flatArmorValues).toEqual([0, 100]);
    expect(grid.rows.map((row) => row.armor)).toEqual([200]);
    expect(grid.maxAbsDelta).toBe(120);
  });

  test("collapses every row when nothing differs anywhere", () => {
    const grid = breakpointGrid(points.map((point) => ({ ...point, delta: 0 })));
    expect(grid.rows).toEqual([]);
    expect(grid.flatArmorValues).toEqual([0, 100, 200]);
  });
});

describe("slotEditorModel", () => {
  test("keeps the slot index each build stores a shared item in", () => {
    const model = slotEditorModel([6672, 3031, 3085], [3085, 6672, 3036]);
    expect(model.shared).toEqual([
      { id: 6672, aIndex: 0, bIndex: 1 },
      { id: 3085, aIndex: 2, bIndex: 0 },
    ]);
    expect(model.onlyA).toEqual([{ id: 3031, index: 1 }]);
    expect(model.onlyB).toEqual([{ id: 3036, index: 2 }]);
  });

  test("an empty slot belongs to the build that holds it", () => {
    const model = slotEditorModel([6672, 0], [6672]);
    expect(model.onlyA).toEqual([{ id: 0, index: 1 }]);
    expect(model.onlyB).toEqual([]);
  });
});

describe("traceCycles", () => {
  const event = (time: number, source: string, final: number): DamageEvent => ({
    time,
    source,
    type: "physical",
    raw: final,
    resistance: 0,
    multiplier: 1,
    attemptedFinal: final,
    final,
    overkill: 0,
    targetHealthAfter: 0,
    notes: [],
  });

  test("groups repeated on-hit events into one row per instant with a running total", () => {
    const { cycles, applied } = traceCycles([
      event(0.5, "Arc of Ruin", 307.3),
      event(1, "Basic attack", 171.4),
      event(1, "Vow of the First Lands", 13.6),
      event(1.53, "Basic attack", 171.4),
    ]);
    expect(cycles).toHaveLength(3);
    expect(cycles[1]!.total).toBeCloseTo(185, 0);
    expect(cycles[2]!.running).toBeCloseTo(663.7, 1);
    expect(applied).toBeCloseTo(663.7, 1);
  });
});

describe("slice grouping", () => {
  test("a group with no decided samples is undecided, not a loss for build A", () => {
    expect(sliceTier(0, 0)).toBe("undecided");
    expect(sliceTier(0, 4)).toBe("flips");
  });

  test("build A below three quarters of a group reads as close, not settled", () => {
    expect(sliceTier(0.74, 9)).toBe("close");
    expect(sliceTier(0.75, 9)).toBe("settled");
  });

  test("contested groups sort worst first and settled groups collapse to a range", () => {
    const groups = groupSlices([
      sliceRow("Zoe", "Zoe", { count: 5, decided: 5, buildAWinRate: 1 }),
      sliceRow("Thresh", "Thresh", { count: 14, decided: 14, buildAWinRate: 0.71 }),
      sliceRow("Volibear", "Volibear", { count: 6, decided: 6, buildAWinRate: 0 }),
      sliceRow("Jhin", "Jhin", { count: 11, decided: 11, buildAWinRate: 1 }),
      sliceRow("Braum", "Braum", { count: 3, decided: 0, buildAWinRate: 0 }),
    ]);
    expect(groups.contested.map((row) => row.key)).toEqual(["Volibear", "Thresh"]);
    expect(groups.settled.map((row) => row.key)).toEqual(["Zoe", "Jhin"]);
    expect(groups.settledRange).toEqual({ min: 5, max: 11 });
    expect(groups.undecided.map((row) => row.key)).toEqual(["Braum"]);
  });

  test("no settled group leaves no range to print", () => {
    expect(groupSlices([]).settledRange).toBeNull();
  });
});
