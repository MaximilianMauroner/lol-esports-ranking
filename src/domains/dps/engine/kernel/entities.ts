import {
  EntityStateSchema,
  assertLifecycleResolution,
  type EntityState,
  type LifecycleResolution,
  type LifecycleTransition,
} from "../../contracts/index.ts";

/** Snapshot-friendly entity ownership state. Mutations replace copies, never caller objects. */
export class EntityRegistry {
  private readonly entities = new Map<string, EntityState>();
  private readonly retiredIds = new Set<string>();
  private readonly revisions = new Map<string, number>();

  constructor(
    initial: readonly EntityState[],
    retiredIds: readonly string[] = [],
    stateRevisions?: Readonly<Record<string, number>>,
  ) {
    if (new Set(retiredIds).size !== retiredIds.length)
      throw new TypeError("retired entity IDs must be unique");
    for (const entity of initial) {
      const parsed = EntityStateSchema.parse(entity);
      if (this.entities.has(parsed.entityId)) throw new TypeError("entity IDs must be unique");
      this.entities.set(parsed.entityId, structuredClone(parsed));
      const revision = stateRevisions?.[parsed.entityId] ?? 1;
      if (!Number.isSafeInteger(revision) || revision < 1)
        throw new TypeError("entity state revision must be a positive safe integer");
      this.revisions.set(parsed.entityId, revision);
    }
    if (
      stateRevisions !== undefined &&
      (Object.keys(stateRevisions).length !== this.entities.size ||
        Object.keys(stateRevisions).some((id) => !this.entities.has(id)))
    )
      throw new TypeError("entity state revisions must match active entity IDs");
    for (const id of retiredIds) {
      if (this.entities.has(id)) throw new TypeError("a retired entity cannot remain active");
      this.retiredIds.add(id);
    }
    this.assertReferences();
  }

  get(entityId: string): EntityState | null {
    const value = this.entities.get(entityId);
    return value ? structuredClone(value) : null;
  }

  active(): readonly EntityState[] {
    return [...this.entities.values()]
      .sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0))
      .map((value) => structuredClone(value));
  }

  retired(): readonly string[] {
    return [...this.retiredIds].sort();
  }

  stateRevisions(): Readonly<Record<string, number>> {
    return Object.fromEntries(
      [...this.revisions.entries()].sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
  }

  firstExpiredBuffAt(timeMs: number): string | null {
    let earliest: { timeMs: number; ownerEntityId: string; buffId: string } | null = null;
    for (const entity of this.entities.values()) {
      for (const buff of entity.buffs) {
        if (buff.expiresAtMs === null || buff.expiresAtMs >= timeMs) continue;
        if (
          earliest === null ||
          buff.expiresAtMs < earliest.timeMs ||
          (buff.expiresAtMs === earliest.timeMs &&
            (entity.entityId < earliest.ownerEntityId ||
              (entity.entityId === earliest.ownerEntityId && buff.buffId < earliest.buffId)))
        )
          earliest = {
            timeMs: buff.expiresAtMs,
            ownerEntityId: entity.entityId,
            buffId: buff.buffId,
          };
      }
    }
    return earliest?.buffId ?? null;
  }

  spawn(entity: EntityState): void {
    const parsed = EntityStateSchema.parse(entity);
    if (this.entities.has(parsed.entityId) || this.retiredIds.has(parsed.entityId))
      throw new TypeError("entity ID was already allocated");
    this.entities.set(parsed.entityId, structuredClone(parsed));
    try {
      this.assertReferences();
      this.revisions.set(parsed.entityId, 1);
    } catch (error) {
      this.entities.delete(parsed.entityId);
      throw error;
    }
  }

  despawn(entityId: string): EntityState {
    const entity = this.entities.get(entityId);
    if (!entity) throw new TypeError("cannot despawn an unknown entity");
    if (
      [...this.entities.values()].some(
        (other) =>
          other.entityId !== entityId &&
          (other.ownerEntityId === entityId ||
            other.abilities.some(
              (ability) =>
                ability.origin.kind === "copied" && ability.origin.sourceEntityId === entityId,
            ) ||
            other.buffs.some((buff) => buff.sourceEntityId === entityId)),
      )
    )
      throw new TypeError("cannot despawn an entity while active state references it");
    this.entities.delete(entityId);
    this.revisions.delete(entityId);
    this.retiredIds.add(entityId);
    return structuredClone(entity);
  }

  /**
   * Applies one lifecycle transition. Despawned IDs stay in the retired ledger, so a
   * restored checkpoint can never allocate them again.
   */
  apply(transition: LifecycleTransition): LifecycleResolution {
    const replacement =
      transition.replacement === null ? null : EntityStateSchema.parse(transition.replacement);
    const request = { ...transition, replacement };
    const result = assertLifecycleResolution(request, this.active(), {
      accepted: true,
      entityId: transition.entityId,
      transition: transition.transition,
      state: replacement,
      reason: null,
    });
    if (request.transition === "despawn") this.despawn(request.entityId);
    else if (replacement === null)
      throw new TypeError("lifecycle transition requires a replacement");
    else if (request.transition === "spawn") this.spawn(replacement);
    else this.replace(request.entityId, replacement);
    return structuredClone(result);
  }

  /** Death, revive, and transform keep the entity identity and advance its revision. */
  private replace(entityId: string, replacement: EntityState): void {
    const previous = this.entities.get(entityId)!;
    const nextRevision = this.revisions.get(entityId)! + 1;
    if (!Number.isSafeInteger(nextRevision))
      throw new RangeError("entity state revision exhausted");
    this.entities.set(entityId, structuredClone(replacement));
    try {
      this.assertReferences();
    } catch (error) {
      this.entities.set(entityId, previous);
      throw error;
    }
    this.revisions.set(entityId, nextRevision);
  }

  private assertReferences(): void {
    for (const entity of this.entities.values()) {
      if (entity.ownerEntityId !== null && !this.entities.has(entity.ownerEntityId))
        throw new TypeError(`unknown owner for ${entity.entityId}`);
      for (const ability of entity.abilities)
        if (ability.origin.kind === "copied" && !this.entities.has(ability.origin.sourceEntityId))
          throw new TypeError(`unknown copied ability source for ${entity.entityId}`);
      for (const buff of entity.buffs)
        if (!this.entities.has(buff.sourceEntityId))
          throw new TypeError(`unknown buff source for ${entity.entityId}`);
      const seen = new Set([entity.entityId]);
      let owner = entity.ownerEntityId;
      while (owner !== null) {
        if (seen.has(owner)) throw new TypeError("entity ownership cannot contain cycles");
        seen.add(owner);
        owner = this.entities.get(owner)?.ownerEntityId ?? null;
      }
    }
  }
}
