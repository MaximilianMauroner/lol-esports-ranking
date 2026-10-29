import { buildGoldTotal } from "./items.ts";
import { round } from "./math.ts";
import {
  canonicalBuildKey,
  canonicalizeItemIds,
  generateCandidateBuilds,
  optimizerContinuationForObjective,
} from "./optimizer.ts";
import { simulateYunara } from "./simulator.ts";
import type {
  Build,
  OptimizerBuildEvaluation,
  OptimizerCandidate,
  OptimizerEvaluationContext,
  OptimizerObjective,
  OptimizerRankedBuild,
  OptimizerSearchResult,
  OptimizerTargetEvaluation,
  SimulationInput,
  Target,
} from "./types.ts";

export const OPTIMIZER_ENGINE_VERSION = "yunara-optimizer-v3-all-modeled-items";
export const DEFAULT_OPTIMIZER_TOP_N = 10;
export const OPTIMIZER_TIE_EPSILON = 1e-9;

export interface OptimizerRankingOptions {
  topN?: number;
  candidates?: readonly (Build | OptimizerCandidate)[];
}

/**
 * Applies the objective's explicit combo semantics before calling the normal
 * simulator. Sustained searches continue autos; burst searches stop after the
 * scripted action list. Fixed-window and TTK searches preserve the caller's
 * exact simulation controls.
 */
export function optimizerBaseForObjective(
  context: Pick<OptimizerEvaluationContext, "base" | "objective">,
): OptimizerEvaluationContext["base"] {
  const engineBase = {
    ...context.base,
    // Optimizer rows need exact totals/kill state, not per-event traces or
    // repeated assumption strings. Direct Compare remains full-trace by
    // default; parity tests use this same optimized simulator input.
    includeEvents: false,
    includeWarnings: false,
  };
  if (context.objective === "sustained-dps") {
    return {
      ...engineBase,
      continueAutos: optimizerContinuationForObjective(
        context.objective,
        context.base.continueAutos,
      ),
    };
  }
  if (context.objective === "burst-damage") {
    return {
      ...engineBase,
      continueAutos: optimizerContinuationForObjective(
        context.objective,
        context.base.continueAutos,
      ),
    };
  }
  if (context.objective === "ttk" && context.base.targetMode === "uncapped") {
    throw new Error(
      "TTK optimization requires mortal target mode so censored kills are observable.",
    );
  }
  return engineBase;
}

/** Builds the exact input sent to the existing Yunara simulator for parity tests and callers. */
export function optimizerSimulationInput(
  context: Pick<OptimizerEvaluationContext, "base" | "objective">,
  build: Build,
  target: Target,
): SimulationInput {
  return {
    ...optimizerBaseForObjective(context),
    build,
    target,
  };
}

/** Evaluates one build against every target without pruning or surrogate math. */
export function evaluateOptimizerBuild(
  context: OptimizerEvaluationContext,
  build: Build | OptimizerCandidate,
): OptimizerBuildEvaluation {
  if (context.targets.length === 0)
    throw new Error("Optimizer evaluation requires at least one target.");
  const candidate = normalizeCandidate(build);
  const base = optimizerBaseForObjective(context);
  const rows = context.targets.map((target) => {
    const result = simulateYunara({ ...base, build: candidate, target });
    return { target, result, weight: targetWeight(target) };
  });
  return summarizeEvaluation(candidate, context.objective, rows);
}

/**
 * Evaluates and ranks every legal candidate. `evaluatedCount` is intentionally
 * exposed so callers and benchmarks can prove that exhaustive search happened.
 */
export function rankOptimizerBuilds(
  context: OptimizerEvaluationContext,
  options: OptimizerRankingOptions = {},
): OptimizerSearchResult {
  const candidates = normalizeCandidates(
    options.candidates ?? generateCandidateBuilds(context.candidateOptions),
  );
  const evaluations = candidates.map((candidate) => evaluateOptimizerBuild(context, candidate));
  const topN = normalizeTopN(options.topN);
  return {
    objective: context.objective,
    contextHash: optimizerContextHash(context, {
      topN,
      candidateIdentities: candidates.map((candidate) => candidate.identity),
    }),
    candidateCount: candidates.length,
    evaluatedCount: evaluations.length,
    rankings: rankOptimizerEvaluations(evaluations, topN),
  };
}

