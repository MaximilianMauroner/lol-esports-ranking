import type { ProgressionApiResponse } from "../../../src/domains/dps/datasets.ts";
import { ITEMS } from "../../../src/domains/dps/items.ts";
import {
  aggregateProgression,
  type InventoryObservation,
} from "../../../src/domains/dps/progression.ts";
import type { StaticItemShape } from "../../../src/domains/dps/observed-items.ts";
import { hasDatabase, query } from "../db/client.ts";
import { getYunaraSkillProgression } from "./skill-progression.ts";

const PATCH = "26.18";
const DDRAGON_VERSION = "16.18.1";
const SUPPORTED_ITEM_IDS = Object.keys(ITEMS)
  .map(Number)
  .sort((left, right) => left - right);
const CACHE_TTL_MS = 60_000;

interface StaticItemRow {
  item_id: number | string;
  name: string;
  tags: string[] | null;
  gold_total: number | string;
  purchasable: boolean;
  from_ids: number[] | null;
  into_ids: number[] | null;
  maps: Record<string, boolean> | null;
}

interface ObservationRow {
  match_key: string;
  participant_key: string;
  level: number | string;
  timestamp_ms: number | string;
  item_ids: number[] | null;
}



let cached: {
  expiresAt: number;
  observations: InventoryObservation[];
  catalog: Map<number, StaticItemShape>;
  provenance: "riot" | "fixture";
} | null = null;

export async function getYunaraProgression(
  requestedLevel: number,
): Promise<ProgressionApiResponse> {
  const source = await loadSource();
  const result = aggregateProgression(source.observations, source.catalog, requestedLevel, {
    supportedItemIds: SUPPORTED_ITEM_IDS,
    sampleThreshold: 20,
    maxWidenRadius: 2,
  });
  const exactLevel = result.levels.find(
    (level) => level.level === result.selection.requestedLevel,
  )!;
  const skill = await getYunaraSkillProgression(result.selection.requestedLevel);
  return {
    ...result,
    patch: PATCH,
    dataVersion: DDRAGON_VERSION,
    champion: "Yunara",
    provenance: source.provenance,
    note:
      source.provenance === "riot"
        ? "Observed Yunara inventories from verified original match archives; one final frame per match/participant/level is counted. Attacker inventory defaults are separate from the enemy target cohort."
        : "Fixture inventory progression only; no Riot observation claim is made.",
    dedupeRule:
      "One latest observed timeline frame per distinct match, participant, and champion level; repeated frames in the same level do not add weight.",
    requestedLevel: result.selection.requestedLevel,
    exactLevel,
    sourceObservationCount: source.observations.length,
    skill,
  };
}

