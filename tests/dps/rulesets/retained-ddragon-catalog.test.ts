import { spawnTestProcess } from "../process.ts";
import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileRetainedDataDragonCatalog } from "../../../tools/dps/rulesets/compile-retained-ddragon.ts";
import { compileDataDragonSourceCatalog } from "../../../src/domains/dps/rulesets/ddragon-source-catalog.ts";
import {
  assertPinnedSourceSet,
  buildPinnedSourceSet,
} from "../../../src/domains/dps/rulesets/source-validation.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const selection = {
  championIndexArtifactId: "champion-index",
  championDetailArtifactId: "champion-detail",
  itemIndexArtifactId: "item-index",
};
const version = "16.18.1";
const champion = (slug: string, key: string) => ({
  id: slug,
  key,
  name: slug,
  passive: { name: `${slug} passive` },
  spells: ["Q", "W", "E", "R"].map((slot) => ({
    id: `${slug}${slot}`,
    name: `${slug} ${slot}`,
  })),
});

async function fixture(
  options: {
    itemName?: string;
    extra?: string;
    hotfix?: string;
    retrievedAt?: string;
    itemLocale?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "p02-ddragon-catalog-"));
  roots.push(root);
  const payloads = [
    {
      id: "champion-index",
      file: "champion.json",
      kind: "data-dragon" as const,
      version,
      uri: `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`,
      body: {
        type: "champion",
        version,
        data: {
          Yunara: { id: "Yunara", key: "804", name: "Yunara", version },
          Aatrox: { id: "Aatrox", key: "266", name: "Aatrox", version },
        },
      },
    },
    {
      id: "champion-detail",
      file: "championFull.json",
      kind: "data-dragon" as const,
      version,
      uri: `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/championFull.json`,
      body: {
        type: "champion",
        version,
        data: { Yunara: champion("Yunara", "804"), Aatrox: champion("Aatrox", "266") },
      },
    },
    {
      id: "item-index",
      file: "item.json",
      kind: "data-dragon" as const,
      version,
      uri: `https://ddragon.leagueoflegends.com/cdn/${version}/data/${options.itemLocale ?? "en_US"}/item.json`,
      body: {
        type: "item",
        version,
        data: {
          "2008": {
            name: "",
            gold: { total: 0, purchasable: false },
            maps: { "11": false },
          },
          "3032": {
            name: options.itemName ?? "Yun Tal",
            gold: { total: 3000, purchasable: true },
            maps: { "11": true },
          },
        },
      },
    },
    {
      id: "manual-scope",
      file: "manual.json",
      kind: "manual" as const,
      version: "fixture-1",
      uri: "https://example.invalid/fixture-1/manual.json",
      body: { note: options.extra ?? "unselected" },
    },
  ];
  const retained = payloads.map((entry) => ({
    artifactId: entry.id,
    bytes: new TextEncoder().encode(JSON.stringify(entry.body)),
  }));
  const sourceSet = await buildPinnedSourceSet(
    {
      schemaVersion: 1,
      sourceSetId: "fixture-source-catalog",
      patch: "26.18",
      hotfixRevision: options.hotfix ?? "fixture-hotfix-1",
      dataDragonVersion: version,
      communityDragonRevision: "16.18",
      regionApplicability: ["EUW1"],
      requiredArtifactIds: payloads.map((entry) => entry.id),
      sourceArtifacts: payloads.map((entry) => ({
        retainedPath: entry.file,
        artifact: {
          artifactId: entry.id,
          kind: entry.kind,
          uri: entry.uri,
          version: entry.version,
          retrievedAt: options.retrievedAt ?? "2026-09-26T00:00:00Z",
        },
      })),
    },
    retained,
  );
  for (const entry of payloads) {
    const source = retained.find((candidate) => candidate.artifactId === entry.id)!;
    await writeFile(join(root, entry.file), source.bytes);
  }
  await writeFile(join(root, "source-set.json"), JSON.stringify(sourceSet));
  return { root, sourceSet, retained };
}

