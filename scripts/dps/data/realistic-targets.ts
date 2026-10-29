export type { TargetDataset, TargetFilters } from "../../../src/domains/dps/datasets.ts";
import type { TargetDataset, TargetFilters } from "../../../src/domains/dps/datasets.ts";
import { createHash } from "node:crypto";
import { hasDatabase, query } from "../db/client.ts";
import { fixtureTargets } from "../../../src/domains/dps/fixtures.ts";
import type { Target } from "../../../src/domains/dps/types.ts";

interface TargetRow {
  scenario_sample_id: string;
  anchor_match_id: string;
  champion_name: string;
  role: string | null;
  tier: string | null;
  health_max: string;
  armor: string;
  magic_resist: string;
  bonus_health_estimate: string;
  bonus_health_status: "derived" | "missing-static" | "clamped" | "unknown" | null;
  level: number;
  minute: string;
  item_ids: number[] | null;
  anchor_event_timestamp_ms: number | null;
  anchor_frame_distance_ms: number | null;
  match_sample_count: string;
  game_start: string | null;
}

interface CandidateCounts {
  snapshots: number;
  matches: number;
}





const CANDIDATES = [
  { phase: "yunara-third-item", fallback: 0 },
  { phase: "bot-carry-third-item", fallback: 1 },
  { phase: "minute-window", fallback: 2 },
] as const;
const SAMPLE_LIMIT_PER_MATCH = 20;

