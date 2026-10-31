import { isCompletedLegendary, type StaticItemShape } from "./observed-items.ts";

/** A single observed inventory state before match/level deduplication. */
export interface InventoryObservation {
  matchKey: string;
  participantKey: string;
  level: number;
  timestampMs: number;
  itemIds: number[];
}

export interface ClassifiedInventory {
  completedLegendaryIds: number[];
  bootsIds: number[];
  bootTier: "none" | "basic" | "upgraded";
  componentOrOtherIds: number[];
}

export interface ProgressionDistributionRow {
  count: number;
  observations: number;
  percent: number;
}

export interface ProgressionRarity {
  count: number;
  /** Number of observations at or above the selected count. */
  tailObservations: number;
  /** Number of observations exactly at the selected count. */
  exactObservations: number;
  progressionPercentile: number;
  tailPercent: number;
  exactPercent: number;
}

export interface ProgressionPattern {
  itemIds: number[];
  itemNames: string[];
  observations: number;
  percent: number;
}

export interface ProgressionItemFrequency {
  itemId: number;
  itemName: string;
  observations: number;
  percent: number;
}

export interface CoreFrequency {
  itemIds: number[];
  observations: number;
  percent: number;
}

export interface LevelProgressionAggregate {
  level: number;
  sampleCount: number;
  distinctMatchCount: number;
  distribution: ProgressionDistributionRow[];
  meanCompletedLegendary: number;
  medianCompletedLegendary: number;
  modeCompletedLegendary: number;
  rarityByCount: ProgressionRarity[];
  commonPatterns: ProgressionPattern[];
  commonCompletedItems: ProgressionItemFrequency[];
  commonBoots: ProgressionItemFrequency[];
  commonComponentsOrOther: ProgressionItemFrequency[];
  supportedCoreFrequencies: CoreFrequency[];
  commonBootId: number | null;
  commonBootTier: "none" | "basic" | "upgraded";
}

export interface ProgressionSelection extends LevelProgressionAggregate {
  requestedLevel: number;
  levelsUsed: number[];
  exactLevelSampleCount: number;
  fallbackUsed: boolean;
  fallbackLabel: string;
  lowSample: boolean;
  recommendedObservedItemIds: number[];
  recommendedSupportedItemIds: number[];
  /** Observed completed items in the mode core that are not supported by the combat engine. */
  recommendedExcludedItemIds: number[];
  recommendedExcludedItemNames: string[];
  recommendedBootId: number | null;
}

export interface ProgressionAggregateResult {
  dedupedObservationCount: number;
  sampleThreshold: number;
  levels: LevelProgressionAggregate[];
  selection: ProgressionSelection;
}

export interface ProgressionOptions {
  sampleThreshold?: number;
  maxWidenRadius?: number;
  supportedItemIds?: number[];
}

/**
 * Inventory rows are emitted once per timeline frame. Keep only the final frame observed while
 * a participant was at each level. This gives every match/participant/level one vote, so a long
 * level interval cannot dominate the empirical distribution.
 */
export function dedupeLevelObservations(
  observations: InventoryObservation[],
): InventoryObservation[] {
  const selected = new Map<string, InventoryObservation>();
  for (const observation of observations) {
    const level = clampLevel(observation.level);
    const normalized: InventoryObservation = {
      ...observation,
      level,
      timestampMs: finiteInt(observation.timestampMs),
      itemIds: observation.itemIds.filter((id) => Number.isInteger(id)),
    };
    const key = `${normalized.matchKey}\u0000${normalized.participantKey}\u0000${level}`;
    const previous = selected.get(key);
    if (
      !previous ||
      normalized.timestampMs > previous.timestampMs ||
      (normalized.timestampMs === previous.timestampMs &&
        normalized.itemIds.join(",") > previous.itemIds.join(","))
    ) {
      selected.set(key, normalized);
    }
  }
  return [...selected.values()].sort(
    (left, right) =>
      left.level - right.level ||
      left.matchKey.localeCompare(right.matchKey) ||
      left.participantKey.localeCompare(right.participantKey),
  );
}

