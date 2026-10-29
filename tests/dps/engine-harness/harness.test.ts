import { expect, test } from "vitest";
import { sampleTrace } from "../contracts/fixtures.ts";
import { assertMechanicTrace, TraceExpectationsSchema } from "../../../tools/dps/validation/harness.ts";

const damage = (expected: number) => ({
  eventId: "event-002",
  effectIndex: 0,
  kind: "damage" as const,
  expected,
  absoluteTolerance: 0,
});

test("contract trace passes exact numeric, order, and proc assertions", () => {
  expect(
    assertMechanicTrace(sampleTrace, {
      eventOrder: ["event-001", "event-002"],
      numeric: [damage(100)],
      effectCounts: [{ eventId: "event-002", kind: "damage", expected: 1 }],
    }),
  ).toEqual(sampleTrace);
});

test("wrong modifier, reversed order, and extra proc each fail", () => {
  expect(() => assertMechanicTrace(sampleTrace, { numeric: [damage(99)] })).toThrow(
    "damage in event-002",
  );
  expect(() =>
    assertMechanicTrace(sampleTrace, { eventOrder: ["event-002", "event-001"] }),
  ).toThrow("Event order violation");
  expect(() =>
    assertMechanicTrace(sampleTrace, {
      effectCounts: [{ eventId: "event-002", kind: "damage", expected: 2 }],
    }),
  ).toThrow("Effect count");
});

test("direct harness calls reject empty, missing, and invalid assertions", () => {
  expect(() => assertMechanicTrace(sampleTrace, {})).toThrow();
  expect(() => assertMechanicTrace(sampleTrace, { eventOrder: ["missing", "event-002"] })).toThrow(
    "Missing expected event",
  );
  expect(() =>
    assertMechanicTrace(sampleTrace, {
      numeric: [{ ...damage(99), absoluteTolerance: Number.NaN }],
    }),
  ).toThrow();
  expect(TraceExpectationsSchema.safeParse({ numeric: [damage(100)], typo: true }).success).toBe(
    false,
  );
});

test("packet assertions detect offsetting multi-hit modifier errors", () => {
  const trace = structuredClone(sampleTrace);
  const packet = trace.events[1]!.effects[0]!;
  if (packet.kind !== "damage") throw new Error("fixture requires a damage packet");
  trace.events[1]!.effects = [
    { ...packet, amount: 40 },
    { ...packet, amount: 60 },
  ];
  expect(() =>
    assertMechanicTrace(trace, { numeric: [{ ...damage(50), effectIndex: 0 }] }),
  ).toThrow("damage in event-002");
});

test("proc assertions are scoped to one event and reject truncated aggregates", () => {
  expect(() =>
    assertMechanicTrace(sampleTrace, {
      effectCounts: [{ eventId: "event-001", kind: "damage", expected: 1 }],
    }),
  ).toThrow("Effect count");
  const trace = { ...sampleTrace, truncated: true, truncationReason: "limit" };
  expect(() => assertMechanicTrace(trace, { numeric: [damage(100)] })).toThrow("complete trace");
});

test("heal, shield, and resource amounts can be checked", () => {
  for (const effect of [
    { kind: "heal" as const, sourceEntityId: "actor", targetEntityId: "actor", amount: 10 },
    { kind: "shield" as const, sourceEntityId: "actor", targetEntityId: "actor", amount: 20 },
    {
      kind: "resource" as const,
      sourceEntityId: "actor",
      targetEntityId: "actor",
      resourceId: "mana",
      delta: -5,
    },
  ]) {
    const trace = structuredClone(sampleTrace);
    trace.events[1]!.effects = [effect];
    const expected = effect.kind === "resource" ? -5 : effect.amount;
    expect(
      assertMechanicTrace(trace, {
        numeric: [
          {
            eventId: "event-002",
            effectIndex: 0,
            kind: effect.kind,
            expected,
            absoluteTolerance: 0,
          },
        ],
      }),
    ).toEqual(trace);
  }
});
