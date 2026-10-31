import { z } from "zod";

import { SourceArtifactSchema, hashCanonical } from "../contracts/index.ts";
import { assertPinnedSourceArtifactUrl, hashRetainedSourceBytes } from "./source-validation.ts";

const positiveId = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine((value) => Number.isSafeInteger(Number(value)));
const numericId = z.number().int().positive().safe();
const rune = z.object({ id: numericId, key: z.string().min(1), name: z.string() });
const runeTree = z.object({
  id: numericId,
  key: z.string().min(1),
  name: z.string(),
  slots: z.array(z.object({ runes: z.array(rune).min(1) })).min(1),
});
const summonerIndex = z.object({
  type: z.literal("summoner"),
  version: z.string().min(1),
  data: z.record(z.string().min(1), z.unknown()),
});
const summoner = z.object({
  id: z.string().min(1),
  key: positiveId,
  name: z.string(),
  modes: z.array(z.string().min(1)).min(1),
});
const mapIndex = z.object({
  type: z.literal("map"),
  version: z.string().min(1),
  data: z.record(z.string().min(1), z.unknown()),
});
const map = z.object({ MapId: positiveId, MapName: z.string() });

type RawSource = Readonly<{ artifact: unknown; bytes: Uint8Array }>;
export type DataDragonAuxiliarySources = Readonly<{
  runes: RawSource;
  summoners: RawSource;
  maps: RawSource;
}>;
type Role = keyof DataDragonAuxiliarySources;

function compare<T extends string | number>(left: T, right: T): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

async function parseSource(role: Role, raw: RawSource) {
  const artifact = SourceArtifactSchema.parse(raw.artifact);
  if (artifact.kind !== "data-dragon")
    throw new TypeError(`${role} inventory requires a Data Dragon artifact`);
  const url = assertPinnedSourceArtifactUrl(artifact);
  const filename = role === "runes" ? "runesReforged" : role === "summoners" ? "summoner" : "map";
  const match = /^\/cdn\/([^/]+)\/data\/([a-z]{2}_[A-Z]{2})\/([^/]+)\.json$/.exec(url.pathname);
  if (
    !match ||
    match[1] !== artifact.version ||
    match[3] !== filename ||
    artifact.uri.includes("?")
  )
    throw new TypeError(`${role} inventory requires a query-free pinned Data Dragon URL`);
  const retained = Uint8Array.from(raw.bytes);
  if ((await hashRetainedSourceBytes(retained)) !== artifact.contentHash)
    throw new TypeError(`${role} inventory bytes do not match the artifact hash`);
  return {
    artifact,
    locale: match[2]!,
    value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(retained)) as unknown,
  };
}

