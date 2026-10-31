import { database, query } from "./db/client.ts";
import { archiveEnabled, listArchiveObjects } from "./storage/archive.ts";

interface CountRow {
  count: string;
}

const relationRows = await query<{ table_name: string; total_bytes: string }>(
  `SELECT c.relname AS table_name,pg_total_relation_size(c.oid)::text AS total_bytes
     FROM pg_class c
     JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='lol_dps' AND c.relkind IN ('r','p')
    ORDER BY pg_total_relation_size(c.oid) DESC`,
);
const databaseSize = await query<{ bytes: string }>(
  `SELECT pg_database_size(current_database())::text AS bytes`,
);
const appSchemaSize = await query<{ bytes: string }>(
  `SELECT COALESCE(SUM(pg_total_relation_size(c.oid)),0)::text AS bytes
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='lol_dps' AND c.relkind IN ('r','p')`,
);
const manifests = await query<{
  status: string;
  count: string;
  compressed_bytes: string;
}>(
  `SELECT status,count(*)::text AS count,COALESCE(SUM(compressed_bytes),0)::text AS compressed_bytes
     FROM lol_dps.archive_objects GROUP BY status ORDER BY status`,
);
const orphanStates = await query<{ state: string; count: string }>(
  `SELECT state,count(*)::text AS count FROM lol_dps.archive_orphans GROUP BY state ORDER BY state`,
);
const [matches, snapshots, items, levels, targets, scenarios, requests] = await Promise.all([
  query<CountRow>(`SELECT count(*)::text AS count FROM lol_dps.matches`),
  query<CountRow>(`SELECT count(*)::text AS count FROM lol_dps.timeline_snapshots`),
  query<CountRow>(`SELECT count(*)::text AS count FROM lol_dps.snapshot_items`),
  query<CountRow>(`SELECT count(*)::text AS count FROM lol_dps.level_observations`),
  query<CountRow>(`SELECT count(*)::text AS count FROM lol_dps.level_targets`),
  query<CountRow>(`SELECT count(*)::text AS count FROM lol_dps.hot_scenario_samples`),
  query<{ requests: string }>(
    `SELECT COALESCE(SUM(CASE WHEN cursor->>'requestCount' ~ '^[0-9]+$'
                       THEN (cursor->>'requestCount')::bigint ELSE 0 END),0)::text AS requests
       FROM lol_dps.ingestion_runs`,
  ),
]);

let bucket: { configured: boolean; objects: number; bytes: number } = {
  configured: false,
  objects: 0,
  bytes: 0,
};
if (archiveEnabled()) {
  const objects = await listArchiveObjects("");
  bucket = {
    configured: true,
    objects: objects.length,
    bytes: objects.reduce((sum, object) => sum + object.bytes, 0),
  };
}

const manifestAggregate = Object.fromEntries(
  manifests.map((row) => [
    row.status,
    { count: Number(row.count), compressedBytes: Number(row.compressed_bytes) },
  ]),
);
const orphanAggregate = Object.fromEntries(
  orphanStates.map((row) => [row.state, Number(row.count)]),
);
console.log(
  JSON.stringify({
    databaseBytes: Number(databaseSize[0]?.bytes ?? 0),
    appSchemaBytes: Number(appSchemaSize[0]?.bytes ?? 0),
    relationBytes: relationRows.map((row) => ({
      name: row.table_name,
      bytes: Number(row.total_bytes),
    })),
    bucket,
    manifests: manifestAggregate,
    orphans: orphanAggregate,
    rows: {
      matches: Number(matches[0]?.count ?? 0),
      oldTimelineSnapshots: Number(snapshots[0]?.count ?? 0),
      oldSnapshotItems: Number(items[0]?.count ?? 0),
      levelObservations: Number(levels[0]?.count ?? 0),
      levelTargets: Number(targets[0]?.count ?? 0),
      hotScenarioSamples: Number(scenarios[0]?.count ?? 0),
    },
    cumulativeRiotRequests: Number(requests[0]?.requests ?? 0),
  }),
);
await database().end();
