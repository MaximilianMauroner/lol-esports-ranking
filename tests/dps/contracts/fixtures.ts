import {
  ActionPolicySchema,
  CombatResultSchema,
  EngineSnapshotSchema,
  EntityStateSchema,
  EvaluationModeSchema,
  ExactComparisonTransferSchema,
  ItemInstanceSchema,
  ObjectiveSpecSchema,
  ResolvedScenarioSchema,
  RulesetManifestSchema,
  RunManifestSchema,
  ScenarioSpecSchema,
  SearchConstraintsSchema,
  TraceSchema,
  assertResolvedScenarioPolicyHash,
  hashCanonical,
  parseContract,
  type Provenance,
} from "../../../src/domains/dps/contracts/index.ts";

export const HASH_A = `sha256:${"a".repeat(64)}`;
export const HASH_B = `sha256:${"b".repeat(64)}`;
export const HASH_C = `sha256:${"c".repeat(64)}`;

export function provenance(
  kind: Provenance["kind"],
  sourceId: string,
  sourceHash: string | null = HASH_A,
): Provenance {
  return {
    kind,
    sourceId,
    sourceHash,
    locator: `${sourceId}:fixture`,
    capturedAt: "2026-09-19T00:00:00Z",
    note: `${kind} fixture evidence`,
  };
}

const fixtureProvenance = provenance("fixture", "p01-contract-fixtures");
const observedProvenance = provenance("observed", "p01-observed-target", HASH_B);

export const transformedCopiedAbility = parseContract(EntityStateSchema, {
  entityId: "actor",
  ownerEntityId: null,
  team: "actor",
  kind: "champion",
  championId: "804",
  alive: true,
  health: { current: 1200, maximum: 1200, shield: 0 },
  resources: [{ resourceId: "mana", current: 500, maximum: 500, regenerationPerSecond: 8 }],
  stats: { attackDamage: 150, health: 1200 },
  statProvenance: {
    attackDamage: fixtureProvenance,
    health: fixtureProvenance,
  },
  abilities: [
    {
      abilityId: "arc-of-judgment",
      ownerEntityId: "actor",
      rank: 5,
      formId: "transformed",
      origin: {
        kind: "transformed",
        sourceAbilityId: "arc-of-judgment",
        transformationId: "transcendence",
      },
    },
    {
      abilityId: "copied-ability",
      ownerEntityId: "actor",
      rank: 1,
      formId: null,
      origin: {
        kind: "copied",
        sourceAbilityId: "source-ability",
        sourceEntityId: "enemy",
        copyId: "copy-001",
      },
    },
  ],
  buffs: [
    {
      buffId: "test-buff",
      ownerEntityId: "actor",
      sourceEntityId: "actor",
      stacks: 2,
      expiresAtMs: 3000,
      tags: ["fixture"],
    },
  ],
  inventory: [
    {
      instanceId: "item-instance-001",
      baseItemId: 1001,
      effectiveItemId: 2001,
      slot: 0,
      state: "equipped",
      upgrade: { upgradeId: "upgrade-001", fromItemId: 1001, toItemId: 2001 },
      stacks: 3,
      charges: 1,
      provenance: fixtureProvenance,
    },
  ],
  inventoryOrigin: "modeled-loadout",
  position: { x: 0, y: 0, z: 0 },
  provenance: fixtureProvenance,
});

export const observedTarget = parseContract(EntityStateSchema, {
  entityId: "enemy",
  ownerEntityId: null,
  team: "enemy",
  kind: "champion",
  championId: "synthetic-target",
  alive: true,
  health: { current: 2500, maximum: 2500, shield: 0 },
  resources: [],
  stats: { health: 2500, armor: 120, magicResist: 80 },
  statProvenance: {
    health: observedProvenance,
    armor: observedProvenance,
    magicResist: observedProvenance,
  },
  abilities: [],
  buffs: [],
  inventory: [],
  inventoryOrigin: "observed-effective",
  position: { x: 500, y: 0, z: 0 },
  provenance: observedProvenance,
});