export const optimizeBuilds = rankOptimizerBuilds;
export const rankOptimizerCandidates = rankOptimizerBuilds;

/** Sorts complete evaluations using only deterministic, objective-aware keys. */
export function compareOptimizerEvaluations(
  left: OptimizerBuildEvaluation,
  right: OptimizerBuildEvaluation,
): number {
  if (left.objective !== right.objective) return left.objective.localeCompare(right.objective);

  if (left.objective === "ttk") {
    const coverageDifference = right.killCoverage - left.killCoverage;
    if (!approximatelyZero(coverageDifference)) return coverageDifference;
    const leftTtk = left.meanTtk;
    const rightTtk = right.meanTtk;
    if (leftTtk === null && rightTtk !== null) return 1;
    if (leftTtk !== null && rightTtk === null) return -1;
    if (leftTtk !== null && rightTtk !== null && !approximatelyZero(leftTtk - rightTtk)) {
      return leftTtk - rightTtk;
    }
  } else if (!approximatelyZero(right.score! - left.score!)) {
    return right.score! - left.score!;
  }

  // TTK has no damage-based tie-break: once coverage and uncensored mean TTK
  // are equal, post-death/applied damage must not decide the ranking. Damage
  // objectives retain weighted kill coverage and applied damage as stable
  // secondary keys.
  if (left.objective !== "ttk") {
    if (!approximatelyZero(right.killCoverage - left.killCoverage)) {
      return right.killCoverage - left.killCoverage;
    }
    if (!approximatelyZero(right.weightedDamage - left.weightedDamage)) {
      return right.weightedDamage - left.weightedDamage;
    }
  }
  if (left.candidate.goldTotal !== right.candidate.goldTotal) {
    return left.candidate.goldTotal - right.candidate.goldTotal;
  }
  return left.candidate.identity.localeCompare(right.candidate.identity);
}

export function rankOptimizerEvaluations(
  evaluations: readonly OptimizerBuildEvaluation[],
  topN = DEFAULT_OPTIMIZER_TOP_N,
): OptimizerRankedBuild[] {
  return [...evaluations]
    .sort(compareOptimizerEvaluations)
    .slice(0, normalizeTopN(topN))
    .map((evaluation, index) => toRankedBuild(evaluation, index + 1));
}

/** A stable browser-safe hash of every result-affecting search input. */
export function optimizerContextHash(
  context: OptimizerEvaluationContext,
  options: { topN?: number; candidateIdentities?: readonly string[] } = {},
): string {
  const serialized = stableSerialize({
    engine: OPTIMIZER_ENGINE_VERSION,
    objective: context.objective,
    base: context.base,
    targets: context.targets,
    candidateOptions: context.candidateOptions ?? null,
    topN: normalizeTopN(options.topN),
    candidateIdentities: options.candidateIdentities ?? null,
  });
  return `${OPTIMIZER_ENGINE_VERSION}:${fnv1a(serialized)}`;
}

