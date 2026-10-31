import { expect, test } from "vitest";
import {
  assertEngineStepResult,
  assertResolvedScenarioPolicyHash,
  assertResumeCompatible,
  EngineSnapshotSchema,
  hashCanonical,
  PolicyVisibleStateSchema,
  RunManifestSchema,
  type EngineCommand,
  type LifecycleTransition,
  type PolicyVisibleState,
  type PortContext,
  type ScheduledEvent,
} from "../../../../src/domains/dps/contracts/index.ts";
import { createMockPorts } from "../../contracts/mock-ports.ts";
import {
  HASH_A,
  sampleResolvedScenario,
  sampleRunningRun,
  sampleRun,
  sampleSnapshot,
} from "../../contracts/fixtures.ts";
import { IncrementalKernelSession } from "../../../../src/domains/dps/engine/kernel/session.ts";

function resume(snapshot = sampleSnapshot) {
  return assertResumeCompatible(
    { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
    snapshot,
    HASH_A,
  );
}

const view = (snapshot: typeof sampleSnapshot): PolicyVisibleState =>
  PolicyVisibleStateSchema.parse({
    schemaVersion: 1,
    atTimeMs: snapshot.currentTimeMs,
    actorEntityId: "actor",
    visibility: sampleResolvedScenario.effective.policy.visibility,
    entities: snapshot.entities.map((entity) => ({
      entityId: entity.entityId,
      team: entity.team,
      kind: entity.kind,
      alive: entity.alive,
      health: entity.health,
      resources: entity.resources.map((resource) => ({
        resourceId: resource.resourceId,
        current: resource.current,
        maximum: resource.maximum,
      })),
      visibleAbilityIds: entity.abilities.map((ability) => ability.abilityId),
      buffs: entity.buffs.map((buff) => ({
        buffId: buff.buffId,
        stacks: buff.stacks,
        expiresAtMs: buff.expiresAtMs,
      })),
      position: entity.position,
    })),
    readiness: snapshot.entities.flatMap((entity) =>
      entity.abilities.map((ability) => ({
        entityId: entity.entityId,
        abilityId: ability.abilityId,
        ready: true,
        cooldownRemainingMs: 0,
      })),
    ),
    visibleResourceIds: [
      ...new Set(
        snapshot.entities.flatMap((entity) =>
          entity.resources.map((resource) => resource.resourceId),
        ),
      ),
    ],
  });

function traceCommand(event: (typeof sampleSnapshot.queue.entries)[number]): EngineCommand {
  return {
    schemaVersion: 1,
    kind: "trace",
    commandId: `trace-${event.eventId}`,
    issuedAtMs: event.timeMs,
    causeEventIds: event.causeEventIds,
    event: {
      eventId: event.eventId,
      sequence: event.sequence,
      timeMs: event.timeMs,
      phase: event.phase,
      kind: "checkpoint",
      actorEntityId: "actor",
      targetEntityIds: ["enemy"],
      causeEventIds: event.causeEventIds,
      effects: [],
      stateDigest: null,
    },
  };
}

function lifecycleTrace(
  event: ScheduledEvent,
  entityId: string,
  transition: LifecycleTransition["transition"],
): EngineCommand {
  const base = traceCommand(event);
  if (base.kind !== "trace") throw new Error("fixture must produce a trace");
  return {
    ...base,
    event: {
      ...base.event,
      kind: "lifecycle",
      targetEntityIds: [entityId],
      effects: [{ kind: "lifecycle", entityId, transition }],
    },
  };
}

function deathCheckpoint() {
  const enemy = sampleSnapshot.entities.find((entity) => entity.entityId === "enemy")!;
  const deadEnemy = {
    ...enemy,
    alive: false,
    health: { ...enemy.health, current: 0, shield: 0 },
  };
  return EngineSnapshotSchema.parse({
    ...sampleSnapshot,
    queue: {
      ...sampleSnapshot.queue,
      entries: [
        {
          ...sampleSnapshot.queue.entries[0]!,
          phase: "lifecycle",
          kind: "lifecycle-transition",
          payload: { entityId: "enemy", transition: "death", replacement: deadEnemy },
        },
      ],
    },
  });
}

test("P01 session processes a future tick only at its timestamp and retains a resumable checkpoint", () => {
  const session = new IncrementalKernelSession(resume(), (event) => [traceCommand(event)], view);
  expect(session.snapshot().currentTimeMs).toBe(100);
  expect(session.policyView().atTimeMs).toBe(100);
  const before = session.step({ maxEvents: 1, untilTimeMs: 999 });
  expect(before.emittedEvents).toHaveLength(0);
  expect(before.snapshot.currentTimeMs).toBe(100);
  const after = session.step({ maxEvents: 1, untilTimeMs: 1000 });
  expect(after.emittedEvents.map((event) => event.eventId)).toEqual(["event-003"]);
  expect(after.snapshot.currentTimeMs).toBe(1000);
  expect(after.snapshot.pendingActions[0]?.state).toBe("complete");
  const restored = new IncrementalKernelSession(
    resume(after.snapshot),
    (event) => [traceCommand(event)],
    view,
  );
  expect(restored.snapshot()).toEqual(after.snapshot);
});

test("pending action follows actual continuation execution or successful cancellation", () => {
  const alreadyExecuted = new IncrementalKernelSession(
    resume(),
    (event) => [
      traceCommand(event),
      {
        schemaVersion: 1,
        kind: "cancel-event",
        commandId: "cancel-current",
        issuedAtMs: event.timeMs,
        causeEventIds: [event.eventId],
        eventId: event.eventId,
      },
    ],
    view,
  );
  const executed = alreadyExecuted.step({ maxEvents: 1, untilTimeMs: null });
  expect(executed.snapshot.pendingActions[0]?.state).toBe("complete");
  expect(executed.emittedEvents.map((event) => event.eventId)).toEqual(["event-003"]);

  const cancellation = EngineSnapshotSchema.parse({
    ...sampleSnapshot,
    allocatedEventIds: [...sampleSnapshot.allocatedEventIds, "cancel-root"],
    queue: {
      ...sampleSnapshot.queue,
      nextSequence: 5,
      entries: [
        {
          eventId: "cancel-root",
          sequence: 4,
          timeMs: 200,
          phase: "input",
          kind: "cancel-continuation",
          payload: null,
          causeEventIds: ["event-002"],
        },
        ...sampleSnapshot.queue.entries,
      ],
    },
  });
  const dispatch = (event: ScheduledEvent): EngineCommand[] => [
    traceCommand(event),
    {
      schemaVersion: 1,
      kind: "cancel-event",
      commandId: "cancel-pending",
      issuedAtMs: event.timeMs,
      causeEventIds: [event.eventId],
      eventId: "event-003",
    },
  ];
  const session = new IncrementalKernelSession(resume(cancellation), dispatch, view);
  const cancelled = session.step({ maxEvents: 1, untilTimeMs: null });
  expect(cancelled.snapshot.pendingActions[0]?.state).toBe("interrupted");
  expect(cancelled.snapshot.queue.entries).toEqual([]);
  const restored = new IncrementalKernelSession(resume(cancelled.snapshot), dispatch, view);
  expect(restored.snapshot()).toEqual(cancelled.snapshot);
});

test("policy view cannot replace the verified scenario visibility with a narrower schema-valid view", () => {
  const restrictedView = (snapshot: typeof sampleSnapshot): PolicyVisibleState => {
    const full = view(snapshot);
    return PolicyVisibleStateSchema.parse({
      ...full,
      visibility: { ...full.visibility, visibleEntityIds: ["actor"] },
      entities: full.entities.filter((entity) => entity.entityId === "actor"),
      readiness: full.readiness.filter((record) => record.entityId === "actor"),
    });
  };
  const session = new IncrementalKernelSession(
    resume(),
    (event) => [traceCommand(event)],
    restrictedView,
  );
  const before = session.snapshot();
  expect(() => session.policyView()).toThrow("must match the verified scenario");
  expect(session.snapshot()).toEqual(before);

  const restored = new IncrementalKernelSession(
    resume(before),
    (event) => [traceCommand(event)],
    view,
  );
  expect(restored.policyView().visibility.visibleEntityIds).toEqual(
    sampleResolvedScenario.effective.policy.visibility.visibleEntityIds,
  );
});

test("policy view rejects stale visible entity values without changing the session", () => {
  const mutations: Array<(value: PolicyVisibleState) => void> = [
    (value) => {
      value.entities[0]!.health.current -= 1;
    },
    (value) => {
      value.entities[0]!.position.x += 1;
    },
    (value) => {
      value.entities[0]!.resources[0]!.current -= 1;
    },
    (value) => {
      value.entities[0]!.buffs[0]!.stacks += 1;
    },
  ];
  for (const mutate of mutations) {
    const staleView = (snapshot: typeof sampleSnapshot): PolicyVisibleState => {
      const visible = structuredClone(view(snapshot));
      mutate(visible);
      return PolicyVisibleStateSchema.parse(visible);
    };
    const session = new IncrementalKernelSession(
      resume(),
      (event) => [traceCommand(event)],
      staleView,
    );
    const before = session.snapshot();
    expect(() => session.policyView()).toThrow("differs from the kernel snapshot");
    expect(session.snapshot()).toEqual(before);
  }
  const restored = new IncrementalKernelSession(resume(), (event) => [traceCommand(event)], view);
  expect(restored.policyView().entities[0]?.health).toEqual(sampleSnapshot.entities[0]?.health);
});

test("policy adapter cannot forge visible values by mutating its input snapshot", () => {
  const mutations: Array<(snapshot: typeof sampleSnapshot) => void> = [
    (snapshot) => {
      snapshot.entities[0]!.health.current -= 1;
    },
    (snapshot) => {
      snapshot.entities[0]!.position.x += 1;
    },
    (snapshot) => {
      snapshot.entities[0]!.resources[0]!.current -= 1;
    },
    (snapshot) => {
      snapshot.entities[0]!.buffs[0]!.stacks += 1;
    },
  ];
  for (const mutate of mutations) {
    const session = new IncrementalKernelSession(
      resume(),
      (event) => [traceCommand(event)],
      (snapshot) => {
        mutate(snapshot);
        return view(snapshot);
      },
    );
    const before = session.snapshot();
    expect(() => session.policyView()).toThrow("differs from the kernel snapshot");
    expect(session.snapshot()).toEqual(before);

    const restored = new IncrementalKernelSession(
      resume(before),
      (event) => [traceCommand(event)],
      view,
    );
    expect(restored.policyView()).toEqual(view(before));
    expect(restored.step({ maxEvents: 1, untilTimeMs: null })).toEqual(
      session.step({ maxEvents: 1, untilTimeMs: null }),
    );
  }
});

test("dispatch cannot rewrite queued causal identity through its event copy", () => {
  const session = new IncrementalKernelSession(
    resume(),
    (event) => {
      event.causeEventIds.length = 0;
      return [traceCommand(event)];
    },
    view,
  );
  const before = session.snapshot();
  expect(() => session.step({ maxEvents: 1, untilTimeMs: null })).toThrow(
    "trace command causes must match the processed event",
  );
  expect(session.snapshot()).toEqual(before);
  const restored = new IncrementalKernelSession(
    resume(before),
    (event) => [traceCommand(event)],
    view,
  );
  expect(
    restored.step({ maxEvents: 1, untilTimeMs: null }).emittedEvents[0]?.causeEventIds,
  ).toEqual(["event-002"]);
});

test("dispatch context and lifecycle payload mutations cannot alter the retained transition", () => {
  const checkpoint = deathCheckpoint();
  const dispatch = (event: ScheduledEvent): EngineCommand[] => [
    lifecycleTrace(event, "enemy", "death"),
  ];
  const baseline = new IncrementalKernelSession(resume(checkpoint), dispatch, view);
  const session = new IncrementalKernelSession(
    resume(checkpoint),
    (event, context) => {
      Reflect.set(context.causeEventIds, "length", 0);
      if (
        event.payload !== null &&
        typeof event.payload === "object" &&
        !Array.isArray(event.payload)
      )
        event.payload.entityId = "actor";
      return dispatch(event);
    },
    view,
  );
  const expected = baseline.step({ maxEvents: 1, untilTimeMs: null });
  expect(session.step({ maxEvents: 1, untilTimeMs: null })).toEqual(expected);
  const restored = new IncrementalKernelSession(resume(session.snapshot()), dispatch, view);
  expect(restored.snapshot()).toEqual(expected.snapshot);
  expect(restored.snapshot().entities.find((entity) => entity.entityId === "actor")?.alive).toBe(
    true,
  );
  expect(restored.snapshot().entities.find((entity) => entity.entityId === "enemy")?.alive).toBe(
    false,
  );
});

test("failed command dispatch leaves queue and snapshot unchanged", () => {
  const session = new IncrementalKernelSession(
    resume(),
    () => [
      {
        schemaVersion: 1,
        kind: "apply-damage",
        commandId: "unsupported",
        issuedAtMs: 1000,
        causeEventIds: ["event-002"],
        packet: {
          sourceEntityId: "actor",
          targetEntityId: "enemy",
          damageType: "physical",
          rawAmount: 10,
          tags: [],
          canOverkill: false,
        },
      },
    ],
    view,
  );
  const before = session.snapshot();
  expect(() => session.step({ maxEvents: 1, untilTimeMs: null })).toThrow("one trace command");
  expect(session.snapshot()).toEqual(before);
  expect(() => session.step({ maxEvents: 0, untilTimeMs: null })).toThrow();
});

test("service dispatch rejects missing, unrelated, and stripped causal provenance atomically", () => {
  const invalidCauses = [[], ["event-003", "unrelated"]];
  for (const causeEventIds of invalidCauses) {
    const session = new IncrementalKernelSession(
      resume(),
      (event) => [
        traceCommand(event),
        {
          schemaVersion: 1,
          kind: "cancel-event",
          commandId: "cancel-future",
          issuedAtMs: event.timeMs,
          causeEventIds,
          eventId: "future-event",
        },
      ],
      view,
    );
    const before = session.snapshot();
    expect(() => session.step({ maxEvents: 1, untilTimeMs: null })).toThrow(
      "service commands must cite only the processed event and its causes",
    );
    expect(session.snapshot()).toEqual(before);
  }

  const session = new IncrementalKernelSession(
    resume(),
    (event) => [{ ...traceCommand(event), causeEventIds: [] }],
    view,
  );
  const before = session.snapshot();
  expect(() => session.step({ maxEvents: 1, untilTimeMs: null })).toThrow(
    "trace command causes must match the processed event",
  );
  expect(session.snapshot()).toEqual(before);
  const restored = new IncrementalKernelSession(
    resume(before),
    (event) => [traceCommand(event)],
    view,
  );
  expect(restored.step({ maxEvents: 1, untilTimeMs: null }).emittedEvents[0]?.eventId).toBe(
    "event-003",
  );
});

test("session dispatch schedules a causal future event and replays it after resume", () => {
  const dispatch = (event: (typeof sampleSnapshot.queue.entries)[number]): EngineCommand[] =>
    event.eventId === "event-003"
      ? [
          traceCommand(event),
          {
            schemaVersion: 1,
            kind: "schedule-event",
            commandId: "schedule-004",
            issuedAtMs: 1000,
            causeEventIds: ["event-003"],
            event: {
              eventId: "event-004",
              sequence: 4,
              timeMs: 1500,
              phase: "periodic",
              kind: "future-tick",
              payload: null,
              causeEventIds: ["event-003"],
            },
          },
        ]
      : [traceCommand(event)];
  const session = new IncrementalKernelSession(resume(), dispatch, view);
  const first = session.step({ maxEvents: 1, untilTimeMs: null });
  expect(first.snapshot.queue.entries.map((event) => event.eventId)).toEqual(["event-004"]);
  expect(first.snapshot.allocatedEventIds).toContain("event-004");
  const restored = new IncrementalKernelSession(resume(first.snapshot), dispatch, view);
  const second = restored.step({ maxEvents: 1, untilTimeMs: null });
  expect(second.emittedEvents.map((event) => event.eventId)).toEqual(["event-004"]);
  expect(second.snapshot.trace.events.at(-1)?.causeEventIds).toEqual(["event-003"]);
});

test("session event limit returns a terminal, scoreless incomplete result", () => {
  const session = new IncrementalKernelSession(resume(), (event) => [traceCommand(event)], view, 2);
  const step = session.step({ maxEvents: 1, untilTimeMs: null });
  expect(step.status).toBe("incomplete");
  expect(step.reason).toContain("event allocation limit");
  expect(step.emittedEvents).toEqual([]);
  expect(step.snapshot.currentTimeMs).toBe(100);
  expect(step.snapshot.queue.entries).toEqual([]);
  expect(step.snapshot.pendingActions).toEqual([]);
  expect(step.snapshot.resumability).toBe("non-resumable");
  expect(step.result?.status).toBe("incomplete");
  expect(step.result?.metrics.dps.status).toBe("undefined");
  expect(step.result?.metrics.ttk.status).toBe("undefined");
  expect(step.result?.censoring).toBe("invalid");
  expect(step.snapshot.result).toEqual(step.result);
  expect(JSON.parse(JSON.stringify(step))).toEqual(step);
  expect(
    assertEngineStepResult(
      { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
      step,
      HASH_A,
    ),
  ).toEqual(step);
  expect(session.snapshot()).toEqual(step.snapshot);
  expect(() => session.step({ maxEvents: 1, untilTimeMs: null })).toThrow("terminal");
});

test("coverage-first event exhaustion validates without inventing kill coverage", async () => {
  const scenarioDraft = structuredClone(sampleResolvedScenario);
  scenarioDraft.effective.objective.aggregation = "coverage-then-ttk";
  scenarioDraft.resolvedScenarioHash = await hashCanonical(scenarioDraft.effective);
  const scenario = await assertResolvedScenarioPolicyHash(scenarioDraft);
  const run = structuredClone(sampleRunningRun);
  run.objective = structuredClone(scenario.effective.objective);
  run.resolvedScenarioHash = scenario.resolvedScenarioHash;
  run.cohortHash = scenario.effective.cohort.contentHash;
  run.policyHash = scenario.policyHash;
  run.candidateInputHash = scenario.candidateInputHash;
  const snapshot = structuredClone(sampleSnapshot);
  snapshot.resolvedScenarioHash = run.resolvedScenarioHash;
  snapshot.cohortHash = run.cohortHash;
  snapshot.policyHash = run.policyHash;
  snapshot.candidateInputHash = run.candidateInputHash;
  const input = { scenario, run, ports: createMockPorts() };
  const session = new IncrementalKernelSession(
    assertResumeCompatible(input, snapshot, HASH_A),
    (event) => [traceCommand(event)],
    view,
    2,
  );

  const step = session.step({ maxEvents: 1, untilTimeMs: null });
  expect(step.status).toBe("incomplete");
  expect(step.result?.coverage).toBeNull();
  expect(step.result?.metrics.ttk.status).toBe("undefined");
  expect(assertEngineStepResult(input, step, HASH_A)).toEqual(step);
  expect(assertEngineStepResult(input, JSON.parse(JSON.stringify(step)), HASH_A)).toEqual(step);
  expect(session.snapshot()).toEqual(step.snapshot);
});

test("event limit commits already processed events before returning incomplete", () => {
  const dispatch = (event: ScheduledEvent): EngineCommand[] => [
    traceCommand(event),
    {
      schemaVersion: 1,
      kind: "schedule-event",
      commandId: "schedule-child",
      issuedAtMs: event.timeMs,
      causeEventIds: [event.eventId],
      event: {
        eventId: "child-after-limit",
        sequence: 4,
        timeMs: event.timeMs,
        phase: "checkpoint",
        kind: "child-after-limit",
        payload: null,
        causeEventIds: [event.eventId],
      },
    },
  ];
  const session = new IncrementalKernelSession(resume(), dispatch, view, 3);
  const step = session.step({ maxEvents: 2, untilTimeMs: null });
  expect(step.status).toBe("incomplete");
  expect(step.emittedEvents.map((event) => event.eventId)).toEqual(["event-003"]);
  expect(step.snapshot.trace.events.at(-1)?.eventId).toBe("event-003");
  expect(step.snapshot.currentTimeMs).toBe(1000);
  expect(step.snapshot.allocatedEventIds).toContain("child-after-limit");
  expect(step.snapshot.queue.entries).toEqual([]);
  expect(step.result?.metrics.damage.status).toBe("undefined");
  expect(session.snapshot()).toEqual(step.snapshot);
});

test("session keeps entity revision counters from a validated checkpoint", () => {
  const checkpoint = EngineSnapshotSchema.parse({
    ...sampleSnapshot,
    stateRevisions: { actor: 7, enemy: 3 },
  });
  const session = new IncrementalKernelSession(
    resume(checkpoint),
    (event) => [traceCommand(event)],
    view,
  );
  expect(session.snapshot().stateRevisions).toEqual({ actor: 7, enemy: 3 });
  expect(session.step({ maxEvents: 1, untilTimeMs: null }).snapshot.stateRevisions).toEqual({
    actor: 7,
    enemy: 3,
  });
});

test("bounded batch matches checkpointed steps and rolls back when a later dispatch fails", () => {
  const dispatch = (event: (typeof sampleSnapshot.queue.entries)[number]): EngineCommand[] =>
    event.eventId === "event-003"
      ? [
          traceCommand(event),
          {
            schemaVersion: 1,
            kind: "schedule-event",
            commandId: "schedule-004",
            issuedAtMs: event.timeMs,
            causeEventIds: [event.eventId],
            event: {
              eventId: "event-004",
              sequence: 4,
              timeMs: 1500,
              phase: "periodic",
              kind: "future-tick",
              payload: null,
              causeEventIds: [event.eventId],
            },
          },
        ]
      : [traceCommand(event)];
  const batched = new IncrementalKernelSession(resume(), dispatch, view);
  const batch = batched.step({ maxEvents: 2, untilTimeMs: null });
  expect(batch.emittedEvents.map((event) => event.eventId)).toEqual(["event-003", "event-004"]);

  const first = new IncrementalKernelSession(resume(), dispatch, view).step({
    maxEvents: 1,
    untilTimeMs: null,
  });
  const resumed = new IncrementalKernelSession(resume(first.snapshot), dispatch, view);
  const second = resumed.step({ maxEvents: 1, untilTimeMs: null });
  expect(batch.snapshot).toEqual(second.snapshot);

  const failing = new IncrementalKernelSession(
    resume(),
    (event) => (event.eventId === "event-004" ? [] : dispatch(event)),
    view,
  );
  const before = failing.snapshot();
  expect(() => failing.step({ maxEvents: 2, untilTimeMs: null })).toThrow("one trace command");
  expect(failing.snapshot()).toEqual(before);
});

test("fresh session validates run identity, seeds a chronological queue, and resumes", () => {
  const plannedRun = RunManifestSchema.parse({
    ...sampleRun,
    status: "planned",
    completedAt: null,
  });
  const start = {
    input: {
      scenario: sampleResolvedScenario,
      run: plannedRun,
      ports: createMockPorts(),
    },
    expectedEngineHash: HASH_A,
  };
  const dispatch = (event: (typeof sampleSnapshot.queue.entries)[number]): EngineCommand[] =>
    event.eventId === plannedRun.runId
      ? [
          traceCommand(event),
          {
            schemaVersion: 1,
            kind: "schedule-event",
            commandId: "schedule-first-attack",
            issuedAtMs: 0,
            causeEventIds: [event.eventId],
            event: {
              eventId: "first-attack",
              sequence: 2,
              timeMs: 100,
              phase: "impact",
              kind: "attack",
              payload: null,
              causeEventIds: [event.eventId],
            },
          },
        ]
      : [traceCommand(event)];
  const session = new IncrementalKernelSession(start, dispatch, view);
  const initial = session.snapshot();
  expect(new IncrementalKernelSession(start, dispatch, view).snapshot()).toEqual(initial);
  expect(initial.currentTimeMs).toBe(0);
  expect(initial.entities).toEqual(sampleResolvedScenario.effective.entities);
  expect(initial.policyProgress.steps.every((step) => step.state === "not-started")).toBe(true);
  expect(initial.queue.entries.map((event) => event.eventId)).toEqual([plannedRun.runId]);
  const first = session.step({ maxEvents: 1, untilTimeMs: 0 });
  expect(first.emittedEvents.map((event) => event.eventId)).toEqual([plannedRun.runId]);
  expect(first.snapshot.queue.entries.map((event) => event.eventId)).toEqual(["first-attack"]);
  const resumed = new IncrementalKernelSession(
    assertResumeCompatible(
      { ...start.input, run: { ...plannedRun, status: "running" } },
      first.snapshot,
      HASH_A,
    ),
    dispatch,
    view,
  );
  expect(resumed.step({ maxEvents: 1, untilTimeMs: null }).emittedEvents[0]?.eventId).toBe(
    "first-attack",
  );
  expect(
    () =>
      new IncrementalKernelSession({ ...start, expectedEngineHash: "sha256:dead" }, () => [], view),
  ).toThrow();
});

test("dispatch cannot place a future effect beyond the objective horizon", () => {
  const session = new IncrementalKernelSession(
    resume(),
    (event) => [
      traceCommand(event),
      {
        schemaVersion: 1,
        kind: "schedule-event",
        commandId: "too-late",
        issuedAtMs: event.timeMs,
        causeEventIds: [event.eventId],
        event: {
          eventId: "outside-window",
          sequence: 4,
          timeMs: 5001,
          phase: "periodic",
          kind: "late-tick",
          payload: null,
          causeEventIds: [event.eventId],
        },
      },
    ],
    view,
  );
  const before = session.snapshot();
  expect(() => session.step({ maxEvents: 1, untilTimeMs: null })).toThrow("objective horizon");
  expect(session.snapshot()).toEqual(before);
});

test("expired buffs stop time advancement before dispatch without changing the checkpoint", () => {
  const dispatched: string[] = [];
  const session = new IncrementalKernelSession(
    resume(),
    (event) => {
      dispatched.push(event.eventId);
      return event.eventId === "event-003"
        ? [
            traceCommand(event),
            {
              schemaVersion: 1,
              kind: "schedule-event",
              commandId: "schedule-after-expiry",
              issuedAtMs: event.timeMs,
              causeEventIds: [event.eventId],
              event: {
                eventId: "event-004",
                sequence: 4,
                timeMs: 3001,
                phase: "checkpoint",
                kind: "later-checkpoint",
                payload: null,
                causeEventIds: [event.eventId],
              },
            },
          ]
        : [traceCommand(event)];
    },
    view,
  );
  const first = session.step({ maxEvents: 1, untilTimeMs: null });
  expect(first.snapshot.currentTimeMs).toBe(1000);
  const checkpoint = session.snapshot();
  expect(() => session.step({ maxEvents: 1, untilTimeMs: null })).toThrow(
    "expiry service must resolve it first",
  );
  expect(dispatched).toEqual(["event-003"]);
  expect(session.snapshot()).toEqual(checkpoint);
  const restored = new IncrementalKernelSession(
    resume(checkpoint),
    () => {
      throw new Error("expired event must never dispatch after resume");
    },
    view,
  );
  expect(() => restored.step({ maxEvents: 1, untilTimeMs: null })).toThrow(
    "expiry service must resolve it first",
  );
});

test("a buff remains valid at its exact expiry timestamp under P01 snapshot rules", () => {
  const session = new IncrementalKernelSession(
    resume(),
    (event) =>
      event.eventId === "event-003"
        ? [
            traceCommand(event),
            {
              schemaVersion: 1,
              kind: "schedule-event",
              commandId: "schedule-expiry-boundary",
              issuedAtMs: event.timeMs,
              causeEventIds: [event.eventId],
              event: {
                eventId: "event-004",
                sequence: 4,
                timeMs: 3000,
                phase: "expiry",
                kind: "expiry-boundary",
                payload: null,
                causeEventIds: [event.eventId],
              },
            },
          ]
        : [traceCommand(event)],
    view,
  );
  const step = session.step({ maxEvents: 2, untilTimeMs: null });
  expect(step.snapshot.currentTimeMs).toBe(3000);
  expect(step.emittedEvents.map((event) => event.eventId)).toEqual(["event-003", "event-004"]);
  expect(step.snapshot.buffs[0]?.expiresAtMs).toBe(3000);
});

test("a trace cannot claim damage before the damage service changes entity state", () => {
  const session = new IncrementalKernelSession(
    resume(),
    (event) => {
      const command = traceCommand(event);
      if (command.kind !== "trace") throw new Error("fixture must emit a trace");
      return [
        {
          ...command,
          event: {
            ...command.event,
            effects: [
              {
                kind: "damage",
                sourceEntityId: "actor",
                targetEntityId: "enemy",
                damageType: "physical",
                amount: 50,
                overkill: 0,
              },
            ],
          },
        },
      ];
    },
    view,
  );
  const before = session.snapshot();
  expect(() => session.step({ maxEvents: 1, untilTimeMs: null })).toThrow(
    "corresponding mechanic service",
  );
  expect(session.snapshot()).toEqual(before);
});

test("timer commands allocate canonical same-time descendants regardless of command order", () => {
  const descendants: Extract<EngineCommand, { kind: "schedule-event" }>[] = [
    {
      schemaVersion: 1,
      kind: "schedule-event",
      commandId: "schedule-expiry",
      issuedAtMs: 1000,
      causeEventIds: ["event-003"],
      event: {
        eventId: "expiry-child",
        sequence: 5,
        timeMs: 1500,
        phase: "expiry",
        kind: "buff-expiry",
        payload: null,
        causeEventIds: ["event-003"],
      },
    },
    {
      schemaVersion: 1,
      kind: "schedule-event",
      commandId: "schedule-impact",
      issuedAtMs: 1000,
      causeEventIds: ["event-003"],
      event: {
        eventId: "impact-child",
        sequence: 4,
        timeMs: 1500,
        phase: "impact",
        kind: "projectile-impact",
        payload: null,
        causeEventIds: ["event-003"],
      },
    },
  ];
  const dispatch = (event: (typeof sampleSnapshot.queue.entries)[number]): EngineCommand[] =>
    event.eventId === "event-003" ? [traceCommand(event), ...descendants] : [traceCommand(event)];
  const session = new IncrementalKernelSession(resume(), dispatch, view);
  const first = session.step({ maxEvents: 1, untilTimeMs: null });
  expect(first.snapshot.queue.entries.map((event) => event.eventId)).toEqual([
    "impact-child",
    "expiry-child",
  ]);
  const restored = new IncrementalKernelSession(resume(first.snapshot), dispatch, view);
  expect(
    restored.step({ maxEvents: 2, untilTimeMs: null }).emittedEvents.map((event) => event.eventId),
  ).toEqual(["impact-child", "expiry-child"]);

  const reversed = new IncrementalKernelSession(
    resume(),
    (event) => [traceCommand(event), ...[...descendants].reverse()],
    view,
  );
  expect(reversed.step({ maxEvents: 1, untilTimeMs: null }).snapshot).toEqual(first.snapshot);

  const invalid = new IncrementalKernelSession(
    resume(),
    (event) => [
      traceCommand(event),
      { ...descendants[0]!, event: { ...descendants[0]!.event, sequence: 4 } },
      descendants[1]!,
    ],
    view,
  );
  const before = invalid.snapshot();
  expect(() => invalid.step({ maxEvents: 1, untilTimeMs: null })).toThrow(
    "canonical allocation order",
  );
  expect(invalid.snapshot()).toEqual(before);
});

test("scheduled death waits for its timestamp and revival survives checkpoint resume", () => {
  const checkpoint = deathCheckpoint();
  const dispatch = (event: ScheduledEvent): EngineCommand[] => {
    if (event.kind !== "lifecycle-transition") return [traceCommand(event)];
    const transition = (event.payload as { transition: "death" | "revive" }).transition;
    const trace = lifecycleTrace(event, "enemy", transition);
    if (transition === "revive") return [trace];
    const enemy = checkpoint.entities.find((entity) => entity.entityId === "enemy")!;
    return [
      trace,
      {
        schemaVersion: 1,
        kind: "schedule-event",
        commandId: "schedule-revive",
        issuedAtMs: event.timeMs,
        causeEventIds: [event.eventId],
        event: {
          eventId: "event-004",
          sequence: 4,
          timeMs: 1500,
          phase: "lifecycle",
          kind: "lifecycle-transition",
          payload: {
            entityId: "enemy",
            transition: "revive",
            replacement: { ...enemy, health: { ...enemy.health, current: 100 } },
          },
          causeEventIds: [event.eventId],
        },
      },
    ];
  };
  const session = new IncrementalKernelSession(resume(checkpoint), dispatch, view);
  const before = session.step({ maxEvents: 1, untilTimeMs: 999 });
  expect(before.snapshot.entities.find((entity) => entity.entityId === "enemy")?.alive).toBe(true);
  const death = session.step({ maxEvents: 1, untilTimeMs: 1000 });
  expect(death.snapshot.entities.find((entity) => entity.entityId === "enemy")?.alive).toBe(false);
  expect(death.snapshot.stateRevisions.enemy).toBe(2);
  expect(death.snapshot.queue.entries[0]?.eventId).toBe("event-004");
  const restored = new IncrementalKernelSession(resume(death.snapshot), dispatch, view);
  expect(restored.policyView().entities.find((entity) => entity.entityId === "enemy")?.alive).toBe(
    false,
  );
  const revival = restored.step({ maxEvents: 1, untilTimeMs: 1500 });
  expect(
    revival.snapshot.entities.find((entity) => entity.entityId === "enemy")?.health.current,
  ).toBe(100);
  expect(revival.snapshot.stateRevisions.enemy).toBe(3);
  expect(revival.snapshot.trace.events.at(-1)?.effects).toEqual([
    { kind: "lifecycle", entityId: "enemy", transition: "revive" },
  ]);
});

test("despawned identities stay retired across checkpoints and cannot be spawned again", () => {
  const actor = sampleSnapshot.entities.find((entity) => entity.entityId === "actor")!;
  const summon = {
    ...structuredClone(actor),
    entityId: "summon-1",
    ownerEntityId: "actor",
    kind: "summon" as const,
    championId: null,
    abilities: [],
    buffs: [],
    resources: [],
    inventory: [],
    inventoryOrigin: "empty" as const,
  };
  const lifecycleEvent = (
    eventId: string,
    sequence: number,
    timeMs: number,
    causeEventIds: string[],
    payload: Readonly<LifecycleTransition>,
  ) => ({
    eventId,
    sequence,
    timeMs,
    phase: "lifecycle" as const,
    kind: "lifecycle-transition",
    payload,
    causeEventIds,
  });
  const checkpoint = EngineSnapshotSchema.parse({
    ...sampleSnapshot,
    queue: {
      ...sampleSnapshot.queue,
      entries: [
        lifecycleEvent("event-003", 3, 1000, ["event-002"], {
          entityId: "summon-1",
          transition: "spawn",
          replacement: summon,
        }),
      ],
    },
  });
  // Spawn at 1000 schedules a despawn at 1500, which schedules a forbidden respawn at 2000.
  const dispatch = (event: ScheduledEvent): EngineCommand[] => {
    const { transition } = event.payload as LifecycleTransition;
    const trace = lifecycleTrace(event, "summon-1", transition);
    const next =
      event.eventId === "event-003"
        ? lifecycleEvent("event-004", 4, 1500, [event.eventId], {
            entityId: "summon-1",
            transition: "despawn",
            replacement: null,
          })
        : event.eventId === "event-004"
          ? lifecycleEvent("event-005", 5, 2000, [event.eventId], {
              entityId: "summon-1",
              transition: "spawn",
              replacement: summon,
            })
          : null;
    if (next === null) return [trace];
    return [
      trace,
      {
        schemaVersion: 1,
        kind: "schedule-event",
        commandId: `schedule-${next.eventId}`,
        issuedAtMs: event.timeMs,
        causeEventIds: [event.eventId],
        event: next,
      },
    ];
  };
  const counts = { commits: 0, rollbacks: 0 };
  const ports = {
    ...createMockPorts(),
    lifecycle: {
      protocolVersion: 2 as const,
      beginBatch: () => ({
        apply: (transition: LifecycleTransition) => ({
          accepted: true,
          entityId: transition.entityId,
          transition: transition.transition,
          state: transition.replacement,
          reason: null,
        }),
        commit: () => {
          counts.commits += 1;
          return undefined;
        },
        rollback: () => {
          counts.rollbacks += 1;
          return undefined;
        },
      }),
    },
  };
  const session = (snapshot: unknown) =>
    new IncrementalKernelSession(
      assertResumeCompatible(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports },
        JSON.parse(JSON.stringify(snapshot)),
        HASH_A,
      ),
      dispatch,
      view,
    );
  const ids = (snapshot: typeof sampleSnapshot) =>
    snapshot.entities.map((entity) => entity.entityId);

  const uninterrupted = session(checkpoint).step({ maxEvents: 2, untilTimeMs: 1500 });
  const spawned = session(checkpoint).step({ maxEvents: 1, untilTimeMs: null });
  expect(ids(spawned.snapshot)).toEqual(["actor", "enemy", "summon-1"]);
  expect(spawned.snapshot.stateRevisions["summon-1"]).toBe(1);
  expect(spawned.snapshot.retiredEntityIds).toEqual([]);

  const despawned = session(spawned.snapshot).step({ maxEvents: 1, untilTimeMs: null });
  expect(ids(despawned.snapshot)).toEqual(["actor", "enemy"]);
  expect(despawned.snapshot.stateRevisions).toEqual({ actor: 1, enemy: 1 });
  expect(despawned.snapshot.retiredEntityIds).toEqual(["summon-1"]);
  expect(despawned.snapshot).toEqual(uninterrupted.snapshot);
  expect(counts).toEqual({ commits: 3, rollbacks: 0 });

  const restored = session(despawned.snapshot);
  const before = restored.snapshot();
  expect(() => restored.step({ maxEvents: 1, untilTimeMs: null })).toThrow("already allocated");
  expect(restored.snapshot()).toEqual(before);
  expect(counts).toEqual({ commits: 3, rollbacks: 1 });
});

test("despawning a policy-visible scenario entity fails the step without changing the checkpoint", () => {
  const checkpoint = EngineSnapshotSchema.parse({
    ...sampleSnapshot,
    // Drop the actor's copied ability so only the policy view still depends on the enemy.
    entities: sampleSnapshot.entities.map((entity) =>
      entity.entityId === "actor"
        ? {
            ...entity,
            abilities: entity.abilities.filter((ability) => ability.origin.kind !== "copied"),
          }
        : entity,
    ),
    queue: {
      ...sampleSnapshot.queue,
      entries: [
        {
          ...sampleSnapshot.queue.entries[0]!,
          phase: "lifecycle",
          kind: "lifecycle-transition",
          payload: { entityId: "enemy", transition: "despawn", replacement: null },
        },
      ],
    },
  });
  const session = new IncrementalKernelSession(
    resume(checkpoint),
    (event) => [lifecycleTrace(event, "enemy", "despawn")],
    view,
  );
  const before = session.snapshot();
  expect(() => session.step({ maxEvents: 1, untilTimeMs: null })).toThrow(
    "snapshot must retain policy-visible entity enemy",
  );
  expect(session.snapshot()).toEqual(before);
});

test("lifecycle events use the shared port at their event frontier", () => {
  const checkpoint = deathCheckpoint();
  const calls: Array<{ transition: LifecycleTransition; context: PortContext }> = [];
  const ports = {
    ...createMockPorts(),
    lifecycle: {
      protocolVersion: 2 as const,
      beginBatch: () => {
        const staged: typeof calls = [];
        return {
          apply: (transition: LifecycleTransition, context: PortContext) => {
            staged.push({
              transition: structuredClone(transition),
              context: structuredClone(context),
            });
            return {
              accepted: true,
              entityId: transition.entityId,
              transition: transition.transition,
              state: transition.replacement,
              reason: null,
            };
          },
          commit: () => {
            calls.push(...staged);
            return undefined;
          },
          rollback: () => undefined,
        };
      },
    },
  };
  const start = assertResumeCompatible(
    { scenario: sampleResolvedScenario, run: sampleRunningRun, ports },
    checkpoint,
    HASH_A,
  );
  const session = new IncrementalKernelSession(
    start,
    (event) => [lifecycleTrace(event, "enemy", "death")],
    view,
  );
  const result = session.step({ maxEvents: 1, untilTimeMs: null });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.transition.entityId).toBe("enemy");
  expect(calls[0]?.transition.transition).toBe("death");
  expect(calls[0]?.transition.replacement?.alive).toBe(false);
  expect(calls[0]?.context.timeMs).toBe(1000);
  expect(calls[0]?.context.sequence).toBe(checkpoint.queue.entries[0]?.sequence);
  expect(result.snapshot.entities.find((entity) => entity.entityId === "enemy")?.alive).toBe(false);
});

