import { describe, expect, test } from "vitest";
import { fixtureTargets } from "../../../../src/domains/dps/fixtures.ts";
import { defaultSkillRanks } from "../../../../src/domains/dps/skills.ts";
import { compareAcrossSamples, simulateYunara } from "../../../../src/domains/dps/simulator.ts";
import {
  evaluateOptimizerBuild,
  optimizerBaseForObjective,
  rankOptimizerBuilds,
} from "../../../../src/domains/dps/optimizer-engine.ts";
import { validateBuild } from "../../../../src/domains/dps/optimizer.ts";
import type { OptimizerEvaluationContext, Target } from "../../../../src/domains/dps/types.ts";

const ranks = defaultSkillRanks(13);

const target: Target = {
  id: "p00-synthetic-target",
  champion: "Synthetic target",
  health: 3_000,
  armor: 0,
  magicResist: 0,
  bonusHealth: 0,
  level: 13,
  provenance: "fixture",
};

function simulate(overrides: Partial<Parameters<typeof simulateYunara>[0]> = {}) {
  return simulateYunara({
    level: 13,
    ranks,
    durationSeconds: 5,
    actions: ["AA"],
    continueAutos: false,
    build: { name: "P00 fixture build", itemIds: [] },
    target,
    ...overrides,
  });
}

