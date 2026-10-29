import {
  assertResumableSnapshot,
  canonicalJson,
  DamageResolutionSchema,
  EngineRunSchema,
  EngineCommandSchema,
  EngineStepResultSchema,
  LifecycleResolutionSchema,
  isRuntimeVerifiedResolvedScenario,
  parseContract,
  ResolvedScenarioSchema,
  ResourceResolutionSchema,
  RngResultSchema,
  ScheduledEventSchema,
  PositionSchema,
  RunManifestSchema,
  StatsSnapshotSchema,
  type CombatResult,
  type DamagePacket,
  type DamageResolution,
  type EngineCommand,
  type EngineEvent,
  type EngineStepResult,
  type EngineSnapshot,
  type EngineRun,
  type EntityState,
  type ExactComparisonTransfer,
  type ItemInstance,
  type HashVerifiedResolvedScenario,
  type PolicyVisibleState,
  type RunManifest,
  type RngStreamSnapshot,
  type ScheduledEvent,
  type StepBudget,
  type StatsSnapshot,
  type TargetSelector,
  type Trace,
  type TraceEvent,
} from "./schemas.ts";

/**
 * Port calls are synchronous and deterministic from the engine's point of
 * view. Implementations may be backed by a worker or a database adapter, but
 * wall-clock reads and network calls stay outside combat decisions.
 */
export type PortContext = Readonly<{
  runId: string;
  timeMs: number;
  sequence: number;
  causeEventIds: readonly string[];
  nextEventSequence: number;
  allocatedEventIds: readonly string[];
}>;

const SCALE_RELATIVE_TOLERANCE = 1e-12;

function scaleAwareEqual(left: number, right: number): boolean {
  if (left === right) return true;
  return (
    Math.abs(left - right) <= SCALE_RELATIVE_TOLERANCE * Math.max(Math.abs(left), Math.abs(right))
  );
}

export type StateRead = Readonly<{
  kind: "snapshot" | "impact";
  entityId: string;
  atTimeMs: number;
  stateRevision: number;
}>;

export type StatsRequest = Readonly<{
  entity: EntityState;
  read: StateRead;
}>;

export function assertStatsSnapshot(
  request: StatsRequest,
  context: PortContext,
  value: unknown,
): StatsSnapshot {
  if (
    request.read.entityId !== request.entity.entityId ||
    request.read.atTimeMs !== context.timeMs
  ) {
    throw new TypeError(
      "stats read entity and time must match the requested entity and port clock",
    );
  }
  const snapshot = parseContract(StatsSnapshotSchema, value);
  if (
    snapshot.entityId !== request.entity.entityId ||
    snapshot.revision !== request.read.stateRevision
  ) {
    throw new TypeError("stats snapshot must match the requested entity and state revision");
  }
  for (const key of Object.keys(request.entity.stats)) {
    if (!Object.hasOwn(snapshot.values, key))
      throw new TypeError("stats snapshot must retain every authoritative baseline stat");
  }
  return snapshot;
}

export interface StatsPort {
  resolve(request: StatsRequest, context: PortContext): StatsSnapshot;
}

export type DamageRequest = Readonly<{
  packet: DamagePacket;
  attacker: EntityState;
  target: EntityState;
  attackerStats: StatsSnapshot;
  targetStats: StatsSnapshot;
  attackerRead: StateRead;
  read: StateRead;
}>;

export interface DamagePort {
  resolve(request: DamageRequest, context: PortContext): DamageResolution;
}

export function assertDamageResolution(
  request: DamageRequest,
  context: PortContext,
  value: unknown,
): DamageResolution {
  if (
    request.packet.sourceEntityId !== request.attacker.entityId ||
    request.packet.targetEntityId !== request.target.entityId ||
    request.attackerStats.entityId !== request.attacker.entityId ||
    request.attackerRead.kind !== "impact" ||
    request.attackerRead.entityId !== request.attacker.entityId ||
    request.attackerStats.revision !== request.attackerRead.stateRevision ||
    request.attackerRead.atTimeMs !== context.timeMs ||
    request.targetStats.entityId !== request.target.entityId ||
    request.read.kind !== "impact" ||
    request.targetStats.revision !== request.read.stateRevision ||
    request.read.entityId !== request.target.entityId ||
    request.read.atTimeMs !== context.timeMs
  ) {
    throw new TypeError("damage request identities must agree");
  }
  if (!request.target.alive) throw new TypeError("damage requests require a living target");
  const resolution = parseContract(DamageResolutionSchema, value);
  const rawPostMitigation = request.packet.rawAmount - resolution.prevented;
  const preventionExceedsPacket =
    resolution.prevented > request.packet.rawAmount &&
    !scaleAwareEqual(resolution.prevented, request.packet.rawAmount);
  const postMitigation = Math.max(0, rawPostMitigation);
  const expectedAbsorbed = Math.min(postMitigation, request.target.health.shield);
  const postShield = postMitigation - expectedAbsorbed;
  const expectedApplied = Math.min(postShield, request.target.health.current);
  const expectedOverkill = request.packet.canOverkill ? postShield - expectedApplied : 0;
  const expectedDiscarded = request.packet.canOverkill ? 0 : postShield - expectedApplied;
  const expectedHealth = request.target.health.current - expectedApplied;
  if (
    resolution.attempted !== request.packet.rawAmount ||
    preventionExceedsPacket ||
    !scaleAwareEqual(resolution.absorbed, expectedAbsorbed) ||
    !scaleAwareEqual(resolution.applied, expectedApplied) ||
    !scaleAwareEqual(resolution.overkill, expectedOverkill) ||
    !scaleAwareEqual(resolution.discarded, expectedDiscarded) ||
    !scaleAwareEqual(resolution.targetHealthAfter, expectedHealth) ||
    resolution.killed !== (expectedHealth === 0)
  ) {
    throw new TypeError("damage resolution must match the requested packet and target state");
  }
  return resolution;
}

export type ResourceMutation = Readonly<{
  entityId: string;
  resourceId: string;
  delta: number;
  reason: string;
}>;