export const samplePolicy = parseContract(ActionPolicySchema, {
  schemaVersion: 1,
  policyId: "p01-policy",
  revision: 1,
  mode: "conditional-priority",
  steps: [
    {
      stepId: "cast-w",
      priority: 1,
      action: {
        kind: "ability",
        actorId: "actor",
        abilityId: "arc-of-judgment",
        target: { kind: "entity", entityId: "enemy" },
      },
      condition: { kind: "always" },
      onUnavailable: "wait",
      unavailableWaitMs: 900,
      repeat: false,
      maxRepeats: null,
    },
    {
      stepId: "basic-attack",
      priority: 2,
      action: {
        kind: "basic-attack",
        actorId: "actor",
        target: { kind: "entity", entityId: "enemy" },
      },
      condition: { kind: "target-alive", entityId: "enemy" },
      onUnavailable: "skip",
      unavailableWaitMs: null,
      repeat: true,
      maxRepeats: 10,
    },
  ],
  visibility: {
    allowFutureEvents: false,
    allowHiddenOpponentState: false,
    visibleEntityIds: ["actor", "enemy"],
  },
});

export const sampleObjective = parseContract(ObjectiveSpecSchema, {
  schemaVersion: 1,
  objectiveId: "fixed-window",
  kind: "fixed-window-damage",
  primaryMetric: "damage",
  horizonMs: 5000,
  warmupMs: 0,
  censoring: "right-censored",
  aggregation: "weighted-mean",
  tiePolicy: "within-tolerance",
  tieTolerance: 1e-9,
});

export const sampleEvaluationMode = parseContract(EvaluationModeSchema, {
  kind: "analytical-expectation",
  random: { kind: "deterministic", algorithm: "none", seed: null, trialCount: 1 },
  approximation: null,
});

export const sampleSearchConstraints = parseContract(SearchConstraintsSchema, {
  schemaVersion: 1,
  slotCount: 3,
  bootRule: "required",
  budget: { kind: "incremental-gold", amount: 7600 },
  requiredItemIds: [1001],
  excludedItemIds: [3000],
  candidateLimit: 1000,
  pruning: "legality-proven",
});

export const sampleRuleset = parseContract(RulesetManifestSchema, {
  schemaVersion: 1,
  manifestId: "ruleset-26-18",
  patch: "26.18",
  dataDragonVersion: "16.18.1",
  sourceArtifacts: [
    {
      artifactId: "fixture-rules",
      kind: "fixture",
      uri: "https://example.invalid/rules.json",
      version: "fixture-1",
      contentHash: HASH_A,
      retrievedAt: "2026-09-19T00:00:00Z",
    },
  ],
  modes: [
    {
      modeId: "summoners-rift",
      mapId: "11",
      queueId: "solo-ranked",
      enabled: true,
      tags: ["standard", "fixture"],
    },
  ],
  manifestHash: HASH_A,
  generatedAt: "2026-09-19T00:00:00Z",
  compatibilityRevision: "combat-contracts-v1",
});

export const sampleScenario = parseContract(ScenarioSpecSchema, {
  schemaVersion: 1,
  scenarioId: "scenario-001",
  rulesetManifestHash: HASH_A,
  modeId: "summoners-rift",
  actorEntityId: "actor",
  entities: [transformedCopiedAbility, observedTarget],
  cohort: {
    cohortId: "cohort-001",
    contentHash: HASH_B,
    members: [
      {
        memberId: "member-001",
        entityId: "enemy",
        matchKey: "match-001",
        weight: 1,
        provenance: observedProvenance,
      },
    ],
    weighting: "match-balanced",
    normalized: true,
  },
  policy: samplePolicy,
  objective: sampleObjective,
  evaluationMode: sampleEvaluationMode,
  searchConstraints: sampleSearchConstraints,
  inputProvenance: {
    rulesetManifestHash: fixtureProvenance,
    modeId: fixtureProvenance,
    actorEntityId: fixtureProvenance,
    entities: fixtureProvenance,
    cohort: observedProvenance,
    policy: fixtureProvenance,
    objective: fixtureProvenance,
    evaluationMode: fixtureProvenance,
    searchConstraints: fixtureProvenance,
  },
});

