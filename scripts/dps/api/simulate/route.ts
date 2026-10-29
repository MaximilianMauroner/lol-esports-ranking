import { compareAcrossSamples, simulateYunara } from "../../../../src/domains/dps/simulator.ts";
import { round, weightedQuantile } from "../../../../src/domains/dps/math.ts";
import { buildGoldTotal, itemStats, ITEMS, unsupportedItemIds } from "../../../../src/domains/dps/items.ts";
import { getRealisticTargets } from "../../data/realistic-targets.ts";
import { fixtureTargets } from "../../../../src/domains/dps/fixtures.ts";
import type { ActionKind, Build, SimulationInput, Target } from "../../../../src/domains/dps/types.ts";

const DEFAULT_A: Build = { name: "Infinity Edge", itemIds: [6672, 3085, 3006, 3031] };
const DEFAULT_B: Build = { name: "Lord Dominik's Regards", itemIds: [6672, 3085, 3006, 3036] };

export async function POST(request: Request) {
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 128_000) {
      return Response.json({ error: "Simulation request is too large." }, { status: 413 });
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const duration = boundedInt(body.durationSeconds, 1, 60, 5, "durationSeconds");
    const metric = boundedChoice(body.metric, ["damage", "ttk"], "damage") as "damage" | "ttk";
    const targetMode = boundedChoice(body.targetMode, ["mortal", "uncapped"], "mortal") as
      "mortal" | "uncapped";
    const level = boundedInt(body.level, 1, 18, 13, "level");
    const rankInput = body.ranks && typeof body.ranks === "object" ? body.ranks as Record<string, unknown> : {};
    const ranks = {
      q: boundedInt(rankInput.q, 1, 5, 5, "Q rank"),
      w: boundedInt(rankInput.w, 1, 5, 3, "W rank"),
      e: boundedInt(rankInput.e, 1, 5, 1, "E rank"),
      r: boundedInt(rankInput.r, 1, 3, 2, "R rank"),
    };
    const actions = normalizeActions(body.actions);
    const yunTalStacks = boundedInt(body.yunTalStacks, 0, 125, 0, "yunTalStacks");
    const buildA = normalizeBuild(body.buildA, DEFAULT_A);
    const buildB = normalizeBuild(body.buildB, DEFAULT_B);
    const dataset = await getRealisticTargets({
      region: boundedChoice(body.region, ["EUW1", "NA1", "KR"], "EUW1"),
      role: boundedChoice(
        body.role,
        ["ALL", "TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"],
        "ALL",
      ),
      champion: typeof body.targetChampion === "string" ? body.targetChampion.slice(0, 48) : "",
      rank: boundedChoice(body.rank, ["ALL", "CHALLENGER", "GRANDMASTER", "MASTER"], "ALL"),
      phase: boundedChoice(
        body.phase,
        ["yunara-third-item", "bot-carry-third-item", "minute-window"],
        "yunara-third-item",
      ),
      limit: 1000,
    });
    const manualTarget = normalizeManualTarget(body.manualTarget);
    let displayDataset = dataset;
    let targets: Target[];
    if (body.targetMode === "manual") {
      targets = [manualTarget];
      displayDataset = {
        ...dataset,
        provenance: "fixture",
        phase: "manual target",
        fallbackLevel: 3,
        note: "Manual target values supplied by the user; no Riot snapshot claim is made.",
        distinctMatchCount: 0,
        snapshotCount: 1,
        uniqueChampions: [manualTarget.champion],
        uniqueRoles: [],
        knownRankCount: 0,
        availableDistinctMatchCount: 0,
        availableSnapshotCount: 1,
        truncated: false,
        sampleLimitPerMatch: 1,
        collection: { earliest: null, latest: null },
      };
    } else if (dataset.targets.length === 0) {
      targets = fixtureTargets;
      displayDataset = {
        ...dataset,
        targets: fixtureTargets,
        provenance: "fixture",
        phase: "fixture fallback (no stored Riot samples)",
        fallbackLevel: 3,
        note: "No stored Riot scenario samples match these filters; fixture values are shown explicitly.",
        distinctMatchCount: 0,
        snapshotCount: fixtureTargets.length,
        uniqueChampions: [...new Set(fixtureTargets.map((target) => target.champion))],
        uniqueRoles: [
          ...new Set(fixtureTargets.map((target) => target.role).filter(Boolean) as string[]),
        ],
        knownRankCount: 0,
        availableDistinctMatchCount: 0,
        availableSnapshotCount: fixtureTargets.length,
        truncated: false,
        sampleLimitPerMatch: 20,
        collection: { earliest: null, latest: null },
      };
    } else {
      targets = dataset.targets;
    }
    const fallbackTarget = targets[0] ?? manualTarget;
    const base: Omit<SimulationInput, "build" | "target"> = {
      level,
      ranks,
      durationSeconds: duration,
      actions,
      continueAutos: body.continueAutos !== false,
      yunTalStacks,
      targetMode,
    };
    const requestedTarget =
      typeof body.selectedTargetId === "string"
        ? targets.find((target) => target.id === body.selectedTargetId)
        : undefined;
    const selectedTarget =
      requestedTarget ??
      [...targets].sort((left, right) => left.id.localeCompare(right.id))[
        Math.floor(targets.length / 2)
      ] ??
      fallbackTarget;
    const a = simulateYunara({ ...base, build: buildA, target: selectedTarget });
    const b = simulateYunara({ ...base, build: buildB, target: selectedTarget });
    const comparison = compareAcrossSamples(base, buildA, buildB, targets, {
      includeEvents: false,
      metric,
    });
    const summary = summarizeTargets(targets);
    return Response.json({
      patch: "26.18",
      dataVersion: "16.18.1",
      engineVersion: "yunara-engine-v1",
      assumptions: `Level ${base.level} / Q${ranks.q} W${ranks.w} E${ranks.e} R${ranks.r}, expected crits, Yun Tal starts at ${yunTalStacks}/125 ranged stacks.`,
      warnings: [
        "Expected crit mode averages crits; it is not a kill probability.",
        targetMode === "mortal"
          ? "Mortal targets stop at first death; fixed-window totals exclude overkill and TTK is an expected-crit first crossing time."
          : "Uncapped training-dummy mode is not a TTK result and should not be read as a kill prediction.",
        "Yunara E is unsupported for damage, and Runaan's bolts are excluded for this single-target comparison.",
        "IE and LDR are compared at their listed costs; this is not an equal-gold comparison.",
        ...new Set([...a.warnings, ...b.warnings]),
      ],
      dataset: { ...displayDataset, count: targets.length, summary },
      builds: {
        a: buildMeta(buildA),
        b: buildMeta(buildB),
        costDelta: buildGoldTotal(buildA.itemIds) - buildGoldTotal(buildB.itemIds),
      },
      target: selectedTarget,
      results: { a, b, comparison },
      breakpoints: breakpointGrid(base, buildA, buildB, fallbackTarget),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Simulation failed" },
      { status: 400 },
    );
  }
}

