/**
 * Pure helpers that turn engine output into the shapes the lab view reads:
 * the item that actually differs between two builds, a per-window verdict,
 * and a breakpoint grid whose empty region is stated once instead of printed
 * as rows of zeroes.
 */
import { ITEMS } from "./items.ts";
import type { DamageEvent, SampleComparison } from "./types.ts";

export interface BuildDiff {
  shared: number[];
  onlyA: number[];
  onlyB: number[];
}

/** Items held by both builds, and the items unique to each side. */
export function buildDiff(a: number[], b: number[]): BuildDiff {
  const remaining = [...b];
  const shared: number[] = [];
  const onlyA: number[] = [];
  for (const id of a) {
    const index = remaining.indexOf(id);
    if (index === -1) onlyA.push(id);
    else {
      shared.push(id);
      remaining.splice(index, 1);
    }
  }
  return { shared, onlyA, onlyB: remaining };
}

export function itemLabel(id: number): string {
  return ITEMS[id]?.name ?? `Item ${id}`;
}

/**
 * The comparison reads as one question when each build holds exactly one item
 * the other does not. Then the labels are the two items, not the whole core.
 */
export function comparisonLabels(
  diff: BuildDiff,
  fallback: { a: string; b: string },
): { a: string; b: string; shortA: string; shortB: string; singleItem: boolean } {
  if (diff.onlyA.length === 1 && diff.onlyB.length === 1) {
    const a = itemLabel(diff.onlyA[0]!);
    const b = itemLabel(diff.onlyB[0]!);
    return { a, b, shortA: a, shortB: b, singleItem: true };
  }
  // Whole-build names are too long for chips, tiles and table headers.
  return { ...fallback, shortA: "Build A", shortB: "Build B", singleItem: false };
}

export type WindowVerdict = "a" | "b" | "tie" | "all-killed" | "no-kills";

export interface WindowSummary {
  duration: number;
  verdict: WindowVerdict;
  medianDelta: number;
  aShare: number;
  bShare: number;
  ties: number;
}

/**
 * Classify one fight length. A damage comparison in which every target dies to
 * both builds is not a tie between the items: the window is simply too long to
 * separate them, and only TTK can.
 */
export function summarizeWindow(duration: number, comparison: SampleComparison): WindowSummary {
  const aShare = weightedShare(comparison, "a");
  const bShare = weightedShare(comparison, "b");
  const everyTargetDies =
    comparison.count > 0 && comparison.aNotKilled === 0 && comparison.bNotKilled === 0;
  const decided = Math.abs(comparison.weightedOutcomes.a - comparison.weightedOutcomes.b) > 1e-9;
  const noKills =
    comparison.metric === "ttk" && comparison.count > 0 && comparison.censored === comparison.count;
  const verdict: WindowVerdict = noKills
    ? "no-kills"
    : comparison.metric === "damage" && everyTargetDies && comparison.ties === comparison.count
      ? "all-killed"
      : decided
        ? comparison.weightedOutcomes.a > comparison.weightedOutcomes.b
          ? "a"
          : "b"
        : "tie";
  return {
    duration,
    verdict,
    medianDelta: comparison.medianRelativeDelta,
    aShare,
    bShare,
    ties: comparison.ties,
  };
}

/** Share of the decided weighted mass held by one side; ties and censored rows are excluded. */
export function weightedShare(
  comparison: Pick<SampleComparison, "weightedOutcomes">,
  side: "a" | "b",
): number {
  const decisive = comparison.weightedOutcomes.a + comparison.weightedOutcomes.b;
  return decisive > 0 ? comparison.weightedOutcomes[side] / decisive : 0;
}

/** Build A takes at least this share of a group before the group reads as settled. */
export const SETTLED_SHARE = 0.75;
/** Below this many samples a group is marked thin and should not decide a build. */
export const THIN_SAMPLES = 6;

export type SliceTier = "flips" | "close" | "settled" | "undecided";

export interface SliceRow {
  key: string;
  label: string;
  /** Weighted share of the group's decided samples taken by build A. */
  share: number;
  count: number;
  decided: number;
  tier: SliceTier;
}

export function sliceTier(share: number, decided: number): SliceTier {
  if (decided === 0) return "undecided";
  if (share < 0.5) return "flips";
  return share < SETTLED_SHARE ? "close" : "settled";
}

export function sliceRow(
  key: string,
  label: string,
  group: { count: number; decided: number; buildAWinRate: number },
): SliceRow {
  return {
    key,
    label,
    share: group.buildAWinRate,
    count: group.count,
    decided: group.decided,
    tier: sliceTier(group.buildAWinRate, group.decided),
  };
}

export interface SliceGroups {
  /** Groups that contradict the headline, worst first. */
  contested: SliceRow[];
  settled: SliceRow[];
  undecided: SliceRow[];
  /** Sample range across the settled groups, for the one-line summary. */
  settledRange: { min: number; max: number } | null;
}

/**
 * Split one axis of the cohort into the groups that argue with the headline and
 * the groups that agree. The agreeing side is a count and a sample range, not a
 * row per name: repeating "wins every sample" forty times hides the exceptions.
 */