const sampleResolvedScenarioDraft = parseContract(ResolvedScenarioSchema, {
  schemaVersion: 1,
  scenarioId: sampleScenario.scenarioId,
  resolvedScenarioHash: HASH_B,
  policyHash: HASH_A,
  candidateInput: { candidateId: "fixture-candidate", itemIds: ["3031"] },
  candidateInputHash: HASH_C,
  effective: {
    rulesetManifestHash: sampleScenario.rulesetManifestHash,
    modeId: sampleScenario.modeId,
    actorEntityId: sampleScenario.actorEntityId,
    entities: sampleScenario.entities,
    cohort: sampleScenario.cohort,
    policy: sampleScenario.policy,
    objective: sampleScenario.objective,
    evaluationMode: sampleScenario.evaluationMode,
    searchConstraints: sampleScenario.searchConstraints,
  },
  provenance: {
    ...sampleScenario.inputProvenance,
    policyHash: fixtureProvenance,
    candidateInput: fixtureProvenance,
    candidateInputHash: fixtureProvenance,
  },
});
const sampleCohortBytes = Object.fromEntries(
  Object.entries(sampleResolvedScenarioDraft.effective.cohort).filter(
    ([key]) => key !== "contentHash",
  ),
);
sampleResolvedScenarioDraft.effective.cohort.contentHash = await hashCanonical(sampleCohortBytes);
sampleResolvedScenarioDraft.policyHash = await hashCanonical(
  sampleResolvedScenarioDraft.effective.policy,
);
sampleResolvedScenarioDraft.candidateInputHash = await hashCanonical(
  sampleResolvedScenarioDraft.candidateInput,
);
sampleResolvedScenarioDraft.resolvedScenarioHash = await hashCanonical(
  sampleResolvedScenarioDraft.effective,
);
export const sampleResolvedScenario = await assertResolvedScenarioPolicyHash(
  sampleResolvedScenarioDraft,
);

export const sampleRun = parseContract(RunManifestSchema, {
  schemaVersion: 1,
  runId: "run-001",
  engineHash: HASH_A,
  rulesetHash: HASH_A,
  resolvedScenarioHash: sampleResolvedScenario.resolvedScenarioHash,
  cohortHash: sampleResolvedScenario.effective.cohort.contentHash,
  policyHash: sampleResolvedScenario.policyHash,
  searchContextHash: HASH_A,
  candidateInputHash: sampleResolvedScenario.candidateInputHash,
  objective: sampleObjective,
  evaluationMode: sampleEvaluationMode,
  random: { kind: "deterministic", algorithm: "none", seed: null, trialCount: 1 },
  status: "complete",
  createdAt: "2026-09-19T00:00:00Z",
  completedAt: "2026-09-19T00:00:01Z",
});

export const sampleRunningRun = parseContract(RunManifestSchema, {
  ...sampleRun,
  status: "running",
  completedAt: null,
});

export const censoredResult = parseContract(CombatResultSchema, {
  schemaVersion: 1,
  resultId: "result-censored",
  runId: sampleRun.runId,
  status: "complete",
  objective: "fixed-window-damage",
  resolvedScenarioHash: sampleResolvedScenario.resolvedScenarioHash,
  candidateInputHash: sampleRun.candidateInputHash,
  metrics: {
    damage: { status: "value", value: 1234.5 },
    dps: { status: "value", value: 246.9 },
    ttk: { status: "censored", horizonMs: 5000 },
    timeToFirstDeath: { status: "not-applicable", reason: "not the selected objective" },
    timeToElimination: { status: "not-applicable", reason: "not the selected objective" },
  },
  coverage: null,
  uncertainty: null,
  killed: false,
  censoring: "right-censored",
  warnings: ["target survived the configured horizon"],
  traceId: null,
});

