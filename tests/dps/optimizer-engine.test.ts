import { describe, expect, test } from "vitest";
import { fixtureTargets } from "../../src/domains/dps/fixtures.ts";
import { defaultSkillRanks } from "../../src/domains/dps/skills.ts";
import { generateCandidateBuilds } from "../../src/domains/dps/optimizer.ts";
import {
  compareOptimizerEvaluations,
  evaluateOptimizerBuild,
  optimizerBaseForObjective,
  optimizerContextHash,
  optimizerSimulationInput,
  rankOptimizerBuilds,
} from "../../src/domains/dps/optimizer-engine.ts";
import { compareAcrossSamples, simulateYunara } from "../../src/domains/dps/simulator.ts";
import type { OptimizerBuildEvaluation, OptimizerEvaluationContext } from "../../src/domains/dps/types.ts";

const base = {
  level: 13,
  ranks: defaultSkillRanks(13),
  durationSeconds: 5,
  actions: ["R", "Q", "W", "AA"] as const,
  continueAutos: true,
  yunTalStacks: 0,
  targetMode: "mortal" as const,
};

const targets = fixtureTargets.slice(0, 3).map((target, index) => ({
  ...target,
  sampleWeight: index === 0 ? 2 : 1,
}));

function context(
  objective: OptimizerEvaluationContext["objective"],
  overrides: Partial<OptimizerEvaluationContext["base"]> = {},
): OptimizerEvaluationContext {
  return {
    base: { ...base, ...overrides },
    targets,
    objective,
    candidateOptions: {
      eligibleItemIds: [3006, 3031, 3032, 3085],
      constraints: { slotCount: 4, bootRule: "required" },
    },
  };
}

