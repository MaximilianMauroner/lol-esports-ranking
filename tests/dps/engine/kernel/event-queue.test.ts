import { expect, test } from "vitest";
import { EventQueue, type EventDraft } from "../../../../src/domains/dps/engine/kernel/event-queue.ts";

const phases = [
  "input",
  "windup",
  "impact",
  "periodic",
  "expiry",
  "lifecycle",
  "checkpoint",
] as const;
const event = (
  eventId: string,
  timeMs: number,
  phase: EventDraft["phase"] = "impact",
  causeEventIds: string[] = [],
): EventDraft => ({
  eventId,
  timeMs,
  phase,
  kind: "test",
  payload: null,
  causeEventIds,
});

test("future damage cannot mutate current health before an earlier attack", () => {
  const queue = new EventQueue();
  let health = 100;
  queue.schedule(event("w-tick", 500));
  queue.schedule(event("attack", 200));
  expect(health).toBe(100);
  const dispatch = (entry: EventDraft) => {
    health -= entry.eventId === "attack" ? 10 : 20;
    return [];
  };
  expect(queue.step(1, null, dispatch).processed.map((entry) => entry.eventId)).toEqual(["attack"]);
  expect(health).toBe(90);
  expect(queue.step(1, null, dispatch).processed.map((entry) => entry.eventId)).toEqual(["w-tick"]);
  expect(health).toBe(70);
});

test("batch phase and ID ties are independent of input order", () => {
  const drafts = [event("z-impact", 10), event("b-input", 10, "input"), event("a-impact", 10)];
  const run = (values: EventDraft[]) => {
    const queue = new EventQueue();
    queue.scheduleBatch(values, phases);
    return queue
      .step(3, null, () => [])
      .processed.map(({ eventId, sequence }) => [eventId, sequence]);
  };
  expect(run(drafts)).toEqual(run([...drafts].reverse()));
  expect(run(drafts).map(([id]) => id)).toEqual(["b-input", "a-impact", "z-impact"]);
});

test("phase policy ranks every known phase exactly once before allocation", () => {
  const queue = new EventQueue();
  const drafts = [event("impact", 10), event("input", 10, "input")];
  const malformed = [
    "input",
    "windup",
    "impact",
    "periodic",
    "expiry",
    "lifecycle",
    "unrecognized",
  ] as unknown as readonly EventDraft["phase"][];
  expect(() => queue.scheduleBatch(drafts, malformed)).toThrow("rank all seven phases");
  expect(queue.snapshot().entries).toEqual([]);
  expect(queue.allocatedEventIds()).toEqual([]);

  const reversed = [...phases].reverse();
  expect(queue.scheduleBatch(drafts, reversed).map((entry) => entry.eventId)).toEqual([
    "impact",
    "input",
  ]);
});

test("cancel, same-time child, checkpoint, and resume preserve event order", () => {
  const run = (pause: boolean) => {
    let queue = new EventQueue();
    queue.schedule(event("root", 0, "input"));
    queue.schedule(event("cancelled", 10));
    const dispatch = (entry: EventDraft) =>
      entry.eventId === "root"
        ? [
            { kind: "cancel" as const, eventId: "cancelled" },
            { kind: "schedule" as const, event: event("child", 0, "impact", ["root"]) },
            { kind: "schedule" as const, event: event("projectile", 100, "impact", ["root"]) },
          ]
        : [];
    const first = queue.step(pause ? 1 : 3, null, dispatch).processed;
    if (pause)
      queue = new EventQueue(
        queue.currentTimeMs,
        100_000,
        JSON.parse(JSON.stringify(queue.snapshot())),
        queue.allocatedEventIds(),
      );
    const rest = pause ? queue.step(3, null, dispatch).processed : [];
    return [...first, ...rest].map((entry) => entry.eventId);
  };
  expect(run(true)).toEqual(["root", "child", "projectile"]);
  expect(run(true)).toEqual(run(false));
});

