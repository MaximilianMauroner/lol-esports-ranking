import { spawnTestProcess } from "../process.ts";
import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifySourceMappingFiles } from "../../../tools/dps/rulesets/verify-source-mapping.ts";
import { buildSourceMapping, assertSourceMapping } from "../../../src/domains/dps/rulesets/source-mapping.ts";
import {
  assertPinnedSourceSet,
  buildPinnedSourceSet,
} from "../../../src/domains/dps/rulesets/source-validation.ts";

const rootPaths: string[] = [];
afterEach(async () => {
  await Promise.all(rootPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const files = [
  {
    artifactId: "cdragon-modes",
    file: "modes.json",
    bytes: new TextEncoder().encode('{"mode":11}'),
  },
  {
    artifactId: "ddragon-items",
    file: "items.json",
    bytes: new TextEncoder().encode('{"version":"16.18.1"}'),
  },
];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "p02-source-mapping-"));
  rootPaths.push(root);
  const retained = files.map(({ artifactId, bytes }) => ({ artifactId, bytes }));
  const sourceDraft = {
    schemaVersion: 1 as const,
    sourceSetId: "mapping-fixture",
    patch: "26.18",
    hotfixRevision: "26.18-cutoff-2026-09-18",
    dataDragonVersion: "16.18.1",
    communityDragonRevision: "16.18",
    regionApplicability: ["EUW1", "NA1"],
    requiredArtifactIds: files.map(({ artifactId }) => artifactId),
    sourceArtifacts: files.map(({ artifactId, file }) => ({
      retainedPath: file,
      artifact: {
        artifactId,
        kind: artifactId.startsWith("cdragon")
          ? ("community-dragon" as const)
          : ("data-dragon" as const),
        uri: artifactId.startsWith("cdragon")
          ? "https://raw.communitydragon.org/16.18/game/modes.json"
          : "https://ddragon.leagueoflegends.com/cdn/16.18.1/data/en_US/item.json",
        version: artifactId.startsWith("cdragon") ? "16.18" : "16.18.1",
        retrievedAt: "2026-09-26T00:00:00Z",
      },
    })),
  };
  const sourceSet = await buildPinnedSourceSet(sourceDraft, retained);
  const verified = await assertPinnedSourceSet(sourceSet, retained);
  for (const { file, bytes } of files) await writeFile(join(root, file), bytes);
  await writeFile(join(root, "source-set.json"), JSON.stringify(sourceSet));
  const draft = {
    schemaVersion: 1 as const,
    pcPatch: "26.18",
    dataDragonVersion: "16.18.1",
    communityDragonRevision: "16.18",
    regions: [
      {
        regionId: "NA1",
        hotfixRevision: sourceSet.hotfixRevision,
        evidenceArtifactIds: ["cdragon-modes"],
      },
      {
        regionId: "EUW1",
        hotfixRevision: sourceSet.hotfixRevision,
        evidenceArtifactIds: ["cdragon-modes"],
      },
    ],
    modes: [
      {
        modeId: "summoners-rift",
        mapId: 11,
        queueIds: [420, 400],
        regionIds: ["NA1", "EUW1"],
        evidenceArtifactIds: ["ddragon-items", "cdragon-modes"],
      },
    ],
  };
  return { root, sourceSet, verified, draft };
}