function normalizeBuild(value: unknown, fallback: Build): Build {
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as { name?: unknown; itemIds?: unknown };
  if (
    !Array.isArray(candidate.itemIds) ||
    candidate.itemIds.length === 0 ||
    candidate.itemIds.length > 6
  ) {
    throw new Error("Each build must contain between 1 and 6 item IDs.");
  }
  const itemIds = candidate.itemIds.map(Number);
  if (itemIds.some((id) => !Number.isInteger(id)))
    throw new Error("Build item IDs must be integers.");
  const unsupported = unsupportedItemIds(itemIds);
  if (unsupported.length) throw new Error(`Unsupported item IDs: ${unsupported.join(", ")}`);
  return {
    name: typeof candidate.name === "string" ? candidate.name.slice(0, 64) : fallback.name,
    itemIds,
  };
}

function buildMeta(build: Build) {
  const stats = itemStats(build.itemIds);
  return {
    ...build,
    goldTotal: buildGoldTotal(build.itemIds),
    supportedItems: build.itemIds.map((id) => ITEMS[id]!.name),
    stats,
  };
}

function normalizeActions(value: unknown): readonly ActionKind[] {
  if (value === undefined) return ["R", "Q", "W", "AA", "AA"];
  if (!Array.isArray(value) || value.length > 100)
    throw new Error("Actions must be an array of at most 100 entries.");
  const actions = value.filter((action): action is ActionKind =>
    typeof action === "string" && ["AA", "Q", "W", "R", "E"].includes(action),
  );
  if (actions.length !== value.length || actions.length === 0)
    throw new Error("Actions contain an unsupported action.");
  return actions;
}

function normalizeManualTarget(raw: unknown): Target {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const target: Target = {
    id: "manual",
    champion: "Custom target",
    health: boundedNumber(value?.health, 1, 1_000_000, 2200, "target health"),
    armor: boundedNumber(value?.armor, -500, 2000, 100, "target armor"),
    magicResist: boundedNumber(value?.magicResist, -500, 2000, 60, "target magic resist"),
    bonusHealth: boundedNumber(value?.bonusHealth, 0, 1_000_000, 500, "target bonus health"),
    level: boundedInt(value?.level, 1, 18, 13, "target level"),
    provenance: "fixture",
  };
  if (target.bonusHealth >= target.health) {
    throw new Error("Target bonus health must be lower than total health.");
  }
  return target;
}

function summarizeTargets(targets: Target[]) {
  const metric = (key: "health" | "bonusHealth" | "armor" | "magicResist" | "level" | "minute") =>
    targets.map((target) => ({
      value: Number(target[key] ?? 0),
      weight: target.sampleWeight ?? 1,
    }));
  return {
    health: bands(metric("health")),
    bonusHealth: bands(metric("bonusHealth")),
    armor: bands(metric("armor")),
    magicResist: bands(metric("magicResist")),
    level: bands(metric("level")),
    minute: bands(metric("minute")),
  };
}

function bands(values: Array<{ value: number; weight: number }>) {
  return {
    p25: round(weightedQuantile(values, 0.25)),
    median: round(weightedQuantile(values, 0.5)),
    p75: round(weightedQuantile(values, 0.75)),
  };
}

function breakpointGrid(
  base: Omit<SimulationInput, "build" | "target">,
  a: Build,
  b: Build,
  target: Target,
) {
  const rows: Array<{ armor: number; bonusHealth: number; a: number; b: number; delta: number }> =
    [];
  for (const armor of [0, 50, 100, 150, 200, 250, 300]) {
    for (const bonusHealth of [0, 500, 1000, 1500, 2000]) {
      const point = { ...target, id: `breakpoint-${armor}-${bonusHealth}`, armor, bonusHealth };
      const resultA = simulateYunara({ ...base, build: a, target: point });
      const resultB = simulateYunara({ ...base, build: b, target: point });
      rows.push({
        armor,
        bonusHealth,
        a: resultA.totalDamage,
        b: resultB.totalDamage,
        delta: resultA.totalDamage - resultB.totalDamage,
      });
    }
  }
  return rows;
}

function boundedChoice(value: unknown, allowed: string[], fallback: string): string {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

function boundedInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  label: string,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  return parsed;
}

function boundedNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  label: string,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max)
    throw new Error(`${label} must be between ${min} and ${max}.`);
  return parsed;
}
