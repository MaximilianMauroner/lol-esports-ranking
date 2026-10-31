import {
  EngineCommandSchema,
  EngineSnapshotSchema,
  PolicyVisibleStateSchema,
  StepBudgetSchema,
  assertEngineInputCompatible,
  assertEngineStepResult,
  assertLifecycleResolution,
  withLifecycleBatch,
  type EngineCommand,
  type EngineEvent,
  type EngineInput,
  type LifecycleBatch,
  type EngineSession,
  type EngineSnapshot,
  type EngineStepResult,
  type PolicyVisibleState,
  type PortContext,
  type ScheduledEvent,
  type StepBudget,
  type TraceEvent,
  type ValidatedResume,
} from "../../contracts/index.ts";
import { DEFAULT_PHASE_ORDER, EventQueue, type QueueCommand } from "./event-queue.ts";
import { EntityRegistry } from "./entities.ts";
import { lifecycleTransitionFromEvent } from "./lifecycle-event.ts";

export type KernelDispatcher = (
  event: Readonly<ScheduledEvent>,
  context: PortContext,
) => readonly EngineCommand[];
export type PolicyViewAdapter = (snapshot: Readonly<EngineSnapshot>) => PolicyVisibleState;

export type FreshKernelStart = Readonly<{
  input: EngineInput;
  expectedEngineHash: string;
}>;

function freshSnapshot(start: FreshKernelStart, eventLimit: number): EngineSnapshot {
  const { scenario, run } = assertEngineInputCompatible(start.input, start.expectedEngineHash);
  if (scenario.effective.evaluationMode.random.kind !== "deterministic")
    throw new TypeError("fresh seeded sessions require the RNG initialization service");
  if (scenario.effective.evaluationMode.kind === "sampled-estimate")
    throw new TypeError("fresh sampled sessions require the branch initialization service");
  const registry = new EntityRegistry(scenario.effective.entities);
  const entities = registry.active();
  const queue = new EventQueue(0, eventLimit);
  const policy = scenario.effective.policy;
  queue.schedule({
    eventId: run.runId,
    timeMs: 0,
    phase: "input",
    kind: "policy-input",
    payload: {
      actorEntityId: scenario.effective.actorEntityId,
      policyId: policy.policyId,
      policyRevision: policy.revision,
    },
    causeEventIds: [],
  });
  return EngineSnapshotSchema.parse({
    schemaVersion: 1,
    runId: run.runId,
    engineHash: run.engineHash,
    rulesetHash: run.rulesetHash,
    cohortHash: run.cohortHash,
    policyHash: run.policyHash,
    resolvedScenarioHash: run.resolvedScenarioHash,
    candidateInputHash: run.candidateInputHash,
    stateRevisions: registry.stateRevisions(),
    trace: {
      schemaVersion: 1,
      traceId: run.runId,
      runId: run.runId,
      events: [],
      truncated: false,
      truncationReason: null,
    },
    allocatedEventIds: queue.allocatedEventIds(),
    currentTimeMs: 0,
    queue: queue.snapshot(),
    entities,
    retiredEntityIds: registry.retired(),
    buffs: entities.flatMap((entity) => entity.buffs),
    pendingActions: [],
    policyProgress: {
      policyId: policy.policyId,
      revision: policy.revision,
      nextStepId: policy.steps[0]?.stepId ?? null,
      steps: policy.steps.map((step) => ({
        stepId: step.stepId,
        consumedRepeats: 0,
        state: "not-started",
      })),
    },
    triggerState: [],
    rngStreams: [],
    numericalBranches: [],
    status: "running",
    resumability: "resumable",
    interruption: { state: "none", reason: null },
    result: null,
  });
}

/** P01 session slice. Policy and mechanic handlers are injected shared services. */
export class IncrementalKernelSession implements EngineSession {
  private state: EngineSnapshot;
  private queue: EventQueue;
  private readonly horizonMs: number;
  private readonly objectiveKind: EngineInput["run"]["objective"]["kind"];
  private readonly actorEntityId: string;
  private readonly visibleEntityIds: readonly string[];
  private readonly lifecyclePort: EngineInput["ports"]["lifecycle"];
  private readonly input: EngineInput;
  private stepping = false;

