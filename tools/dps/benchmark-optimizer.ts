import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureTargets } from "../../src/domains/dps/fixtures.ts";
import { defaultSkillRanks } from "../../src/domains/dps/skills.ts";
import { generateCandidateBuilds } from "../../src/domains/dps/optimizer.ts";
import { rankOptimizerBuilds } from "../../src/domains/dps/optimizer-engine.ts";
import type { OptimizerEvaluationContext } from "../../src/domains/dps/types.ts";

/**
 * Deterministic engine-only benchmark. Pass --targets-dir or
 * OPTIMIZER_BENCHMARK_TARGETS_DIR with targets-{10,13,16}.json files to
 * benchmark a sanitized real cohort fetched through the existing cohort path.
 * Without it, the fixture fallback is explicit in the output.
 */
const contexts = [
  { level: 10, slotCount: 3 },
  { level: 13, slotCount: 4 },
  { level: 16, slotCount: 5 },
] as const;

const targetsDirectory =
  process.argv.find((argument) => argument.startsWith("--targets-dir="))?.split("=", 2)[1] ??
  process.env.OPTIMIZER_BENCHMARK_TARGETS_DIR;
const source = targetsDirectory ? "provided-cohort" : "fixture";

for (const { level, slotCount } of contexts) {
  const targets = targetsDirectory
    ? JSON.parse(readFileSync(join(targetsDirectory, `targets-${level}.json`), "utf8"))
    : fixtureTargets.map((target) => ({ ...target }));
  const candidateOptions = {
    constraints: { slotCount, bootRule: "required" as const },
  };
  const candidates = generateCandidateBuilds(candidateOptions);
  const context: OptimizerEvaluationContext = {
    base: {
      level,
      ranks: defaultSkillRanks(level),
      durationSeconds: 5,
      actions: ["R", "Q", "W", "AA", "AA"],
      continueAutos: true,
      yunTalStacks: 0,
      targetMode: "mortal",
    },
    targets,
    objective: "sustained-dps",
    candidateOptions,
  };
  const started = performance.now();
  const result = rankOptimizerBuilds(context, { candidates, topN: 3 });
  const elapsedMs = performance.now() - started;
  console.log(
    JSON.stringify({
      level,
      slotCount,
      targetCount: targets.length,
      candidateCount: result.candidateCount,
      buildTargetSimulations: result.candidateCount * targets.length,
      evaluatedCount: result.evaluatedCount,
      source,
      elapsedMs: Number(elapsedMs.toFixed(1)),
      top: result.rankings.map((row) => ({
        rank: row.rank,
        identity: row.candidate.identity,
        score: row.score,
        killCoverage: row.killCoverage,
      })),
    }),
  );
}
