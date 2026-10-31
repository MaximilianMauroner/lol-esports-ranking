export function resistanceMultiplier(resistance: number): number {
  return resistance >= 0 ? 100 / (100 + resistance) : 2 - 100 / (100 - resistance);
}

export function mitigate(rawDamage: number, resistance: number): number {
  return rawDamage * resistanceMultiplier(resistance);
}

export function applyPercentArmorPenetration(armor: number, percent: number): number {
  return armor * (1 - Math.max(0, Math.min(1, percent)));
}

/** Percent penetration sources stack multiplicatively in League. */
export function applyPercentPenetrationSources(
  resistance: number,
  percentages: readonly number[],
): number {
  return percentages.reduce(
    (remaining, percent) => applyPercentArmorPenetration(remaining, percent),
    resistance,
  );
}

// Riot champion growth curve, used for stats stored as "per level".
export function growthAtLevel(perLevel: number, level: number): number {
  const levels = Math.max(0, Math.min(17, level - 1));
  return perLevel * levels * (0.7025 + 0.0175 * levels);
}

export function quantile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const fraction = index - low;
  return sorted[low]! + (sorted[low + 1] ?? sorted[low]!) * fraction - sorted[low]! * fraction;
}

export function weightedQuantile(
  values: Array<{ value: number; weight: number }>,
  p: number,
): number {
  if (values.length === 0) return 0;
  const sorted = values
    .filter(
      (entry) => Number.isFinite(entry.value) && Number.isFinite(entry.weight) && entry.weight > 0,
    )
    .sort((a, b) => a.value - b.value);
  if (sorted.length === 0) return 0;
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  const target = Math.max(0, Math.min(1, p)) * total;
  let running = 0;
  for (const entry of sorted) {
    running += entry.weight;
    if (running >= target) return entry.value;
  }
  return sorted[sorted.length - 1]!.value;
}

export function round(value: number, digits = 1): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
