import { expect, test } from "vitest";
import { ValidationRecordSchema, assertObservationForPatch } from "../../../tools/dps/validation/records.ts";

const hash = `sha256:${"a".repeat(64)}`;
const observed = {
  fixtureId: "fixture-001",
  mechanicId: "basic-attack",
  expectedTracePath: "trace.json",
  discrepancy: "none",
  evidenceKind: "observed",
  observationId: "observation-001",
  source: {
    sourceId: "capture-001",
    contentHash: hash,
    locator: "capture/frame-001",
    category: "client-capture",
  },
  protocol: {
    patch: "26.18",
    clientVersion: "26.18.1",
    hotfixId: "cutoff-001",
    modeId: "summoners-rift",
    championId: "yunara",
    itemIds: [],
    initialState: { health: 1000 },
    actionTimelineMs: [0, 100],
    targetStats: { armor: 50 },
    repetitions: 3,
  },
  observedPatch: "26.18",
  reviewerId: "reviewer-001",
  mechanicAuthorId: "author-001",
  disputed: false,
} as const;

test("synthetic contract fixtures cannot be relabeled observed", () => {
  expect(
    ValidationRecordSchema.safeParse({
      fixtureId: "f",
      mechanicId: "m",
      expectedTracePath: "t",
      discrepancy: "none",
      evidenceKind: "synthetic",
      purpose: "algorithm test",
    }).success,
  ).toBe(true);
  expect(
    ValidationRecordSchema.safeParse({
      fixtureId: "f",
      mechanicId: "m",
      expectedTracePath: "t",
      discrepancy: "none",
      evidenceKind: "observed",
      purpose: "algorithm test",
    }).success,
  ).toBe(false);
});

test("observation requires source identity, matched client and independent disputed review", () => {
  const record = ValidationRecordSchema.parse(observed);
  expect(() => assertObservationForPatch(record, "26.18", "26.18.1", "cutoff-001")).not.toThrow();
  expect(() => assertObservationForPatch(record, "26.18", "26.19.1", "cutoff-001")).toThrow(
    "does not match",
  );
  expect(
    ValidationRecordSchema.safeParse({
      ...observed,
      source: { ...observed.source, contentHash: null },
    }).success,
  ).toBe(false);
  expect(
    ValidationRecordSchema.safeParse({
      ...observed,
      source: { ...observed.source, category: "riot-artifact" },
    }).success,
  ).toBe(false);
  expect(ValidationRecordSchema.safeParse({ ...observed, observedPatch: "26.19" }).success).toBe(
    false,
  );
  expect(
    ValidationRecordSchema.safeParse({ ...observed, disputed: true, reviewerId: "author-001" })
      .success,
  ).toBe(false);
  expect(
    ValidationRecordSchema.safeParse({
      ...observed,
      protocol: { ...observed.protocol, actionTimelineMs: [] },
    }).success,
  ).toBe(false);
  expect(
    ValidationRecordSchema.safeParse({
      ...observed,
      protocol: { ...observed.protocol, actionTimelineMs: [100, 0] },
    }).success,
  ).toBe(false);
});

test("legacy behavior remains labeled and cannot validate the ruleset", () => {
  const record = ValidationRecordSchema.parse({
    fixtureId: "legacy-001",
    mechanicId: "w-chronology",
    expectedTracePath: "legacy.json",
    discrepancy: "implementation",
    evidenceKind: "legacy",
    baselineCommit: "f2747db43ca89d12338982b0e7ed2f700ee2b591",
    knownLimit: "future W tick can mutate health early",
  });
  expect(() => assertObservationForPatch(record, "26.18", "26.18.1", "cutoff-001")).toThrow(
    "Only observed",
  );
});