test("forged or rejected lifecycle port responses leave the checkpoint unchanged", () => {
  const checkpoint = deathCheckpoint();
  for (const apply of [
    (transition: LifecycleTransition) => ({
      accepted: true,
      entityId: transition.entityId,
      transition: transition.transition,
      state: checkpoint.entities.find((entity) => entity.entityId === "enemy")!,
      reason: null,
    }),
    (transition: LifecycleTransition) => ({
      accepted: false,
      entityId: transition.entityId,
      transition: transition.transition,
      state: null,
      reason: "lifecycle service rejected transition",
    }),
  ]) {
    let commits = 0;
    let rollbacks = 0;
    const start = assertResumeCompatible(
      {
        scenario: sampleResolvedScenario,
        run: sampleRunningRun,
        ports: {
          ...createMockPorts(),
          lifecycle: {
            protocolVersion: 2,
            beginBatch: () => ({
              apply,
              commit: () => {
                commits += 1;
                return undefined;
              },
              rollback: () => {
                rollbacks += 1;
                return undefined;
              },
            }),
          },
        },
      },
      checkpoint,
      HASH_A,
    );
    const session = new IncrementalKernelSession(
      start,
      (event) => [lifecycleTrace(event, "enemy", "death")],
      view,
    );
    const before = session.snapshot();
    expect(() => session.step({ maxEvents: 1, untilTimeMs: null })).toThrow();
    expect(session.snapshot()).toEqual(before);
    expect(commits).toBe(0);
    expect(rollbacks).toBe(1);
  }
});