  private readonly dispatch: KernelDispatcher;
  private readonly view: PolicyViewAdapter;
  private readonly eventLimit: number;
  constructor(
    start: ValidatedResume | FreshKernelStart,
    dispatch: KernelDispatcher,
    view: PolicyViewAdapter,
    eventLimit = 100_000,
  ) {
    this.dispatch = dispatch;
    this.view = view;
    this.eventLimit = eventLimit;
    this.horizonMs = start.input.run.objective.horizonMs;
    this.objectiveKind = start.input.run.objective.kind;
    this.input = start.input;
    this.lifecyclePort = start.input.ports.lifecycle;
    this.actorEntityId = start.input.scenario.effective.actorEntityId;
    this.visibleEntityIds = [
      ...start.input.scenario.effective.policy.visibility.visibleEntityIds,
    ].sort();
    this.state = structuredClone(
      "snapshot" in start
        ? EngineSnapshotSchema.parse(start.snapshot)
        : freshSnapshot(start, eventLimit),
    );
    this.queue = new EventQueue(
      this.state.currentTimeMs,
      eventLimit,
      this.state.queue,
      this.state.allocatedEventIds,
    );
  }

  snapshot(): EngineSnapshot {
    return structuredClone(EngineSnapshotSchema.parse(this.state));
  }

  policyView(): PolicyVisibleState {
    const value = PolicyVisibleStateSchema.parse(this.view(this.snapshot()));
    if (value.atTimeMs !== this.state.currentTimeMs)
      throw new TypeError("policy view must match the session clock");
    if (
      value.actorEntityId !== this.actorEntityId ||
      JSON.stringify([...value.visibility.visibleEntityIds].sort()) !==
        JSON.stringify(this.visibleEntityIds)
    )
      throw new TypeError("policy view actor and visibility must match the verified scenario");
    // Adapters can mutate their detached input despite its shallow Readonly type.
    // Only retained session state is authoritative for validating their output.
    const entities = new Map(this.state.entities.map((entity) => [entity.entityId, entity]));
    for (const visible of value.entities) {
      const entity = entities.get(visible.entityId);
      if (
        !entity ||
        visible.team !== entity.team ||
        visible.kind !== entity.kind ||
        visible.alive !== entity.alive ||
        JSON.stringify(visible.health) !== JSON.stringify(entity.health) ||
        JSON.stringify(visible.position) !== JSON.stringify(entity.position) ||
        visible.resources.some((resource) => {
          const retained = entity.resources.find(
            (entry) => entry.resourceId === resource.resourceId,
          );
          return (
            !retained ||
            resource.current !== retained.current ||
            resource.maximum !== retained.maximum
          );
        }) ||
        visible.buffs.some((buff) => {
          const retained = entity.buffs.find((entry) => entry.buffId === buff.buffId);
          return (
            !retained ||
            buff.stacks !== retained.stacks ||
            buff.expiresAtMs !== retained.expiresAtMs
          );
        }) ||
        visible.visibleAbilityIds.some(
          (abilityId) => !entity.abilities.some((ability) => ability.abilityId === abilityId),
        )
      )
        throw new TypeError(
          `policy view entity ${visible.entityId} differs from the kernel snapshot`,
        );
    }
    return value;
  }

