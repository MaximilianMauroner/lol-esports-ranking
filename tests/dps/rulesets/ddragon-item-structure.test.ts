import { spawnTestProcess } from "../process.ts";
import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileRetainedDataDragonItemStructure } from "../../../tools/dps/rulesets/compile-retained-ddragon-item-structure.ts";
import { discoverDataDragonItemStructure } from "../../../src/domains/dps/rulesets/ddragon-item-structure.ts";
import { buildPinnedSourceSet } from "../../../src/domains/dps/rulesets/source-validation.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const version = "16.18.1";
const itemData = () => ({
  type: "item",
  version,
  data: {
    "1001": {
      name: "Component",
      gold: { total: 300, purchasable: true },
      maps: { "11": true },
      into: ["2001"],
      stats: { FlatMovementSpeedMod: 25 },
    },
    "2001": {
      name: "Upgrade",
      gold: { total: 900, purchasable: true },
      maps: { "11": true },
      from: ["1001", "1001"],
      effect: { Effect1Amount: "0.12" },
    },
    "3001": {
      name: "Unreciprocated listing",
      gold: { total: 0, purchasable: false },
      maps: { "11": false },
      into: ["2001"],
    },
  },
});

async function fixture(
  options: {
    items?: unknown;
    extra?: string;
    hotfix?: string;
    retrievedAt?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "p02-ddragon-item-structure-"));
  roots.push(root);
  const itemBytes = new TextEncoder().encode(JSON.stringify(options.items ?? itemData()));
  const manualBytes = new TextEncoder().encode(options.extra ?? "unselected");
  const sourceSet = await buildPinnedSourceSet(
    {
      schemaVersion: 1,
      sourceSetId: "fixture-item-structure",
      patch: "fixture-pc-26.18",
      hotfixRevision: options.hotfix ?? "fixture-hotfix-1",
      dataDragonVersion: version,
      communityDragonRevision: "fixture-cdragon-16.18",
      regionApplicability: ["EUW1"],
      requiredArtifactIds: ["item-index", "manual-scope"],
      sourceArtifacts: [
        {
          retainedPath: "item.json",
          artifact: {
            artifactId: "item-index",
            kind: "data-dragon",
            uri: `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/item.json`,
            version,
            retrievedAt: options.retrievedAt ?? "2026-09-28T00:00:00Z",
          },
        },
        {
          retainedPath: "manual.txt",
          artifact: {
            artifactId: "manual-scope",
            kind: "manual",
            uri: "https://example.invalid/fixture-1/manual.txt",
            version: "fixture-1",
            retrievedAt: options.retrievedAt ?? "2026-09-28T00:00:00Z",
          },
        },
      ],
    },
    [
      { artifactId: "item-index", bytes: itemBytes },
      { artifactId: "manual-scope", bytes: manualBytes },
    ],
  );
  await writeFile(join(root, "item.json"), itemBytes);
  await writeFile(join(root, "manual.txt"), manualBytes);
  await writeFile(join(root, "source-set.json"), JSON.stringify(sourceSet));
  return { root, sourceSet, itemBytes };
}

