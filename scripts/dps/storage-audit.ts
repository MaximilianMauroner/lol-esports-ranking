import { database, query } from "./db/client.ts";
import { listArchiveObjects } from "./storage/archive.ts";

const patch = process.env.LOL_PATCH ?? "26.18";

const raw = await query<{
  pointer_count: string;
  pointer_bytes: string;
  full_count: string;
  full_bytes: string;
  other_count: string;
  other_bytes: string;
  legacy_count: string;
}>(
  `SELECT
     count(*) FILTER (WHERE raw ? 'archiveObjectKey')::text AS pointer_count,
     COALESCE(sum(pg_column_size(raw)) FILTER (WHERE raw ? 'archiveObjectKey'),0)::text AS pointer_bytes,
     count(*) FILTER (WHERE raw ? 'info')::text AS full_count,
     COALESCE(sum(pg_column_size(raw)) FILTER (WHERE raw ? 'info'),0)::text AS full_bytes,
     count(*) FILTER (WHERE NOT (raw ? 'archiveObjectKey') AND NOT (raw ? 'info'))::text AS other_count,
     COALESCE(sum(pg_column_size(raw)) FILTER (WHERE NOT (raw ? 'archiveObjectKey') AND NOT (raw ? 'info')),0)::text AS other_bytes,
     count(*) FILTER (WHERE archive_status='legacy')::text AS legacy_count
   FROM lol_dps.matches`,
);
const integrity = await query<{
  accepted_current: string;
  verified_match_manifests: string;
  accepted_missing_manifest: string;
  manifest_missing_match: string;
  pointer_mismatch: string;
  legacy_exception: string;
}>(
  `SELECT
     (SELECT count(*) FROM lol_dps.matches WHERE patch=$1 AND archive_status='verified')::text AS accepted_current,
     (SELECT count(*) FROM lol_dps.archive_objects WHERE object_kind='match-source' AND status='verified')::text AS verified_match_manifests,
     (SELECT count(*) FROM lol_dps.matches m
       LEFT JOIN lol_dps.archive_objects ao ON ao.object_kind='match-source' AND ao.source_match_id=m.match_id
       WHERE m.patch=$1 AND m.archive_status='verified' AND ao.archive_object_id IS NULL)::text AS accepted_missing_manifest,
     (SELECT count(*) FROM lol_dps.archive_objects ao
       LEFT JOIN lol_dps.matches m ON m.match_id=ao.source_match_id
       WHERE ao.object_kind='match-source' AND ao.status='verified' AND m.match_id IS NULL)::text AS manifest_missing_match,
     (SELECT count(*) FROM lol_dps.matches m
       JOIN lol_dps.archive_objects ao ON ao.object_kind='match-source' AND ao.source_match_id=m.match_id
       WHERE m.archive_status='verified'
         AND ((m.raw->>'archiveObjectKey') IS DISTINCT FROM ao.object_key
           OR (m.raw->>'archiveSha256') IS DISTINCT FROM ao.sha256))::text AS pointer_mismatch,
     (SELECT count(*) FROM lol_dps.matches WHERE archive_status='legacy')::text AS legacy_exception`,
  [patch],
);
const staticRaw = await query<{
  champions_count: string;
  champions_bytes: string;
  items_count: string;
  items_bytes: string;
}>(
  `SELECT
     (SELECT count(*) FROM lol_dps.champions WHERE raw IS NOT NULL)::text AS champions_count,
     (SELECT COALESCE(sum(pg_column_size(raw)),0) FROM lol_dps.champions)::text AS champions_bytes,
     (SELECT count(*) FROM lol_dps.items WHERE raw IS NOT NULL)::text AS items_count,
     (SELECT COALESCE(sum(pg_column_size(raw)),0) FROM lol_dps.items)::text AS items_bytes`,
);
const rows = await query<{
  matches: string;
  participants: string;
  snapshots: string;
  snapshot_items: string;
  scenario_samples: string;
  level_observations: string;
  level_targets: string;
  hot_scenario_samples: string;
  running_ingestions: string;
  failed_ingestions: string;
}>(
  `SELECT
     (SELECT count(*) FROM lol_dps.matches)::text AS matches,
     (SELECT count(*) FROM lol_dps.participants)::text AS participants,
     (SELECT count(*) FROM lol_dps.timeline_snapshots)::text AS snapshots,
     (SELECT count(*) FROM lol_dps.snapshot_items)::text AS snapshot_items,
     (SELECT count(*) FROM lol_dps.scenario_samples)::text AS scenario_samples,
     (SELECT count(*) FROM lol_dps.level_observations)::text AS level_observations,
     (SELECT count(*) FROM lol_dps.level_targets)::text AS level_targets,
     (SELECT count(*) FROM lol_dps.hot_scenario_samples)::text AS hot_scenario_samples,
     (SELECT count(*) FROM lol_dps.ingestion_runs WHERE status='running')::text AS running_ingestions,
     (SELECT count(*) FROM lol_dps.ingestion_runs WHERE status='failed')::text AS failed_ingestions`,
);
const manifestStates = await query<{ status: string; count: string; bytes: string }>(
  `SELECT status,count(*)::text AS count,COALESCE(sum(compressed_bytes),0)::text AS bytes
     FROM lol_dps.archive_objects GROUP BY status ORDER BY status`,
);
const orphanStates = await query<{ state: string; count: string }>(
  `SELECT state,count(*)::text AS count FROM lol_dps.archive_orphans GROUP BY state ORDER BY state`,
);
const manifestKeys = await query<{ object_key: string }>(
  `SELECT object_key FROM lol_dps.archive_objects`,
);
const bucketObjects = await listArchiveObjects("");
const bucketKeySet = new Set(bucketObjects.map((object) => object.key));
const manifestKeySet = new Set(manifestKeys.map((row) => row.object_key));
const prefixCounts = new Map<string, { objects: number; bytes: number }>();
const bucketHashes = new Map<string, number>();
for (const object of bucketObjects) {
  const prefix = object.key.startsWith("raw/")
    ? "raw"
    : object.key.startsWith("static/")
      ? "static"
      : "other";
  const current = prefixCounts.get(prefix) ?? { objects: 0, bytes: 0 };
  current.objects += 1;
  current.bytes += object.bytes;
  prefixCounts.set(prefix, current);
  const hash = /(?:^|\/)sha256=([^/]+)/.exec(object.key)?.[1];
  if (hash) bucketHashes.set(hash, (bucketHashes.get(hash) ?? 0) + 1);
}
const duplicateChecksums = await query<{ groups: string; objects: string }>(
  `SELECT count(*)::text AS groups,COALESCE(sum(object_count),0)::text AS objects
     FROM (SELECT sha256,count(*) AS object_count FROM lol_dps.archive_objects GROUP BY sha256 HAVING count(*) > 1) duplicates`,
);

