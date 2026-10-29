import type { AbilityRanks } from "../../../src/domains/dps/types.ts";
import type { SkillProgression } from "../../../src/domains/dps/datasets.ts";
import { query } from "../db/client.ts";
import { defaultSkillRanks, type SkillKey } from "../../../src/domains/dps/skills.ts";
import { archiveEnabled, readArchivedSource } from "../storage/archive.ts";



interface ArchiveRow {
  object_key: string;
  source_match_id: string;
  yunara_participant_id: number;
}

interface SkillObservation {
  level: number;
  ranks: AbilityRanks;
  order: SkillKey[];
}

let cached: { expiresAt: number; observations: SkillObservation[] } | null = null;

export async function getYunaraSkillProgression(level: number): Promise<SkillProgression> {
  const requestedLevel = Math.max(1, Math.min(18, Math.round(level)));
  const fallback = fallbackSkillProgression(requestedLevel);
  if (!archiveEnabled()) return fallback;
  try {
    const observations = await loadObservations();
    if (observations.length === 0) return fallback;
    const exact = observations.filter((observation) => observation.level === requestedLevel);
    const levels =
      exact.length >= 20 ? [requestedLevel] : nearbyLevels(observations, requestedLevel);
    const pool = observations.filter((observation) => levels.includes(observation.level));
    if (pool.length === 0) return fallback;
    const common = modeObservation(pool);
    return {
      requestedLevel,
      ranks: common.ranks,
      order: common.order,
      sampleCount: pool.length,
      levelsUsed: levels,
      provenance: "timeline",
      note:
        levels.length === 1
          ? `Common Yunara skill ranks from ${pool.length} archived timeline observations at level ${requestedLevel}.`
          : `Nearby-level skill fallback using levels ${levels.join("/")} (${pool.length} archived timeline observations).`,
    };
  } catch {
    return fallback;
  }
}

async function loadObservations(): Promise<SkillObservation[]> {
  if (cached && cached.expiresAt > Date.now()) return cached.observations;
  const rows = await query<ArchiveRow>(
    `SELECT DISTINCT ao.object_key, ao.source_match_id, p.participant_id AS yunara_participant_id
       FROM lol_dps.archive_objects ao
       JOIN lol_dps.participants p ON p.match_id = ao.source_match_id
      WHERE ao.object_kind = 'match-source'
        AND ao.status = 'verified'
        AND ao.patch = '26.18'
        AND p.champion_id = 804
      ORDER BY ao.source_match_id
      LIMIT 200`,
  );
  const observations: SkillObservation[] = [];
  for (const row of rows) {
    try {
      const source = await readArchivedSource(row.object_key);
      observations.push(...extractSkillObservations(source.timeline, [row.yunara_participant_id]));
    } catch {
      // One corrupt/missing archive should not make the level UI unusable.
    }
  }
  cached = { expiresAt: Date.now() + 5 * 60_000, observations };
  return observations;
}