describe("P00 legacy characterization", () => {
  // Regression for the audited baseline's eager application of W's future tick.
  test("W future tick cannot mutate health before an earlier eligible attack", () => {
    const result = simulate({
      durationSeconds: 2,
      actions: ["W", "AA"],
      target: { ...target, id: "p00-w-chronology", health: 400 },
    });
    const attack = result.events.find((event) => event.source === "Basic attack");
    const linger = result.events.find((event) => event.source === "Arc of Judgment — linger");
    const attackIndex = result.events.findIndex((event) => event.source === "Basic attack");
    const lingerIndex = result.events.findIndex(
      (event) => event.source === "Arc of Judgment — linger",
    );

    expect(attack).toBeDefined();
    expect(linger).toBeDefined();
    expect(attackIndex).toBeLessThan(lingerIndex);
    expect(attack?.time).toBeLessThan(linger?.time ?? Infinity);
    expect(attack?.final).toBeGreaterThan(85);
    expect(result.ttk).toBe(1);
    expect(result.events.map((event) => event.time)).toEqual(
      [...result.events].map((event) => event.time).sort((left, right) => left - right),
    );
  });

  test("an earlier lethal attack cancels pending W damage", () => {
    const result = simulate({
      actions: ["W", "AA"],
      target: { ...target, health: 300 },
    });
    expect(result.ttk).toBe(0.5);
    expect(result.events.some((event) => event.source === "Arc of Judgment — linger")).toBe(false);
    expect(result.totalDamage).toBe(300);
  });

  test("current-health on-hit sees only W damage that has already landed", () => {
    const result = simulate({
      actions: ["W", "AA"],
      build: { name: "BORK chronology", itemIds: [3153] },
    });
    const initial = result.events.find((event) => event.source === "Arc of Judgment")!;
    const onHit = result.events.find(
      (event) => event.source === "Blade of the Ruined King — Mist's Edge",
    )!;
    expect(onHit.time).toBe(0.5);
    expect(onHit.raw).toBeCloseTo((target.health - initial.final) * 0.06, 3);
  });

  test("linger drains during cooldown waiting and before an attack at the same time", () => {
    const waiting = simulate({
      durationSeconds: 12,
      actions: ["W", "W", "AA"],
      target: { ...target, health: 100_000 },
    });
    expect(waiting.events.map((event) => event.time)).toEqual([0, 1, 10, 10.5, 10.5, 11]);

    const attack = simulate({ actions: ["W", "Q", "Q", "AA"] });
    expect(attack.events.filter((event) => event.time === 1).map((event) => event.source)).toEqual([
      "Arc of Judgment — linger",
      "Basic attack",
      "Cultivation of Spirit — passive",
      "Cultivation of Spirit — active",
    ]);
  });

  test("a lethal linger stops an attack waiting for readiness", () => {
    const result = simulate({ actions: ["W", "AA", "AA"], target: { ...target, health: 400 } });
    expect(result.ttk).toBe(1);
    expect(result.events.filter((event) => event.source === "Basic attack")).toHaveLength(1);
  });

  test("an attack outside the window cannot drain damage before an earlier spell", () => {
    const result = simulate({
      durationSeconds: 1.2,
      actions: ["W", "AA", "AA", "W"],
      abilityHaste: 1500,
    });
    expect(result.events.map((event) => event.time)).toEqual([0, 0.5, 0.5, 0.75, 1]);
  });

  test("linger uses penetration earned by earlier attacks", () => {
    const result = simulate({
      actions: ["AA", "W", "AA"],
      build: { name: "Terminus chronology", itemIds: [3302] },
      target: { ...target, magicResist: 100 },
    });
    expect(result.events.find((event) => event.source === "Arc of Judgment")?.resistance).toBe(100);
    expect(
      result.events.find((event) => event.source === "Arc of Judgment — linger")?.resistance,
    ).toBe(90);
  });

  test("continued autos share chronology in mortal and uncapped modes", () => {
    const base = {
      actions: ["W" as const],
      continueAutos: true,
      target: { ...target, health: 400 },
    };
    const mortal = simulate(base);
    expect(mortal.ttk).toBe(1);
    expect(mortal.events.filter((event) => event.source === "Basic attack")).toHaveLength(1);
    const hidden = simulate({ ...base, includeEvents: false });
    expect(hidden.ttk).toBe(mortal.ttk);
    expect(hidden.totalDamage).toBe(mortal.totalDamage);
    const uncapped = simulate({ ...base, targetMode: "uncapped" });
    expect(uncapped.ttk).toBeNull();
    expect(uncapped.events.map((event) => event.time)).toEqual(
      uncapped.events.map((event) => event.time).sort((left, right) => left - right),
    );
    expect(uncapped.totalDamage).toBeGreaterThan(400);
  });

  test("a lethal linger stops a spell waiting for cooldown", () => {
    const result = simulate({
      durationSeconds: 12,
      actions: ["W", "W"],
      target: { ...target, health: 300 },
    });
    expect(result.ttk).toBe(1);
    expect(result.events.map((event) => event.time)).toEqual([0, 1]);
  });

  test("pending linger respects the window even without actions or event capture", () => {
    const base = { actions: ["W" as const], durationSeconds: 1 };
    const visible = simulate(base);
    expect(visible.events.map((event) => event.time)).toEqual([0, 1]);
    expect(simulate({ ...base, durationSeconds: 0.999 }).events.map((event) => event.time)).toEqual(
      [0],
    );
    const hidden = simulate({ ...base, includeEvents: false });
    expect(hidden.events).toEqual([]);
    expect(hidden.totalDamage).toBe(visible.totalDamage);
    expect(hidden.sources).toEqual(visible.sources);
  });

  test("characterizes scripted cooldown waiting without treating readiness as an action", () => {
    const result = simulate({
      durationSeconds: 12,
      actions: ["W", "W"],
      target: { ...target, id: "p00-cooldown", health: 100_000 },
    });
    expect(
      result.events
        .filter((event) => event.source === "Arc of Judgment")
        .map((event) => event.time),
    ).toEqual([0, 10]);
  });

  test("characterizes expected crit state as an averaged attack, not a sampled roll", () => {
    const result = simulate({
      durationSeconds: 1,
      actions: ["AA"],
      build: { name: "Infinity Edge", itemIds: [3031] },
      target: { ...target, id: "p00-average-crit", health: 100_000 },
    });
    const attack = result.events.find((event) => event.source === "Basic attack");
    const expectedRaw =
      result.stats.attackDamage * (1 + result.stats.critChance * (result.stats.critDamage - 1));

    expect(result.stats.critChance).toBe(0.25);
    expect(result.stats.critDamage).toBeCloseTo(2.3, 6);
    expect(attack?.raw).toBeCloseTo(expectedRaw, 0);
    expect(attack?.notes.join(" ")).toContain("25% expected crit at 230%");
  });

  test("characterizes selected-result transfer through the existing comparison path", () => {
    const targets = fixtureTargets.slice(0, 2);
    const context: OptimizerEvaluationContext = {
      base: {
        level: 13,
        ranks,
        durationSeconds: 5,
        actions: ["AA"],
        continueAutos: false,
        targetMode: "mortal",
      },
      targets,
      objective: "fixed-window-damage",
      candidateOptions: {
        eligibleItemIds: [3006, 3031, 3032],
        constraints: { slotCount: 2, bootRule: "required" },
      },
    };
    const search = rankOptimizerBuilds(context, { topN: 1 });
    const selected = search.rankings[0]!.candidate;
    const evaluation = evaluateOptimizerBuild(context, selected);
    const comparison = compareAcrossSamples(
      optimizerBaseForObjective(context),
      { name: selected.name, itemIds: [...selected.itemIds] },
      { name: "comparison control", itemIds: [3006] },
      targets,
      { includeEvents: false },
    );

    expect(comparison.rows.map((row) => row.a.totalDamage)).toEqual(
      evaluation.rows.map((row) => row.result.totalDamage),
    );
    expect(comparison.rows.map((row) => row.a.dps)).toEqual(
      evaluation.rows.map((row) => row.result.dps),
    );
  });

  test("characterizes current complete-inventory validation boundaries", () => {
    const constraints = {
      slotCount: 3,
      bootRule: "required" as const,
      maxBoots: 1,
    };
    const legal = validateBuild([3006, 3031, 3032], {
      eligibleItemIds: [3006, 3031, 3032],
      constraints,
    });
    const illegal = validateBuild([3006, 3006, 3031], {
      eligibleItemIds: [3006, 3031, 3032],
      constraints,
    });

    expect(legal.legal).toBe(true);
    expect(legal.totalGold).toBe(7_600);
    expect(legal.bootCount).toBe(1);
    expect(illegal.legal).toBe(false);
    expect(illegal.reasons).toEqual(["duplicate-item", "too-many-boots"]);
  });
});