describe("optimizer evaluation semantics", () => {
  test("uses the existing simulator exactly for every target and preserves weights", () => {
    const evaluationContext = context("fixed-window-damage", { continueAutos: false });
    const candidate = generateCandidateBuilds(evaluationContext.candidateOptions)[0]!;
    const evaluation = evaluateOptimizerBuild(evaluationContext, candidate);
    const direct = targets.map((target) =>
      simulateYunara(optimizerSimulationInput(evaluationContext, candidate, target)),
    );
    expect(evaluation.rows.map((row) => row.result)).toEqual(direct);
    expect(evaluation.totalWeight).toBe(4);
    expect(evaluation.weightedDamage).toBeCloseTo(
      (direct[0]!.totalDamage * 2 + direct[1]!.totalDamage + direct[2]!.totalDamage) / 4,
      6,
    );
    expect(evaluation.score).toBe(evaluation.weightedDamage);
  });

  test("optimizer summary execution is metric-identical to the full simulator trace", () => {
    const evaluationContext = context("fixed-window-damage", { continueAutos: false });
    const candidate = generateCandidateBuilds(evaluationContext.candidateOptions)[0]!;
    const full = simulateYunara({
      ...optimizerSimulationInput(evaluationContext, candidate, targets[0]!),
      includeEvents: true,
      includeWarnings: true,
    });
    const summary = simulateYunara(
      optimizerSimulationInput(evaluationContext, candidate, targets[0]!),
    );

    expect(summary.events).toEqual([]);
    expect(summary.warnings).toEqual([]);
    expect(summary.totalDamage).toBe(full.totalDamage);
    expect(summary.dps).toBe(full.dps);
    expect(summary.ttk).toBe(full.ttk);
    expect(summary.split).toEqual(full.split);
    expect(summary.sources).toEqual(full.sources);
    expect(summary.killed).toBe(full.killed);
    expect(summary.censored).toBe(full.censored);
    expect(summary.overkill).toBe(full.overkill);
  });

  test("sustained and burst objectives make continuation semantics explicit", () => {
    const sustained = context("sustained-dps", { continueAutos: false });
    const burst = context("burst-damage", { continueAutos: true });
    const build = generateCandidateBuilds(sustained.candidateOptions)[0]!;
    expect(optimizerBaseForObjective(sustained).continueAutos).toBe(true);
    expect(optimizerBaseForObjective(burst).continueAutos).toBe(false);

    const sustainedRun = evaluateOptimizerBuild(sustained, build);
    const burstRun = evaluateOptimizerBuild(burst, build);
    expect(sustainedRun.score).toBe(sustainedRun.weightedDps);
    expect(burstRun.score).toBe(burstRun.weightedDamage);
    expect(sustainedRun.rows[0]!.result.totalDamage).toBeGreaterThanOrEqual(
      burstRun.rows[0]!.result.totalDamage,
    );
  });

  test("TTK reports kill coverage and excludes censored rows from mean TTK", () => {
    const ttkTargets = [
      { ...targets[0]!, id: "easy", health: 100, sampleWeight: 1 },
      { ...targets[0]!, id: "hard", health: 100_000, sampleWeight: 1 },
    ];
    const evaluationContext: OptimizerEvaluationContext = {
      base: { ...base, durationSeconds: 1, actions: ["AA"], continueAutos: false },
      targets: ttkTargets,
      objective: "ttk",
    };
    const build = { name: "test build", itemIds: [3006, 3031] };
    const evaluation = evaluateOptimizerBuild(evaluationContext, build);
    const killed = evaluation.rows.find((row) => row.target.id === "easy")!;
    const censored = evaluation.rows.find((row) => row.target.id === "hard")!;

    expect(killed.result.killed).toBe(true);
    expect(censored.result.killed).toBe(false);
    expect(censored.result.censored).toBe(true);
    expect(evaluation.killCoverage).toBe(0.5);
    expect(evaluation.censoredCoverage).toBe(0.5);
    expect(evaluation.meanTtk).toBe(killed.result.ttk);
    expect(evaluation.score).toBe(evaluation.meanTtk);
  });

  test("rejects TTK against uncapped targets instead of treating survival as a slow kill", () => {
    expect(() =>
      evaluateOptimizerBuild(context("ttk", { targetMode: "uncapped" }), {
        name: "test build",
        itemIds: [3006, 3031],
      }),
    ).toThrow("mortal target mode");
  });

  test("does not use post-death damage to break equal TTK coverage and time", () => {
    const make = (identity: string, goldTotal: number, weightedDamage: number) =>
      ({
        candidate: { name: identity, itemIds: [3006], identity, goldTotal },
        objective: "ttk" as const,
        score: 1,
        weightedDamage,
        weightedDps: weightedDamage,
        totalWeight: 1,
        killCoverage: 1,
        censoredCoverage: 0,
        killedCount: 1,
        censoredCount: 0,
        meanTtk: 1,
        warnings: [],
        rows: [],
      }) as OptimizerBuildEvaluation;

    const cheaper = make("cheaper", 1_000, 10);
    const moreDamage = make("more-damage", 2_000, 10_000);
    expect(compareOptimizerEvaluations(cheaper, moreDamage)).toBeLessThan(0);

    const moreCoverage = {
      ...cheaper,
      candidate: { ...cheaper.candidate, identity: "more-coverage" },
      killCoverage: 0.75,
      meanTtk: 10,
      score: 10,
      weightedDamage: 1,
    };
    const fasterButCensored = {
      ...cheaper,
      candidate: { ...cheaper.candidate, identity: "faster-but-censored" },
      killCoverage: 0.5,
      meanTtk: 1,
      score: 1,
      weightedDamage: 100_000,
    };
    expect(compareOptimizerEvaluations(moreCoverage, fasterButCensored)).toBeLessThan(0);
  });

  test("hands the exact ranked item set to compare with matching simulator metrics", () => {
    const evaluationContext = context("fixed-window-damage", { continueAutos: false });
    const result = rankOptimizerBuilds(evaluationContext, { topN: 1 });
    const selected = result.rankings[0]!.candidate;
    const optimizerEvaluation = evaluateOptimizerBuild(evaluationContext, selected);
    const handoff = { name: selected.name, itemIds: [...selected.itemIds] };
    const comparison = compareAcrossSamples(
      evaluationContext.base,
      handoff,
      { name: "comparison", itemIds: [3006] },
      targets,
      { includeEvents: false, metric: "damage" },
    );

    expect(handoff.itemIds).toEqual(selected.itemIds);
    expect(comparison.rows.map((row) => row.a.totalDamage)).toEqual(
      optimizerEvaluation.rows.map((row) => row.result.totalDamage),
    );
    expect(optimizerEvaluation.score).toBe(
      optimizerEvaluation.rows.reduce((sum, row) => sum + row.result.totalDamage * row.weight, 0) /
        optimizerEvaluation.totalWeight,
    );
    expect(comparison.rows).toHaveLength(targets.length);
  });

  test("objective-specific handoff keeps Compare on the optimizer scenario", () => {
    for (const objective of ["sustained-dps", "burst-damage"] as const) {
      const evaluationContext = context(objective, { continueAutos: objective === "burst-damage" });
      const selected = generateCandidateBuilds(evaluationContext.candidateOptions)[0]!;
      const optimizerEvaluation = evaluateOptimizerBuild(evaluationContext, selected);
      const comparison = compareAcrossSamples(
        optimizerBaseForObjective(evaluationContext),
        selected,
        { name: "comparison", itemIds: [3006] },
        targets,
        { includeEvents: false, metric: "damage" },
      );

      expect(comparison.rows.map((row) => row.a.totalDamage)).toEqual(
        optimizerEvaluation.rows.map((row) => row.result.totalDamage),
      );
      expect(comparison.rows.map((row) => row.a.dps)).toEqual(
        optimizerEvaluation.rows.map((row) => row.result.dps),
      );
    }
  });
});

