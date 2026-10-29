import { createHash } from "node:crypto";
import { hasDatabase, query } from "../db/client.ts";
import { fixtureTargets } from "../../../src/domains/dps/fixtures.ts";
import { MAX_LEVEL_COHORT_TARGETS } from "../../../src/domains/dps/cohort-cache.ts";
import type { Target } from "../../../src/domains/dps/types.ts";
import type { TargetDataset, TargetFilters } from "./realistic-targets.ts";
import { matchBalancedWeight } from "../../../src/domains/dps/level-cohort.ts";

const PATCH = "26.18";
const SAMPLE_THRESHOLD_MATCHES = 20;
const MAX_WIDEN_RADIUS = 2;
const SAMPLE_LIMIT_PER_MATCH = 20;

interface CountRow {
  level: number | string;
  snapshot_count: string;
  match_count: string;
}

interface LevelTargetRow {
  sample_id: string;
  anchor_match_id: string;
  target_champion: string;
  target_role: string | null;
  target_tier: string | null;
  target_participant_id: number;
  health_max: string;
  armor: string;
  magic_resist: string;
  bonus_health_estimate: string;
  bonus_health_status: "derived" | "missing-static" | "clamped" | "unknown" | null;
  target_level: number;
  minute: string;
  item_ids: number[] | null;
  anchor_level: number;
  anchor_timestamp_ms: number;
  match_target_rows: string;
  game_start: string | null;
}