function unique<T>(values: readonly T[], label: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${label} must be unique`);
}

/** Retained Data Dragon IDs only; active modes and combat semantics remain unreviewed. */
export async function discoverDataDragonAuxiliaryInventory(sources: DataDragonAuxiliarySources) {
  // Detach all bytes before the first await so caller mutation cannot change the evidence.
  const stable = {
    runes: { artifact: sources.runes.artifact, bytes: Uint8Array.from(sources.runes.bytes) },
    summoners: {
      artifact: sources.summoners.artifact,
      bytes: Uint8Array.from(sources.summoners.bytes),
    },
    maps: { artifact: sources.maps.artifact, bytes: Uint8Array.from(sources.maps.bytes) },
  };
  const [runeSource, summonerSource, mapSource] = await Promise.all([
    parseSource("runes", stable.runes),
    parseSource("summoners", stable.summoners),
    parseSource("maps", stable.maps),
  ]);
  const selected = [runeSource, summonerSource, mapSource];
  unique(
    selected.map(({ artifact }) => artifact.artifactId),
    "auxiliary source artifact IDs",
  );
  if (
    new Set(selected.map(({ artifact }) => artifact.version)).size !== 1 ||
    new Set(selected.map(({ locale }) => locale)).size !== 1
  )
    throw new TypeError("auxiliary Data Dragon versions or locales conflict");

  const trees = z.array(runeTree).min(1).parse(runeSource.value);
  unique(
    trees.map((tree) => tree.id),
    "rune tree IDs",
  );
  unique(
    trees.map((tree) => tree.key),
    "rune tree keys",
  );
  const gaps: Array<{
    kind: "rune-tree" | "rune" | "summoner" | "map";
    id: string;
    reason: "empty-name";
    sourcePointer: string;
  }> = [];
  const runeTrees = trees.map((tree, treeIndex) => {
    const sourcePointer = `/${treeIndex}`;
    if (!tree.name.trim())
      gaps.push({ kind: "rune-tree", id: String(tree.id), reason: "empty-name", sourcePointer });
    return {
      id: tree.id,
      key: tree.key,
      name: tree.name,
      sourcePointer,
      slots: tree.slots.map((slot, slotIndex) => ({
        position: slotIndex,
        runeIds: slot.runes.map((entry) => entry.id),
      })),
    };
  });
  const runes = trees.flatMap((tree, treeIndex) =>
    tree.slots.flatMap((slot, slotIndex) =>
      slot.runes.map((entry, runeIndex) => {
        const sourcePointer = `/${treeIndex}/slots/${slotIndex}/runes/${runeIndex}`;
        if (!entry.name.trim())
          gaps.push({ kind: "rune", id: String(entry.id), reason: "empty-name", sourcePointer });
        return {
          id: entry.id,
          key: entry.key,
          name: entry.name,
          treeId: tree.id,
          slotIndex,
          runeIndex,
          sourcePointer,
        };
      }),
    ),
  );
  unique(
    runes.map((entry) => entry.id),
    "rune IDs",
  );
  unique(
    runes.map((entry) => entry.key),
    "rune keys",
  );

  const parsedSummoners = summonerIndex.parse(summonerSource.value);
  if (parsedSummoners.version !== summonerSource.artifact.version)
    throw new TypeError("summoner index version conflicts with its artifact");
  if (Object.keys(parsedSummoners.data).length === 0)
    throw new TypeError("summoner index cannot be empty");
  const summoners = Object.entries(parsedSummoners.data).map(([slug, value]) => {
    const entry = summoner.parse(value);
    if (entry.id !== slug) throw new TypeError(`summoner ${slug} identity conflicts with its key`);
    unique(entry.modes, `summoner ${slug} mode tags`);
    const sourcePointer = `/data/${pointer(slug)}`;
    if (!entry.name.trim())
      gaps.push({ kind: "summoner", id: entry.key, reason: "empty-name", sourcePointer });
    return {
      id: entry.key,
      slug,
      name: entry.name,
      sourcePointer,
      modeTags: [...entry.modes].sort(compare),
    };
  });
  unique(
    summoners.map((entry) => entry.id),
    "summoner numeric IDs",
  );

  const parsedMaps = mapIndex.parse(mapSource.value);
  if (parsedMaps.version !== mapSource.artifact.version)
    throw new TypeError("map index version conflicts with its artifact");
  if (Object.keys(parsedMaps.data).length === 0) throw new TypeError("map index cannot be empty");
  const maps = Object.entries(parsedMaps.data).map(([id, value]) => {
    positiveId.parse(id);
    const entry = map.parse(value);
    if (entry.MapId !== id) throw new TypeError(`map ${id} identity conflicts with its key`);
    const sourcePointer = `/data/${pointer(id)}`;
    if (!entry.MapName.trim()) gaps.push({ kind: "map", id, reason: "empty-name", sourcePointer });
    return { id, name: entry.MapName, sourcePointer };
  });
  unique(
    maps.map((entry) => entry.id),
    "map IDs",
  );

  const body = {
    schemaVersion: 1 as const,
    scope: "data-dragon-auxiliary-id-inventory-only" as const,
    pcPatchMappingReviewed: false as const,
    activeModeMappingReviewed: false as const,
    combatComplete: false as const,
    dataDragonVersion: runeSource.artifact.version,
    locale: runeSource.locale,
    sources: {
      runes: sourceIdentity(runeSource.artifact),
      summoners: sourceIdentity(summonerSource.artifact),
      maps: sourceIdentity(mapSource.artifact),
    },
    runeTrees: runeTrees.sort((left, right) => compare(left.id, right.id)),
    runes: runes.sort((left, right) => compare(left.id, right.id)),
    summoners: summoners.sort((left, right) => compare(Number(left.id), Number(right.id))),
    maps: maps.sort((left, right) => compare(Number(left.id), Number(right.id))),
    rawSummonerModeTags: [...new Set(summoners.flatMap((entry) => entry.modeTags))].sort(compare),
    gaps: gaps.sort((left, right) => compare(left.kind, right.kind) || compare(left.id, right.id)),
  };
  return { ...body, inventoryHash: await hashCanonical(body) };
}

function sourceIdentity(artifact: z.infer<typeof SourceArtifactSchema>) {
  return {
    artifactId: artifact.artifactId,
    uri: artifact.uri,
    version: artifact.version,
    contentHash: artifact.contentHash,
  };
}

export type DataDragonAuxiliaryInventory = Awaited<
  ReturnType<typeof discoverDataDragonAuxiliaryInventory>
>;
