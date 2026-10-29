import { database, query, transaction } from "./db/client.ts";
import {
  archiveEnabled,
  listArchiveObjects,
  parseRawArchiveKey,
  readArchivedSource,
  sourceMatchIdentity,
  verifyArchiveKey,
  isVerifiedArchive,
} from "./storage/archive.ts";
import { buildCompactProjection } from "./ingestion/compact-projection.ts";
import { persistArchivedMatch } from "./ingestion/persist.ts";
import {
  ensurePendingArchiveIntent,
  markArchiveObjectFailed,
  markArchiveVerified,
  type ArchiveManifestRow,
} from "./storage/manifest.ts";
import type { StaticItemShape } from "../../src/domains/dps/observed-items.ts";
import type { MatchArchiveSource } from "./storage/archive.ts";
import type { RiotTimeline } from "../../src/domains/dps/observation-types.ts";

type AnyRecord = Record<string, any>;
type RepairMode = "none" | "safe";

const repairMode: RepairMode = process.argv.includes("--repair-orphans") ? "safe" : "none";
const gameVersionPrefix = process.env.DDRAGON_VERSION?.replace(/\.1$/, "") ?? "16.18";
const routing = process.env.ROUTING_REGION ?? "EUROPE";

if (!archiveEnabled()) throw new Error("Railway bucket S3 variables are not configured.");

interface ManifestToCheck extends ArchiveManifestRow {
  source_match_id: string | null;
}

interface MatchPointerRow {
  archive_status: string;
  pointer_key: string | null;
  pointer_sha256: string | null;
}

async function patchData(patchName: string) {
  const itemRows = await query<AnyRecord>(
    `SELECT item_id,name,tags,gold_total,purchasable,from_ids,into_ids,maps
       FROM lol_dps.items WHERE patch=$1`,
    [patchName],
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
    [patchName],
  );
  const championStats = new Map<number, AnyRecord>(
    championRows.map((row) => [Number(row.champion_id), row.stats]),
  );
  return { staticItems, championStats };
}

function validSourceMatch(source: MatchArchiveSource): boolean {
  const match = source.match as AnyRecord;
  const timeline = source.timeline as AnyRecord;
  const info = match?.info as AnyRecord;
  return (
    typeof sourceMatchIdentity(source) === "string" &&
    Array.isArray(info?.participants) &&
    info.participants.length === 10 &&
    Number(info.queueId ?? 420) === 420 &&
    Number(info.gameDuration ?? 0) >= 900 &&
    String(info.gameVersion ?? "").startsWith(gameVersionPrefix) &&
    Array.isArray(timeline?.info?.frames)
  );
}

async function matchPointer(matchId: string): Promise<MatchPointerRow | null> {
  const rows = await query<MatchPointerRow>(
    `SELECT archive_status,raw->>'archiveObjectKey' AS pointer_key,
            raw->>'archiveSha256' AS pointer_sha256
       FROM lol_dps.matches WHERE match_id=$1`,
    [matchId],
  );
  return rows[0] ?? null;
}

async function recordOrphan(
  object: { key: string; bytes: number },
  details: {
    sha256: string | null;
    uncompressedBytes: number | null;
    state: "unresolved" | "registered" | "tombstone";
    reason: string;
  },
): Promise<void> {
  await query(
    `INSERT INTO lol_dps.archive_orphans
      (object_key,sha256,compressed_bytes,uncompressed_bytes,source_schema_version,state,reason)
     VALUES ($1,$2,$3,$4,'riot-match-timeline-v1',$5,$6)
     ON CONFLICT (object_key) DO UPDATE SET
       sha256=EXCLUDED.sha256,compressed_bytes=EXCLUDED.compressed_bytes,
       uncompressed_bytes=EXCLUDED.uncompressed_bytes,source_schema_version=EXCLUDED.source_schema_version,
       state=EXCLUDED.state,reason=EXCLUDED.reason,last_seen_at=now(),
       resolved_at=CASE WHEN EXCLUDED.state='unresolved' THEN NULL ELSE now() END`,
    [
      object.key,
      details.sha256,
      object.bytes,
      details.uncompressedBytes,
      details.state,
      details.reason,
    ],
  );
}