export async function getRealisticTargets(filters?: TargetFilters): Promise<TargetDataset> {
  if (!hasDatabase()) return fixtureDataset(filters);

  const role = filters?.role && filters.role !== "ALL" ? filters.role : null;
  const champion = filters?.champion?.trim() || null;
  const rank = filters?.rank && filters.rank !== "ALL" ? filters.rank : null;
  const requestedPhase = filters?.phase;
  const region = filters?.region ?? "EUW1";
  const limit = Math.max(1, Math.min(1000, Math.round(filters?.limit ?? 1000)));
  const candidates = [...CANDIDATES];
  if (requestedPhase && candidates.some((candidate) => candidate.phase === requestedPhase)) {
    candidates.sort(
      (a, b) => Number(a.phase !== requestedPhase) - Number(b.phase !== requestedPhase),
    );
  }

  for (const candidate of candidates) {
    const values = ["26.18", region, candidate.phase, role, champion, rank];
    const where = `ss.patch = $1 AND ss.platform_region = $2 AND ss.phase = $3
          AND ($4::text IS NULL OR p.role = $4)
          AND ($5::text IS NULL OR lower(p.champion_name) = lower($5))
          AND ($6::text IS NULL OR p.tier = $6)
          AND s.bonus_health_estimate IS NOT NULL`;
    const countRows = await query<{ snapshot_count: string; match_count: string }>(
      `WITH compact AS (
         SELECT hs.anchor_match_id
           FROM lol_dps.hot_scenario_samples hs
           JOIN lol_dps.participants p
             ON p.match_id = hs.anchor_match_id AND p.participant_id = hs.target_participant_id
          WHERE hs.patch = $1 AND hs.platform_region = $2 AND hs.phase = $3
            AND ($4::text IS NULL OR p.role = $4)
            AND ($5::text IS NULL OR lower(p.champion_name) = lower($5))
            AND ($6::text IS NULL OR p.tier = $6)
            AND hs.target_bonus_health_estimate IS NOT NULL
       ), legacy AS (
         SELECT ss.anchor_match_id
           FROM lol_dps.scenario_samples ss
           JOIN lol_dps.timeline_snapshots s ON s.snapshot_id = ss.target_snapshot_id
           JOIN lol_dps.participants p
             ON p.match_id = s.match_id AND p.participant_id = s.participant_id
          WHERE ${where}
            AND NOT EXISTS (
              SELECT 1 FROM lol_dps.hot_scenario_samples hs
               WHERE hs.patch = $1 AND hs.platform_region = $2 AND hs.phase = ss.phase
            )
       ), combined AS (
         SELECT anchor_match_id FROM compact
         UNION ALL
         SELECT anchor_match_id FROM legacy
       )
       SELECT COUNT(*)::text AS snapshot_count,
              COUNT(DISTINCT anchor_match_id)::text AS match_count
         FROM combined`,
      values,
    );
    const available: CandidateCounts = {
      snapshots: Number(countRows[0]?.snapshot_count ?? 0),
      matches: Number(countRows[0]?.match_count ?? 0),
    };
    if (available.snapshots === 0) continue;

    const rows = await query<TargetRow>(
      `WITH compact_grouped AS (
         SELECT hs.hot_scenario_sample_id::text AS scenario_sample_id,
                hs.anchor_match_id, hs.anchor_event_timestamp_ms,
                hs.anchor_frame_distance_ms, p.champion_name, p.role, p.tier,
                hs.target_health_max AS health_max, hs.target_armor AS armor,
                hs.target_magic_resist AS magic_resist,
                hs.target_bonus_health_estimate AS bonus_health_estimate,
                hs.target_bonus_health_status AS bonus_health_status,
                hs.target_level AS level, hs.target_minute AS minute, m.game_start,
                hs.target_item_ids AS item_ids,
                COUNT(*) OVER (PARTITION BY hs.anchor_match_id) AS match_sample_count
           FROM lol_dps.hot_scenario_samples hs
           JOIN lol_dps.participants p
             ON p.match_id = hs.anchor_match_id AND p.participant_id = hs.target_participant_id
           JOIN lol_dps.matches m ON m.match_id = hs.anchor_match_id
          WHERE hs.patch = $1 AND hs.platform_region = $2 AND hs.phase = $3
            AND ($4::text IS NULL OR p.role = $4)
            AND ($5::text IS NULL OR lower(p.champion_name) = lower($5))
            AND ($6::text IS NULL OR p.tier = $6)
            AND hs.target_bonus_health_estimate IS NOT NULL
       ), legacy_grouped AS (
         SELECT ss.scenario_sample_id::text, ss.anchor_match_id, ss.anchor_event_timestamp_ms,
                ss.anchor_frame_distance_ms, p.champion_name, p.role, p.tier,
                s.health_max, s.armor, s.magic_resist, s.bonus_health_estimate,
                s.bonus_health_status, s.level, s.minute, m.game_start,
                COALESCE(array_agg(DISTINCT si.item_id) FILTER (WHERE si.item_id IS NOT NULL), '{}') AS item_ids,
                COUNT(*) OVER (PARTITION BY ss.anchor_match_id) AS match_sample_count
           FROM lol_dps.scenario_samples ss
           JOIN lol_dps.timeline_snapshots s ON s.snapshot_id = ss.target_snapshot_id
           JOIN lol_dps.participants p
             ON p.match_id = s.match_id AND p.participant_id = s.participant_id
           JOIN lol_dps.matches m ON m.match_id = s.match_id
           LEFT JOIN lol_dps.snapshot_items si ON si.snapshot_id = s.snapshot_id
          WHERE ${where}
            AND NOT EXISTS (
              SELECT 1 FROM lol_dps.hot_scenario_samples hs
               WHERE hs.patch = $1 AND hs.platform_region = $2 AND hs.phase = ss.phase
            )
          GROUP BY ss.scenario_sample_id, ss.anchor_match_id, ss.anchor_event_timestamp_ms,
                   ss.anchor_frame_distance_ms, p.champion_name, p.role, p.tier,
                   s.health_max, s.armor, s.magic_resist, s.bonus_health_estimate,
                   s.bonus_health_status, s.level, s.minute, m.game_start
       ), candidates AS (
         SELECT * FROM compact_grouped
         UNION ALL
         SELECT * FROM legacy_grouped
       ), ranked AS (
         SELECT candidates.*, ROW_NUMBER() OVER (
           PARTITION BY anchor_match_id
           ORDER BY md5(anchor_match_id || ':' || scenario_sample_id::text)
         ) AS match_row
         FROM candidates
       )
       SELECT * FROM ranked
        WHERE match_row <= ${SAMPLE_LIMIT_PER_MATCH}
        ORDER BY md5(anchor_match_id || ':' || scenario_sample_id::text)
        LIMIT $7`,
      [...values, limit],
    );
    return datasetFromRows(rows, candidate, rank, available, available.snapshots > rows.length);
  }
  return emptyDataset();
}

