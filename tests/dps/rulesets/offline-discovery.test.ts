import { spawnTestProcess } from "../process.ts";
import { expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRetainedIndices } from "../../../tools/dps/rulesets/discover-retained.ts";
import { buildPinnedSourceSet } from "../../../src/domains/dps/rulesets/source-validation.ts";

async function withFixture(
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
) {
  const fixture = await createFixture();
  try {
    await run(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "dps-discovery-"));
  const payloads = {
    champion: {
      type: "champion",
      version: "16.18.1",
      data: { Example: { version: "16.18.1", id: "Example", key: "1", name: "Example" } },
    },
    item: {
      type: "item",
      version: "16.18.1",
      data: { "2008": { name: "", gold: { total: 0, purchasable: false }, maps: { "11": false } } },
    },
    auxiliary: { intentionally: "not a supported index" },
  };
  const retained = Object.entries(payloads).map(([artifactId, value]) => ({
    artifactId,
    bytes: new TextEncoder().encode(JSON.stringify(value)),
  }));
  const manifest = await buildPinnedSourceSet(
    {
      schemaVersion: 1,
      sourceSetId: "discovery-fixture",
      patch: "26.18",
      hotfixRevision: "fixture-only",
      dataDragonVersion: "16.18.1",
      communityDragonRevision: "26.18",
      regionApplicability: ["EUW1"],
      requiredArtifactIds: retained.map((entry) => entry.artifactId),
      sourceArtifacts: retained.map(({ artifactId }) => ({
        retainedPath: `${artifactId}.json`,
        artifact: {
          artifactId,
          kind: "data-dragon" as const,
          uri: `https://ddragon.leagueoflegends.com/cdn/16.18.1/data/en_US/${artifactId}.json`,
          version: "16.18.1",
          retrievedAt: "2026-09-26T00:00:00Z",
        },
      })),
    },
    retained,
  );
  for (const entry of retained)
    await writeFile(join(root, `${entry.artifactId}.json`), entry.bytes);
  await writeFile(join(root, "source-set.json"), JSON.stringify(manifest));
  return {
    root,
    manifest,
    totalBytes: retained.reduce((sum, entry) => sum + entry.bytes.length, 0),
  };
}

test("offline discovery preserves gaps, explicit omissions and source identity deterministically", async () => {
  await withFixture(async ({ root, manifest, totalBytes }) => {
    const first = await discoverRetainedIndices(manifest, root, ["item", "champion"]);
    expect(first).toEqual(await discoverRetainedIndices(manifest, root, ["champion", "item"]));
    expect(first.scope).toBe("source-discovery-only");
    expect(first.sourceSetHash).toBe(manifest.sourceSetHash);
    expect(first.verifiedArtifactCount).toBe(3);
    expect(first.totalBytes).toBe(totalBytes);
    expect(first.undiscoveredArtifactIds).toEqual(["auxiliary"]);
    expect(first.indices[1]!.entries.map((entry) => entry.id)).toEqual(["2008"]);
    expect(first.indices[1]!.gaps).toEqual([{ id: "2008", reason: "empty-name" }]);
  });
});

test("selection rejects empty, duplicate, unknown and unsupported artifact IDs", async () => {
  await withFixture(async ({ root, manifest }) => {
    for (const ids of [[], ["item", "item"], ["missing"], ["auxiliary"]]) {
      await expect(discoverRetainedIndices(manifest, root, ids)).rejects.toThrow();
    }
  });
});

test("unselected corrupt sources and byte limits still block discovery", async () => {
  await withFixture(async ({ root, manifest }) => {
    await expect(
      discoverRetainedIndices(manifest, root, ["item"], {
        maxArtifactBytes: 1,
        maxTotalBytes: 1000,
      }),
    ).rejects.toThrow("byte limit");
    await writeFile(join(root, "auxiliary.json"), "corrupt");
    await expect(discoverRetainedIndices(manifest, root, ["item"])).rejects.toThrow();
  });
});

test("CLI emits only a complete canonical report or an error exit with empty stdout", async () => {
  await withFixture(async ({ root, manifest }) => {
    const invoke = (ids: string[]) =>
      spawnTestProcess(
        [
          process.execPath,
          "tools/dps/rulesets/discover-retained.ts",
          join(root, "source-set.json"),
          root,
          ...ids,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
    const success = invoke(["item"]);
    const output = await success.stdout;
    expect(await success.exited).toBe(0);
    expect(JSON.parse(output)).toEqual(await discoverRetainedIndices(manifest, root, ["item"]));
    const invalid = invoke(["item", "missing"]);
    expect(await invalid.stdout).toBe("");
    expect(await invalid.exited).toBe(1);
    const usage = invoke([]);
    expect(await usage.stdout).toBe("");
    expect(await usage.exited).toBe(2);
  });
});
