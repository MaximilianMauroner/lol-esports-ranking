import { expect, test } from "vitest";
import { discoverDataDragonAbilitySlots } from "../../../src/domains/dps/rulesets/ddragon-ability-slots.ts";
import { hashRetainedSourceBytes } from "../../../src/domains/dps/rulesets/source-validation.ts";

const version = "16.18.1";
const index = () => ({
  type: "champion",
  version,
  data: {
    Yunara: { id: "Yunara", key: "804", name: "Yunara", version },
    Aatrox: { id: "Aatrox", key: "266", name: "Aatrox", version },
  },
});
function champion(slug: string, key: string) {
  return {
    id: slug,
    key,
    name: slug,
    passive: { name: `${slug} passive` },
    spells: ["Q", "W", "E", "R"].map((slot) => ({
      id: `${slug}${slot}`,
      name: `${slug} ${slot}`,
    })),
  };
}
const details = () => ({
  type: "champion",
  version,
  data: { Yunara: champion("Yunara", "804"), Aatrox: champion("Aatrox", "266") },
});
async function source(payload: unknown, filename: string) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return {
    bytes,
    artifact: {
      artifactId: `fixture-${filename}`,
      kind: "data-dragon",
      uri: `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/${filename}.json`,
      version,
      contentHash: await hashRetainedSourceBytes(bytes),
      retrievedAt: "2026-09-26T00:00:00Z",
    },
  };
}
async function discover(payload: unknown = details()) {
  const a = await source(index(), "champion");
  const b = await source(payload, "championFull");
  return discoverDataDragonAbilitySlots(a.artifact, a.bytes, b.artifact, b.bytes);
}

test("all primary slots retain stable numeric identities and exact source pointers", async () => {
  const result = await discover();
  expect(result.scope).toBe("data-dragon-primary-ability-slots-only");
  expect(result.entries.map(({ id }) => id)).toEqual(["266", "804"]);
  expect(result.entries[1]!.abilities.map(({ slot }) => slot)).toEqual([
    "passive",
    "Q",
    "W",
    "E",
    "R",
  ]);
  expect(result.entries[1]!.abilities[0]).toEqual({
    slot: "passive",
    sourceId: null,
    name: "Yunara passive",
    sourcePointer: "/data/Yunara/passive",
  });
  expect(result.entries[1]!.abilities[2]).toEqual({
    slot: "W",
    sourceId: "YunaraW",
    name: "Yunara W",
    sourcePointer: "/data/Yunara/spells/1",
  });
  expect(result.gaps).toEqual([]);
});

test("source ordering cannot change inventory, while byte hashes preserve provenance", async () => {
  const original = details();
  const reversed = {
    ...original,
    data: Object.fromEntries(Object.entries(original.data).reverse()),
  };
  const first = await discover(original);
  const second = await discover(reversed);
  expect(first.entries).toEqual(second.entries);
  expect(first.gaps).toEqual(second.gaps);
  expect(first.detailArtifact.contentHash).not.toBe(second.detailArtifact.contentHash);
});

test("empty names remain visible source gaps without dropping their slots", async () => {
  const payload = details();
  payload.data.Yunara.passive.name = " ";
  payload.data.Yunara.spells[1]!.name = "";
  const result = await discover(payload);
  expect(result.entries[1]!.abilities).toHaveLength(5);
  expect(result.gaps).toEqual([
    { id: "804", slot: "passive", reason: "empty-name" },
    { id: "804", slot: "W", reason: "empty-name" },
  ]);
});

test("missing/extra roster, identity drift and malformed slots fail closed", async () => {
  const mutations = [
    (value: ReturnType<typeof details>) => {
      delete (value.data as Record<string, unknown>).Aatrox;
    },
    (value: ReturnType<typeof details>) => {
      (value.data as Record<string, unknown>).Extra = champion("Extra", "1");
    },
    (value: ReturnType<typeof details>) => {
      value.data.Yunara.key = "266";
    },
    (value: ReturnType<typeof details>) => {
      value.data.Yunara.name = "Changed";
    },
    (value: ReturnType<typeof details>) => {
      value.data.Yunara.spells.pop();
    },
    (value: ReturnType<typeof details>) => {
      value.data.Yunara.spells[1]!.id = "YunaraQ";
    },
  ];
  for (const mutate of mutations) {
    const payload = details();
    mutate(payload);
    await expect(discover(payload)).rejects.toThrow();
  }
});

test("pinned provider, locale, version and retained hash guard detail discovery", async () => {
  const a = await source(index(), "champion");
  const b = await source(details(), "championFull");
  const changes = [
    { kind: "fixture" },
    { artifactId: a.artifact.artifactId },
    { uri: b.artifact.uri.replace("ddragon.leagueoflegends.com", "example.invalid") },
    { uri: b.artifact.uri.replace("en_US", "fr_FR") },
    { uri: b.artifact.uri.replace("championFull", "item") },
    { version: "16.17.1" },
  ];
  for (const update of changes) {
    await expect(
      discoverDataDragonAbilitySlots(a.artifact, a.bytes, { ...b.artifact, ...update }, b.bytes),
    ).rejects.toThrow();
  }
  const corrupt = Uint8Array.from(b.bytes);
  corrupt[0] = 0;
  await expect(
    discoverDataDragonAbilitySlots(a.artifact, a.bytes, b.artifact, corrupt),
  ).rejects.toThrow("artifact hash");
});

test("caller mutation during hashing cannot change parsed source evidence", async () => {
  const a = await source(index(), "champion");
  const b = await source(details(), "championFull");
  const pending = discoverDataDragonAbilitySlots(a.artifact, a.bytes, b.artifact, b.bytes);
  b.bytes.fill(0);
  b.artifact.version = "changed";
  const result = await pending;
  expect(result.detailArtifact.version).toBe(version);
  expect(result.entries).toHaveLength(2);
});
