import { hashCanonical } from "../contracts/index.ts";
import { discoverDataDragonAbilitySlots } from "./ddragon-ability-slots.ts";
import { discoverDataDragonIndex } from "./ddragon-discovery.ts";
import { assertPinnedSourceSet } from "./source-validation.ts";
import type { RetainedSourceBytes, VerifiedPinnedSourceSet } from "./source-validation.ts";

export type DataDragonCatalogSelection = Readonly<{
  championIndexArtifactId: string;
  championDetailArtifactId: string;
  itemIndexArtifactId: string;
}>;

/** Compile only the source records represented by three verified Data Dragon artifacts. */
export async function compileDataDragonSourceCatalog(
  verifiedSourceSet: VerifiedPinnedSourceSet,
  retained: readonly RetainedSourceBytes[],
  selection: DataDragonCatalogSelection,
) {
  // The selected records cannot be published against a stale or partial retained set.
  const stableRetained = retained.map(({ artifactId, bytes }) => ({
    artifactId,
    bytes: Uint8Array.from(bytes),
  }));
  const sourceSet = await assertPinnedSourceSet(verifiedSourceSet, stableRetained);
  const ids = [
    selection.championIndexArtifactId,
    selection.championDetailArtifactId,
    selection.itemIndexArtifactId,
  ];
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length)
    throw new TypeError("catalog requires three distinct source artifact IDs");

  const sources = ids.map((id) => {
    const entry = sourceSet.sourceArtifacts.find(({ artifact }) => artifact.artifactId === id);
    const bytes = stableRetained.find((source) => source.artifactId === id)?.bytes;
    if (!entry || !bytes) throw new TypeError(`catalog source artifact ${id} is missing`);
    return { ...entry, bytes };
  });
  const [championIndexSource, championDetailSource, itemIndexSource] = sources as [
    (typeof sources)[number],
    (typeof sources)[number],
    (typeof sources)[number],
  ];
  const [championIndex, abilities, itemIndex] = await Promise.all([
    discoverDataDragonIndex(championIndexSource.artifact, championIndexSource.bytes),
    discoverDataDragonAbilitySlots(
      championIndexSource.artifact,
      championIndexSource.bytes,
      championDetailSource.artifact,
      championDetailSource.bytes,
    ),
    discoverDataDragonIndex(itemIndexSource.artifact, itemIndexSource.bytes),
  ]);
  if (championIndex.kind !== "champion-index" || itemIndex.kind !== "item-index")
    throw new TypeError("catalog source roles conflict with pinned Data Dragon index types");
  if (championIndex.locale !== itemIndex.locale || abilities.locale !== championIndex.locale)
    throw new TypeError("catalog Data Dragon source locales conflict");
  if (
    championIndex.artifact.version !== sourceSet.dataDragonVersion ||
    itemIndex.artifact.version !== sourceSet.dataDragonVersion ||
    abilities.detailArtifact.version !== sourceSet.dataDragonVersion
  )
    throw new TypeError("catalog Data Dragon versions conflict with pinned source set");

  const championsById = new Map(championIndex.entries.map((entry) => [entry.id, entry]));
  const champions = abilities.entries.map((entry) => {
    const index = championsById.get(entry.id);
    if (!index) throw new TypeError(`champion ${entry.id} is absent from its index`);
    return {
      id: entry.id,
      slug: entry.slug,
      name: index.name,
      indexSourcePointer: index.sourcePointer,
      detailSourcePointer: entry.sourcePointer,
      abilities: entry.abilities,
    };
  });
  const selectedArtifacts = [
    { role: "champion-index" as const, source: championIndexSource },
    { role: "champion-detail" as const, source: championDetailSource },
    { role: "item-index" as const, source: itemIndexSource },
  ].map(({ role, source }) => ({
    role,
    artifactId: source.artifact.artifactId,
    contentHash: source.artifact.contentHash,
    retainedPath: source.retainedPath,
  }));
  const body = {
    schemaVersion: 1 as const,
    scope: "data-dragon-index-and-primary-slots-only" as const,
    combatComplete: false as const,
    sourceSetId: sourceSet.sourceSetId,
    sourceSetHash: sourceSet.sourceSetHash,
    pcPatch: sourceSet.patch,
    dataDragonVersion: sourceSet.dataDragonVersion,
    locale: championIndex.locale,
    selectedArtifacts,
    champions,
    items: itemIndex.entries,
    gaps: {
      championNames: championIndex.gaps,
      abilityNames: abilities.gaps,
      itemNames: itemIndex.gaps,
    },
    undiscoveredArtifactIds: sourceSet.sourceArtifacts
      .map(({ artifact }) => artifact.artifactId)
      .filter((id) => !ids.includes(id)),
  };
  return { ...body, catalogHash: await hashCanonical(body) };
}

export type DataDragonSourceCatalog = Awaited<ReturnType<typeof compileDataDragonSourceCatalog>>;