async function tryRepairManifest(
  manifest: ManifestToCheck,
  staticData: Awaited<ReturnType<typeof patchData>>,
  verification: Awaited<ReturnType<typeof verifyArchiveKey>>,
): Promise<"repaired" | "not-repairable"> {
  if (manifest.object_kind !== "match-source" || !isVerifiedArchive(verification)) {
    return "not-repairable";
  }
  let source;
  try {
    source = await readArchivedSource(manifest.object_key);
  } catch {
    return "not-repairable";
  }
  const matchId = sourceMatchIdentity(source);
  if (!matchId || (manifest.source_match_id && matchId !== manifest.source_match_id)) {
    return "not-repairable";
  }
  const match = source.match as AnyRecord;
  const timeline = source.timeline as AnyRecord;
  if (!validSourceMatch(source)) return "not-repairable";
  const pointer = await matchPointer(matchId);
  if (pointer?.archive_status === "legacy") return "not-repairable";
  if (
    pointer &&
    (pointer.pointer_key !== manifest.object_key || pointer.pointer_sha256 !== manifest.sha256)
  ) {
    return "not-repairable";
  }
  const participants = (match.info.participants ?? []) as AnyRecord[];
  const projection = buildCompactProjection({
    participants,
    timeline: timeline as RiotTimeline,
    championStats: staticData.championStats,
    staticItems: staticData.staticItems,
    scenarioMinute: Number(process.env.SCENARIO_MINUTE ?? 25),
    scenarioMinuteTolerance: Number(process.env.SCENARIO_MINUTE_TOLERANCE ?? 2),
  });
  const input = {
    objectKind: "match-source" as const,
    sourceMatchId: matchId,
    sourceIdentity: `match:${matchId}`,
    patch: manifest.patch,
    platformRegion: manifest.platform_region,
    objectKey: manifest.object_key,
    sha256: manifest.sha256,
    compressedBytes: Number(manifest.compressed_bytes),
    uncompressedBytes: Number(manifest.uncompressed_bytes),
    sourceSchemaVersion: manifest.source_schema_version,
    extractorVersion: manifest.extractor_version,
    datasetVersion: manifest.dataset_version,
    engineVersion: manifest.engine_version,
  };
  const intent = await transaction((client) => ensurePendingArchiveIntent(client, input));
  if (pointer) {
    await transaction((client) =>
      markArchiveVerified(client, intent.archive_object_id, {
        objectKey: manifest.object_key,
        sha256: manifest.sha256,
        compressedBytes: Number(manifest.compressed_bytes),
        uncompressedBytes: Number(manifest.uncompressed_bytes),
      }),
    );
  } else {
    await persistArchivedMatch({
      matchId,
      match,
      patch: manifest.patch,
      platformRegion: manifest.platform_region ?? "unknown",
      routingRegion: routing,
      gameVersion: String(match.info.gameVersion ?? ""),
      tierByPuuid: new Map(),
      archiveObjectId: intent.archive_object_id,
      archiveObject: {
        key: manifest.object_key,
        sha256: manifest.sha256,
        compressedBytes: Number(manifest.compressed_bytes),
        uncompressedBytes: Number(manifest.uncompressed_bytes),
      },
      projection,
    });
  }
  return "repaired";
}

const bucketObjects = await listArchiveObjects("");
const manifests = await query<ManifestToCheck>(
  `SELECT archive_object_id,object_kind,source_match_id,source_identity,patch,platform_region,
          object_key,sha256,compressed_bytes,uncompressed_bytes,source_schema_version,
          extractor_version,dataset_version,engine_version,status
     FROM lol_dps.archive_objects ORDER BY archive_object_id`,
);
const manifestByKey = new Map(manifests.map((manifest) => [manifest.object_key, manifest]));
const rawObjects = bucketObjects.filter((object) => object.key.startsWith("raw/"));
const staticDataCache = new Map<string, Awaited<ReturnType<typeof patchData>>>();
let healthyVerified = 0;
let missingObjects = 0;
let verificationMismatches = 0;
let verifiedMissingMatch = 0;
let recoveredManifests = 0;
let pendingOrFailedWithObject = 0;
let orphanValid = 0;
let orphanInvalid = 0;
let orphanRegistered = 0;
let orphanUnresolved = 0;

