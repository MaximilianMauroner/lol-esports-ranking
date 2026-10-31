import { spawnTestProcess } from "../process.ts";
import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverRetainedCommunityDragonChampion } from "../../../tools/dps/rulesets/discover-retained-cdragon.ts";
import { discoverCommunityDragonChampionGraph } from "../../../src/domains/dps/rulesets/cdragon-champion-graph.ts";
import {
  buildPinnedSourceSet,
  hashRetainedSourceBytes,
} from "../../../src/domains/dps/rulesets/source-validation.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const characterPath = "Characters/Yunara/CharacterRecords/Root";
const qAbility = "Characters/Yunara/Spells/YunaraQAbility";
const wAbility = "Characters/Yunara/Spells/YunaraWAbility";
const qSpell = `${qAbility}/YunaraQ`;
const qChild = `${qAbility}/YunaraQBounceMissile`;
const wSpell = `${wAbility}/YunaraW`;

function payload() {
  return {
    [qAbility]: {
      __type: "AbilityObject",
      mRootSpell: qSpell,
      mChildSpells: [qChild],
    },
    [wAbility]: { __type: "AbilityObject", mRootSpell: wSpell },
    [qSpell]: { __type: "SpellObject", mSpell: { mClientData: 7 } },
    [qChild]: { __type: "SpellObject" },
    [wSpell]: { __type: "SpellObject" },
    [characterPath]: {
      __type: "CharacterRecord",
      mCharacterName: "Yunara",
      mAbilities: [qAbility, wAbility],
    },
    "Characters/Yunara/Spells/Attacks/YunaraBasicAttack": { __type: "SpellObject" },
    __linked: [] as string[],
  };
}

async function source(value: unknown = payload(), retrievedAt = "2026-09-27T00:00:00Z") {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return {
    bytes,
    artifact: {
      artifactId: "cdragon-yunara",
      kind: "community-dragon",
      uri: "https://raw.communitydragon.org/16.18/game/data/characters/yunara/yunara.bin.json",
      version: "16.18",
      contentHash: await hashRetainedSourceBytes(bytes),
      retrievedAt,
    },
  };
}

async function fixture(extra = "unselected", hotfix = "fixture-hotfix") {
  const root = await mkdtemp(join(tmpdir(), "p02-cdragon-graph-"));
  roots.push(root);
  const selected = await source();
  const retained = [
    { artifactId: selected.artifact.artifactId, bytes: selected.bytes },
    { artifactId: "manual-scope", bytes: new TextEncoder().encode(extra) },
  ];
  const sourceSet = await buildPinnedSourceSet(
    {
      schemaVersion: 1,
      sourceSetId: "cdragon-graph-fixture",
      patch: "26.18",
      hotfixRevision: hotfix,
      dataDragonVersion: "16.18.1",
      communityDragonRevision: "16.18",
      regionApplicability: ["EUW1"],
      requiredArtifactIds: retained.map((entry) => entry.artifactId),
      sourceArtifacts: [
        {
          retainedPath: "yunara.bin.json",
          artifact: {
            artifactId: selected.artifact.artifactId,
            kind: "community-dragon" as const,
            uri: selected.artifact.uri,
            version: selected.artifact.version,
            retrievedAt: selected.artifact.retrievedAt,
          },
        },
        {
          retainedPath: "manual.txt",
          artifact: {
            artifactId: "manual-scope",
            kind: "manual" as const,
            uri: "https://example.invalid/fixture-1/manual.txt",
            version: "fixture-1",
            retrievedAt: selected.artifact.retrievedAt,
          },
        },
      ],
    },
    retained,
  );
  await writeFile(join(root, "yunara.bin.json"), selected.bytes);
  await writeFile(join(root, "manual.txt"), retained[1]!.bytes);
  await writeFile(join(root, "source-set.json"), JSON.stringify(sourceSet));
  return { root, sourceSet, selected };
}