describe("optimizer ranking", () => {
  test("evaluates every candidate and gives stable tie results independent of input order", () => {
    const evaluationContext: OptimizerEvaluationContext = {
      base: { ...base, actions: [], continueAutos: false },
      targets: [targets[0]!],
      objective: "fixed-window-damage",
    };
    const candidates = [
      { name: "Berserkers", itemIds: [3006] },
      { name: "Gluttonous", itemIds: [3008] },
    ];
    const first = rankOptimizerBuilds(evaluationContext, { candidates, topN: 2 });
    const second = rankOptimizerBuilds(evaluationContext, {
      candidates: [...candidates].reverse(),
      topN: 2,
    });

    expect(first.candidateCount).toBe(2);
    expect(first.evaluatedCount).toBe(2);
    expect(first.rankings.map((row) => row.candidate.identity)).toEqual(
      second.rankings.map((row) => row.candidate.identity),
    );
    expect(first.rankings[0]!.candidate.identity).toBe("3008");
    expect(
      compareOptimizerEvaluations(
        { ...first.rankings[0]!, rows: [] } as OptimizerBuildEvaluation,
        { ...first.rankings[1]!, rows: [] } as OptimizerBuildEvaluation,
      ),
    ).toBeLessThan(0);
  });

  test("normalizes candidate identity and gold from canonical item IDs", () => {
    const evaluationContext: OptimizerEvaluationContext = {
      base: { ...base, actions: [], continueAutos: false },
      targets: [targets[0]!],
      objective: "fixed-window-damage",
    };
    const candidates = [
      { name: "z label", itemIds: [3031, 3006], identity: "not-canonical", goldTotal: 1 },
      { name: "a label", itemIds: [3006, 3031], identity: "also-wrong", goldTotal: 999_999 },
    ];
    const result = rankOptimizerBuilds(evaluationContext, { candidates, topN: 2 });

    expect(result.candidateCount).toBe(1);
    expect(result.rankings[0]!.candidate.identity).toBe("3006,3031");
    expect(result.rankings[0]!.candidate.goldTotal).toBe(4600);
    expect(result.rankings[0]!.candidate.name).toBe("a label");
  });

  test("changes the context hash for every result-affecting input but ignores search token", () => {
    const evaluationContext = context("sustained-dps");
    const candidates = generateCandidateBuilds(evaluationContext.candidateOptions);
    const options = {
      topN: 3,
      candidateIdentities: candidates.map((candidate) => candidate.identity),
    };
    const same = optimizerContextHash(evaluationContext, options);
    const changed = optimizerContextHash(
      { ...evaluationContext, base: { ...evaluationContext.base, durationSeconds: 10 } },
      options,
    );
    expect(same).toBe(optimizerContextHash(evaluationContext, options));
    expect(changed).not.toBe(same);

    const changedInputs = [
      { ...evaluationContext, objective: "burst-damage" as const },
      { ...evaluationContext, base: { ...evaluationContext.base, actions: ["AA"] as const } },
      { ...evaluationContext, base: { ...evaluationContext.base, continueAutos: false } },
      { ...evaluationContext, base: { ...evaluationContext.base, yunTalStacks: 50 } },
      {
        ...evaluationContext,
        base: { ...evaluationContext.base, ranks: { ...evaluationContext.base.ranks, q: 4 } },
      },
      {
        ...evaluationContext,
        candidateOptions: {
          ...evaluationContext.candidateOptions,
          constraints: { slotCount: 5, bootRule: "required" as const },
        },
      },
    ];
    expect(changedInputs.every((input) => optimizerContextHash(input, options) !== same)).toBe(
      true,
    );
  });
});