function datasetFromRows(
  rows: TargetRow[],
  candidate: (typeof CANDIDATES)[number],
  requestedRank: string | null,
  available: CandidateCounts,
  truncated: boolean,
): TargetDataset {
  const distinctMatches = new Set(rows.map((row) => row.anchor_match_id));
  const targets = rows.map((row) => ({
    id: row.scenario_sample_id,
    champion: row.champion_name,
    role: row.role ?? undefined,
    rank: row.tier ?? undefined,
    health: finiteOrZero(row.health_max),
    armor: finiteOrZero(row.armor),
    magicResist: finiteOrZero(row.magic_resist),
    bonusHealth: Math.max(0, finiteOrZero(row.bonus_health_estimate)),
    bonusHealthStatus: row.bonus_health_status ?? "unknown",
    level: clamp(row.level, 1, 18),
    minute: finiteOrZero(row.minute),
    itemIds: (row.item_ids ?? []).map(Number).filter(Number.isInteger),
    sampleWeight: 1 / Math.max(1, Number(row.match_sample_count)),
    sourceMatchKey: createHash("sha256").update(row.anchor_match_id).digest("hex").slice(0, 16),
    anchorEventTimestampMs: row.anchor_event_timestamp_ms ?? undefined,
    anchorFrameDistanceMs: row.anchor_frame_distance_ms ?? undefined,
    provenance: "riot" as const,
  }));
  return {
    targets,
    provenance: "riot",
    phase: candidate.phase,
    fallbackLevel: candidate.fallback,
    note:
      `${candidate.fallback === 0 ? "Exact Yunara third-item anchors" : "Sparse-data fallback"}. ` +
      `${truncated ? `Deterministically sampled ${rows.length} of ${available.snapshots} snapshots; ` : ""}` +
      `up to ${SAMPLE_LIMIT_PER_MATCH} snapshots per match are retained so long matches do not dominate. ` +
      (requestedRank
        ? "Rank filter refers only to directly seeded participants; other target ranks remain unknown."
        : "Rank is shown only when Riot seed provenance identifies that participant."),
    distinctMatchCount: distinctMatches.size,
    snapshotCount: targets.length,
    availableDistinctMatchCount: available.matches,
    availableSnapshotCount: available.snapshots,
    truncated,
    sampleLimitPerMatch: SAMPLE_LIMIT_PER_MATCH,
    uniqueChampions: [...new Set(targets.map((target) => target.champion))].sort(),
    uniqueRoles: [
      ...new Set(targets.map((target) => target.role).filter(Boolean) as string[]),
    ].sort(),
    knownRankCount: targets.filter((target) => Boolean(target.rank)).length,
    collection: {
      earliest:
        rows
          .map((row) => row.game_start)
          .filter(Boolean)
          .sort()[0] ?? null,
      latest:
        rows
          .map((row) => row.game_start)
          .filter(Boolean)
          .sort()
          .at(-1) ?? null,
    },
  };
}

function emptyDataset(): TargetDataset {
  return {
    targets: [],
    provenance: "riot",
    phase: "no-samples",
    fallbackLevel: 3,
    note: "The database is connected but contains no matching scenario samples with derived base-health provenance.",
    distinctMatchCount: 0,
    snapshotCount: 0,
    availableDistinctMatchCount: 0,
    availableSnapshotCount: 0,
    truncated: false,
    sampleLimitPerMatch: SAMPLE_LIMIT_PER_MATCH,
    uniqueChampions: [],
    uniqueRoles: [],
    knownRankCount: 0,
    collection: { earliest: null, latest: null },
  };
}

function fixtureDataset(filters?: TargetFilters): TargetDataset {
  const targets = filterFixtures(filters);
  return {
    targets,
    provenance: "fixture",
    phase: "Yunara third-item timing (demo approximation)",
    fallbackLevel: 3,
    note: "Fixture values are illustrative and are not presented as Riot match observations.",
    distinctMatchCount: 0,
    snapshotCount: targets.length,
    availableDistinctMatchCount: 0,
    availableSnapshotCount: targets.length,
    truncated: false,
    sampleLimitPerMatch: SAMPLE_LIMIT_PER_MATCH,
    uniqueChampions: [...new Set(targets.map((target) => target.champion))],
    uniqueRoles: [...new Set(targets.map((target) => target.role).filter(Boolean) as string[])],
    knownRankCount: 0,
    collection: { earliest: null, latest: null },
  };
}

function filterFixtures(filters?: TargetFilters): Target[] {
  return fixtureTargets.filter(
    (target) =>
      (!filters?.role || filters.role === "ALL" || target.role === filters.role) &&
      (!filters?.champion || target.champion.toLowerCase() === filters.champion.toLowerCase()),
  );
}

function finiteOrZero(value: string | number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