export function classifyInventory(
  itemIds: number[],
  catalog: Map<number, StaticItemShape>,
): ClassifiedInventory {
  const completedLegendaryIds: number[] = [];
  const bootsIds: number[] = [];
  const componentOrOtherIds: number[] = [];
  for (const itemId of itemIds) {
    const item = catalog.get(itemId);
    if (!item) {
      componentOrOtherIds.push(itemId);
    } else if (isCompletedLegendary(item)) {
      completedLegendaryIds.push(itemId);
    } else if (isBoot(item)) {
      bootsIds.push(itemId);
    } else {
      componentOrOtherIds.push(itemId);
    }
  }
  const bootTier =
    bootsIds.length === 0
      ? "none"
      : bootsIds.some((id) => isUpgradedBoot(catalog.get(id)!))
        ? "upgraded"
        : "basic";
  return { completedLegendaryIds, bootsIds, bootTier, componentOrOtherIds };
}

export function aggregateProgression(
  observations: InventoryObservation[],
  catalog: Map<number, StaticItemShape>,
  requestedLevel: number,
  options: ProgressionOptions = {},
): ProgressionAggregateResult {
  const sampleThreshold = clampInt(options.sampleThreshold ?? 20, 1, 10_000);
  const maxWidenRadius = clampInt(options.maxWidenRadius ?? 2, 0, 8);
  const supportedItemIds = [
    ...new Set((options.supportedItemIds ?? []).filter(Number.isInteger)),
  ].sort((left, right) => left - right);
  const deduped = dedupeLevelObservations(observations);
  const byLevel = new Map<number, InventoryObservation[]>();
  for (const observation of deduped) {
    const rows = byLevel.get(observation.level) ?? [];
    rows.push(observation);
    byLevel.set(observation.level, rows);
  }
  const levels = Array.from({ length: 18 }, (_, index) =>
    aggregateLevel(index + 1, byLevel.get(index + 1) ?? [], catalog, supportedItemIds),
  );
  const requested = clampLevel(requestedLevel);
  const exact = byLevel.get(requested) ?? [];
  const pool = choosePool(byLevel, requested, sampleThreshold, maxWidenRadius);
  const selectedBase = aggregateLevel(requested, pool.rows, catalog, supportedItemIds);
  const fallbackUsed = pool.levels.length !== 1 || pool.levels[0] !== requested;
  const fallbackLabel = fallbackUsed
    ? `Nearby-level fallback: levels ${pool.levels.join("/")} (${pool.rows.length} deduped observations)`
    : `Exact level ${requested} (${exact.length} deduped observations)`;
  const recommendedPattern =
    selectedBase.commonPatterns.find(
      (pattern) => pattern.itemIds.length === selectedBase.modeCompletedLegendary,
    ) ?? selectedBase.commonPatterns[0];
  const recommendedObservedItemIds = recommendedPattern?.itemIds ?? [];
  const recommendedSupportedItemIds = recommendedObservedItemIds.filter((id) =>
    supportedItemIds.includes(id),
  );
  const recommendedExcludedItemIds = recommendedObservedItemIds.filter(
    (id) => !recommendedSupportedItemIds.includes(id),
  );
  const recommendedExcludedItemNames = recommendedPattern
    ? recommendedPattern.itemIds
        .map((id, index) =>
          recommendedExcludedItemIds.includes(id) ? recommendedPattern.itemNames[index] : null,
        )
        .filter((name): name is string => Boolean(name))
    : [];
  return {
    dedupedObservationCount: deduped.length,
    sampleThreshold,
    levels,
    selection: {
      ...selectedBase,
      requestedLevel: requested,
      levelsUsed: pool.levels,
      exactLevelSampleCount: exact.length,
      fallbackUsed,
      fallbackLabel,
      lowSample: selectedBase.sampleCount < sampleThreshold || exact.length < sampleThreshold,
      recommendedObservedItemIds,
      recommendedSupportedItemIds,
      recommendedExcludedItemIds,
      recommendedExcludedItemNames,
      recommendedBootId: selectedBase.commonBootId,
    },
  };
}