test("step reports only cancellations that removed pending events", () => {
  const queue = new EventQueue();
  queue.schedule(event("root", 0));
  queue.schedule(event("pending", 10));
  const step = queue.step(1, null, () => [
    { kind: "cancel", eventId: "root" },
    { kind: "cancel", eventId: "missing" },
    { kind: "cancel", eventId: "pending" },
    { kind: "cancel", eventId: "pending" },
  ]);
  expect(step.cancelledEventIds).toEqual(["pending"]);
  expect(step.processed.map((entry) => entry.eventId)).toEqual(["root"]);
  expect(queue.snapshot().entries).toEqual([]);
  const restored = new EventQueue(
    queue.currentTimeMs,
    100_000,
    queue.snapshot(),
    queue.allocatedEventIds(),
  );
  expect(restored.allocatedEventIds()).toEqual(["root", "pending"]);
});

test("pending causes cannot be cancelled or replaced while descendants remain", () => {
  const queue = new EventQueue();
  queue.schedule(event("parent", 10));
  queue.schedule(event("child", 20, "impact", ["parent"]));
  const before = queue.snapshot();
  expect(() => queue.cancel("parent")).toThrow("descendant remains queued");
  expect(() => queue.replace("parent", event("replacement", 10))).toThrow(
    "descendant remains queued",
  );
  expect(queue.snapshot()).toEqual(before);
  expect(queue.allocatedEventIds()).toEqual(["parent", "child"]);
  expect(queue.cancel("child")).toBe(true);
  expect(queue.cancel("parent")).toBe(true);
});

test("one dispatch cancels a pending causal group regardless of command order", () => {
  const run = (reverse: boolean) => {
    const queue = new EventQueue();
    queue.schedule(event("root", 0, "input"));
    queue.schedule(event("parent", 10, "impact", ["root"]));
    queue.schedule(event("child", 20, "impact", ["parent", "root"]));
    const commands = [
      { kind: "cancel" as const, eventId: "parent" },
      { kind: "cancel" as const, eventId: "child" },
    ];
    const result = queue.step(1, null, () => (reverse ? [...commands].reverse() : commands));
    const restored = new EventQueue(
      queue.currentTimeMs,
      100_000,
      queue.snapshot(),
      queue.allocatedEventIds(),
    );
    return { cancelled: result.cancelledEventIds, snapshot: restored.snapshot() };
  };
  expect(run(false)).toEqual(run(true));
  expect(run(false).cancelled).toEqual(["parent", "child"]);
});

test("failed partial causal cancellation and new child of cancelled cause leave queue unchanged", () => {
  const queue = new EventQueue();
  queue.schedule(event("root", 0, "input"));
  queue.schedule(event("parent", 10, "impact", ["root"]));
  queue.schedule(event("child", 20, "impact", ["parent"]));
  const before = queue.snapshot();
  expect(() => queue.step(1, null, () => [{ kind: "cancel", eventId: "parent" }])).toThrow(
    "descendant remains queued",
  );
  expect(queue.snapshot()).toEqual(before);
  expect(() =>
    queue.step(1, null, () => [
      { kind: "cancel", eventId: "child" },
      { kind: "cancel", eventId: "parent" },
      { kind: "schedule", event: event("replacement-child", 30, "impact", ["root", "parent"]) },
    ]),
  ).toThrow("cite a cancelled event");
  expect(queue.snapshot()).toEqual(before);
  expect(queue.allocatedEventIds()).toEqual(["root", "parent", "child"]);
});

test("self-trigger loop reaches a typed limit rather than a completed score", () => {
  const queue = new EventQueue(0, 3);
  queue.schedule(event("root", 0));
  const result = queue.step(10, null, (entry) => [
    { kind: "schedule", event: event(`child-${entry.sequence}`, 0, "impact", [entry.eventId]) },
  ]);
  expect(result.status).toBe("event-limit");
  expect(result.processed).toHaveLength(3);
  expect(queue.peek()).not.toBeNull();
});