export type ResourceResolution = Readonly<{
  accepted: boolean;
  entityId: string;
  resourceId: string;
  previous: number;
  current: number;
  reason: string | null;
}>;

export interface ResourcePort {
  restore(entity: EntityState, context: PortContext): void;
  apply(mutation: ResourceMutation, context: PortContext): ResourceResolution;
}

export function assertResourceResolution(
  mutation: ResourceMutation,
  entity: EntityState,
  value: unknown,
): ResourceResolution {
  const resource = entity.resources.find(
    (candidate) => candidate.resourceId === mutation.resourceId,
  );
  if (entity.entityId !== mutation.entityId || !resource)
    throw new TypeError("resource state must belong to the mutated entity");
  if (!Number.isFinite(mutation.delta))
    throw new TypeError("resource mutation delta must be finite");
  const result = parseContract(ResourceResolutionSchema, value);
  const expected = result.accepted
    ? Math.min(resource.maximum, Math.max(0, resource.current + mutation.delta))
    : resource.current;
  if (
    result.entityId !== mutation.entityId ||
    result.resourceId !== mutation.resourceId ||
    result.resourceId !== resource.resourceId ||
    !scaleAwareEqual(result.previous, resource.current) ||
    !scaleAwareEqual(result.current, expected) ||
    result.current > resource.maximum
  )
    throw new TypeError("resource resolution must be finite and match the requested mutation");
  return result;
}

export type TimerSchedule = Readonly<{
  event: ScheduledEvent;
  replacesEventId: string | null;
}>;

export interface TimerPort {
  schedule(request: TimerSchedule, context: PortContext): void;
  cancel(eventId: string, context: PortContext): boolean;
  peek(context: PortContext): ScheduledEvent | null;
}

export function assertTimerCancelResult(value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError("timer cancellation result must be boolean");
  return value;
}

export function assertTimerPeekResult(context: PortContext, value: unknown): ScheduledEvent | null {
  if (value === null) return null;
  const event = parseContract(ScheduledEventSchema, value);
  if (
    event.timeMs < context.timeMs ||
    (event.timeMs === context.timeMs && event.sequence <= context.sequence)
  )
    throw new TypeError("peeked timer must follow the full port ordering key");
  return event;
}

export type MovementRequest = Readonly<{
  entity: EntityState;
  destination: Readonly<{ x: number; y: number; z: number }>;
  read: StateRead;
}>;

export type MovementResolution = Readonly<{
  entityId: string;
  accepted: boolean;
  position: Readonly<{ x: number; y: number; z: number }>;
  reason: string | null;
}>;

export interface MovementPort {
  move(request: MovementRequest, context: PortContext): MovementResolution;
}

export function assertMovementResolution(
  request: MovementRequest,
  context: PortContext,
  value: unknown,
): MovementResolution {
  canonicalJson(value);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("movement resolution must be a strict object");
  const result = value as Partial<MovementResolution>;
  if (
    Object.keys(value).length !== 4 ||
    !Object.hasOwn(value, "entityId") ||
    !Object.hasOwn(value, "accepted") ||
    !Object.hasOwn(value, "position") ||
    !Object.hasOwn(value, "reason")
  )
    throw new TypeError("movement resolution must contain only declared fields");
  const position = parseContract(PositionSchema, result.position);
  if (
    request.read.entityId !== request.entity.entityId ||
    request.read.atTimeMs !== context.timeMs ||
    result.entityId !== request.entity.entityId ||
    typeof result.accepted !== "boolean" ||
    (result.reason !== null && (typeof result.reason !== "string" || result.reason.length === 0)) ||
    result.accepted !== (result.reason === null) ||
    canonicalJson(position) !==
      canonicalJson(result.accepted ? request.destination : request.entity.position)
  )
    throw new TypeError(
      "movement resolution must match the requested entity, read, destination, and acceptance",
    );
  return {
    entityId: result.entityId,
    accepted: result.accepted,
    position,
    reason: result.reason,
  } as MovementResolution;
}

export type TargetingRequest = Readonly<{
  actor: EntityState;
  selector: TargetSelector;
  visibleState: PolicyVisibleState;
  /** Copied from the hash-verified resolved scenario policy, not derived from visibleState. */
  expectedVisibleEntityIds: readonly string[];
}>;

export type TargetingResolution = Readonly<{
  targetEntityIds: readonly string[];
  rejected: boolean;
  reason: string | null;
}>;

export interface TargetingPort {
  select(request: TargetingRequest, context: PortContext): TargetingResolution;
}