  private performStep(budget: StepBudget, lifecycleStage: Pick<LifecycleBatch, "apply">) {
    const traceEvents: TraceEvent[] = [];
    const emittedEvents: EngineEvent[] = [];
    const workingEntities = new EntityRegistry(
      this.state.entities,
      this.state.retiredEntityIds,
      this.state.stateRevisions,
    );
    const workingQueue = new EventQueue(
      this.state.currentTimeMs,
      this.eventLimit,
      this.queue.snapshot(),
      this.queue.allocatedEventIds(),
    );
    const step = workingQueue.step(budget.maxEvents, budget.untilTimeMs, (event) => {
      if (event.timeMs > this.horizonMs)
        throw new RangeError("kernel event exceeds the objective horizon");
      const expiredBuffId = workingEntities.firstExpiredBuffAt(event.timeMs);
      if (expiredBuffId !== null)
        throw new TypeError(
          `buff ${expiredBuffId} expired before event ${event.eventId}; expiry service must resolve it first`,
        );
      const context: PortContext = {
        runId: this.state.runId,
        timeMs: event.timeMs,
        sequence: event.sequence,
        causeEventIds: event.causeEventIds,
        nextEventSequence: workingQueue.nextEventSequence,
        allocatedEventIds: workingQueue.allocatedEventIds(),
      };
      // Handlers cannot rewrite the queued event or its shared causal context.
      const commands = this.dispatch(structuredClone(event), structuredClone(context)).map(
        (command) => EngineCommandSchema.parse(command),
      );
      if (new Set(commands.map((command) => command.commandId)).size !== commands.length)
        throw new TypeError("command IDs must be unique within one dispatch");
      if (commands.some((command) => command.issuedAtMs !== event.timeMs))
        throw new TypeError("commands must be issued at the processed event time");
      const traces = commands.filter((command) => command.kind === "trace");
      if (traces.length !== 1)
        throw new TypeError("each processed event requires one trace command");
      const allowedCauses = new Set([...event.causeEventIds, event.eventId]);
      for (const command of commands) {
        if (command.kind === "trace") {
          if (JSON.stringify(command.causeEventIds) !== JSON.stringify(event.causeEventIds))
            throw new TypeError("trace command causes must match the processed event");
        } else if (
          !command.causeEventIds.includes(event.eventId) ||
          command.causeEventIds.some((cause) => !allowedCauses.has(cause))
        ) {
          throw new TypeError("service commands must cite only the processed event and its causes");
        }
      }
      const trace = traces[0]!.event;
      const lifecycle = lifecycleTransitionFromEvent(event);
      if (lifecycle === null) {
        if (trace.effects.length > 0)
          throw new TypeError("trace effects require the corresponding mechanic service");
      } else if (
        trace.kind !== "lifecycle" ||
        trace.effects.length !== 1 ||
        trace.effects[0]?.kind !== "lifecycle" ||
        trace.effects[0].entityId !== lifecycle.entityId ||
        trace.effects[0].transition !== lifecycle.transition ||
        !trace.targetEntityIds.includes(lifecycle.entityId)
      ) {
        throw new TypeError("lifecycle trace must match the scheduled transition");
      }
      if (
        trace.eventId !== event.eventId ||
        trace.sequence !== event.sequence ||
        trace.timeMs !== event.timeMs ||
        trace.phase !== event.phase ||
        JSON.stringify(trace.causeEventIds) !== JSON.stringify(event.causeEventIds)
      )
        throw new TypeError("trace command must preserve the processed event identity");
      const scheduled = commands.filter((command) => command.kind === "schedule-event");
      const phaseRank = new Map(DEFAULT_PHASE_ORDER.map((phase, index) => [phase, index]));
      const canonicalScheduled = [...scheduled].sort(
        (left, right) =>
          left.event.timeMs - right.event.timeMs ||
          phaseRank.get(left.event.phase)! - phaseRank.get(right.event.phase)! ||
          (left.event.eventId < right.event.eventId
            ? -1
            : left.event.eventId > right.event.eventId
              ? 1
              : 0),
      );
      for (const [index, command] of canonicalScheduled.entries()) {
        if (command.event.sequence !== workingQueue.nextEventSequence + index)
          throw new TypeError("scheduled command sequence must match canonical allocation order");
      }
      const queueCommands: QueueCommand[] = [];
      for (const command of commands) {
        if (command.kind === "apply-damage")
          throw new TypeError("damage command requires the P05 damage service");
        if (command.kind === "cancel-event") {
          queueCommands.push({ kind: "cancel", eventId: command.eventId });
        }
        if (command.kind === "schedule-event") {
          if (command.event.timeMs > this.horizonMs)
            throw new RangeError("scheduled event exceeds the objective horizon");
          if (!command.event.causeEventIds.includes(event.eventId))
            throw new TypeError("scheduled event must cite the processed event");
          const nested = command.event;
          queueCommands.push({
            kind: "schedule",
            event: {
              eventId: nested.eventId,
              timeMs: nested.timeMs,
              phase: nested.phase,
              kind: nested.kind,
              payload: nested.payload,
              causeEventIds: nested.causeEventIds,
            },
          });
        }
      }
      if (lifecycle !== null) {
        const resolution = assertLifecycleResolution(
          lifecycle,
          workingEntities.active(),
          lifecycleStage.apply(structuredClone(lifecycle), structuredClone(context)),
        );
        if (!resolution.accepted)
          throw new TypeError(`lifecycle service rejected transition: ${resolution.reason}`);
        workingEntities.apply(lifecycle);
      }
      traceEvents.push(structuredClone(trace));
      emittedEvents.push({
        schemaVersion: 1,
        eventId: event.eventId,
        timeMs: event.timeMs,
        sequence: event.sequence,
        phase: event.phase,
        kind: trace.kind,
        actorEntityId: trace.actorEntityId,
        targetEntityIds: trace.targetEntityIds,
        causeEventIds: event.causeEventIds,
        payload: event.payload,
      });
      return queueCommands;
    });
    // A batch is atomic at the session boundary. The queue and trace are only
    // committed after the entire bounded step has passed contract validation.
    const exhausted = step.status === "event-limit";
    const limitReason = "kernel event allocation limit reached; no combat score is available";
    const incompleteResult = exhausted
      ? {
          schemaVersion: 1 as const,
          resultId: this.state.runId,
          runId: this.state.runId,
          status: "incomplete" as const,
          objective: this.objectiveKind,
          resolvedScenarioHash: this.state.resolvedScenarioHash,
          candidateInputHash: this.state.candidateInputHash,
          metrics: {
            damage: { status: "undefined" as const, reason: limitReason },
            dps: { status: "undefined" as const, reason: limitReason },
            ttk: { status: "undefined" as const, reason: limitReason },
            timeToFirstDeath: { status: "undefined" as const, reason: limitReason },
            timeToElimination: { status: "undefined" as const, reason: limitReason },
          },
          coverage: null,
          uncertainty: null,
          killed: false,
          censoring: "invalid" as const,
          warnings: [limitReason],
          traceId: this.state.trace.traceId,
        }
      : null;
    const cancelledIds = new Set(step.cancelledEventIds);
    const nextState = EngineSnapshotSchema.parse({
      ...this.state,
      currentTimeMs: workingQueue.currentTimeMs,
      queue: exhausted ? { ...workingQueue.snapshot(), entries: [] } : workingQueue.snapshot(),
      entities: workingEntities.active(),
      retiredEntityIds: workingEntities.retired(),
      stateRevisions: workingEntities.stateRevisions(),
      buffs: workingEntities.active().flatMap((entity) => entity.buffs),
      allocatedEventIds: workingQueue.allocatedEventIds(),
      trace: { ...this.state.trace, events: [...this.state.trace.events, ...traceEvents] },
      pendingActions: exhausted
        ? []
        : this.state.pendingActions.map((pending) =>
            pending.continuationEventId !== null &&
            (emittedEvents.some((entry) => entry.eventId === pending.continuationEventId) ||
              cancelledIds.has(pending.continuationEventId))
              ? {
                  ...pending,
                  continuationEventId: null,
                  state: cancelledIds.has(pending.continuationEventId) ? "interrupted" : "complete",
                }
              : pending,
          ),
      status: exhausted ? "incomplete" : "running",
      resumability: exhausted ? "non-resumable" : "resumable",
      result: incompleteResult,
      interruption: {
        state: "budget-exhausted",
        reason: exhausted
          ? limitReason
          : step.status === "empty"
            ? "kernel awaits objective evaluation"
            : "step event budget exhausted",
      },
    });
    const result = assertEngineStepResult(
      this.input,
      {
        schemaVersion: 1,
        status: exhausted ? "incomplete" : "progress",
        snapshot: nextState,
        emittedEvents,
        result: incompleteResult,
        reason: nextState.interruption.reason,
      },
      this.state.engineHash,
    );
    const nextQueue = exhausted
      ? new EventQueue(
          nextState.currentTimeMs,
          this.eventLimit,
          nextState.queue,
          nextState.allocatedEventIds,
        )
      : workingQueue;
    return { result, nextState, nextQueue };
  }

  step(rawBudget: StepBudget): EngineStepResult {
    const budget = StepBudgetSchema.parse(rawBudget);
    if (this.state.status !== "running")
      throw new TypeError("a terminal kernel session cannot be stepped");
    if (this.stepping) throw new TypeError("kernel session step is already running");
    this.stepping = true;
    try {
      const committed = withLifecycleBatch(this.lifecyclePort, this.state, (lifecycleStage) =>
        this.performStep(budget, lifecycleStage),
      );
      this.queue = committed.nextQueue;
      this.state = committed.nextState;
      return committed.result;
    } finally {
      this.stepping = false;
    }
  }
}
