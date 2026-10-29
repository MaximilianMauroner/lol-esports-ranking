import type {
  CombatKernelPorts,
  LifecycleTransition,
  PortContext,
  TargetingRequest,
  Trace,
} from "../../../src/domains/dps/contracts/index.ts";

/** A deterministic, side-effect-free port set for contract consumers. */
export function createMockPorts(): CombatKernelPorts {
  const tracesByRunId = new Map<string, Trace>();
  const scheduledByRunId = new Map<
    string,
    Map<string, import("../../../src/domains/dps/contracts/index.ts").ScheduledEvent>
  >();
  const resourceValues = new Map<string, { current: number; maximum: number }>();
  const rngDrawCounts = new Map<string, number>();
  const lifecycleEntitiesByRunId = new Map<
    string,
    Map<string, import("../../../src/domains/dps/contracts/index.ts").EntityState>
  >();
  const cloneTrace = (trace: Trace): Trace => structuredClone(trace);
  const timersFor = (runId: string) => {
    const existing = scheduledByRunId.get(runId);
    if (existing) return existing;
    const created = new Map<string, import("../../../src/domains/dps/contracts/index.ts").ScheduledEvent>();
    scheduledByRunId.set(runId, created);
    return created;
  };

  return {
    stats: {
      resolve: ({ entity, read }) => ({
        entityId: entity.entityId,
        revision: read.stateRevision,
        values: { ...entity.stats },
      }),
    },
    damage: {
      resolve: ({ packet, target }) => {
        const attempted = packet.rawAmount;
        const absorbed = Math.min(attempted, target.health.shield);
        const afterShield = attempted - absorbed;
        const applied = Math.min(afterShield, target.health.current);
        return {
          attempted,
          absorbed,
          prevented: 0,
          applied,
          overkill: packet.canOverkill ? afterShield - applied : 0,
          discarded: packet.canOverkill ? 0 : afterShield - applied,
          targetHealthAfter: target.health.current - applied,
          killed: target.health.current - applied <= 0,
        };
      },
    },
    resources: {
      restore: (entity, context) => {
        for (const resource of entity.resources) {
          resourceValues.set(
            `${context.runId}\u0000${entity.entityId}\u0000${resource.resourceId}`,
            {
              current: resource.current,
              maximum: resource.maximum,
            },
          );
        }
      },
      apply: (mutation, context) => {
        const key = `${context.runId}\u0000${mutation.entityId}\u0000${mutation.resourceId}`;
        const restored = resourceValues.get(key) ?? { current: 100, maximum: 100 };
        const previous = restored.current;
        const current = Math.min(restored.maximum, Math.max(0, previous + mutation.delta));
        resourceValues.set(key, { ...restored, current });
        return {
          accepted: true,
          entityId: mutation.entityId,
          resourceId: mutation.resourceId,
          previous,
          current,
          reason: null,
        };
      },
    },
    timers: {
      schedule: ({ event, replacesEventId }, context) => {
        const scheduled = timersFor(context.runId);
        if (replacesEventId !== null) scheduled.delete(replacesEventId);
        scheduled.set(event.eventId, structuredClone(event));
      },
      cancel: (eventId, context) => timersFor(context.runId).delete(eventId),
      peek: (context) => {
        const next = [...timersFor(context.runId).values()].sort(
          (left, right) => left.timeMs - right.timeMs || left.sequence - right.sequence,
        )[0];
        return next ? structuredClone(next) : null;
      },
    },
    movement: {
      move: ({ entity, destination }) => ({
        entityId: entity.entityId,
        accepted: true,
        position: destination,
        reason: null,
      }),
    },
    targeting: {
      select: (request: TargetingRequest) => {
        const enemies = request.visibleState.entities.filter(
          (entity) => entity.team === "enemy" && entity.alive,
        );
        const targetEntityIds =
          request.selector.kind === "entity"
            ? [request.selector.entityId]
            : request.selector.kind === "self"
              ? [request.selector.actorId]
              : request.selector.kind === "lowest-health-visible-enemy"
                ? enemies
                    .sort((left, right) => {
                      const healthDifference =
                        left.health.current / left.health.maximum -
                        right.health.current / right.health.maximum;
                      if (healthDifference !== 0) return healthDifference;
                      return left.entityId < right.entityId
                        ? -1
                        : left.entityId > right.entityId
                          ? 1
                          : 0;
                    })
                    .slice(0, 1)
                    .map((entity) => entity.entityId)
                : enemies.map((entity) => entity.entityId);
        if (request.selector.kind === "lowest-health-visible-enemy" && targetEntityIds.length === 0)
          return { targetEntityIds: [], rejected: true, reason: "no living visible enemy" };
        return { targetEntityIds, rejected: false, reason: null };
      },
    },
    lifecycle: {
      protocolVersion: 2,
      beginBatch: (snapshot) => {
        const staged = new Map(
          snapshot.entities.map((entity) => [entity.entityId, structuredClone(entity)]),
        );
        let open = true;
        return {
          apply: (transition: LifecycleTransition, context: PortContext) => {
            if (!open || context.runId !== snapshot.runId)
              throw new TypeError("lifecycle batch is closed or belongs to another run");
            if (transition.replacement === null) staged.delete(transition.entityId);
            else staged.set(transition.entityId, structuredClone(transition.replacement));
            return {
              accepted: true,
              entityId: transition.entityId,
              transition: transition.transition,
              state: transition.replacement,
              reason: null,
            };
          },
          commit: () => {
            if (!open) throw new TypeError("lifecycle batch is closed");
            lifecycleEntitiesByRunId.set(snapshot.runId, staged);
            open = false;
            return undefined;
          },
          rollback: () => {
            open = false;
            return undefined;
          },
        };
      },
    },
    triggers: {
      dispatch: () => ({ accepted: true, emittedCommands: [], reason: null }),
    },
    rng: {
      restore: (snapshot, context) => {
        rngDrawCounts.set(`${context.runId}\u0000${snapshot.streamId}`, snapshot.drawCount);
      },
      draw: ({ streamId, draws }, context) => {
        const key = `${context.runId}\u0000${streamId}`;
        const nextDrawCount = (rngDrawCounts.get(key) ?? 0) + draws;
        rngDrawCounts.set(key, nextDrawCount);
        return {
          streamId,
          values: Array.from({ length: draws }, () => 0.5),
          nextDrawCount,
        };
      },
    },
    trace: {
      restore: (trace, context) => {
        tracesByRunId.set(context.runId, cloneTrace(trace));
      },
      record: (event, context) => {
        const trace = tracesByRunId.get(context.runId) ?? {
          schemaVersion: 1,
          traceId: `trace-${context.runId}`,
          runId: context.runId,
          events: [],
          truncated: false,
          truncationReason: null,
        };
        tracesByRunId.set(
          context.runId,
          cloneTrace({ ...trace, events: [...trace.events, structuredClone(event)] }),
        );
      },
      snapshot: (runId) => {
        const trace = tracesByRunId.get(runId);
        return trace
          ? cloneTrace(trace)
          : {
              schemaVersion: 1,
              traceId: `trace-${runId}`,
              runId,
              events: [],
              truncated: false,
              truncationReason: null,
            };
      },
    },
  };
}

export const mockPortContext: PortContext = {
  runId: "run-001",
  timeMs: 0,
  sequence: 1,
  causeEventIds: [],
  nextEventSequence: 2,
  allocatedEventIds: [],
};