export async function getYunaraLevelTargets(
  filters: TargetFilters & { level: number },
): Promise<TargetDataset> {
  const requestedLevel = clampLevel(filters.level);
  if (!hasDatabase()) return fixtureLevelDataset(requestedLevel, filters);

  const role = filters.role && filters.role !== "ALL" ? filters.role : null;
  const champion = filters.champion?.trim() || null;
  const rank = filters.rank && filters.rank !== "ALL" ? filters.rank : null;
  const region = filters.region ?? "EUW1";
  const counts = await query<CountRow>(
    `WITH compact_yunara AS (
       SELECT lo.level_observation_id, lo.match_id, lo.participant_id,
              lo.timestamp_ms, lo.level, p.team_id
         FROM lol_dps.level_observations lo
         JOIN lol_dps.participants p
           ON p.match_id = lo.match_id AND p.participant_id = lo.participant_id
         JOIN lol_dps.matches m ON m.match_id = lo.match_id
        WHERE m.patch = $1
          AND m.platform_region = $2
          AND m.queue_id = 420
          AND m.archive_status = 'verified'
          AND p.champion_id = 804
     ), compact_counts AS (
       SELECT y.level, COUNT(*)::bigint AS snapshot_count,
              COUNT(DISTINCT y.match_id)::bigint AS match_count
         FROM compact_yunara y
         JOIN lol_dps.level_targets lt ON lt.level_observation_id = y.level_observation_id
         JOIN lol_dps.participants ep
           ON ep.match_id = y.match_id AND ep.participant_id = lt.target_participant_id
        WHERE ep.team_id <> y.team_id
          AND ($3::text IS NULL OR ep.role = $3)
          AND ($4::text IS NULL OR lower(ep.champion_name) = lower($4))
          AND ($5::text IS NULL OR ep.tier = $5)
          AND lt.bonus_health_estimate IS NOT NULL
        GROUP BY y.level
     ), legacy_yunara AS (
       SELECT DISTINCT ON (s.match_id, s.participant_id, s.level)
              s.match_id, s.participant_id, s.timestamp_ms, s.level, p.team_id
         FROM lol_dps.timeline_snapshots s
         JOIN lol_dps.participants p
           ON p.match_id = s.match_id AND p.participant_id = s.participant_id
         JOIN lol_dps.matches m ON m.match_id = s.match_id
        WHERE m.patch = $1
          AND m.platform_region = $2
          AND m.queue_id = 420
          AND p.champion_id = 804
          AND NOT EXISTS (
            SELECT 1
              FROM lol_dps.level_observations lo
              JOIN lol_dps.participants compact_p
                ON compact_p.match_id = lo.match_id
               AND compact_p.participant_id = lo.participant_id
              JOIN lol_dps.matches compact_m ON compact_m.match_id = lo.match_id
             WHERE compact_m.patch = $1 AND compact_p.champion_id = 804
          )
        ORDER BY s.match_id, s.participant_id, s.level, s.timestamp_ms DESC
     ), legacy_counts AS (
       SELECT y.level, COUNT(*)::bigint AS snapshot_count,
              COUNT(DISTINCT y.match_id)::bigint AS match_count
         FROM legacy_yunara y
         JOIN lol_dps.timeline_snapshots ts
           ON ts.match_id = y.match_id AND ts.timestamp_ms = y.timestamp_ms
         JOIN lol_dps.participants ep
           ON ep.match_id = ts.match_id AND ep.participant_id = ts.participant_id
        WHERE ep.team_id <> y.team_id
          AND ($3::text IS NULL OR ep.role = $3)
          AND ($4::text IS NULL OR lower(ep.champion_name) = lower($4))
          AND ($5::text IS NULL OR ep.tier = $5)
          AND ts.bonus_health_estimate IS NOT NULL
        GROUP BY y.level
     )
     SELECT level, SUM(snapshot_count)::text AS snapshot_count,
            SUM(match_count)::text AS match_count
       FROM (SELECT * FROM compact_counts UNION ALL SELECT * FROM legacy_counts) all_counts
      GROUP BY level
      ORDER BY level`,
    [PATCH, region, role, champion, rank],
  );
  const countByLevel = new Map(
    counts.map((row) => [
      Number(row.level),
      { snapshots: Number(row.snapshot_count), matches: Number(row.match_count) },
    ]),
  );
  const pool = chooseLevelPool(countByLevel, requestedLevel);
  if (pool.levels.length === 0) return emptyLevelDataset(requestedLevel);

  const limit = Math.max(1, Math.min(MAX_LEVEL_COHORT_TARGETS, Math.round(filters.limit ?? 500)));
  const rows = await query<LevelTargetRow>(
    `WITH compact_yunara AS (
       SELECT lo.level_observation_id, lo.match_id, lo.participant_id,
              lo.timestamp_ms, lo.level, p.team_id
         FROM lol_dps.level_observations lo
         JOIN lol_dps.participants p
           ON p.match_id = lo.match_id AND p.participant_id = lo.participant_id
         JOIN lol_dps.matches m ON m.match_id = lo.match_id
        WHERE m.patch = $1
          AND m.platform_region = $2
          AND m.queue_id = 420
          AND m.archive_status = 'verified'
          AND p.champion_id = 804
          AND lo.level = ANY($3::integer[])
     ), compact_candidates AS (
       SELECT md5(y.match_id || ':' || y.timestamp_ms::text || ':' || lt.target_participant_id::text) AS sample_id,
              y.match_id AS anchor_match_id,
              ep.champion_name AS target_champion,
              ep.role AS target_role,
              ep.tier AS target_tier,
              lt.target_participant_id,
              lt.health_max,
              lt.armor,
              lt.magic_resist,
              lt.bonus_health_estimate,
              lt.bonus_health_status,
              lt.target_level,
              lt.minute,
              lt.item_ids,
              y.level AS anchor_level,
              y.timestamp_ms AS anchor_timestamp_ms,
              m.game_start,
              COUNT(*) OVER (PARTITION BY y.match_id) AS match_target_rows
         FROM compact_yunara y
         JOIN lol_dps.level_targets lt ON lt.level_observation_id = y.level_observation_id
         JOIN lol_dps.participants ep
           ON ep.match_id = y.match_id AND ep.participant_id = lt.target_participant_id
         JOIN lol_dps.matches m ON m.match_id = y.match_id
        WHERE ep.team_id <> y.team_id
          AND ($4::text IS NULL OR ep.role = $4)
          AND ($5::text IS NULL OR lower(ep.champion_name) = lower($5))
          AND ($6::text IS NULL OR ep.tier = $6)
          AND lt.bonus_health_estimate IS NOT NULL
     ), legacy_yunara AS (
       SELECT DISTINCT ON (s.match_id, s.participant_id, s.level)
              s.match_id, s.participant_id, s.timestamp_ms, s.level, p.team_id
         FROM lol_dps.timeline_snapshots s
         JOIN lol_dps.participants p
           ON p.match_id = s.match_id AND p.participant_id = s.participant_id
         JOIN lol_dps.matches m ON m.match_id = s.match_id
        WHERE m.patch = $1
          AND m.platform_region = $2
          AND m.queue_id = 420
          AND p.champion_id = 804
          AND s.level = ANY($3::integer[])
          AND NOT EXISTS (
            SELECT 1
              FROM lol_dps.level_observations lo
              JOIN lol_dps.participants compact_p
                ON compact_p.match_id = lo.match_id
               AND compact_p.participant_id = lo.participant_id
              JOIN lol_dps.matches compact_m ON compact_m.match_id = lo.match_id
             WHERE compact_m.patch = $1 AND compact_p.champion_id = 804
          )
        ORDER BY s.match_id, s.participant_id, s.level, s.timestamp_ms DESC
     ), legacy_grouped AS (
       SELECT md5(y.match_id || ':' || y.timestamp_ms::text || ':' || ts.participant_id::text) AS sample_id,
              y.match_id AS anchor_match_id,
              ep.champion_name AS target_champion,
              ep.role AS target_role,
              ep.tier AS target_tier,
              ts.participant_id AS target_participant_id,
              ts.health_max,
              ts.armor,
              ts.magic_resist,
              ts.bonus_health_estimate,
              CASE WHEN ts.bonus_health_estimate IS NULL THEN 'unknown' ELSE 'derived' END AS bonus_health_status,
              ts.level AS target_level,
              ts.minute,
              COALESCE(array_agg(DISTINCT si.item_id) FILTER (WHERE si.item_id IS NOT NULL), '{}') AS item_ids,
              y.level AS anchor_level,
              y.timestamp_ms AS anchor_timestamp_ms,
              m.game_start
         FROM legacy_yunara y
         JOIN lol_dps.timeline_snapshots ts
           ON ts.match_id = y.match_id AND ts.timestamp_ms = y.timestamp_ms
         JOIN lol_dps.participants ep
           ON ep.match_id = ts.match_id AND ep.participant_id = ts.participant_id
         JOIN lol_dps.matches m ON m.match_id = ts.match_id
         LEFT JOIN lol_dps.snapshot_items si ON si.snapshot_id = ts.snapshot_id
        WHERE ep.team_id <> y.team_id
          AND ($4::text IS NULL OR ep.role = $4)
          AND ($5::text IS NULL OR lower(ep.champion_name) = lower($5))
          AND ($6::text IS NULL OR ep.tier = $6)
          AND ts.bonus_health_estimate IS NOT NULL
        GROUP BY y.match_id, y.timestamp_ms, ts.participant_id, ep.champion_name, ep.role, ep.tier,
                 ts.health_max, ts.armor, ts.magic_resist, ts.bonus_health_estimate,
                 ts.level, ts.minute, y.level, m.game_start
     ), legacy_candidates AS (
       SELECT legacy_grouped.*, COUNT(*) OVER (PARTITION BY anchor_match_id) AS match_target_rows
         FROM legacy_grouped
     ), candidates AS (
       SELECT * FROM compact_candidates
       UNION ALL
       SELECT * FROM legacy_candidates
     ), ranked AS (
       SELECT candidates.*, ROW_NUMBER() OVER (
         PARTITION BY anchor_match_id
         ORDER BY md5(anchor_match_id || ':' || anchor_timestamp_ms::text || ':' || target_participant_id::text)
       ) AS match_row
       FROM candidates
     )
     SELECT * FROM ranked
      WHERE match_row <= ${SAMPLE_LIMIT_PER_MATCH}
      ORDER BY md5(anchor_match_id || ':' || anchor_timestamp_ms::text || ':' || target_participant_id::text)
      LIMIT $7`,
    [PATCH, region, pool.levels, role, champion, rank, limit],
  );
  return datasetFromRows(
    rows,
    requestedLevel,
    pool,
    countByLevel,
    rows.length <
      pool.levels.reduce((sum, level) => sum + (countByLevel.get(level)?.snapshots ?? 0), 0),
  );
}