export function assertTargetingResolution(
  request: TargetingRequest,
  context: PortContext,
  value: unknown,
): TargetingResolution {
  if (
    request.actor.entityId !== request.visibleState.actorEntityId ||
    ("actorId" in request.selector && request.selector.actorId !== request.actor.entityId) ||
    request.visibleState.atTimeMs !== context.timeMs
  ) {
    throw new TypeError("targeting request actor, selector, and context time must agree");
  }
  if (
    canonicalJson([...request.visibleState.visibility.visibleEntityIds].sort()) !==
    canonicalJson([...request.expectedVisibleEntityIds].sort())
  ) {
    throw new TypeError("policy view visibility must match the scenario allowlist");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("targeting resolution must be a strict object");
  }
  canonicalJson(value);
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !keys.includes("targetEntityIds") ||
    !keys.includes("rejected") ||
    !keys.includes("reason")
  ) {
    throw new TypeError("targeting resolution must contain only declared fields");
  }
  const result = value as Partial<TargetingResolution>;
  if (
    !Array.isArray(result.targetEntityIds) ||
    typeof result.rejected !== "boolean" ||
    (result.reason !== null && (typeof result.reason !== "string" || result.reason.length === 0)) ||
    result.rejected !== (result.reason !== null)
  ) {
    throw new TypeError("targeting resolution rejection and reason must correlate");
  }
  if (result.rejected && result.targetEntityIds.length > 0) {
    throw new TypeError("rejected targeting resolutions must return no targets");
  }
  const visible = new Set(request.visibleState.entities.map((entity) => entity.entityId));
  if (result.targetEntityIds.some((id) => typeof id !== "string" || !visible.has(id))) {
    throw new TypeError("targeting selections must reference visible entities");
  }
  const expected =
    request.selector.kind === "self"
      ? request.selector.actorId
      : request.selector.kind === "entity"
        ? request.selector.entityId
        : null;
  let dynamicExpected: string[] | null = null;
  const livingEnemies = request.visibleState.entities.filter(
    (entity) => entity.team === "enemy" && entity.alive,
  );
  if (request.selector.kind === "all-visible-enemies") {
    dynamicExpected = livingEnemies.map((entity) => entity.entityId);
  } else if (request.selector.kind === "lowest-health-visible-enemy") {
    dynamicExpected = livingEnemies
      .sort((left, right) => {
        const difference =
          left.health.current / left.health.maximum - right.health.current / right.health.maximum;
        if (difference !== 0) return difference;
        return left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0;
      })
      .slice(0, 1)
      .map((entity) => entity.entityId);
  }
  if (
    !result.rejected &&
    expected !== null &&
    (result.targetEntityIds.length !== 1 || result.targetEntityIds[0] !== expected)
  ) {
    throw new TypeError("targeting selection must match explicit selector semantics");
  }
  if (
    !result.rejected &&
    dynamicExpected !== null &&
    canonicalJson(result.targetEntityIds) !== canonicalJson(dynamicExpected)
  ) {
    throw new TypeError("targeting selection must match dynamic selector semantics");
  }
  if (
    request.selector.kind === "lowest-health-visible-enemy" &&
    livingEnemies.length === 0 &&
    !result.rejected
  )
    throw new TypeError("singular enemy targeting must reject when no living enemy exists");
  return Object.freeze({
    targetEntityIds: Object.freeze([...result.targetEntityIds]),
    rejected: result.rejected,
    reason: result.reason,
  }) as TargetingResolution;
}

export type LifecycleTransition = Readonly<{
  entityId: string;
  transition: "spawn" | "despawn" | "death" | "revive" | "transform";
  replacement: EntityState | null;
}>;

export type LifecycleResolution = Readonly<{
  accepted: boolean;
  entityId: string;
  transition: LifecycleTransition["transition"];
  state: EntityState | null;
  reason: string | null;
}>;

/** Port-only revision; serialized combat and snapshot schemas remain at version 1. */
export const LIFECYCLE_PORT_PROTOCOL_VERSION = 2 as const;

/** A single speculative engine step. Effects are private until commit succeeds. */
export interface LifecycleBatch {
  apply(transition: LifecycleTransition, context: PortContext): LifecycleResolution;
  /** Publishes every staged transition atomically, exactly once. A throwing commit publishes none. */
  commit(): undefined;
  /** Discards all staged transitions, including after a failed commit. */
  rollback(): undefined;
}

export interface LifecyclePort {
  readonly protocolVersion: typeof LIFECYCLE_PORT_PROTOCOL_VERSION;
  /** Must not publish effects; the snapshot is detached from the session's retained state. */
  beginBatch(snapshot: Readonly<EngineSnapshot>): LifecycleBatch;
}

export function assertLifecyclePortProtocol(value: unknown): asserts value is LifecyclePort {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    (value as Partial<LifecyclePort>).protocolVersion !== LIFECYCLE_PORT_PROTOCOL_VERSION ||
    typeof (value as Partial<LifecyclePort>).beginBatch !== "function"
  ) {
    throw new TypeError("lifecycle port requires transaction protocol version 2");
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isNativeAsyncFunction(value: unknown): boolean {
  return Object.prototype.toString.call(value) === "[object AsyncFunction]";
}

function rejectThenable(
  value: unknown,
  message: string,
  onFulfilled: (value: unknown) => void = () => undefined,
): void {
  if (!isThenable(value)) return;
  // Observe both outcomes even though this synchronous boundary rejects the call.
  void Promise.resolve(value)
    .then(onFulfilled, () => undefined)
    .catch(() => undefined);
  throw new TypeError(message);
}

function requireUndefinedLifecycleReturn(value: unknown, operation: "commit" | "rollback"): void {
  const message = `lifecycle ${operation} must be synchronous and return undefined`;
  rejectThenable(value, message);
  if (value !== undefined) throw new TypeError(message);
}

/**
 * Runs the entire speculative step, including result validation, before publishing
 * lifecycle effects. The callback sees only apply, never commit or rollback.
 */
export function withLifecycleBatch<T>(
  port: LifecyclePort,
  snapshot: Readonly<EngineSnapshot>,
  work: (stage: Pick<LifecycleBatch, "apply">) => T extends PromiseLike<unknown> ? never : T,
): T {
  assertLifecyclePortProtocol(port);
  if (isNativeAsyncFunction(port.beginBatch))
    throw new TypeError("lifecycle beginBatch must be synchronous");
  const batch = port.beginBatch(structuredClone(snapshot));
  // Capture rollback before inspecting any other handle property. A getter may
  // throw after beginBatch has allocated private resources.
  const rollback =
    batch !== null && (typeof batch === "object" || typeof batch === "function")
      ? (batch as Partial<LifecycleBatch>).rollback
      : undefined;
  let open = true;
  let failed = false;
  let firstFailure: unknown;
  try {
    rejectThenable(batch, "lifecycle beginBatch must be synchronous", (opened) => {
      if (opened === null || (typeof opened !== "object" && typeof opened !== "function")) return;
      try {
        const lateRollback = (opened as Partial<LifecycleBatch>).rollback;
        if (typeof lateRollback !== "function") return;
        const result = lateRollback.call(opened);
        if (isThenable(result)) void Promise.resolve(result).catch(() => undefined);
      } catch {
        // The invalid async adapter is already rejected; cleanup is best effort.
      }
    });
    if (batch === null || (typeof batch !== "object" && typeof batch !== "function"))
      throw new TypeError("lifecycle port must open a complete transaction");
    const apply = batch.apply;
    const commit = batch.commit;
    if (
      typeof apply !== "function" ||
      typeof commit !== "function" ||
      typeof rollback !== "function"
    )
      throw new TypeError("lifecycle port must open a complete transaction");
    if (isNativeAsyncFunction(rollback))
      throw new TypeError("lifecycle rollback must be synchronous");
    const asyncCommit = isNativeAsyncFunction(commit);
    const stage = Object.freeze({
      apply: (transition: LifecycleTransition, context: PortContext) => {
        if (!open) throw new TypeError("lifecycle batch is closed");
        if (failed) throw new TypeError("lifecycle batch has already failed");
        try {
          if (context.runId !== snapshot.runId)
            throw new TypeError("lifecycle batch context must match the snapshot run");
          if (isNativeAsyncFunction(apply))
            throw new TypeError("lifecycle apply must finish synchronously");
          const resolution = apply.call(
            batch,
            structuredClone(transition),
            structuredClone(context),
          );
          rejectThenable(resolution, "lifecycle apply must finish synchronously");
          return resolution;
        } catch (error) {
          failed = true;
          firstFailure = error;
          throw error;
        }
      },
    });
    if (asyncCommit) throw new TypeError("lifecycle commit must be synchronous");
    if (
      /^\[object (?:GeneratorFunction|AsyncGeneratorFunction)\]$/.test(
        Object.prototype.toString.call(work),
      )
    )
      throw new TypeError("lifecycle batches must finish synchronously");
    const result = work(stage);
    rejectThenable(result, "lifecycle batches must finish synchronously");
    if (/^\[object (?:Generator|AsyncGenerator)\]$/.test(Object.prototype.toString.call(result)))
      throw new TypeError("lifecycle batches must finish synchronously");
    if (failed) throw firstFailure;
    open = false;
    requireUndefinedLifecycleReturn(commit.call(batch), "commit");
    return result;
  } catch (error) {
    open = false;
    if (typeof rollback !== "function") throw error;
    try {
      const result = rollback.call(batch);
      if (isNativeAsyncFunction(rollback)) {
        if (isThenable(result)) void Promise.resolve(result).catch(() => undefined);
      } else {
        requireUndefinedLifecycleReturn(result, "rollback");
      }
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "lifecycle batch rollback failed", { cause: rollbackError });
    }
    throw error;
  }
}