async function loadSource(): Promise<{
  observations: InventoryObservation[];
  catalog: Map<number, StaticItemShape>;
  provenance: "riot" | "fixture";
}> {
  if (cached && cached.expiresAt > Date.now()) return cached;
  if (!hasDatabase()) {
    const fixture = {
      observations: fixtureObservations(),
      catalog: fixtureCatalog(),
      provenance: "fixture" as const,
    };
    cached = { ...fixture, expiresAt: Date.now() + CACHE_TTL_MS };
    return fixture;
  }
  const [itemRows, observationRows] = await Promise.all([
    query<StaticItemRow>(
      `SELECT item_id, name, tags, gold_total, purchasable, from_ids, into_ids, maps
         FROM lol_dps.items
        WHERE patch = $1`,
      [PATCH],
    ),
    query<ObservationRow>(
      `WITH compact AS (
         SELECT lo.match_id AS match_key,
                lo.participant_id::text AS participant_key,
                lo.level,
                lo.timestamp_ms,
                lo.item_ids
           FROM lol_dps.level_observations lo
           JOIN lol_dps.participants p
             ON p.match_id = lo.match_id AND p.participant_id = lo.participant_id
           JOIN lol_dps.matches m ON m.match_id = lo.match_id
          WHERE m.patch = $1
            AND m.archive_status = 'verified'
            AND p.champion_id = 804
       ), legacy AS (
         SELECT s.match_id AS match_key,
                s.participant_id::text AS participant_key,
                s.level,
                s.timestamp_ms,
                COALESCE(
                  array_agg(si.item_id ORDER BY si.slot) FILTER (WHERE si.item_id IS NOT NULL),
                  '{}'::integer[]
                ) AS item_ids
           FROM lol_dps.timeline_snapshots s
           JOIN lol_dps.participants p
             ON p.match_id = s.match_id AND p.participant_id = s.participant_id
           JOIN lol_dps.matches m ON m.match_id = s.match_id
           LEFT JOIN lol_dps.snapshot_items si ON si.snapshot_id = s.snapshot_id
          WHERE m.patch = $1
            AND p.champion_id = 804
            AND NOT EXISTS (
              SELECT 1
                FROM lol_dps.level_observations lo
                JOIN lol_dps.participants compact_p
                  ON compact_p.match_id = lo.match_id
                 AND compact_p.participant_id = lo.participant_id
                JOIN lol_dps.matches compact_m ON compact_m.match_id = lo.match_id
               WHERE compact_m.patch = $1
                 AND compact_p.champion_id = 804
            )
          GROUP BY s.match_id, s.participant_id, s.level, s.timestamp_ms
       ), observed AS (
         SELECT * FROM compact
         UNION ALL
         SELECT * FROM legacy
       ), deduped AS (
         SELECT observed.*,
                ROW_NUMBER() OVER (
                  PARTITION BY match_key, participant_key, level
                  ORDER BY timestamp_ms DESC
                ) AS level_row
           FROM observed
       )
       SELECT match_key, participant_key, level, timestamp_ms, item_ids
         FROM deduped
        WHERE level_row = 1
        ORDER BY level, match_key, participant_key`,
      [PATCH],
    ),
  ]);
  const catalog = new Map<number, StaticItemShape>(
    itemRows.map((row) => [
      Number(row.item_id),
      {
        id: Number(row.item_id),
        name: row.name,
        tags: row.tags ?? [],
        goldTotal: Number(row.gold_total),
        purchasable: Boolean(row.purchasable),
        fromIds: (row.from_ids ?? []).map(Number),
        intoIds: (row.into_ids ?? []).map(Number),
        maps: row.maps ?? {},
      },
    ]),
  );
  const observations = observationRows.map((row) => ({
    matchKey: row.match_key,
    participantKey: row.participant_key,
    level: Number(row.level),
    timestampMs: Number(row.timestamp_ms),
    itemIds: (row.item_ids ?? []).map(Number),
  }));
  const source = { observations, catalog, provenance: "riot" as const };
  cached = { ...source, expiresAt: Date.now() + CACHE_TTL_MS };
  return source;
}

function fixtureCatalog(): Map<number, StaticItemShape> {
  return new Map([
    [
      3006,
      {
        id: 3006,
        name: ITEMS[3006]!.name,
        tags: ["Boots"],
        goldTotal: 1100,
        purchasable: true,
        fromIds: [1001],
        intoIds: [],
        maps: { "11": true },
      },
    ],
    ...SUPPORTED_ITEM_IDS.filter((id) => id !== 3006).map(
      (id) =>
        [
          id,
          {
            id,
            name: ITEMS[id]!.name,
            tags: [],
            goldTotal: ITEMS[id]!.goldTotal,
            purchasable: true,
            fromIds: [1038],
            intoIds: [],
            maps: { "11": true },
          } satisfies StaticItemShape,
        ] as const,
    ),
  ]);
}

function fixtureObservations(): InventoryObservation[] {
  const observations: InventoryObservation[] = [];
  for (let match = 1; match <= 8; match += 1) {
    for (let level = 1; level <= 18; level += 1) {
      const itemIds = [3006];
      if (level >= 7 + (match % 2)) itemIds.push(6672);
      if (level >= 10 + (match % 3)) itemIds.push(3085);
      if (level >= 13 + (match % 2)) itemIds.push(3031);
      observations.push({
        matchKey: `fixture-match-${match}`,
        participantKey: "1",
        level,
        timestampMs: level * 60_000 + match,
        itemIds,
      });
    }
  }
  return observations;
}