function datasetFromRows(
  rows: LevelTargetRow[],
  requestedLevel: number,
  pool: { levels: number[] },
  counts: Map<number, { snapshots: number; matches: number }>,
  truncated: boolean,
): TargetDataset {
  const distinctMatches = new Set(rows.map((row) => row.anchor_match_id));
  const availableSnapshots = pool.levels.reduce(
    (sum, level) => sum + (counts.get(level)?.snapshots ?? 0),
    0,
  );
  const availableMatches = new Set(rows.map((row) => row.anchor_match_id)).size;
  const targets: Target[] = rows.map((row) => ({
    id: row.sample_id,
    champion: row.target_champion,
    role: row.target_role ?? undefined,
    rank: row.target_tier ?? undefined,
    health: finite(row.health_max, 1, 1_000_000),
    armor: finite(row.armor, -500, 2_000),
    magicResist: finite(row.magic_resist, -500, 2_000),
    bonusHealth: finite(row.bonus_health_estimate, 0, 1_000_000),
    bonusHealthStatus: row.bonus_health_status ?? "unknown",
    level: clampLevel(row.target_level),
    minute: finite(row.minute, 0, 120),
    itemIds: (row.item_ids ?? []).map(Number).filter(Number.isInteger).slice(0, 6),
    sampleWeight: matchBalancedWeight(Number(row.match_target_rows)),
    sourceMatchKey: createHash("sha256").update(row.anchor_match_id).digest("hex").slice(0, 16),
    anchorEventTimestampMs: row.anchor_timestamp_ms,
    anchorFrameDistanceMs: 0,
    provenance: "riot",
  }));
  const widened = pool.levels.length !== 1 || pool.levels[0] !== requestedLevel;
  return {
    targets,
    provenance: "riot",
    phase: `yunara-level-${requestedLevel}`,
    fallbackLevel: widened ? 1 : 0,
    note:
      `${widened ? `Nearby-level fallback using levels ${pool.levels.join("/")}; ` : "Exact Yunara-level anchors; "}` +
      `each target is an enemy snapshot from the same match/frame as Yunara level ${requestedLevel}. ` +
      `${truncated ? `Deterministically sampled ${rows.length} of ${availableSnapshots} vectors; ` : ""}` +
      "match-balanced weights prevent five enemies or repeated level anchors from dominating.",
    distinctMatchCount: distinctMatches.size,
    snapshotCount: targets.length,
    availableDistinctMatchCount: availableMatches,
    availableSnapshotCount: availableSnapshots,
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

function chooseLevelPool(
  counts: Map<number, { snapshots: number; matches: number }>,
  requested: number,
): { levels: number[] } {
  let best: { levels: number[] } = { levels: [] };
  for (let radius = 0; radius <= MAX_WIDEN_RADIUS; radius += 1) {
    const levels = Array.from(
      { length: radius * 2 + 1 },
      (_, index) => requested - radius + index,
    ).filter((level) => level >= 1 && level <= 18);
    const matches = levels.reduce((sum, level) => sum + (counts.get(level)?.matches ?? 0), 0);
    if (matches > 0) best = { levels };
    if (matches >= SAMPLE_THRESHOLD_MATCHES) return { levels };
  }
  return best;
}

function fixtureLevelDataset(level: number, filters: TargetFilters): TargetDataset {
  // The demo path honours the same role and champion filters as the SQL path, so
  // picking an enemy in the lab narrows the cohort with or without a database.
  const role = filters.role && filters.role !== "ALL" ? filters.role : null;
  const champion = filters.champion?.trim().toLowerCase() || null;
  const matching = fixtureTargets.filter(
    (target) =>
      (!role || target.role === role) && (!champion || target.champion.toLowerCase() === champion),
  );
  const targets = matching.map((target, index) => ({
    ...target,
    id: `fixture-level-${level}-${index}`,
    minute: level * 1.5,
    sampleWeight: 1 / Math.max(1, matching.length),
  }));
  return {
    targets,
    provenance: "fixture",
    phase: `yunara-level-${level}`,
    fallbackLevel: 3,
    note: "Fixture/demo values only; no Riot level-matched target claim is made.",
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

function emptyLevelDataset(level: number): TargetDataset {
  return {
    targets: [],
    provenance: "riot",
    phase: `yunara-level-${level}`,
    fallbackLevel: 3,
    note: `No verified same-match enemy snapshots were found near Yunara level ${level}.`,
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

function clampLevel(value: number): number {
  return Math.max(1, Math.min(18, Number.isFinite(value) ? Math.round(value) : 1));
}

function finite(value: string | number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : min;
}
