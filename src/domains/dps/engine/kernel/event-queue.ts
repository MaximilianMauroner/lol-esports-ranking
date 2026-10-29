import {
  EventQueueSnapshotSchema,
  ScheduledEventSchema,
  type ScheduledEvent,
} from "../../contracts/index.ts";

export type EventDraft = Omit<ScheduledEvent, "sequence">;
export type QueueCommand =
  { kind: "schedule"; event: EventDraft } | { kind: "cancel"; eventId: string };
export type QueueStep = Readonly<{
  status: "progress" | "empty" | "event-limit";
  processed: readonly ScheduledEvent[];
  cancelledEventIds: readonly string[];
  currentTimeMs: number;
}>;

export const DEFAULT_PHASE_ORDER: readonly ScheduledEvent["phase"][] = [
  "input",
  "windup",
  "impact",
  "periodic",
  "expiry",
  "lifecycle",
  "checkpoint",
];

/** P04 queue primitive. One integer time unit is one millisecond. */
export class EventQueue {
  private entries: ScheduledEvent[];
  private clockMs: number;
  private lastProcessedSequence: number;
  private currentTimeSequence: number;
  private nextSequence: number;
  private readonly allocatedIds: Set<string>;

  private readonly eventLimit: number;
  constructor(
    currentTimeMs = 0,
    eventLimit = 100_000,
    snapshot?: unknown,
    allocatedEventIds?: readonly string[],
  ) {
    this.eventLimit = eventLimit;
    if (!Number.isSafeInteger(currentTimeMs) || currentTimeMs < 0)
      throw new RangeError("current time must be a nonnegative integer millisecond");
    if (!Number.isSafeInteger(eventLimit) || eventLimit < 1)
      throw new RangeError("event limit must be a positive integer");
    const parsed = snapshot === undefined ? null : EventQueueSnapshotSchema.parse(snapshot);
    this.clockMs = currentTimeMs;
    this.entries = parsed ? structuredClone(parsed.entries) : [];
    this.lastProcessedSequence = parsed?.lastProcessedSequence ?? 0;
    this.currentTimeSequence = parsed?.currentTimeSequence ?? 0;
    this.nextSequence = parsed?.nextSequence ?? 1;
    if (parsed && allocatedEventIds === undefined)
      throw new TypeError("restoring a queue requires the complete allocated event ID ledger");
    if (!parsed && allocatedEventIds !== undefined)
      throw new TypeError("a fresh queue cannot accept a restored event ID ledger");
    this.allocatedIds = new Set(allocatedEventIds ?? []);
    if (
      this.allocatedIds.size !== (allocatedEventIds?.length ?? 0) ||
      (parsed && this.allocatedIds.size !== this.nextSequence - 1) ||
      this.entries.some((entry) => !this.allocatedIds.has(entry.eventId))
    )
      throw new TypeError("allocated event ID ledger does not match the queue allocation frontier");
    if (
      this.entries.some(
        (entry) =>
          entry.timeMs < currentTimeMs ||
          (entry.timeMs === currentTimeMs && entry.sequence <= this.currentTimeSequence),
      )
    )
      throw new RangeError("restored queue contains an event behind the current frontier");
  }

  get currentTimeMs(): number {
    return this.clockMs;
  }

  get nextEventSequence(): number {
    return this.nextSequence;
  }

  allocatedEventIds(): readonly string[] {
    return [...this.allocatedIds];
  }

