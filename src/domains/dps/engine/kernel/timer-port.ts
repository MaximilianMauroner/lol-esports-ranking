import {
  ScheduledEventSchema,
  assertTimerPeekResult,
  type PortContext,
  type TimerPort,
  type TimerSchedule,
  type ScheduledEvent,
} from "../../contracts/index.ts";
import { EventQueue } from "./event-queue.ts";

/** One run's P01 timer service backed by the authoritative kernel queue. */
export class QueueTimerPort implements TimerPort {
  private readonly queue: EventQueue;
  private readonly runId: string;
  constructor(
    queue: EventQueue,
    runId: string,
  ) {
    this.queue = queue;
    this.runId = runId;
  }

  schedule(request: TimerSchedule, context: PortContext): void {
    this.assertContext(context);
    const event = ScheduledEventSchema.parse(request.event);
    if (event.sequence !== this.queue.nextEventSequence)
      throw new TypeError("timer event sequence must match the queue allocation frontier");
    if (
      event.timeMs < context.timeMs ||
      (event.timeMs === context.timeMs && event.sequence <= context.sequence)
    )
      throw new TypeError("scheduled timer must follow the current event frontier");
    if (context.causeEventIds.some((id) => !event.causeEventIds.includes(id)))
      throw new TypeError("scheduled timer must preserve causal event IDs");
    const draft = {
      eventId: event.eventId,
      timeMs: event.timeMs,
      phase: event.phase,
      kind: event.kind,
      payload: event.payload,
      causeEventIds: event.causeEventIds,
    };
    if (request.replacesEventId === null) this.queue.schedule(draft);
    else this.queue.replace(request.replacesEventId, draft);
  }

  cancel(eventId: string, context: PortContext): boolean {
    this.assertContext(context);
    return this.queue.cancel(eventId);
  }

  peek(context: PortContext): ScheduledEvent | null {
    this.assertContext(context);
    return assertTimerPeekResult(context, this.queue.peek());
  }

  private assertContext(context: PortContext): void {
    if (
      context.runId !== this.runId ||
      context.timeMs !== this.queue.currentTimeMs ||
      context.sequence !== this.queue.snapshot().currentTimeSequence ||
      context.nextEventSequence !== this.queue.nextEventSequence ||
      context.allocatedEventIds.length !== this.queue.allocatedEventIds().length ||
      new Set(context.allocatedEventIds).size !== context.allocatedEventIds.length ||
      context.allocatedEventIds.some((id) => !this.queue.allocatedEventIds().includes(id))
    )
      throw new TypeError("timer context does not match the kernel queue");
  }
}