for (const manifest of manifests) {
  if (manifest.status === "legacy") continue;
  const verification = await verifyArchiveKey(manifest.object_key, {
    sha256: manifest.sha256,
    compressedBytes: Number(manifest.compressed_bytes),
    uncompressedBytes: Number(manifest.uncompressed_bytes),
    sourceSchemaVersion: manifest.source_schema_version,
  });
  if (!verification.exists) {
    missingObjects += 1;
    if (manifest.status === "verified") {
      await markArchiveObjectFailed(manifest.archive_object_id, "archive object is missing");
    }
    continue;
  }
  if (!isVerifiedArchive(verification)) {
    verificationMismatches += 1;
    if (manifest.status === "verified") {
      await markArchiveObjectFailed(
        manifest.archive_object_id,
        "archive object verification failed",
      );
    }
    continue;
  }
  if (manifest.object_kind === "match-source") {
    let envelopeMatchId: string | null;
    try {
      const source = await readArchivedSource(manifest.object_key);
      envelopeMatchId = sourceMatchIdentity(source);
      if (!envelopeMatchId || envelopeMatchId !== manifest.source_match_id) {
        throw new Error("source identity mismatch");
      }
    } catch {
      verificationMismatches += 1;
      if (manifest.status === "verified") {
        await markArchiveObjectFailed(
          manifest.archive_object_id,
          "source envelope identity failed",
        );
      }
      continue;
    }
    if (manifest.status === "verified" && envelopeMatchId) {
      const pointer = await matchPointer(envelopeMatchId);
      if (!pointer) {
        verifiedMissingMatch += 1;
        if (repairMode === "safe") {
          const data = staticDataCache.get(manifest.patch) ?? (await patchData(manifest.patch));
          staticDataCache.set(manifest.patch, data);
          if ((await tryRepairManifest(manifest, data, verification)) === "repaired") {
            recoveredManifests += 1;
          }
        }
        continue;
      }
    }
  }
  if (manifest.status === "verified") {
    healthyVerified += 1;
    continue;
  }
  pendingOrFailedWithObject += 1;
  if (repairMode === "safe") {
    if (manifest.object_kind === "match-source") {
      const data = staticDataCache.get(manifest.patch) ?? (await patchData(manifest.patch));
      staticDataCache.set(manifest.patch, data);
      if ((await tryRepairManifest(manifest, data, verification)) === "repaired") {
        recoveredManifests += 1;
      }
    } else {
      await transaction(async (client) => {
        await markArchiveVerified(client, manifest.archive_object_id, {
          objectKey: manifest.object_key,
          sha256: manifest.sha256,
          compressedBytes: Number(manifest.compressed_bytes),
          uncompressedBytes: Number(manifest.uncompressed_bytes),
        });
      });
      recoveredManifests += 1;
    }
  }
}