export function extractSkillObservations(
  timeline: unknown,
  participantIds?: Iterable<string | number>,
): SkillObservation[] {
  const value = timeline as {
    info?: {
      frames?: Array<{
        timestamp?: number;
        participantFrames?: Record<string, { level?: number }>;
        events?: Array<Record<string, unknown>>;
      }>;
    };
  };
  const frames = [...(value.info?.frames ?? [])].sort(
    (left, right) => Number(left.timestamp ?? 0) - Number(right.timestamp ?? 0),
  );
  const yunaraIds = new Set<string>(
    participantIds === undefined ? [] : [...participantIds].map((id) => String(id)),
  );
  for (const frame of frames) {
    for (const event of frame.events ?? []) {
      if (
        event.type === "SKILL_LEVEL_UP" &&
        event.participantId != null &&
        (participantIds === undefined || yunaraIds.has(String(event.participantId)))
      )
        yunaraIds.add(String(event.participantId));
    }
  }
  const byId = new Map<string, { level: number; slot: number; timestamp: number }[]>();
  for (const frame of frames) {
    const frameTimestamp = Number(frame.timestamp ?? 0);
    for (const event of frame.events ?? []) {
      if (
        event.type !== "SKILL_LEVEL_UP" ||
        event.participantId == null ||
        !yunaraIds.has(String(event.participantId))
      )
        continue;
      const slot = Number(event.skillSlot);
      if (![1, 2, 3, 4].includes(slot)) continue;
      const participantId = String(event.participantId);
      const level = Math.max(
        1,
        Math.min(18, Number(frame.participantFrames?.[participantId]?.level ?? 1)),
      );
      const list = byId.get(participantId) ?? [];
      list.push({ level, slot, timestamp: frameTimestamp });
      byId.set(participantId, list);
    }
  }
  if (yunaraIds.size === 0) return [];
  const output: SkillObservation[] = [];
  for (const participantId of yunaraIds) {
    const events = (byId.get(participantId) ?? []).sort(
      (left, right) => left.timestamp - right.timestamp,
    );
    if (events.length === 0) continue;
    for (let level = 1; level <= 18; level += 1) {
      const ranks: AbilityRanks = { q: 0, w: 0, e: 0, r: 0 };
      const order: SkillKey[] = [];
      for (const event of events) {
        if (event.level > level) continue;
        const key = slotKey(event.slot);
        if (!key || ranks[key] >= (key === "r" ? 3 : 5)) continue;
        ranks[key] += 1;
        order.push(key);
      }
      if (ranks.q + ranks.w + ranks.e + ranks.r > 0) output.push({ level, ranks, order });
    }
  }
  return output;
}

function modeObservation(observations: SkillObservation[]): SkillObservation {
  const counts = new Map<string, { count: number; observation: SkillObservation }>();
  for (const observation of observations) {
    const key = `${observation.ranks.q}/${observation.ranks.w}/${observation.ranks.e}/${observation.ranks.r}|${observation.order.join("")}`;
    const previous = counts.get(key) ?? { count: 0, observation };
    previous.count += 1;
    counts.set(key, previous);
  }
  return [...counts.values()].sort(
    (left, right) =>
      right.count - left.count || rankScore(right.observation) - rankScore(left.observation),
  )[0]!.observation;
}

function rankScore(observation: SkillObservation): number {
  return (
    observation.ranks.q * 100 +
    observation.ranks.w * 10 +
    observation.ranks.e +
    observation.ranks.r * 1000
  );
}

function nearbyLevels(observations: SkillObservation[], requested: number): number[] {
  for (let radius = 0; radius <= 2; radius += 1) {
    const levels = Array.from(
      { length: radius * 2 + 1 },
      (_, index) => requested - radius + index,
    ).filter((level) => level >= 1 && level <= 18);
    if (observations.filter((observation) => levels.includes(observation.level)).length >= 20)
      return levels;
  }
  return [
    ...new Set(
      observations
        .map((observation) => observation.level)
        .filter((level) => Math.abs(level - requested) <= 2),
    ),
  ].sort((left, right) => left - right);
}

function fallbackSkillProgression(level: number): SkillProgression {
  const ranks = defaultSkillRanks(level);
  const order: SkillKey[] = [];
  for (let index = 0; index < ranks.q; index += 1) order.push("q");
  for (let index = 0; index < ranks.w; index += 1) order.push("w");
  for (let index = 0; index < ranks.e; index += 1) order.push("e");
  for (let index = 0; index < ranks.r; index += 1) order.push("r");
  return {
    requestedLevel: level,
    ranks,
    order,
    sampleCount: 0,
    levelsUsed: [level],
    provenance: "legal-fallback",
    note: "Archived timelines did not expose enough usable skill-up events; this is a deterministic legal rank fallback, not an observed skill order.",
  };
}

function slotKey(slot: number): SkillKey | null {
  return slot === 1 ? "q" : slot === 2 ? "w" : slot === 3 ? "e" : slot === 4 ? "r" : null;
}