test("verified sources compile a deterministic partial catalog with all IDs and visible gaps", async () => {
  const { root, sourceSet, retained } = await fixture();
  const first = await compileRetainedDataDragonCatalog(sourceSet, root, selection);
  const repeated = await compileRetainedDataDragonCatalog(sourceSet, root, selection);
  expect(repeated).toEqual(first);
  expect(first.catalogHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(first.scope).toBe("data-dragon-index-and-primary-slots-only");
  expect(first.combatComplete).toBe(false);
  expect(first.sourceSetHash).toBe(sourceSet.sourceSetHash);
  expect(first.champions.map((entry) => entry.id)).toEqual(["266", "804"]);
  expect(first.champions[1]!.abilities.map((entry) => entry.slot)).toEqual([
    "passive",
    "Q",
    "W",
    "E",
    "R",
  ]);
  expect(first.champions[1]!.indexSourcePointer).toBe("/data/Yunara");
  expect(first.champions[1]!.abilities[2]!.sourcePointer).toBe("/data/Yunara/spells/1");
  expect(first.items.map((entry) => entry.id)).toEqual(["2008", "3032"]);
  expect(first.gaps.itemNames).toEqual([{ id: "2008", reason: "empty-name" }]);
  expect(first.undiscoveredArtifactIds).toEqual(["manual-scope"]);
  const verified = await assertPinnedSourceSet(sourceSet, retained);
  expect(
    await compileDataDragonSourceCatalog(verified, [...retained].reverse(), selection),
  ).toEqual(first);
  const callerOwned = retained.map(({ artifactId, bytes }) => ({
    artifactId,
    bytes: Uint8Array.from(bytes),
  }));
  const pending = compileDataDragonSourceCatalog(verified, callerOwned, selection);
  callerOwned[1]!.bytes.fill(0);
  expect(await pending).toEqual(first);
});

test("catalog hash changes with selected or unselected bytes and hotfix source identity", async () => {
  const original = await fixture();
  const first = await compileRetainedDataDragonCatalog(
    original.sourceSet,
    original.root,
    selection,
  );
  for (const options of [
    { itemName: "Changed item" },
    { extra: "changed unselected evidence" },
    { hotfix: "fixture-hotfix-2" },
  ]) {
    const changed = await fixture(options);
    const catalog = await compileRetainedDataDragonCatalog(
      changed.sourceSet,
      changed.root,
      selection,
    );
    expect(catalog.catalogHash).not.toBe(first.catalogHash);
  }
  const recaptured = await fixture({ retrievedAt: "2026-09-27T00:00:00Z" });
  expect(
    (await compileRetainedDataDragonCatalog(recaptured.sourceSet, recaptured.root, selection))
      .catalogHash,
  ).toBe(first.catalogHash);
});

test("missing, conflicting, or corrupted retained sources cannot yield a catalog", async () => {
  const { root, sourceSet, retained } = await fixture();
  for (const invalid of [
    { ...selection, championDetailArtifactId: "missing" },
    { ...selection, championDetailArtifactId: "champion-index" },
    { ...selection, itemIndexArtifactId: "champion-detail" },
  ]) {
    await expect(compileRetainedDataDragonCatalog(sourceSet, root, invalid)).rejects.toThrow();
  }
  const mismatched = await fixture({ itemLocale: "fr_FR" });
  await expect(
    compileRetainedDataDragonCatalog(mismatched.sourceSet, mismatched.root, selection),
  ).rejects.toThrow("locales conflict");
  const verified = await assertPinnedSourceSet(sourceSet, retained);
  await expect(
    compileDataDragonSourceCatalog(verified, retained.slice(0, 3), selection),
  ).rejects.toThrow(/inventory exactly|missing/);
  await writeFile(join(root, "manual.json"), "corrupt");
  await expect(compileRetainedDataDragonCatalog(sourceSet, root, selection)).rejects.toThrow(
    /hash mismatch/,
  );
  await rm(join(root, "championFull.json"));
  await expect(compileRetainedDataDragonCatalog(sourceSet, root, selection)).rejects.toThrow();
});

test("CLI emits one canonical report or an error with empty stdout", async () => {
  const { root, sourceSet } = await fixture();
  const run = (detailId: string) =>
    spawnTestProcess(
      [
        process.execPath,
        "tools/dps/rulesets/compile-retained-ddragon.ts",
        join(root, "source-set.json"),
        root,
        selection.championIndexArtifactId,
        detailId,
        selection.itemIndexArtifactId,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
  const success = run(selection.championDetailArtifactId);
  const output = await success.stdout;
  expect(await success.exited).toBe(0);
  expect(JSON.parse(output)).toEqual(
    await compileRetainedDataDragonCatalog(sourceSet, root, selection),
  );
  const invalid = run("missing");
  expect(await invalid.stdout).toBe("");
  expect(await invalid.exited).toBe(1);
});