test("invalid lifecycle trace or replacement rolls back the whole session step", () => {
  const checkpoint = deathCheckpoint();
  const wrongTrace = new IncrementalKernelSession(
    resume(checkpoint),
    (event) => [traceCommand(event)],
    view,
  );
  const initial = wrongTrace.snapshot();
  expect(() => wrongTrace.step({ maxEvents: 1, untilTimeMs: null })).toThrow("lifecycle trace");
  expect(wrongTrace.snapshot()).toEqual(initial);

  const bad = EngineSnapshotSchema.parse({
    ...checkpoint,
    queue: {
      ...checkpoint.queue,
      entries: checkpoint.queue.entries.map((event) => ({
        ...event,
        payload: {
          entityId: "enemy",
          transition: "death",
          replacement: checkpoint.entities.find((entity) => entity.entityId === "enemy"),
        },
      })),
    },
  });
  const invalid = new IncrementalKernelSession(
    resume(bad),
    (event) => [lifecycleTrace(event, "enemy", "death")],
    view,
  );
  const before = invalid.snapshot();
  expect(() => invalid.step({ maxEvents: 1, untilTimeMs: null })).toThrow("dead entity");
  expect(invalid.snapshot()).toEqual(before);

  const wrongPhase = EngineSnapshotSchema.parse({
    ...checkpoint,
    queue: {
      ...checkpoint.queue,
      entries: checkpoint.queue.entries.map((event) => ({ ...event, phase: "impact" })),
    },
  });
  const phaseSession = new IncrementalKernelSession(
    resume(wrongPhase),
    (event) => [lifecycleTrace(event, "enemy", "death")],
    view,
  );
  const phaseBefore = phaseSession.snapshot();
  expect(() => phaseSession.step({ maxEvents: 1, untilTimeMs: null })).toThrow("lifecycle phase");
  expect(phaseSession.snapshot()).toEqual(phaseBefore);
});