test("identical retained bytes and reordered mapping inputs produce one canonical manifest", async () => {
  const { root, sourceSet, verified, draft } = await fixture();
  const first = await buildSourceMapping(draft, verified);
  const second = await buildSourceMapping(
    {
      ...draft,
      regions: [...draft.regions].reverse(),
      modes: draft.modes.map((mode) => ({
        ...mode,
        queueIds: [...mode.queueIds].reverse(),
        regionIds: [...mode.regionIds].reverse(),
        evidenceArtifactIds: [...mode.evidenceArtifactIds].reverse(),
      })),
    },
    verified,
  );
  expect(second).toEqual(first);
  expect(first.mappingHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(first.regions.map((entry) => entry.regionId)).toEqual(["EUW1", "NA1"]);
  expect(first.modes[0]!.queueIds).toEqual([400, 420]);
  const checked = await assertSourceMapping(first, verified);
  expect(Object.isFrozen(checked.regions[0])).toBe(true);
  expect(Object.isFrozen(checked.modes[0]!.queueIds)).toBe(true);
  expect(() => checked.modes[0]!.queueIds.push(999)).toThrow();
  expect(() => {
    checked.regions[0]!.hotfixRevision = "forged";
  }).toThrow();
  expect(checked.mappingHash).toBe(first.mappingHash);
  await writeFile(join(root, "mapping.json"), JSON.stringify(first));
  expect(
    await verifySourceMappingFiles(join(root, "source-set.json"), root, join(root, "mapping.json")),
  ).toEqual({
    scope: "source-mapping-only",
    sourceSetHash: sourceSet.sourceSetHash,
    mappingHash: first.mappingHash,
    verifiedArtifactCount: 2,
    totalBytes: files.reduce((sum, entry) => sum + entry.bytes.length, 0),
    regionCount: 2,
    modeCount: 1,
  });
});

test("changed source bytes, hotfix and mode assignments change identity", async () => {
  const { verified, draft, sourceSet } = await fixture();
  const original = await buildSourceMapping(draft, verified);
  const changedMode = await buildSourceMapping(
    { ...draft, modes: [{ ...draft.modes[0]!, queueIds: [430] }] },
    verified,
  );
  expect(changedMode.mappingHash).not.toBe(original.mappingHash);
  const changedRegionalHotfix = await buildSourceMapping(
    {
      ...draft,
      regions: draft.regions.map((entry) =>
        entry.regionId === "NA1" ? { ...entry, hotfixRevision: "26.18-na1-hotfix-2" } : entry,
      ),
    },
    verified,
  );
  expect(changedRegionalHotfix.mappingHash).not.toBe(original.mappingHash);
  const changedSource = await buildPinnedSourceSet(
    {
      ...sourceSet,
      sourceArtifacts: sourceSet.sourceArtifacts.map(({ artifact, retainedPath }) => ({
        retainedPath,
        artifact: {
          artifactId: artifact.artifactId,
          kind: artifact.kind,
          uri: artifact.uri,
          version: artifact.version,
          retrievedAt: artifact.retrievedAt,
        },
      })),
    },
    files.map(({ artifactId, bytes }) => ({
      artifactId,
      bytes: artifactId === "cdragon-modes" ? new TextEncoder().encode("changed") : bytes,
    })),
  );
  const changedVerified = await assertPinnedSourceSet(
    changedSource,
    files.map(({ artifactId, bytes }) => ({
      artifactId,
      bytes: artifactId === "cdragon-modes" ? new TextEncoder().encode("changed") : bytes,
    })),
  );
  expect((await buildSourceMapping(draft, changedVerified)).mappingHash).not.toBe(
    original.mappingHash,
  );
  const hotfixDraft = { ...sourceSet, hotfixRevision: "26.18-cutoff-2026-09-19" };
  const hotfixSet = await buildPinnedSourceSet(
    {
      ...hotfixDraft,
      sourceArtifacts: sourceSet.sourceArtifacts.map(({ artifact, retainedPath }) => ({
        retainedPath,
        artifact: {
          artifactId: artifact.artifactId,
          kind: artifact.kind,
          uri: artifact.uri,
          version: artifact.version,
          retrievedAt: artifact.retrievedAt,
        },
      })),
    },
    files.map(({ artifactId, bytes }) => ({ artifactId, bytes })),
  );
  const hotfixVerified = await assertPinnedSourceSet(
    hotfixSet,
    files.map(({ artifactId, bytes }) => ({ artifactId, bytes })),
  );
  const hotfixMapping = await buildSourceMapping(
    {
      ...draft,
      regions: draft.regions.map((entry) => ({
        ...entry,
        hotfixRevision: hotfixSet.hotfixRevision,
      })),
    },
    hotfixVerified,
  );
  expect(hotfixMapping.mappingHash).not.toBe(original.mappingHash);
});

test("missing evidence, conflicting patch, region, mode and queue IDs block mapping", async () => {
  const { verified, draft } = await fixture();
  const invalid = [
    { ...draft, pcPatch: "26.19" },
    { ...draft, regions: draft.regions.slice(0, 1) },
    { ...draft, regions: [...draft.regions, draft.regions[0]!] },
    ...["latest", "26.18-latest", "current-hotfix"].map((hotfixRevision) => ({
      ...draft,
      regions: draft.regions.map((entry) => ({ ...entry, hotfixRevision })),
    })),
    { ...draft, modes: [...draft.modes, draft.modes[0]!] },
    {
      ...draft,
      modes: [draft.modes[0]!, { ...draft.modes[0]!, modeId: "arena" }],
    },
    {
      ...draft,
      modes: [{ ...draft.modes[0]!, evidenceArtifactIds: ["missing"] }],
    },
    {
      ...draft,
      regions: draft.regions.map((entry) => ({
        ...entry,
        evidenceArtifactIds: ["ddragon-items"],
      })),
      modes: [{ ...draft.modes[0]!, evidenceArtifactIds: ["ddragon-items"] }],
    },
    { ...draft, modes: [{ ...draft.modes[0]!, regionIds: ["BR1"] }] },
  ];
  for (const candidate of invalid) {
    await expect(buildSourceMapping(candidate, verified)).rejects.toThrow();
  }
  const valid = await buildSourceMapping(draft, verified);
  await expect(
    assertSourceMapping({ ...valid, mappingHash: `sha256:${"0".repeat(64)}` }, verified),
  ).rejects.toThrow(/hash/);
  await expect(
    assertSourceMapping({ ...valid, sourceSetHash: `sha256:${"0".repeat(64)}` }, verified),
  ).rejects.toThrow(/identity/);
  const rollingAlias = structuredClone(valid);
  rollingAlias.regions[0]!.hotfixRevision = "current-hotfix";
  await expect(assertSourceMapping(rollingAlias, verified)).rejects.toThrow(/explicit hotfix/);
  await expect(
    assertSourceMapping(
      { ...valid, modes: [{ ...valid.modes[0]!, queueIds: [420, 400] }] },
      verified,
    ),
  ).rejects.toThrow(/canonical order/);
});

test("offline verification rejects a missing or corrupt retained source with no CLI output", async () => {
  const { root, verified, draft } = await fixture();
  const mapping = await buildSourceMapping(draft, verified);
  await writeFile(join(root, "mapping.json"), JSON.stringify(mapping));
  const run = () =>
    spawnTestProcess(
      [
        process.execPath,
        "tools/dps/rulesets/verify-source-mapping.ts",
        join(root, "source-set.json"),
        root,
        join(root, "mapping.json"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
  const success = run();
  expect(await success.exited).toBe(0);
  expect(JSON.parse(await success.stdout).mappingHash).toBe(
    mapping.mappingHash,
  );
  await writeFile(join(root, "modes.json"), "corrupt");
  const corrupt = run();
  expect(await corrupt.exited).toBe(1);
  expect(await corrupt.stdout).toBe("");
  await rm(join(root, "modes.json"));
  const missing = run();
  expect(await missing.exited).toBe(1);
  expect(await missing.stdout).toBe("");
});