export function assertLifecycleResolution(
  transition: LifecycleTransition,
  entities: readonly EntityState[],
  value: unknown,
): LifecycleResolution {
  const entityExists = entities.some((entity) => entity.entityId === transition.entityId);
  const existingEntity = entities.find((entity) => entity.entityId === transition.entityId);
  if (
    (transition.transition === "spawn" && entityExists) ||
    (transition.transition !== "spawn" && !entityExists)
  ) {
    throw new TypeError("lifecycle transition must match authoritative entity existence");
  }
  if (transition.transition === "revive" && existingEntity?.alive)
    throw new TypeError("revive transitions require an existing dead entity");
  if (transition.transition === "death" && !existingEntity?.alive)
    throw new TypeError("death transitions require an existing living entity");
  if (transition.replacement !== null && transition.replacement.entityId !== transition.entityId) {
    throw new TypeError("lifecycle replacement identity must match the transition entity");
  }
  if (
    transition.transition === "revive" &&
    transition.replacement !== null &&
    (!transition.replacement.alive || transition.replacement.health.current <= 0)
  ) {
    throw new TypeError("revive replacement must be alive with positive health");
  }
  if (
    transition.transition === "death" &&
    (transition.replacement === null ||
      transition.replacement.alive ||
      transition.replacement.health.current !== 0)
  ) {
    throw new TypeError("death replacement must preserve a dead entity with zero health");
  }
  if (
    transition.transition === "transform" &&
    transition.replacement !== null &&
    existingEntity?.alive !== transition.replacement.alive
  ) {
    throw new TypeError("transform replacements must preserve entity liveness");
  }
  if (transition.replacement !== null) {
    const knownIds = new Set([...entities.map((entity) => entity.entityId), transition.entityId]);
    if (
      (transition.replacement.ownerEntityId !== null &&
        !knownIds.has(transition.replacement.ownerEntityId)) ||
      transition.replacement.buffs.some((buff) => !knownIds.has(buff.sourceEntityId)) ||
      transition.replacement.abilities.some(
        (ability) =>
          ability.origin.kind === "copied" && !knownIds.has(ability.origin.sourceEntityId),
      )
    ) {
      throw new TypeError("lifecycle replacement references must resolve in the world");
    }
  }
  const resulting = new Map(entities.map((entity) => [entity.entityId, entity]));
  if (transition.replacement === null) resulting.delete(transition.entityId);
  else resulting.set(transition.entityId, transition.replacement);
  for (const entity of resulting.values()) {
    if (
      (entity.ownerEntityId !== null && !resulting.has(entity.ownerEntityId)) ||
      entity.buffs.some((buff) => !resulting.has(buff.sourceEntityId)) ||
      entity.abilities.some(
        (ability) =>
          ability.origin.kind === "copied" && !resulting.has(ability.origin.sourceEntityId),
      )
    )
      throw new TypeError("lifecycle result cannot leave dangling entity references");
    const visited = new Set<string>([entity.entityId]);
    let ownerId = entity.ownerEntityId;
    while (ownerId !== null) {
      if (visited.has(ownerId))
        throw new TypeError("lifecycle replacement ownership cannot create cycles");
      visited.add(ownerId);
      ownerId = resulting.get(ownerId)?.ownerEntityId ?? null;
    }
  }
  if (
    (["spawn", "revive", "transform"].includes(transition.transition) &&
      transition.replacement === null) ||
    (transition.transition === "despawn" && transition.replacement !== null)
  ) {
    throw new TypeError("lifecycle replacement must match transition semantics");
  }
  const result = parseContract(LifecycleResolutionSchema, value);
  if (result.entityId !== transition.entityId || result.transition !== transition.transition) {
    throw new TypeError("lifecycle resolution must match the requested identity and transition");
  }
  if (
    (result.accepted && canonicalJson(result.state) !== canonicalJson(transition.replacement)) ||
    (!result.accepted && result.state !== null)
  ) {
    throw new TypeError("lifecycle resolution state must match the accepted request");
  }
  return result;
}