export function groupSlices(rows: SliceRow[]): SliceGroups {
  const contested = rows
    .filter((row) => row.tier === "flips" || row.tier === "close")
    .sort((left, right) => left.share - right.share);
  const settled = rows.filter((row) => row.tier === "settled");
  const counts = settled.map((row) => row.count);
  return {
    contested,
    settled,
    undecided: rows.filter((row) => row.tier === "undecided"),
    settledRange: counts.length ? { min: Math.min(...counts), max: Math.max(...counts) } : null,
  };
}

export interface BreakpointCell {
  bonusHealth: number;
  delta: number;
}

export interface BreakpointRow {
  armor: number;
  cells: BreakpointCell[];
}

export interface BreakpointGrid {
  bonusHealthValues: number[];
  /** Leading armor values whose whole row shows no difference, stated as one row. */
  flatArmorValues: number[];
  rows: BreakpointRow[];
  maxAbsDelta: number;
}

/**
 * Group the flat breakpoint list into rows and fold the leading no-difference
 * region into a single labelled row, so the eye lands on the armor range where
 * the answer changes.
 */
export function breakpointGrid(
  rows: Array<{ armor: number; bonusHealth: number; delta: number }>,
): BreakpointGrid {
  const bonusHealthValues = [...new Set(rows.map((row) => row.bonusHealth))].sort(
    (left, right) => left - right,
  );
  const armorValues = [...new Set(rows.map((row) => row.armor))].sort(
    (left, right) => left - right,
  );
  const grouped: BreakpointRow[] = armorValues.map((armor) => ({
    armor,
    cells: bonusHealthValues.map((bonusHealth) => ({
      bonusHealth,
      delta: rows.find((row) => row.armor === armor && row.bonusHealth === bonusHealth)?.delta ?? 0,
    })),
  }));
  const flatArmorValues: number[] = [];
  while (grouped.length > 0 && grouped[0]!.cells.every((cell) => Math.round(cell.delta) === 0)) {
    flatArmorValues.push(grouped.shift()!.armor);
  }
  const maxAbsDelta = grouped.reduce(
    (max, row) => row.cells.reduce((rowMax, cell) => Math.max(rowMax, Math.abs(cell.delta)), max),
    0,
  );
  return { bonusHealthValues, flatArmorValues, rows: grouped, maxAbsDelta };
}

export interface SlotEditorModel {
  /** Items held by both builds, with the slot index each build stores them in. */
  shared: Array<{ id: number; aIndex: number; bIndex: number }>;
  onlyA: Array<{ id: number; index: number }>;
  onlyB: Array<{ id: number; index: number }>;
}

/**
 * Split two build-slot arrays into the shared core and the slots unique to each
 * side, keeping the slot indices so an edit can be written back. Empty slots
 * (zero) belong to the side that holds them.
 */
export function slotEditorModel(a: Array<number | 0>, b: Array<number | 0>): SlotEditorModel {
  const takenB = new Set<number>();
  const shared: SlotEditorModel["shared"] = [];
  const onlyA: SlotEditorModel["onlyA"] = [];
  a.forEach((id, index) => {
    if (id > 0) {
      const match = b.findIndex(
        (candidate, candidateIndex) => candidate === id && !takenB.has(candidateIndex),
      );
      if (match !== -1) {
        takenB.add(match);
        shared.push({ id, aIndex: index, bIndex: match });
        return;
      }
    }
    onlyA.push({ id, index });
  });
  const onlyB = b.map((id, index) => ({ id, index })).filter((slot) => !takenB.has(slot.index));
  return { shared, onlyA, onlyB };
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

export interface TraceCycle {
  time: number;
  perSource: Record<string, number>;
  total: number;
  running: number;
  label: string;
}

export interface TraceCycles {
  sources: string[];
  cycles: TraceCycle[];
  applied: number;
}

const MAX_TRACE_SOURCES = 5;

/**
 * Collapse the shot-by-shot log into one row per attack cycle. The raw log
 * repeats the same on-hit sources every attack, which hides the shape of the
 * fight; a cycle row plus a running total shows how the kill is reached.
 */
export function traceCycles(events: DamageEvent[]): TraceCycles {
  const totalsBySource = new Map<string, number>();
  for (const event of events) {
    totalsBySource.set(event.source, (totalsBySource.get(event.source) ?? 0) + event.final);
  }
  const ranked = [...totalsBySource.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([source]) => source);
  const sources = ranked.slice(0, MAX_TRACE_SOURCES);
  const hasOther = ranked.length > sources.length;
  const columns = hasOther ? [...sources, "Other"] : sources;

  const cycles: TraceCycle[] = [];
  let running = 0;
  for (const event of events) {
    const time = Math.round(event.time * 100) / 100;
    let cycle = cycles[cycles.length - 1];
    if (!cycle || cycle.time !== time) {
      cycle = { time, perSource: {}, total: 0, running: 0, label: `${time.toFixed(2)}s` };
      cycles.push(cycle);
    }
    const column = sources.includes(event.source) ? event.source : "Other";
    cycle.perSource[column] = (cycle.perSource[column] ?? 0) + event.final;
    cycle.total += event.final;
    running += event.final;
    cycle.running = running;
  }
  return { sources: columns, cycles, applied: running };
}
