import { database, query } from "./db/client.ts";
import {
  buildCompactProjection,
  compactProjectionChecksum,
} from "./ingestion/compact-projection.ts";
import { persistArchivedMatch } from "./ingestion/persist.ts";
import type { StaticItemShape } from "../../src/domains/dps/observed-items.ts";
import type { RiotTimeline } from "../../src/domains/dps/observation-types.ts";
import {
  isVerifiedArchive,
  readArchivedSource,
  sourceMatchIdentity,
  verifyArchiveKey,
} from "./storage/archive.ts";
import type { ArchiveManifestRow } from "./storage/manifest.ts";
import { compareRebuiltProjection } from "./storage/rebuild.ts";

type AnyRecord = Record<string, any>;

const dryRun = !process.argv.includes("--apply");
const requestedLimit = Number(
  process.env.REBUILD_LIMIT ?? process.argv[process.argv.indexOf("--limit") + 1] ?? 1000,
);
const limit =
  Number.isFinite(requestedLimit) && requestedLimit >= 0 ? Math.floor(requestedLimit) : 1000;
const routing = process.env.ROUTING_REGION ?? "EUROPE";

async function patchData(patch: string) {
  const itemRows = await query<AnyRecord>(
    `SELECT item_id,name,tags,gold_total,purchasable,from_ids,into_ids,maps
       FROM lol_dps.items WHERE patch=$1`,
    [patch],
  );
  const staticItems = new Map<number, StaticItemShape>(
    itemRows.map((row) => [
      Number(row.item_id),
      {
        id: Number(row.item_id),
        name: row.name,
        tags: row.tags ?? [],
        goldTotal: Number(row.gold_total),
        purchasable: row.purchasable,
        fromIds: (row.from_ids ?? []).map(Number),
        intoIds: (row.into_ids ?? []).map(Number),
        maps: row.maps ?? {},
      },
    ]),
  );
  const championRows = await query<AnyRecord>(
    `SELECT champion_id,stats FROM lol_dps.champions WHERE patch=$1`,
    [patch],
  );
  const championStats = new Map<number, AnyRecord>(
    championRows.map((row) => [Number(row.champion_id), row.stats]),
  );
  return { staticItems, championStats };
}

const manifests = await query<ArchiveManifestRow>(
  `SELECT archive_object_id,object_kind,source_match_id,source_identity,patch,platform_region,
          object_key,sha256,compressed_bytes,uncompressed_bytes,source_schema_version,
          extractor_version,dataset_version,engine_version,status
     FROM lol_dps.archive_objects
    WHERE object_kind='match-source' AND status='verified'
    ORDER BY archive_object_id LIMIT $1`,
  [limit],
);
const staticDataCache = new Map<string, Awaited<ReturnType<typeof patchData>>>();
let checked = 0;
let sourceVerificationFailures = 0;
let identityFailures = 0;
let countMismatches = 0;
let checksumMissing = 0;
let checksumMismatches = 0;
let applied = 0;
let expectedLevelRows = 0;
let expectedTargetRows = 0;
let expectedScenarioRows = 0;
let currentLevelRows = 0;
let currentTargetRows = 0;
let currentScenarioRows = 0;