export type TriggerDispatch = Readonly<{
  triggerId: string;
  ownerEntityId: string;
  event: EngineEvent;
}>;

export type TriggerDispatchResult = Readonly<{
  accepted: boolean;
  emittedCommands: readonly EngineCommand[];
  reason: string | null;
}>;

export interface TriggerPort {
  dispatch(request: TriggerDispatch, context: PortContext): TriggerDispatchResult;
}

export function assertTriggerDispatchResult(
  request: TriggerDispatch,
  context: PortContext,
  value: unknown,
): TriggerDispatchResult {
  if (
    request.event.timeMs !== context.timeMs ||
    request.event.sequence !== context.sequence ||
    canonicalJson([...request.event.causeEventIds].sort()) !==
      canonicalJson([...context.causeEventIds].sort())
  )
    throw new TypeError("trigger event time, sequence, and causes must match the port context");
  canonicalJson(value);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("trigger result must be a strict object");
  const result = value as Partial<TriggerDispatchResult>;
  if (
    Object.keys(value).length !== 3 ||
    !Object.hasOwn(value, "accepted") ||
    !Object.hasOwn(value, "emittedCommands") ||
    !Object.hasOwn(value, "reason")
  )
    throw new TypeError("trigger result must contain only declared fields");
  if (
    !Array.isArray(result.emittedCommands) ||
    typeof result.accepted !== "boolean" ||
    (result.reason !== null && (typeof result.reason !== "string" || result.reason.length === 0)) ||
    result.accepted !== (result.reason === null) ||
    (!result.accepted && result.emittedCommands.length > 0)
  )
    throw new TypeError("trigger result acceptance, reason, and commands must correlate");
  const commands = result.emittedCommands.map((command) =>
    parseContract(EngineCommandSchema, command),
  );
  if (!Number.isSafeInteger(context.nextEventSequence) || context.nextEventSequence <= 0)
    throw new TypeError("trigger allocation frontier must provide a positive safe sequence");
  if (new Set(commands.map((command) => command.commandId)).size !== commands.length)
    throw new TypeError("trigger command IDs must be unique within a batch");
  const allocatedEvents = commands
    .filter((command) => command.kind === "schedule-event" || command.kind === "trace")
    .map((command) => command.event);
  if (
    new Set(allocatedEvents.map((event) => event.eventId)).size !== allocatedEvents.length ||
    new Set(allocatedEvents.map((event) => event.sequence)).size !== allocatedEvents.length
  )
    throw new TypeError(
      "trigger scheduled event IDs and sequences must be unique within a batch, including trace events",
    );
  for (const command of commands) {
    const allowedCauses = new Set([...context.causeEventIds, request.event.eventId]);
    if (
      command.issuedAtMs !== context.timeMs ||
      !command.causeEventIds.includes(request.event.eventId) ||
      command.causeEventIds.some((causeEventId) => !allowedCauses.has(causeEventId)) ||
      ((command.kind === "schedule-event" || command.kind === "trace") &&
        command.event.causeEventIds.some((causeEventId) => !allowedCauses.has(causeEventId))) ||
      ((command.kind === "schedule-event" || command.kind === "trace") &&
        command.event.sequence <= context.sequence)
    ) {
      throw new TypeError("trigger commands must preserve dispatch timing and causal identity");
    }
  }
  const allocatedEventIds = new Set([...context.allocatedEventIds, request.event.eventId]);
  if (
    allocatedEvents.some(
      (event) => allocatedEventIds.has(event.eventId) || event.sequence < context.nextEventSequence,
    )
  )
    throw new TypeError("trigger events must allocate beyond the queue frontier without ID reuse");
  return {
    accepted: result.accepted,
    emittedCommands: commands,
    reason: result.reason,
  } as TriggerDispatchResult;
}

export type RngRequest = Readonly<{
  streamId: string;
  draws: number;
}>;

export type RngResult = Readonly<{
  streamId: string;
  values: readonly number[];
  nextDrawCount: number;
}>;

export function assertRngResult(
  request: RngRequest,
  previousDrawCount: number,
  value: unknown,
): RngResult {
  const result = parseContract(RngResultSchema, value);
  if (
    result.streamId !== request.streamId ||
    result.values.length !== request.draws ||
    result.nextDrawCount !== previousDrawCount + request.draws
  ) {
    throw new TypeError(
      "RNG result must match the requested stream, draw count, and cumulative counter",
    );
  }
  return result;
}

export interface RngPort {
  restore(snapshot: RngStreamSnapshot, context: PortContext): void;
  draw(request: RngRequest, context: PortContext): RngResult;
}

export interface TracePort {
  restore(trace: Trace, context: PortContext): void;
  record(event: TraceEvent, context: PortContext): void;
  snapshot(runId: string): Trace;
}

export type CombatKernelPorts = Readonly<{
  stats: StatsPort;
  damage: DamagePort;
  resources: ResourcePort;
  timers: TimerPort;
  movement: MovementPort;
  targeting: TargetingPort;
  lifecycle: LifecyclePort;
  triggers: TriggerPort;
  rng: RngPort;
  trace: TracePort;
}>;

export type EngineInput = Readonly<{
  scenario: HashVerifiedResolvedScenario;
  run: RunManifest;
  ports: CombatKernelPorts;
}>;

declare const validatedEngineInput: unique symbol;

/** Frozen input returned only after replay-affecting identities are validated. */
export type ValidatedEngineInput = EngineInput & Readonly<{ [validatedEngineInput]: true }>;

declare const validatedResume: unique symbol;
export type ValidatedResume = Readonly<{
  input: ValidatedEngineInput;
  snapshot: EngineSnapshot;
  [validatedResume]: true;
}>;