for (const object of rawObjects) {
  if (manifestByKey.has(object.key)) continue;
  const parsedKey = parseRawArchiveKey(object.key);
  if (!parsedKey) {
    orphanInvalid += 1;
    await recordOrphan(object, {
      sha256: null,
      uncompressedBytes: null,
      state: "unresolved",
      reason: "raw object key does not match the immutable source convention",
    });
    orphanUnresolved += 1;
    continue;
  }
  const verification = await verifyArchiveKey(object.key, {
    sha256: parsedKey.sha256,
    compressedBytes: object.bytes,
    sourceSchemaVersion: "riot-match-timeline-v1",
  });
  if (!isVerifiedArchive(verification)) {
    orphanInvalid += 1;
    await recordOrphan(object, {
      sha256: verification.actualSha256,
      uncompressedBytes: verification.actualUncompressedBytes,
      state: "unresolved",
      reason: "unmanifested object failed source verification",
    });
    orphanUnresolved += 1;
    continue;
  }
  orphanValid += 1;
  let source;
  try {
    source = await readArchivedSource(object.key);
  } catch {
    await recordOrphan(object, {
      sha256: verification.actualSha256,
      uncompressedBytes: verification.actualUncompressedBytes,
      state: "unresolved",
      reason: "unmanifested object is valid gzip but not a supported source envelope",
    });
    orphanUnresolved += 1;
    continue;
  }
  const matchId = sourceMatchIdentity(source);
  const pointer = matchId ? await matchPointer(matchId) : null;
  const existingPointerMatches = Boolean(
    pointer &&
    pointer.archive_status !== "legacy" &&
    pointer.pointer_key === object.key &&
    pointer.pointer_sha256 === verification.actualSha256,
  );
  let registered = false;
  if (
    repairMode === "safe" &&
    matchId &&
    parsedKey.patch === (process.env.LOL_PATCH ?? "26.18") &&
    (existingPointerMatches || !pointer) &&
    validSourceMatch(source)
  ) {
    const data = staticDataCache.get(parsedKey.patch) ?? (await patchData(parsedKey.patch));
    staticDataCache.set(parsedKey.patch, data);
    const input = {
      objectKind: "match-source" as const,
      sourceMatchId: matchId,
      sourceIdentity: `match:${matchId}`,
      patch: parsedKey.patch,
      platformRegion: parsedKey.region,
      objectKey: object.key,
      sha256: verification.actualSha256!,
      compressedBytes: object.bytes,
      uncompressedBytes: verification.actualUncompressedBytes!,
      sourceSchemaVersion: "riot-match-timeline-v1",
      extractorVersion: "timeline-extractor-v2",
      datasetVersion: "26.18-euw-ranked-solo-v1",
    };
    if (existingPointerMatches) {
      await transaction(async (client) => {
        const intent = await ensurePendingArchiveIntent(client, input);
        await markArchiveVerified(client, intent.archive_object_id, input);
      });
      registered = true;
    } else if (!pointer) {
      const match = source.match as AnyRecord;
      const timeline = source.timeline as AnyRecord;
      const participants = (match.info.participants ?? []) as AnyRecord[];
      const projection = buildCompactProjection({
        participants,
        timeline: timeline as RiotTimeline,
        championStats: data.championStats,
        staticItems: data.staticItems,
        scenarioMinute: Number(process.env.SCENARIO_MINUTE ?? 25),
        scenarioMinuteTolerance: Number(process.env.SCENARIO_MINUTE_TOLERANCE ?? 2),
      });
      const intent = await transaction((client) => ensurePendingArchiveIntent(client, input));
      await persistArchivedMatch({
        matchId,
        match,
        patch: parsedKey.patch,
        platformRegion: parsedKey.region,
        routingRegion: routing,
        gameVersion: String(match.info.gameVersion ?? ""),
        tierByPuuid: new Map(),
        archiveObjectId: intent.archive_object_id,
        archiveObject: {
          key: object.key,
          sha256: verification.actualSha256!,
          compressedBytes: object.bytes,
          uncompressedBytes: verification.actualUncompressedBytes!,
        },
        projection,
      });
      registered = true;
    }
  }
  await recordOrphan(object, {
    sha256: verification.actualSha256,
    uncompressedBytes: verification.actualUncompressedBytes,
    state: registered ? "registered" : "unresolved",
    reason: registered
      ? "verified through the normal archive manifest path"
      : "valid source object requires manual identity/retention decision",
  });
  if (registered) orphanRegistered += 1;
  else orphanUnresolved += 1;
}

const finalManifests = await query<{ status: string; count: string }>(
  `SELECT status,count(*)::text AS count FROM lol_dps.archive_objects GROUP BY status ORDER BY status`,
);
const finalOrphans = await query<{ state: string; count: string }>(
  `SELECT state,count(*)::text AS count FROM lol_dps.archive_orphans GROUP BY state ORDER BY state`,
);
console.log(
  `Archive reconciliation: bucket_objects=${bucketObjects.length}, raw_objects=${rawObjects.length}, manifests=${manifests.length}, healthy_verified=${healthyVerified}, verified_missing_match=${verifiedMissingMatch}, pending_or_failed_with_object=${pendingOrFailedWithObject}, recovered=${recoveredManifests}, missing_objects=${missingObjects}, verification_mismatches=${verificationMismatches}, valid_unmanifested=${orphanValid}, invalid_unmanifested=${orphanInvalid}, registered_unmanifested=${orphanRegistered}, unresolved_unmanifested=${orphanUnresolved}, mode=${repairMode}.`,
);
console.log(
  `Final manifest states=${finalManifests.map((row) => `${row.status}:${row.count}`).join(",") || "none"}; orphan states=${finalOrphans.map((row) => `${row.state}:${row.count}`).join(",") || "none"}.`,
);
await database().end();
