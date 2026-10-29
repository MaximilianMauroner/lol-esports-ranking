import { randomUUID } from "node:crypto";
import { database, hasDatabase } from "./db/client.ts";
import {
  buildCompactProjection,
  estimateCompactProjectionBytes,
} from "./ingestion/compact-projection.ts";
import type { StaticItemShape } from "../../src/domains/dps/observed-items.ts";
import type { RiotTimeline } from "../../src/domains/dps/observation-types.ts";
import { persistArchivedMatch } from "./ingestion/persist.ts";
import { nextBatchBoundary, type IngestionCeilings } from "./ingestion/limits.ts";
import { runArchiveFirst } from "./storage/archive-workflow.ts";
import {
  archiveEnabled,
  archiveObjectKey,
  buildMatchArchive,
  compressArchive,
  DATASET_VERSION,
  EXTRACTOR_VERSION,
  putVerifiedArchive,
  SOURCE_SCHEMA_VERSION,
} from "./storage/archive.ts";
import {
  createPendingArchiveIntent,
  markArchiveFailed,
  markArchiveUploadAttempt,
  type ArchiveManifestRow,
} from "./storage/manifest.ts";

type AnyRecord = Record<string, any>;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function ceiling(value: string | undefined, fallback: number, label: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`${label} must be a non-negative number`);
  return Math.floor(parsed);
}

const patch = process.env.LOL_PATCH ?? "26.18";
const apiKey = process.env.RIOT_API_KEY;
const platform = arg("--region") ?? "EUW1";
const routing = arg("--routing") ?? "EUROPE";
const tiers = (arg("--tiers") ?? "CHALLENGER,GRANDMASTER,MASTER").split(",");
const maxPlayers = ceiling(arg("--players") ?? process.env.INGEST_MAX_PLAYERS, 100, "players");
const requestedMatches = ceiling(
  arg("--matches") ?? process.env.INGEST_MAX_MATCHES,
  200,
  "matches",
);
const maxMatches = Math.min(1000, requestedMatches);
const maxAcceptedMatches = Math.min(
  maxMatches,
  ceiling(
    arg("--max-accepted") ?? process.env.INGEST_MAX_ACCEPTED_MATCHES,
    maxMatches,
    "accepted matches",
  ),
);
const candidateLimit = Math.min(
  4000,
  ceiling(arg("--candidates") ?? process.env.INGEST_CANDIDATES, maxMatches, "candidates"),
);
const candidateOffset = Math.max(
  0,
  ceiling(arg("--candidate-offset") ?? process.env.INGEST_CANDIDATE_OFFSET, 0, "candidate offset"),
);
const configuredMaxRequests = Math.min(
  5000,
  ceiling(arg("--max-requests") ?? process.env.INGEST_MAX_REQUESTS, 5000, "requests"),
);
const maxBucketBytes = ceiling(
  arg("--max-bucket-bytes") ?? process.env.INGEST_MAX_BUCKET_BYTES,
  256 * 1024 * 1024,
  "bucket bytes",
);
const maxProjectedPgBytes = ceiling(
  arg("--max-pg-hot-bytes") ?? process.env.INGEST_MAX_PROJECTED_PG_BYTES,
  64 * 1024 * 1024,
  "projected Postgres bytes",
);
const scenarioMinute = Number(process.env.SCENARIO_MINUTE ?? 25);
const scenarioMinuteTolerance = Number(process.env.SCENARIO_MINUTE_TOLERANCE ?? 2);
const gameVersionPrefix = process.env.DDRAGON_VERSION?.replace(/\.1$/, "") ?? "16.18";
const patchStartUnix = Number(process.env.PATCH_START_UNIX ?? 1788912000);
const patchEndUnix = Number(process.env.PATCH_END_UNIX ?? Math.floor(Date.now() / 1000) + 3600);
const globalRequestCeiling = 5000;
const untrackedRequestReserve = Math.max(0, Number(process.env.GLOBAL_REQUEST_RESERVE ?? 500));
const riotRequestTimeoutMs = ceiling(
  process.env.RIOT_REQUEST_TIMEOUT_MS,
  20_000,
  "Riot request timeout",
);
const batchCeilings: IngestionCeilings = {
  acceptedMatches: maxAcceptedMatches,
  requests: configuredMaxRequests,
  bucketBytes: maxBucketBytes,
  projectedPgBytes: maxProjectedPgBytes,
};