export class ResumeCompatibilityError extends Error {
  readonly mismatches: readonly string[];

  constructor(mismatches: readonly string[]) {
    super(`resume compatibility failed: ${mismatches.join("; ")}`);
    this.name = "ResumeCompatibilityError";
    this.mismatches = mismatches;
  }
}

function engineInputMismatches(
  scenario: ReturnType<typeof ResolvedScenarioSchema.parse>,
  run: RunManifest,
): string[] {
  const mismatches: string[] = [];
  if (run.resolvedScenarioHash !== scenario.resolvedScenarioHash)
    mismatches.push("run and scenario resolvedScenarioHash differ");
  if (run.rulesetHash !== scenario.effective.rulesetManifestHash)
    mismatches.push("run and scenario rulesetHash differ");
  if (run.cohortHash !== scenario.effective.cohort.contentHash)
    mismatches.push("run and scenario cohortHash differ");
  if (run.policyHash !== scenario.policyHash) mismatches.push("run and scenario policyHash differ");
  if (run.candidateInputHash !== scenario.candidateInputHash)
    mismatches.push("run and scenario candidateInputHash differ");
  if (canonicalJson(run.objective) !== canonicalJson(scenario.effective.objective))
    mismatches.push("run and scenario objective configuration differ");
  if (canonicalJson(run.evaluationMode) !== canonicalJson(scenario.effective.evaluationMode))
    mismatches.push("run and scenario evaluation configuration differ");
  return mismatches;
}

/** Validates all replay-affecting identities before starting fresh execution. */
export function assertEngineInputCompatible(
  input: EngineInput,
  expectedEngineHash: string,
): ValidatedEngineInput {
  assertLifecyclePortProtocol(input.ports?.lifecycle);
  if (!isRuntimeVerifiedResolvedScenario(input.scenario))
    throw new ResumeCompatibilityError([
      "scenario must retain runtime-verified canonical hash identity",
    ]);
  const scenario = parseContract(ResolvedScenarioSchema, input.scenario);
  const run = parseContract(RunManifestSchema, input.run);
  const mismatches = engineInputMismatches(scenario, run);
  if (run.engineHash !== expectedEngineHash)
    mismatches.unshift("run engineHash differs from the executing engine");
  if (run.status !== "planned") mismatches.unshift("run must be planned for fresh execution");
  if (mismatches.length > 0) throw new ResumeCompatibilityError(mismatches);
  const validated = { scenario: input.scenario, run, ports: input.ports } as ValidatedEngineInput;
  deepFreezeRun(validated.run);
  return Object.freeze(validated);
}

/**
 * Validates the snapshot and all replay-affecting identities before a kernel
 * is allowed to resume it. Concrete engines must call this guard at their
 * resumeSession boundary.
 */
