import { expect, test } from "vitest";
import { discoverDataDragonIndex } from "../../../src/domains/dps/rulesets/ddragon-discovery.ts";
import { hashRetainedSourceBytes } from "../../../src/domains/dps/rulesets/source-validation.ts";

const item = (name: string, purchasable = true) => ({
  name,
  gold: { total: 300, purchasable },
  maps: { "11": false, "30": true },
});
const items = () => ({
  type: "item",
  version: "16.18.1",
  data: {
    "2008": item("", false),
    "1001": item("Boots"),
    "772139": { ...item(""), maps: { "11": false, "30": false } },
  },
});
const champions = () => ({
  type: "champion",
  version: "16.18.1",
  data: {
    Aatrox: { version: "16.18.1", id: "Aatrox", key: "266", name: "Aatrox" },
    Yunara: { version: "16.18.1", id: "Yunara", key: "804", name: "Yunara" },
  },
});

async function source(payload: unknown, kind = "item") {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return {
    bytes,
    artifact: {
      artifactId: `fixture-${kind}-index`,
      kind: "data-dragon",
      uri: `https://ddragon.leagueoflegends.com/cdn/16.18.1/data/en_US/${kind}.json`,
      version: "16.18.1",
      contentHash: await hashRetainedSourceBytes(bytes),
      retrievedAt: "2026-09-26T00:00:00Z",
    },
  };
}

test("discovery retains unnamed, nonpurchasable and no-map item IDs with explicit source gaps", async () => {
  const { artifact, bytes } = await source(items());
  const result = await discoverDataDragonIndex(artifact, bytes);
  expect(result.scope).toBe("source-discovery-only");
  expect(result.kind).toBe("item-index");
  expect(result.artifact.contentHash).toBe(artifact.contentHash);
  expect(result.entries.map((entry) => entry.id)).toEqual(["1001", "2008", "772139"]);
  expect(result.gaps).toEqual([
    { id: "2008", reason: "empty-name" },
    { id: "772139", reason: "empty-name" },
  ]);
  if (result.kind === "item-index") {
    expect(result.entries[1]!.purchasable).toBe(false);
    expect(result.entries[2]!.maps).toEqual({ "11": false, "30": false });
    expect(result.entries[2]!.sourcePointer).toBe("/data/772139");
  }
});

test("entry ordering is deterministic while source byte identity remains distinct", async () => {
  const original = champions();
  const left = await source(original, "champion");
  const right = await source(
    {
      ...original,
      data: Object.fromEntries(Object.entries(original.data).reverse()),
    },
    "champion",
  );
  const a = await discoverDataDragonIndex(left.artifact, left.bytes);
  const b = await discoverDataDragonIndex(right.artifact, right.bytes);
  expect(a.entries).toEqual(b.entries);
  expect(a.gaps).toEqual(b.gaps);
  expect(a.artifact.contentHash).not.toBe(b.artifact.contentHash);
});

test("champion discovery preserves numeric ID/slug pairs and rejects collisions or source drift", async () => {
  const good = await source(champions(), "champion");
  const result = await discoverDataDragonIndex(good.artifact, good.bytes);
  expect(result.kind).toBe("champion-index");
  expect(result.entries).toEqual([
    { id: "266", slug: "Aatrox", name: "Aatrox", sourcePointer: "/data/Aatrox" },
    { id: "804", slug: "Yunara", name: "Yunara", sourcePointer: "/data/Yunara" },
  ]);
  for (const update of [{ key: "266" }, { id: "Wrong" }, { version: "16.17.1" }]) {
    const payload = champions();
    Object.assign(payload.data.Yunara, update);
    const invalid = await source(payload, "champion");
    await expect(discoverDataDragonIndex(invalid.artifact, invalid.bytes)).rejects.toThrow();
  }
});

test("discovery verifies source bytes and pinned provider/index identity before parsing", async () => {
  const { artifact, bytes } = await source(items());
  const corrupt = Uint8Array.from(bytes);
  corrupt[0] = 0;
  await expect(discoverDataDragonIndex(artifact, corrupt)).rejects.toThrow("artifact hash");
  for (const update of [
    { kind: "fixture" },
    { uri: artifact.uri.replace("ddragon.leagueoflegends.com", "example.invalid") },
    { uri: artifact.uri.replace("16.18.1", "latest") },
    { uri: artifact.uri.replace("item.json", "champion/Yunara.json") },
    { version: "16.17.1" },
  ])
    await expect(discoverDataDragonIndex({ ...artifact, ...update }, bytes)).rejects.toThrow();
});

test("wrong type/version, empty indices and malformed entries fail without partial inventory", async () => {
  for (const payload of [
    { ...items(), type: "champion" },
    { ...items(), version: "16.17.1" },
    { ...items(), data: {} },
    { ...items(), data: { "1001": { name: "missing source fields" } } },
    { ...items(), data: { "01001": item("noncanonical ID") } },
  ]) {
    const invalid = await source(payload);
    await expect(discoverDataDragonIndex(invalid.artifact, invalid.bytes)).rejects.toThrow();
  }
});

test("caller mutation during async hashing cannot change the decoded evidence", async () => {
  const { artifact, bytes } = await source(items());
  const expectedHash = artifact.contentHash;
  const pending = discoverDataDragonIndex(artifact, bytes);
  bytes.fill(0);
  artifact.version = "changed";
  const result = await pending;
  expect(result.artifact.version).toBe("16.18.1");
  expect(result.artifact.contentHash).toBe(expectedHash);
  expect(result.entries).toHaveLength(3);
});
