import { describe, expect, test } from "vitest";
import {
  ActionPolicySchema,
  ActionCommandSchema,
  assertDamageResolution,
  assertEngineStepResult as assertEngineStepResultBoundary,
  assertEngineRun,
  assertEngineInputCompatible,
  assertExactComparisonTransfer,
  assertLifecycleResolution,
  assertLifecyclePortProtocol,
  assertMovementResolution,
  assertResolvedScenarioPolicyHash,
  assertRulesetManifestHash,
  assertRngResult,
  assertResourceResolution,
  assertTargetingResolution,
  assertTimerCancelResult,
  assertTimerPeekResult,
  assertTriggerDispatchResult,
  assertStatsSnapshot,
  assertResumableSnapshot,
  assertResumeCompatible as assertResumeCompatibleBoundary,
  CombatResultSchema,
  ContractValidationError,
  ContractSchemas,
  DamageResolutionSchema,
  EngineCommandSchema,
  EngineEventSchema,
  EngineStepResultSchema,
  EngineSnapshotSchema,
  EntityStateSchema,
  ExactComparisonTransferSchema,
  ItemInstanceSchema,
  ResolvedScenarioSchema,
  RunManifestSchema,
  PolicyVisibleStateSchema,
  ResumeCompatibilityError,
  SnapshotNotResumableError,
  ScenarioSpecSchema,
  TraceSchema,
  TraceEventSchema,
  WorkerMessageSchema,
  withLifecycleBatch,
  canonicalJson,
  hashCanonical,
  parseContract,
  type LifecycleBatch,
  type LifecyclePort,
  type LifecycleTransition,
} from "../../../src/domains/dps/contracts/index.ts";
import { createMockPorts, mockPortContext } from "./mock-ports.ts";
import {
  HASH_A,
  HASH_B,
  HASH_C,
  censoredResult,
  parsedItemInstance,
  samplePolicy,
  sampleResolvedScenario,
  sampleRuleset,
  sampleRun,
  sampleRunningRun,
  sampleScenario,
  sampleSnapshot,
  sampleTrace,
  sampleTransfer,
  transformedCopiedAbility,
  observedTarget,
} from "./fixtures.ts";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertResumeCompatible(
  input: Parameters<typeof assertResumeCompatibleBoundary>[0],
  value: unknown,
  expectedEngineHash = input.run.engineHash,
) {
  return assertResumeCompatibleBoundary(input, value, expectedEngineHash);
}

function assertEngineStepResult(
  input: Parameters<typeof assertEngineStepResultBoundary>[0],
  value: unknown,
  expectedEngineHash = input.run.engineHash,
) {
  return assertEngineStepResultBoundary(input, value, expectedEngineHash);
}

async function bindScenarioHashes<T extends typeof sampleResolvedScenario>(
  scenario: T,
): Promise<T> {
  const cohortBytes = Object.fromEntries(
    Object.entries(scenario.effective.cohort).filter(([key]) => key !== "contentHash"),
  );
  scenario.effective.cohort.contentHash = await hashCanonical(cohortBytes);
  scenario.policyHash = await hashCanonical(scenario.effective.policy);
  scenario.candidateInputHash = await hashCanonical(scenario.candidateInput);
  scenario.resolvedScenarioHash = await hashCanonical(scenario.effective);
  return scenario;
}

async function verifyScenarioForEngine<T extends typeof sampleResolvedScenario>(scenario: T) {
  await bindScenarioHashes(scenario);
  return assertResolvedScenarioPolicyHash(scenario);
}

function bindRunToScenario(
  run: typeof sampleRunningRun,
  scenario: typeof sampleResolvedScenario,
): void {
  run.resolvedScenarioHash = scenario.resolvedScenarioHash;
  run.cohortHash = scenario.effective.cohort.contentHash;
  run.policyHash = scenario.policyHash;
  run.candidateInputHash = scenario.candidateInputHash;
}

function bindSnapshotToRun(snapshot: typeof sampleSnapshot, run: typeof sampleRunningRun): void {
  snapshot.engineHash = run.engineHash;
  snapshot.rulesetHash = run.rulesetHash;
  snapshot.cohortHash = run.cohortHash;
  snapshot.policyHash = run.policyHash;
  snapshot.resolvedScenarioHash = run.resolvedScenarioHash;
  snapshot.candidateInputHash = run.candidateInputHash;
}

function visiblePolicyStateFixture() {
  return {
    schemaVersion: 1,
    atTimeMs: 100,
    actorEntityId: "actor",
    visibility: clone(samplePolicy.visibility),
    entities: [
      {
        entityId: "actor",
        team: "actor",
        kind: "champion",
        alive: true,
        health: { current: 1200, maximum: 1200, shield: 0 },
        resources: [{ resourceId: "mana", current: 500, maximum: 500 }],
        visibleAbilityIds: ["arc-of-judgment"],
        buffs: [{ buffId: "test-buff", stacks: 2, expiresAtMs: 3000 }],
        position: { x: 0, y: 0, z: 0 },
      },
      {
        entityId: "enemy",
        team: "enemy",
        kind: "champion",
        alive: true,
        health: { current: 2500, maximum: 2500, shield: 0 },
        resources: [],
        visibleAbilityIds: [],
        buffs: [],
        position: { x: 500, y: 0, z: 0 },
      },
    ],
    readiness: [
      { entityId: "actor", abilityId: "arc-of-judgment", ready: true, cooldownRemainingMs: 0 },
    ],
    visibleResourceIds: ["mana"],
  };
}

function completeSnapshotForTest() {
  const snapshot = clone(sampleSnapshot);
  snapshot.currentTimeMs = 5000;
  snapshot.buffs.forEach((buff) => (buff.expiresAtMs = null));
  snapshot.entities.forEach((entity) => entity.buffs.forEach((buff) => (buff.expiresAtMs = null)));
  snapshot.status = "complete";
  snapshot.resumability = "non-resumable";
  snapshot.interruption = { state: "completed", reason: null };
  snapshot.queue.entries = [];
  snapshot.pendingActions = [];
  snapshot.queue.nextSequence = 4;
  snapshot.result = clone(censoredResult);
  return snapshot;
}