function assertSnapshotCompatible(
  input: EngineInput,
  value: unknown,
  expectedEngineHash: string,
  requiredRunStatus: "planned" | "running",
): ValidatedResume {
  assertLifecyclePortProtocol(input.ports?.lifecycle);
  if (!isRuntimeVerifiedResolvedScenario(input.scenario))
    throw new ResumeCompatibilityError([
      "scenario must retain runtime-verified canonical hash identity",
    ]);
  const scenario = parseContract(ResolvedScenarioSchema, input.scenario);
  const run = parseContract(RunManifestSchema, input.run);
  const snapshot = assertResumableSnapshot(value);
  const mismatches: string[] = [];

  if (run.status !== requiredRunStatus)
    mismatches.push(
      requiredRunStatus === "running"
        ? "run must be running to resume"
        : "fresh-session step validation requires the planned run manifest",
    );
  if (run.engineHash !== expectedEngineHash)
    mismatches.push("run engineHash differs from the executing engine");
  if (snapshot.engineHash !== expectedEngineHash)
    mismatches.push("snapshot engineHash differs from the executing engine");
  mismatches.push(...engineInputMismatches(scenario, run));
  if (snapshot.policyProgress.policyId !== scenario.effective.policy.policyId) {
    mismatches.push("snapshot policy progress policyId differs from scenario policy");
  }
  if (snapshot.policyProgress.revision !== scenario.effective.policy.revision) {
    mismatches.push("snapshot policy progress revision differs from scenario policy");
  }
  const progressStepIds = snapshot.policyProgress.steps.map((step) => step.stepId);
  const policyStepIds = scenario.effective.policy.steps.map((step) => step.stepId);
  if (canonicalJson(progressStepIds) !== canonicalJson(policyStepIds)) {
    mismatches.push("snapshot policy progress step IDs differ from scenario policy");
  }
  for (const [index, progress] of snapshot.policyProgress.steps.entries()) {
    const step = scenario.effective.policy.steps[index];
    if (!step || step.stepId !== progress.stepId) continue;
    if (!step.repeat && progress.consumedRepeats > 1) {
      mismatches.push(`snapshot policy step ${step.stepId} exceeds its one-shot count`);
    }
    if (!step.repeat && progress.state === "completed" && progress.consumedRepeats !== 1) {
      mismatches.push(
        `snapshot completed one-shot step ${step.stepId} requires exactly one execution`,
      );
    }
    if (step.maxRepeats !== null && progress.consumedRepeats > step.maxRepeats) {
      mismatches.push(`snapshot policy step ${step.stepId} exceeds maxRepeats`);
    }
    if (progress.state === "not-started" && progress.consumedRepeats !== 0) {
      mismatches.push(`snapshot policy step ${step.stepId} has progress before starting`);
    }
    if (
      progress.state === "active" &&
      ((!step.repeat && progress.consumedRepeats >= 1) ||
        (step.maxRepeats !== null && progress.consumedRepeats >= step.maxRepeats))
    ) {
      mismatches.push(`snapshot policy step ${step.stepId} is active at its repeat limit`);
    }
  }
  if (scenario.effective.policy.mode === "scripted") {
    const firstExecutable = snapshot.policyProgress.steps.find((step) =>
      ["not-started", "active"].includes(step.state),
    );
    if (snapshot.policyProgress.nextStepId !== (firstExecutable?.stepId ?? null)) {
      mismatches.push("scripted policy cursor must reference the first executable step");
    }
    const frontier = firstExecutable
      ? snapshot.policyProgress.steps.findIndex((step) => step.stepId === firstExecutable.stepId)
      : snapshot.policyProgress.steps.length;
    if (
      snapshot.policyProgress.steps
        .slice(frontier + 1)
        .some((step) => step.state !== "not-started" || step.consumedRepeats !== 0)
    ) {
      mismatches.push("scripted policy steps beyond the cursor must remain not-started");
    }
  }
  for (const branch of snapshot.numericalBranches) {
    if (branch.mode !== scenario.effective.evaluationMode.kind) {
      mismatches.push(`snapshot numerical branch ${branch.branchId} differs from evaluation mode`);
    }
  }
  for (const stream of snapshot.rngStreams) {
    if (stream.algorithm !== scenario.effective.evaluationMode.random.algorithm) {
      mismatches.push(`snapshot RNG stream ${stream.streamId} differs from evaluation algorithm`);
    }
    if (
      scenario.effective.evaluationMode.random.kind === "seeded" &&
      stream.seed !== scenario.effective.evaluationMode.random.seed
    ) {
      mismatches.push(`snapshot RNG stream ${stream.streamId} differs from evaluation seed`);
    }
    if (
      scenario.effective.evaluationMode.random.kind === "deterministic" &&
      (stream.drawCount !== 0 || stream.state.length !== 0)
    )
      mismatches.push("deterministic resume cannot retain consumed RNG state");
  }
  if (
    scenario.effective.evaluationMode.random.kind === "seeded" &&
    snapshot.rngStreams.length === 0
  ) {
    mismatches.push("seeded resume requires retained RNG stream state");
  }
  if (
    scenario.effective.evaluationMode.kind === "sampled-estimate" &&
    snapshot.numericalBranches.length === 0
  )
    mismatches.push("sampled resume requires retained numerical branch state");
  if (snapshot.currentTimeMs > scenario.effective.objective.horizonMs) {
    mismatches.push("snapshot currentTimeMs exceeds the objective horizon");
  }
  const retainedActor = snapshot.entities.find(
    (entity) => entity.entityId === scenario.effective.actorEntityId,
  );
  if (!retainedActor) mismatches.push("snapshot must retain the designated scenario actor");
  else if (retainedActor.team !== "actor")
    mismatches.push("snapshot designated scenario actor must remain on the actor team");
  // A scenario identity may only leave the active world through the retired ledger.
  const activeEntityIds = new Set(snapshot.entities.map((entity) => entity.entityId));
  const retiredEntityIds = new Set(snapshot.retiredEntityIds);
  for (const entity of scenario.effective.entities) {
    if (!activeEntityIds.has(entity.entityId) && !retiredEntityIds.has(entity.entityId))
      mismatches.push(
        `snapshot must retain scenario entity ${entity.entityId} as active or retired`,
      );
  }
  // The frozen policy view cannot represent a departed entity.
  for (const entityId of scenario.effective.policy.visibility.visibleEntityIds) {
    if (!activeEntityIds.has(entityId))
      mismatches.push(`snapshot must retain policy-visible entity ${entityId}`);
  }
  for (const pending of snapshot.pendingActions) {
    if (pending.command.actorId !== scenario.effective.actorEntityId)
      mismatches.push(`snapshot pending action ${pending.actionId} differs from scenario actor`);
    const sourceStep = scenario.effective.policy.steps.find(
      (step) => step.stepId === pending.origin.stepId,
    );
    if (!sourceStep) {
      mismatches.push(`snapshot pending action ${pending.actionId} has no originating policy step`);
    } else if (
      pending.origin.kind === "policy-action" &&
      canonicalJson(pending.command) !== canonicalJson(sourceStep.action)
    ) {
      mismatches.push(`snapshot pending action ${pending.actionId} differs from its policy step`);
    } else if (
      pending.origin.kind === "policy-wait" &&
      (sourceStep.onUnavailable !== "wait" ||
        pending.command.kind !== "wait" ||
        sourceStep.unavailableWaitMs !== pending.command.durationMs ||
        pending.command.actorId !== sourceStep.action.actorId)
    ) {
      mismatches.push(`snapshot pending wait ${pending.actionId} lacks policy wait provenance`);
    }
  }

  const identities: ReadonlyArray<[string, string, string]> = [
    ["runId", snapshot.runId, run.runId],
    ["engineHash", snapshot.engineHash, run.engineHash],
    ["rulesetHash", snapshot.rulesetHash, run.rulesetHash],
    ["cohortHash", snapshot.cohortHash, run.cohortHash],
    ["policyHash", snapshot.policyHash, run.policyHash],
    ["resolvedScenarioHash", snapshot.resolvedScenarioHash, run.resolvedScenarioHash],
    ["candidateInputHash", snapshot.candidateInputHash, run.candidateInputHash],
  ];
  for (const [name, actual, expected] of identities) {
    if (actual !== expected) mismatches.push(`snapshot ${name} differs from run`);
  }
  if (mismatches.length > 0) throw new ResumeCompatibilityError(mismatches);
  const validatedInput = {
    scenario: input.scenario,
    run,
    ports: input.ports,
  } as ValidatedEngineInput;
  deepFreezeRun(validatedInput.run);
  deepFreezeRun(snapshot);
  return Object.freeze({
    input: Object.freeze(validatedInput),
    snapshot,
  }) as ValidatedResume;
}

export function assertResumeCompatible(
  input: EngineInput,
  value: unknown,
  expectedEngineHash: string,
): ValidatedResume {
  return assertSnapshotCompatible(input, value, expectedEngineHash, "running");
}

export interface EngineSession {
  /** Advances a bounded number of events without consulting wall-clock time. */
  step(budget: StepBudget): EngineStepResult;
  snapshot(): EngineSnapshot;
  /** Only this filtered view is exposed to action policies. */
  policyView(): PolicyVisibleState;
}