export const sampleTransfer = parseContract(ExactComparisonTransferSchema, {
  schemaVersion: 1,
  result: censoredResult,
  resolvedScenario: sampleResolvedScenario,
  run: sampleRun,
  candidateInputHash: sampleRun.candidateInputHash,
});

export const sampleTrace = parseContract(TraceSchema, {
  schemaVersion: 1,
  traceId: "trace-001",
  runId: sampleRun.runId,
  events: [
    {
      eventId: "event-001",
      sequence: 1,
      timeMs: 0,
      phase: "input",
      kind: "action",
      actorEntityId: "actor",
      targetEntityIds: ["enemy"],
      causeEventIds: [],
      effects: [],
      stateDigest: null,
    },
    {
      eventId: "event-002",
      sequence: 2,
      timeMs: 100,
      phase: "impact",
      kind: "damage",
      actorEntityId: "actor",
      targetEntityIds: ["enemy"],
      causeEventIds: ["event-001"],
      effects: [
        {
          kind: "damage",
          sourceEntityId: "actor",
          targetEntityId: "enemy",
          damageType: "physical",
          amount: 100,
          overkill: 0,
        },
      ],
      stateDigest: null,
    },
  ],
  truncated: false,
  truncationReason: null,
});

export const sampleSnapshot = parseContract(EngineSnapshotSchema, {
  schemaVersion: 1,
  runId: sampleRun.runId,
  engineHash: sampleRun.engineHash,
  rulesetHash: sampleRun.rulesetHash,
  cohortHash: sampleRun.cohortHash,
  policyHash: sampleRun.policyHash,
  resolvedScenarioHash: sampleRun.resolvedScenarioHash,
  candidateInputHash: sampleRun.candidateInputHash,
  stateRevisions: { actor: 1, enemy: 1 },
  trace: sampleTrace,
  allocatedEventIds: ["event-001", "event-002", "event-003"],
  currentTimeMs: 100,
  queue: {
    lastProcessedSequence: 2,
    currentTimeSequence: 2,
    nextSequence: 4,
    entries: [
      {
        eventId: "event-003",
        timeMs: 1000,
        sequence: 3,
        phase: "periodic",
        kind: "future-tick",
        payload: { source: "fixture", stacks: 1 },
        causeEventIds: ["event-002"],
      },
    ],
  },
  entities: [transformedCopiedAbility, observedTarget],
  retiredEntityIds: [],
  buffs: transformedCopiedAbility.buffs,
  pendingActions: [
    {
      actionId: "action-001",
      continuationEventId: "event-003",
      origin: { kind: "policy-wait", stepId: "cast-w" },
      command: {
        kind: "wait",
        actorId: "actor",
        durationMs: 900,
      },
      state: "scheduled",
      startedAtMs: 100,
    },
  ],
  policyProgress: {
    policyId: samplePolicy.policyId,
    revision: samplePolicy.revision,
    nextStepId: "basic-attack",
    steps: [
      { stepId: "cast-w", consumedRepeats: 1, state: "completed" },
      { stepId: "basic-attack", consumedRepeats: 2, state: "active" },
    ],
  },
  triggerState: [
    {
      triggerId: "trigger-001",
      ownerEntityId: "actor",
      armed: true,
      stacks: 1,
      internalCooldownUntilMs: null,
    },
  ],
  rngStreams: [
    {
      streamId: "combat",
      algorithm: "none",
      seed: "fixed",
      drawCount: 0,
      state: [],
    },
  ],
  numericalBranches: [
    {
      branchId: "branch-001",
      mode: "analytical-expectation",
      accumulators: { damage: 100 },
      labels: ["fixture"],
    },
  ],
  status: "running",
  resumability: "resumable",
  interruption: { state: "budget-exhausted", reason: "step event budget exhausted" },
  result: null,
});

export const parsedItemInstance = parseContract(
  ItemInstanceSchema,
  transformedCopiedAbility.inventory[0],
);
