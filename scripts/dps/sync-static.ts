import { database, transaction } from "./db/client.ts";
import { isCompletedLegendary } from "../../src/domains/dps/observed-items.ts";
import {
  compressStaticArchive,
  DATASET_VERSION,
  EXTRACTOR_VERSION,
  putVerifiedStaticArchive,
  STATIC_SOURCE_SCHEMA_VERSION,
  staticArchiveObjectKey,
  staticSourceIdentity,
} from "./storage/archive.ts";
import {
  createPendingArchiveIntent,
  markArchiveFailed,
  markArchiveUploadAttempt,
  markArchiveVerified,
} from "./storage/manifest.ts";

type StaticPayload = { data: Record<string, any> };

const patch = process.env.LOL_PATCH ?? "26.18";
const version = process.env.DDRAGON_VERSION ?? "16.18.1";
const base = `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US`;
const requestTimeoutMs = Number(process.env.STATIC_REQUEST_TIMEOUT_MS ?? 20_000);

if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0)
  throw new Error("STATIC_REQUEST_TIMEOUT_MS must be positive");

async function fetchStaticBytes(url: string): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error("Data Dragon static-data request failed");
    return Uint8Array.from(new Uint8Array(await response.arrayBuffer()));
  } catch {
    throw new Error("Data Dragon static-data request timed out or failed");
  } finally {
    clearTimeout(timeout);
  }
}

const [championBytes, itemBytes] = await Promise.all([
  fetchStaticBytes(`${base}/champion.json`),
  fetchStaticBytes(`${base}/item.json`),
]);
const champions = JSON.parse(new TextDecoder().decode(championBytes)) as StaticPayload;
const items = JSON.parse(new TextDecoder().decode(itemBytes)) as StaticPayload;

const championArchive = compressStaticArchive("champions", patch, version, championBytes);
const itemArchive = compressStaticArchive("items", patch, version, itemBytes);
const championIntent = {
  objectKind: "static-source" as const,
  sourceIdentity: staticSourceIdentity(patch, version, "champions"),
  patch,
  platformRegion: null,
  objectKey: staticArchiveObjectKey(patch, version, "champions", championArchive.sha256),
  sha256: championArchive.sha256,
  compressedBytes: championArchive.compressedBytes,
  uncompressedBytes: championArchive.uncompressedBytes,
  sourceSchemaVersion: STATIC_SOURCE_SCHEMA_VERSION,
  extractorVersion: EXTRACTOR_VERSION,
  datasetVersion: DATASET_VERSION,
};
const itemIntent = {
  objectKind: "static-source" as const,
  sourceIdentity: staticSourceIdentity(patch, version, "items"),
  patch,
  platformRegion: null,
  objectKey: staticArchiveObjectKey(patch, version, "items", itemArchive.sha256),
  sha256: itemArchive.sha256,
  compressedBytes: itemArchive.compressedBytes,
  uncompressedBytes: itemArchive.uncompressedBytes,
  sourceSchemaVersion: STATIC_SOURCE_SCHEMA_VERSION,
  extractorVersion: EXTRACTOR_VERSION,
  datasetVersion: DATASET_VERSION,
};
const intents = [
  await createPendingArchiveIntent(championIntent),
  await createPendingArchiveIntent(itemIntent),
];
await Promise.all(intents.map((intent) => markArchiveUploadAttempt(intent.archive_object_id)));

let championObject: Awaited<ReturnType<typeof putVerifiedStaticArchive>>;
let itemObject: Awaited<ReturnType<typeof putVerifiedStaticArchive>>;
try {
  [championObject, itemObject] = await Promise.all([
    putVerifiedStaticArchive(championArchive),
    putVerifiedStaticArchive(itemArchive),
  ]);
} catch (error) {
  await Promise.all(intents.map((intent) => markArchiveFailed(intent.archive_object_id, error)));
  throw error;
}

await transaction(async (client) => {
  await markArchiveVerified(client, intents[0]!.archive_object_id, {
    objectKey: championObject.key,
    sha256: championObject.sha256,
    compressedBytes: championObject.compressedBytes,
    uncompressedBytes: championObject.uncompressedBytes,
  });
  await markArchiveVerified(client, intents[1]!.archive_object_id, {
    objectKey: itemObject.key,
    sha256: itemObject.sha256,
    compressedBytes: itemObject.compressedBytes,
    uncompressedBytes: itemObject.uncompressedBytes,
  });
  await client.query(
    `INSERT INTO lol_dps.patches (patch,ddragon_version,released_at)
     VALUES ($1,$2,DATE '2026-09-09')
     ON CONFLICT (patch) DO UPDATE SET ddragon_version=EXCLUDED.ddragon_version,synced_at=now()`,
    [patch, version],
  );
  for (const champion of Object.values(champions.data)) {
    await client.query(
      `INSERT INTO lol_dps.champions (patch,champion_id,slug,name,stats,raw)
       VALUES ($1,$2,$3,$4,$5,NULL)
       ON CONFLICT (patch,champion_id) DO UPDATE SET
         slug=EXCLUDED.slug,name=EXCLUDED.name,stats=EXCLUDED.stats`,
      [patch, Number(champion.key), champion.id, champion.name, champion.stats],
    );
  }
  for (const [id, item] of Object.entries(items.data)) {
    const shape = {
      id: Number(id),
      name: item.name as string,
      tags: (item.tags ?? []) as string[],
      goldTotal: Number(item.gold?.total ?? 0),
      purchasable: Boolean(item.gold?.purchasable),
      fromIds: (item.from ?? []).map(Number),
      intoIds: (item.into ?? []).map(Number),
      maps: (item.maps ?? {}) as Record<string, boolean>,
    };
    await client.query(
      `INSERT INTO lol_dps.items
        (patch,item_id,name,tags,gold_total,purchasable,from_ids,into_ids,maps,completed_legendary,raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL)
       ON CONFLICT (patch,item_id) DO UPDATE SET
         name=EXCLUDED.name,tags=EXCLUDED.tags,gold_total=EXCLUDED.gold_total,
         purchasable=EXCLUDED.purchasable,from_ids=EXCLUDED.from_ids,into_ids=EXCLUDED.into_ids,
         maps=EXCLUDED.maps,completed_legendary=EXCLUDED.completed_legendary`,
      [
        patch,
        shape.id,
        shape.name,
        shape.tags,
        shape.goldTotal,
        shape.purchasable,
        shape.fromIds,
        shape.intoIds,
        shape.maps,
        isCompletedLegendary(shape),
      ],
    );
  }
});

console.log(
  `Synced ${Object.keys(champions.data).length} champions and ${Object.keys(items.data).length} items for ${patch}; static archives verified (${championObject.compressedBytes + itemObject.compressedBytes} compressed B).`,
);
await database().end();