for (const manifest of manifests) {
  const verification = await verifyArchiveKey(manifest.object_key, {
    sha256: manifest.sha256,
    compressedBytes: Number(manifest.compressed_bytes),
    uncompressedBytes: Number(manifest.uncompressed_bytes),
    sourceSchemaVersion: manifest.source_schema_version,
  });
  checked += 1;
  if (!isVerifiedArchive(verification)) {
    sourceVerificationFailures += 1;
    continue;
  }
  const source = await readArchivedSource(manifest.object_key);
  const matchId = sourceMatchIdentity(source);
  if (!matchId || matchId !== manifest.source_match_id) {
    identityFailures += 1;
    continue;
  }
  const match = source.match as AnyRecord;
  const timeline = source.timeline as AnyRecord;
  const participants = (match.info?.participants ?? []) as AnyRecord[];
  if (
    participants.length !== 10 ||
    Number(match.info?.queueId ?? 420) !== 420 ||
    Number(match.info?.gameDuration ?? 0) < 900 ||
    !Array.isArray(timeline.info?.frames)
  ) {
    identityFailures += 1;
    continue;
  }
  const data = staticDataCache.get(manifest.patch) ?? (await patchData(manifest.patch));
  staticDataCache.set(manifest.patch, data);
  const projection = buildCompactProjection({
    participants,
    timeline: timeline as RiotTimeline,
    championStats: data.championStats,
    staticItems: data.staticItems,
    scenarioMinute: Number(process.env.SCENARIO_MINUTE ?? 25),
    scenarioMinuteTolerance: Number(process.env.SCENARIO_MINUTE_TOLERANCE ?? 2),
  });
  const expected = {
    levels: projection.levelObservations.length,
    targets: projection.levelTargets.length,
    scenarios: projection.scenarioSamples.length,
  };
  const current = await query<{
    levels: string;
    targets: string;
    scenarios: string;
    projection_checksum: string | null;
  }>(
    `SELECT
       (SELECT count(*) FROM lol_dps.level_observations WHERE match_id=$1)::text AS levels,
       (SELECT count(*) FROM lol_dps.level_targets lt JOIN lol_dps.level_observations lo
          ON lo.level_observation_id=lt.level_observation_id WHERE lo.match_id=$1)::text AS targets,
       (SELECT count(*) FROM lol_dps.hot_scenario_samples WHERE anchor_match_id=$1)::text AS scenarios,
       (SELECT hot_projection_checksum FROM lol_dps.matches WHERE match_id=$1) AS projection_checksum`,
    [matchId],
  );
  const row = current[0];
  const actual = {
    levels: Number(row?.levels ?? 0),
    targets: Number(row?.targets ?? 0),
    scenarios: Number(row?.scenarios ?? 0),
  };
  expectedLevelRows += expected.levels;
  expectedTargetRows += expected.targets;
  expectedScenarioRows += expected.scenarios;
  currentLevelRows += actual.levels;
  currentTargetRows += actual.targets;
  currentScenarioRows += actual.scenarios;
  const checksum = row?.projection_checksum;
  const comparison = compareRebuiltProjection(
    expected,
    actual,
    compactProjectionChecksum(projection),
    checksum,
  );
  if (comparison.countMismatch) countMismatches += 1;
  if (comparison.checksumMissing) checksumMissing += 1;
  if (comparison.checksumMismatch) checksumMismatches += 1;

  if (!dryRun && !comparison.countMismatch && !comparison.checksumMismatch) {
    await persistArchivedMatch({
      matchId,
      match,
      patch: manifest.patch,
      platformRegion: manifest.platform_region ?? "unknown",
      routingRegion: routing,
      gameVersion: String(match.info?.gameVersion ?? ""),
      tierByPuuid: new Map(),
      archiveObjectId: manifest.archive_object_id,
      archiveObject: {
        key: manifest.object_key,
        sha256: manifest.sha256,
        compressedBytes: Number(manifest.compressed_bytes),
        uncompressedBytes: Number(manifest.uncompressed_bytes),
      },
      projection,
    });
    applied += 1;
  }
}

console.log(
  `Archive rebuild ${dryRun ? "dry-run" : "apply"}: checked=${checked}, source_verification_failures=${sourceVerificationFailures}, identity_failures=${identityFailures}, count_mismatches=${countMismatches}, checksum_missing=${checksumMissing}, checksum_mismatches=${checksumMismatches}, applied=${applied}, expected_rows={levels:${expectedLevelRows},targets:${expectedTargetRows},scenarios:${expectedScenarioRows}}, current_rows={levels:${currentLevelRows},targets:${currentTargetRows},scenarios:${currentScenarioRows}}.`,
);
await database().end();