test("rejects duplicate identity and scheduling into the past", () => {
  const queue = new EventQueue();
  queue.schedule(event("first", 10));
  queue.step(1, null, () => []);
  expect(() => queue.schedule(event("first", 11))).toThrow("already allocated");
  expect(() => queue.schedule(event("past", 9))).toThrow("past");
});

test("invalid batch is atomic and work limit stays stable across resume", () => {
  const queue = new EventQueue(0, 2);
  expect(() => queue.scheduleBatch([event("valid", 0), event("invalid", -1)], phases)).toThrow();
  expect(queue.peek()).toBeNull();
  queue.schedule(event("root", 0));
  queue.schedule(event("cancelled", 1));
  queue.cancel("cancelled");
  queue.schedule(event("later", 2));
  const first = queue.step(1, null, () => []);
  const restored = new EventQueue(
    queue.currentTimeMs,
    2,
    queue.snapshot(),
    queue.allocatedEventIds(),
  );
  expect(first.processed.map((entry) => entry.eventId)).toEqual(["root"]);
  expect(restored.step(1, null, () => []).status).toBe("event-limit");
  expect(queue.step(1, null, () => []).status).toBe("event-limit");
  expect(restored.snapshot()).toEqual(queue.snapshot());
});

test("restored allocation ledger prevents reuse of processed and cancelled IDs", () => {
  const queue = new EventQueue();
  queue.schedule(event("processed", 0));
  queue.schedule(event("cancelled", 1));
  queue.cancel("cancelled");
  queue.step(1, null, () => []);
  expect(() => new EventQueue(queue.currentTimeMs, 100_000, queue.snapshot())).toThrow("ledger");
  const restored = new EventQueue(
    queue.currentTimeMs,
    100_000,
    queue.snapshot(),
    queue.allocatedEventIds(),
  );
  expect(() => restored.schedule(event("processed", 2))).toThrow("already allocated");
  expect(() => restored.schedule(event("cancelled", 2))).toThrow("already allocated");
});

test("batch rejects descendants sorted before their causes without partial allocation", () => {
  const queue = new EventQueue();
  expect(() =>
    queue.scheduleBatch(
      [event("a-child", 0, "impact", ["z-parent"]), event("z-parent", 0)],
      phases,
    ),
  ).toThrow("cause must precede");
  expect(queue.peek()).toBeNull();
  expect(queue.allocatedEventIds()).toEqual([]);
});

test("queue rejects unknown and future pending causes before allocating a descendant", () => {
  const queue = new EventQueue();
  expect(() => queue.schedule(event("orphan", 10, "impact", ["missing"]))).toThrow(
    "cause must already be allocated",
  );
  expect(() =>
    queue.scheduleBatch(
      [event("root", 0, "input"), event("orphan", 10, "impact", ["missing"])],
      phases,
    ),
  ).toThrow("cause must already be allocated");
  expect(queue.snapshot().entries).toEqual([]);
  expect(queue.allocatedEventIds()).toEqual([]);

  queue.schedule(event("parent", 100));
  const before = queue.snapshot();
  expect(() => queue.schedule(event("early-child", 50, "impact", ["parent"]))).toThrow(
    "cannot follow its descendant",
  );
  expect(queue.snapshot()).toEqual(before);
  expect(queue.allocatedEventIds()).toEqual(["parent"]);

  queue.schedule(event("child", 150, "impact", ["parent"]));
  const restored = new EventQueue(0, 100_000, queue.snapshot(), queue.allocatedEventIds());
  expect(restored.step(2, null, () => []).processed.map((entry) => entry.eventId)).toEqual([
    "parent",
    "child",
  ]);
});

test("separate same-time scheduling is rejected; canonical batch is required", () => {
  const queue = new EventQueue();
  queue.schedule(event("z", 0));
  expect(() => queue.schedule(event("a", 0))).toThrow("canonical batch");
});
