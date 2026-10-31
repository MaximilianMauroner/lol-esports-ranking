/** Pure helpers for level-matched target cohorts. Database adapters can use these
 * rules without coupling the simulator to SQL or client code. */

export interface LevelAnchorObservation<T = unknown> {
  matchId: string;
  participantId: string | number;
  level: number;
  timestampMs: number;
  value: T;
}

/** Keep one deterministic latest frame for each match/participant/champion level. */
export function dedupeLevelAnchors<T>(
  observations: Array<LevelAnchorObservation<T>>,
): Array<LevelAnchorObservation<T>> {
  const selected = new Map<string, LevelAnchorObservation<T>>();
  for (const observation of observations) {
    if (!Number.isFinite(observation.timestampMs)) continue;
    const level = Math.max(1, Math.min(18, Math.round(observation.level)));
    const normalized = { ...observation, level, timestampMs: Math.round(observation.timestampMs) };
    const key = `${observation.matchId}\u0000${observation.participantId}\u0000${level}`;
    const previous = selected.get(key);
    if (!previous || normalized.timestampMs > previous.timestampMs) selected.set(key, normalized);
  }
  return [...selected.values()].sort(
    (a, b) =>
      a.level - b.level || a.matchId.localeCompare(b.matchId) || a.timestampMs - b.timestampMs,
  );
}

/** Give each match a total weight of one, regardless of enemy-vector count. */
export function matchBalancedWeight(matchVectorCount: number): number {
  return 1 / Math.max(1, Math.round(Number.isFinite(matchVectorCount) ? matchVectorCount : 1));
}
