import { z } from "zod";
import { SourceArtifactSchema } from "../contracts/index.ts";
import { assertPinnedSourceArtifactUrl, hashRetainedSourceBytes } from "./source-validation.ts";

const sourceId = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine((value) => Number.isSafeInteger(Number(value)));
const index = z.object({
  type: z.enum(["champion", "item"]),
  version: z.string().min(1),
  data: z.record(z.string().min(1), z.unknown()),
});
const champion = z.object({
  version: z.string(),
  id: z.string().min(1),
  key: sourceId,
  name: z.string(),
});
const item = z.object({
  name: z.string(),
  gold: z.object({ total: z.number().int().nonnegative(), purchasable: z.boolean() }),
  maps: z.record(z.string().min(1), z.boolean()),
});

function pointer(key: string): string {
  return `/data/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}
function compareIds(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Source discovery only: retains all IDs, including incomplete labels and inactive map flags. */
export async function discoverDataDragonIndex(rawArtifact: unknown, bytes: Uint8Array) {
  const artifact = SourceArtifactSchema.parse(rawArtifact);
  if (artifact.kind !== "data-dragon")
    throw new TypeError("discovery requires a Data Dragon artifact");
  const url = assertPinnedSourceArtifactUrl(artifact);
  const match = /^\/cdn\/([^/]+)\/data\/([a-z]{2}_[A-Z]{2})\/(champion|item)\.json$/.exec(
    url.pathname,
  );
  if (!match || match[1] !== artifact.version)
    throw new TypeError("discovery requires the pinned champion or item index URL");
  // Hash and decode one detached copy so callers cannot change bytes between those steps.
  const retained = Uint8Array.from(bytes);
  if ((await hashRetainedSourceBytes(retained)) !== artifact.contentHash)
    throw new TypeError("Data Dragon index bytes do not match the artifact hash");
  const parsed = index.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(retained)),
  );
  if (parsed.version !== artifact.version || parsed.type !== match[3])
    throw new TypeError("Data Dragon index type/version differs from its pinned artifact");
  if (Object.keys(parsed.data).length === 0)
    throw new TypeError("Data Dragon index cannot be empty");
  const gaps: Array<{ id: string; reason: "empty-name" }> = [];
  const common = {
    scope: "source-discovery-only" as const,
    artifact,
    locale: match[2]!,
  };
  if (parsed.type === "champion") {
    const entries = Object.entries(parsed.data)
      .map(([key, value]) => {
        const record = champion.parse(value);
        if (record.id !== key || record.version !== parsed.version)
          throw new TypeError("champion index entry identity/version differs from its source");
        if (!record.name.trim()) gaps.push({ id: record.key, reason: "empty-name" });
        return { id: record.key, slug: record.id, name: record.name, sourcePointer: pointer(key) };
      })
      .sort(compareIds);
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
      throw new TypeError("champion index contains duplicate numeric IDs");
    return {
      ...common,
      kind: "champion-index" as const,
      entries,
      gaps: gaps.sort(compareIds),
    };
  }
  const entries = Object.entries(parsed.data)
    .map(([key, value]) => {
      const id = sourceId.parse(key);
      const record = item.parse(value);
      if (!record.name.trim()) gaps.push({ id, reason: "empty-name" });
      return {
        id,
        name: record.name,
        totalGold: record.gold.total,
        purchasable: record.gold.purchasable,
        maps: record.maps,
        sourcePointer: pointer(key),
      };
    })
    .sort(compareIds);
  return { ...common, kind: "item-index" as const, entries, gaps: gaps.sort(compareIds) };
}