console.log(
  JSON.stringify({
    patch,
    raw: {
      pointerRows: Number(raw[0]?.pointer_count ?? 0),
      pointerBytes: Number(raw[0]?.pointer_bytes ?? 0),
      fullSourceRows: Number(raw[0]?.full_count ?? 0),
      fullSourceBytes: Number(raw[0]?.full_bytes ?? 0),
      otherRows: Number(raw[0]?.other_count ?? 0),
      otherBytes: Number(raw[0]?.other_bytes ?? 0),
      legacyRows: Number(raw[0]?.legacy_count ?? 0),
    },
    integrity: {
      acceptedCurrent: Number(integrity[0]?.accepted_current ?? 0),
      verifiedMatchManifests: Number(integrity[0]?.verified_match_manifests ?? 0),
      acceptedMissingManifest: Number(integrity[0]?.accepted_missing_manifest ?? 0),
      manifestMissingMatch: Number(integrity[0]?.manifest_missing_match ?? 0),
      pointerMismatches: Number(integrity[0]?.pointer_mismatch ?? 0),
      legacyException: Number(integrity[0]?.legacy_exception ?? 0),
      registeredOrphans: Number(orphanStates.find((row) => row.state === "registered")?.count ?? 0),
      unresolvedOrphans: Number(orphanStates.find((row) => row.state === "unresolved")?.count ?? 0),
    },
    staticRaw: {
      championRows: Number(staticRaw[0]?.champions_count ?? 0),
      championBytes: Number(staticRaw[0]?.champions_bytes ?? 0),
      itemRows: Number(staticRaw[0]?.items_count ?? 0),
      itemBytes: Number(staticRaw[0]?.items_bytes ?? 0),
    },
    rows: {
      matches: Number(rows[0]?.matches ?? 0),
      participants: Number(rows[0]?.participants ?? 0),
      oldSnapshots: Number(rows[0]?.snapshots ?? 0),
      oldSnapshotItems: Number(rows[0]?.snapshot_items ?? 0),
      oldScenarioSamples: Number(rows[0]?.scenario_samples ?? 0),
      levelObservations: Number(rows[0]?.level_observations ?? 0),
      levelTargets: Number(rows[0]?.level_targets ?? 0),
      hotScenarioSamples: Number(rows[0]?.hot_scenario_samples ?? 0),
      runningIngestions: Number(rows[0]?.running_ingestions ?? 0),
      failedIngestions: Number(rows[0]?.failed_ingestions ?? 0),
    },
    bucket: {
      objects: bucketObjects.length,
      compressedBytes: bucketObjects.reduce((sum, object) => sum + object.bytes, 0),
      prefixes: Object.fromEntries(prefixCounts),
      objectsWithoutManifest: bucketObjects.filter((object) => !manifestKeySet.has(object.key))
        .length,
      manifestsWithoutObject: manifestKeys.filter((row) => !bucketKeySet.has(row.object_key))
        .length,
      duplicateKeys: bucketObjects.length - bucketKeySet.size,
      duplicateHashGroups: [...bucketHashes.values()].filter((count) => count > 1).length,
    },
    manifests: Object.fromEntries(
      manifestStates.map((row) => [
        row.status,
        { count: Number(row.count), compressedBytes: Number(row.bytes) },
      ]),
    ),
    duplicateManifestChecksumGroups: Number(duplicateChecksums[0]?.groups ?? 0),
    duplicateManifestObjects: Number(duplicateChecksums[0]?.objects ?? 0),
  }),
);
await database().end();
