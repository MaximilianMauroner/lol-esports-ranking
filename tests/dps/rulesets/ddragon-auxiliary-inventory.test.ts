import { spawnTestProcess } from "../process.ts";
import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileRetainedDataDragonAuxiliaryInventory } from "../../../tools/dps/rulesets/compile-retained-ddragon-auxiliary.ts";
import { discoverDataDragonAuxiliaryInventory } from "../../../src/domains/dps/rulesets/ddragon-auxiliary-inventory.ts";
import { buildPinnedSourceSet } from "../../../src/domains/dps/rulesets/source-validation.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const selection = {
  runesArtifactId: "runes",
  summonerArtifactId: "summoners",
  mapArtifactId: "maps",
};
const version = "16.18.1";
const runeData = () => [
  {
    id: 8100,
    key: "Domination",
    name: "Domination",
    slots: [
      { runes: [{ id: 8112, key: "Electrocute", name: "Electrocute" }] },
      { runes: [{ id: 8126, key: "CheapShot", name: "" }] },
    ],
  },
  {
    id: 8000,
    key: "Precision",
    name: "Precision",
    slots: [{ runes: [{ id: 8005, key: "PressTheAttack", name: "Press the Attack" }] }],
  },
];
const summonerData = () => ({
  type: "summoner",
  version,
  data: {
    SummonerFlash: {
      id: "SummonerFlash",
      key: "4",
      name: "Flash",
      modes: ["CLASSIC", "ARAM"],
    },
    SummonerTest: {
      id: "SummonerTest",
      key: "71",
      name: "",
      modes: ["WIPMODEWIP"],
    },
  },
});
const mapData = () => ({
  type: "map",
  version,
  data: {
    "453": { MapId: "453", MapName: "" },
    "11": { MapId: "11", MapName: "Summoner's Rift" },
  },
});

async function fixture(
  options: {
    runes?: unknown;
    summoners?: unknown;
    maps?: unknown;
    extra?: string;
    hotfix?: string;
    retrievedAt?: string;
    summonerLocale?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "p02-ddragon-auxiliary-"));
  roots.push(root);
  const payloads = [
    {
      id: "runes",
      file: "runesReforged.json",
      kind: "data-dragon" as const,
      uri: `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/runesReforged.json`,
      version,
      value: options.runes ?? runeData(),
    },
    {
      id: "summoners",
      file: "summoner.json",
      kind: "data-dragon" as const,
      uri: `https://ddragon.leagueoflegends.com/cdn/${version}/data/${options.summonerLocale ?? "en_US"}/summoner.json`,
      version,
      value: options.summoners ?? summonerData(),
    },
    {
      id: "maps",
      file: "map.json",
      kind: "data-dragon" as const,
      uri: `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/map.json`,
      version,
      value: options.maps ?? mapData(),
    },
    {
      id: "manual-scope",
      file: "manual.txt",
      kind: "manual" as const,
      uri: "https://example.invalid/fixture-1/manual.txt",
      version: "fixture-1",
      value: options.extra ?? "unselected",
    },
  ];
  const retained = payloads.map(({ id, value }) => ({
    artifactId: id,
    bytes: new TextEncoder().encode(JSON.stringify(value)),
  }));
  const sourceSet = await buildPinnedSourceSet(
    {
      schemaVersion: 1,
      sourceSetId: "fixture-auxiliary-sources",
      patch: "fixture-pc-26.18",
      hotfixRevision: options.hotfix ?? "fixture-hotfix-1",
      dataDragonVersion: version,
      communityDragonRevision: "fixture-cdragon-16.18",
      regionApplicability: ["EUW1"],
      requiredArtifactIds: payloads.map(({ id }) => id),
      sourceArtifacts: payloads.map(({ id, file, kind, uri, version: artifactVersion }) => ({
        retainedPath: file,
        artifact: {
          artifactId: id,
          kind,
          uri,
          version: artifactVersion,
          retrievedAt: options.retrievedAt ?? "2026-09-28T00:00:00Z",
        },
      })),
    },
    retained,
  );
  for (const payload of payloads)
    await writeFile(
      join(root, payload.file),
      retained.find((entry) => entry.artifactId === payload.id)!.bytes,
    );
  await writeFile(join(root, "source-set.json"), JSON.stringify(sourceSet));
  const sources = Object.fromEntries(
    [
      ["runes", "runes"],
      ["summoners", "summoners"],
      ["maps", "maps"],
    ].map(([role, id]) => [
      role,
      {
        artifact: sourceSet.sourceArtifacts.find(({ artifact }) => artifact.artifactId === id)!
          .artifact,
        bytes: retained.find((entry) => entry.artifactId === id)!.bytes,
      },
    ]),
  ) as Parameters<typeof discoverDataDragonAuxiliaryInventory>[0];
  return { root, sourceSet, retained, sources };
}