function assertCombatResultMatchesInput(input: EngineInput, result: CombatResult): void {
  if (
    result.runId !== input.run.runId ||
    result.resolvedScenarioHash !== input.run.resolvedScenarioHash ||
    result.candidateInputHash !== input.run.candidateInputHash
  )
    throw new TypeError("engine output must match the requested run identities");
  if (result.objective !== input.run.objective.kind)
    throw new TypeError("engine output must match the requested objective");
  for (const [metricName, metric] of Object.entries(result.metrics)) {
    if (metric.status === "censored" && metric.horizonMs !== input.run.objective.horizonMs)
      throw new TypeError("engine output censoring must match the requested objective horizon");
    if (
      ["ttk", "timeToFirstDeath", "timeToElimination"].includes(metricName) &&
      metric.status === "value" &&
      metric.value > input.run.objective.horizonMs
    )
      throw new TypeError("engine output elapsed-time metrics cannot exceed the objective horizon");
  }
  if (input.run.evaluationMode.kind !== "sampled-estimate" && result.uncertainty !== null)
    throw new TypeError("non-sampled engine output cannot carry sampling uncertainty");
  if (input.run.evaluationMode.kind === "sampled-estimate") {
    const uncertainty = result.uncertainty;
    const primaryMetric =
      input.run.objective.primaryMetric === "time-to-first-death"
        ? "timeToFirstDeath"
        : input.run.objective.primaryMetric === "time-to-elimination"
          ? "timeToElimination"
          : input.run.objective.primaryMetric;
    if (result.status === "complete" && uncertainty === null)
      throw new TypeError("complete sampled output requires machine-readable uncertainty");
    if (
      uncertainty !== null &&
      (uncertainty.confidenceLevel !== input.run.evaluationMode.confidenceLevel ||
        uncertainty.effectiveSampleCount > input.run.evaluationMode.random.trialCount ||
        (result.status === "complete" &&
          (uncertainty.effectiveSampleCount < 2 || !(primaryMetric in uncertainty.standardErrors))))
    )
      throw new TypeError("engine output uncertainty must match requested confidence and metric");
  }
  if (
    result.status === "complete" &&
    !result.killed &&
    input.run.objective.censoring === "fail-if-not-killed"
  )
    throw new TypeError("engine output violates fail-if-not-killed policy");
  if (result.coverage !== null) {
    const totalWeight = input.scenario.effective.cohort.members.reduce(
      (sum, member) => sum + member.weight,
      0,
    );
    if (
      result.coverage.totalCount !== input.scenario.effective.cohort.members.length ||
      !scaleAwareEqual(result.coverage.totalWeight, totalWeight)
    )
      throw new TypeError("engine output coverage must match the requested cohort denominator");
  }
  if (
    input.run.objective.aggregation === "coverage-then-ttk" &&
    result.status === "complete" &&
    result.coverage === null
  )
    throw new TypeError("engine output coverage must match the requested cohort denominator");
}

export function assertEngineRun(input: EngineInput, value: unknown): EngineRun {
  const run = parseContract(EngineRunSchema, value);
  assertCombatResultMatchesInput(input, run.result);
  if (run.trace.events.some((event) => event.timeMs > input.run.objective.horizonMs))
    throw new TypeError("engine trace events cannot exceed the requested objective horizon");
  return run;
}

/** Validates bounded-step output against the session configuration before consumption. */
export function assertEngineStepResult(
  input: EngineInput,
  value: unknown,
  expectedEngineHash: string,
): EngineStepResult {
  const step = parseContract(EngineStepResultSchema, value);
  const identities: ReadonlyArray<[string, string]> = [
    [step.snapshot.runId, input.run.runId],
    [step.snapshot.engineHash, input.run.engineHash],
    [step.snapshot.rulesetHash, input.run.rulesetHash],
    [step.snapshot.cohortHash, input.run.cohortHash],
    [step.snapshot.policyHash, input.run.policyHash],
    [step.snapshot.resolvedScenarioHash, input.run.resolvedScenarioHash],
    [step.snapshot.candidateInputHash, input.run.candidateInputHash],
  ];
  if (identities.some(([actual, expected]) => actual !== expected))
    throw new TypeError("engine step output must match every requested run identity");
  if (step.snapshot.currentTimeMs > input.run.objective.horizonMs)
    throw new TypeError("engine step snapshot cannot exceed the requested objective horizon");
  const compatibilitySnapshot =
    step.status === "progress"
      ? step.snapshot
      : {
          ...step.snapshot,
          status: "running" as const,
          resumability: "resumable" as const,
          interruption: { state: "none" as const, reason: null },
          result: null,
        };
  assertSnapshotCompatible(
    input,
    compatibilitySnapshot,
    expectedEngineHash,
    input.run.status === "planned" ? "planned" : "running",
  );
  if (step.result !== null) assertCombatResultMatchesInput(input, step.result);
  return step;
}

function deepFreezeRun(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreezeRun(child);
  Object.freeze(value);
}

export interface CombatEngine {
  /** Retains the frozen value returned by assertEngineInputCompatible. */
  createSession(input: ValidatedEngineInput): EngineSession;
  /** Must call assertResumeCompatible and reject non-resumable snapshots. */
  resumeSession(resume: ValidatedResume): EngineSession;
  /** Must call assertEngineInputCompatible before starting fresh execution. */
  run(input: EngineInput): EngineRun;
}

export interface LegacySimulationAdapter<LegacyInput, LegacyOutput> {
  readonly adapterId: string;
  readonly revision: number;
  toScenario(input: LegacyInput): import("./schemas.ts").ScenarioSpec;
  fromResult(result: CombatResult): LegacyOutput;
}

export type SerializablePortValue =
  | EntityState
  | ItemInstance
  | StatsSnapshot
  | DamageResolution
  | EngineCommand
  | EngineEvent
  | EngineSnapshot
  | EngineStepResult
  | ExactComparisonTransfer;

export type { WorkerMessage } from "./schemas.ts";
