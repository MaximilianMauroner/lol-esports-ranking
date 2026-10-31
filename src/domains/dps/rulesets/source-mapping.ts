import { z } from "zod";

import { ContentHashSchema, canonicalJson, hashCanonical } from "../contracts/index.ts";
import type { VerifiedPinnedSourceSet } from "./source-validation.ts";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const numericId = z.number().int().nonnegative().safe();
const region = z
  .object({
    regionId: id,
    hotfixRevision: id,
    evidenceArtifactIds: z.array(id).min(1),
  })
  .strict();
const mode = z
  .object({
    modeId: id,
    mapId: numericId,
    queueIds: z.array(numericId).min(1),
    regionIds: z.array(id).min(1),
    evidenceArtifactIds: z.array(id).min(1),
  })
  .strict();

export const SourceMappingSchema = z
  .object({
    schemaVersion: z.literal(1),
    scope: z.literal("source-mapping-only"),
    sourceSetHash: ContentHashSchema,
    pcPatch: id,
    dataDragonVersion: id,
    communityDragonRevision: id,
    regions: z.array(region).min(1),
    modes: z.array(mode).min(1),
    mappingHash: ContentHashSchema,
  })
  .strict();
export type SourceMapping = z.infer<typeof SourceMappingSchema>;
export type SourceMappingDraft = Omit<SourceMapping, "mappingHash" | "sourceSetHash" | "scope">;

function compare<T extends string | number>(left: T, right: T): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sorted<T extends string | number>(values: readonly T[]): T[] {
  return [...values].sort(compare);
}

function unique<T>(values: readonly T[], label: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${label} must be unique`);
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}

function assertSorted<T extends string | number>(values: readonly T[], label: string): void {
  if (canonicalJson(values) !== canonicalJson(sorted(values)))
    throw new TypeError(`${label} must use canonical order`);
}

function canonicalize(draft: SourceMappingDraft): SourceMappingDraft {
  return {
    ...draft,
    regions: draft.regions
      .map((entry) => ({ ...entry, evidenceArtifactIds: sorted(entry.evidenceArtifactIds) }))
      .sort((left, right) => compare(left.regionId, right.regionId)),
    modes: draft.modes
      .map((entry) => ({
        ...entry,
        queueIds: sorted(entry.queueIds),
        regionIds: sorted(entry.regionIds),
        evidenceArtifactIds: sorted(entry.evidenceArtifactIds),
      }))
      .sort((left, right) => compare(left.modeId, right.modeId)),
  };
}

function hashInput(mapping: SourceMapping): Omit<SourceMapping, "mappingHash"> {
  return {
    schemaVersion: mapping.schemaVersion,
    scope: mapping.scope,
    sourceSetHash: mapping.sourceSetHash,
    pcPatch: mapping.pcPatch,
    dataDragonVersion: mapping.dataDragonVersion,
    communityDragonRevision: mapping.communityDragonRevision,
    regions: mapping.regions,
    modes: mapping.modes,
  };
}

function assertMappingContents(mapping: SourceMapping, sourceSet: VerifiedPinnedSourceSet): void {
  if (
    mapping.sourceSetHash !== sourceSet.sourceSetHash ||
    mapping.pcPatch !== sourceSet.patch ||
    mapping.dataDragonVersion !== sourceSet.dataDragonVersion ||
    mapping.communityDragonRevision !== sourceSet.communityDragonRevision
  ) {
    throw new TypeError("source mapping conflicts with pinned source-set identity");
  }
  const artifactIds = new Set(sourceSet.sourceArtifacts.map(({ artifact }) => artifact.artifactId));
  const kindsById = new Map(
    sourceSet.sourceArtifacts.map(({ artifact }) => [artifact.artifactId, artifact.kind]),
  );
  const sourceKinds = new Set(sourceSet.sourceArtifacts.map(({ artifact }) => artifact.kind));
  if (!sourceKinds.has("data-dragon") || !sourceKinds.has("community-dragon"))
    throw new TypeError(
      "source mapping requires retained Data Dragon and CommunityDragon artifacts",
    );

  const regionIds = mapping.regions.map((entry) => entry.regionId);
  unique(regionIds, "region IDs");
  assertSorted(regionIds, "regions");
  if (canonicalJson(regionIds) !== canonicalJson(sourceSet.regionApplicability))
    throw new TypeError("source mapping regions must match pinned region applicability exactly");
  const referencedArtifactIds = new Set<string>();
  for (const entry of mapping.regions) {
    if (/(^|[./_-])(?:latest|current)(?:$|[./_-])/i.test(entry.hotfixRevision))
      throw new TypeError(`region ${entry.regionId} must use an explicit hotfix revision`);
    assertEvidence(entry.evidenceArtifactIds, artifactIds, `region ${entry.regionId}`);
    entry.evidenceArtifactIds.forEach((id) => referencedArtifactIds.add(id));
  }

  const modeIds = mapping.modes.map((entry) => entry.modeId);
  unique(modeIds, "mode IDs");
  assertSorted(modeIds, "modes");
  const queueIds: number[] = [];
  for (const entry of mapping.modes) {
    unique(entry.queueIds, `mode ${entry.modeId} queue IDs`);
    assertSorted(entry.queueIds, `mode ${entry.modeId} queue IDs`);
    unique(entry.regionIds, `mode ${entry.modeId} region IDs`);
    assertSorted(entry.regionIds, `mode ${entry.modeId} region IDs`);
    assertEvidence(entry.evidenceArtifactIds, artifactIds, `mode ${entry.modeId}`);
    entry.evidenceArtifactIds.forEach((id) => referencedArtifactIds.add(id));
    for (const regionId of entry.regionIds) {
      if (!regionIds.includes(regionId))
        throw new TypeError(`mode ${entry.modeId} references unknown region ${regionId}`);
    }
    queueIds.push(...entry.queueIds);
  }
  unique(queueIds, "queue IDs across modes");
  const referencedKinds = new Set([...referencedArtifactIds].map((id) => kindsById.get(id)));
  if (!referencedKinds.has("data-dragon") || !referencedKinds.has("community-dragon"))
    throw new TypeError(
      "source mapping must reference retained Data Dragon and CommunityDragon evidence",
    );
}

function assertEvidence(ids: string[], available: Set<string>, label: string): void {
  unique(ids, `${label} evidence artifact IDs`);
  assertSorted(ids, `${label} evidence artifact IDs`);
  for (const id of ids) {
    if (!available.has(id))
      throw new TypeError(`${label} references missing source artifact ${id}`);
  }
}

/** This records supplied source assignments, never content or mode completeness. */
export async function buildSourceMapping(
  draft: SourceMappingDraft,
  sourceSet: VerifiedPinnedSourceSet,
): Promise<SourceMapping> {
  const candidate = SourceMappingSchema.parse({
    ...canonicalize(draft),
    scope: "source-mapping-only",
    sourceSetHash: sourceSet.sourceSetHash,
    mappingHash: `sha256:${"0".repeat(64)}`,
  });
  assertMappingContents(candidate, sourceSet);
  candidate.mappingHash = await hashCanonical(hashInput(candidate));
  return candidate;
}

export async function assertSourceMapping(
  value: unknown,
  sourceSet: VerifiedPinnedSourceSet,
): Promise<Readonly<SourceMapping>> {
  const mapping = SourceMappingSchema.parse(value);
  assertMappingContents(mapping, sourceSet);
  if (mapping.mappingHash !== (await hashCanonical(hashInput(mapping))))
    throw new TypeError("source mapping hash does not match canonical mapping");
  deepFreeze(mapping);
  return mapping;
}