function summarizeEvaluation(
  candidate: OptimizerCandidate,
  objective: OptimizerObjective,
  rows: OptimizerTargetEvaluation[],
): OptimizerBuildEvaluation {
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  const weightedDamage = weightedMean(rows, (row) => row.result.totalDamage, totalWeight);
  const weightedDps = weightedMean(rows, (row) => row.result.dps, totalWeight);
  const killedRows = rows.filter((row) => row.result.killed);
  const killedWeight = killedRows.reduce((sum, row) => sum + row.weight, 0);
  const censoredRows = rows.filter((row) => row.result.censored);
  const censoredWeight = censoredRows.reduce((sum, row) => sum + row.weight, 0);
  const ttkRows = killedRows.filter((row) => row.result.ttk !== null);
  const ttkWeight = ttkRows.reduce((sum, row) => sum + row.weight, 0);
  const meanTtk = ttkWeight
    ? round(ttkRows.reduce((sum, row) => sum + row.result.ttk! * row.weight, 0) / ttkWeight, 6)
    : null;
  const normalizedTotalWeight = round(totalWeight, 6);
  const killCoverage = totalWeight ? round(killedWeight / totalWeight, 6) : 0;
  const censoredCoverage = totalWeight ? round(censoredWeight / totalWeight, 6) : 0;
  const roundedDamage = round(weightedDamage, 6);
  const roundedDps = round(weightedDps, 6);

  return {
    candidate,
    objective,
    score:
      objective === "ttk" ? meanTtk : objective === "sustained-dps" ? roundedDps : roundedDamage,
    weightedDamage: roundedDamage,
    weightedDps: roundedDps,
    totalWeight: normalizedTotalWeight,
    killCoverage,
    censoredCoverage,
    killedCount: killedRows.length,
    censoredCount: censoredRows.length,
    meanTtk,
    warnings: [...new Set(rows.flatMap((row) => row.result.warnings))],
    rows,
  };
}

function normalizeCandidate(build: Build | OptimizerCandidate): OptimizerCandidate {
  const itemIds = canonicalizeItemIds(build.itemIds);
  return {
    name: build.name,
    itemIds,
    identity: canonicalBuildKey(itemIds),
    goldTotal: buildGoldTotal(itemIds),
  };
}

function toRankedBuild(evaluation: OptimizerBuildEvaluation, rank: number): OptimizerRankedBuild {
  return {
    candidate: evaluation.candidate,
    objective: evaluation.objective,
    score: evaluation.score,
    weightedDamage: evaluation.weightedDamage,
    weightedDps: evaluation.weightedDps,
    totalWeight: evaluation.totalWeight,
    killCoverage: evaluation.killCoverage,
    censoredCoverage: evaluation.censoredCoverage,
    killedCount: evaluation.killedCount,
    censoredCount: evaluation.censoredCount,
    meanTtk: evaluation.meanTtk,
    warnings: evaluation.warnings,
    rank,
  };
}

function normalizeCandidates(
  candidates: readonly (Build | OptimizerCandidate)[],
): OptimizerCandidate[] {
  const unique = new Map<string, OptimizerCandidate>();
  for (const candidate of candidates) {
    const normalized = normalizeCandidate(candidate);
    const existing = unique.get(normalized.identity);
    if (!existing || normalized.name.localeCompare(existing.name) < 0) {
      unique.set(normalized.identity, normalized);
    }
  }
  return [...unique.values()].sort((left, right) => left.identity.localeCompare(right.identity));
}

function targetWeight(target: Target): number {
  return Number.isFinite(target.sampleWeight) && (target.sampleWeight ?? 0) > 0
    ? target.sampleWeight!
    : 1;
}

function weightedMean(
  rows: readonly OptimizerTargetEvaluation[],
  value: (row: OptimizerTargetEvaluation) => number,
  totalWeight: number,
): number {
  if (!totalWeight) return 0;
  return rows.reduce((sum, row) => sum + value(row) * row.weight, 0) / totalWeight;
}

function normalizeTopN(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_OPTIMIZER_TOP_N;
  return Math.max(1, Math.floor(value!));
}

function approximatelyZero(value: number): boolean {
  return Math.abs(value) <= OPTIMIZER_TIE_EPSILON;
}

function stableSerialize(value: unknown, stack: unknown[] = []): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "number:NaN";
    if (value === Infinity) return "number:Infinity";
    if (value === -Infinity) return "number:-Infinity";
    return `number:${value}`;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value !== "object") return `${typeof value}:${String(value)}`;
  if (stack.includes(value)) throw new Error("Optimizer context must not contain cyclic data.");
  const nextStack = [...stack, value];
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry, nextStack)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key], nextStack)}`)
    .join(",")}}`;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