export function progressionRarity(
  aggregate: Pick<LevelProgressionAggregate, "distribution" | "sampleCount">,
  count: number,
): ProgressionRarity {
  const normalized = Math.max(0, Math.round(count));
  const less = aggregate.distribution
    .filter((row) => row.count < normalized)
    .reduce((sum, row) => sum + row.observations, 0);
  const equal = aggregate.distribution.find((row) => row.count === normalized)?.observations ?? 0;
  const atLeast = aggregate.distribution
    .filter((row) => row.count >= normalized)
    .reduce((sum, row) => sum + row.observations, 0);
  const denominator = Math.max(1, aggregate.sampleCount);
  return {
    count: normalized,
    tailObservations: atLeast,
    exactObservations: equal,
    progressionPercentile: roundPercent(((less + equal / 2) / denominator) * 100),
    tailPercent: roundPercent((atLeast / denominator) * 100),
    exactPercent: roundPercent((equal / denominator) * 100),
  };
}

function aggregateLevel(
  level: number,
  observations: InventoryObservation[],
  catalog: Map<number, StaticItemShape>,
  supportedItemIds: number[],
): LevelProgressionAggregate {
  const classified = observations.map((observation) => ({
    observation,
    inventory: classifyInventory(observation.itemIds, catalog),
  }));
  const counts = classified.map((row) => row.inventory.completedLegendaryIds.length);
  const distribution = distributionFor(counts);
  const patterns = countPatterns(
    classified.map((row) => row.inventory.completedLegendaryIds),
    catalog,
    observations.length,
  );
  const completedItems = countItems(
    classified.map((row) => row.inventory.completedLegendaryIds),
    catalog,
    observations.length,
  );
  const boots = countItems(
    classified.map((row) => row.inventory.bootsIds),
    catalog,
    observations.length,
  );
  const components = countItems(
    classified.map((row) => row.inventory.componentOrOtherIds),
    catalog,
    observations.length,
  );
  const supportedCoreFrequencies = coreFrequencies(
    classified.map((row) => row.inventory.completedLegendaryIds),
    supportedItemIds,
    observations.length,
  );
  const bootTiers = new Map<"none" | "basic" | "upgraded", number>();
  for (const row of classified) {
    bootTiers.set(row.inventory.bootTier, (bootTiers.get(row.inventory.bootTier) ?? 0) + 1);
  }
  const commonBoot = boots[0];
  const commonTier = commonBoot
    ? isUpgradedBoot(catalog.get(commonBoot.itemId)!)
      ? "upgraded"
      : "basic"
    : ([...bootTiers.entries()].sort(
        (left, right) => right[1] - left[1] || bootTierOrder(left[0]) - bootTierOrder(right[0]),
      )[0]?.[0] ?? "none");
  return {
    level,
    sampleCount: observations.length,
    distinctMatchCount: new Set(observations.map((observation) => observation.matchKey)).size,
    distribution,
    meanCompletedLegendary: roundNumber(mean(counts)),
    medianCompletedLegendary: roundNumber(median(counts)),
    modeCompletedLegendary: mode(counts),
    rarityByCount: distribution.map((row) =>
      progressionRarity({ distribution, sampleCount: observations.length }, row.count),
    ),
    commonPatterns: patterns,
    commonCompletedItems: completedItems,
    commonBoots: boots,
    commonComponentsOrOther: components,
    supportedCoreFrequencies,
    commonBootId: commonBoot?.itemId ?? null,
    commonBootTier: commonTier,
  };
}

function choosePool(
  byLevel: Map<number, InventoryObservation[]>,
  requested: number,
  threshold: number,
  maxRadius: number,
): { levels: number[]; rows: InventoryObservation[] } {
  let best: { levels: number[]; rows: InventoryObservation[] } | null = null;
  for (let radius = 0; radius <= maxRadius; radius += 1) {
    const levels = Array.from({ length: radius * 2 + 1 }, (_, index) => requested - radius + index)
      .filter((level) => level >= 1 && level <= 18)
      .sort((left, right) => left - right);
    const rows = levels.flatMap((level) => byLevel.get(level) ?? []);
    if (rows.length > 0) best = { levels, rows };
    if (rows.length >= threshold) return { levels, rows };
  }
  if (best) return best;
  return { levels: [], rows: [] };
}

