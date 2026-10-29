import { z } from "zod";

import { SourceArtifactSchema, hashCanonical } from "../contracts/index.ts";
import { assertPinnedSourceArtifactUrl, hashRetainedSourceBytes } from "./source-validation.ts";

const recordSchema = z.object({ __type: z.string().min(1) }).passthrough();
const characterSchema = recordSchema.extend({
  mCharacterName: z.string().min(1),
  mAbilities: z.array(z.string().min(1)).min(1),
});
const abilitySchema = recordSchema.extend({
  mRootSpell: z.string().min(1),
  mChildSpells: z.array(z.string().min(1)).optional(),
});

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pointer(path: string): string {
  return `/${path.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${label} must be unique`);
}

/** Inventory retained CommunityDragon records and explicit character/ability source links only. */
export async function discoverCommunityDragonChampionGraph(
  rawArtifact: unknown,
  bytes: Uint8Array,
) {
  const artifact = SourceArtifactSchema.parse(rawArtifact);
  if (artifact.kind !== "community-dragon")
    throw new TypeError("champion graph requires a CommunityDragon artifact");
  const url = assertPinnedSourceArtifactUrl(artifact);
  const match = /^\/([^/]+)\/game\/data\/characters\/([a-z0-9]+)\/\2\.bin\.json$/.exec(
    url.pathname,
  );
  if (
    !match ||
    match[1] !== artifact.version ||
    url.search ||
    artifact.version.toLowerCase() === "pbe"
  )
    throw new TypeError("champion graph requires a pinned character .bin.json URL");

  // Hash and parse one private byte copy so caller mutation cannot change discovered records.
  const retained = Uint8Array.from(bytes);
  if ((await hashRetainedSourceBytes(retained)) !== artifact.contentHash)
    throw new TypeError("CommunityDragon champion bytes do not match the artifact hash");
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(retained));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError("CommunityDragon champion root must be an object");
  const root = parsed as Record<string, unknown>;
  const linkedPaths = z
    .array(z.string().min(1))
    .parse(root.__linked === undefined ? [] : root.__linked);
  unique(linkedPaths, "linked source paths");
  const records = new Map<string, z.infer<typeof recordSchema>>();
  for (const [path, value] of Object.entries(root)) {
    if (path === "__linked") continue;
    if (!path) throw new TypeError("CommunityDragon source record paths must not be empty");
    records.set(path, recordSchema.parse(value));
  }
  if (records.size === 0) throw new TypeError("CommunityDragon champion has no source records");
  const slug = match[2]!;
  const characterRecords = [...records].filter(([, value]) => value.__type === "CharacterRecord");
  if (characterRecords.length !== 1)
    throw new TypeError("champion graph requires exactly one CharacterRecord");
  const [characterPath, characterValue] = characterRecords[0]!;
  const character = characterSchema.parse(characterValue);
  if (
    character.mCharacterName.toLowerCase() !== slug ||
    !characterPath.toLowerCase().startsWith(`characters/${slug}/`)
  )
    throw new TypeError("CharacterRecord identity conflicts with pinned character URL");
  unique(character.mAbilities, "CharacterRecord ability paths");

  function requireRecord(path: string, type: string, label: string) {
    const record = records.get(path);
    if (!record || record.__type !== type)
      throw new TypeError(`${label} references missing or conflicting ${type} ${path}`);
    return record;
  }
  const abilities = character.mAbilities.map((path, index) => {
    const ability = abilitySchema.parse(requireRecord(path, "AbilityObject", "CharacterRecord"));
    const childPaths = ability.mChildSpells ?? [];
    unique([ability.mRootSpell, ...childPaths], `ability ${path} spell paths`);
    requireRecord(ability.mRootSpell, "SpellObject", `ability ${path}`);
    for (const childPath of childPaths) requireRecord(childPath, "SpellObject", `ability ${path}`);
    return {
      path,
      sourcePointer: `${pointer(characterPath)}/mAbilities/${index}`,
      recordPointer: pointer(path),
      rootSpell: { path: ability.mRootSpell, sourcePointer: `${pointer(path)}/mRootSpell` },
      childSpells: childPaths.map((childPath, childIndex) => ({
        path: childPath,
        sourcePointer: `${pointer(path)}/mChildSpells/${childIndex}`,
      })),
    };
  });
  const body = {
    schemaVersion: 1 as const,
    scope: "community-dragon-character-record-graph-only" as const,
    combatComplete: false as const,
    pcPatchMappingReviewed: false as const,
    source: {
      artifactId: artifact.artifactId,
      uri: artifact.uri,
      revision: artifact.version,
      contentHash: artifact.contentHash,
    },
    characterSlug: slug,
    characterRecord: { path: characterPath, sourcePointer: pointer(characterPath) },
    records: [...records]
      .map(([path, value]) => ({ path, type: value.__type, sourcePointer: pointer(path) }))
      .sort((left, right) => compare(left.path, right.path)),
    abilities,
    linkedPaths,
    unreferencedAbilityObjectPaths: [...records]
      .filter(
        ([path, value]) => value.__type === "AbilityObject" && !character.mAbilities.includes(path),
      )
      .map(([path]) => path)
      .sort(compare),
  };
  return { ...body, graphHash: await hashCanonical(body) };
}

export type CommunityDragonChampionGraph = Awaited<
  ReturnType<typeof discoverCommunityDragonChampionGraph>
>;