test("same-time lifecycle descendant failure rolls back an earlier death in the batch", () => {
  const checkpoint = deathCheckpoint();
  const published: string[] = [];
  const rolledBack: string[][] = [];
  const ports = {
    ...createMockPorts(),
    lifecycle: {
      protocolVersion: 2 as const,
      beginBatch: () => {
        const staged: string[] = [];
        return {
          apply: (transition: LifecycleTransition) => {
            staged.push(transition.transition);
            return {
              accepted: true,
              entityId: transition.entityId,
              transition: transition.transition,
              state: transition.replacement,
              reason: null,
            };
          },
          commit: () => {
            published.push(...staged);
            return undefined;
          },
          rollback: () => {
            rolledBack.push([...staged]);
            return undefined;
          },
        };
      },
    },
  };
  const enemy = checkpoint.entities.find((entity) => entity.entityId === "enemy")!;
  const dispatch = (event: ScheduledEvent): EngineCommand[] => {
    if (event.eventId === "event-004") return [traceCommand(event)];
    return [
      lifecycleTrace(event, "enemy", "death"),
      {
        schemaVersion: 1,
        kind: "schedule-event",
        commandId: "same-time-revive",
        issuedAtMs: event.timeMs,
        causeEventIds: [event.eventId],
        event: {
          eventId: "event-004",
          sequence: 4,
          timeMs: event.timeMs,
          phase: "lifecycle",
          kind: "lifecycle-transition",
          payload: { entityId: "enemy", transition: "revive", replacement: enemy },
          causeEventIds: [event.eventId],
        },
      },
    ];
  };
  const session = new IncrementalKernelSession(
    assertResumeCompatible(
      { scenario: sampleResolvedScenario, run: sampleRunningRun, ports },
      checkpoint,
      HASH_A,
    ),
    dispatch,
    view,
  );
  const before = session.snapshot();
  expect(() => session.step({ maxEvents: 2, untilTimeMs: null })).toThrow("lifecycle trace");
  expect(session.snapshot()).toEqual(before);
  expect(rolledBack).toEqual([["death"]]);
  expect(published).toEqual([]);
  const first = session.step({ maxEvents: 1, untilTimeMs: null });
  expect(published).toEqual(["death"]);
  expect(first.snapshot.entities.find((entity) => entity.entityId === "enemy")?.alive).toBe(false);
  expect(first.snapshot.queue.entries[0]?.timeMs).toBe(1000);
  expect(first.snapshot.queue.entries[0]?.sequence).toBe(4);
});