test("verified auxiliary bytes retain all IDs, hierarchy, raw mode tags and visible gaps", async () => {
  const { root, sourceSet, sources } = await fixture();
  const first = await compileRetainedDataDragonAuxiliaryInventory(sourceSet, root, selection);
  expect(await compileRetainedDataDragonAuxiliaryInventory(sourceSet, root, selection)).toEqual(
    first,
  );
  expect(first.scope).toBe("retained-data-dragon-auxiliary-id-inventory-only");
  expect(first.inventory.pcPatchMappingReviewed).toBe(false);
  expect(first.inventory.activeModeMappingReviewed).toBe(false);
  expect(first.inventory.combatComplete).toBe(false);
  expect(first.inventory.runeTrees.map((entry) => entry.id)).toEqual([8000, 8100]);
  expect(first.inventory.runes.map((entry) => entry.id)).toEqual([8005, 8112, 8126]);
  expect(first.inventory.runes.find((entry) => entry.id === 8126)?.sourcePointer).toBe(
    "/0/slots/1/runes/0",
  );
  expect(first.inventory.summoners.map((entry) => entry.id)).toEqual(["4", "71"]);
  expect(first.inventory.rawSummonerModeTags).toEqual(["ARAM", "CLASSIC", "WIPMODEWIP"]);
  expect(first.inventory.maps.map((entry) => entry.id)).toEqual(["11", "453"]);
  expect(first.inventory.gaps.map(({ kind, id }) => `${kind}:${id}`)).toEqual([
    "map:453",
    "rune:8126",
    "summoner:71",
  ]);
  expect(first.undiscoveredArtifactIds).toEqual(["manual-scope"]);
  expect(first.reportHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  const mutableSelection = { ...selection };
  const pendingReport = compileRetainedDataDragonAuxiliaryInventory(
    sourceSet,
    root,
    mutableSelection,
  );
  mutableSelection.mapArtifactId = "missing";
  expect(await pendingReport).toEqual(first);
  const recaptured = await fixture({ retrievedAt: "2026-09-29T00:00:00Z" });
  expect(
    (
      await compileRetainedDataDragonAuxiliaryInventory(
        recaptured.sourceSet,
        recaptured.root,
        selection,
      )
    ).reportHash,
  ).toBe(first.reportHash);
  const pending = discoverDataDragonAuxiliaryInventory(sources);
  sources.runes.bytes.fill(0);
  expect((await pending).inventoryHash).toBe(first.inventory.inventoryHash);
});

test("selected bytes, unselected bytes and source-set hotfix identity change report hash", async () => {
  const original = await fixture();
  const first = await compileRetainedDataDragonAuxiliaryInventory(
    original.sourceSet,
    original.root,
    selection,
  );
  for (const options of [
    { runes: runeData().map((tree) => ({ ...tree, name: `${tree.name}!` })) },
    { extra: "changed unselected bytes" },
    { hotfix: "fixture-hotfix-2" },
  ]) {
    const changed = await fixture(options);
    const next = await compileRetainedDataDragonAuxiliaryInventory(
      changed.sourceSet,
      changed.root,
      selection,
    );
    expect(next.reportHash).not.toBe(first.reportHash);
  }
});

test("missing, conflicting, corrupt and malformed sources fail closed", async () => {
  const original = await fixture();
  const compile = (selected = selection, source = original) =>
    compileRetainedDataDragonAuxiliaryInventory(source.sourceSet, source.root, selected);
  await expect(compile({ ...selection, mapArtifactId: "missing" })).rejects.toThrow("missing");
  await expect(compile({ ...selection, mapArtifactId: "runes" })).rejects.toThrow("distinct");
  const locale = await fixture({ summonerLocale: "fr_FR" });
  await expect(compile(selection, locale)).rejects.toThrow("locales conflict");
  const duplicateRune = runeData();
  duplicateRune[1]!.slots[0]!.runes[0]!.id = 8112;
  await expect(compile(selection, await fixture({ runes: duplicateRune }))).rejects.toThrow(
    "rune IDs must be unique",
  );
  const conflictingSummoner = summonerData();
  conflictingSummoner.data.SummonerTest.key = "4";
  await expect(
    compile(selection, await fixture({ summoners: conflictingSummoner })),
  ).rejects.toThrow("summoner numeric IDs must be unique");
  const conflictingMap = mapData();
  conflictingMap.data["453"].MapId = "11";
  await expect(compile(selection, await fixture({ maps: conflictingMap }))).rejects.toThrow(
    "identity conflicts",
  );
  const direct = await fixture();
  const runeArtifact = direct.sourceSet.sourceArtifacts.find(
    ({ artifact }) => artifact.artifactId === "runes",
  )!.artifact;
  await expect(
    discoverDataDragonAuxiliaryInventory({
      ...direct.sources,
      runes: {
        ...direct.sources.runes,
        artifact: { ...runeArtifact, uri: `${runeArtifact.uri}?variant=1` },
      },
    }),
  ).rejects.toThrow("query-free pinned Data Dragon URL");
  await writeFile(join(original.root, "manual.txt"), "corrupt");
  await expect(compile()).rejects.toThrow("hash mismatch");
  await rm(join(original.root, "map.json"));
  await expect(compile()).rejects.toThrow();
});

test("CLI emits one canonical report or no stdout on missing or corrupt sources", async () => {
  const { root, sourceSet } = await fixture();
  const run = (mapArtifactId = selection.mapArtifactId) =>
    spawnTestProcess(
      [
        process.execPath,
        "tools/dps/rulesets/compile-retained-ddragon-auxiliary.ts",
        join(root, "source-set.json"),
        root,
        selection.runesArtifactId,
        selection.summonerArtifactId,
        mapArtifactId,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
  const success = run();
  expect(await success.exited).toBe(0);
  expect(JSON.parse(await success.stdout)).toEqual(
    await compileRetainedDataDragonAuxiliaryInventory(sourceSet, root, selection),
  );
  const missing = run("missing");
  expect(await missing.stdout).toBe("");
  expect(await missing.exited).toBe(1);
  await writeFile(join(root, "manual.txt"), "corrupt");
  const corrupt = run();
  expect(await corrupt.stdout).toBe("");
  expect(await corrupt.exited).toBe(1);
});