test("verified item bytes preserve component multiplicity, field keys and visible link gaps", async () => {
  const { root, sourceSet, itemBytes } = await fixture();
  const first = await compileRetainedDataDragonItemStructure(sourceSet, root, "item-index");
  expect(await compileRetainedDataDragonItemStructure(sourceSet, root, "item-index")).toEqual(
    first,
  );
  expect(first.structure.itemCount).toBe(3);
  expect(first.structure.fromLinkCount).toBe(2);
  expect(first.structure.intoLinkCount).toBe(2);
  expect(first.structure.items.find(({ id }) => id === "2001")?.from).toEqual(["1001", "1001"]);
  expect(first.structure.effectKeys).toEqual(["Effect1Amount"]);
  expect(first.structure.statKeys).toEqual(["FlatMovementSpeedMod"]);
  expect(first.structure.linkGaps).toEqual([
    {
      kind: "into-link-without-reciprocal-from",
      itemId: "3001",
      targetId: "2001",
      sourcePointer: "/data/3001/into/0",
    },
  ]);
  expect(first.structure.pcPatchMappingReviewed).toBe(false);
  expect(first.structure.activeModeMappingReviewed).toBe(false);
  expect(first.structure.combatComplete).toBe(false);
  expect(first.undiscoveredArtifactIds).toEqual(["manual-scope"]);
  expect(first.reportHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  const recaptured = await fixture({ retrievedAt: "2026-09-29T00:00:00Z" });
  expect(
    (
      await compileRetainedDataDragonItemStructure(
        recaptured.sourceSet,
        recaptured.root,
        "item-index",
      )
    ).reportHash,
  ).toBe(first.reportHash);
  const artifact = sourceSet.sourceArtifacts[0]!.artifact;
  const pending = discoverDataDragonItemStructure(artifact, itemBytes);
  itemBytes.fill(0);
  expect((await pending).structureHash).toBe(first.structure.structureHash);
});

test("selected, unselected and hotfix source identity changes report hash", async () => {
  const original = await fixture();
  const first = await compileRetainedDataDragonItemStructure(
    original.sourceSet,
    original.root,
    "item-index",
  );
  for (const options of [
    {
      items: {
        ...itemData(),
        data: { ...itemData().data, "1001": { ...itemData().data["1001"], name: "Changed" } },
      },
    },
    { extra: "changed unselected bytes" },
    { hotfix: "fixture-hotfix-2" },
  ]) {
    const changed = await fixture(options);
    expect(
      (await compileRetainedDataDragonItemStructure(changed.sourceSet, changed.root, "item-index"))
        .reportHash,
    ).not.toBe(first.reportHash);
  }
});

test("missing, conflicting and corrupt item sources fail closed", async () => {
  const original = await fixture();
  const compile = (source = original, id = "item-index") =>
    compileRetainedDataDragonItemStructure(source.sourceSet, source.root, id);
  await expect(compile(original, "missing")).rejects.toThrow("missing");
  const missingLink = itemData();
  missingLink.data["1001"].into = ["9999"];
  await expect(compile(await fixture({ items: missingLink }))).rejects.toThrow("missing item 9999");
  const badReverse = itemData();
  badReverse.data["1001"].into = [];
  await expect(compile(await fixture({ items: badReverse }))).rejects.toThrow(
    "from links conflict",
  );
  const duplicateInto = itemData();
  duplicateInto.data["1001"].into = ["2001", "2001"];
  await expect(compile(await fixture({ items: duplicateInto }))).rejects.toThrow(
    "duplicate into links",
  );
  const artifact = original.sourceSet.sourceArtifacts[0]!.artifact;
  await expect(
    discoverDataDragonItemStructure(
      { ...artifact, uri: `${artifact.uri}?variant=1` },
      original.itemBytes,
    ),
  ).rejects.toThrow("query-free");
  await writeFile(join(original.root, "manual.txt"), "corrupt");
  await expect(compile()).rejects.toThrow("hash mismatch");
  await rm(join(original.root, "item.json"));
  await expect(compile()).rejects.toThrow();
});

test("CLI emits one canonical report and no stdout for missing or corrupt sources", async () => {
  const { root, sourceSet } = await fixture();
  const run = (id = "item-index") =>
    spawnTestProcess(
      [
        process.execPath,
        "tools/dps/rulesets/compile-retained-ddragon-item-structure.ts",
        join(root, "source-set.json"),
        root,
        id,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
  const success = run();
  expect(await success.exited).toBe(0);
  expect(JSON.parse(await success.stdout)).toEqual(
    await compileRetainedDataDragonItemStructure(sourceSet, root, "item-index"),
  );
  const missing = run("missing");
  expect(await missing.stdout).toBe("");
  expect(await missing.exited).toBe(1);
  await writeFile(join(root, "manual.txt"), "corrupt");
  const corrupt = run();
  expect(await corrupt.stdout).toBe("");
  expect(await corrupt.exited).toBe(1);
});