function countPatterns(
  itemSets: number[][],
  catalog: Map<number, StaticItemShape>,
  total: number,
): ProgressionPattern[] {
  const counts = new Map<string, { itemIds: number[]; observations: number }>();
  for (const ids of itemSets) {
    const itemIds = [...new Set(ids)].sort((left, right) => left - right);
    const key = itemIds.join(",");
    const previous = counts.get(key) ?? { itemIds, observations: 0 };
    previous.observations += 1;
    counts.set(key, previous);
  }
  return [...counts.values()]
    .sort(
      (left, right) =>
        right.observations - left.observations ||
        left.itemIds.join(",").localeCompare(right.itemIds.join(",")),
    )
    .slice(0, 8)
    .map((pattern) => ({
      ...pattern,
      itemNames: pattern.itemIds.map((id) => catalog.get(id)?.name ?? `Item ${id}`),
      percent: roundPercent((pattern.observations / Math.max(1, total)) * 100),
    }));
}

function countItems(
  itemSets: number[][],
  catalog: Map<number, StaticItemShape>,
  total: number,
): ProgressionItemFrequency[] {
  const counts = new Map<number, number>();
  for (const ids of itemSets) {
    for (const id of new Set(ids)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .slice(0, 8)
    .map(([itemId, observations]) => ({
      itemId,
      itemName: catalog.get(itemId)?.name ?? `Item ${itemId}`,
      observations,
      percent: roundPercent((observations / Math.max(1, total)) * 100),
    }));
}

function coreFrequencies(
  itemSets: number[][],
  supportedItemIds: number[],
  total: number,
): CoreFrequency[] {
  // Only enumerate combinations that occur in at least one observed inventory.
  // Enumerating every subset of the whole item catalog made a small cohort produce
  // hundreds of thousands of zero-frequency rows and made the progression endpoint
  // needlessly slow. This preserves the useful "selected core appeared in" query
  // while bounding work by observed rows (at most 2^6 subsets per inventory).
  const supported = new Set(supportedItemIds);
  const candidateKeys = new Set<string>();
  for (const source of itemSets) {
    const ids = [...new Set(source.filter((id) => supported.has(id)))].sort((a, b) => a - b);
    for (let mask = 1; mask < 1 << ids.length; mask += 1) {
      const subset = ids.filter((_, index) => (mask & (1 << index)) !== 0);
      candidateKeys.add(subset.join(","));
    }
  }
  const frequencies: CoreFrequency[] = [...candidateKeys].map((key) => {
    const ids = key.split(",").map(Number);
    const observations = itemSets.filter((set) => ids.every((id) => set.includes(id))).length;
    return {
      itemIds: ids,
      observations,
      percent: roundPercent((observations / Math.max(1, total)) * 100),
    };
  });
  frequencies.sort(
    (left, right) =>
      right.itemIds.length - left.itemIds.length ||
      right.observations - left.observations ||
      left.itemIds.join(",").localeCompare(right.itemIds.join(",")),
  );
  return frequencies;
}

function distributionFor(counts: number[]): ProgressionDistributionRow[] {
  const map = new Map<number, number>();
  for (const count of counts) map.set(count, (map.get(count) ?? 0) + 1);
  return [...map.entries()]
    .sort(([left], [right]) => left - right)
    .map(([count, observations]) => ({
      count,
      observations,
      percent: roundPercent((observations / Math.max(1, counts.length)) * 100),
    }));
}

function isBoot(item: StaticItemShape): boolean {
  return item.tags.some((tag) => tag.toLowerCase() === "boots");
}

function isUpgradedBoot(item: StaticItemShape): boolean {
  return isBoot(item) && (item.fromIds.length > 0 || item.goldTotal >= 700);
}

function bootTierOrder(tier: "none" | "basic" | "upgraded"): number {
  return tier === "upgraded" ? 2 : tier === "basic" ? 1 : 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function mode(values: number[]): number {
  if (values.length === 0) return 0;
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const max = Math.max(...counts.values());
  const medianValue = median(values);
  return [...counts.entries()]
    .filter(([, count]) => count === max)
    .sort(
      (left, right) =>
        Math.abs(left[0] - medianValue) - Math.abs(right[0] - medianValue) || left[0] - right[0],
    )[0]![0];
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clampLevel(value: number): number {
  return clampInt(value, 1, 18);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? Math.round(value) : min));
}

function finiteInt(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}
