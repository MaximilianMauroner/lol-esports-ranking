import { spawnTestProcess } from "../process.ts";
import { expect, test } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPinnedSourceSet } from "../../../src/domains/dps/rulesets/source-validation.ts";
import {
  verifyRetainedManifest,
  verifyRetainedSourceFiles,
} from "../../../tools/dps/rulesets/verify-retained.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dps-retained-"));
  const bytes = new TextEncoder().encode('{"fixture":true}');
  const sourceSet = await buildPinnedSourceSet(
    {
      schemaVersion: 1,
      sourceSetId: "offline-fixture",
      patch: "26.18",
      hotfixRevision: "fixture-only",
      dataDragonVersion: "16.18.1",
      communityDragonRevision: "26.18",
      regionApplicability: ["EUW1"],
      requiredArtifactIds: ["first", "second"],
      sourceArtifacts: ["first", "second"].map((artifactId) => ({
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
    ["first", "second"].map((artifactId) => ({ artifactId, bytes })),
  );
  await Promise.all(["first", "second"].map((id) => writeFile(join(root, `${id}.json`), bytes)));
  await writeFile(join(root, "source-set.json"), JSON.stringify(sourceSet));
  return { root, bytes, sourceSet };
}

async function withFixture(run: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const value = await fixture();
  try {
    await run(value);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
}

test("offline files verify the exact declared source identity and CLI emits no artifact contents", async () => {
  await withFixture(async ({ root, sourceSet, bytes }) => {
    const verified = await verifyRetainedManifest(join(root, "source-set.json"), root);
    expect(verified.sourceSet.sourceSetHash).toBe(sourceSet.sourceSetHash);
    expect(verified.totalBytes).toBe(bytes.length * 2);
    expect(Object.isFrozen(verified.sourceSet)).toBe(true);
    const child = spawnTestProcess(
      [
        process.execPath,
        "tools/dps/rulesets/verify-retained.ts",
        join(root, "source-set.json"),
        root,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await child.stdout;
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output)).toEqual({
      sourceSetId: sourceSet.sourceSetId,
      sourceSetHash: sourceSet.sourceSetHash,
      verifiedArtifactCount: 2,
      totalBytes: bytes.length * 2,
      scope: "retained-bytes-only",
    });
    expect(output).not.toContain('"fixture":true');
  });
});

test("missing and changed artifact bytes fail before a verified source set can be returned", async () => {
  await withFixture(async ({ root, sourceSet }) => {
    await writeFile(join(root, "first.json"), "corrupt");
    await expect(verifyRetainedSourceFiles(sourceSet, root)).rejects.toThrow();
    await rm(join(root, "first.json"));
    await expect(verifyRetainedSourceFiles(sourceSet, root)).rejects.toThrow("ENOENT");
    const child = spawnTestProcess(
      [
        process.execPath,
        "tools/dps/rulesets/verify-retained.ts",
        join(root, "source-set.json"),
        root,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.stdout).toBe("");
    expect(await child.exited).toBe(1);
  });
});

test("source roots reject escaping symlinks, traversal metadata and non-file artifacts", async () => {
  await withFixture(async ({ root, sourceSet }) => {
    const outside = await mkdtemp(join(tmpdir(), "dps-outside-"));
    try {
      await writeFile(join(outside, "outside.json"), "private-outside-value");
      await rm(join(root, "first.json"));
      await symlink(join(outside, "outside.json"), join(root, "first.json"));
      await expect(verifyRetainedSourceFiles(sourceSet, root)).rejects.toThrow("outside its root");
      const invalid = structuredClone(sourceSet);
      invalid.sourceArtifacts[0]!.retainedPath = "../outside.json";
      await expect(verifyRetainedSourceFiles(invalid, root)).rejects.toThrow(
        "canonical relative POSIX paths",
      );
      await rm(join(root, "first.json"));
      await mkdir(join(root, "first.json"));
      await expect(verifyRetainedSourceFiles(sourceSet, root)).rejects.toThrow("regular files");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("artifact and total byte limits accept exact boundaries and reject overages", async () => {
  await withFixture(async ({ root, sourceSet, bytes }) => {
    const exact = { maxArtifactBytes: bytes.length, maxTotalBytes: bytes.length * 2 };
    expect((await verifyRetainedSourceFiles(sourceSet, root, exact)).totalBytes).toBe(
      bytes.length * 2,
    );
    await expect(
      verifyRetainedSourceFiles(sourceSet, root, { ...exact, maxArtifactBytes: bytes.length - 1 }),
    ).rejects.toThrow("byte limit");
    await expect(
      verifyRetainedSourceFiles(sourceSet, root, { ...exact, maxTotalBytes: bytes.length * 2 - 1 }),
    ).rejects.toThrow("byte limit");
    await expect(
      verifyRetainedSourceFiles(sourceSet, root, { ...exact, maxTotalBytes: Number.NaN }),
    ).rejects.toThrow("positive safe integers");
  });
});

test("manifest parsing is bounded and malformed manifests cannot reach verification", async () => {
  await withFixture(async ({ root }) => {
    const path = join(root, "source-set.json");
    await writeFile(path, "not json");
    await expect(verifyRetainedManifest(path, root)).rejects.toThrow();
    await writeFile(path, " ".repeat(1024 * 1024 + 1));
    await expect(verifyRetainedManifest(path, root)).rejects.toThrow("byte limit");
  });
});
