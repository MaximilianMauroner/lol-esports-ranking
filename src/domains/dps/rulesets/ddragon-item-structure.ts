import { z } from "zod";

import { SourceArtifactSchema, hashCanonical } from "../contracts/index.ts";
import { discoverDataDragonIndex } from "./ddragon-discovery.ts";

const itemId = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine((value) => Number.isSafeInteger(Number(value)));
const effectKey = z.string().regex(/^Effect[1-9][0-9]*Amount$/);
const itemRecord = z.object({
  name: z.string(),
  from: z.array(itemId).optional(),
  into: z.array(itemId).optional(),
  effect: z.record(effectKey, z.string()).optional(),
  stats: z.record(z.string().min(1), z.number().finite()).optional(),
});
const itemIndex = z.object({
  type: z.literal("item"),
  version: z.string().min(1),
  data: z.record(itemId, z.unknown()),
});

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function pointer(id: string): string {
  return `/data/${id.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

/** Raw item source links and field names, without mechanic or mode interpretation. */
export async function discoverDataDragonItemStructure(rawArtifact: unknown, bytes: Uint8Array) {
  const artifact = SourceArtifactSchema.parse(rawArtifact);
  if (artifact.uri.includes("?"))
    throw new TypeError("item structure requires a query-free pinned Data Dragon URL");
  // The existing index discovery verifies the official URL, version and byte hash.
  // Parse this same detached copy after its await to avoid caller mutation races.
  const retained = Uint8Array.from(bytes);
  const discovered = await discoverDataDragonIndex(artifact, retained);
  if (discovered.kind !== "item-index")
    throw new TypeError("item structure requires a Data Dragon item index");
  const parsed = itemIndex.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(retained)),
  );
  if (parsed.version !== artifact.version)
    throw new TypeError("item structure version conflicts with its artifact");

  const ids = new Set(discovered.entries.map(({ id }) => id));
  const items = Object.entries(parsed.data)
    .map(([id, raw]) => {
      const record = itemRecord.parse(raw);
      const from = record.from ?? [];
      const into = record.into ?? [];
      if (new Set(into).size !== into.length)
        throw new TypeError(`item ${id} has duplicate into links`);
      for (const linkedId of [...from, ...into]) {
        if (!ids.has(linkedId))
          throw new TypeError(`item ${id} references missing item ${linkedId}`);
        if (linkedId === id) throw new TypeError(`item ${id} references itself`);
      }
      return {
        id,
        name: record.name,
        sourcePointer: pointer(id),
        // Duplicate components are meaningful quantities, so preserve every occurrence.
        from: [...from],
        into: [...into],
        effectKeys: Object.keys(record.effect ?? {}).sort(compare),
        statKeys: Object.keys(record.stats ?? {}).sort(compare),
      };
    })
    .sort((left, right) => compare(left.id, right.id));
  if (items.length !== ids.size)
    throw new TypeError("item structure and verified index IDs conflict");

  const byId = new Map(items.map((item) => [item.id, item]));
  const linkGaps = items.flatMap((item) =>
    item.into
      .map((targetId, linkIndex) => ({ targetId, linkIndex }))
      .filter(({ targetId }) => !byId.get(targetId)!.from.includes(item.id))
      .map(({ targetId, linkIndex }) => ({
        kind: "into-link-without-reciprocal-from" as const,
        itemId: item.id,
        targetId,
        sourcePointer: `${item.sourcePointer}/into/${linkIndex}`,
      })),
  );
  const missingInto = items.flatMap((item) =>
    [...new Set(item.from)]
      .filter((componentId) => !byId.get(componentId)!.into.includes(item.id))
      .map((componentId) => ({
        itemId: item.id,
        componentId,
        sourcePointer: `${item.sourcePointer}/from`,
      })),
  );
  if (missingInto.length) throw new TypeError("item from links conflict with component into links");

  const body = {
    schemaVersion: 1 as const,
    scope: "data-dragon-item-structure-only" as const,
    pcPatchMappingReviewed: false as const,
    activeModeMappingReviewed: false as const,
    combatComplete: false as const,
    source: {
      artifactId: artifact.artifactId,
      uri: artifact.uri,
      version: artifact.version,
      contentHash: artifact.contentHash,
      locale: discovered.locale,
    },
    itemCount: items.length,
    fromLinkCount: items.reduce((count, item) => count + item.from.length, 0),
    intoLinkCount: items.reduce((count, item) => count + item.into.length, 0),
    effectKeys: [...new Set(items.flatMap((item) => item.effectKeys))].sort(compare),
    statKeys: [...new Set(items.flatMap((item) => item.statKeys))].sort(compare),
    items,
    linkGaps,
  };
  return { ...body, structureHash: await hashCanonical(body) };
}