if (!hasDatabase())
  throw new Error(
    "DATABASE_URL is required for ingestion. Run db:migrate after binding the intended Railway Postgres service.",
  );
if (!apiKey)
  throw new Error(
    "RIOT_API_KEY is not configured. Copy .env.example, add the key locally, then rerun ingestion.",
  );
if (process.env.ARCHIVE_REQUIRED === "false")
  throw new Error("ARCHIVE_REQUIRED=false is unsupported: archive-first ingestion is mandatory.");
if (!archiveEnabled())
  throw new Error(
    "Railway bucket S3 variables are required for ingestion. Configure BUCKET, ENDPOINT, REGION, ACCESS_KEY_ID, and SECRET_ACCESS_KEY.",
  );

const platformHost = `${platform.toLowerCase()}.api.riotgames.com`;
const routingHost = `${routing.toLowerCase()}.api.riotgames.com`;
const headers = { "X-Riot-Token": apiKey };
let lastRequestAt = 0;
let requestCount = 0;
let maxRequests = configuredMaxRequests;

async function riotJson<T>(url: string): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (requestCount >= maxRequests)
      throw new Error(`Riot request ceiling reached (${maxRequests}).`);
    requestCount += 1;
    const wait = Math.max(0, 110 - (Date.now() - lastRequestAt));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), riotRequestTimeoutMs);
    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      if (response.ok) return (await response.json()) as T;
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get("retry-after") ?? 1);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(retryAfter * 1000, 500 * 2 ** attempt)),
        );
        continue;
      }
      throw new Error(`Riot API request failed with status ${response.status}.`);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith("Riot API request failed") ||
          error.message.startsWith("Riot request ceiling"))
      )
        throw error;
      if (attempt === 4) throw new Error("Riot API request timed out or failed.", { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error("Riot API retry budget exhausted.");
}

const itemRows = await database().query<AnyRecord>(
  `SELECT item_id, name, tags, gold_total, purchasable, from_ids, into_ids, maps
     FROM lol_dps.items WHERE patch = $1`,
  [patch],
);
const staticItems = new Map<number, StaticItemShape>(
  itemRows.rows.map((row) => [
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
const championRows = await database().query<AnyRecord>(
  `SELECT champion_id, stats FROM lol_dps.champions WHERE patch = $1`,
  [patch],
);
const championStats = new Map<number, AnyRecord>(
  championRows.rows.map((row) => [Number(row.champion_id), row.stats]),
);
const requestHistory = await database().query<{ used: string }>(
  `SELECT COALESCE(SUM(CASE WHEN cursor->>'requestCount' ~ '^[0-9]+$'
                    THEN (cursor->>'requestCount')::bigint ELSE 0 END),0)::text AS used
     FROM lol_dps.ingestion_runs`,
);
const knownRequestCount = Number(requestHistory.rows[0]?.used ?? 0);
maxRequests = Math.min(
  configuredMaxRequests,
  Math.max(0, globalRequestCeiling - knownRequestCount - untrackedRequestReserve),
);
batchCeilings.requests = maxRequests;
if (maxRequests <= 0) {
  throw new Error("The global Riot request ceiling is exhausted; no new ingestion was started.");
}
const runId = randomUUID();
await database().query(
  `INSERT INTO lol_dps.ingestion_runs (run_id,patch,platform_region,routing_region,tiers,status)
   VALUES ($1,$2,$3,$4,$5,'running')`,
  [runId, patch, platform, routing, tiers],
);

try {
  const enrichedRows = await database().query<{ puuid: string }>(
    `SELECT DISTINCT p.puuid
       FROM lol_dps.participants p
       JOIN lol_dps.matches m ON m.match_id = p.match_id
      WHERE p.puuid IS NOT NULL AND p.champion_id = 804 AND m.patch = $1
      ORDER BY p.puuid
      LIMIT $2`,
    [patch, Math.min(50, maxPlayers)],
  );
  const enrichedSeeds = enrichedRows.rows
    .map((row) => ({ puuid: row.puuid, tier: "ENRICHED_YUNARA" }))
    .filter((seed) => seed.puuid.length > 0);
  const regularSeeds: Array<{ puuid: string; tier: string }> = [];
  for (const tier of tiers) {
    const path =
      tier === "CHALLENGER"
        ? "challengerleagues"
        : tier === "GRANDMASTER"
          ? "grandmasterleagues"
          : "masterleagues";
    const league = await riotJson<AnyRecord>(
      `https://${platformHost}/lol/league/v4/${path}/by-queue/RANKED_SOLO_5x5`,
    );
    for (const entry of (league.entries ?? []).slice(0, Math.ceil(maxPlayers / tiers.length))) {
      let puuid = entry.puuid as string | undefined;
      if (!puuid && entry.summonerId) {
        const summoner = await riotJson<AnyRecord>(
          `https://${platformHost}/lol/summoner/v4/summoners/${entry.summonerId}`,
        );
        puuid = summoner.puuid;
      }
      if (puuid) regularSeeds.push({ puuid, tier });
      if (regularSeeds.length >= maxPlayers) break;
    }
    if (regularSeeds.length >= maxPlayers) break;
  }
  const seeds: Array<{ puuid: string; tier: string }> = [];
  const seenSeeds = new Set<string>();
  for (const seed of [...enrichedSeeds, ...regularSeeds]) {
    if (seenSeeds.has(seed.puuid)) continue;
    seenSeeds.add(seed.puuid);
    seeds.push(seed);
  }
  const knownMatchRows = await database().query<{ match_id: string }>(
    `SELECT match_id FROM lol_dps.matches`,
  );
  const knownMatchIds = new Set(knownMatchRows.rows.map((row) => row.match_id));
  const matchIds = new Set<string>();
  let emptySeeds = 0;
  for (const seed of seeds) {
    const ids = await riotJson<string[]>(
      `https://${routingHost}/lol/match/v5/matches/by-puuid/${encodeURIComponent(seed.puuid)}/ids?queue=420&startTime=${patchStartUnix}&endTime=${patchEndUnix}&start=0&count=100`,
    );
    if (ids.length === 0) emptySeeds += 1;
    for (const id of ids) {
      if (!knownMatchIds.has(id)) matchIds.add(id);
    }
    if (matchIds.size >= candidateOffset + candidateLimit) break;
  }
  const selected = [...matchIds].slice(candidateOffset, candidateOffset + candidateLimit);
  const tierByPuuid = new Map(seeds.map((seed) => [seed.puuid, seed.tier]));
  await database().query(
    `UPDATE lol_dps.ingestion_runs SET players_seen=$2,matches_seen=$3 WHERE run_id=$1`,
    [runId, seeds.length, selected.length],
  );
  let ingested = 0;
  let projectedBucketBytes = 0;
  let projectedPgBytes = 0;
  let stopReason: string | null = null;
  const skipped = { existing: 0, short: 0, malformed: 0, patch: 0, outsideWindow: 0 };
  for (const matchId of selected) {
    if (ingested >= maxAcceptedMatches) {
      stopReason = "accepted-match-ceiling";
      break;
    }
    const exists = await database().query(`SELECT 1 FROM lol_dps.matches WHERE match_id=$1`, [
      matchId,
    ]);
    if (exists.rowCount) {
      skipped.existing += 1;
      continue;
    }
    const match = await riotJson<AnyRecord>(
      `https://${routingHost}/lol/match/v5/matches/${matchId}`,
    );
    const info = match.info as AnyRecord;
    const gameVersion = String(info.gameVersion ?? "");
    const durationSeconds = Number(info.gameDuration ?? 0);
    const gameStartUnix = Math.floor(Number(info.gameStartTimestamp ?? 0) / 1000);
    if (
      !Number.isFinite(gameStartUnix) ||
      gameStartUnix < patchStartUnix ||
      gameStartUnix > patchEndUnix
    ) {
      skipped.outsideWindow += 1;
      continue;
    }
    if (durationSeconds < 900) {
      skipped.short += 1;
      continue;
    }
    if (!Array.isArray(info.participants) || info.participants.length !== 10) {
      skipped.malformed += 1;
      continue;
    }
    if (!gameVersion.startsWith(gameVersionPrefix)) {
      skipped.patch += 1;
      continue;
    }
    const timeline = await riotJson<RiotTimeline>(
      `https://${routingHost}/lol/match/v5/matches/${matchId}/timeline`,
    );
    const archive = compressArchive(buildMatchArchive(match, timeline));
    const projection = buildCompactProjection({
      participants: info.participants,
      timeline,
      championStats,
      staticItems,
      scenarioMinute,
      scenarioMinuteTolerance,
    });
    const estimatedPgBytes = estimateCompactProjectionBytes(projection);
    const boundary = nextBatchBoundary(
      {
        acceptedMatches: ingested,
        requests: requestCount,
        bucketBytes: projectedBucketBytes,
        projectedPgBytes,
      },
      {
        acceptedMatches: ingested + 1,
        requests: requestCount,
        bucketBytes: projectedBucketBytes + archive.compressedBytes,
        projectedPgBytes: projectedPgBytes + estimatedPgBytes,
      },
      batchCeilings,
    );
    if (boundary) {
      stopReason = boundary;
      break;
    }
    const archiveIntent = {
      objectKind: "match-source",
      sourceMatchId: matchId,
      sourceIdentity: `match:${matchId}`,
      patch,
      platformRegion: platform,
      objectKey: archiveObjectKey(patch, platform, archive.sha256),
      sha256: archive.sha256,
      compressedBytes: archive.compressedBytes,
      uncompressedBytes: archive.uncompressedBytes,
      sourceSchemaVersion: SOURCE_SCHEMA_VERSION,
      extractorVersion: EXTRACTOR_VERSION,
      datasetVersion: DATASET_VERSION,
    } as const;
    await runArchiveFirst<ArchiveManifestRow, Awaited<ReturnType<typeof putVerifiedArchive>>>({
      createPendingIntent: () => createPendingArchiveIntent(archiveIntent),
      markUploadAttempt: (pending) => markArchiveUploadAttempt(pending.archive_object_id),
      uploadAndVerify: () => putVerifiedArchive(archive, { patch, region: platform }),
      markUploadFailed: (pending, error) => markArchiveFailed(pending.archive_object_id, error),
      finalizeTransactionally: (pending, archiveObject) =>
        persistArchivedMatch({
          matchId,
          match,
          patch,
          platformRegion: platform,
          routingRegion: routing,
          gameVersion,
          tierByPuuid,
          archiveObjectId: pending.archive_object_id,
          archiveObject,
          projection,
        }),
    });
    ingested += 1;
    projectedBucketBytes += archive.compressedBytes;
    projectedPgBytes += estimatedPgBytes;
    await database().query(
      `UPDATE lol_dps.ingestion_runs SET matches_ingested=$2,cursor=$3 WHERE run_id=$1`,
      [
        runId,
        ingested,
        {
          requestCount,
          candidateOffset,
          patchStartUnix,
          patchEndUnix,
          projectedBucketBytes,
          projectedPgBytes,
        },
      ],
    );
    console.log(`Ingested ${ingested}/${selected.length} accepted match(es).`);
  }
  const status = stopReason ? "stopped" : "complete";
  await database().query(
    `UPDATE lol_dps.ingestion_runs SET status=$2,finished_at=now(),cursor=$3 WHERE run_id=$1`,
    [
      runId,
      status,
      {
        requestCount,
        candidateOffset,
        patchStartUnix,
        patchEndUnix,
        projectedBucketBytes,
        projectedPgBytes,
        stopReason,
      },
    ],
  );
  console.log(
    `Ingestion ${status}: ${ingested} new ${patch} match(es); bucket=${projectedBucketBytes} B, projected-pg=${projectedPgBytes} B, requests=${requestCount}.`,
  );
  console.log(
    `Discovery seeds=${seeds.length}, empty=${emptySeeds}, selected=${selected.length}; skipped existing=${skipped.existing}, short=${skipped.short}, malformed=${skipped.malformed}, outside-window=${skipped.outsideWindow}, other-patch=${skipped.patch}; stop=${stopReason ?? "none"}.`,
  );
} catch (error) {
  await database().query(
    `UPDATE lol_dps.ingestion_runs SET status='failed',error=$2,finished_at=now(),cursor=$3 WHERE run_id=$1`,
    [
      runId,
      String(error).slice(0, 1000),
      { requestCount, candidateOffset, patchStartUnix, patchEndUnix },
    ],
  );
  throw error;
} finally {
  await database().end();
}