test("all typed paths and explicit character/ability references remain visible and hashed", async () => {
  const original = await source();
  const graph = await discoverCommunityDragonChampionGraph(original.artifact, original.bytes);
  expect(graph.scope).toBe("community-dragon-character-record-graph-only");
  expect(graph.combatComplete).toBe(false);
  expect(graph.pcPatchMappingReviewed).toBe(false);
  expect(graph.records).toHaveLength(7);
  expect(graph.records.map((entry) => entry.path)).toEqual(
    [...graph.records.map((entry) => entry.path)].sort(),
  );
  expect(graph.abilities.map((entry) => entry.path)).toEqual([qAbility, wAbility]);
  expect(graph.abilities[0]!.sourcePointer).toBe(
    "/Characters~1Yunara~1CharacterRecords~1Root/mAbilities/0",
  );
  expect(graph.abilities[0]!.rootSpell.path).toBe(qSpell);
  expect(graph.abilities[0]!.childSpells).toEqual([
    { path: qChild, sourcePointer: "/Characters~1Yunara~1Spells~1YunaraQAbility/mChildSpells/0" },
  ]);
  expect(graph.unreferencedAbilityObjectPaths).toEqual([]);
  expect(graph.graphHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  const recaptured = await source(payload(), "2026-09-28T00:00:00Z");
  expect(
    (await discoverCommunityDragonChampionGraph(recaptured.artifact, recaptured.bytes)).graphHash,
  ).toBe(graph.graphHash);
  const pending = discoverCommunityDragonChampionGraph(original.artifact, original.bytes);
  original.bytes.fill(0);
  original.artifact.version = "changed";
  expect(await pending).toEqual(graph);
});

test("changed bytes change graph identity; provider, revision, URL and hash must stay pinned", async () => {
  const original = await source();
  const graph = await discoverCommunityDragonChampionGraph(original.artifact, original.bytes);
  const changed = payload();
  changed[qSpell].mSpell.mClientData = 8;
  const recaptured = await source(changed);
  expect(
    (await discoverCommunityDragonChampionGraph(recaptured.artifact, recaptured.bytes)).graphHash,
  ).not.toBe(graph.graphHash);
  for (const update of [
    { kind: "data-dragon" },
    { version: "16.17" },
    { uri: original.artifact.uri.replace("raw.communitydragon.org", "example.invalid") },
    { uri: original.artifact.uri.replace("/16.18/", "/pbe/") },
    { uri: `${original.artifact.uri}?latest=1` },
  ]) {
    await expect(
      discoverCommunityDragonChampionGraph({ ...original.artifact, ...update }, original.bytes),
    ).rejects.toThrow();
  }
  const corrupted = Uint8Array.from(original.bytes);
  corrupted[0] = 0;
  await expect(discoverCommunityDragonChampionGraph(original.artifact, corrupted)).rejects.toThrow(
    "artifact hash",
  );
});

test("missing or conflicting character, ability, and spell paths fail discovery", async () => {
  const mutations = [
    (value: ReturnType<typeof payload>) => {
      delete (value as Record<string, unknown>)[characterPath];
    },
    (value: ReturnType<typeof payload>) => {
      value[characterPath].mCharacterName = "Other";
    },
    (value: ReturnType<typeof payload>) => {
      value[characterPath].mAbilities.push(qAbility);
    },
    (value: ReturnType<typeof payload>) => {
      value[characterPath].mAbilities[0] = "missing";
    },
    (value: ReturnType<typeof payload>) => {
      value[qAbility].mRootSpell = "missing";
    },
    (value: ReturnType<typeof payload>) => {
      value[qAbility].mChildSpells.push(qSpell);
    },
    (value: ReturnType<typeof payload>) => {
      value[qChild].__type = "AbilityObject";
    },
    (value: ReturnType<typeof payload>) => {
      value.__linked = ["missing", "missing"];
    },
    (value: ReturnType<typeof payload>) => {
      value.__linked = null as unknown as string[];
    },
    (value: ReturnType<typeof payload>) => {
      const records = value as Record<string, unknown>;
      records["Characters/Other/CharacterRecords/Root"] = records[characterPath];
      delete records[characterPath];
    },
  ];
  for (const mutate of mutations) {
    const value = payload();
    mutate(value);
    const artifact = await source(value);
    await expect(
      discoverCommunityDragonChampionGraph(artifact.artifact, artifact.bytes),
    ).rejects.toThrow();
  }
});

test("offline report checks unselected retained bytes and CLI never prints partial output", async () => {
  const { root, sourceSet } = await fixture();
  const first = await discoverRetainedCommunityDragonChampion(sourceSet, root, "cdragon-yunara");
  expect(first.scope).toBe("retained-community-dragon-character-graph-only");
  expect(first.undiscoveredArtifactIds).toEqual(["manual-scope"]);
  expect(first.reportHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(first).toEqual(
    await discoverRetainedCommunityDragonChampion(sourceSet, root, "cdragon-yunara"),
  );
  const changedHotfix = await fixture("unselected", "changed-hotfix");
  expect(
    (
      await discoverRetainedCommunityDragonChampion(
        changedHotfix.sourceSet,
        changedHotfix.root,
        "cdragon-yunara",
      )
    ).reportHash,
  ).not.toBe(first.reportHash);

  const run = (artifactId: string) =>
    spawnTestProcess(
      [
        process.execPath,
        "tools/dps/rulesets/discover-retained-cdragon.ts",
        join(root, "source-set.json"),
        root,
        artifactId,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
  const success = run("cdragon-yunara");
  expect(await success.exited).toBe(0);
  expect(JSON.parse(await success.stdout)).toEqual(first);
  const unknown = run("missing");
  expect(await unknown.stdout).toBe("");
  expect(await unknown.exited).toBe(1);
  await writeFile(join(root, "manual.txt"), "corrupt");
  const corrupt = run("cdragon-yunara");
  expect(await corrupt.stdout).toBe("");
  expect(await corrupt.exited).toBe(1);
  await rm(join(root, "yunara.bin.json"));
  await expect(
    discoverRetainedCommunityDragonChampion(sourceSet, root, "cdragon-yunara"),
  ).rejects.toThrow();
});
