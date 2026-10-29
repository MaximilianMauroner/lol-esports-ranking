import { expect, test } from "vitest";
import type { PortContext, ScheduledEvent } from "../../../../src/domains/dps/contracts/index.ts";
import { EventQueue } from "../../../../src/domains/dps/engine/kernel/event-queue.ts";
import { QueueTimerPort } from "../../../../src/domains/dps/engine/kernel/timer-port.ts";

const event = (
  eventId: string,
  timeMs: number,
  sequence: number,
  causes: string[] = [],
): ScheduledEvent => ({
  eventId,
  timeMs,
  sequence,
  phase: "impact",
  kind: "test",
  payload: null,
  causeEventIds: causes,
});
const context = (queue: EventQueue): PortContext => ({
  runId: "run-1",
  timeMs: queue.currentTimeMs,
  sequence: queue.snapshot().currentTimeSequence,
  causeEventIds: [],
  nextEventSequence: queue.nextEventSequence,
  allocatedEventIds: queue.allocatedEventIds(),
});

test("P01 timer port schedules, peeks, cancels, and replaces through one queue", () => {
  const queue = new EventQueue();
  const timers = new QueueTimerPort(queue, "run-1");
  timers.schedule({ event: event("first", 100, 1), replacesEventId: null }, context(queue));
  expect(timers.peek(context(queue))?.eventId).toBe("first");
  expect(() =>
    timers.schedule({ event: event("wrong", 20, 7), replacesEventId: null }, context(queue)),
  ).toThrow("sequence");
  timers.schedule(
    { event: event("replacement", 100, 2), replacesEventId: "first" },
    context(queue),
  );
  expect(timers.peek(context(queue))?.eventId).toBe("replacement");
  expect(timers.cancel("replacement", context(queue))).toBe(true);
  expect(timers.peek(context(queue))).toBeNull();
  expect(queue.allocatedEventIds()).toEqual(["first", "replacement"]);
});

test("replacement rejection leaves original timer and ledger unchanged", () => {
  const queue = new EventQueue();
  const timers = new QueueTimerPort(queue, "run-1");
  timers.schedule({ event: event("first", 100, 1), replacesEventId: null }, context(queue));
  timers.schedule({ event: event("other", 200, 2), replacesEventId: null }, context(queue));
  expect(() =>
    timers.schedule({ event: event("bad", 200, 3), replacesEventId: "first" }, context(queue)),
  ).toThrow("canonical batch");
  expect(timers.peek(context(queue))?.eventId).toBe("first");
  expect(queue.allocatedEventIds()).toEqual(["first", "other"]);
});

test("timer port rejects stale run, ledger, and causal context", () => {
  const queue = new EventQueue();
  const timers = new QueueTimerPort(queue, "run-1");
  expect(() => timers.peek({ ...context(queue), runId: "other" })).toThrow("context");
  expect(() => timers.peek({ ...context(queue), nextEventSequence: 2 })).toThrow("context");
  expect(() =>
    timers.schedule(
      { event: event("first", 100, 1), replacesEventId: null },
      { ...context(queue), causeEventIds: ["parent"] },
    ),
  ).toThrow("causal");
  expect(queue.peek()).toBeNull();
});

test("timer cancellation cannot orphan a pending descendant", () => {
  const queue = new EventQueue();
  const timers = new QueueTimerPort(queue, "run-1");
  timers.schedule({ event: event("parent", 100, 1), replacesEventId: null }, context(queue));
  timers.schedule(
    { event: event("child", 200, 2, ["parent"]), replacesEventId: null },
    context(queue),
  );
  const before = queue.snapshot();
  expect(() => timers.cancel("parent", context(queue))).toThrow("descendant remains queued");
  expect(queue.snapshot()).toEqual(before);
  expect(timers.cancel("child", context(queue))).toBe(true);
  expect(timers.cancel("parent", context(queue))).toBe(true);
});