test("lifecycle publication failure leaves the validated kernel step uncommitted", () => {
  const checkpoint = deathCheckpoint();
  let rollbacks = 0;
  const ports = {
    ...createMockPorts(),
    lifecycle: {
      protocolVersion: 2 as const,
      beginBatch: () => ({
        apply: (transition: LifecycleTransition) => ({
          accepted: true,
          entityId: transition.entityId,
          transition: transition.transition,
          state: transition.replacement,
          reason: null,
        }),
        commit: (): undefined => {
          throw new Error("publication failed");
        },
        rollback: () => {
          rollbacks += 1;
          return undefined;
        },
      }),
    },
  };
  const session = new IncrementalKernelSession(
    assertResumeCompatible(
      { scenario: sampleResolvedScenario, run: sampleRunningRun, ports },
      checkpoint,
      HASH_A,
    ),
    (event) => [lifecycleTrace(event, "enemy", "death")],
    view,
  );
  const before = session.snapshot();
  expect(() => session.step({ maxEvents: 1, untilTimeMs: null })).toThrow("publication failed");
  expect(rollbacks).toBe(1);
  expect(session.snapshot()).toEqual(before);
});

test("lifecycle publication cannot reenter the uncommitted session frontier", () => {
  const checkpoint = deathCheckpoint();
  let reentryError: string | null = null;
  const ports = {
    ...createMockPorts(),
    lifecycle: {
      protocolVersion: 2 as const,
      beginBatch: () => ({
        apply: (transition: LifecycleTransition) => ({
          accepted: true,
          entityId: transition.entityId,
          transition: transition.transition,
          state: transition.replacement,
          reason: null,
        }),
        commit: () => {
          try {
            session.step({ maxEvents: 1, untilTimeMs: null });
          } catch (error) {
            reentryError = (error as Error).message;
          }
          return undefined;
        },
        rollback: () => undefined,
      }),
    },
  };
  const session = new IncrementalKernelSession(
    assertResumeCompatible(
      { scenario: sampleResolvedScenario, run: sampleRunningRun, ports },
      checkpoint,
      HASH_A,
    ),
    (event) => [lifecycleTrace(event, "enemy", "death")],
    view,
  );
  const result = session.step({ maxEvents: 1, untilTimeMs: null });
  expect(String(reentryError)).toContain("already running");
  expect(
    result.snapshot.trace.events.filter((event) => event.eventId === "event-003"),
  ).toHaveLength(1);
  expect(session.snapshot()).toEqual(result.snapshot);
});