  /** A batch receives canonical ties, independent of its caller's insertion order. */
  scheduleBatch(
    drafts: readonly EventDraft[],
    phaseOrder: readonly ScheduledEvent["phase"][],
  ): readonly ScheduledEvent[] {
    const rank = new Map(phaseOrder.map((phase, index) => [phase, index]));
    if (
      phaseOrder.length !== DEFAULT_PHASE_ORDER.length ||
      rank.size !== phaseOrder.length ||
      DEFAULT_PHASE_ORDER.some((phase) => !rank.has(phase))
    )
      throw new TypeError("phase policy must rank all seven phases exactly once");
    const ordered = [...drafts].sort(
      (a, b) =>
        a.timeMs - b.timeMs ||
        rank.get(a.phase)! - rank.get(b.phase)! ||
        (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
    );
    if (new Set(ordered.map((event) => event.eventId)).size !== ordered.length)
      throw new TypeError("batch event IDs must be unique");
    if (ordered.some((event) => this.allocatedIds.has(event.eventId)))
      throw new TypeError("event ID was already allocated");
    if (ordered.some((event) => event.timeMs < this.clockMs))
      throw new RangeError("cannot schedule into the past");
    if (ordered.some((event) => this.entries.some((pending) => pending.timeMs === event.timeMs)))
      throw new TypeError("same-time events must be allocated together in one canonical batch");
    if (!Number.isSafeInteger(this.nextSequence + ordered.length))
      throw new RangeError("event sequence exhausted");
    const indexById = new Map(ordered.map((event, index) => [event.eventId, index]));
    for (const [index, event] of ordered.entries()) {
      for (const cause of event.causeEventIds) {
        const causeIndex = indexById.get(cause);
        if (causeIndex !== undefined && causeIndex >= index)
          throw new TypeError("batch cause must precede its descendant");
        if (causeIndex === undefined && !this.allocatedIds.has(cause))
          throw new TypeError("event cause must already be allocated or precede it in the batch");
        const pendingCause = this.entries.find((entry) => entry.eventId === cause);
        if (pendingCause && pendingCause.timeMs > event.timeMs)
          throw new TypeError("pending event cause cannot follow its descendant");
      }
    }
    for (const [index, event] of ordered.entries())
      ScheduledEventSchema.parse({ ...event, sequence: this.nextSequence + index });
    return ordered.map((event) => this.allocate(event));
  }

  schedule(draft: EventDraft): ScheduledEvent {
    if (this.entries.some((entry) => entry.timeMs === draft.timeMs))
      throw new TypeError("same-time events must be allocated together in one canonical batch");
    return this.allocate(draft);
  }

  private allocate(draft: EventDraft): ScheduledEvent {
    if (this.allocatedIds.has(draft.eventId)) throw new TypeError("event ID was already allocated");
    if (draft.timeMs < this.clockMs) throw new RangeError("cannot schedule into the past");
    for (const cause of draft.causeEventIds) {
      if (!this.allocatedIds.has(cause))
        throw new TypeError("event cause must already be allocated or precede it in the batch");
      const pendingCause = this.entries.find((entry) => entry.eventId === cause);
      if (pendingCause && pendingCause.timeMs > draft.timeMs)
        throw new TypeError("pending event cause cannot follow its descendant");
    }
    if (!Number.isSafeInteger(this.nextSequence + 1))
      throw new RangeError("event sequence exhausted");
    const event = ScheduledEventSchema.parse({ ...draft, sequence: this.nextSequence });
    this.nextSequence += 1;
    this.allocatedIds.add(event.eventId);
    this.entries.push(event);
    this.entries.sort((a, b) => a.timeMs - b.timeMs || a.sequence - b.sequence);
    return structuredClone(event);
  }

  cancel(eventId: string): boolean {
    return this.cancelBatch([eventId]).length > 0;
  }

  private cancelBatch(eventIds: readonly string[]): readonly string[] {
    const requested = new Set(eventIds);
    const cancelled = this.entries.filter((event) => requested.has(event.eventId));
    const cancelledIds = new Set(cancelled.map((event) => event.eventId));
    if (
      this.entries.some(
        (event) =>
          !cancelledIds.has(event.eventId) &&
          event.causeEventIds.some((cause) => cancelledIds.has(cause)),
      )
    )
      throw new TypeError("cannot cancel a pending cause while its descendant remains queued");
    this.entries = this.entries.filter((event) => !cancelledIds.has(event.eventId));
    return cancelled.map((event) => event.eventId);
  }

  replace(replacesEventId: string, draft: EventDraft): ScheduledEvent {
    if (!this.entries.some((entry) => entry.eventId === replacesEventId))
      throw new TypeError("replacement target is not pending");
    const trial = new EventQueue(
      this.clockMs,
      this.eventLimit,
      this.snapshot(),
      this.allocatedEventIds(),
    );
    trial.cancel(replacesEventId);
    const replacement = trial.schedule(draft);
    this.entries = trial.entries;
    this.nextSequence = trial.nextSequence;
    this.allocatedIds.add(replacement.eventId);
    return replacement;
  }

  peek(): ScheduledEvent | null {
    return this.entries[0] ? structuredClone(this.entries[0]) : null;
  }

  /** The callback receives a copy and may only affect the queue through returned commands. */
  step(
    maxEvents: number,
    untilTimeMs: number | null,
    dispatch: (event: Readonly<ScheduledEvent>) => readonly QueueCommand[],
  ): QueueStep {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1)
      throw new RangeError("step budget must be positive");
    if (untilTimeMs !== null && (!Number.isSafeInteger(untilTimeMs) || untilTimeMs < this.clockMs))
      throw new RangeError("step time bound cannot precede the current time");
    const processed: ScheduledEvent[] = [];
    const cancelledEventIds: string[] = [];
    while (
      processed.length < maxEvents &&
      this.entries.length > 0 &&
      (untilTimeMs === null || this.entries[0]!.timeMs <= untilTimeMs)
    ) {
      // The persisted allocation frontier is a conservative, resume-stable work limit.
      // Cancelled allocations consume budget rather than permitting more work after resume.
      if (this.entries[0]!.sequence > this.eventLimit)
        return { status: "event-limit", processed, cancelledEventIds, currentTimeMs: this.clockMs };
      const trial = new EventQueue(
        this.clockMs,
        this.eventLimit,
        this.snapshot(),
        this.allocatedEventIds(),
      );
      const event = trial.entries.shift()!;
      trial.clockMs = event.timeMs;
      trial.lastProcessedSequence = Math.max(trial.lastProcessedSequence, event.sequence);
      trial.currentTimeSequence = event.sequence;
      const scheduled: EventDraft[] = [];
      const cancellations: string[] = [];
      for (const command of dispatch(structuredClone(event))) {
        if (command.kind === "cancel") cancellations.push(command.eventId);
        else {
          if (!command.event.causeEventIds.includes(event.eventId))
            throw new TypeError("scheduled descendants must cite the dispatching event");
          scheduled.push(command.event);
        }
      }
      const cancelledInEvent = trial.cancelBatch(cancellations);
      if (
        scheduled.some((draft) => draft.causeEventIds.some((id) => cancelledInEvent.includes(id)))
      )
        throw new TypeError("scheduled descendant cannot cite a cancelled event");
      trial.scheduleBatch(scheduled, DEFAULT_PHASE_ORDER);
      this.entries = trial.entries;
      this.clockMs = trial.clockMs;
      this.lastProcessedSequence = trial.lastProcessedSequence;
      this.currentTimeSequence = trial.currentTimeSequence;
      this.nextSequence = trial.nextSequence;
      for (const id of trial.allocatedIds) this.allocatedIds.add(id);
      cancelledEventIds.push(...cancelledInEvent);
      processed.push(structuredClone(event));
    }
    return {
      status: this.entries.length === 0 ? "empty" : "progress",
      processed,
      cancelledEventIds,
      currentTimeMs: this.clockMs,
    };
  }

  snapshot() {
    return EventQueueSnapshotSchema.parse({
      lastProcessedSequence: this.lastProcessedSequence,
      currentTimeSequence: this.currentTimeSequence,
      nextSequence: this.nextSequence,
      entries: structuredClone(this.entries),
    });
  }
}
