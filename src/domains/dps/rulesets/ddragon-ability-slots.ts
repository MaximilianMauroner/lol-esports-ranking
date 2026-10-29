import { z } from "zod";
import { SourceArtifactSchema } from "../contracts/index.ts";
import { discoverDataDragonIndex } from "./ddragon-discovery.ts";
import { assertPinnedSourceArtifactUrl, hashRetainedSourceBytes } from "./source-validation.ts";

const detailRoot = z.object({
  type: z.literal("champion"),
  version: z.string().min(1),
  data: z.record(z.string().min(1), z.unknown()),
});
const detail = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  name: z.string(),
  passive: z.object({ name: z.string() }),
  spells: z.array(z.object({ id: z.string().min(1), name: z.string() })).length(4),
});
const spellSlots = ["Q", "W", "E", "R"] as const;

function pointer(key: string): string {
  return `/data/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}
function byId(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Verified source slots only; Data Dragon does not establish all forms or combat behavior. */
export async function discoverDataDragonAbilitySlots(
  rawIndexArtifact: unknown,
  indexBytes: Uint8Array,
  rawDetailArtifact: unknown,
  detailBytes: Uint8Array,
) {
  // Detach both sources before awaiting index validation; callers retain their inputs.
  const artifact = SourceArtifactSchema.parse(rawDetailArtifact);
  const retained = Uint8Array.from(detailBytes);
  const index = await discoverDataDragonIndex(rawIndexArtifact, indexBytes);
  if (index.kind !== "champion-index")
    throw new TypeError("ability discovery requires a champion index");

  if (artifact.kind !== "data-dragon" || artifact.artifactId === index.artifact.artifactId)
    throw new TypeError("ability discovery requires a distinct Data Dragon detail artifact");
  const url = assertPinnedSourceArtifactUrl(artifact);
  const match = /^\/cdn\/([^/]+)\/data\/([a-z]{2}_[A-Z]{2})\/championFull\.json$/.exec(
    url.pathname,
  );
  if (
    !match ||
    match[1] !== artifact.version ||
    match[2] !== index.locale ||
    artifact.version !== index.artifact.version
  )
    throw new TypeError("ability discovery requires the matching pinned championFull index");

  // Verify and parse the same private copy, independent of concurrent caller changes.
  if ((await hashRetainedSourceBytes(retained)) !== artifact.contentHash)
    throw new TypeError("Data Dragon champion detail bytes do not match the artifact hash");
  const parsed = detailRoot.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(retained)),
  );
  if (parsed.version !== artifact.version)
    throw new TypeError("champion detail version differs from its pinned artifact");

  const expected = new Map(index.entries.map((entry) => [entry.slug, entry]));
  if (Object.keys(parsed.data).length !== expected.size)
    throw new TypeError("champion detail roster differs from its pinned index");
  const gaps: Array<{
    id: string;
    slot: "passive" | (typeof spellSlots)[number];
    reason: "empty-name";
  }> = [];
  const entries = Object.entries(parsed.data)
    .map(([slug, value]) => {
      const source = expected.get(slug);
      const record = detail.parse(value);
      if (!source || record.id !== slug || record.key !== source.id || record.name !== source.name)
        throw new TypeError("champion detail identity differs from its pinned index");
      if (new Set(record.spells.map((spell) => spell.id)).size !== spellSlots.length)
        throw new TypeError("champion detail contains duplicate spell source IDs");
      const root = pointer(slug);
      const abilities = [
        {
          slot: "passive" as const,
          sourceId: null,
          name: record.passive.name,
          sourcePointer: `${root}/passive`,
        },
        ...record.spells.map((spell, position) => ({
          slot: spellSlots[position]!,
          sourceId: spell.id,
          name: spell.name,
          sourcePointer: `${root}/spells/${position}`,
        })),
      ];
      for (const ability of abilities) {
        if (!ability.name.trim())
          gaps.push({ id: source.id, slot: ability.slot, reason: "empty-name" });
      }
      return { id: source.id, slug, sourcePointer: root, abilities };
    })
    .sort(byId);
  return {
    scope: "data-dragon-primary-ability-slots-only" as const,
    indexArtifact: index.artifact,
    detailArtifact: artifact,
    locale: index.locale,
    entries,
    gaps: gaps.sort(
      (left, right) => byId(left, right) || spellOrder(left.slot) - spellOrder(right.slot),
    ),
  };
}

function spellOrder(slot: "passive" | (typeof spellSlots)[number]): number {
  return slot === "passive" ? 0 : spellSlots.indexOf(slot) + 1;
}