describe("P01 versioned contract fixtures", () => {
  test("round-trips through JSON and structured clone without executable values", () => {
    const values = [
      sampleRuleset,
      sampleScenario,
      sampleResolvedScenario,
      samplePolicy,
      sampleRun,
      sampleTransfer,
      censoredResult,
      sampleTrace,
      sampleSnapshot,
    ];

    for (const value of values) {
      const jsonRoundTrip = JSON.parse(JSON.stringify(value)) as unknown;
      expect(canonicalJson(jsonRoundTrip)).toBe(canonicalJson(value));
      expect(canonicalJson(structuredClone(value))).toBe(canonicalJson(value));
      expect(
        Object.values(value as Record<string, unknown>).some((item) => item instanceof Map),
      ).toBe(false);
    }
  });

  test("rejects unsupported versions, invalid ranks, item state, nonfinite numbers, and horizons", () => {
    const unsupported = clone(sampleScenario) as { schemaVersion: number };
    unsupported.schemaVersion = 2;
    expect(() => parseContract(ScenarioSpecSchema, unsupported)).toThrow(ContractValidationError);

    const invalidRank = clone(transformedCopiedAbility);
    invalidRank.abilities[0]!.rank = 7;
    expect(() => parseContract(EntityStateSchema, invalidRank)).toThrow(ContractValidationError);

    const invalidItemState = clone(parsedItemInstance) as { state: string };
    invalidItemState.state = "duplicated";
    expect(() => parseContract(ItemInstanceSchema, invalidItemState)).toThrow(
      ContractValidationError,
    );

    const nonfinite = clone(transformedCopiedAbility);
    nonfinite.stats.attackDamage = Number.POSITIVE_INFINITY;
    expect(() => parseContract(EntityStateSchema, nonfinite)).toThrow(ContractValidationError);

    const negativeHorizon = clone(sampleScenario);
    negativeHorizon.objective.horizonMs = -1;
    expect(() => parseContract(ScenarioSpecSchema, negativeHorizon)).toThrow(
      ContractValidationError,
    );
  });

  test("rejects invalid entity references before an engine can execute them", () => {
    const invalid = clone(sampleScenario);
    const action = invalid.policy.steps[0]!.action;
    if (action.kind !== "ability") throw new Error("fixture action should be an ability");
    action.target = { kind: "entity", entityId: "missing-entity" };

    expect(() => parseContract(ScenarioSpecSchema, invalid)).toThrow(/unknown entity/);
  });

  test("rejects duplicate entities and unknown copied-ability or buff sources", () => {
    const duplicate = clone(sampleScenario);
    duplicate.entities.push(clone(duplicate.entities[0]!));
    expect(() => parseContract(ScenarioSpecSchema, duplicate)).toThrow(/must be unique/);

    const unknownCopiedSource = clone(sampleScenario);
    const copied = unknownCopiedSource.entities[0]!.abilities[1]!;
    if (copied.origin.kind !== "copied") throw new Error("fixture ability should be copied");
    copied.origin.sourceEntityId = "missing-source";
    expect(() => parseContract(ScenarioSpecSchema, unknownCopiedSource)).toThrow(
      /unknown source entity/,
    );

    const unknownBuffSource = clone(sampleScenario);
    unknownBuffSource.entities[0]!.buffs[0]!.sourceEntityId = "missing-source";
    expect(() => parseContract(ScenarioSpecSchema, unknownBuffSource)).toThrow(
      /unknown source entity/,
    );
  });

  test("recursively validates policy conditions and scoped action references", () => {
    const condition = clone(sampleScenario);
    condition.policy.steps[1]!.condition = {
      kind: "all",
      clauses: [
        {
          kind: "not",
          clause: {
            kind: "any",
            clauses: [
              { kind: "resource-at-least", entityId: "actor", resourceId: "missing", amount: 1 },
              { kind: "buff-stacks-at-least", entityId: "actor", buffId: "missing", stacks: 1 },
            ],
          },
        },
      ],
    };
    expect(() => parseContract(ScenarioSpecSchema, condition)).toThrow(
      /unknown resource|unknown buff/,
    );

    const missingAbility = clone(sampleScenario);
    const ability = missingAbility.policy.steps[0]!.action;
    if (ability.kind !== "ability") throw new Error("fixture action should be an ability");
    ability.abilityId = "missing-ability";
    expect(() => parseContract(ScenarioSpecSchema, missingAbility)).toThrow(/unknown ability/);

    const missingItem = clone(sampleScenario);
    missingItem.policy.steps[0]!.action = {
      kind: "item-active",
      actorId: "actor",
      itemInstanceId: "missing-item",
      target: { kind: "entity", entityId: "enemy" },
    };
    expect(() => parseContract(ScenarioSpecSchema, missingItem)).toThrow(/unknown item instance/);

    const hiddenEntity = clone(sampleScenario);
    hiddenEntity.policy.visibility.visibleEntityIds = ["actor", "missing-entity"];
    expect(() => parseContract(ScenarioSpecSchema, hiddenEntity)).toThrow(
      /policy visibility references unknown entity/,
    );
  });

  test("requires provenance for every effective replay-affecting field", () => {
    const invalid = clone(sampleResolvedScenario);
    delete invalid.provenance.objective;

    expect(() => parseContract(ResolvedScenarioSchema, invalid)).toThrow(
      /replay-affecting field requires provenance/,
    );
  });

  test("preserves transformed and copied ability origins", () => {
    const parsed = parseContract(EntityStateSchema, transformedCopiedAbility);
    expect(parsed.abilities.map((ability) => ability.origin.kind)).toEqual([
      "transformed",
      "copied",
    ]);
    expect(parsed.abilities[1]!.origin).toMatchObject({
      sourceEntityId: "enemy",
      copyId: "copy-001",
    });
  });

  test("preserves item instance identity while an upgrade changes effective item identity", () => {
    const upgraded = parseContract(ItemInstanceSchema, {
      ...parsedItemInstance,
      effectiveItemId: 2002,
      upgrade: { upgradeId: "upgrade-002", fromItemId: 1001, toItemId: 2002 },
    });

    expect(upgraded.instanceId).toBe(parsedItemInstance.instanceId);
    expect(upgraded.baseItemId).toBe(parsedItemInstance.baseItemId);
    expect(upgraded.effectiveItemId).toBe(2002);
    expect(upgraded.stacks).toBe(parsedItemInstance.stacks);
  });

  test("keeps observed effective target stats separate from modeled inventory", () => {
    const target = parseContract(EntityStateSchema, observedTarget);

    expect(target.inventoryOrigin).toBe("observed-effective");
    expect(target.inventory).toEqual([]);
    expect(target.statProvenance.armor.kind).toBe("observed");
    expect(target.statProvenance.armor.sourceHash).toBe(HASH_B);
  });

  test("round-trips revive effects and retains the lifecycle boundary", () => {
    const revivedTrace = clone(sampleTrace);
    revivedTrace.events.push({
      eventId: "event-revive",
      sequence: 3,
      timeMs: 2000,
      phase: "lifecycle",
      kind: "lifecycle",
      actorEntityId: "enemy",
      targetEntityIds: ["enemy"],
      causeEventIds: ["event-002"],
      effects: [{ kind: "lifecycle", entityId: "enemy", transition: "revive" }],
      stateDigest: null,
    });
    const parsed = parseContract(TraceSchema, revivedTrace);
    expect(parsed.events.at(-1)?.effects[0]).toEqual({
      kind: "lifecycle",
      entityId: "enemy",
      transition: "revive",
    });
  });

  test("does not retain an early lifecycle effect when a later batch event fails", () => {
    let committed: string[] = [];
    const checkpoint = clone(sampleSnapshot);
    const deadEnemy = clone(observedTarget);
    deadEnemy.alive = false;
    deadEnemy.health.current = 0;
    const deadActor = clone(transformedCopiedAbility);
    deadActor.alive = false;
    deadActor.health.current = 0;
    const first = { entityId: "enemy", transition: "death" as const, replacement: deadEnemy };
    const second = { entityId: "actor", transition: "death" as const, replacement: deadActor };
    const statefulPort: LifecyclePort = {
      protocolVersion: 2,
      beginBatch: (snapshot) => {
        const staged: string[] = [];
        snapshot.entities[0]!.health.current = 1;
        return {
          apply: (request, context) => {
            if (context.runId !== snapshot.runId) throw new TypeError("foreign run");
            staged.push(request.entityId);
            return {
              accepted: true,
              entityId: request.entityId,
              transition: request.transition,
              state: request.replacement,
              reason: null,
            };
          },
          commit: () => {
            committed = [...committed, ...staged];
            return undefined;
          },
          rollback: () => {
            staged.length = 0;
            return undefined;
          },
        };
      },
    };

    expect(() => {
      withLifecycleBatch(statefulPort, checkpoint, (stage) => {
        assertLifecycleResolution(first, checkpoint.entities, stage.apply(first, mockPortContext));
        expect(committed).toEqual([]);
        const forged = { ...stage.apply(second, mockPortContext), entityId: "enemy" };
        assertLifecycleResolution(second, checkpoint.entities, forged);
      });
    }).toThrow(/requested identity/);
    expect(committed).toEqual([]);
    expect(checkpoint).toEqual(sampleSnapshot);

    let leakedStage: Pick<LifecycleBatch, "apply"> | null = null;
    withLifecycleBatch(statefulPort, checkpoint, (stage) => {
      leakedStage = stage;
      assertLifecycleResolution(first, checkpoint.entities, stage.apply(first, mockPortContext));
      assertLifecycleResolution(second, checkpoint.entities, stage.apply(second, mockPortContext));
      expect(committed).toEqual([]);
    });
    expect(committed).toEqual(["enemy", "actor"]);
    expect(() => leakedStage!.apply(first, mockPortContext)).toThrow(/closed/);
  });

  test("rejects old and unsafe lifecycle batch boundaries", () => {
    const oldPort = { apply: () => ({ accepted: true }) };
    expect(() => assertLifecyclePortProtocol(oldPort)).toThrow(/protocol version 2/);
    expect(() =>
      withLifecycleBatch(oldPort as unknown as LifecyclePort, sampleSnapshot, () => null),
    ).toThrow(/protocol version 2/);
    const oldPorts = {
      ...createMockPorts(),
      lifecycle: oldPort,
    } as unknown as Parameters<typeof assertEngineInputCompatible>[0]["ports"];
    const plannedRun = clone(sampleRunningRun);
    plannedRun.status = "planned";
    expect(() =>
      assertEngineInputCompatible(
        { scenario: sampleResolvedScenario, run: plannedRun, ports: oldPorts },
        plannedRun.engineHash,
      ),
    ).toThrow(/protocol version 2/);
    expect(() =>
      assertResumeCompatible(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: oldPorts },
        sampleSnapshot,
      ),
    ).toThrow(/protocol version 2/);

    let rolledBack = 0;
    const failingCommit: LifecyclePort = {
      protocolVersion: 2,
      beginBatch: () => ({
        apply: () => {
          throw new Error("not used");
        },
        commit: () => {
          throw new Error("commit failed before publication");
        },
        rollback: () => {
          rolledBack += 1;
          return undefined;
        },
      }),
    };
    expect(() => withLifecycleBatch(failingCommit, sampleSnapshot, () => null)).toThrow(
      /commit failed before publication/,
    );
    expect(rolledBack).toBe(1);
    expect(() =>
      withLifecycleBatch(failingCommit, sampleSnapshot, () => Promise.resolve() as unknown as null),
    ).toThrow(/must finish synchronously/);
    expect(rolledBack).toBe(2);

    const failingApply: LifecyclePort = {
      protocolVersion: 2,
      beginBatch: () => ({
        apply: () => {
          throw new Error("apply failed");
        },
        commit: () => {
          throw new Error("must not commit");
        },
        rollback: () => {
          rolledBack += 1;
          return undefined;
        },
      }),
    };
    expect(() =>
      withLifecycleBatch(failingApply, sampleSnapshot, (stage) =>
        stage.apply(
          { entityId: "enemy", transition: "despawn", replacement: null },
          mockPortContext,
        ),
      ),
    ).toThrow(/apply failed/);
    expect(rolledBack).toBe(3);

    const malformed: LifecyclePort = {
      protocolVersion: 2,
      beginBatch: () => ({ apply: () => null }) as unknown as LifecycleBatch,
    };
    expect(() => withLifecycleBatch(malformed, sampleSnapshot, () => null)).toThrow(
      /complete transaction/,
    );
    let malformedRollback = 0;
    const partiallyFormed: LifecyclePort = {
      protocolVersion: 2,
      beginBatch: () =>
        ({
          rollback: () => {
            malformedRollback += 1;
            return undefined;
          },
        }) as unknown as LifecycleBatch,
    };
    expect(() => withLifecycleBatch(partiallyFormed, sampleSnapshot, () => null)).toThrow(
      /complete transaction/,
    );
    expect(malformedRollback).toBe(1);
    const failingBegin: LifecyclePort = {
      protocolVersion: 2,
      beginBatch: () => {
        throw new Error("begin failed before staging");
      },
    };
    expect(() => withLifecycleBatch(failingBegin, sampleSnapshot, () => null)).toThrow(
      /begin failed before staging/,
    );

    const asyncCommit: LifecyclePort = {
      protocolVersion: 2,
      beginBatch: () => ({
        apply: () => {
          throw new Error("not used");
        },
        commit: () => Promise.resolve() as unknown as undefined,
        rollback: () => {
          rolledBack += 1;
          return undefined;
        },
      }),
    };
    expect(() => withLifecycleBatch(asyncCommit, sampleSnapshot, () => null)).toThrow(
      /commit must be synchronous/,
    );
    expect(rolledBack).toBe(4);

    expect(() =>
      withLifecycleBatch(createMockPorts().lifecycle, sampleSnapshot, (stage) =>
        stage.apply(
          { entityId: "enemy", transition: "despawn", replacement: null },
          { ...mockPortContext, runId: "foreign-run" },
        ),
      ),
    ).toThrow(/snapshot run/);

    const brokenRollback: LifecyclePort = {
      protocolVersion: 2,
      beginBatch: () => ({
        apply: () => {
          throw new Error("not used");
        },
        commit: () => {
          throw new Error("commit failed");
        },
        rollback: () => {
          throw new Error("rollback failed");
        },
      }),
    };
    expect(() => withLifecycleBatch(brokenRollback, sampleSnapshot, () => null)).toThrow(
      /rollback failed/,
    );
  });

  test("refuses to commit a caught apply error or a reentrant transition", () => {
    let committed: string[] = [];
    let rolledBack = 0;
    const transition = { entityId: "enemy", transition: "despawn" as const, replacement: null };
    const partiallyMutating: LifecyclePort = {
      protocolVersion: 2,
      beginBatch: () => {
        const staged: string[] = [];
        return {
          apply: (request) => {
            staged.push(request.entityId);
            throw new Error("apply failed after staging");
          },
          commit: () => {
            committed = [...committed, ...staged];
            return undefined;
          },
          rollback: () => {
            rolledBack += 1;
            staged.length = 0;
            return undefined;
          },
        };
      },
    };
    expect(() =>
      withLifecycleBatch(partiallyMutating, sampleSnapshot, (stage) => {
        try {
          stage.apply(transition, mockPortContext);
        } catch {
          // A caller may turn a failed event into a typed invalid result.
        }
        return null;
      }),
    ).toThrow(/apply failed after staging/);
    expect(committed).toEqual([]);
    expect(rolledBack).toBe(1);

    let leakedStage: Pick<LifecycleBatch, "apply"> | null = null;
    let reentrantError: unknown;
    const reentrant: LifecyclePort = {
      protocolVersion: 2,
      beginBatch: () => {
        const staged: string[] = [];
        return {
          apply: (request) => {
            staged.push(request.entityId);
            return {
              accepted: true,
              entityId: request.entityId,
              transition: request.transition,
              state: request.replacement,
              reason: null,
            };
          },
          commit: () => {
            try {
              leakedStage!.apply(transition, mockPortContext);
            } catch (error) {
              reentrantError = error;
            }
            committed = [...committed, ...staged];
            return undefined;
          },
          rollback: () => undefined,
        };
      },
    };
    withLifecycleBatch(reentrant, sampleSnapshot, (stage) => {
      leakedStage = stage;
      stage.apply(transition, mockPortContext);
    });
    expect(reentrantError).toBeInstanceOf(TypeError);
    expect(committed).toEqual(["enemy"]);
  });

  test("rejects asynchronous lifecycle callbacks and native async publication", async () => {
    const effects: string[] = [];
    let rolledBack = 0;
    const port: LifecyclePort = {
      protocolVersion: 2,
      beginBatch: () => ({
        apply: () => {
          throw new Error("not used");
        },
        commit: (async () => {
          await Promise.resolve();
          effects.push("late publication");
        }) as unknown as () => undefined,
        rollback: () => {
          rolledBack += 1;
          return undefined;
        },
      }),
    };
    expect(() => withLifecycleBatch(port, sampleSnapshot, () => null)).toThrow(
      /commit must be synchronous/,
    );
    await Promise.resolve();
    expect(effects).toEqual([]);
    expect(rolledBack).toBe(1);

    let leakedStage: Pick<LifecycleBatch, "apply"> | null = null;
    const ordinaryPort: LifecyclePort = {
      protocolVersion: 2,
      beginBatch: () => ({
        apply: () => {
          throw new Error("not used");
        },
        commit: () => {
          throw new Error("must not commit");
        },
        rollback: () => {
          rolledBack += 1;
          return undefined;
        },
      }),
    };
    expect(() =>
      withLifecycleBatch(ordinaryPort, sampleSnapshot, ((stage: Pick<LifecycleBatch, "apply">) => {
        leakedStage = stage;
        return Promise.resolve().then(() =>
          stage.apply(
            { entityId: "enemy", transition: "despawn", replacement: null },
            mockPortContext,
          ),
        );
      }) as unknown as (stage: Pick<LifecycleBatch, "apply">) => null),
    ).toThrow(/must finish synchronously/);
    await Promise.resolve();
    await Promise.resolve();
    expect(rolledBack).toBe(2);
    expect(() =>
      leakedStage!.apply(
        { entityId: "enemy", transition: "despawn", replacement: null },
        mockPortContext,
      ),
    ).toThrow(/closed/);

    const rejectedBegin: LifecyclePort = {
      protocolVersion: 2,
      beginBatch: () => Promise.reject(new Error("late begin")) as unknown as LifecycleBatch,
    };
    expect(() => withLifecycleBatch(rejectedBegin, sampleSnapshot, () => null)).toThrow(
      /beginBatch must be synchronous/,
    );
    let lateBeginRollback = 0;
    const resolvedBegin: LifecyclePort = {
      protocolVersion: 2,
      beginBatch: () =>
        Promise.resolve({
          apply: () => {
            throw new Error("not used");
          },
          commit: () => {
            throw new Error("must not commit");
          },
          rollback: () => {
            lateBeginRollback += 1;
            return undefined;
          },
        }) as unknown as LifecycleBatch,
    };
    expect(() => withLifecycleBatch(resolvedBegin, sampleSnapshot, () => null)).toThrow(
      /beginBatch must be synchronous/,
    );
    expect(lateBeginRollback).toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(lateBeginRollback).toBe(1);
    const rejectedApply: LifecyclePort = {
      protocolVersion: 2,
      beginBatch: () => ({
        apply: () =>
          Promise.reject(new Error("late apply")) as unknown as ReturnType<LifecycleBatch["apply"]>,
        commit: () => undefined,
        rollback: () => undefined,
      }),
    };
    expect(() =>
      withLifecycleBatch(rejectedApply, sampleSnapshot, (stage) =>
        stage.apply(
          { entityId: "enemy", transition: "despawn", replacement: null },
          mockPortContext,
        ),
      ),
    ).toThrow(/apply must finish synchronously/);
    const rejectedCommit: LifecyclePort = {
      protocolVersion: 2,
      beginBatch: () => ({
        apply: () => {
          throw new Error("not used");
        },
        commit: () => Promise.reject(new Error("late commit")) as unknown as undefined,
        rollback: () => undefined,
      }),
    };
    expect(() => withLifecycleBatch(rejectedCommit, sampleSnapshot, () => null)).toThrow(
      /commit must be synchronous/,
    );
    const rejectedRollback: LifecyclePort = {
      protocolVersion: 2,
      beginBatch: () => ({
        apply: () => {
          throw new Error("not used");
        },
        commit: () => {
          throw new Error("not used");
        },
        rollback: () => Promise.reject(new Error("late rollback")) as unknown as undefined,
      }),
    };
    expect(() =>
      withLifecycleBatch(rejectedRollback, sampleSnapshot, () => {
        throw new Error("batch failed");
      }),
    ).toThrow(/rollback failed/);
    await Promise.resolve();
    await Promise.resolve();
  });

  test("rejects lifecycle commits that return without publishing", () => {
    const transition = { entityId: "enemy", transition: "despawn" as const, replacement: null };
    for (const mode of ["false", "generator", "async-generator"] as const) {
      let published: string[] = [];
      let rolledBack = 0;
      const commit =
        mode === "false"
          ? () => false
          : mode === "generator"
            ? function* () {
                published = ["enemy"];
                yield "enemy";
              }
            : async function* () {
                published = ["enemy"];
                yield "enemy";
              };
      const port: LifecyclePort = {
        protocolVersion: 2,
        beginBatch: () => ({
          apply: (request) => ({
            accepted: true,
            entityId: request.entityId,
            transition: request.transition,
            state: request.replacement,
            reason: null,
          }),
          commit: commit as unknown as () => undefined,
          rollback: () => {
            rolledBack += 1;
            return undefined;
          },
        }),
      };
      expect(() =>
        withLifecycleBatch(port, sampleSnapshot, (stage) => {
          stage.apply(transition, mockPortContext);
          return "adopted";
        }),
      ).toThrow(/commit must be synchronous and return undefined/);
      expect(published).toEqual([]);
      expect(rolledBack).toBe(1);
    }

    const falseRollback: LifecyclePort = {
      protocolVersion: 2,
      beginBatch: () => ({
        apply: () => {
          throw new Error("not used");
        },
        commit: () => {
          throw new Error("commit failed");
        },
        rollback: () => false as unknown as undefined,
      }),
    };
    expect(() => withLifecycleBatch(falseRollback, sampleSnapshot, () => null)).toThrow(
      /rollback failed/,
    );
    const partialFalseRollback: LifecyclePort = {
      protocolVersion: 2,
      beginBatch: () => ({ rollback: () => false }) as unknown as LifecycleBatch,
    };
    expect(() => withLifecycleBatch(partialFalseRollback, sampleSnapshot, () => null)).toThrow(
      /rollback failed/,
    );
  });

  test("rolls back when transaction-handle inspection throws", () => {
    for (const property of ["then", "apply", "commit"] as const) {
      for (const malformedRollback of [false, true]) {
        const inspectionError = new Error(`${property} inspection failed`);
        let rollbacks = 0;
        let commits = 0;
        const handle = {
          get then() {
            if (property === "then") throw inspectionError;
            return undefined;
          },
          get apply() {
            if (property === "apply") throw inspectionError;
            return () => {
              throw new Error("not used");
            };
          },
          get commit() {
            if (property === "commit") throw inspectionError;
            return () => {
              commits += 1;
              return undefined;
            };
          },
          rollback: () => {
            rollbacks += 1;
            return malformedRollback ? (false as unknown as undefined) : undefined;
          },
        };
        const port: LifecyclePort = {
          protocolVersion: 2,
          beginBatch: () => handle,
        };
        let caught: unknown;
        try {
          withLifecycleBatch(port, sampleSnapshot, () => null);
        } catch (error) {
          caught = error;
        }
        expect(rollbacks).toBe(1);
        expect(commits).toBe(0);
        if (malformedRollback) {
          expect(caught).toBeInstanceOf(AggregateError);
          const errors = (caught as AggregateError).errors;
          expect(errors[0]).toBe(inspectionError);
          expect(errors[1]).toBeInstanceOf(TypeError);
        } else {
          expect(caught).toBe(inspectionError);
        }
      }
    }
  });

  test("rejects generator batch callbacks before publication", () => {
    for (const generator of [
      function* () {
        yield "deferred work";
      },
      async function* () {
        yield "deferred work";
      },
    ]) {
      let commits = 0;
      let rollbacks = 0;
      const port: LifecyclePort = {
        protocolVersion: 2,
        beginBatch: () => ({
          apply: () => {
            throw new Error("not used");
          },
          commit: () => {
            commits += 1;
            return undefined;
          },
          rollback: () => {
            rollbacks += 1;
            return undefined;
          },
        }),
      };
      expect(() =>
        withLifecycleBatch(port, sampleSnapshot, generator as unknown as () => null),
      ).toThrow(/synchronously/);
      expect(commits).toBe(0);
      expect(rollbacks).toBe(1);
    }
  });

  test("observes async rollback cleanup after rejecting a transaction", async () => {
    let cleanupStarted = 0;
    let cleanupFinished = 0;
    const port: LifecyclePort = {
      protocolVersion: 2,
      beginBatch: () => ({
        apply: () => {
          throw new Error("not used");
        },
        commit: () => undefined,
        rollback: (async () => {
          cleanupStarted += 1;
          await Promise.resolve();
          cleanupFinished += 1;
        }) as unknown as () => undefined,
      }),
    };
    expect(() => withLifecycleBatch(port, sampleSnapshot, () => null)).toThrow(
      /rollback must be synchronous/,
    );
    expect(cleanupStarted).toBe(1);
    await Promise.resolve();
    expect(cleanupFinished).toBe(1);
  });

  test("accepts callable transaction handles and cleans up inspection errors", () => {
    let commits = 0;
    let rollbacks = 0;
    const callable = Object.assign(() => undefined, {
      apply: (transition: LifecycleTransition) => ({
        accepted: true,
        entityId: transition.entityId,
        transition: transition.transition,
        state: transition.replacement,
        reason: null,
      }),
      commit: () => {
        commits += 1;
        return undefined;
      },
      rollback: () => {
        rollbacks += 1;
        return undefined;
      },
    });
    const port: LifecyclePort = { protocolVersion: 2, beginBatch: () => callable };
    withLifecycleBatch(port, sampleSnapshot, (stage) => {
      stage.apply({ entityId: "enemy", transition: "despawn", replacement: null }, mockPortContext);
    });
    expect(commits).toBe(1);
    expect(rollbacks).toBe(0);

    const inspectionError = new Error("callable apply inspection failed");
    const failingCallable = Object.assign(() => undefined, {
      commit: () => undefined,
      rollback: () => {
        rollbacks += 1;
        return undefined;
      },
    });
    Object.defineProperty(failingCallable, "apply", {
      get: () => {
        throw inspectionError;
      },
    });
    const failingPort: LifecyclePort = {
      protocolVersion: 2,
      beginBatch: () => failingCallable as unknown as LifecycleBatch,
    };
    expect(() => withLifecycleBatch(failingPort, sampleSnapshot, () => null)).toThrow(
      inspectionError,
    );
    expect(rollbacks).toBe(1);
  });

  test("accepts callable lifecycle ports at fresh and resume boundaries", () => {
    let commits = 0;
    const callablePort = Object.assign(() => undefined, {
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
          commits += 1;
          return undefined;
        },
        rollback: () => undefined,
      }),
    });
    assertLifecyclePortProtocol(callablePort);
    withLifecycleBatch(callablePort, sampleSnapshot, (stage) => {
      stage.apply({ entityId: "enemy", transition: "despawn", replacement: null }, mockPortContext);
    });
    expect(commits).toBe(1);

    const ports = { ...createMockPorts(), lifecycle: callablePort };
    const plannedRun = clone(sampleRunningRun);
    plannedRun.status = "planned";
    expect(() =>
      assertEngineInputCompatible(
        { scenario: sampleResolvedScenario, run: plannedRun, ports },
        plannedRun.engineHash,
      ),
    ).not.toThrow();
    expect(() =>
      assertResumeCompatible(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports },
        sampleSnapshot,
      ),
    ).not.toThrow();
  });

  test("rejects trace sequence reuse across different timestamps", () => {
    const duplicate = clone(sampleTrace);
    duplicate.events.push({
      ...duplicate.events[1]!,
      eventId: "event-003",
      timeMs: 2000,
    });

    expect(() => parseContract(TraceSchema, duplicate)).toThrow(/globally unique/);
  });

  test("captures an interrupted long run with queue, actions, triggers, RNG and numerical state", () => {
    expect(sampleSnapshot.status).toBe("running");
    expect(sampleSnapshot.queue.entries[0]?.eventId).toBe("event-003");
    expect(sampleSnapshot.pendingActions[0]?.state).toBe("scheduled");
    expect(sampleSnapshot.triggerState[0]?.triggerId).toBe("trigger-001");
    expect(sampleSnapshot.rngStreams[0]?.drawCount).toBe(0);
    expect(sampleSnapshot.numericalBranches[0]?.accumulators.damage).toBe(100);
    expect(parseContract(EngineSnapshotSchema, clone(sampleSnapshot))).toEqual(sampleSnapshot);
  });

  test("rejects ambiguous queue ties, stale sequence allocation, and non-resumable work", () => {
    const duplicateTie = clone(sampleSnapshot);
    duplicateTie.queue.entries.push({
      ...duplicateTie.queue.entries[0]!,
      eventId: "event-004",
    });
    duplicateTie.queue.nextSequence = 5;
    expect(() => parseContract(EngineSnapshotSchema, duplicateTie)).toThrow(
      /sequence IDs must be unique|ordered by time/,
    );

    const staleSequence = clone(sampleSnapshot);
    staleSequence.queue.nextSequence = 3;
    expect(() => parseContract(EngineSnapshotSchema, staleSequence)).toThrow(
      /nextSequence must be greater/,
    );

    const staleEvent = clone(sampleSnapshot);
    staleEvent.queue.entries[0]!.timeMs = 99;
    expect(() => parseContract(EngineSnapshotSchema, staleEvent)).toThrow(
      /cannot precede currentTimeMs/,
    );

    const cancelledWithWork = clone(sampleSnapshot);
    cancelledWithWork.status = "cancelled";
    cancelledWithWork.resumability = "non-resumable";
    cancelledWithWork.interruption = { state: "cancelled", reason: "user cancelled" };
    expect(() => parseContract(EngineSnapshotSchema, cancelledWithWork)).toThrow(
      /non-resumable snapshots cannot retain/,
    );

    const unknownPendingActor = clone(sampleSnapshot);
    unknownPendingActor.pendingActions[0]!.command = {
      kind: "wait",
      actorId: "missing-actor",
      durationMs: 10,
    };
    expect(() => parseContract(EngineSnapshotSchema, unknownPendingActor)).toThrow(
      /pending actions must reference known actor/,
    );

    const cancelled = clone(sampleSnapshot);
    cancelled.status = "cancelled";
    cancelled.resumability = "non-resumable";
    cancelled.interruption = { state: "cancelled", reason: "user cancelled" };
    cancelled.queue.entries = [];
    cancelled.pendingActions = [];
    cancelled.queue.nextSequence = 4;
    cancelled.result = clone(censoredResult);
    cancelled.result.status = "cancelled";
    cancelled.result.censoring = "invalid";
    cancelled.result.metrics.ttk = { status: "undefined", reason: "cancelled" };
    expect(parseContract(EngineSnapshotSchema, cancelled).status).toBe("cancelled");
    expect(() => assertResumableSnapshot(cancelled)).toThrow(SnapshotNotResumableError);

    for (const status of ["cancelled", "incomplete"] as const) {
      const invalidComplete = completeSnapshotForTest();
      invalidComplete.result = clone(censoredResult);
      invalidComplete.result.status = status;
      invalidComplete.result.censoring = "invalid";
      invalidComplete.result.metrics.ttk = { status: "undefined", reason: status };
      expect(() => parseContract(EngineSnapshotSchema, invalidComplete), status).toThrow(
        /complete snapshots require a complete result/,
      );
    }
  });

  test("rejects contradictory engine step status and snapshot interruption state", () => {
    const cancelledSnapshot = clone(sampleSnapshot);
    cancelledSnapshot.status = "cancelled";
    cancelledSnapshot.resumability = "non-resumable";
    cancelledSnapshot.interruption = { state: "cancelled", reason: "cancelled by caller" };
    cancelledSnapshot.queue.entries = [];
    cancelledSnapshot.pendingActions = [];
    cancelledSnapshot.queue.nextSequence = 4;

    expect(() =>
      parseContract(EngineStepResultSchema, {
        schemaVersion: 1,
        status: "progress",
        snapshot: cancelledSnapshot,
        emittedEvents: [],
        result: null,
        reason: "still working",
      }),
    ).toThrow(/require a running snapshot/);

    expect(() =>
      parseContract(EngineStepResultSchema, {
        schemaVersion: 1,
        status: "cancelled",
        snapshot: sampleSnapshot,
        emittedEvents: [],
        result: null,
        reason: "cancelled by caller",
      }),
    ).toThrow(/require a cancelled snapshot/);

    expect(() =>
      parseContract(EngineStepResultSchema, {
        schemaVersion: 1,
        status: "cancelled",
        snapshot: cancelledSnapshot,
        emittedEvents: [],
        result: null,
        reason: "different cancellation reason",
      }),
    ).toThrow(/matching the snapshot interruption/);

    const idleSnapshot = clone(sampleSnapshot);
    idleSnapshot.interruption = { state: "none", reason: null };
    expect(() =>
      parseContract(EngineStepResultSchema, {
        schemaVersion: 1,
        status: "progress",
        snapshot: idleSnapshot,
        emittedEvents: [],
        result: null,
        reason: "unexpected reason",
      }),
    ).toThrow(/without interruption cannot carry a reason/);

    expect(() =>
      parseContract(EngineStepResultSchema, {
        schemaVersion: 1,
        status: "progress",
        snapshot: sampleSnapshot,
        emittedEvents: [],
        result: null,
        reason: "different budget reason",
      }),
    ).toThrow(/matching the snapshot interruption/);

    const completeSnapshot = completeSnapshotForTest();
    const completeResult = clone(censoredResult);
    expect(
      parseContract(EngineStepResultSchema, {
        schemaVersion: 1,
        status: "complete",
        snapshot: completeSnapshot,
        emittedEvents: [],
        result: completeResult,
        reason: null,
      }).result,
    ).toEqual(completeResult);

    const alteredResult = clone(completeResult);
    alteredResult.warnings = ["semantically different"];
    expect(() =>
      parseContract(EngineStepResultSchema, {
        schemaVersion: 1,
        status: "complete",
        snapshot: completeSnapshot,
        emittedEvents: [],
        result: alteredResult,
        reason: null,
      }),
    ).toThrow(/exactly match the snapshot result/);
  });

  test("resume guards reject non-resumable and incompatible snapshots", () => {
    const input = {
      scenario: sampleResolvedScenario,
      run: sampleRunningRun,
      ports: createMockPorts(),
    };
    expect(assertResumableSnapshot(sampleSnapshot)).toEqual(sampleSnapshot);
    expect(() => assertResumeCompatible(input, sampleSnapshot)).not.toThrow();

    const mismatchedRun = { ...sampleRunningRun, engineHash: HASH_C };
    expect(() => assertResumeCompatible({ ...input, run: mismatchedRun }, sampleSnapshot)).toThrow(
      ResumeCompatibilityError,
    );

    const complete = clone(sampleSnapshot);
    complete.currentTimeMs = 5000;
    complete.buffs.forEach((buff) => (buff.expiresAtMs = null));
    complete.entities.forEach((entity) =>
      entity.buffs.forEach((buff) => (buff.expiresAtMs = null)),
    );
    complete.status = "complete";
    complete.resumability = "non-resumable";
    complete.interruption = { state: "completed", reason: null };
    complete.queue.entries = [];
    complete.pendingActions = [];
    complete.queue.nextSequence = 4;
    complete.result = censoredResult;
    expect(() => assertResumeCompatible(input, complete)).toThrow(SnapshotNotResumableError);
  });

  test("snapshots keep a retired entity ledger that accounts for every scenario entity", () => {
    // Snapshots written before the ledger existed fail closed instead of defaulting to none.
    const withoutLedger: Record<string, unknown> = clone(sampleSnapshot);
    delete withoutLedger.retiredEntityIds;
    const missing = EngineSnapshotSchema.safeParse(withoutLedger);
    expect(missing.success).toBe(false);
    expect(missing.error?.issues.map((issue) => issue.path)).toEqual([["retiredEntityIds"]]);

    const stillActive = clone(sampleSnapshot);
    stillActive.retiredEntityIds = ["enemy"];
    expect(() => parseContract(EngineSnapshotSchema, stillActive)).toThrow(
      /retired entity IDs cannot remain active/,
    );

    const duplicate = clone(sampleSnapshot);
    duplicate.retiredEntityIds = ["summon-1", "summon-1"];
    expect(() => parseContract(EngineSnapshotSchema, duplicate)).toThrow(/values must be unique/);

    // The actor's copied ability names the enemy, so it leaves the world with the enemy.
    const enemyGone = clone(sampleSnapshot);
    enemyGone.entities = enemyGone.entities.filter((entity) => entity.entityId !== "enemy");
    enemyGone.entities[0]!.abilities = enemyGone.entities[0]!.abilities.filter(
      (ability) => ability.origin.kind !== "copied",
    );
    enemyGone.stateRevisions = { actor: 1 };
    const input = {
      scenario: sampleResolvedScenario,
      run: sampleRunningRun,
      ports: createMockPorts(),
    };
    const mismatchesOf = (snapshot: typeof sampleSnapshot) => {
      try {
        assertResumeCompatible(input, snapshot);
        return [];
      } catch (error) {
        if (error instanceof ResumeCompatibilityError) return error.mismatches;
        throw error;
      }
    };
    expect(mismatchesOf(enemyGone)).toEqual([
      "snapshot must retain scenario entity enemy as active or retired",
      "snapshot must retain policy-visible entity enemy",
    ]);
    // Retiring the enemy accounts for it, but the frozen policy view still needs it.
    enemyGone.retiredEntityIds = ["enemy"];
    expect(mismatchesOf(enemyGone)).toEqual(["snapshot must retain policy-visible entity enemy"]);
  });

  test("retained lifecycle trace effects must agree with the retired entity ledger", () => {
    const withLifecycleEffect = (
      entityId: string,
      transition: "spawn" | "despawn",
      retiredEntityIds: string[],
    ) => {
      const snapshot = clone(sampleSnapshot);
      snapshot.trace.events[1] = {
        ...snapshot.trace.events[1]!,
        kind: "lifecycle",
        targetEntityIds: [entityId],
        effects: [{ kind: "lifecycle", entityId, transition }],
      };
      snapshot.retiredEntityIds = retiredEntityIds;
      return EngineSnapshotSchema.safeParse(snapshot).error?.issues.map((issue) => issue.message);
    };
    const mismatch = ["retained lifecycle trace effects must match the retired entity ledger"];
    expect(withLifecycleEffect("summon-1", "despawn", [])).toEqual(mismatch);
    expect(withLifecycleEffect("summon-1", "despawn", ["summon-1"])).toBeUndefined();
    expect(withLifecycleEffect("enemy", "despawn", [])).toEqual(mismatch);
    expect(withLifecycleEffect("summon-1", "spawn", [])).toEqual(mismatch);
    expect(withLifecycleEffect("summon-1", "spawn", ["summon-1"])).toBeUndefined();
  });

  test("uses tagged censored metrics instead of JSON Infinity or NaN", () => {
    const json = JSON.stringify(censoredResult);
    expect(json).not.toContain("Infinity");
    expect(json).not.toContain("NaN");
    expect(parseContract(CombatResultSchema, JSON.parse(json))).toEqual(censoredResult);
    expect(censoredResult.metrics.ttk).toEqual({ status: "censored", horizonMs: 5000 });
  });

  test("rejects contradictory kill and censoring combinations", () => {
    const killedAsCensored = {
      ...censoredResult,
      killed: true,
      censoring: "right-censored" as const,
      metrics: {
        ...censoredResult.metrics,
        ttk: { status: "value" as const, value: 4200 },
      },
    };
    expect(() => parseContract(CombatResultSchema, killedAsCensored)).toThrow(/cannot be censored/);

    const nonKillAsUncensored = { ...censoredResult, censoring: "not-censored" as const };
    expect(() => parseContract(CombatResultSchema, nonKillAsUncensored)).toThrow(
      /must be right-censored or invalid/,
    );

    const completeAsInvalid = {
      ...censoredResult,
      censoring: "invalid" as const,
      metrics: {
        ...censoredResult.metrics,
        ttk: { status: "undefined" as const, reason: "not completed" },
      },
    };
    expect(() => parseContract(CombatResultSchema, completeAsInvalid)).toThrow(
      /interrupted\/invalid result/,
    );

    const interruptedAsCensored = {
      ...censoredResult,
      status: "cancelled" as const,
      censoring: "right-censored" as const,
      metrics: {
        ...censoredResult.metrics,
        ttk: { status: "censored" as const, horizonMs: 5000 },
      },
    };
    expect(() => parseContract(CombatResultSchema, interruptedAsCensored)).toThrow(
      /right-censored results must be complete/,
    );

    const negativeTtk = {
      ...censoredResult,
      killed: true,
      censoring: "not-censored" as const,
      metrics: {
        ...censoredResult.metrics,
        ttk: { status: "value" as const, value: -1 },
      },
    };
    expect(() => parseContract(CombatResultSchema, negativeTtk)).toThrow(/non-negative TTK/);
  });

  test("canonical hashes ignore object insertion order but change with candidate input", async () => {
    const first = await hashCanonical({ b: 2, a: 1 });
    const second = await hashCanonical({ a: 1, b: 2 });
    const changed = await hashCanonical({ a: 1, b: 3 });

    expect(first).toBe(second);
    expect(changed).not.toBe(first);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sampleRun.searchContextHash).not.toBe(sampleRun.candidateInputHash);
    expect(HASH_A).not.toBe(HASH_C);
  });

  test("canonicalization rejects hidden, executable, and silently ignored values", () => {
    const symbolKey = Symbol("hidden");
    const symbolObject: Record<string | symbol, unknown> = { visible: 1 };
    symbolObject[symbolKey] = 2;
    expect(() => canonicalJson(symbolObject)).toThrow(/symbol-keyed/);

    const nonEnumerable = { visible: 1 };
    Object.defineProperty(nonEnumerable, "hidden", { value: 2, enumerable: false });
    expect(() => canonicalJson(nonEnumerable)).toThrow(/non-enumerable/);

    const accessor = {};
    Object.defineProperty(accessor, "value", { enumerable: true, get: () => 1 });
    expect(() => canonicalJson(accessor)).toThrow(/accessor/);

    const extraArrayProperty = [1] as number[] & { extra?: number };
    extraArrayProperty.extra = 2;
    expect(() => canonicalJson(extraArrayProperty)).toThrow(/extra properties/);

    const hiddenArrayProperty = [1];
    Object.defineProperty(hiddenArrayProperty, "hidden", { value: 2, enumerable: false });
    expect(() => canonicalJson(hiddenArrayProperty)).toThrow(/non-enumerable/);

    expect(() => canonicalJson({ executable: () => 1 })).toThrow(/structured-clone-safe/);
    expect(() => canonicalJson({ nonfinite: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson(new Map([["key", 1]]))).toThrow(/plain objects/);

    const schemaBoundaryExecutable = clone(visiblePolicyStateFixture());
    Object.defineProperty(schemaBoundaryExecutable, "executable", {
      value: () => 1,
      enumerable: true,
    });
    expect(() => parseContract(PolicyVisibleStateSchema, schemaBoundaryExecutable)).toThrow(
      /structured-clone-safe/,
    );

    const schemaBoundaryHidden = clone(visiblePolicyStateFixture());
    Object.defineProperty(schemaBoundaryHidden, "hidden", {
      value: 2,
      enumerable: false,
    });
    expect(() => parseContract(PolicyVisibleStateSchema, schemaBoundaryHidden)).toThrow(
      /non-enumerable/,
    );

    const schemaBoundaryArray = clone(visiblePolicyStateFixture());
    (
      schemaBoundaryArray.entities as typeof schemaBoundaryArray.entities & { extra?: number }
    ).extra = 1;
    expect(() => parseContract(PolicyVisibleStateSchema, schemaBoundaryArray)).toThrow(
      /extra properties/,
    );
  });

  test("rejects inherited required fields and proxies at every canonical boundary", async () => {
    const previousSchemaVersion = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "schemaVersion",
    );
    try {
      Object.defineProperty(Object.prototype, "schemaVersion", {
        value: 1,
        configurable: true,
        enumerable: false,
        writable: true,
      });
      const polluted = clone(sampleScenario) as Record<string, unknown>;
      delete polluted.schemaVersion;
      expect(() => parseContract(ScenarioSpecSchema, polluted)).toThrow(/schemaVersion|expected 1/);
    } finally {
      if (previousSchemaVersion) {
        Object.defineProperty(Object.prototype, "schemaVersion", previousSchemaVersion);
      } else {
        Reflect.deleteProperty(Object.prototype, "schemaVersion");
      }
    }

    const proxy = new Proxy({ value: 1 }, {});
    expect(() => canonicalJson(proxy)).toThrow(/structured-clone-safe/);

    let hashError: unknown;
    try {
      await hashCanonical(proxy);
    } catch (error) {
      hashError = error;
    }
    expect(String(hashError)).toMatch(/structured-clone-safe/);

    const proxyContract = new Proxy(visiblePolicyStateFixture(), {});
    expect(() => parseContract(PolicyVisibleStateSchema, proxyContract)).toThrow(
      /structured-clone-safe/,
    );

    const accessorContract = clone(sampleScenario);
    Object.defineProperty(accessorContract, "schemaVersion", {
      configurable: true,
      enumerable: true,
      get: () => 1,
    });
    expect(() => parseContract(ScenarioSpecSchema, accessorContract)).toThrow(/accessor/);
  });

  test("rejects a run that collapses search context and candidate input identity", () => {
    const invalid = { ...sampleRun, candidateInputHash: sampleRun.searchContextHash };
    expect(() => parseContract(RunManifestSchema, invalid)).toThrow(/must remain distinct/);
  });

  test("accepts incomplete manifests and requires timezone-qualified timestamps", () => {
    const incomplete = clone(sampleRun);
    incomplete.status = "incomplete";
    incomplete.completedAt = null;
    expect(parseContract(RunManifestSchema, incomplete).status).toBe("incomplete");

    const localTime = clone(sampleRun);
    localTime.createdAt = "2026-09-19T00:00:00";
    expect(() => parseContract(RunManifestSchema, localTime)).toThrow(/explicit timezone/);
  });

  test("validates exact comparison transfer hashes and versioned worker envelopes", () => {
    expect(parseContract(ExactComparisonTransferSchema, clone(sampleTransfer))).toEqual(
      sampleTransfer,
    );

    const mismatched = clone(sampleTransfer);
    mismatched.result.candidateInputHash = HASH_A;
    expect(() => parseContract(ExactComparisonTransferSchema, mismatched)).toThrow(
      /same candidate input/,
    );

    const message = parseContract(WorkerMessageSchema, {
      schemaVersion: 1,
      direction: "step",
      payload: {
        schemaVersion: 1,
        status: "progress",
        snapshot: sampleSnapshot,
        emittedEvents: [],
        result: null,
        reason: "step event budget exhausted",
      },
    });
    expect(message.schemaVersion).toBe(1);
    if (message.direction !== "step") throw new Error("fixture message should be a step");
    expect(message.payload.snapshot.runId).toBe(sampleRun.runId);
  });

  test("rejects a censored non-kill under fail-if-not-killed exact transfer policy", () => {
    const invalid = clone(sampleTransfer);
    invalid.run.objective.censoring = "fail-if-not-killed";
    invalid.resolvedScenario.effective.objective.censoring = "fail-if-not-killed";

    expect(() => parseContract(ExactComparisonTransferSchema, invalid)).toThrow(
      /fail-if-not-killed objectives cannot transfer a non-kill result/,
    );
  });

  test("rejects every exact-comparison provenance mismatch and interrupted result", () => {
    type MutableTransfer = Omit<typeof sampleTransfer, "schemaVersion"> & {
      schemaVersion?: number;
    };
    const cases: Array<{
      label: string;
      mutate: (value: MutableTransfer) => void;
      message: RegExp;
    }> = [
      {
        label: "schema version",
        mutate: (value) => delete value.schemaVersion,
        message: /schemaVersion|expected 1/,
      },
      {
        label: "run identity",
        mutate: (value) => {
          value.run.runId = "different-run";
        },
        message: /run and result must share run identity/,
      },
      {
        label: "scenario identity",
        mutate: (value) => {
          value.resolvedScenario.resolvedScenarioHash = HASH_C;
        },
        message: /same resolved scenario/,
      },
      {
        label: "result identity",
        mutate: (value) => {
          value.result.resolvedScenarioHash = HASH_C;
        },
        message: /same resolved scenario/,
      },
      {
        label: "ruleset provenance",
        mutate: (value) => {
          value.run.rulesetHash = HASH_C;
        },
        message: /ruleset provenance/,
      },
      {
        label: "cohort provenance",
        mutate: (value) => {
          value.run.cohortHash = HASH_C;
        },
        message: /cohort provenance/,
      },
      {
        label: "policy provenance",
        mutate: (value) => {
          value.run.policyHash = HASH_C;
        },
        message: /policy provenance/,
      },
      {
        label: "candidate provenance",
        mutate: (value) => {
          value.candidateInputHash = HASH_A;
        },
        message: /candidate input/,
      },
      {
        label: "objective configuration",
        mutate: (value) => {
          value.run.objective.horizonMs = 4000;
        },
        message: /objective configuration/,
      },
      {
        label: "evaluation configuration",
        mutate: (value) => {
          value.run.evaluationMode = {
            kind: "average-state-approximation",
            random: { kind: "deterministic", algorithm: "none", seed: null, trialCount: 1 },
            approximation: "expected-crit",
          };
        },
        message: /evaluation configuration/,
      },
      {
        label: "result objective identity",
        mutate: (value) => {
          value.result.objective = "ttk";
        },
        message: /objective identity/,
      },
      {
        label: "censoring horizon",
        mutate: (value) => {
          if (value.result.metrics.ttk.status !== "censored") {
            throw new Error("fixture result should be censored");
          }
          value.result.metrics.ttk.horizonMs = 4000;
        },
        message: /objective horizon/,
      },
      {
        label: "incomplete result",
        mutate: (value) => {
          value.result.status = "incomplete";
          value.result.censoring = "invalid";
          value.result.metrics.ttk = { status: "undefined", reason: "interrupted" };
        },
        message: /complete run and complete result/,
      },
      {
        label: "cancelled result",
        mutate: (value) => {
          value.result.status = "cancelled";
          value.result.censoring = "invalid";
          value.result.metrics.ttk = { status: "undefined", reason: "cancelled" };
        },
        message: /complete run and complete result/,
      },
    ];

    for (const testCase of cases) {
      const invalid = clone(sampleTransfer) as MutableTransfer;
      testCase.mutate(invalid);
      expect(() => parseContract(ExactComparisonTransferSchema, invalid), testCase.label).toThrow(
        testCase.message,
      );
    }
  });

  test("validates versioned command/event envelopes and exposes narrow mock ports", () => {
    const command = parseContract(EngineCommandSchema, {
      schemaVersion: 1,
      kind: "apply-damage",
      commandId: "command-001",
      issuedAtMs: 100,
      causeEventIds: [],
      packet: {
        sourceEntityId: "actor",
        targetEntityId: "enemy",
        damageType: "physical",
        rawAmount: 100,
        tags: ["basic-attack"],
        canOverkill: false,
      },
    });
    const event = parseContract(EngineEventSchema, {
      schemaVersion: 1,
      eventId: "event-command",
      timeMs: 100,
      sequence: 4,
      phase: "impact",
      kind: "damage",
      actorEntityId: "actor",
      targetEntityIds: ["enemy"],
      causeEventIds: [],
      payload: { commandId: command.commandId },
    });
    const ports = createMockPorts();
    if (command.kind !== "apply-damage") throw new Error("fixture command should apply damage");
    const resolution = ports.damage.resolve(
      {
        packet: command.packet,
        attacker: transformedCopiedAbility,
        target: observedTarget,
        attackerStats: { entityId: "actor", revision: 1, values: transformedCopiedAbility.stats },
        targetStats: { entityId: "enemy", revision: 1, values: observedTarget.stats },
        attackerRead: { kind: "impact", entityId: "actor", atTimeMs: 100, stateRevision: 1 },
        read: { kind: "impact", entityId: "enemy", atTimeMs: 100, stateRevision: 1 },
      },
      mockPortContext,
    );

    expect(event.payload).toEqual({ commandId: "command-001" });
    expect(resolution.applied).toBe(100);
    expect(ports.timers.cancel("missing-event", mockPortContext)).toBe(false);
  });

  test("keeps action policy visibility explicit and non-future-facing", () => {
    const parsed = parseContract(ActionPolicySchema, samplePolicy);
    expect(parsed.visibility.allowFutureEvents).toBe(false);
    expect(parsed.visibility.allowHiddenOpponentState).toBe(false);
    expect(parsed.steps.every((step) => step.condition !== undefined)).toBe(true);
  });

  test("exposes only declared policy-visible state", () => {
    const visible = {
      schemaVersion: 1,
      atTimeMs: 100,
      actorEntityId: "actor",
      visibility: samplePolicy.visibility,
      entities: [
        {
          entityId: "actor",
          team: "actor",
          kind: "champion",
          alive: true,
          health: { current: 1200, maximum: 1200, shield: 0 },
          resources: [{ resourceId: "mana", current: 500, maximum: 500 }],
          visibleAbilityIds: ["arc-of-judgment"],
          buffs: [{ buffId: "test-buff", stacks: 2, expiresAtMs: 3000 }],
          position: { x: 0, y: 0, z: 0 },
        },
        {
          entityId: "enemy",
          team: "enemy",
          kind: "champion",
          alive: true,
          health: { current: 2500, maximum: 2500, shield: 0 },
          resources: [],
          visibleAbilityIds: [],
          buffs: [],
          position: { x: 500, y: 0, z: 0 },
        },
      ],
      readiness: [
        { entityId: "actor", abilityId: "arc-of-judgment", ready: true, cooldownRemainingMs: 0 },
      ],
      visibleResourceIds: ["mana"],
    };
    const parsedVisible = parseContract(PolicyVisibleStateSchema, visible);
    expect(parsedVisible.actorEntityId).toBe("actor");
    expect(parsedVisible.entities[1]?.entityId).toBe("enemy");

    const leaked = clone(visible);
    Object.defineProperty(leaked.entities[0]!, "stats", {
      value: { attackDamage: 150 },
      enumerable: true,
    });
    expect(() => parseContract(PolicyVisibleStateSchema, leaked)).toThrow(/stats/);

    const hiddenReadiness = clone(visible);
    hiddenReadiness.readiness[0]!.abilityId = "hidden-ability";
    expect(() => parseContract(PolicyVisibleStateSchema, hiddenReadiness)).toThrow(
      /non-visible ability/,
    );
  });

  test("rejects hidden condition entities, duplicate readiness, and duplicate snapshot RNG streams", () => {
    const hiddenCondition = clone(sampleScenario);
    hiddenCondition.policy.visibility.visibleEntityIds = ["actor"];
    expect(() => parseContract(ScenarioSpecSchema, hiddenCondition)).toThrow(
      /condition references hidden entity/,
    );

    const duplicateReadiness = visiblePolicyStateFixture();
    duplicateReadiness.readiness.push({
      ...duplicateReadiness.readiness[0]!,
      ready: false,
      cooldownRemainingMs: 100,
    });
    expect(() => parseContract(PolicyVisibleStateSchema, duplicateReadiness)).toThrow(
      /readiness record IDs must be unique/,
    );

    const duplicateRng = clone(sampleSnapshot);
    duplicateRng.rngStreams.push({ ...duplicateRng.rngStreams[0]!, seed: "other" });
    expect(() => parseContract(EngineSnapshotSchema, duplicateRng)).toThrow(
      /RNG stream IDs must be unique/,
    );
  });

  test("rejects ambiguous trace IDs, inventory slots, and missing item upgrade metadata", () => {
    const duplicateTraceId = clone(sampleTrace);
    duplicateTraceId.events.push({
      ...duplicateTraceId.events[1]!,
      sequence: 3,
      timeMs: 200,
    });
    expect(() => parseContract(TraceSchema, duplicateTraceId)).toThrow(
      /trace event IDs must be globally unique/,
    );

    const duplicateSlot = clone(transformedCopiedAbility);
    duplicateSlot.inventory.push({
      ...clone(duplicateSlot.inventory[0]!),
      instanceId: "item-instance-duplicate-slot",
    });
    expect(() => parseContract(EntityStateSchema, duplicateSlot)).toThrow(
      /equipped inventory slot IDs must be unique/,
    );

    const negativeSlot = clone(transformedCopiedAbility);
    negativeSlot.inventory[0]!.slot = -1;
    expect(() => parseContract(EntityStateSchema, negativeSlot)).toThrow(
      /equipped items require a real inventory slot/,
    );

    const missingUpgrade = { ...clone(parsedItemInstance), effectiveItemId: 2002, upgrade: null };
    expect(() => parseContract(ItemInstanceSchema, missingUpgrade)).toThrow(
      /requires upgrade metadata/,
    );
  });

  test("requires own stat provenance and normalized cohort mass", () => {
    const inheritedName = clone(transformedCopiedAbility);
    inheritedName.stats = { constructor: 100 };
    inheritedName.statProvenance = {};
    expect(() => parseContract(EntityStateSchema, inheritedName)).toThrow(
      /every effective stat requires provenance/,
    );

    const invalidWeights = clone(sampleScenario);
    invalidWeights.cohort.members.push({
      ...clone(invalidWeights.cohort.members[0]!),
      memberId: "member-002",
    });
    expect(() => parseContract(ScenarioSpecSchema, invalidWeights)).toThrow(
      /normalized cohort weights must sum to one/,
    );
  });

  test("requires objective-complete metrics including death and elimination time", () => {
    for (const [objective, metric] of [
      ["fixed-window-damage", "damage"],
      ["sustained-dps", "dps"],
      ["ttk", "ttk"],
      ["first-death", "timeToFirstDeath"],
      ["final-elimination", "timeToElimination"],
    ] as const) {
      const result = clone(censoredResult);
      result.objective = objective;
      result.metrics[metric] = { status: "undefined", reason: "missing" };
      expect(() => parseContract(CombatResultSchema, result), objective).toThrow(
        /objective-valid primary metric/,
      );
    }
  });

  test("carries non-success terminal results and policy progress through snapshots", () => {
    const snapshot = clone(sampleSnapshot);
    snapshot.status = "incomplete";
    snapshot.resumability = "non-resumable";
    snapshot.interruption = { state: "budget-exhausted", reason: "hard event limit" };
    snapshot.queue.entries = [];
    snapshot.pendingActions = [];
    snapshot.result = clone(censoredResult);
    snapshot.result.status = "incomplete";
    snapshot.result.censoring = "invalid";
    snapshot.result.metrics.ttk = { status: "undefined", reason: "hard event limit" };

    const step = parseContract(EngineStepResultSchema, {
      schemaVersion: 1,
      status: "incomplete",
      snapshot,
      emittedEvents: [],
      result: snapshot.result,
      reason: "hard event limit",
    });
    expect(step.result?.status).toBe("incomplete");
    expect(step.snapshot.policyProgress.nextStepId).toBe("basic-attack");
    expect(step.snapshot.policyProgress.steps[1]?.consumedRepeats).toBe(2);

    const invalidProgress = clone(sampleSnapshot);
    invalidProgress.policyProgress.nextStepId = "missing-step";
    expect(() => parseContract(EngineSnapshotSchema, invalidProgress)).toThrow(
      /next policy step must exist/,
    );
  });

  test("mock timers use chronological order and traces remain isolated by run", () => {
    const ports = createMockPorts();
    const later = clone(sampleSnapshot.queue.entries[0]!);
    const earlier = { ...later, eventId: "event-earlier", timeMs: 500, sequence: 4 };
    ports.timers.schedule({ event: later, replacesEventId: null }, mockPortContext);
    ports.timers.schedule({ event: earlier, replacesEventId: null }, mockPortContext);
    expect(ports.timers.peek(mockPortContext)?.eventId).toBe("event-earlier");

    ports.trace.record(sampleTrace.events[0]!, mockPortContext);
    ports.trace.record(sampleTrace.events[1]!, { ...mockPortContext, runId: "run-002" });
    expect(
      ports.trace.snapshot(mockPortContext.runId).events.map((event) => event.eventId),
    ).toEqual(["event-001"]);
    expect(ports.trace.snapshot("run-002").events.map((event) => event.eventId)).toEqual([
      "event-002",
    ]);
  });

  test("binds unique policy steps and resumable progress to the scenario policy", () => {
    const duplicateStep = clone(samplePolicy);
    duplicateStep.steps[1]!.stepId = duplicateStep.steps[0]!.stepId;
    expect(() => parseContract(ActionPolicySchema, duplicateStep)).toThrow(
      /action step IDs must be unique/,
    );

    for (const mutate of [
      (snapshot: typeof sampleSnapshot) => {
        snapshot.policyProgress.policyId = "foreign-policy";
      },
      (snapshot: typeof sampleSnapshot) => {
        snapshot.policyProgress.revision += 1;
      },
      (snapshot: typeof sampleSnapshot) => {
        snapshot.policyProgress.nextStepId = "cast-w";
        snapshot.policyProgress.steps.pop();
      },
    ]) {
      const snapshot = clone(sampleSnapshot);
      mutate(snapshot);
      expect(() =>
        assertResumeCompatible(
          { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
          snapshot,
        ),
      ).toThrow();
    }

    const impossibleRepeatProgress = clone(sampleSnapshot);
    impossibleRepeatProgress.policyProgress.steps[0]!.consumedRepeats = 2;
    expect(() =>
      assertResumeCompatible(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
        impossibleRepeatProgress,
      ),
    ).toThrow(/one-shot count/);
  });

  test("requires unique resumable action, trigger, and numerical branch identities", () => {
    for (const [collection, duplicate] of [
      ["pendingActions", { ...sampleSnapshot.pendingActions[0] }],
      ["triggerState", { ...sampleSnapshot.triggerState[0] }],
      ["numericalBranches", { ...sampleSnapshot.numericalBranches[0] }],
    ] as const) {
      const snapshot = clone(sampleSnapshot);
      snapshot[collection].push(duplicate as never);
      expect(() => parseContract(EngineSnapshotSchema, snapshot), collection).toThrow(/unique/);
    }
  });

  test("requires one consistent snapshot buff representation", () => {
    const conflicting = clone(sampleSnapshot);
    conflicting.buffs[0]!.stacks += 1;
    expect(() => parseContract(EngineSnapshotSchema, conflicting)).toThrow(
      /top-level buffs must exactly match entity buff state/,
    );

    const expired = clone(sampleSnapshot);
    expired.buffs[0]!.expiresAtMs = 99;
    expired.entities[0]!.buffs[0]!.expiresAtMs = 99;
    expect(() => parseContract(EngineSnapshotSchema, expired)).toThrow(
      /snapshot buffs cannot already be expired/,
    );
  });

  test("rejects invalid metric values and mismatched censored time horizons", () => {
    const negative = clone(censoredResult);
    negative.metrics.damage = { status: "value", value: -1 };
    expect(() => parseContract(CombatResultSchema, negative)).toThrow(/expected number to be >=0/);

    const transfer = clone(sampleTransfer);
    transfer.run.objective.kind = "first-death";
    transfer.run.objective.primaryMetric = "time-to-first-death";
    transfer.resolvedScenario.effective.objective = clone(transfer.run.objective);
    transfer.result.objective = "first-death";
    transfer.result.metrics.timeToFirstDeath = { status: "censored", horizonMs: 4000 };
    expect(() => parseContract(ExactComparisonTransferSchema, transfer)).toThrow(
      /censored metric must match the transferred objective horizon/,
    );
  });

  test("validates coverage-first result metadata and sustained DPS windows", () => {
    const covered = clone(censoredResult);
    covered.coverage = {
      killedCount: 1,
      totalCount: 4,
      killedWeight: 0.9,
      totalWeight: 1,
      fraction: 0.9,
    };
    expect(parseContract(CombatResultSchema, covered).coverage).toEqual(covered.coverage);

    const contradictory = clone(covered);
    contradictory.coverage!.fraction = 0.5;
    expect(() => parseContract(CombatResultSchema, contradictory)).toThrow(
      /fraction must match its weights/,
    );

    const transfer = clone(sampleTransfer);
    transfer.run.objective.aggregation = "coverage-then-ttk";
    transfer.resolvedScenario.effective.objective = clone(transfer.run.objective);
    expect(() => parseContract(ExactComparisonTransferSchema, transfer)).toThrow(
      /machine-readable kill coverage/,
    );

    const noMeasurementWindow = clone(sampleScenario);
    noMeasurementWindow.objective.kind = "sustained-dps";
    noMeasurementWindow.objective.primaryMetric = "dps";
    noMeasurementWindow.objective.warmupMs = noMeasurementWindow.objective.horizonMs;
    expect(() => parseContract(ScenarioSpecSchema, noMeasurementWindow)).toThrow(
      /strictly less than the horizon/,
    );
  });

  test("keeps unevaluated coverage absent on interrupted coverage-first steps", async () => {
    const scenarioDraft = clone(sampleResolvedScenario);
    scenarioDraft.effective.objective.aggregation = "coverage-then-ttk";
    const scenario = await verifyScenarioForEngine(scenarioDraft);
    const run = clone(sampleRunningRun);
    run.objective = clone(scenario.effective.objective);
    bindRunToScenario(run, scenario);
    const input = { scenario, run, ports: createMockPorts() };

    for (const [status, state, reason] of [
      ["incomplete", "budget-exhausted", "event limit reached"],
      ["cancelled", "cancelled", "cancelled before objective evaluation"],
      ["invalid", "invalid", "objective evaluation unavailable"],
    ] as const) {
      const result = clone(censoredResult);
      result.status = status;
      result.censoring = "invalid";
      result.coverage = null;
      result.metrics = {
        damage: { status: "undefined", reason },
        dps: { status: "undefined", reason },
        ttk: { status: "undefined", reason },
        timeToFirstDeath: { status: "undefined", reason },
        timeToElimination: { status: "undefined", reason },
      };
      result.resolvedScenarioHash = run.resolvedScenarioHash;
      result.candidateInputHash = run.candidateInputHash;
      const snapshot = completeSnapshotForTest();
      snapshot.currentTimeMs = 100;
      snapshot.status = status;
      snapshot.interruption = { state, reason };
      snapshot.result = result;
      bindSnapshotToRun(snapshot, run);
      const step = {
        schemaVersion: 1 as const,
        status,
        snapshot,
        emittedEvents: [],
        result,
        reason,
      };

      expect(parseContract(EngineStepResultSchema, step)).toEqual(step);
      expect(assertEngineStepResult(input, step)).toEqual(step);
      expect(assertEngineStepResult(input, JSON.parse(JSON.stringify(step)))).toEqual(step);
      expect(assertEngineRun(input, { status, result, trace: sampleTrace }).result).toEqual(result);

      const suppliedCoverage = clone(step);
      suppliedCoverage.result.coverage = {
        killedCount: 0,
        totalCount: 99,
        killedWeight: 0,
        totalWeight: 99,
        fraction: 0,
      };
      suppliedCoverage.snapshot.result = suppliedCoverage.result;
      expect(() => assertEngineStepResult(input, suppliedCoverage)).toThrow(
        /coverage.*cohort denominator/,
      );
      expect(() =>
        assertEngineRun(input, { status, result: suppliedCoverage.result, trace: sampleTrace }),
      ).toThrow(/coverage.*cohort denominator/);
    }

    const completeResult = clone(censoredResult);
    completeResult.resolvedScenarioHash = run.resolvedScenarioHash;
    completeResult.candidateInputHash = run.candidateInputHash;
    const completeSnapshot = completeSnapshotForTest();
    completeSnapshot.result = completeResult;
    bindSnapshotToRun(completeSnapshot, run);
    const completeStep = {
      schemaVersion: 1,
      status: "complete" as const,
      snapshot: completeSnapshot,
      emittedEvents: [],
      result: completeResult,
      reason: null,
    };
    expect(() => assertEngineStepResult(input, completeStep)).toThrow(
      /coverage.*cohort denominator/,
    );
    expect(() =>
      assertEngineRun(input, { status: "complete", result: completeResult, trace: sampleTrace }),
    ).toThrow(/coverage.*cohort denominator/);

    const transfer = clone(sampleTransfer);
    transfer.resolvedScenario = scenario;
    transfer.run.objective = clone(run.objective);
    bindRunToScenario(transfer.run, scenario);
    transfer.result.resolvedScenarioHash = run.resolvedScenarioHash;
    transfer.result.candidateInputHash = run.candidateInputHash;
    expect(() => parseContract(ExactComparisonTransferSchema, transfer)).toThrow(
      /machine-readable kill coverage/,
    );

    const coverage = {
      killedCount: 0,
      totalCount: 1,
      killedWeight: 0,
      totalWeight: 1,
      fraction: 0,
    };
    completeResult.coverage = coverage;
    completeSnapshot.result = completeResult;
    transfer.result.coverage = coverage;
    expect(assertEngineStepResult(input, completeStep).result?.coverage).toEqual(coverage);
    expect(
      assertEngineRun(input, { status: "complete", result: completeResult, trace: sampleTrace })
        .result.coverage,
    ).toEqual(coverage);
    expect(parseContract(ExactComparisonTransferSchema, transfer).result.coverage).toEqual(
      coverage,
    );
  });

  test("validates stats snapshots and entity ownership at runtime boundaries", () => {
    expect(
      assertStatsSnapshot(
        {
          entity: transformedCopiedAbility,
          read: { kind: "snapshot", entityId: "actor", atTimeMs: 0, stateRevision: 1 },
        },
        mockPortContext,
        { entityId: "actor", revision: 1, values: transformedCopiedAbility.stats },
      ),
    ).toMatchObject({ entityId: "actor", revision: 1 });
    expect(() =>
      assertStatsSnapshot(
        {
          entity: transformedCopiedAbility,
          read: { kind: "snapshot", entityId: "actor", atTimeMs: 0, stateRevision: 1 },
        },
        mockPortContext,
        {
          entityId: "actor",
          revision: 1,
          values: { ...transformedCopiedAbility.stats, attackDamage: Infinity },
        },
      ),
    ).toThrow(/non-finite/);

    const unknownOwner = clone(sampleScenario);
    unknownOwner.entities[1]!.ownerEntityId = "missing-owner";
    expect(() => parseContract(ScenarioSpecSchema, unknownOwner)).toThrow(/unknown entity/);

    const owned = clone(sampleScenario);
    owned.entities[1]!.ownerEntityId = "actor";
    expect(parseContract(ScenarioSpecSchema, owned).entities[1]!.ownerEntityId).toBe("actor");
  });

  test("requires retained trace causes to precede their effects", () => {
    for (const causeEventId of ["missing-event", "event-002"] as const) {
      const invalid = clone(sampleTrace);
      invalid.events[0]!.causeEventIds = [causeEventId];
      expect(() => parseContract(TraceSchema, invalid)).toThrow(
        /causes must reference an earlier retained event|complete trace causes must reference a retained event/,
      );
    }

    const truncatedMissing = clone(sampleTrace);
    truncatedMissing.truncated = true;
    truncatedMissing.truncationReason = "retention limit";
    truncatedMissing.events[0]!.causeEventIds = ["omitted-event"];
    expect(() => parseContract(TraceSchema, truncatedMissing)).not.toThrow();

    const truncatedForward = clone(truncatedMissing);
    truncatedForward.events[0]!.causeEventIds = ["event-002"];
    expect(() => parseContract(TraceSchema, truncatedForward)).toThrow(/earlier retained event/);
  });

  test("makes tie tolerance, selector actors, and seeded algorithms unambiguous", () => {
    const missingTolerance = clone(sampleScenario);
    missingTolerance.objective.tieTolerance = null;
    expect(() => parseContract(ScenarioSpecSchema, missingTolerance)).toThrow(
      /requires a numeric tolerance/,
    );

    const exactWithTolerance = clone(sampleScenario);
    exactWithTolerance.objective.tiePolicy = "exact";
    expect(() => parseContract(ScenarioSpecSchema, exactWithTolerance)).toThrow(
      /exact tie policy cannot carry a tolerance/,
    );

    expect(() =>
      parseContract(ActionCommandSchema, {
        kind: "basic-attack",
        actorId: "actor",
        target: { kind: "self", actorId: "enemy" },
      }),
    ).toThrow(/selector actor must match/);

    const invalidSeeded = clone(sampleScenario);
    invalidSeeded.evaluationMode = {
      kind: "seeded-trajectory",
      random: { kind: "seeded", algorithm: "none", seed: "seed", trialCount: 1 },
      approximation: null,
    };
    expect(() => parseContract(ScenarioSpecSchema, invalidSeeded)).toThrow(
      /requires a random algorithm/,
    );

    const enemyActor = clone(sampleScenario);
    enemyActor.actorEntityId = "enemy";
    expect(() => parseContract(ScenarioSpecSchema, enemyActor)).toThrow(/actor team/);
  });

  test("rejects retroactive commands, reversed run timestamps, and contradictory empty inventory", () => {
    expect(() =>
      parseContract(EngineCommandSchema, {
        schemaVersion: 1,
        kind: "schedule-event",
        commandId: "retroactive",
        issuedAtMs: 1000,
        causeEventIds: [],
        event: {
          eventId: "past-event",
          timeMs: 500,
          sequence: 1,
          phase: "impact",
          kind: "damage",
          payload: {},
          causeEventIds: [],
        },
      }),
    ).toThrow(/cannot precede command issue time/);

    const reversed = clone(sampleRun);
    reversed.completedAt = "2026-09-18T23:59:59Z";
    expect(() => parseContract(RunManifestSchema, reversed)).toThrow(/cannot precede createdAt/);

    const contradictory = clone(transformedCopiedAbility);
    contradictory.inventoryOrigin = "empty";
    expect(() => parseContract(EntityStateSchema, contradictory)).toThrow(
      /empty inventory origin requires an empty inventory/,
    );
  });

  test("reconciles damage totals and death state", () => {
    expect(() =>
      parseContract(DamageResolutionSchema, {
        attempted: 10,
        absorbed: 0,
        prevented: 0,
        applied: 10,
        overkill: 20,
        discarded: 0,
        targetHealthAfter: 0,
        killed: true,
      }),
    ).toThrow(/totals must reconcile/);
    expect(() =>
      parseContract(DamageResolutionSchema, {
        attempted: 10,
        absorbed: 0,
        prevented: 0,
        applied: 10,
        overkill: 0,
        discarded: 0,
        targetHealthAfter: 10,
        killed: true,
      }),
    ).toThrow(/death state must match/);
  });

  test("mock ports isolate and accumulate mutable state deterministically", () => {
    const ports = createMockPorts();
    const otherRun = { ...mockPortContext, runId: "run-002" };
    const event = clone(sampleSnapshot.queue.entries[0]!);
    const replacement = { ...event, eventId: "replacement", timeMs: 500, sequence: 4 };
    ports.timers.schedule({ event, replacesEventId: null }, mockPortContext);
    ports.timers.schedule({ event: replacement, replacesEventId: event.eventId }, mockPortContext);
    ports.timers.schedule({ event, replacesEventId: null }, otherRun);
    expect(ports.timers.peek(mockPortContext)?.eventId).toBe("replacement");
    expect(ports.timers.peek(otherRun)?.eventId).toBe(event.eventId);
    expect(ports.timers.cancel(event.eventId, mockPortContext)).toBe(false);

    expect(ports.rng.draw({ streamId: "combat", draws: 3 }, mockPortContext).nextDrawCount).toBe(3);
    expect(ports.rng.draw({ streamId: "combat", draws: 2 }, mockPortContext).nextDrawCount).toBe(5);
    expect(ports.rng.draw({ streamId: "combat", draws: 1 }, otherRun).nextDrawCount).toBe(1);
    ports.rng.restore(
      { streamId: "combat", algorithm: "xorshift32", seed: "seed", drawCount: 7, state: [1] },
      mockPortContext,
    );
    expect(ports.rng.draw({ streamId: "combat", draws: 2 }, mockPortContext).nextDrawCount).toBe(9);

    const mutation = { entityId: "actor", resourceId: "mana", delta: -60, reason: "cast" };
    expect(ports.resources.apply(mutation, mockPortContext)).toMatchObject({
      previous: 100,
      current: 40,
    });
    expect(ports.resources.apply(mutation, mockPortContext)).toMatchObject({
      previous: 40,
      current: 0,
    });
    expect(ports.resources.apply(mutation, otherRun)).toMatchObject({
      previous: 100,
      current: 40,
    });
    ports.resources.restore(transformedCopiedAbility, otherRun);
    expect(ports.resources.apply(mutation, otherRun)).toMatchObject({
      previous: 500,
      current: 440,
    });
  });

  test("mock lowest-health targeting returns one deterministic enemy", () => {
    const ports = createMockPorts();
    const visibleState = visiblePolicyStateFixture();
    visibleState.entities.push({
      ...clone(visibleState.entities[1]!),
      entityId: "enemy-low",
      health: { current: 100, maximum: 1000, shield: 0 },
    });
    visibleState.visibility.visibleEntityIds.push("enemy-low");
    visibleState.entities[1]!.alive = false;
    visibleState.entities[1]!.health.current = 0;
    const result = ports.targeting.select(
      {
        actor: transformedCopiedAbility,
        selector: { kind: "lowest-health-visible-enemy", actorId: "actor" },
        visibleState: parseContract(PolicyVisibleStateSchema, visibleState),
        expectedVisibleEntityIds: visibleState.visibility.visibleEntityIds,
      },
      mockPortContext,
    );
    expect(result.targetEntityIds).toEqual(["enemy-low"]);

    const allEnemies = ports.targeting.select(
      {
        actor: transformedCopiedAbility,
        selector: { kind: "all-visible-enemies", actorId: "actor" },
        visibleState: parseContract(PolicyVisibleStateSchema, visibleState),
        expectedVisibleEntityIds: visibleState.visibility.visibleEntityIds,
      },
      mockPortContext,
    );
    expect(allEnemies.targetEntityIds).toEqual(["enemy-low"]);
  });

  test("mock damage consumes shields before health", () => {
    const ports = createMockPorts();
    const shielded = clone(observedTarget);
    shielded.health.current = 80;
    shielded.health.maximum = 80;
    shielded.health.shield = 30;
    const resolution = ports.damage.resolve(
      {
        packet: {
          sourceEntityId: "actor",
          targetEntityId: "enemy",
          damageType: "physical",
          rawAmount: 100,
          tags: [],
          canOverkill: true,
        },
        attacker: transformedCopiedAbility,
        target: shielded,
        attackerStats: { entityId: "actor", revision: 1, values: transformedCopiedAbility.stats },
        targetStats: { entityId: "enemy", revision: 1, values: shielded.stats },
        attackerRead: { kind: "impact", entityId: "actor", atTimeMs: 100, stateRevision: 1 },
        read: { kind: "impact", entityId: "enemy", atTimeMs: 100, stateRevision: 1 },
      },
      mockPortContext,
    );
    expect(resolution).toMatchObject({
      attempted: 100,
      absorbed: 30,
      applied: 70,
      overkill: 0,
      targetHealthAfter: 10,
      killed: false,
    });
  });

  test("hardens remaining replay and adapter boundaries", () => {
    const impossibleDate = clone(sampleRun);
    impossibleDate.createdAt = "2026-02-30T00:00:00Z";
    expect(() => parseContract(RunManifestSchema, impossibleDate)).toThrow(/real calendar/);

    const hiddenTarget = clone(sampleScenario);
    hiddenTarget.policy.visibility.visibleEntityIds = ["actor"];
    expect(() => parseContract(ScenarioSpecSchema, hiddenTarget)).toThrow(/targets hidden entity/);

    const futureBuff = clone(sampleScenario);
    futureBuff.policy.steps[0]!.condition = {
      kind: "buff-stacks-at-least",
      entityId: "actor",
      buffId: "future-proc",
      stacks: 1,
    };
    expect(() => parseContract(ScenarioSpecSchema, futureBuff)).not.toThrow();

    const completedCursor = clone(sampleSnapshot);
    completedCursor.policyProgress.nextStepId = "cast-w";
    expect(() => parseContract(EngineSnapshotSchema, completedCursor)).toThrow(
      /executable progress/,
    );

    const causalQueue = clone(sampleSnapshot);
    causalQueue.queue.entries.push({
      ...causalQueue.queue.entries[0]!,
      eventId: "event-later",
      sequence: 4,
      timeMs: 2000,
    });
    causalQueue.queue.entries[0]!.causeEventIds = ["event-later"];
    causalQueue.queue.nextSequence = 5;
    expect(() => parseContract(EngineSnapshotSchema, causalQueue)).toThrow(/earlier retained/);

    const deadAlive = clone(transformedCopiedAbility);
    deadAlive.health.current = 0;
    expect(() => parseContract(EntityStateSchema, deadAlive)).toThrow(/alive state/);

    const expiredVisible = visiblePolicyStateFixture();
    expiredVisible.atTimeMs = 4000;
    expect(() => parseContract(PolicyVisibleStateSchema, expiredVisible)).toThrow(
      /visible buffs cannot already be expired/,
    );

    const negativeZero = clone(transformedCopiedAbility);
    negativeZero.position.x = -0;
    expect(Object.is(parseContract(EntityStateSchema, negativeZero).position.x, -0)).toBe(false);
  });

  test("validates request-correlated port results and terminal runs", () => {
    expect(() =>
      assertRngResult({ streamId: "combat", draws: 2 }, 7, {
        streamId: "combat",
        values: [0.1, Number.NaN],
        nextDrawCount: 9,
      }),
    ).toThrow(/non-finite/);

    const request = {
      packet: {
        sourceEntityId: "actor",
        targetEntityId: "enemy",
        damageType: "physical" as const,
        rawAmount: 10,
        tags: [] as string[],
        canOverkill: false,
      },
      attacker: transformedCopiedAbility,
      target: observedTarget,
      attackerStats: { entityId: "actor", revision: 1, values: transformedCopiedAbility.stats },
      targetStats: { entityId: "enemy", revision: 1, values: observedTarget.stats },
      attackerRead: { kind: "impact" as const, entityId: "actor", atTimeMs: 0, stateRevision: 1 },
      read: { kind: "impact" as const, entityId: "enemy", atTimeMs: 0, stateRevision: 1 },
    };
    expect(() =>
      assertDamageResolution(request, mockPortContext, {
        attempted: 10,
        absorbed: 0,
        prevented: 0,
        applied: 10,
        overkill: 0,
        discarded: 0,
        targetHealthAfter: 0,
        killed: true,
      }),
    ).toThrow(/requested packet and target/);

    expect(() =>
      assertEngineRun(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
        {
          status: "complete",
          result: { ...censoredResult, status: "invalid" },
          trace: sampleTrace,
        },
      ),
    ).toThrow(/must match/);

    expect(() =>
      assertStatsSnapshot(
        {
          entity: transformedCopiedAbility,
          read: { kind: "snapshot", entityId: "actor", atTimeMs: 0, stateRevision: 2 },
        },
        mockPortContext,
        { entityId: "enemy", revision: 1, values: { armor: 10 } },
      ),
    ).toThrow(/requested entity and state revision/);
  });

  test("validates worker event batches, horizons, uncertainty, and resume modes", () => {
    const step = {
      schemaVersion: 1 as const,
      status: "progress" as const,
      snapshot: sampleSnapshot,
      emittedEvents: [
        {
          schemaVersion: 1 as const,
          eventId: "later",
          timeMs: 200,
          sequence: 2,
          phase: "impact" as const,
          kind: "damage",
          actorEntityId: "actor",
          targetEntityIds: ["enemy"],
          causeEventIds: [],
          payload: {},
        },
        {
          schemaVersion: 1 as const,
          eventId: "earlier",
          timeMs: 100,
          sequence: 1,
          phase: "input" as const,
          kind: "action",
          actorEntityId: "actor",
          targetEntityIds: ["enemy"],
          causeEventIds: [],
          payload: {},
        },
      ],
      result: null,
      reason: sampleSnapshot.interruption.reason,
    };
    expect(() => parseContract(EngineStepResultSchema, step)).toThrow(/ordered by time/);

    const pastHorizon = clone(sampleTransfer);
    pastHorizon.result.killed = true;
    pastHorizon.result.censoring = "not-censored";
    pastHorizon.result.metrics.ttk = { status: "value", value: 6000 };
    expect(() => parseContract(ExactComparisonTransferSchema, pastHorizon)).toThrow(
      /cannot exceed.*horizon/,
    );

    const sampled = clone(sampleTransfer);
    sampled.run.evaluationMode = {
      kind: "sampled-estimate",
      random: { kind: "seeded", algorithm: "xorshift32", seed: "seed", trialCount: 10 },
      approximation: null,
      confidenceLevel: 0.95,
    };
    sampled.run.random = clone(sampled.run.evaluationMode.random);
    sampled.resolvedScenario.effective.evaluationMode = clone(sampled.run.evaluationMode);
    sampled.result.uncertainty = null;
    expect(() => parseContract(ExactComparisonTransferSchema, sampled)).toThrow(
      /machine-readable uncertainty/,
    );

    const wrongMode = clone(sampleSnapshot);
    wrongMode.numericalBranches[0]!.mode = "sampled-estimate";
    expect(() =>
      assertResumeCompatible(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
        wrongMode,
      ),
    ).toThrow(/numerical branch/);
  });

  test("enforces latest-head request, snapshot, trace, and time invariants", () => {
    expect(() =>
      assertResourceResolution(
        { entityId: "actor", resourceId: "mana", delta: -10, reason: "cast" },
        transformedCopiedAbility,
        {
          accepted: "yes",
          entityId: "actor",
          resourceId: "mana",
          previous: 100,
          current: 90,
          reason: null,
        },
      ),
    ).toThrow();

    expect(() =>
      assertTargetingResolution(
        {
          actor: transformedCopiedAbility,
          selector: { kind: "self", actorId: "actor" },
          visibleState: parseContract(PolicyVisibleStateSchema, visiblePolicyStateFixture()),
          expectedVisibleEntityIds: samplePolicy.visibility.visibleEntityIds,
        },
        { ...mockPortContext, timeMs: 100 },
        { targetEntityIds: ["enemy"], rejected: false, reason: null },
      ),
    ).toThrow(/selector semantics/);

    expect(() =>
      assertStatsSnapshot(
        {
          entity: transformedCopiedAbility,
          read: { kind: "snapshot", entityId: "enemy", atTimeMs: 0, stateRevision: 1 },
        },
        mockPortContext,
        { entityId: "actor", revision: 1, values: { attackDamage: 150 } },
      ),
    ).toThrow(/stats read entity/);

    const traceMismatch = clone(censoredResult);
    traceMismatch.traceId = "different-trace";
    expect(() =>
      assertEngineRun(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
        { status: "complete", result: traceMismatch, trace: sampleTrace },
      ),
    ).toThrow(/trace identity/);

    const ownershipCycle = clone(sampleSnapshot);
    ownershipCycle.entities[0]!.ownerEntityId = "enemy";
    ownershipCycle.entities[1]!.ownerEntityId = "actor";
    expect(() => parseContract(EngineSnapshotSchema, ownershipCycle)).toThrow(/ownership.*cycles/);

    const pastHorizon = clone(sampleSnapshot);
    pastHorizon.currentTimeMs = 5001;
    pastHorizon.queue.entries[0]!.timeMs = 6000;
    const horizonWait = pastHorizon.pendingActions[0]!.command;
    if (horizonWait.kind !== "wait") throw new Error("fixture action should be a wait");
    horizonWait.durationMs = 5900;
    pastHorizon.buffs[0]!.expiresAtMs = null;
    pastHorizon.entities[0]!.buffs[0]!.expiresAtMs = null;
    expect(() =>
      assertResumeCompatible(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
        pastHorizon,
      ),
    ).toThrow(/objective horizon/);

    const emptyCompleted = clone(sampleSnapshot);
    emptyCompleted.policyProgress.steps[0]!.consumedRepeats = 0;
    expect(() =>
      assertResumeCompatible(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
        emptyCompleted,
      ),
    ).toThrow(/exactly one execution/);

    const subMillisecond = clone(sampleRun);
    subMillisecond.createdAt = "2026-09-19T00:00:00.0009Z";
    expect(() => parseContract(RunManifestSchema, subMillisecond)).toThrow(/explicit timezone/);
  });

  test("enforces selector, port identity, RNG, and lifecycle boundaries", async () => {
    const visibleState = visiblePolicyStateFixture();
    visibleState.entities.push({
      ...clone(visibleState.entities[1]!),
      entityId: "enemy-low",
      health: { current: 1, maximum: 100, shield: 0 },
    });
    visibleState.visibility.visibleEntityIds.push("enemy-low");
    const parsedVisible = parseContract(PolicyVisibleStateSchema, visibleState);
    expect(() =>
      assertTargetingResolution(
        {
          actor: transformedCopiedAbility,
          selector: { kind: "lowest-health-visible-enemy", actorId: "actor" },
          visibleState: parsedVisible,
          expectedVisibleEntityIds: parsedVisible.visibility.visibleEntityIds,
        },
        { ...mockPortContext, timeMs: 100 },
        { targetEntityIds: ["enemy"], rejected: false, reason: null },
      ),
    ).toThrow(/dynamic selector/);
    expect(() =>
      assertTargetingResolution(
        {
          actor: transformedCopiedAbility,
          selector: { kind: "all-visible-enemies", actorId: "actor" },
          visibleState: parsedVisible,
          expectedVisibleEntityIds: parsedVisible.visibility.visibleEntityIds,
        },
        { ...mockPortContext, timeMs: 100 },
        { targetEntityIds: ["actor"], rejected: false, reason: null },
      ),
    ).toThrow(/dynamic selector|visible entities/);

    const ports = createMockPorts();
    const command = {
      packet: {
        sourceEntityId: "enemy",
        targetEntityId: "enemy",
        damageType: "physical" as const,
        rawAmount: 10,
        tags: [] as string[],
        canOverkill: false,
      },
      attacker: transformedCopiedAbility,
      target: observedTarget,
      attackerStats: { entityId: "actor", revision: 1, values: transformedCopiedAbility.stats },
      targetStats: { entityId: "enemy", revision: 1, values: observedTarget.stats },
      attackerRead: { kind: "impact" as const, entityId: "actor", atTimeMs: 0, stateRevision: 1 },
      read: { kind: "impact" as const, entityId: "enemy", atTimeMs: 0, stateRevision: 1 },
    };
    expect(() =>
      assertDamageResolution(command, mockPortContext, {
        attempted: 10,
        absorbed: 0,
        prevented: 0,
        applied: 10,
        overkill: 0,
        discarded: 0,
        targetHealthAfter: observedTarget.health.current - 10,
        killed: false,
      }),
    ).toThrow(/identities/);

    const deadEnemy = clone(observedTarget);
    deadEnemy.alive = false;
    deadEnemy.health.current = 0;
    const deadActor = clone(transformedCopiedAbility);
    deadActor.alive = false;
    deadActor.health.current = 0;
    expect(() =>
      withLifecycleBatch(ports.lifecycle, sampleSnapshot, (stage) =>
        assertLifecycleResolution(
          { entityId: "enemy", transition: "death", replacement: deadEnemy },
          sampleSnapshot.entities,
          stage.apply(
            { entityId: "actor", transition: "death", replacement: deadActor },
            mockPortContext,
          ),
        ),
      ),
    ).toThrow(/requested identity/);

    const executableRng = {
      streamId: "combat",
      values: [0.5],
      nextDrawCount: 1,
      extra: () => 1,
    };
    expect(() => assertRngResult({ streamId: "combat", draws: 1 }, 0, executableRng)).toThrow();

    const seededScenarioDraft = clone(sampleResolvedScenario);
    seededScenarioDraft.effective.evaluationMode = {
      kind: "seeded-trajectory",
      random: { kind: "seeded", algorithm: "xorshift32", seed: "expected", trialCount: 1 },
      approximation: null,
    };
    const seededScenario = await verifyScenarioForEngine(seededScenarioDraft);
    const seededRun = clone(sampleRunningRun);
    seededRun.evaluationMode = clone(seededScenario.effective.evaluationMode);
    seededRun.random = clone(seededRun.evaluationMode.random);
    bindRunToScenario(seededRun, seededScenario);
    const seededSnapshot = clone(sampleSnapshot);
    bindSnapshotToRun(seededSnapshot, seededRun);
    seededSnapshot.numericalBranches[0]!.mode = "seeded-trajectory";
    seededSnapshot.rngStreams[0]!.algorithm = "xorshift32";
    seededSnapshot.rngStreams[0]!.seed = "wrong";
    expect(() =>
      assertResumeCompatible(
        { scenario: seededScenario, run: seededRun, ports: createMockPorts() },
        seededSnapshot,
      ),
    ).toThrow(/evaluation seed/);
  });

  test("enforces cohort modes, proxy rejection order, and effective policy hashes", async () => {
    const uniform = clone(sampleScenario);
    uniform.cohort.weighting = "uniform-member";
    uniform.cohort.members.push({
      ...clone(uniform.cohort.members[0]!),
      memberId: "member-002",
      weight: 0.25,
    });
    uniform.cohort.members[0]!.weight = 0.75;
    expect(() => parseContract(ScenarioSpecSchema, uniform)).toThrow(/equal member weights/);

    const matchBalanced = clone(sampleScenario);
    matchBalanced.cohort.weighting = "match-balanced";
    matchBalanced.cohort.members[0]!.weight = 1 / 3;
    matchBalanced.cohort.members.push(
      {
        ...clone(matchBalanced.cohort.members[0]!),
        memberId: "member-002",
        matchKey: "match-001",
      },
      {
        ...clone(matchBalanced.cohort.members[0]!),
        memberId: "member-003",
        matchKey: "match-002",
      },
    );
    expect(() => parseContract(ScenarioSpecSchema, matchBalanced)).toThrow(
      /equal aggregate weight per match/,
    );

    let traversed = false;
    const hostileProxy = new Proxy(
      { value: 1 },
      {
        ownKeys() {
          traversed = true;
          return ["value"];
        },
      },
    );
    expect(() => canonicalJson(hostileProxy)).toThrow(/structured-clone-safe/);
    expect(traversed).toBe(true);

    const policyBound = clone(sampleResolvedScenario);
    await bindScenarioHashes(policyBound);
    await expect(assertResolvedScenarioPolicyHash(policyBound)).resolves.toBeDefined();
    policyBound.effective.policy.steps[0]!.priority += 100;
    await expect(assertResolvedScenarioPolicyHash(policyBound)).rejects.toThrow(
      /resolved scenario hashes/,
    );
  });

  test("closes paginated findings for worker, adapter, and aggregate boundaries", async () => {
    const noOpUpgrade = {
      ...clone(parsedItemInstance),
      effectiveItemId: parsedItemInstance.baseItemId,
      upgrade: {
        upgradeId: "noop",
        fromItemId: parsedItemInstance.baseItemId,
        toItemId: parsedItemInstance.baseItemId,
      },
    };
    expect(() => parseContract(ItemInstanceSchema, noOpUpgrade)).toThrow(
      /unchanged item identity|real identity change/,
    );

    expect(() =>
      parseContract(WorkerMessageSchema, {
        schemaVersion: 1,
        direction: "event",
        payload: {
          schemaVersion: 1,
          eventId: "event-worker",
          timeMs: 0,
          sequence: 1,
          phase: "input",
          kind: "action",
          actorEntityId: "actor",
          targetEntityIds: [],
          causeEventIds: [],
          payload: {},
        },
      }),
    ).toThrow(/expected string/);

    const activeOneShot = clone(sampleSnapshot);
    activeOneShot.policyProgress.steps[0]!.state = "active";
    expect(() =>
      assertResumeCompatible(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
        activeOneShot,
      ),
    ).toThrow(/repeat limit/);

    expect(() =>
      assertMovementResolution(
        {
          entity: transformedCopiedAbility,
          destination: { x: 1, y: 2, z: 3 },
          read: { kind: "snapshot", entityId: "enemy", atTimeMs: 0, stateRevision: 1 },
        },
        mockPortContext,
        { entityId: "actor", accepted: true, position: { x: 1, y: 2, z: 3 }, reason: null },
      ),
    ).toThrow(/requested entity/);

    expect(() =>
      assertTriggerDispatchResult(
        {
          triggerId: "trigger",
          ownerEntityId: "actor",
          event: {
            schemaVersion: 1,
            eventId: "cause",
            timeMs: 0,
            sequence: 1,
            phase: "input",
            kind: "action",
            actorEntityId: "actor",
            targetEntityIds: [],
            causeEventIds: [],
            payload: {},
          },
        },
        mockPortContext,
        { accepted: false, emittedCommands: [{ schemaVersion: 1 }], reason: "rejected" },
      ),
    ).toThrow(/commands must correlate/);

    const impossibleCoverage = clone(censoredResult);
    impossibleCoverage.coverage = {
      killedCount: 0,
      totalCount: 1,
      killedWeight: 1,
      totalWeight: 1,
      fraction: 1,
    };
    expect(() => parseContract(CombatResultSchema, impossibleCoverage)).toThrow(
      /kill count and weight/,
    );

    const contradictoryReadiness = visiblePolicyStateFixture();
    contradictoryReadiness.readiness[0]!.cooldownRemainingMs = 1;
    expect(() => parseContract(PolicyVisibleStateSchema, contradictoryReadiness)).toThrow(
      /zero remaining cooldown/,
    );

    const infiniteAggregate = clone(sampleScenario);
    infiniteAggregate.cohort.normalized = false;
    infiniteAggregate.cohort.weighting = "declared-mass";
    infiniteAggregate.cohort.members[0]!.weight = 1e308;
    infiniteAggregate.cohort.members.push({
      ...clone(infiniteAggregate.cohort.members[0]!),
      memberId: "member-large",
    });
    expect(() => parseContract(ScenarioSpecSchema, infiniteAggregate)).toThrow(
      /aggregate cohort weight must be finite/,
    );

    let getterRan = false;
    const accessor = {};
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => {
        getterRan = true;
        return 1;
      },
    });
    expect(() => canonicalJson(accessor)).toThrow(/accessor/);
    expect(getterRan).toBe(false);

    const scenarioHash = clone(sampleResolvedScenario);
    await bindScenarioHashes(scenarioHash);
    scenarioHash.effective.objective.horizonMs += 1;
    await expect(assertResolvedScenarioPolicyHash(scenarioHash)).rejects.toThrow(
      /resolved scenario hashes/,
    );
  });

  test("closes Prometheus exact-head runtime and cross-field findings", () => {
    const shielded = clone(observedTarget);
    shielded.health.shield = 80;
    const damageRequest = {
      packet: {
        sourceEntityId: "actor",
        targetEntityId: "enemy",
        damageType: "physical" as const,
        rawAmount: 100,
        tags: [] as string[],
        canOverkill: false,
      },
      attacker: transformedCopiedAbility,
      target: shielded,
      attackerStats: { entityId: "actor", revision: 1, values: transformedCopiedAbility.stats },
      targetStats: { entityId: "enemy", revision: 1, values: shielded.stats },
      attackerRead: { kind: "impact" as const, entityId: "actor", atTimeMs: 0, stateRevision: 1 },
      read: { kind: "impact" as const, entityId: "enemy", atTimeMs: 0, stateRevision: 1 },
    };
    expect(() =>
      assertDamageResolution(damageRequest, mockPortContext, {
        attempted: 100,
        prevented: 50,
        absorbed: 50,
        applied: 0,
        overkill: 0,
        discarded: 0,
        targetHealthAfter: shielded.health.current,
        killed: false,
      }),
    ).not.toThrow();

    expect(() =>
      assertTargetingResolution(
        {
          actor: transformedCopiedAbility,
          selector: { kind: "self", actorId: "enemy" },
          visibleState: parseContract(PolicyVisibleStateSchema, visiblePolicyStateFixture()),
          expectedVisibleEntityIds: samplePolicy.visibility.visibleEntityIds,
        },
        { ...mockPortContext, timeMs: 100 },
        { targetEntityIds: ["enemy"], rejected: false, reason: null },
      ),
    ).toThrow(/actor, selector/);
    expect(() =>
      assertResourceResolution(
        { entityId: "actor", resourceId: "mana", delta: 0, reason: "blocked" },
        transformedCopiedAbility,
        {
          accepted: false,
          entityId: "actor",
          resourceId: "mana",
          previous: -1,
          current: -1,
          reason: "blocked",
        },
      ),
    ).toThrow();
    expect(() => assertTimerCancelResult("yes")).toThrow(/boolean/);
    expect(() =>
      assertTimerPeekResult(mockPortContext, {
        ...sampleSnapshot.queue.entries[0]!,
        timeMs: -1,
      }),
    ).toThrow();

    const wrongReplacement = clone(transformedCopiedAbility);
    wrongReplacement.entityId = "other";
    expect(() =>
      assertLifecycleResolution(
        { entityId: "actor", transition: "transform", replacement: wrongReplacement },
        sampleSnapshot.entities,
        {
          accepted: true,
          entityId: "actor",
          transition: "transform",
          state: wrongReplacement,
          reason: null,
        },
      ),
    ).toThrow(/replacement identity/);

    const seededTrials = clone(sampleScenario);
    seededTrials.evaluationMode = {
      kind: "seeded-trajectory",
      random: { kind: "seeded", algorithm: "xorshift32", seed: "seed", trialCount: 2 },
      approximation: null,
    };
    expect(() => parseContract(ScenarioSpecSchema, seededTrials)).toThrow(/exactly one trial/);

    const oneShotLimit = clone(samplePolicy);
    oneShotLimit.steps[0]!.maxRepeats = 2;
    expect(() => parseContract(ActionPolicySchema, oneShotLimit)).toThrow(/null repeat limit/);

    const futureResult = completeSnapshotForTest();
    futureResult.currentTimeMs = 100;
    futureResult.result = clone(censoredResult);
    futureResult.result.killed = true;
    futureResult.result.censoring = "not-censored";
    futureResult.result.metrics.ttk = { status: "value", value: 500 };
    expect(() => parseContract(EngineSnapshotSchema, futureResult)).toThrow(
      /cannot exceed currentTimeMs/,
    );

    const reversedDeaths = clone(censoredResult);
    reversedDeaths.metrics.timeToFirstDeath = { status: "value", value: 200 };
    reversedDeaths.metrics.timeToElimination = { status: "value", value: 100 };
    expect(() => parseContract(CombatResultSchema, reversedDeaths)).toThrow(
      /first death cannot follow/,
    );

    const futureArtifact = clone(sampleRuleset);
    futureArtifact.generatedAt = "2026-09-18T00:00:00Z";
    expect(() => parseContract(ContractSchemas.RulesetManifest, futureArtifact)).toThrow(
      /artifact retrieval cannot follow/,
    );
  });

  test("closes latest exact-head execution boundary findings", async () => {
    const lowHealthTarget = clone(observedTarget);
    lowHealthTarget.health.current = 5;
    const overkillRequest = {
      packet: {
        sourceEntityId: "actor",
        targetEntityId: "enemy",
        damageType: "true" as const,
        rawAmount: 10,
        tags: [] as string[],
        canOverkill: true,
      },
      attacker: transformedCopiedAbility,
      target: lowHealthTarget,
      attackerStats: { entityId: "actor", revision: 1, values: transformedCopiedAbility.stats },
      targetStats: { entityId: "enemy", revision: 1, values: lowHealthTarget.stats },
      attackerRead: { kind: "impact" as const, entityId: "actor", atTimeMs: 0, stateRevision: 1 },
      read: { kind: "impact" as const, entityId: "enemy", atTimeMs: 0, stateRevision: 1 },
    };
    expect(() =>
      assertDamageResolution(overkillRequest, mockPortContext, {
        attempted: 10,
        prevented: 0,
        absorbed: 0,
        applied: 4,
        overkill: 6,
        discarded: 0,
        targetHealthAfter: 1,
        killed: false,
      }),
    ).toThrow(/requested packet and target state/);

    expect(() =>
      assertResourceResolution(
        { entityId: "actor", resourceId: "mana", delta: 100, reason: "restore" },
        transformedCopiedAbility,
        {
          accepted: true,
          entityId: "actor",
          resourceId: "mana",
          previous: transformedCopiedAbility.resources[0]!.current,
          current: transformedCopiedAbility.resources[0]!.maximum + 1,
          reason: null,
        },
      ),
    ).toThrow(/requested mutation/);

    expect(() =>
      assertTimerPeekResult(
        { ...mockPortContext, timeMs: 101 },
        { ...sampleSnapshot.queue.entries[0]!, timeMs: 100 },
      ),
    ).toThrow(/full port ordering key/);

    expect(() =>
      assertMovementResolution(
        {
          entity: transformedCopiedAbility,
          destination: { x: 1, y: 2, z: 3 },
          read: { kind: "snapshot", entityId: "actor", atTimeMs: 0, stateRevision: 1 },
        },
        mockPortContext,
        { entityId: "actor", accepted: false, position: { x: 1, y: 2, z: 3 }, reason: "blocked" },
      ),
    ).toThrow(/destination.*acceptance/);

    expect(() =>
      assertTriggerDispatchResult(
        {
          triggerId: "trigger",
          ownerEntityId: "actor",
          event: {
            schemaVersion: 1,
            eventId: "cause",
            timeMs: 0,
            sequence: 1,
            phase: "input",
            kind: "action",
            actorEntityId: "actor",
            targetEntityIds: [],
            causeEventIds: [],
            payload: {},
          },
        },
        mockPortContext,
        {
          accepted: true,
          emittedCommands: [
            {
              schemaVersion: 1,
              kind: "cancel-event",
              commandId: "late-command",
              issuedAtMs: 101,
              causeEventIds: ["cause"],
              eventId: "scheduled",
            },
          ],
          reason: null,
        },
      ),
    ).toThrow(/dispatch timing/);

    expect(() =>
      parseContract(WorkerMessageSchema, {
        schemaVersion: 1,
        direction: "command",
        payload: {
          schemaVersion: 1,
          kind: "cancel-event",
          commandId: "command",
          issuedAtMs: 0,
          causeEventIds: [],
          eventId: "event",
        },
      }),
    ).toThrow(/expected string/);

    expect(() =>
      parseContract(EngineCommandSchema, {
        schemaVersion: 1,
        kind: "schedule-event",
        commandId: "command",
        issuedAtMs: 0,
        causeEventIds: ["cause"],
        event: {
          ...sampleSnapshot.queue.entries[0]!,
          causeEventIds: [],
        },
      }),
    ).toThrow(/preserve every command cause/);

    const nonKillElimination = clone(censoredResult);
    nonKillElimination.metrics.timeToElimination = { status: "value", value: 100 };
    expect(() => parseContract(CombatResultSchema, nonKillElimination)).toThrow(
      /non-kill.*finite time to elimination/,
    );

    const orphanedPending = clone(sampleSnapshot);
    orphanedPending.pendingActions[0]!.continuationEventId = "missing-event";
    expect(() => parseContract(EngineSnapshotSchema, orphanedPending)).toThrow(
      /queued continuation/,
    );

    const deadRevive = clone(transformedCopiedAbility);
    deadRevive.alive = false;
    deadRevive.health.current = 0;
    const deadExisting = clone(deadRevive);
    expect(() =>
      assertLifecycleResolution(
        { entityId: "actor", transition: "revive", replacement: deadRevive },
        [deadExisting, observedTarget],
        {
          accepted: true,
          entityId: "actor",
          transition: "revive",
          state: deadRevive,
          reason: null,
        },
      ),
    ).toThrow(/alive with positive health/);

    const planned = { ...sampleRunningRun, status: "planned" as const };
    expect(() =>
      assertEngineInputCompatible(
        {
          scenario: sampleResolvedScenario,
          run: planned,
          ports: createMockPorts(),
        },
        planned.engineHash,
      ),
    ).not.toThrow();
    expect(() =>
      assertEngineInputCompatible(
        {
          scenario: sampleResolvedScenario,
          run: sampleRunningRun,
          ports: createMockPorts(),
        },
        sampleRunningRun.engineHash,
      ),
    ).toThrow(/planned for fresh execution/);

    const scriptedScenarioDraft = clone(sampleResolvedScenario);
    scriptedScenarioDraft.effective.policy.mode = "scripted";
    const scriptedScenario = await verifyScenarioForEngine(scriptedScenarioDraft);
    const scriptedRun = clone(sampleRunningRun);
    bindRunToScenario(scriptedRun, scriptedScenario);
    const skippedCursor = clone(sampleSnapshot);
    bindSnapshotToRun(skippedCursor, scriptedRun);
    skippedCursor.policyProgress.nextStepId = "basic-attack";
    skippedCursor.policyProgress.steps[0] = {
      stepId: "cast-w",
      consumedRepeats: 0,
      state: "not-started",
    };
    expect(() =>
      assertResumeCompatible(
        { scenario: scriptedScenario, run: scriptedRun, ports: createMockPorts() },
        skippedCursor,
      ),
    ).toThrow(/first executable step/);
  });

  test("closes latest transfer, targeting, and resume findings", async () => {
    const staleTransfer = clone(sampleTransfer);
    staleTransfer.resolvedScenario.effective.policy.steps[0]!.priority += 100;
    await expect(assertExactComparisonTransfer(staleTransfer)).rejects.toThrow(
      /resolved scenario hashes/,
    );

    const missingReadiness = visiblePolicyStateFixture();
    missingReadiness.readiness = [];
    expect(() => parseContract(PolicyVisibleStateSchema, missingReadiness)).toThrow(
      /every visible ability requires exactly one readiness record/,
    );

    const visible = parseContract(PolicyVisibleStateSchema, visiblePolicyStateFixture());
    const targetingRequest = {
      actor: transformedCopiedAbility,
      selector: { kind: "self" as const, actorId: "actor" },
      visibleState: visible,
      expectedVisibleEntityIds: visible.visibility.visibleEntityIds,
    };
    expect(() =>
      assertTargetingResolution(
        targetingRequest,
        { ...mockPortContext, timeMs: 100 },
        {
          targetEntityIds: ["actor"],
          rejected: true,
          reason: "blocked",
        },
      ),
    ).toThrow(/return no targets/);
    expect(() =>
      assertTargetingResolution(
        targetingRequest,
        { ...mockPortContext, timeMs: 99 },
        {
          targetEntityIds: ["actor"],
          rejected: false,
          reason: null,
        },
      ),
    ).toThrow(/context time/);

    const selfOwned = clone(transformedCopiedAbility);
    selfOwned.ownerEntityId = selfOwned.entityId;
    expect(() => parseContract(EntityStateSchema, selfOwned)).toThrow(/cannot own itself/);

    const seededScenarioDraft = clone(sampleResolvedScenario);
    seededScenarioDraft.effective.evaluationMode = {
      kind: "seeded-trajectory",
      random: { kind: "seeded", algorithm: "xorshift32", seed: "expected", trialCount: 1 },
      approximation: null,
    };
    const seededScenario = await verifyScenarioForEngine(seededScenarioDraft);
    const seededRun = clone(sampleRunningRun);
    seededRun.evaluationMode = clone(seededScenario.effective.evaluationMode);
    seededRun.random = clone(seededRun.evaluationMode.random);
    bindRunToScenario(seededRun, seededScenario);
    const missingRng = clone(sampleSnapshot);
    bindSnapshotToRun(missingRng, seededRun);
    missingRng.numericalBranches[0]!.mode = "seeded-trajectory";
    missingRng.rngStreams = [];
    expect(() =>
      assertResumeCompatible(
        { scenario: seededScenario, run: seededRun, ports: createMockPorts() },
        missingRng,
      ),
    ).toThrow(/retained RNG stream state/);
  });

  test("closes latest continuation, numeric, and execution-boundary findings", async () => {
    const terminalContinuation = clone(sampleSnapshot);
    terminalContinuation.pendingActions[0]!.state = "complete";
    expect(() => parseContract(EngineSnapshotSchema, terminalContinuation)).toThrow(
      /terminal pending actions cannot retain continuations/,
    );

    const sampledScenarioDraft = clone(sampleResolvedScenario);
    sampledScenarioDraft.effective.evaluationMode = {
      kind: "sampled-estimate",
      random: { kind: "seeded", algorithm: "xorshift32", seed: "seed", trialCount: 10 },
      approximation: null,
      confidenceLevel: 0.95,
    };
    const sampledScenario = await verifyScenarioForEngine(sampledScenarioDraft);
    const sampledRun = clone(sampleRunningRun);
    sampledRun.evaluationMode = clone(sampledScenario.effective.evaluationMode);
    sampledRun.random = clone(sampledRun.evaluationMode.random);
    bindRunToScenario(sampledRun, sampledScenario);
    const missingBranch = clone(sampleSnapshot);
    bindSnapshotToRun(missingBranch, sampledRun);
    missingBranch.rngStreams[0]!.algorithm = "xorshift32";
    missingBranch.rngStreams[0]!.seed = "seed";
    missingBranch.numericalBranches = [];
    expect(() =>
      assertResumeCompatible(
        { scenario: sampledScenario, run: sampledRun, ports: createMockPorts() },
        missingBranch,
      ),
    ).toThrow(/retained numerical branch state/);

    const fractionalTarget = clone(observedTarget);
    fractionalTarget.health.current = 1;
    fractionalTarget.health.maximum = 1;
    fractionalTarget.health.shield = 0.2;
    expect(() =>
      assertDamageResolution(
        {
          packet: {
            sourceEntityId: "actor",
            targetEntityId: "enemy",
            damageType: "magic",
            rawAmount: 0.3,
            tags: [],
            canOverkill: false,
          },
          attacker: transformedCopiedAbility,
          target: fractionalTarget,
          attackerStats: { entityId: "actor", revision: 1, values: {} },
          targetStats: { entityId: "enemy", revision: 1, values: {} },
          attackerRead: { kind: "impact", entityId: "actor", atTimeMs: 0, stateRevision: 1 },
          read: { kind: "impact", entityId: "enemy", atTimeMs: 0, stateRevision: 1 },
        },
        mockPortContext,
        {
          attempted: 0.3,
          prevented: 0.1,
          absorbed: 0.2,
          applied: 0,
          overkill: 0,
          discarded: 0,
          targetHealthAfter: 1,
          killed: false,
        },
      ),
    ).not.toThrow();

    expect(() =>
      assertResourceResolution(
        { entityId: "actor", resourceId: "mana", delta: 0.2, reason: "regen" },
        {
          ...transformedCopiedAbility,
          resources: [{ resourceId: "mana", current: 0.1, maximum: 1, regenerationPerSecond: 0 }],
        },
        {
          accepted: true,
          entityId: "actor",
          resourceId: "mana",
          previous: 0.1,
          current: 0.3,
          reason: null,
        },
      ),
    ).not.toThrow();

    const verified = await assertResolvedScenarioPolicyHash(
      await bindScenarioHashes(clone(sampleResolvedScenario)),
    );
    expect(() => {
      verified.effective.entities[0]!.stats.attackDamage = 999;
    }).toThrow();

    const foreignResult = clone(censoredResult);
    foreignResult.runId = "run-foreign";
    const foreignTrace = clone(sampleTrace);
    foreignTrace.runId = "run-foreign";
    expect(() =>
      assertEngineRun(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
        { status: "complete", result: foreignResult, trace: foreignTrace },
      ),
    ).toThrow(/requested run identities/);

    const deadTarget = clone(observedTarget);
    deadTarget.alive = false;
    deadTarget.health.current = 0;
    expect(() =>
      assertDamageResolution(
        {
          packet: {
            sourceEntityId: "actor",
            targetEntityId: "enemy",
            damageType: "true",
            rawAmount: 0,
            tags: [],
            canOverkill: false,
          },
          attacker: transformedCopiedAbility,
          target: deadTarget,
          attackerStats: { entityId: "actor", revision: 1, values: {} },
          targetStats: { entityId: "enemy", revision: 1, values: {} },
          attackerRead: { kind: "impact", entityId: "actor", atTimeMs: 0, stateRevision: 1 },
          read: { kind: "impact", entityId: "enemy", atTimeMs: 0, stateRevision: 1 },
        },
        mockPortContext,
        {
          attempted: 0,
          prevented: 0,
          absorbed: 0,
          applied: 0,
          overkill: 0,
          discarded: 0,
          targetHealthAfter: 0,
          killed: true,
        },
      ),
    ).toThrow(/living target/);

    expect(() =>
      assertStatsSnapshot(
        {
          entity: transformedCopiedAbility,
          read: { kind: "snapshot", entityId: "actor", atTimeMs: 101, stateRevision: 1 },
        },
        { ...mockPortContext, timeMs: 100 },
        { entityId: "actor", revision: 1, values: {} },
      ),
    ).toThrow(/requested entity/);

    const triggerEvent = {
      schemaVersion: 1 as const,
      eventId: "cause",
      timeMs: 100,
      sequence: 1,
      phase: "input" as const,
      kind: "action",
      actorEntityId: "actor",
      targetEntityIds: [] as string[],
      causeEventIds: [] as string[],
      payload: {},
    };
    const duplicateCommand = {
      schemaVersion: 1 as const,
      kind: "cancel-event" as const,
      commandId: "duplicate",
      issuedAtMs: 100,
      causeEventIds: ["cause"],
      eventId: "queued",
    };
    expect(() =>
      assertTriggerDispatchResult(
        { triggerId: "trigger", ownerEntityId: "actor", event: triggerEvent },
        { ...mockPortContext, timeMs: 100 },
        {
          accepted: true,
          emittedCommands: [duplicateCommand, duplicateCommand],
          reason: null,
        },
      ),
    ).toThrow(/command IDs must be unique/);

    const enemyActor = clone(sampleScenario);
    enemyActor.policy.steps[1]!.action.actorId = "enemy";
    expect(() => parseContract(ScenarioSpecSchema, enemyActor)).toThrow(
      /designated scenario actor/,
    );

    const noLivingEnemy = visiblePolicyStateFixture();
    noLivingEnemy.entities[1]!.alive = false;
    noLivingEnemy.entities[1]!.health.current = 0;
    expect(() =>
      assertTargetingResolution(
        {
          actor: transformedCopiedAbility,
          selector: { kind: "lowest-health-visible-enemy", actorId: "actor" },
          visibleState: parseContract(PolicyVisibleStateSchema, noLivingEnemy),
          expectedVisibleEntityIds: noLivingEnemy.visibility.visibleEntityIds,
        },
        { ...mockPortContext, timeMs: 100 },
        { targetEntityIds: [], rejected: false, reason: null },
      ),
    ).toThrow(/must reject when no living enemy/);

    expect(() =>
      parseContract(EngineCommandSchema, {
        schemaVersion: 1,
        kind: "trace",
        commandId: "trace-command",
        issuedAtMs: 100,
        causeEventIds: [],
        event: { ...sampleTrace.events[0]!, timeMs: 101 },
      }),
    ).toThrow(/trace event time must match/);
  });

  test("closes latest frontier, correlation, and immutable-transfer findings", async () => {
    const verifiedTransfer = clone(sampleTransfer);
    await bindScenarioHashes(verifiedTransfer.resolvedScenario as typeof sampleResolvedScenario);
    verifiedTransfer.run.cohortHash =
      verifiedTransfer.resolvedScenario.effective.cohort.contentHash;
    verifiedTransfer.run.policyHash = verifiedTransfer.resolvedScenario.policyHash;
    verifiedTransfer.candidateInputHash = verifiedTransfer.resolvedScenario.candidateInputHash;
    verifiedTransfer.run.candidateInputHash = verifiedTransfer.resolvedScenario.candidateInputHash;
    verifiedTransfer.result.candidateInputHash =
      verifiedTransfer.resolvedScenario.candidateInputHash;
    verifiedTransfer.run.resolvedScenarioHash =
      verifiedTransfer.resolvedScenario.resolvedScenarioHash;
    verifiedTransfer.result.resolvedScenarioHash =
      verifiedTransfer.resolvedScenario.resolvedScenarioHash;
    const frozenTransfer = await assertExactComparisonTransfer(verifiedTransfer);
    expect(() => {
      frozenTransfer.result.warnings.push("mutated");
    }).toThrow();

    const reusedSequence = clone(sampleSnapshot);
    reusedSequence.queue.entries = [];
    reusedSequence.queue.lastProcessedSequence = 3;
    reusedSequence.queue.nextSequence = 3;
    expect(() => parseContract(EngineSnapshotSchema, reusedSequence)).toThrow(
      /greater than every allocated event sequence/,
    );

    const triggerEvent = {
      schemaVersion: 1 as const,
      eventId: "future-cause",
      timeMs: 100,
      sequence: 2,
      phase: "input" as const,
      kind: "action",
      actorEntityId: "actor",
      targetEntityIds: [] as string[],
      causeEventIds: [] as string[],
      payload: {},
    };
    expect(() =>
      assertTriggerDispatchResult(
        { triggerId: "trigger", ownerEntityId: "actor", event: triggerEvent },
        mockPortContext,
        { accepted: true, emittedCommands: [], reason: null },
      ),
    ).toThrow(/event time, sequence/);

    const scriptedScenarioDraft = clone(sampleResolvedScenario);
    scriptedScenarioDraft.effective.policy.mode = "scripted";
    const scriptedScenario = await verifyScenarioForEngine(scriptedScenarioDraft);
    const scriptedRun = clone(sampleRunningRun);
    bindRunToScenario(scriptedRun, scriptedScenario);
    const outOfOrder = clone(sampleSnapshot);
    bindSnapshotToRun(outOfOrder, scriptedRun);
    outOfOrder.policyProgress.nextStepId = "cast-w";
    outOfOrder.policyProgress.steps[0] = {
      stepId: "cast-w",
      consumedRepeats: 0,
      state: "not-started",
    };
    outOfOrder.policyProgress.steps[1] = {
      stepId: "basic-attack",
      consumedRepeats: 1,
      state: "completed",
    };
    expect(() =>
      assertResumeCompatible(
        { scenario: scriptedScenario, run: scriptedRun, ports: createMockPorts() },
        outOfOrder,
      ),
    ).toThrow(/beyond the cursor/);

    const wrongObjective = clone(censoredResult);
    wrongObjective.objective = "ttk";
    expect(() =>
      assertEngineRun(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
        { status: "complete", result: wrongObjective, trace: sampleTrace },
      ),
    ).toThrow(/requested objective/);

    const prematureCensoring = completeSnapshotForTest();
    prematureCensoring.currentTimeMs = 100;
    expect(() => parseContract(EngineSnapshotSchema, prematureCensoring)).toThrow(
      /censoring horizons cannot exceed currentTimeMs/,
    );

    const missingActor = clone(sampleSnapshot);
    missingActor.entities = [clone(observedTarget)];
    missingActor.stateRevisions = { enemy: 1 };
    missingActor.buffs = [];
    missingActor.pendingActions = [];
    missingActor.triggerState = [];
    expect(() =>
      assertResumeCompatible(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
        missingActor,
      ),
    ).toThrow(/retain the designated scenario actor/);

    expect(() =>
      parseContract(CombatResultSchema, {
        ...clone(censoredResult),
        killed: true,
        censoring: "not-censored",
        metrics: {
          ...censoredResult.metrics,
          ttk: { status: "value", value: 5000 },
        },
        coverage: {
          killedCount: 1,
          totalCount: 1,
          killedWeight: 0.30000000000000004,
          totalWeight: 0.3,
          fraction: 1,
        },
      }),
    ).not.toThrow();

    const missingOwner = clone(transformedCopiedAbility);
    missingOwner.ownerEntityId = "missing";
    expect(() =>
      assertLifecycleResolution(
        { entityId: "actor", transition: "transform", replacement: missingOwner },
        sampleSnapshot.entities,
        {
          accepted: true,
          entityId: "actor",
          transition: "transform",
          state: missingOwner,
          reason: null,
        },
      ),
    ).toThrow(/references must resolve/);

    const lowHealth = clone(observedTarget);
    lowHealth.health.current = 5;
    expect(() =>
      assertDamageResolution(
        {
          packet: {
            sourceEntityId: "actor",
            targetEntityId: "enemy",
            damageType: "true",
            rawAmount: 10,
            tags: [],
            canOverkill: false,
          },
          attacker: transformedCopiedAbility,
          target: lowHealth,
          attackerStats: { entityId: "actor", revision: 1, values: {} },
          targetStats: { entityId: "enemy", revision: 1, values: {} },
          attackerRead: { kind: "impact", entityId: "actor", atTimeMs: 0, stateRevision: 1 },
          read: { kind: "impact", entityId: "enemy", atTimeMs: 0, stateRevision: 1 },
        },
        mockPortContext,
        {
          attempted: 10,
          prevented: 0,
          absorbed: 0,
          applied: 5,
          overkill: 5,
          discarded: 0,
          targetHealthAfter: 0,
          killed: true,
        },
      ),
    ).toThrow(/requested packet and target state/);
  });

  test("closes latest visibility, clock, hash, and statistical findings", async () => {
    const visible = parseContract(PolicyVisibleStateSchema, visiblePolicyStateFixture());
    expect(() =>
      assertTargetingResolution(
        {
          actor: transformedCopiedAbility,
          selector: { kind: "self", actorId: "actor" },
          visibleState: visible,
          expectedVisibleEntityIds: ["actor"],
        },
        { ...mockPortContext, timeMs: 100 },
        { targetEntityIds: ["actor"], rejected: false, reason: null },
      ),
    ).toThrow(/scenario allowlist/);

    const child = clone(observedTarget);
    child.ownerEntityId = "actor";
    const cyclicReplacement = clone(transformedCopiedAbility);
    cyclicReplacement.ownerEntityId = "enemy";
    expect(() =>
      assertLifecycleResolution(
        { entityId: "actor", transition: "transform", replacement: cyclicReplacement },
        [transformedCopiedAbility, child],
        {
          accepted: true,
          entityId: "actor",
          transition: "transform",
          state: cyclicReplacement,
          reason: null,
        },
      ),
    ).toThrow(/ownership cannot create cycles/);

    const clockDamage = {
      packet: {
        sourceEntityId: "actor",
        targetEntityId: "enemy",
        damageType: "true" as const,
        rawAmount: 0,
        tags: [] as string[],
        canOverkill: false,
      },
      attacker: transformedCopiedAbility,
      target: observedTarget,
      attackerStats: { entityId: "actor", revision: 1, values: transformedCopiedAbility.stats },
      targetStats: { entityId: "enemy", revision: 1, values: observedTarget.stats },
      attackerRead: { kind: "impact" as const, entityId: "actor", atTimeMs: 100, stateRevision: 1 },
      read: { kind: "impact" as const, entityId: "enemy", atTimeMs: 101, stateRevision: 1 },
    };
    expect(() =>
      assertDamageResolution(
        clockDamage,
        { ...mockPortContext, timeMs: 100 },
        {
          attempted: 0,
          prevented: 0,
          absorbed: 0,
          applied: 0,
          overkill: 0,
          discarded: 0,
          targetHealthAfter: observedTarget.health.current,
          killed: false,
        },
      ),
    ).toThrow(/identities/);
    expect(() =>
      assertMovementResolution(
        {
          entity: transformedCopiedAbility,
          destination: { x: 1, y: 2, z: 3 },
          read: { kind: "snapshot", entityId: "actor", atTimeMs: 101, stateRevision: 1 },
        },
        { ...mockPortContext, timeMs: 100 },
        { entityId: "actor", accepted: true, position: { x: 1, y: 2, z: 3 }, reason: null },
      ),
    ).toThrow(/requested entity/);

    const sampledInputRun = clone(sampleRunningRun);
    sampledInputRun.evaluationMode = {
      kind: "sampled-estimate",
      random: { kind: "seeded", algorithm: "xorshift32", seed: "seed", trialCount: 10 },
      approximation: null,
      confidenceLevel: 0.95,
    };
    sampledInputRun.random = clone(sampledInputRun.evaluationMode.random);
    const sampledOutput = clone(censoredResult);
    sampledOutput.uncertainty = {
      effectiveSampleCount: 2,
      confidenceLevel: 0.5,
      standardErrors: {},
    };
    expect(() =>
      assertEngineRun(
        { scenario: sampleResolvedScenario, run: sampledInputRun, ports: createMockPorts() },
        { status: "complete", result: sampledOutput, trace: sampleTrace },
      ),
    ).toThrow(/confidence and metric/);
    const failIfNotKilled = clone(sampleRunningRun);
    failIfNotKilled.objective.censoring = "fail-if-not-killed";
    expect(() =>
      assertEngineRun(
        { scenario: sampleResolvedScenario, run: failIfNotKilled, ports: createMockPorts() },
        { status: "complete", result: censoredResult, trace: sampleTrace },
      ),
    ).toThrow(/fail-if-not-killed/);

    expect(() =>
      assertDamageResolution(
        {
          ...clockDamage,
          packet: { ...clockDamage.packet, rawAmount: 0.3 },
          attackerRead: { ...clockDamage.attackerRead, atTimeMs: 0 },
          read: { ...clockDamage.read, atTimeMs: 0 },
        },
        mockPortContext,
        {
          attempted: 0.3,
          prevented: 0.1 + 0.2,
          absorbed: 0,
          applied: 0,
          overkill: 0,
          discarded: 0,
          targetHealthAfter: observedTarget.health.current,
          killed: false,
        },
      ),
    ).not.toThrow();
    expect(() =>
      assertTimerPeekResult(
        { ...mockPortContext, timeMs: 100, sequence: 5 },
        { ...sampleSnapshot.queue.entries[0]!, timeMs: 100, sequence: 4 },
      ),
    ).toThrow(/full port ordering key/);

    const planned = clone(sampleRunningRun);
    planned.status = "planned";
    const validated = assertEngineInputCompatible(
      {
        scenario: sampleResolvedScenario,
        run: planned,
        ports: createMockPorts(),
      },
      planned.engineHash,
    );
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.run)).toBe(true);
    expect(() => {
      validated.run.objective.horizonMs = 1;
    }).toThrow();

    const staleCohort = await bindScenarioHashes(clone(sampleResolvedScenario));
    staleCohort.effective.cohort.members[0]!.matchKey = "changed-match";
    staleCohort.resolvedScenarioHash = await hashCanonical(staleCohort.effective);
    await expect(assertResolvedScenarioPolicyHash(staleCohort)).rejects.toThrow(
      /resolved scenario hashes/,
    );

    expect(() =>
      parseContract(EngineEventSchema, {
        schemaVersion: 1,
        eventId: "self-cause",
        timeMs: 0,
        sequence: 1,
        phase: "input",
        kind: "action",
        actorEntityId: "actor",
        targetEntityIds: [],
        causeEventIds: ["self-cause"],
        payload: {},
      }),
    ).toThrow(/cannot cite itself/);
    expect(() =>
      assertResourceResolution(
        { entityId: "actor", resourceId: "mana", delta: Number.NaN, reason: "bad" },
        transformedCopiedAbility,
        {
          accepted: true,
          entityId: "actor",
          resourceId: "mana",
          previous: transformedCopiedAbility.resources[0]!.current,
          current: transformedCopiedAbility.resources[0]!.current,
          reason: null,
        },
      ),
    ).toThrow(/delta must be finite/);

    const missingFirstDeath = clone(censoredResult);
    missingFirstDeath.killed = true;
    missingFirstDeath.censoring = "not-censored";
    missingFirstDeath.metrics.ttk = { status: "value", value: 100 };
    missingFirstDeath.metrics.timeToElimination = { status: "value", value: 100 };
    expect(() => parseContract(CombatResultSchema, missingFirstDeath)).toThrow(
      /finite elimination requires a finite first-death/,
    );
    expect(() =>
      assertStatsSnapshot(
        {
          entity: transformedCopiedAbility,
          read: { kind: "snapshot", entityId: "actor", atTimeMs: 0, stateRevision: 1 },
        },
        mockPortContext,
        { entityId: "actor", revision: 1, values: {} },
      ),
    ).toThrow(/baseline stat/);
  });

  test("closes latest damage, resume, identity, and frontier findings", async () => {
    const lowHealth = clone(observedTarget);
    lowHealth.health.current = 5;
    const damageRequest = {
      packet: {
        sourceEntityId: "actor",
        targetEntityId: "enemy",
        damageType: "true" as const,
        rawAmount: 10,
        tags: [] as string[],
        canOverkill: false,
      },
      attacker: transformedCopiedAbility,
      target: lowHealth,
      attackerStats: { entityId: "actor", revision: 2, values: transformedCopiedAbility.stats },
      targetStats: { entityId: "enemy", revision: 2, values: lowHealth.stats },
      attackerRead: { kind: "impact" as const, entityId: "actor", atTimeMs: 0, stateRevision: 2 },
      read: { kind: "impact" as const, entityId: "enemy", atTimeMs: 0, stateRevision: 2 },
    };
    expect(() =>
      assertDamageResolution(damageRequest, mockPortContext, {
        attempted: 10,
        prevented: 0,
        absorbed: 0,
        applied: 5,
        overkill: 0,
        discarded: 5,
        targetHealthAfter: 0,
        killed: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertDamageResolution(
        { ...damageRequest, targetStats: { ...damageRequest.targetStats, revision: 1 } },
        mockPortContext,
        {
          attempted: 10,
          prevented: 0,
          absorbed: 0,
          applied: 5,
          overkill: 0,
          discarded: 5,
          targetHealthAfter: 0,
          killed: true,
        },
      ),
    ).toThrow(/identities/);

    const horizonRun = clone(sampleRunningRun);
    horizonRun.objective = {
      ...horizonRun.objective,
      kind: "ttk",
      primaryMetric: "ttk",
      horizonMs: 5000,
    };
    const beyondHorizon = clone(censoredResult);
    beyondHorizon.objective = "ttk";
    beyondHorizon.killed = true;
    beyondHorizon.censoring = "not-censored";
    beyondHorizon.metrics.ttk = { status: "value", value: 6000 };
    beyondHorizon.metrics.timeToFirstDeath = { status: "value", value: 6000 };
    beyondHorizon.metrics.timeToElimination = { status: "value", value: 6000 };
    expect(() =>
      assertEngineRun(
        { scenario: sampleResolvedScenario, run: horizonRun, ports: createMockPorts() },
        { status: "complete", result: beyondHorizon, trace: sampleTrace },
      ),
    ).toThrow(/objective horizon/);

    const outOfAllocationOrder = clone(sampleSnapshot);
    outOfAllocationOrder.trace.events = [outOfAllocationOrder.trace.events[1]!];
    outOfAllocationOrder.trace.truncated = true;
    outOfAllocationOrder.trace.truncationReason = "earlier allocation remains queued";
    outOfAllocationOrder.queue.entries[0]!.sequence = 1;
    expect(() => parseContract(EngineSnapshotSchema, outOfAllocationOrder)).not.toThrow();

    const sampledRun = clone(sampleRunningRun);
    sampledRun.evaluationMode = {
      kind: "sampled-estimate",
      random: { kind: "seeded", algorithm: "xorshift32", seed: "seed", trialCount: 10 },
      approximation: null,
      confidenceLevel: 0.95,
    };
    sampledRun.random = clone(sampledRun.evaluationMode.random);
    const undersampled = clone(censoredResult);
    undersampled.uncertainty = {
      effectiveSampleCount: 1,
      confidenceLevel: 0.95,
      standardErrors: { damage: 1 },
    };
    expect(() =>
      assertEngineRun(
        { scenario: sampleResolvedScenario, run: sampledRun, ports: createMockPorts() },
        { status: "complete", result: undersampled, trace: sampleTrace },
      ),
    ).toThrow(/confidence and metric/);

    const triggerEvent = {
      schemaVersion: 1 as const,
      eventId: "trigger-event",
      timeMs: 0,
      sequence: 1,
      phase: "input" as const,
      kind: "action",
      actorEntityId: "actor",
      targetEntityIds: [] as string[],
      causeEventIds: [] as string[],
      payload: {},
    };
    expect(() =>
      assertTriggerDispatchResult(
        { triggerId: "trigger", ownerEntityId: "actor", event: triggerEvent },
        mockPortContext,
        {
          accepted: true,
          reason: null,
          emittedCommands: [
            {
              schemaVersion: 1,
              kind: "schedule-event",
              commandId: "retroactive-sequence",
              issuedAtMs: 0,
              causeEventIds: ["trigger-event"],
              event: {
                eventId: "scheduled",
                timeMs: 0,
                sequence: 1,
                phase: "impact",
                kind: "damage",
                payload: {},
                causeEventIds: ["trigger-event"],
              },
            },
          ],
        },
      ),
    ).toThrow(/dispatch timing/);

    const resumed = assertResumeCompatible(
      { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
      sampleSnapshot,
    );
    expect(Object.isFrozen(resumed)).toBe(true);
    expect(Object.isFrozen(resumed.input.run)).toBe(true);
    expect(Object.isFrozen(resumed.snapshot)).toBe(true);

    const foreignResult = clone(censoredResult);
    foreignResult.objective = "ttk";
    for (const metric of Object.values(foreignResult.metrics)) {
      if (metric.status === "censored") metric.horizonMs = sampleSnapshot.currentTimeMs;
    }
    const terminalSnapshot = clone(sampleSnapshot);
    terminalSnapshot.status = "complete";
    terminalSnapshot.resumability = "non-resumable";
    terminalSnapshot.interruption = { state: "completed", reason: null };
    terminalSnapshot.queue.entries = [];
    terminalSnapshot.pendingActions = [];
    terminalSnapshot.result = foreignResult;
    expect(() =>
      assertEngineStepResult(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
        {
          schemaVersion: 1,
          status: "complete",
          snapshot: terminalSnapshot,
          emittedEvents: [],
          result: foreignResult,
          reason: null,
        },
      ),
    ).toThrow(/requested objective/);

    const absent = clone(transformedCopiedAbility);
    absent.entityId = "absent";
    expect(() =>
      assertLifecycleResolution(
        { entityId: "absent", transition: "transform", replacement: absent },
        sampleSnapshot.entities,
        {
          accepted: true,
          entityId: "absent",
          transition: "transform",
          state: absent,
          reason: null,
        },
      ),
    ).toThrow(/authoritative entity existence/);
    expect(() =>
      assertLifecycleResolution(
        { entityId: "actor", transition: "spawn", replacement: transformedCopiedAbility },
        sampleSnapshot.entities,
        {
          accepted: true,
          entityId: "actor",
          transition: "spawn",
          state: transformedCopiedAbility,
          reason: null,
        },
      ),
    ).toThrow(/authoritative entity existence/);

    const earlyContinuation = clone(sampleSnapshot);
    earlyContinuation.pendingActions[0]!.startedAtMs = 1000;
    earlyContinuation.queue.entries[0]!.timeMs = 500;
    expect(() => parseContract(EngineSnapshotSchema, earlyContinuation)).toThrow(
      /cannot precede the action start/,
    );
    expect(() =>
      parseContract(TraceEventSchema, {
        ...sampleTrace.events[0]!,
        causeEventIds: [sampleTrace.events[0]!.eventId],
      }),
    ).toThrow(/cannot cite itself/);

    const verifiedRuleset = clone(sampleRuleset);
    const rulesetBytes = Object.fromEntries(
      Object.entries(verifiedRuleset).filter(([key]) => key !== "manifestHash"),
    );
    verifiedRuleset.manifestHash = await hashCanonical(rulesetBytes);
    await expect(assertRulesetManifestHash(verifiedRuleset)).resolves.toBeDefined();
    verifiedRuleset.patch = "changed-patch";
    await expect(assertRulesetManifestHash(verifiedRuleset)).rejects.toThrow(/manifest hash/);

    const staleCandidate = await bindScenarioHashes(clone(sampleResolvedScenario));
    staleCandidate.candidateInput = { candidateId: "changed" };
    await expect(assertResolvedScenarioPolicyHash(staleCandidate)).rejects.toThrow(
      /resolved scenario hashes/,
    );

    expect(() =>
      assertTriggerDispatchResult(
        {
          triggerId: "trigger",
          ownerEntityId: "actor",
          event: { ...triggerEvent, causeEventIds: ["event-a"] },
        },
        { ...mockPortContext, causeEventIds: ["event-b"] },
        { accepted: true, emittedCommands: [], reason: null },
      ),
    ).toThrow(/causes must match/);
  });

  test("closes latest portable-resume and output-frontier findings", () => {
    const dependent = clone(observedTarget);
    dependent.ownerEntityId = "actor";
    expect(() =>
      assertLifecycleResolution(
        { entityId: "actor", transition: "despawn", replacement: null },
        [transformedCopiedAbility, dependent],
        {
          accepted: true,
          entityId: "actor",
          transition: "despawn",
          state: null,
          reason: null,
        },
      ),
    ).toThrow(/dangling entity references/);

    const coverageRun = clone(sampleRunningRun);
    coverageRun.objective.aggregation = "coverage-then-ttk";
    expect(() =>
      assertEngineRun(
        { scenario: sampleResolvedScenario, run: coverageRun, ports: createMockPorts() },
        { status: "complete", result: censoredResult, trace: sampleTrace },
      ),
    ).toThrow(/coverage.*cohort denominator/);

    const foreignSnapshot = clone(sampleSnapshot);
    foreignSnapshot.engineHash = HASH_C;
    expect(() =>
      assertEngineStepResult(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
        {
          schemaVersion: 1,
          status: "progress",
          snapshot: foreignSnapshot,
          emittedEvents: [],
          result: null,
          reason: foreignSnapshot.interruption.reason,
        },
      ),
    ).toThrow(/every requested run identity/);

    const beyondProcessed = clone(sampleSnapshot);
    beyondProcessed.queue.entries[0]!.sequence = 4;
    beyondProcessed.queue.nextSequence = 5;
    expect(() =>
      parseContract(EngineStepResultSchema, {
        schemaVersion: 1,
        status: "progress",
        snapshot: beyondProcessed,
        emittedEvents: [
          {
            schemaVersion: 1,
            eventId: "emitted-3",
            timeMs: 100,
            sequence: 3,
            phase: "impact",
            kind: "damage",
            actorEntityId: "actor",
            targetEntityIds: ["enemy"],
            causeEventIds: [],
            payload: {},
          },
        ],
        result: null,
        reason: beyondProcessed.interruption.reason,
      }),
    ).toThrow(/snapshot frontier/);

    const triggerEvent = {
      schemaVersion: 1 as const,
      eventId: "trigger-event",
      timeMs: 0,
      sequence: 1,
      phase: "input" as const,
      kind: "action",
      actorEntityId: "actor",
      targetEntityIds: [] as string[],
      causeEventIds: [] as string[],
      payload: {},
    };
    const scheduledCommand = {
      schemaVersion: 1 as const,
      kind: "schedule-event" as const,
      commandId: "schedule-a",
      issuedAtMs: 0,
      causeEventIds: ["trigger-event"],
      event: {
        eventId: "same-event",
        timeMs: 1,
        sequence: 2,
        phase: "impact" as const,
        kind: "damage",
        payload: {},
        causeEventIds: ["trigger-event"],
      },
    };
    expect(() =>
      assertTriggerDispatchResult(
        { triggerId: "trigger", ownerEntityId: "actor", event: triggerEvent },
        mockPortContext,
        {
          accepted: true,
          reason: null,
          emittedCommands: [scheduledCommand, { ...scheduledCommand, commandId: "schedule-b" }],
        },
      ),
    ).toThrow(/scheduled event IDs and sequences/);

    const lateTrace = clone(sampleTrace);
    lateTrace.events[1]!.timeMs = sampleRunningRun.objective.horizonMs + 1;
    expect(() =>
      assertEngineRun(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
        { status: "complete", result: censoredResult, trace: lateTrace },
      ),
    ).toThrow(/trace events cannot exceed/);

    const sharedContinuation = clone(sampleSnapshot);
    sharedContinuation.pendingActions.push({
      ...clone(sharedContinuation.pendingActions[0]!),
      actionId: "action-002",
    });
    expect(() => parseContract(EngineSnapshotSchema, sharedContinuation)).toThrow(
      /unique continuation events/,
    );
    const missingRevision = clone(sampleSnapshot);
    delete missingRevision.stateRevisions.enemy;
    expect(() => parseContract(EngineSnapshotSchema, missingRevision)).toThrow(
      /cover every entity exactly/,
    );

    const ports = createMockPorts();
    ports.trace.restore(sampleTrace, mockPortContext);
    expect(ports.trace.snapshot(mockPortContext.runId).events).toEqual(sampleTrace.events);

    const staleAttacker = {
      packet: {
        sourceEntityId: "actor",
        targetEntityId: "enemy",
        damageType: "true" as const,
        rawAmount: 0,
        tags: [] as string[],
        canOverkill: false,
      },
      attacker: transformedCopiedAbility,
      target: observedTarget,
      attackerStats: { entityId: "actor", revision: 1, values: transformedCopiedAbility.stats },
      targetStats: { entityId: "enemy", revision: 2, values: observedTarget.stats },
      attackerRead: {
        kind: "impact" as const,
        entityId: "actor",
        atTimeMs: 0,
        stateRevision: 2,
      },
      read: { kind: "impact" as const, entityId: "enemy", atTimeMs: 0, stateRevision: 2 },
    };
    expect(() =>
      assertDamageResolution(staleAttacker, mockPortContext, {
        attempted: 0,
        prevented: 0,
        absorbed: 0,
        applied: 0,
        overkill: 0,
        discarded: 0,
        targetHealthAfter: observedTarget.health.current,
        killed: false,
      }),
    ).toThrow(/identities/);

    const consumedDeterministic = clone(sampleSnapshot);
    consumedDeterministic.rngStreams[0]!.drawCount = 1;
    consumedDeterministic.rngStreams[0]!.state = [1];
    expect(() =>
      assertResumeCompatible(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
        consumedDeterministic,
      ),
    ).toThrow(/deterministic resume cannot retain consumed RNG state/);
  });

  test("closes latest snapshot, interruption, and detached-output findings", async () => {
    const zeroRevision = clone(sampleSnapshot);
    zeroRevision.stateRevisions.actor = 0;
    expect(() => parseContract(EngineSnapshotSchema, zeroRevision)).toThrow(
      /expected number to be >0/,
    );

    const futureTrace = clone(sampleSnapshot);
    futureTrace.trace.events[1]!.sequence = 99;
    expect(() => parseContract(EngineSnapshotSchema, futureTrace)).toThrow(/processed frontier/);

    expect(() =>
      assertLifecycleResolution(
        { entityId: "actor", transition: "revive", replacement: transformedCopiedAbility },
        sampleSnapshot.entities,
        {
          accepted: true,
          entityId: "actor",
          transition: "revive",
          state: transformedCopiedAbility,
          reason: null,
        },
      ),
    ).toThrow(/existing dead entity/);

    const interruptedRun = clone(sampleRunningRun);
    interruptedRun.objective.censoring = "fail-if-not-killed";
    const interruptedScenarioDraft = clone(sampleResolvedScenario);
    interruptedScenarioDraft.effective.objective = clone(interruptedRun.objective);
    const interruptedScenario = await verifyScenarioForEngine(interruptedScenarioDraft);
    bindRunToScenario(interruptedRun, interruptedScenario);
    const interruptedResult = clone(censoredResult);
    interruptedResult.status = "incomplete";
    interruptedResult.censoring = "invalid";
    interruptedResult.metrics.ttk = { status: "undefined", reason: "budget" };
    interruptedResult.resolvedScenarioHash = interruptedRun.resolvedScenarioHash;
    interruptedResult.candidateInputHash = interruptedRun.candidateInputHash;
    const interruptedSnapshot = completeSnapshotForTest();
    interruptedSnapshot.status = "incomplete";
    interruptedSnapshot.interruption = { state: "budget-exhausted", reason: "budget" };
    interruptedSnapshot.result = interruptedResult;
    bindSnapshotToRun(interruptedSnapshot, interruptedRun);
    expect(() =>
      assertEngineStepResult(
        { scenario: interruptedScenario, run: interruptedRun, ports: createMockPorts() },
        {
          schemaVersion: 1,
          status: "incomplete",
          snapshot: interruptedSnapshot,
          emittedEvents: [],
          result: interruptedResult,
          reason: "budget",
        },
      ),
    ).not.toThrow();

    const lateStep = clone(sampleSnapshot);
    lateStep.currentTimeMs = sampleRunningRun.objective.horizonMs + 1;
    lateStep.queue.entries = [];
    lateStep.pendingActions = [];
    lateStep.buffs.forEach((buff) => (buff.expiresAtMs = null));
    lateStep.entities.forEach((entity) =>
      entity.buffs.forEach((buff) => (buff.expiresAtMs = null)),
    );
    expect(() =>
      assertEngineStepResult(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
        {
          schemaVersion: 1,
          status: "progress",
          snapshot: lateStep,
          emittedEvents: [],
          result: null,
          reason: lateStep.interruption.reason,
        },
      ),
    ).toThrow(/objective horizon/);

    const foreignTrace = completeSnapshotForTest();
    foreignTrace.result!.traceId = "foreign-trace";
    expect(() => parseContract(EngineSnapshotSchema, foreignTrace)).toThrow(/identity must match/);

    const visible = parseContract(PolicyVisibleStateSchema, visiblePolicyStateFixture());
    const adapterTargets = ["actor"];
    const detached = assertTargetingResolution(
      {
        actor: transformedCopiedAbility,
        selector: { kind: "self", actorId: "actor" },
        visibleState: visible,
        expectedVisibleEntityIds: visible.visibility.visibleEntityIds,
      },
      { ...mockPortContext, timeMs: 100 },
      { targetEntityIds: adapterTargets, rejected: false, reason: null },
    );
    adapterTargets[0] = "enemy";
    expect(detached.targetEntityIds).toEqual(["actor"]);

    expect(() =>
      assertResourceResolution(
        { entityId: "enemy", resourceId: "mana", delta: 0, reason: "bad-owner" },
        transformedCopiedAbility,
        {
          accepted: true,
          entityId: "enemy",
          resourceId: "mana",
          previous: transformedCopiedAbility.resources[0]!.current,
          current: transformedCopiedAbility.resources[0]!.current,
          reason: null,
        },
      ),
    ).toThrow(/belong to the mutated entity/);
  });

  test("closes latest queue, resume, lifecycle, coverage, and impact-read findings", () => {
    const reusedQueuedId = clone(sampleSnapshot);
    reusedQueuedId.queue.entries[0]!.eventId = reusedQueuedId.trace.events[0]!.eventId;
    expect(() => parseContract(EngineSnapshotSchema, reusedQueuedId)).toThrow(/retained trace/);

    const foreignPolicyProgress = clone(sampleSnapshot);
    foreignPolicyProgress.policyProgress.policyId = "foreign-policy";
    expect(() =>
      assertEngineStepResult(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
        {
          schemaVersion: 1,
          status: "progress",
          snapshot: foreignPolicyProgress,
          emittedEvents: [],
          result: null,
          reason: foreignPolicyProgress.interruption.reason,
        },
      ),
    ).toThrow(/policyId differs/);

    const deadActor = clone(transformedCopiedAbility);
    deadActor.alive = false;
    deadActor.health.current = 0;
    expect(() =>
      assertLifecycleResolution(
        { entityId: "actor", transition: "death", replacement: null },
        sampleSnapshot.entities,
        {
          accepted: true,
          entityId: "actor",
          transition: "death",
          state: null,
          reason: null,
        },
      ),
    ).toThrow(/preserve a dead entity/);
    expect(() =>
      assertLifecycleResolution(
        { entityId: "actor", transition: "death", replacement: transformedCopiedAbility },
        sampleSnapshot.entities,
        {
          accepted: true,
          entityId: "actor",
          transition: "death",
          state: transformedCopiedAbility,
          reason: null,
        },
      ),
    ).toThrow(/preserve a dead entity/);
    expect(
      assertLifecycleResolution(
        { entityId: "actor", transition: "death", replacement: deadActor },
        sampleSnapshot.entities,
        {
          accepted: true,
          entityId: "actor",
          transition: "death",
          state: deadActor,
          reason: null,
        },
      ).state,
    ).toMatchObject({ entityId: "actor", alive: false, health: { current: 0 } });

    const tinyPartialCoverage = clone(censoredResult);
    tinyPartialCoverage.coverage = {
      killedCount: 1,
      totalCount: 2,
      killedWeight: 1 - 5e-13,
      totalWeight: 1,
      fraction: 1 - 5e-13,
    };
    expect(parseContract(CombatResultSchema, tinyPartialCoverage).coverage).toEqual(
      tinyPartialCoverage.coverage,
    );

    const snapshotReadDamage = {
      packet: {
        sourceEntityId: "actor",
        targetEntityId: "enemy",
        damageType: "true" as const,
        rawAmount: 0,
        tags: [] as string[],
        canOverkill: false,
      },
      attacker: transformedCopiedAbility,
      target: observedTarget,
      attackerStats: { entityId: "actor", revision: 1, values: transformedCopiedAbility.stats },
      targetStats: { entityId: "enemy", revision: 1, values: observedTarget.stats },
      attackerRead: {
        kind: "snapshot" as const,
        entityId: "actor",
        atTimeMs: 0,
        stateRevision: 1,
      },
      read: { kind: "snapshot" as const, entityId: "enemy", atTimeMs: 0, stateRevision: 1 },
    };
    expect(() =>
      assertDamageResolution(snapshotReadDamage, mockPortContext, {
        attempted: 0,
        prevented: 0,
        absorbed: 0,
        applied: 0,
        overkill: 0,
        discarded: 0,
        targetHealthAfter: observedTarget.health.current,
        killed: false,
      }),
    ).toThrow(/identities/);
  });

  test("closes latest cause, lifecycle, denominator, queue, and censoring findings", () => {
    const unresolvedQueuedCause = clone(sampleSnapshot);
    unresolvedQueuedCause.queue.entries[0]!.causeEventIds = ["missing-cause"];
    expect(() => parseContract(EngineSnapshotSchema, unresolvedQueuedCause)).toThrow(
      /resolve to a retained trace or earlier queued event/,
    );

    const alreadyDead = clone(transformedCopiedAbility);
    alreadyDead.alive = false;
    alreadyDead.health.current = 0;
    expect(() =>
      assertLifecycleResolution(
        { entityId: "actor", transition: "death", replacement: alreadyDead },
        [alreadyDead, observedTarget],
        {
          accepted: true,
          entityId: "actor",
          transition: "death",
          state: alreadyDead,
          reason: null,
        },
      ),
    ).toThrow(/existing living entity/);

    const foreignCoverage = clone(censoredResult);
    foreignCoverage.coverage = {
      killedCount: 0,
      totalCount: 99,
      killedWeight: 0,
      totalWeight: 99,
      fraction: 0,
    };
    expect(() =>
      assertEngineRun(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
        { status: "complete", result: foreignCoverage, trace: sampleTrace },
      ),
    ).toThrow(/coverage.*cohort denominator/);

    const reusedTraceSequence = clone(sampleSnapshot);
    reusedTraceSequence.queue.entries[0]!.sequence = reusedTraceSequence.trace.events[0]!.sequence;
    expect(() => parseContract(EngineSnapshotSchema, reusedTraceSequence)).toThrow(
      /identities.*retained trace/,
    );

    const killedWithCensoredPrimary = clone(censoredResult);
    killedWithCensoredPrimary.objective = "first-death";
    killedWithCensoredPrimary.killed = true;
    killedWithCensoredPrimary.censoring = "not-censored";
    killedWithCensoredPrimary.metrics.ttk = { status: "value", value: 100 };
    killedWithCensoredPrimary.metrics.timeToFirstDeath = {
      status: "censored",
      horizonMs: 5000,
    };
    expect(() => parseContract(CombatResultSchema, killedWithCensoredPrimary)).toThrow(
      /objective-valid primary metric/,
    );
  });

  test("closes latest emitted-cause, transfer, actor, and scheduling findings", () => {
    expect(() =>
      parseContract(EngineStepResultSchema, {
        schemaVersion: 1,
        status: "progress",
        snapshot: sampleSnapshot,
        emittedEvents: [
          {
            schemaVersion: 1,
            eventId: "emitted-with-missing-cause",
            timeMs: 100,
            sequence: 2,
            phase: "impact",
            kind: "damage",
            actorEntityId: "actor",
            targetEntityIds: ["enemy"],
            causeEventIds: ["missing-cause"],
            payload: {},
          },
        ],
        result: null,
        reason: sampleSnapshot.interruption.reason,
      }),
    ).toThrow(/already executed event/);

    const transferWithForeignCoverage = clone(sampleTransfer);
    transferWithForeignCoverage.result.coverage = {
      killedCount: 0,
      totalCount: 99,
      killedWeight: 0,
      totalWeight: 99,
      fraction: 0,
    };
    expect(() => parseContract(ExactComparisonTransferSchema, transferWithForeignCoverage)).toThrow(
      /coverage denominator.*transferred cohort/,
    );

    const enemyActorSnapshot = clone(sampleSnapshot);
    enemyActorSnapshot.entities.find((entity) => entity.entityId === "actor")!.team = "enemy";
    expect(() =>
      assertResumeCompatible(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
        enemyActorSnapshot,
      ),
    ).toThrow(/actor team/);

    const triggerEvent = {
      schemaVersion: 1 as const,
      eventId: "trigger-sequence-2",
      timeMs: 0,
      sequence: 2,
      phase: "input" as const,
      kind: "action",
      actorEntityId: "actor",
      targetEntityIds: [] as string[],
      causeEventIds: [] as string[],
      payload: {},
    };
    expect(() =>
      assertTriggerDispatchResult(
        { triggerId: "trigger", ownerEntityId: "actor", event: triggerEvent },
        { ...mockPortContext, sequence: 2 },
        {
          accepted: true,
          reason: null,
          emittedCommands: [
            {
              schemaVersion: 1,
              kind: "schedule-event",
              commandId: "reused-sequence",
              issuedAtMs: 0,
              causeEventIds: ["trigger-sequence-2"],
              event: {
                eventId: "future-event",
                timeMs: 1000,
                sequence: 2,
                phase: "impact",
                kind: "damage",
                payload: {},
                causeEventIds: ["trigger-sequence-2"],
              },
            },
          ],
        },
      ),
    ).toThrow(/dispatch timing and causal identity/);

    expect(() =>
      parseContract(EngineCommandSchema, {
        schemaVersion: 1,
        kind: "schedule-event",
        commandId: "self-causal-schedule",
        issuedAtMs: 0,
        causeEventIds: ["self-causal-event"],
        event: {
          eventId: "self-causal-event",
          timeMs: 1,
          sequence: 3,
          phase: "impact",
          kind: "damage",
          payload: {},
          causeEventIds: ["self-causal-event"],
        },
      }),
    ).toThrow(/cannot cite itself/);
  });

  test("closes latest terminal, frontier, lifecycle, policy, and mock findings", () => {
    const terminalSnapshot = completeSnapshotForTest();
    terminalSnapshot.policyProgress.policyId = "foreign-policy";
    expect(() =>
      assertEngineStepResult(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
        {
          schemaVersion: 1,
          status: "complete",
          snapshot: terminalSnapshot,
          emittedEvents: [],
          result: terminalSnapshot.result,
          reason: null,
        },
      ),
    ).toThrow(/policyId differs/);

    expect(() =>
      parseContract(EngineStepResultSchema, {
        schemaVersion: 1,
        status: "progress",
        snapshot: sampleSnapshot,
        emittedEvents: [
          {
            schemaVersion: 1,
            eventId: "effect-before-cause",
            timeMs: 0,
            sequence: 1,
            phase: "input",
            kind: "action",
            actorEntityId: "actor",
            targetEntityIds: [],
            causeEventIds: ["event-002"],
            payload: {},
          },
        ],
        result: null,
        reason: sampleSnapshot.interruption.reason,
      }),
    ).toThrow(/already executed event/);

    const sameTimeBehind = clone(sampleSnapshot);
    sameTimeBehind.trace.events = [sameTimeBehind.trace.events[1]!];
    sameTimeBehind.trace.truncated = true;
    sameTimeBehind.trace.truncationReason = "older trace prefix omitted";
    sameTimeBehind.queue.entries[0]!.timeMs = sameTimeBehind.currentTimeMs;
    sameTimeBehind.queue.entries[0]!.sequence = 1;
    expect(() => parseContract(EngineSnapshotSchema, sameTimeBehind)).toThrow(
      /processed time and sequence frontier/,
    );

    const deadTransform = clone(transformedCopiedAbility);
    deadTransform.alive = false;
    deadTransform.health.current = 0;
    expect(() =>
      assertLifecycleResolution(
        { entityId: "actor", transition: "transform", replacement: deadTransform },
        sampleSnapshot.entities,
        {
          accepted: true,
          entityId: "actor",
          transition: "transform",
          state: deadTransform,
          reason: null,
        },
      ),
    ).toThrow(/preserve entity liveness/);

    const enemyPendingAction = clone(sampleSnapshot);
    enemyPendingAction.pendingActions[0]!.command.actorId = "enemy";
    expect(() =>
      assertResumeCompatible(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
        enemyPendingAction,
      ),
    ).toThrow(/differs from scenario actor/);

    const unavailableItem = clone(sampleScenario);
    unavailableItem.entities[0]!.inventory[0]!.state = "owned";
    unavailableItem.policy.steps[0]!.action = {
      kind: "item-active",
      actorId: "actor",
      itemInstanceId: "item-instance-001",
      target: { kind: "entity", entityId: "enemy" },
    };
    expect(() => parseContract(ScenarioSpecSchema, unavailableItem)).toThrow(
      /unavailable item instance/,
    );

    const ports = createMockPorts();
    ports.resources.restore(transformedCopiedAbility, mockPortContext);
    const fullMana = transformedCopiedAbility.resources[0]!;
    const clamped = ports.resources.apply(
      {
        entityId: "actor",
        resourceId: fullMana.resourceId,
        delta: fullMana.maximum,
        reason: "restore",
      },
      mockPortContext,
    );
    expect(clamped.current).toBe(fullMana.maximum);

    const truncatedTrace = clone(sampleTrace);
    truncatedTrace.traceId = "retained-trace";
    truncatedTrace.truncated = true;
    truncatedTrace.truncationReason = "budget";
    ports.trace.restore(truncatedTrace, mockPortContext);
    expect(ports.trace.snapshot(mockPortContext.runId)).toEqual(truncatedTrace);

    const noEnemyVisible = visiblePolicyStateFixture();
    const visibleEnemy = noEnemyVisible.entities.find((entity) => entity.team === "enemy")!;
    visibleEnemy.alive = false;
    visibleEnemy.health.current = 0;
    const noTarget = ports.targeting.select(
      {
        actor: transformedCopiedAbility,
        selector: { kind: "lowest-health-visible-enemy", actorId: "actor" },
        visibleState: parseContract(PolicyVisibleStateSchema, noEnemyVisible),
        expectedVisibleEntityIds: noEnemyVisible.visibility.visibleEntityIds,
      },
      mockPortContext,
    );
    expect(noTarget).toMatchObject({ rejected: true, targetEntityIds: [] });

    const visible = parseContract(PolicyVisibleStateSchema, visiblePolicyStateFixture());
    expect(() =>
      assertTargetingResolution(
        {
          actor: transformedCopiedAbility,
          selector: { kind: "self", actorId: "actor" },
          visibleState: visible,
          expectedVisibleEntityIds: visible.visibility.visibleEntityIds,
        },
        { ...mockPortContext, timeMs: visible.atTimeMs },
        { targetEntityIds: [], rejected: true, reason: "" },
      ),
    ).toThrow(/rejection and reason/);
  });

  test("closes latest trigger allocation, coverage, and engine-identity findings", () => {
    const triggerEvent = {
      schemaVersion: 1 as const,
      eventId: "trigger-event",
      timeMs: 0,
      sequence: 1,
      phase: "input" as const,
      kind: "action",
      actorEntityId: "actor",
      targetEntityIds: [] as string[],
      causeEventIds: [] as string[],
      payload: {},
    };
    const traceCommand = {
      schemaVersion: 1 as const,
      kind: "trace" as const,
      commandId: "trace-a",
      issuedAtMs: 0,
      causeEventIds: ["trigger-event"],
      event: {
        ...sampleTrace.events[0]!,
        eventId: "nested-trace",
        sequence: 2,
        causeEventIds: ["trigger-event"],
      },
    };
    expect(() =>
      assertTriggerDispatchResult(
        { triggerId: "trigger", ownerEntityId: "actor", event: triggerEvent },
        mockPortContext,
        {
          accepted: true,
          reason: null,
          emittedCommands: [traceCommand, { ...traceCommand, commandId: "trace-b" }],
        },
      ),
    ).toThrow(/scheduled event IDs and sequences/);
    expect(() =>
      assertTriggerDispatchResult(
        { triggerId: "trigger", ownerEntityId: "actor", event: triggerEvent },
        mockPortContext,
        {
          accepted: true,
          reason: null,
          emittedCommands: [{ ...traceCommand, event: { ...traceCommand.event, sequence: 1 } }],
        },
      ),
    ).toThrow(/dispatch timing and causal identity/);

    const contradictoryCoverage = clone(censoredResult);
    contradictoryCoverage.coverage = {
      killedCount: 1,
      totalCount: 1,
      killedWeight: 1,
      totalWeight: 1,
      fraction: 1,
    };
    expect(() => parseContract(CombatResultSchema, contradictoryCoverage)).toThrow(
      /kill status must match full cohort coverage/,
    );

    const planned = clone(sampleRunningRun);
    planned.status = "planned";
    expect(() =>
      assertEngineInputCompatible(
        { scenario: sampleResolvedScenario, run: planned, ports: createMockPorts() },
        HASH_C,
      ),
    ).toThrow(/executing engine/);
  });

  test("closes latest frontier, provenance, scale, lifecycle, and trace findings", () => {
    const triggerEvent = {
      schemaVersion: 1 as const,
      eventId: "trigger-frontier",
      timeMs: 0,
      sequence: 2,
      phase: "input" as const,
      kind: "action",
      actorEntityId: "actor",
      targetEntityIds: [] as string[],
      causeEventIds: [] as string[],
      payload: {},
    };
    const scheduledCommand = {
      schemaVersion: 1 as const,
      kind: "schedule-event" as const,
      commandId: "frontier-command",
      issuedAtMs: 0,
      causeEventIds: [triggerEvent.eventId],
      event: {
        eventId: "new-event",
        timeMs: 10,
        sequence: 5,
        phase: "impact" as const,
        kind: "damage",
        payload: {},
        causeEventIds: [triggerEvent.eventId],
      },
    };
    const frontierContext = {
      ...mockPortContext,
      sequence: triggerEvent.sequence,
      nextEventSequence: 6,
      allocatedEventIds: ["already-allocated"],
    };
    expect(() =>
      assertTriggerDispatchResult(
        { triggerId: "trigger", ownerEntityId: "actor", event: triggerEvent },
        frontierContext,
        { accepted: true, reason: null, emittedCommands: [scheduledCommand] },
      ),
    ).toThrow(/queue frontier/);
    expect(() =>
      assertTriggerDispatchResult(
        { triggerId: "trigger", ownerEntityId: "actor", event: triggerEvent },
        frontierContext,
        {
          accepted: true,
          reason: null,
          emittedCommands: [
            {
              ...scheduledCommand,
              event: { ...scheduledCommand.event, eventId: "already-allocated", sequence: 6 },
            },
          ],
        },
      ),
    ).toThrow(/without ID reuse/);

    const tinyUniform = clone(sampleScenario);
    tinyUniform.cohort.normalized = false;
    tinyUniform.cohort.weighting = "uniform-member";
    tinyUniform.cohort.members[0]!.weight = 1e-20;
    tinyUniform.cohort.members.push({
      ...clone(tinyUniform.cohort.members[0]!),
      memberId: "member-tiny-uniform",
      weight: 1e-10,
    });
    expect(() => parseContract(ScenarioSpecSchema, tinyUniform)).toThrow(/equal member weights/);

    const tinyBalanced = clone(tinyUniform);
    tinyBalanced.cohort.weighting = "match-balanced";
    tinyBalanced.cohort.members[1]!.matchKey = "match-002";
    expect(() => parseContract(ScenarioSpecSchema, tinyBalanced)).toThrow(
      /equal aggregate weight per match/,
    );

    const tinyScenario = clone(sampleResolvedScenario);
    tinyScenario.effective.cohort.normalized = false;
    tinyScenario.effective.cohort.weighting = "declared-mass";
    tinyScenario.effective.cohort.members[0]!.weight = 1e-13;
    const wrongTinyCoverage = clone(censoredResult);
    wrongTinyCoverage.coverage = {
      killedCount: 0,
      totalCount: 1,
      killedWeight: 0,
      totalWeight: 9e-13,
      fraction: 0,
    };
    expect(() =>
      assertEngineRun(
        { scenario: tinyScenario, run: sampleRunningRun, ports: createMockPorts() },
        { status: "complete", result: wrongTinyCoverage, trace: sampleTrace },
      ),
    ).toThrow(/coverage.*cohort denominator/);
    const tinyTransfer = clone(sampleTransfer);
    tinyTransfer.resolvedScenario.effective.cohort.normalized = false;
    tinyTransfer.resolvedScenario.effective.cohort.weighting = "declared-mass";
    tinyTransfer.resolvedScenario.effective.cohort.members[0]!.weight = 1e-13;
    tinyTransfer.result.coverage = clone(wrongTinyCoverage.coverage);
    expect(() => parseContract(ExactComparisonTransferSchema, tinyTransfer)).toThrow(
      /coverage denominator.*transferred cohort/,
    );

    expect(() =>
      assertResumeCompatible(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
        sampleSnapshot,
        HASH_C,
      ),
    ).toThrow(/executing engine/);

    const foreignPolicyCommand = clone(sampleSnapshot);
    foreignPolicyCommand.pendingActions[0]!.origin = {
      kind: "policy-action",
      stepId: "cast-w",
    };
    foreignPolicyCommand.pendingActions[0]!.command = {
      kind: "ability",
      actorId: "actor",
      abilityId: "copied-ability",
      target: { kind: "entity", entityId: "enemy" },
    };
    expect(() =>
      assertResumeCompatible(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
        foreignPolicyCommand,
      ),
    ).toThrow(/differs from its policy step/);

    const splitFrontier = clone(sampleSnapshot);
    splitFrontier.currentTimeMs = 10;
    splitFrontier.trace.events = [
      {
        ...clone(sampleTrace.events[0]!),
        eventId: "past-high-allocation",
        timeMs: 0,
        sequence: 100,
        causeEventIds: [],
      },
      {
        ...clone(sampleTrace.events[1]!),
        eventId: "current-first",
        timeMs: 10,
        sequence: 1,
        causeEventIds: ["past-high-allocation"],
      },
    ];
    splitFrontier.queue.lastProcessedSequence = 100;
    splitFrontier.queue.currentTimeSequence = 1;
    splitFrontier.queue.nextSequence = 101;
    splitFrontier.queue.entries = [
      {
        ...clone(splitFrontier.queue.entries[0]!),
        eventId: "current-second",
        timeMs: 10,
        sequence: 2,
        causeEventIds: ["current-first"],
      },
    ];
    splitFrontier.allocatedEventIds = ["past-high-allocation", "current-first", "current-second"];
    splitFrontier.pendingActions[0]!.continuationEventId = "current-second";
    splitFrontier.pendingActions[0]!.startedAtMs = 0;
    const splitWait = splitFrontier.pendingActions[0]!.command;
    if (splitWait.kind !== "wait") throw new Error("fixture action should be a wait");
    splitWait.durationMs = 10;
    expect(() => parseContract(EngineSnapshotSchema, splitFrontier)).not.toThrow();

    const missingCopySource = clone(transformedCopiedAbility);
    const copiedAbility = missingCopySource.abilities.find(
      (ability) => ability.origin.kind === "copied",
    )!;
    if (copiedAbility.origin.kind !== "copied") throw new Error("fixture ability should be copied");
    copiedAbility.origin.sourceEntityId = "missing-copy-source";
    expect(() =>
      assertLifecycleResolution(
        { entityId: "actor", transition: "transform", replacement: missingCopySource },
        sampleSnapshot.entities,
        {
          accepted: true,
          entityId: "actor",
          transition: "transform",
          state: missingCopySource,
          reason: null,
        },
      ),
    ).toThrow(/replacement references/);
    const snapshotWithMissingCopySource = clone(sampleSnapshot);
    snapshotWithMissingCopySource.entities[0] = missingCopySource;
    expect(() => parseContract(EngineSnapshotSchema, snapshotWithMissingCopySource)).toThrow(
      /copied abilities.*known source entities/,
    );

    const ports = createMockPorts();
    const restored = clone(sampleTrace);
    ports.trace.restore(restored, mockPortContext);
    restored.events[0]!.eventId = "mutated-ingress";
    expect(ports.trace.snapshot(mockPortContext.runId).events[0]!.eventId).toBe("event-001");
    const detached = ports.trace.snapshot(mockPortContext.runId);
    detached.events[0]!.eventId = "mutated-egress";
    expect(ports.trace.snapshot(mockPortContext.runId).events[0]!.eventId).toBe("event-001");
    const recorded = clone(sampleTrace.events[0]!);
    recorded.eventId = "recorded-original";
    ports.trace.record(recorded, { ...mockPortContext, runId: "record-run" });
    recorded.eventId = "mutated-record";
    expect(ports.trace.snapshot("record-run").events[0]!.eventId).toBe("recorded-original");
  });

  test("closes latest wait, arithmetic, timer, interruption, and cause findings", async () => {
    const mismatchedWait = clone(sampleSnapshot);
    const pendingWait = mismatchedWait.pendingActions[0]!;
    if (pendingWait.command.kind !== "wait") throw new Error("fixture action should be a wait");
    pendingWait.command.durationMs = 1;
    expect(() => parseContract(EngineSnapshotSchema, mismatchedWait)).toThrow(
      /wait continuation must match its declared duration/,
    );

    const tinyDamage = {
      attempted: 1e-20,
      absorbed: 0,
      prevented: 0,
      applied: 9e-10,
      overkill: 0,
      discarded: 0,
      targetHealthAfter: 0,
      killed: true,
    };
    expect(() => parseContract(DamageResolutionSchema, tinyDamage)).toThrow(
      /totals must reconcile/,
    );
    const tinyTarget = clone(observedTarget);
    tinyTarget.health.current = 1e-20;
    tinyTarget.health.maximum = 1e-20;
    expect(() =>
      assertDamageResolution(
        {
          packet: {
            sourceEntityId: "actor",
            targetEntityId: "enemy",
            damageType: "true",
            rawAmount: 1e-20,
            tags: [],
            canOverkill: false,
          },
          attacker: transformedCopiedAbility,
          target: tinyTarget,
          attackerStats: {
            entityId: "actor",
            revision: 1,
            values: clone(transformedCopiedAbility.stats),
          },
          targetStats: { entityId: "enemy", revision: 1, values: clone(tinyTarget.stats) },
          attackerRead: {
            kind: "impact",
            entityId: "actor",
            atTimeMs: 0,
            stateRevision: 1,
          },
          read: { kind: "impact", entityId: "enemy", atTimeMs: 0, stateRevision: 1 },
        },
        mockPortContext,
        tinyDamage,
      ),
    ).toThrow(/totals must reconcile|requested packet/);

    const tinyResourceEntity = clone(transformedCopiedAbility);
    tinyResourceEntity.resources[0]!.current = 1e-20;
    tinyResourceEntity.resources[0]!.maximum = 1e-20;
    expect(() =>
      assertResourceResolution(
        { entityId: "actor", resourceId: "mana", delta: 0, reason: "no-op" },
        tinyResourceEntity,
        {
          accepted: true,
          entityId: "actor",
          resourceId: "mana",
          previous: 9e-10,
          current: 9e-10,
          reason: null,
        },
      ),
    ).toThrow(/match the requested mutation/);

    const ports = createMockPorts();
    const scheduled = clone(sampleSnapshot.queue.entries[0]!);
    const originalTime = scheduled.timeMs;
    ports.timers.schedule({ event: scheduled, replacesEventId: null }, mockPortContext);
    scheduled.timeMs += 1000;
    expect(ports.timers.peek(mockPortContext)?.timeMs).toBe(originalTime);
    const detachedTimer = ports.timers.peek(mockPortContext)!;
    detachedTimer.timeMs += 2000;
    expect(ports.timers.peek(mockPortContext)?.timeMs).toBe(originalTime);

    const sampledScenarioDraft = clone(sampleResolvedScenario);
    sampledScenarioDraft.effective.evaluationMode = {
      kind: "sampled-estimate",
      random: { kind: "seeded", algorithm: "xorshift32", seed: "seed", trialCount: 10 },
      approximation: null,
      confidenceLevel: 0.95,
    };
    const sampledScenario = await verifyScenarioForEngine(sampledScenarioDraft);
    const sampledRun = clone(sampleRunningRun);
    sampledRun.evaluationMode = clone(sampledScenario.effective.evaluationMode);
    sampledRun.random = clone(sampledRun.evaluationMode.random);
    bindRunToScenario(sampledRun, sampledScenario);
    const interrupted = clone(censoredResult);
    interrupted.status = "cancelled";
    interrupted.censoring = "invalid";
    interrupted.metrics.ttk = { status: "undefined", reason: "cancelled before sampling" };
    interrupted.uncertainty = null;
    interrupted.resolvedScenarioHash = sampledRun.resolvedScenarioHash;
    interrupted.candidateInputHash = sampledRun.candidateInputHash;
    const sampledInput = { scenario: sampledScenario, run: sampledRun, ports: createMockPorts() };
    expect(() =>
      assertEngineRun(sampledInput, {
        status: "cancelled",
        result: interrupted,
        trace: sampleTrace,
      }),
    ).not.toThrow();
    const oneSample = clone(interrupted);
    oneSample.uncertainty = {
      effectiveSampleCount: 1,
      confidenceLevel: 0.95,
      standardErrors: {},
    };
    expect(() =>
      assertEngineRun(sampledInput, { status: "cancelled", result: oneSample, trace: sampleTrace }),
    ).not.toThrow();

    const interruptedSnapshot = clone(sampleSnapshot);
    interruptedSnapshot.status = "cancelled";
    interruptedSnapshot.resumability = "non-resumable";
    interruptedSnapshot.interruption = { state: "cancelled", reason: "cancelled early" };
    interruptedSnapshot.queue.entries = [];
    interruptedSnapshot.pendingActions = [];
    interruptedSnapshot.result = interrupted;
    interruptedSnapshot.numericalBranches[0]!.mode = "sampled-estimate";
    interruptedSnapshot.rngStreams[0] = {
      streamId: "combat",
      algorithm: "xorshift32",
      seed: "seed",
      drawCount: 1,
      state: [1],
    };
    bindSnapshotToRun(interruptedSnapshot, sampledRun);
    expect(() =>
      assertEngineStepResult(sampledInput, {
        schemaVersion: 1,
        status: "cancelled",
        snapshot: interruptedSnapshot,
        emittedEvents: [],
        result: interrupted,
        reason: "cancelled early",
      }),
    ).not.toThrow();

    const triggerEvent = {
      schemaVersion: 1 as const,
      eventId: "trigger-cause",
      timeMs: 0,
      sequence: 1,
      phase: "input" as const,
      kind: "action",
      actorEntityId: "actor",
      targetEntityIds: [] as string[],
      causeEventIds: [] as string[],
      payload: {},
    };
    expect(() =>
      assertTriggerDispatchResult(
        { triggerId: "trigger", ownerEntityId: "actor", event: triggerEvent },
        mockPortContext,
        {
          accepted: true,
          reason: null,
          emittedCommands: [
            {
              schemaVersion: 1,
              kind: "schedule-event",
              commandId: "unknown-cause-command",
              issuedAtMs: 0,
              causeEventIds: ["trigger-cause", "missing-cause"],
              event: {
                eventId: "scheduled-cause",
                timeMs: 1,
                sequence: 2,
                phase: "impact",
                kind: "damage",
                payload: {},
                causeEventIds: ["trigger-cause", "missing-cause"],
              },
            },
          ],
        },
      ),
    ).toThrow(/causal identity/);
  });

  test("closes latest wait-basis, fraction, verification, and emitted-identity findings", () => {
    const alteredWait = clone(sampleSnapshot);
    const alteredWaitCommand = alteredWait.pendingActions[0]!.command;
    if (alteredWaitCommand.kind !== "wait") throw new Error("fixture action should be a wait");
    alteredWaitCommand.durationMs = 1000;
    alteredWait.queue.entries[0]!.timeMs = alteredWait.pendingActions[0]!.startedAtMs + 1000;
    expect(() => parseContract(EngineSnapshotSchema, alteredWait)).not.toThrow();
    expect(() =>
      assertResumeCompatible(
        { scenario: sampleResolvedScenario, run: sampleRunningRun, ports: createMockPorts() },
        alteredWait,
      ),
    ).toThrow(/policy wait provenance/);

    const wrongTinyFraction = clone(censoredResult);
    wrongTinyFraction.coverage = {
      killedCount: 1,
      totalCount: 2,
      killedWeight: 1e-20,
      totalWeight: 1,
      fraction: 1e-13,
    };
    expect(() => parseContract(CombatResultSchema, wrongTinyFraction)).toThrow(
      /fraction must match its weights/,
    );

    const clonedScenario = clone(sampleResolvedScenario);
    clonedScenario.effective.entities[1]!.health.current -= 1;
    const planned = clone(sampleRunningRun);
    planned.status = "planned";
    expect(() =>
      assertEngineInputCompatible(
        { scenario: clonedScenario, run: planned, ports: createMockPorts() },
        planned.engineHash,
      ),
    ).toThrow(/runtime-verified canonical hash identity/);
    expect(() =>
      assertResumeCompatible(
        { scenario: clonedScenario, run: sampleRunningRun, ports: createMockPorts() },
        sampleSnapshot,
      ),
    ).toThrow(/runtime-verified canonical hash identity/);

    expect(() =>
      parseContract(EngineStepResultSchema, {
        schemaVersion: 1,
        status: "progress",
        snapshot: sampleSnapshot,
        emittedEvents: [
          {
            schemaVersion: 1,
            eventId: "different-event-at-sequence-2",
            timeMs: 100,
            sequence: 2,
            phase: "impact",
            kind: "damage",
            actorEntityId: "actor",
            targetEntityIds: ["enemy"],
            causeEventIds: ["event-001"],
            payload: {},
          },
        ],
        result: null,
        reason: sampleSnapshot.interruption.reason,
      }),
    ).toThrow(/identities must exactly match retained trace identities/);
  });

  test("closes latest fresh-step, allocation-ledger, champion, and overflow findings", () => {
    const plannedRun = clone(sampleRunningRun);
    plannedRun.status = "planned";
    const freshInput = assertEngineInputCompatible(
      { scenario: sampleResolvedScenario, run: plannedRun, ports: createMockPorts() },
      plannedRun.engineHash,
    );
    expect(() =>
      assertEngineStepResult(freshInput, {
        schemaVersion: 1,
        status: "progress",
        snapshot: sampleSnapshot,
        emittedEvents: [],
        result: null,
        reason: sampleSnapshot.interruption.reason,
      }),
    ).not.toThrow();

    const truncated = clone(sampleSnapshot);
    truncated.trace.truncated = true;
    truncated.trace.truncationReason = "retention limit";
    truncated.trace.events = truncated.trace.events.slice(1);
    expect(() => parseContract(EngineSnapshotSchema, truncated)).not.toThrow();
    truncated.allocatedEventIds = truncated.allocatedEventIds.filter(
      (eventId) => eventId !== "event-001",
    );
    expect(() => parseContract(EngineSnapshotSchema, truncated)).toThrow(
      /allocated event IDs must retain represented identity event-001/,
    );

    const omittedEmissionSnapshot = clone(sampleSnapshot);
    omittedEmissionSnapshot.trace.truncated = true;
    omittedEmissionSnapshot.trace.truncationReason = "retention limit";
    omittedEmissionSnapshot.trace.events = [];
    const omittedTraceEvent = sampleTrace.events[0]!;
    const omittedEmission = {
      schemaVersion: 1 as const,
      eventId: omittedTraceEvent.eventId,
      timeMs: omittedTraceEvent.timeMs,
      sequence: omittedTraceEvent.sequence,
      phase: omittedTraceEvent.phase,
      kind: omittedTraceEvent.kind,
      actorEntityId: omittedTraceEvent.actorEntityId,
      targetEntityIds: clone(omittedTraceEvent.targetEntityIds),
      causeEventIds: clone(omittedTraceEvent.causeEventIds),
      payload: {},
    };
    const omittedEmissionStep = {
      schemaVersion: 1 as const,
      status: "progress" as const,
      snapshot: omittedEmissionSnapshot,
      emittedEvents: [omittedEmission],
      result: null,
      reason: omittedEmissionSnapshot.interruption.reason,
    };
    expect(() => parseContract(EngineStepResultSchema, omittedEmissionStep)).not.toThrow();
    omittedEmissionSnapshot.allocatedEventIds = omittedEmissionSnapshot.allocatedEventIds.filter(
      (eventId) => eventId !== omittedEmission.eventId,
    );
    expect(() => parseContract(EngineStepResultSchema, omittedEmissionStep)).toThrow(
      /snapshot allocation ledger/,
    );

    const missingChampion = clone(transformedCopiedAbility);
    missingChampion.championId = null;
    expect(() => parseContract(EntityStateSchema, missingChampion)).toThrow(
      /champion entities require a champion ID/,
    );
    const falseChampion = clone(transformedCopiedAbility);
    falseChampion.kind = "summon";
    expect(() => parseContract(EntityStateSchema, falseChampion)).toThrow(
      /other entity kinds require null/,
    );

    expect(() =>
      parseContract(DamageResolutionSchema, {
        attempted: 1,
        absorbed: 1e308,
        prevented: 1e308,
        applied: 1e308,
        overkill: 1e308,
        discarded: 1e308,
        targetHealthAfter: 1,
        killed: false,
      }),
    ).toThrow(/damage resolution totals must reconcile/);
  });
});
