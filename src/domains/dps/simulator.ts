import { round, weightedQuantile } from "./math.ts";
import type { Build, SampleComparison, SimulationInput, Target } from "./types.ts";
import { yunara } from "./champions/yunara.ts";

export function simulateYunara(input: SimulationInput) {
  return yunara.simulate(input);
}

export interface CompareOptions {
  includeEvents?: boolean;
  /** `damage` is applied damage in the configured window; `ttk` ranks first-crossing time. */
  metric?: "damage" | "ttk";
}

export function compareAcrossSamples(
  base: Omit<SimulationInput, "build" | "target">,
  buildA: Build,
  buildB: Build,
  targets: Target[],
  options: CompareOptions = {},
): SampleComparison {
  const includeEvents = options.includeEvents !== false;
  const metric = options.metric ?? "damage";
  const rows = targets.map((target) => {
    const simulatedA = simulateYunara({ ...base, build: buildA, target });
    const simulatedB = simulateYunara({ ...base, build: buildB, target });
    const a = includeEvents ? simulatedA : { ...simulatedA, events: [] };
    const b = includeEvents ? simulatedB : { ...simulatedB, events: [] };
    const relativeDelta = b.totalDamage === 0 ? 0 : (a.totalDamage - b.totalDamage) / b.totalDamage;
    const outcome = compareOutcome(a, b, metric);
    return {
      target,
      a,
      b,
      relativeDelta: Number.isFinite(relativeDelta) ? relativeDelta : 0,
      metricDelta: metricDelta(a, b, metric),
      outcome,
    };
  });
  const weighted = rows
    .filter((row) => row.metricDelta !== null)
    .map((row) => ({ value: row.metricDelta!, weight: targetWeight(row.target) }));
  const totalWeight = targets.reduce((sum, target) => sum + targetWeight(target), 0);
  const weightedOutcomes = rows.reduce(
    (mass, row) => {
      mass[row.outcome] += targetWeight(row.target);
      return mass;
    },
    { a: 0, b: 0, tie: 0, censored: 0 },
  );
  const decisive = rows.filter((row) => row.outcome !== "censored");
  const stats = outcomeStats(rows);
  const distinctMatchCount = new Set(rows.map((row) => row.target.sourceMatchKey ?? row.target.id))
    .size;
  const roles = [...new Set(rows.map((row) => row.target.role ?? "UNKNOWN"))];
  const champions = [...new Set(rows.map((row) => row.target.champion))];
  return {
    metric,
    count: rows.length,
    distinctMatchCount,
    totalWeight: round(totalWeight, 4),
    weightedOutcomes: Object.fromEntries(
      Object.entries(weightedOutcomes).map(([key, value]) => [key, round(value, 6)]),
    ) as typeof weightedOutcomes,
    buildAWinRate: weightedWinRate(decisive),
    medianRelativeDelta: round(weightedQuantile(weighted, 0.5) * 100, 2),
    p25RelativeDelta: round(weightedQuantile(weighted, 0.25) * 100, 2),
    p75RelativeDelta: round(weightedQuantile(weighted, 0.75) * 100, 2),
    aWins: stats.aWins,
    bWins: stats.bWins,
    ties: stats.ties,
    censored: stats.censored,
    aNotKilled: rows.filter((row) => !row.a.killed).length,
    bNotKilled: rows.filter((row) => !row.b.killed).length,
    byRole: roles
      .map((role) => {
        const group = rows.filter((row) => (row.target.role ?? "UNKNOWN") === role);
        return {
          role,
          count: group.length,
          decided: decidedCount(group),
          buildAWinRate: weightedWinRate(group.filter((row) => row.outcome !== "censored")),
        };
      })
      .filter((group) => group.count >= 2),
    byChampion: champions
      .map((champion) => {
        const group = rows.filter((row) => row.target.champion === champion);
        return {
          champion,
          count: group.length,
          decided: decidedCount(group),
          buildAWinRate: weightedWinRate(group.filter((row) => row.outcome !== "censored")),
        };
      })
      .filter((group) => group.count >= 2),
    rows,
  };
}

/**
 * Selects the headline from the same weighted outcome mass used by the cohort bar.
 * Ties and censored rows are neutral; only weighted A/B mass chooses a winner.
 */
export function weightedHeadlineWinner(
  comparison: Pick<SampleComparison, "weightedOutcomes">,
): "a" | "b" | "tie" {
  const { a, b } = comparison.weightedOutcomes;
  if (Math.abs(a - b) < 1e-9) return "tie";
  return a > b ? "a" : "b";
}

function targetWeight(target: Target): number {
  return Number.isFinite(target.sampleWeight) && (target.sampleWeight ?? 0) > 0
    ? target.sampleWeight!
    : 1;
}

function compareOutcome(
  a: ReturnType<typeof simulateYunara>,
  b: ReturnType<typeof simulateYunara>,
  metric: "damage" | "ttk",
): "a" | "b" | "tie" | "censored" {
  if (metric === "ttk") {
    if (a.killed && b.killed) {
      if (a.ttk === null || b.ttk === null) return "censored";
      if (Math.abs(a.ttk - b.ttk) < 1e-9) return "tie";
      return a.ttk < b.ttk ? "a" : "b";
    }
    if (a.killed) return "a";
    if (b.killed) return "b";
    return "censored";
  }
  // In mortal fixed-window mode, two kills are an applied-damage tie: overkill is not a win.
  if (a.killed && b.killed) return "tie";
  if (a.killed) return "a";
  if (b.killed) return "b";
  if (Math.abs(a.totalDamage - b.totalDamage) < 1e-9) return "tie";
  return a.totalDamage > b.totalDamage ? "a" : "b";
}

function metricDelta(
  a: ReturnType<typeof simulateYunara>,
  b: ReturnType<typeof simulateYunara>,
  metric: "damage" | "ttk",
): number | null {
  if (metric === "damage") {
    if (b.totalDamage === 0) return a.totalDamage === 0 ? 0 : null;
    return (a.totalDamage - b.totalDamage) / b.totalDamage;
  }
  if (!a.killed || !b.killed || a.ttk === null || b.ttk === null || b.ttk === 0) return null;
  return (b.ttk - a.ttk) / b.ttk;
}

function outcomeStats(rows: Array<{ outcome: "a" | "b" | "tie" | "censored" }>) {
  return {
    aWins: rows.filter((row) => row.outcome === "a").length,
    bWins: rows.filter((row) => row.outcome === "b").length,
    ties: rows.filter((row) => row.outcome === "tie").length,
    censored: rows.filter((row) => row.outcome === "censored").length,
  };
}

/** Rows that chose a side. A group with none has a win rate of zero for want of a decision. */
function decidedCount(rows: Array<{ outcome: "a" | "b" | "tie" | "censored" }>): number {
  return rows.filter((row) => row.outcome === "a" || row.outcome === "b").length;
}

function weightedWinRate(
  rows: Array<{
    target: Target;
    outcome: "a" | "b" | "tie" | "censored";
  }>,
): number {
  const decisive = rows.filter((row) => row.outcome === "a" || row.outcome === "b");
  const total = decisive.reduce((sum, row) => sum + targetWeight(row.target), 0);
  if (!total) return 0;
  return round(
    decisive.reduce((sum, row) => sum + (row.outcome === "a" ? targetWeight(row.target) : 0), 0) /
      total,
    6,
  );
}
