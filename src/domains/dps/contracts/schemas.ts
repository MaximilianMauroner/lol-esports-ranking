import { z } from "zod";

/**
 * P01 freezes the wire shape, not the complete combat implementation. Later
 * slices may add fields through a new schema version or an additive revision.
 */
export const CONTRACT_SCHEMA_VERSION = 1 as const;

const finiteNumber = z.number().finite();
const nonNegativeNumber = finiteNumber.nonnegative();
const nonNegativeInteger = z.number().int().safe().nonnegative();
const positiveInteger = z.number().int().safe().positive();
const SCALE_RELATIVE_TOLERANCE = 1e-12;

function scaleAwareEqual(left: number, right: number): boolean {
  if (left === right) return true;
  return (
    Math.abs(left - right) <= SCALE_RELATIVE_TOLERANCE * Math.max(Math.abs(left), Math.abs(right))
  );
}
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must be a stable ASCII identifier");
const itemId = z.number().int().positive();
const timestamp = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/,
    "must be an ISO-8601 timestamp with an explicit timezone",
  )
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: "must be an ISO-compatible timestamp",
  })
  .refine(
    (value) => {
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
      if (!match) return false;
      const [, year, month, day, hour, minute, second] = match.map(Number);
      const candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
      return (
        candidate.getUTCFullYear() === year &&
        candidate.getUTCMonth() === month - 1 &&
        candidate.getUTCDate() === day &&
        candidate.getUTCHours() === hour &&
        candidate.getUTCMinutes() === minute &&
        candidate.getUTCSeconds() === second
      );
    },
    {
      message: "must contain a real calendar date and time",
    },
  );

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    finiteNumber,
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const ContentHashSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "must be a lowercase sha256:<64 hex characters> hash");
export type ContentHash = z.infer<typeof ContentHashSchema>;

export const ProvenanceKindSchema = z.enum([
  "observed",
  "inferred",
  "manual",
  "fixture",
  "derived",
  "unknown",
]);

/** Every source-affecting field carries an explicit provenance record. */
export const ProvenanceSchema = z
  .object({
    kind: ProvenanceKindSchema,
    sourceId: identifier,
    sourceHash: ContentHashSchema.nullable(),
    locator: z.string().min(1),
    capturedAt: timestamp.nullable(),
    note: z.string().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "observed" && value.sourceHash === null) {
      context.addIssue({
        code: "custom",
        path: ["sourceHash"],
        message: "observed values require a retained source hash",
      });
    }
  });
export type Provenance = z.infer<typeof ProvenanceSchema>;

const uniqueIdentifiers = z
  .array(identifier)
  .refine((values) => new Set(values).size === values.length, "values must be unique");
const uniqueItemIds = z
  .array(itemId)
  .refine((values) => new Set(values).size === values.length, "item IDs must be unique");
const finiteNumberMap = z.record(z.string().min(1), finiteNumber);
const provenanceMap = z.record(z.string().min(1), ProvenanceSchema);

function addDuplicateIdIssues(
  ids: readonly string[],
  path: string,
  label: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, id] of ids.entries()) {
    if (seen.has(id)) {
      context.addIssue({
        code: "custom",
        path: [path, index],
        message: `${label} IDs must be unique`,
      });
    }
    seen.add(id);
  }
}

export const SourceArtifactSchema = z
  .object({
    artifactId: identifier,
    kind: z.enum(["data-dragon", "community-dragon", "riot-api", "fixture", "manual"]),
    uri: z.string().url(),
    version: z.string().min(1),
    contentHash: ContentHashSchema,
    retrievedAt: timestamp,
  })
  .strict();
export type SourceArtifact = z.infer<typeof SourceArtifactSchema>;

export const RulesetModeSchema = z
  .object({
    modeId: identifier,
    mapId: identifier,
    queueId: identifier,
    enabled: z.boolean(),
    tags: uniqueIdentifiers,
  })
  .strict();

export const RulesetManifestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    manifestId: identifier,
    patch: z.string().min(1),
    dataDragonVersion: z.string().min(1),
    sourceArtifacts: z.array(SourceArtifactSchema).min(1),
    modes: z.array(RulesetModeSchema).min(1),
    manifestHash: ContentHashSchema,
    generatedAt: timestamp,
    compatibilityRevision: identifier,
  })
  .strict()
  .superRefine((value, context) => {
    const artifactIds = value.sourceArtifacts.map((artifact) => artifact.artifactId);
    for (const [index, artifact] of value.sourceArtifacts.entries()) {
      if (Date.parse(artifact.retrievedAt) > Date.parse(value.generatedAt)) {
        context.addIssue({
          code: "custom",
          path: ["sourceArtifacts", index, "retrievedAt"],
          message: "artifact retrieval cannot follow manifest generation",
        });
      }
    }
    if (new Set(artifactIds).size !== artifactIds.length) {
      context.addIssue({
        code: "custom",
        path: ["sourceArtifacts"],
        message: "artifact IDs must be unique",
      });
    }
    const modeIds = value.modes.map((mode) => mode.modeId);
    if (new Set(modeIds).size !== modeIds.length) {
      context.addIssue({
        code: "custom",
        path: ["modes"],
        message: "mode IDs must be unique",
      });
    }
  });
export type RulesetManifest = z.infer<typeof RulesetManifestSchema>;
declare const verifiedRulesetHash: unique symbol;
export type HashVerifiedRulesetManifest = RulesetManifest & {
  readonly [verifiedRulesetHash]: true;
};

export const PositionSchema = z
  .object({ x: finiteNumber, y: finiteNumber, z: finiteNumber })
  .strict();
export type Position = z.infer<typeof PositionSchema>;

export const HealthStateSchema = z
  .object({
    current: nonNegativeNumber,
    maximum: finiteNumber.positive(),
    shield: nonNegativeNumber,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.current > value.maximum) {
      context.addIssue({
        code: "custom",
        path: ["current"],
        message: "current health cannot exceed maximum health",
      });
    }
  });

export const ResourceStateSchema = z
  .object({
    resourceId: identifier,
    current: nonNegativeNumber,
    maximum: finiteNumber.positive(),
    regenerationPerSecond: nonNegativeNumber,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.current > value.maximum) {
      context.addIssue({
        code: "custom",
        path: ["current"],
        message: "current resource cannot exceed maximum resource",
      });
    }
  });
export type ResourceState = z.infer<typeof ResourceStateSchema>;

export const BuffStateSchema = z
  .object({
    buffId: identifier,
    ownerEntityId: identifier,
    sourceEntityId: identifier,
    stacks: nonNegativeInteger,
    expiresAtMs: nonNegativeInteger.nullable(),
    tags: uniqueIdentifiers,
  })
  .strict();
export type BuffState = z.infer<typeof BuffStateSchema>;

export const AbilityOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("native"), sourceAbilityId: identifier }).strict(),
  z
    .object({
      kind: z.literal("copied"),
      sourceAbilityId: identifier,
      sourceEntityId: identifier,
      copyId: identifier,
    })
    .strict(),
  z
    .object({
      kind: z.literal("transformed"),
      sourceAbilityId: identifier,
      transformationId: identifier,
    })
    .strict(),
]);

export const AbilityStateSchema = z
  .object({
    abilityId: identifier,
    ownerEntityId: identifier,
    rank: z.number().int().min(0).max(6),
    formId: identifier.nullable(),
    origin: AbilityOriginSchema,
  })
  .strict();
export type AbilityState = z.infer<typeof AbilityStateSchema>;

export const ItemUpgradeSchema = z
  .object({
    upgradeId: identifier,
    fromItemId: itemId,
    toItemId: itemId,
  })
  .strict();

export const ItemInstanceSchema = z
  .object({
    instanceId: identifier,
    baseItemId: itemId,
    effectiveItemId: itemId,
    slot: z.number().int().min(-1).max(5),
    state: z.enum(["owned", "equipped", "consumed", "sold"]),
    upgrade: ItemUpgradeSchema.nullable(),
    stacks: nonNegativeInteger,
    charges: nonNegativeInteger,
    provenance: ProvenanceSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.upgrade === null && value.baseItemId !== value.effectiveItemId) {
      context.addIssue({
        code: "custom",
        path: ["upgrade"],
        message: "changed effective item identity requires upgrade metadata",
      });
    }
    if (value.upgrade !== null && value.baseItemId === value.effectiveItemId) {
      context.addIssue({
        code: "custom",
        path: ["upgrade"],
        message: "unchanged item identity cannot carry upgrade metadata",
      });
    }
    if (value.upgrade !== null && value.upgrade.fromItemId === value.upgrade.toItemId) {
      context.addIssue({
        code: "custom",
        path: ["upgrade", "toItemId"],
        message: "item upgrades require a real identity change",
      });
    }
    if (value.upgrade && value.upgrade.fromItemId !== value.baseItemId) {
      context.addIssue({
        code: "custom",
        path: ["upgrade", "fromItemId"],
        message: "upgrade source must match the immutable base item ID",
      });
    }
    if (value.upgrade && value.upgrade.toItemId !== value.effectiveItemId) {
      context.addIssue({
        code: "custom",
        path: ["upgrade", "toItemId"],
        message: "upgrade destination must match the effective item ID",
      });
    }
  });
export type ItemInstance = z.infer<typeof ItemInstanceSchema>;

export const EntityTeamSchema = z.enum(["actor", "ally", "enemy", "neutral"]);
export const EntityKindSchema = z.enum([
  "champion",
  "minion",
  "monster",
  "summon",
  "projectile",
  "object",
]);

export const EntityStateSchema = z
  .object({
    entityId: identifier,
    ownerEntityId: identifier.nullable(),
    team: EntityTeamSchema,
    kind: EntityKindSchema,
    championId: identifier.nullable(),
    alive: z.boolean(),
    health: HealthStateSchema,
    resources: z.array(ResourceStateSchema),
    stats: finiteNumberMap,
    statProvenance: provenanceMap,
    abilities: z.array(AbilityStateSchema),
    buffs: z.array(BuffStateSchema),
    inventory: z.array(ItemInstanceSchema),
    inventoryOrigin: z.enum(["observed-effective", "modeled-loadout", "empty", "unknown"]),
    position: PositionSchema,
    provenance: ProvenanceSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.kind === "champion") !== (value.championId !== null)) {
      context.addIssue({
        code: "custom",
        path: ["championId"],
        message: "champion entities require a champion ID and other entity kinds require null",
      });
    }
    if (value.ownerEntityId === value.entityId) {
      context.addIssue({
        code: "custom",
        path: ["ownerEntityId"],
        message: "an entity cannot own itself",
      });
    }
    if (value.alive !== value.health.current > 0) {
      context.addIssue({
        code: "custom",
        path: ["alive"],
        message: "entity alive state must match positive current health",
      });
    }
    addDuplicateIdIssues(
      value.resources.map((resource) => resource.resourceId),
      "resources",
      "resource",
      context,
    );
    addDuplicateIdIssues(
      value.abilities.map((ability) => ability.abilityId),
      "abilities",
      "ability",
      context,
    );
    addDuplicateIdIssues(
      value.buffs.map((buff) => buff.buffId),
      "buffs",
      "buff",
      context,
    );
    addDuplicateIdIssues(
      value.inventory.map((item) => item.instanceId),
      "inventory",
      "item instance",
      context,
    );
    const equippedSlots = value.inventory
      .filter((item) => item.state === "equipped" && item.slot >= 0)
      .map((item) => String(item.slot));
    addDuplicateIdIssues(equippedSlots, "inventory", "equipped inventory slot", context);
    if (value.inventoryOrigin === "empty" && value.inventory.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["inventory"],
        message: "empty inventory origin requires an empty inventory",
      });
    }
    for (const [index, item] of value.inventory.entries()) {
      if (item.state === "equipped" && item.slot < 0) {
        context.addIssue({
          code: "custom",
          path: ["inventory", index, "slot"],
          message: "equipped items require a real inventory slot",
        });
      }
    }
    const statKeys = Object.keys(value.stats).sort();
    const provenanceKeys = Object.keys(value.statProvenance).sort();
    for (const statKey of statKeys) {
      if (!Object.hasOwn(value.statProvenance, statKey)) {
        context.addIssue({
          code: "custom",
          path: ["statProvenance", statKey],
          message: "every effective stat requires provenance",
        });
      }
    }
    for (const provenanceKey of provenanceKeys) {
      if (!Object.hasOwn(value.stats, provenanceKey)) {
        context.addIssue({
          code: "custom",
          path: ["statProvenance", provenanceKey],
          message: "stat provenance cannot describe a missing effective stat",
        });
      }
    }
    const entityIds = new Set([value.entityId]);
    for (const ability of value.abilities) {
      if (ability.ownerEntityId !== value.entityId) {
        context.addIssue({
          code: "custom",
          path: ["abilities"],
          message: `ability ${ability.abilityId} must be owned by ${value.entityId}`,
        });
      }
    }
    for (const buff of value.buffs) {
      if (!entityIds.has(buff.ownerEntityId)) {
        context.addIssue({
          code: "custom",
          path: ["buffs"],
          message: `buff ${buff.buffId} must be owned by ${value.entityId}`,
        });
      }
    }
  });
export type EntityState = z.infer<typeof EntityStateSchema>;

export const CohortMemberSchema = z
  .object({
    memberId: identifier,
    entityId: identifier,
    matchKey: identifier,
    weight: finiteNumber.positive(),
    provenance: ProvenanceSchema,
  })
  .strict();

export const CohortSpecSchema = z
  .object({
    cohortId: identifier,
    contentHash: ContentHashSchema,
    members: z.array(CohortMemberSchema).min(1),
    weighting: z.enum(["uniform-member", "match-balanced", "declared-mass"]),
    normalized: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const memberIds = value.members.map((member) => member.memberId);
    if (new Set(memberIds).size !== memberIds.length) {
      context.addIssue({
        code: "custom",
        path: ["members"],
        message: "cohort member IDs must be unique",
      });
    }
    const totalWeight = value.members.reduce((sum, member) => sum + member.weight, 0);
    if (!Number.isFinite(totalWeight)) {
      context.addIssue({
        code: "custom",
        path: ["members"],
        message: "aggregate cohort weight must be finite",
      });
    }
    if (value.normalized) {
      if (Math.abs(totalWeight - 1) > 1e-9) {
        context.addIssue({
          code: "custom",
          path: ["members"],
          message: "normalized cohort weights must sum to one within 1e-9",
        });
      }
    }
    if (value.weighting === "uniform-member") {
      const expectedWeight = value.normalized ? 1 / value.members.length : value.members[0]!.weight;
      if (value.members.some((member) => !scaleAwareEqual(member.weight, expectedWeight))) {
        context.addIssue({
          code: "custom",
          path: ["members"],
          message: "uniform-member cohorts require equal member weights",
        });
      }
    }
    if (value.weighting === "match-balanced") {
      const weightsByMatch = new Map<string, number>();
      for (const member of value.members)
        weightsByMatch.set(
          member.matchKey,
          (weightsByMatch.get(member.matchKey) ?? 0) + member.weight,
        );
      const totals = [...weightsByMatch.values()];
      if (totals.some((weight) => !scaleAwareEqual(weight, totals[0]!))) {
        context.addIssue({
          code: "custom",
          path: ["members"],
          message: "match-balanced cohorts require equal aggregate weight per match",
        });
      }
    }
  });
export type CohortSpec = z.infer<typeof CohortSpecSchema>;

export const TargetSelectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("self"), actorId: identifier }).strict(),
  z.object({ kind: z.literal("entity"), entityId: identifier }).strict(),
  z.object({ kind: z.literal("all-visible-enemies"), actorId: identifier }).strict(),
  z.object({ kind: z.literal("lowest-health-visible-enemy"), actorId: identifier }).strict(),
]);
export type TargetSelector = z.infer<typeof TargetSelectorSchema>;

export type Condition =
  | { kind: "always" }
  | { kind: "all"; clauses: Condition[] }
  | { kind: "any"; clauses: Condition[] }
  | { kind: "not"; clause: Condition }
  | { kind: "cooldown-ready"; entityId: string; abilityId: string }
  | { kind: "resource-at-least"; entityId: string; resourceId: string; amount: number }
  | { kind: "target-alive"; entityId: string }
  | { kind: "health-ratio-at-most"; entityId: string; ratio: number }
  | { kind: "buff-stacks-at-least"; entityId: string; buffId: string; stacks: number };

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("always") }).strict(),
    z.object({ kind: z.literal("all"), clauses: z.array(ConditionSchema).min(1) }).strict(),
    z.object({ kind: z.literal("any"), clauses: z.array(ConditionSchema).min(1) }).strict(),
    z.object({ kind: z.literal("not"), clause: ConditionSchema }).strict(),
    z
      .object({
        kind: z.literal("cooldown-ready"),
        entityId: identifier,
        abilityId: identifier,
      })
      .strict(),
    z
      .object({
        kind: z.literal("resource-at-least"),
        entityId: identifier,
        resourceId: identifier,
        amount: nonNegativeNumber,
      })
      .strict(),
    z.object({ kind: z.literal("target-alive"), entityId: identifier }).strict(),
    z
      .object({
        kind: z.literal("health-ratio-at-most"),
        entityId: identifier,
        ratio: finiteNumber.min(0).max(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal("buff-stacks-at-least"),
        entityId: identifier,
        buffId: identifier,
        stacks: nonNegativeInteger,
      })
      .strict(),
  ]),
);

export const ActionCommandSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("basic-attack"),
        actorId: identifier,
        target: TargetSelectorSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("ability"),
        actorId: identifier,
        abilityId: identifier,
        target: TargetSelectorSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("item-active"),
        actorId: identifier,
        itemInstanceId: identifier,
        target: TargetSelectorSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("move"),
        actorId: identifier,
        destination: PositionSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("wait"),
        actorId: identifier,
        durationMs: positiveInteger,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      "target" in value &&
      value.target.kind !== "entity" &&
      value.target.actorId !== value.actorId
    ) {
      context.addIssue({
        code: "custom",
        path: ["target", "actorId"],
        message: "selector actor must match the command actor",
      });
    }
  });
export type ActionCommand = z.infer<typeof ActionCommandSchema>;

export const ActionStepSchema = z
  .object({
    stepId: identifier,
    priority: positiveInteger,
    action: ActionCommandSchema,
    condition: ConditionSchema,
    onUnavailable: z.enum(["wait", "skip", "fail"]),
    unavailableWaitMs: positiveInteger.nullable(),
    repeat: z.boolean(),
    maxRepeats: positiveInteger.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.onUnavailable === "wait") !== (value.unavailableWaitMs !== null))
      context.addIssue({
        code: "custom",
        path: ["unavailableWaitMs"],
        message: "only wait-on-unavailable steps require a deterministic wait duration",
      });
    if (!value.repeat && value.maxRepeats !== null)
      context.addIssue({
        code: "custom",
        path: ["maxRepeats"],
        message: "one-shot policy steps require a null repeat limit",
      });
  });

export const PolicyVisibilitySchema = z
  .object({
    allowFutureEvents: z.literal(false),
    allowHiddenOpponentState: z.literal(false),
    visibleEntityIds: uniqueIdentifiers,
  })
  .strict();

export const ActionPolicySchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    policyId: identifier,
    revision: positiveInteger,
    mode: z.enum(["scripted", "conditional-priority"]),
    steps: z.array(ActionStepSchema).min(1),
    visibility: PolicyVisibilitySchema,
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIdIssues(
      value.steps.map((step) => step.stepId),
      "steps",
      "action step",
      context,
    );
    const priorities = value.steps.map((step) => step.priority);
    if (new Set(priorities).size !== priorities.length) {
      context.addIssue({
        code: "custom",
        path: ["steps"],
        message: "action priorities must be unique",
      });
    }
  });
export type ActionPolicy = z.infer<typeof ActionPolicySchema>;

export const ObjectiveKindSchema = z.enum([
  "burst-damage",
  "fixed-window-damage",
  "sustained-dps",
  "ttk",
  "first-death",
  "final-elimination",
]);

export const ObjectiveSpecSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    objectiveId: identifier,
    kind: ObjectiveKindSchema,
    primaryMetric: z.enum(["damage", "dps", "ttk", "time-to-first-death", "time-to-elimination"]),
    horizonMs: positiveInteger,
    warmupMs: nonNegativeInteger,
    censoring: z.enum(["right-censored", "fail-if-not-killed"]),
    aggregation: z.enum(["weighted-mean", "median", "coverage-then-ttk"]),
    tiePolicy: z.enum(["exact", "within-tolerance"]),
    tieTolerance: nonNegativeNumber.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.warmupMs > value.horizonMs) {
      context.addIssue({
        code: "custom",
        path: ["warmupMs"],
        message: "warmup cannot exceed the horizon",
      });
    }
    if (value.kind === "sustained-dps" && value.warmupMs === value.horizonMs) {
      context.addIssue({
        code: "custom",
        path: ["warmupMs"],
        message: "sustained DPS warmup must be strictly less than the horizon",
      });
    }
    const expectedMetric =
      value.kind === "sustained-dps"
        ? "dps"
        : value.kind === "ttk"
          ? "ttk"
          : value.kind === "first-death"
            ? "time-to-first-death"
            : value.kind === "final-elimination"
              ? "time-to-elimination"
              : "damage";
    if (value.primaryMetric !== expectedMetric) {
      context.addIssue({
        code: "custom",
        path: ["primaryMetric"],
        message: `${value.kind} must use ${expectedMetric}`,
      });
    }
    if (value.tiePolicy === "within-tolerance" && value.tieTolerance === null) {
      context.addIssue({
        code: "custom",
        path: ["tieTolerance"],
        message: "within-tolerance tie policy requires a numeric tolerance",
      });
    }
    if (value.tiePolicy === "exact" && value.tieTolerance !== null) {
      context.addIssue({
        code: "custom",
        path: ["tieTolerance"],
        message: "exact tie policy cannot carry a tolerance",
      });
    }
  });
export type ObjectiveSpec = z.infer<typeof ObjectiveSpecSchema>;

export const DeterministicRandomSchema = z
  .object({
    kind: z.literal("deterministic"),
    algorithm: z.literal("none"),
    seed: z.null(),
    trialCount: z.literal(1),
  })
  .strict();

export const SeededRandomSchema = z
  .object({
    kind: z.literal("seeded"),
    algorithm: identifier.refine((value) => value !== "none", {
      message: "seeded random configuration requires a random algorithm",
    }),
    seed: identifier,
    trialCount: positiveInteger,
  })
  .strict();

export const RandomConfigurationSchema = z.discriminatedUnion("kind", [
  DeterministicRandomSchema,
  SeededRandomSchema,
]);
export type RandomConfiguration = z.infer<typeof RandomConfigurationSchema>;

export const EvaluationModeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("analytical-expectation"),
      random: DeterministicRandomSchema,
      approximation: z.null(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("average-state-approximation"),
      random: DeterministicRandomSchema,
      approximation: z.enum(["expected-crit", "mean-resource", "mean-cooldown"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("seeded-trajectory"),
      random: SeededRandomSchema.refine((random) => random.trialCount === 1, {
        message: "seeded trajectories require exactly one trial",
      }),
      approximation: z.null(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("sampled-estimate"),
      random: SeededRandomSchema.refine((random) => random.trialCount >= 2, {
        message: "sampled estimates require at least two trials",
      }),
      approximation: z.null(),
      confidenceLevel: finiteNumber.gt(0).lt(1),
    })
    .strict(),
]);
export type EvaluationMode = z.infer<typeof EvaluationModeSchema>;

export const SearchBudgetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("incremental-gold"), amount: nonNegativeInteger }).strict(),
  z.object({ kind: z.literal("total-final-inventory"), amount: nonNegativeInteger }).strict(),
]);

export const SearchConstraintsSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    slotCount: z.number().int().min(1).max(6),
    bootRule: z.enum(["required", "optional", "forbidden"]),
    budget: SearchBudgetSchema,
    requiredItemIds: uniqueItemIds,
    excludedItemIds: uniqueItemIds,
    candidateLimit: positiveInteger,
    pruning: z.enum(["none", "legality-proven", "bound-proven"]),
  })
  .strict()
  .superRefine((value, context) => {
    const excluded = new Set(value.excludedItemIds);
    if (value.requiredItemIds.some((required) => excluded.has(required))) {
      context.addIssue({
        code: "custom",
        path: ["excludedItemIds"],
        message: "an item cannot be both required and excluded",
      });
    }
    if (value.requiredItemIds.length > value.slotCount) {
      context.addIssue({
        code: "custom",
        path: ["requiredItemIds"],
        message: "required items cannot exceed the slot count",
      });
    }
  });
export type SearchConstraints = z.infer<typeof SearchConstraintsSchema>;

const scenarioInputProvenanceFields = [
  "rulesetManifestHash",
  "modeId",
  "actorEntityId",
  "entities",
  "cohort",
  "policy",
  "objective",
  "evaluationMode",
  "searchConstraints",
] as const;

const resolvedProvenanceFields = [
  ...scenarioInputProvenanceFields,
  "policyHash",
  "candidateInput",
  "candidateInputHash",
] as const;

const scenarioValueShape = {
  rulesetManifestHash: ContentHashSchema,
  modeId: identifier,
  actorEntityId: identifier,
  entities: z.array(EntityStateSchema).min(1),
  cohort: CohortSpecSchema,
  policy: ActionPolicySchema,
  objective: ObjectiveSpecSchema,
  evaluationMode: EvaluationModeSchema,
  searchConstraints: SearchConstraintsSchema,
};

function addReferenceIssue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

function referencedEntityIds(
  policy: ActionPolicy,
): Array<{ id: string; path: (string | number)[] }> {
  const references: Array<{ id: string; path: (string | number)[] }> = [];
  for (const [stepIndex, step] of policy.steps.entries()) {
    const action = step.action;
    references.push({
      id: action.actorId,
      path: ["policy", "steps", stepIndex, "action", "actorId"],
    });
    if (action.kind === "move" || action.kind === "wait") continue;
    if (action.target.kind === "entity") {
      references.push({
        id: action.target.entityId,
        path: ["policy", "steps", stepIndex, "action", "target", "entityId"],
      });
    } else {
      references.push({
        id: action.target.actorId,
        path: ["policy", "steps", stepIndex, "action", "target", "actorId"],
      });
    }
  }
  return references;
}

type ConditionReference =
  | { kind: "entity"; entityId: string; path: (string | number)[] }
  | { kind: "ability"; entityId: string; abilityId: string; path: (string | number)[] }
  | { kind: "resource"; entityId: string; resourceId: string; path: (string | number)[] }
  | { kind: "buff"; entityId: string; buffId: string; path: (string | number)[] };

function visitCondition(
  condition: Condition,
  path: (string | number)[],
  visit: (reference: ConditionReference) => void,
): void {
  switch (condition.kind) {
    case "always":
      return;
    case "all":
    case "any":
      for (const [index, clause] of condition.clauses.entries()) {
        visitCondition(clause, [...path, "clauses", index], visit);
      }
      return;
    case "not":
      visitCondition(condition.clause, [...path, "clause"], visit);
      return;
    case "cooldown-ready":
      visit({
        kind: "ability",
        entityId: condition.entityId,
        abilityId: condition.abilityId,
        path: [...path, "abilityId"],
      });
      return;
    case "resource-at-least":
      visit({
        kind: "resource",
        entityId: condition.entityId,
        resourceId: condition.resourceId,
        path: [...path, "resourceId"],
      });
      return;
    case "target-alive":
    case "health-ratio-at-most":
      visit({ kind: "entity", entityId: condition.entityId, path: [...path, "entityId"] });
      return;
    case "buff-stacks-at-least":
      visit({
        kind: "buff",
        entityId: condition.entityId,
        buffId: condition.buffId,
        path: [...path, "buffId"],
      });
      return;
  }
}

function validateScenarioReferences(
  value: {
    actorEntityId: string;
    entities: EntityState[];
    cohort: CohortSpec;
    policy: ActionPolicy;
  },
  context: z.RefinementCtx,
): void {
  const entityIds = new Set<string>();
  const entitiesById = new Map<string, EntityState>();
  const visibleEntityIds = new Set(value.policy.visibility.visibleEntityIds);
  for (const [index, entity] of value.entities.entries()) {
    if (entityIds.has(entity.entityId)) {
      addReferenceIssue(
        context,
        ["entities", index, "entityId"],
        `entity ID ${entity.entityId} must be unique within a scenario`,
      );
    }
    entityIds.add(entity.entityId);
    entitiesById.set(entity.entityId, entity);
  }
  if (!entityIds.has(value.actorEntityId)) {
    addReferenceIssue(
      context,
      ["actorEntityId"],
      "actorEntityId must reference an entity in entities",
    );
  } else if (entitiesById.get(value.actorEntityId)?.team !== "actor") {
    addReferenceIssue(
      context,
      ["actorEntityId"],
      "actorEntityId must reference an entity on the actor team",
    );
  }
  for (const [index, member] of value.cohort.members.entries()) {
    if (!entityIds.has(member.entityId)) {
      addReferenceIssue(
        context,
        ["cohort", "members", index, "entityId"],
        `cohort member references unknown entity ${member.entityId}`,
      );
    }
  }
  for (const [entityIndex, entity] of value.entities.entries()) {
    if (entity.ownerEntityId !== null && !entityIds.has(entity.ownerEntityId)) {
      addReferenceIssue(
        context,
        ["entities", entityIndex, "ownerEntityId"],
        `entity owner references unknown entity ${entity.ownerEntityId}`,
      );
    }
    for (const [abilityIndex, ability] of entity.abilities.entries()) {
      if (ability.origin.kind === "copied" && !entityIds.has(ability.origin.sourceEntityId)) {
        addReferenceIssue(
          context,
          ["entities", entityIndex, "abilities", abilityIndex, "origin", "sourceEntityId"],
          `copied ability references unknown source entity ${ability.origin.sourceEntityId}`,
        );
      }
    }
    for (const [buffIndex, buff] of entity.buffs.entries()) {
      if (!entityIds.has(buff.sourceEntityId)) {
        addReferenceIssue(
          context,
          ["entities", entityIndex, "buffs", buffIndex, "sourceEntityId"],
          `buff references unknown source entity ${buff.sourceEntityId}`,
        );
      }
    }
  }
  for (const [entityIndex, entity] of value.entities.entries()) {
    const visited = new Set<string>([entity.entityId]);
    let ownerId = entity.ownerEntityId;
    while (ownerId !== null) {
      if (visited.has(ownerId)) {
        addReferenceIssue(
          context,
          ["entities", entityIndex, "ownerEntityId"],
          "entity ownership cannot contain cycles",
        );
        break;
      }
      visited.add(ownerId);
      ownerId = entitiesById.get(ownerId)?.ownerEntityId ?? null;
    }
  }
  for (const reference of referencedEntityIds(value.policy)) {
    if (!entityIds.has(reference.id)) {
      addReferenceIssue(
        context,
        reference.path,
        `policy references unknown entity ${reference.id}`,
      );
    }
  }
  for (const [index, visibleEntityId] of value.policy.visibility.visibleEntityIds.entries()) {
    if (!entityIds.has(visibleEntityId)) {
      addReferenceIssue(
        context,
        ["policy", "visibility", "visibleEntityIds", index],
        `policy visibility references unknown entity ${visibleEntityId}`,
      );
    }
  }
  if (!value.policy.visibility.visibleEntityIds.includes(value.actorEntityId)) {
    addReferenceIssue(
      context,
      ["policy", "visibility", "visibleEntityIds"],
      "policy visibility must include the actor entity",
    );
  }
  for (const [stepIndex, step] of value.policy.steps.entries()) {
    const action = step.action;
    if (action.actorId !== value.actorEntityId) {
      addReferenceIssue(
        context,
        ["policy", "steps", stepIndex, "action", "actorId"],
        "policy actions must use the designated scenario actor",
      );
    }
    const actor = entitiesById.get(action.actorId);
    if (!visibleEntityIds.has(action.actorId)) {
      addReferenceIssue(
        context,
        ["policy", "steps", stepIndex, "action", "actorId"],
        `policy action references hidden actor ${action.actorId}`,
      );
    }
    if (
      "target" in action &&
      action.target.kind === "entity" &&
      !visibleEntityIds.has(action.target.entityId)
    ) {
      addReferenceIssue(
        context,
        ["policy", "steps", stepIndex, "action", "target", "entityId"],
        `policy action targets hidden entity ${action.target.entityId}`,
      );
    }
    if (actor && action.kind === "ability") {
      if (!actor.abilities.some((ability) => ability.abilityId === action.abilityId)) {
        addReferenceIssue(
          context,
          ["policy", "steps", stepIndex, "action", "abilityId"],
          `policy references unknown ability ${action.abilityId} on entity ${action.actorId}`,
        );
      }
    }
    if (actor && action.kind === "item-active") {
      if (
        !actor.inventory.some(
          (item) => item.instanceId === action.itemInstanceId && item.state === "equipped",
        )
      ) {
        addReferenceIssue(
          context,
          ["policy", "steps", stepIndex, "action", "itemInstanceId"],
          `policy references unknown item instance or unavailable item instance ${action.itemInstanceId} on entity ${action.actorId}`,
        );
      }
    }
    visitCondition(step.condition, ["policy", "steps", stepIndex, "condition"], (reference) => {
      const entity = entitiesById.get(reference.entityId);
      if (!entity) {
        addReferenceIssue(
          context,
          [...reference.path.slice(0, -1), "entityId"],
          `condition references unknown entity ${reference.entityId}`,
        );
        return;
      }
      if (!visibleEntityIds.has(reference.entityId)) {
        addReferenceIssue(
          context,
          [...reference.path.slice(0, -1), "entityId"],
          `condition references hidden entity ${reference.entityId}`,
        );
      }
      if (reference.kind === "ability") {
        if (!entity.abilities.some((ability) => ability.abilityId === reference.abilityId)) {
          addReferenceIssue(
            context,
            reference.path,
            `condition references unknown ability ${reference.abilityId} on entity ${reference.entityId}`,
          );
        }
      } else if (reference.kind === "resource") {
        if (!entity.resources.some((resource) => resource.resourceId === reference.resourceId)) {
          addReferenceIssue(
            context,
            reference.path,
            `condition references unknown resource ${reference.resourceId} on entity ${reference.entityId}`,
          );
        }
      }
    });
  }
}

export const ScenarioSpecSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    scenarioId: identifier,
    ...scenarioValueShape,
    inputProvenance: provenanceMap,
  })
  .strict()
  .superRefine((value, context) => {
    validateScenarioReferences(value, context);
    for (const field of scenarioInputProvenanceFields) {
      if (!(field in value.inputProvenance)) {
        context.addIssue({
          code: "custom",
          path: ["inputProvenance", field],
          message: "every input field requires provenance",
        });
      }
    }
  });
export type ScenarioSpec = z.infer<typeof ScenarioSpecSchema>;

export const ResolvedScenarioValuesSchema = z
  .object(scenarioValueShape)
  .strict()
  .superRefine((value, context) => validateScenarioReferences(value, context));
export type ResolvedScenarioValues = z.infer<typeof ResolvedScenarioValuesSchema>;

export const ResolvedScenarioSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    scenarioId: identifier,
    resolvedScenarioHash: ContentHashSchema,
    policyHash: ContentHashSchema,
    candidateInput: JsonValueSchema,
    candidateInputHash: ContentHashSchema,
    effective: ResolvedScenarioValuesSchema,
    provenance: provenanceMap,
  })
  .strict()
  .superRefine((value, context) => {
    for (const field of resolvedProvenanceFields) {
      if (!(field in value.provenance)) {
        context.addIssue({
          code: "custom",
          path: ["provenance", field],
          message: "every replay-affecting field requires provenance",
        });
      }
    }
  });
export type ResolvedScenario = z.infer<typeof ResolvedScenarioSchema>;
declare const verifiedScenarioHashes: unique symbol;
export type HashVerifiedResolvedScenario = ResolvedScenario & {
  readonly [verifiedScenarioHashes]: true;
};
const runtimeVerifiedScenarios = new WeakSet<object>();

export function isRuntimeVerifiedResolvedScenario(
  value: unknown,
): value is HashVerifiedResolvedScenario {
  return typeof value === "object" && value !== null && runtimeVerifiedScenarios.has(value);
}

export const RunManifestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    runId: identifier,
    engineHash: ContentHashSchema,
    rulesetHash: ContentHashSchema,
    resolvedScenarioHash: ContentHashSchema,
    cohortHash: ContentHashSchema,
    policyHash: ContentHashSchema,
    searchContextHash: ContentHashSchema,
    candidateInputHash: ContentHashSchema,
    objective: ObjectiveSpecSchema,
    evaluationMode: EvaluationModeSchema,
    random: RandomConfigurationSchema,
    status: z.enum(["planned", "running", "complete", "incomplete", "cancelled", "invalid"]),
    createdAt: timestamp,
    completedAt: timestamp.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.searchContextHash === value.candidateInputHash) {
      context.addIssue({
        code: "custom",
        path: ["candidateInputHash"],
        message: "candidate input hash must remain distinct from the frozen search-context hash",
      });
    }
    if (value.status === "complete" && value.completedAt === null) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "complete runs require completedAt",
      });
    }
    if (value.status !== "complete" && value.completedAt !== null) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "incomplete runs cannot carry completedAt",
      });
    }
    if (value.completedAt !== null && Date.parse(value.completedAt) < Date.parse(value.createdAt)) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "completedAt cannot precede createdAt",
      });
    }
    if (canonicalJson(value.random) !== canonicalJson(value.evaluationMode.random)) {
      context.addIssue({
        code: "custom",
        path: ["random"],
        message: "run random configuration must match evaluationMode.random",
      });
    }
  });
export type RunManifest = z.infer<typeof RunManifestSchema>;

export const MechanicEvidenceSourceSchema = z
  .object({
    sourceId: identifier,
    sourceHash: ContentHashSchema,
    locator: z.string().min(1),
    excerpt: z.string().min(1),
  })
  .strict();

export const MechanicEvidenceSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    mechanicId: identifier,
    status: z.enum([
      "discovered",
      "specified",
      "implemented",
      "tested",
      "validated",
      "unavailable",
    ]),
    patch: z.string().min(1),
    sources: z.array(MechanicEvidenceSourceSchema),
    discrepancy: z.string().min(1).nullable(),
    nextAction: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status !== "unavailable" && value.sources.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["sources"],
        message: "non-unavailable mechanics require at least one source",
      });
    }
    if (value.status === "unavailable" && value.discrepancy === null) {
      context.addIssue({
        code: "custom",
        path: ["discrepancy"],
        message: "unavailable mechanics require a recorded discrepancy",
      });
    }
  });
export type MechanicEvidence = z.infer<typeof MechanicEvidenceSchema>;

export const StatsSnapshotSchema = z
  .object({
    entityId: identifier,
    revision: positiveInteger,
    values: finiteNumberMap,
  })
  .strict();
export type StatsSnapshot = z.infer<typeof StatsSnapshotSchema>;

export const DamagePacketSchema = z
  .object({
    sourceEntityId: identifier,
    targetEntityId: identifier,
    damageType: z.enum(["physical", "magic", "true"]),
    rawAmount: nonNegativeNumber,
    tags: uniqueIdentifiers,
    canOverkill: z.boolean(),
  })
  .strict();
export type DamagePacket = z.infer<typeof DamagePacketSchema>;

export const DamageResolutionSchema = z
  .object({
    attempted: nonNegativeNumber,
    absorbed: nonNegativeNumber,
    prevented: nonNegativeNumber,
    applied: nonNegativeNumber,
    overkill: nonNegativeNumber,
    discarded: nonNegativeNumber,
    targetHealthAfter: nonNegativeNumber,
    killed: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const accounted =
      value.absorbed + value.prevented + value.applied + value.overkill + value.discarded;
    if (!Number.isFinite(accounted) || !scaleAwareEqual(value.attempted, accounted)) {
      context.addIssue({
        code: "custom",
        path: ["attempted"],
        message: "damage resolution totals must reconcile",
      });
    }
    if (value.killed !== (value.targetHealthAfter === 0)) {
      context.addIssue({
        code: "custom",
        path: ["killed"],
        message: "damage death state must match zero target health",
      });
    }
  });
export type DamageResolution = z.infer<typeof DamageResolutionSchema>;

export const ResourceResolutionSchema = z
  .object({
    accepted: z.boolean(),
    entityId: identifier,
    resourceId: identifier,
    previous: nonNegativeNumber,
    current: nonNegativeNumber,
    reason: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.accepted !== (value.reason === null)) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "accepted resource responses require no rejection reason",
      });
    }
  });

export const LifecycleResolutionSchema = z
  .object({
    accepted: z.boolean(),
    entityId: identifier,
    transition: z.enum(["spawn", "despawn", "death", "revive", "transform"]),
    state: EntityStateSchema.nullable(),
    reason: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.accepted !== (value.reason === null)) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "accepted lifecycle responses require no rejection reason",
      });
    }
  });

export const RngResultSchema = z
  .object({
    streamId: identifier,
    values: z.array(finiteNumber.min(0).lt(1)),
    nextDrawCount: nonNegativeInteger,
  })
  .strict();

export const TraceEffectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("damage"),
      sourceEntityId: identifier,
      targetEntityId: identifier,
      damageType: z.enum(["physical", "magic", "true"]),
      amount: nonNegativeNumber,
      overkill: nonNegativeNumber,
    })
    .strict(),
  z
    .object({
      kind: z.literal("heal"),
      sourceEntityId: identifier,
      targetEntityId: identifier,
      amount: nonNegativeNumber,
    })
    .strict(),
  z
    .object({
      kind: z.literal("shield"),
      sourceEntityId: identifier,
      targetEntityId: identifier,
      amount: nonNegativeNumber,
    })
    .strict(),
  z
    .object({
      kind: z.literal("resource"),
      sourceEntityId: identifier,
      targetEntityId: identifier,
      resourceId: identifier,
      delta: finiteNumber,
    })
    .strict(),
  z.object({ kind: z.literal("buff"), buff: BuffStateSchema }).strict(),
  z
    .object({
      kind: z.literal("lifecycle"),
      entityId: identifier,
      transition: z.enum(["spawn", "despawn", "death", "revive", "transform"]),
    })
    .strict(),
]);

export const TraceEventSchema = z
  .object({
    eventId: identifier,
    sequence: positiveInteger,
    timeMs: nonNegativeInteger,
    phase: z.enum(["input", "windup", "impact", "periodic", "expiry", "lifecycle", "checkpoint"]),
    kind: z.enum(["action", "damage", "resource", "buff", "lifecycle", "random", "checkpoint"]),
    actorEntityId: identifier.nullable(),
    targetEntityIds: uniqueIdentifiers,
    causeEventIds: uniqueIdentifiers,
    effects: z.array(TraceEffectSchema),
    stateDigest: ContentHashSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.causeEventIds.includes(value.eventId)) {
      context.addIssue({
        code: "custom",
        path: ["causeEventIds"],
        message: "a trace event cannot cite itself as a cause",
      });
    }
  });
export type TraceEvent = z.infer<typeof TraceEventSchema>;

export const TraceSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    traceId: identifier,
    runId: identifier,
    events: z.array(TraceEventSchema),
    truncated: z.boolean(),
    truncationReason: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const sequences = value.events.map((event) => event.sequence);
    if (new Set(sequences).size !== sequences.length) {
      context.addIssue({
        code: "custom",
        path: ["events"],
        message: "trace sequence IDs must be globally unique",
      });
    }
    const eventIds = value.events.map((event) => event.eventId);
    if (new Set(eventIds).size !== eventIds.length) {
      context.addIssue({
        code: "custom",
        path: ["events"],
        message: "trace event IDs must be globally unique",
      });
    }
    const eventIndexById = new Map(value.events.map((event, index) => [event.eventId, index]));
    for (const [index, event] of value.events.entries()) {
      for (const [causeIndex, causeEventId] of event.causeEventIds.entries()) {
        const predecessorIndex = eventIndexById.get(causeEventId);
        if (predecessorIndex !== undefined && predecessorIndex >= index) {
          context.addIssue({
            code: "custom",
            path: ["events", index, "causeEventIds", causeIndex],
            message: "trace causes must reference an earlier retained event",
          });
        } else if (predecessorIndex === undefined && !value.truncated) {
          context.addIssue({
            code: "custom",
            path: ["events", index, "causeEventIds", causeIndex],
            message: "complete trace causes must reference a retained event",
          });
        }
      }
    }
    for (let index = 1; index < value.events.length; index += 1) {
      const previous = value.events[index - 1]!;
      const current = value.events[index]!;
      if (
        current.timeMs < previous.timeMs ||
        (current.timeMs === previous.timeMs && current.sequence <= previous.sequence)
      ) {
        context.addIssue({
          code: "custom",
          path: ["events", index],
          message: "trace events must have deterministic chronological order",
        });
      }
    }
    if (value.truncated && value.truncationReason === null) {
      context.addIssue({
        code: "custom",
        path: ["truncationReason"],
        message: "truncated traces require a reason",
      });
    }
    if (!value.truncated && value.truncationReason !== null) {
      context.addIssue({
        code: "custom",
        path: ["truncationReason"],
        message: "complete traces cannot carry a truncation reason",
      });
    }
  });
export type Trace = z.infer<typeof TraceSchema>;

export const MetricValueSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("value"), value: nonNegativeNumber }).strict(),
  z.object({ status: z.literal("censored"), horizonMs: positiveInteger }).strict(),
  z.object({ status: z.literal("undefined"), reason: z.string().min(1) }).strict(),
  z.object({ status: z.literal("not-applicable"), reason: z.string().min(1) }).strict(),
]);
export type MetricValue = z.infer<typeof MetricValueSchema>;

export const KillCoverageSchema = z
  .object({
    killedCount: nonNegativeInteger,
    totalCount: positiveInteger,
    killedWeight: nonNegativeNumber,
    totalWeight: finiteNumber.positive(),
    fraction: finiteNumber.min(0).max(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.killedCount > value.totalCount) {
      context.addIssue({
        code: "custom",
        path: ["killedCount"],
        message: "kill coverage cannot exceed its denominator",
      });
    }
    const weightsEqual = scaleAwareEqual(value.killedWeight, value.totalWeight);
    if (value.killedWeight > value.totalWeight && !weightsEqual) {
      context.addIssue({
        code: "custom",
        path: ["killedWeight"],
        message: "killed coverage weight cannot exceed total weight",
      });
    }
    if ((value.killedCount === 0) !== (value.killedWeight === 0)) {
      context.addIssue({
        code: "custom",
        path: ["killedWeight"],
        message: "zero kill count and weight must agree",
      });
    }
    if (
      (value.killedCount === value.totalCount && !weightsEqual) ||
      (value.killedCount < value.totalCount && value.killedWeight >= value.totalWeight)
    ) {
      context.addIssue({
        code: "custom",
        path: ["killedWeight"],
        message: "full kill count and weight must agree",
      });
    }
    if (!scaleAwareEqual(value.fraction, value.killedWeight / value.totalWeight)) {
      context.addIssue({
        code: "custom",
        path: ["fraction"],
        message: "kill coverage fraction must match its weights",
      });
    }
  });

export const SampleUncertaintySchema = z
  .object({
    effectiveSampleCount: positiveInteger,
    confidenceLevel: finiteNumber.gt(0).lt(1),
    standardErrors: finiteNumberMap,
  })
  .strict()
  .superRefine((value, context) => {
    for (const [metric, standardError] of Object.entries(value.standardErrors)) {
      if (standardError < 0) {
        context.addIssue({
          code: "custom",
          path: ["standardErrors", metric],
          message: "metric standard errors cannot be negative",
        });
      }
    }
  });

export const CombatResultSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    resultId: identifier,
    runId: identifier,
    status: z.enum(["complete", "incomplete", "cancelled", "invalid"]),
    objective: ObjectiveKindSchema,
    resolvedScenarioHash: ContentHashSchema,
    candidateInputHash: ContentHashSchema,
    metrics: z
      .object({
        damage: MetricValueSchema,
        dps: MetricValueSchema,
        ttk: MetricValueSchema,
        timeToFirstDeath: MetricValueSchema,
        timeToElimination: MetricValueSchema,
      })
      .strict(),
    coverage: KillCoverageSchema.nullable(),
    uncertainty: SampleUncertaintySchema.nullable(),
    killed: z.boolean(),
    censoring: z.enum(["not-censored", "right-censored", "invalid"]),
    warnings: z.array(z.string()),
    traceId: identifier.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.coverage !== null &&
      value.killed !== (value.coverage.killedCount === value.coverage.totalCount)
    ) {
      context.addIssue({
        code: "custom",
        path: ["killed"],
        message: "kill status must match full cohort coverage",
      });
    }
    const firstDeath = value.metrics.timeToFirstDeath;
    const elimination = value.metrics.timeToElimination;
    if (
      firstDeath.status === "value" &&
      elimination.status === "value" &&
      firstDeath.value > elimination.value
    ) {
      context.addIssue({
        code: "custom",
        path: ["metrics", "timeToFirstDeath"],
        message: "first death cannot follow final elimination",
      });
    }
    if (elimination.status === "value" && firstDeath.status !== "value") {
      context.addIssue({
        code: "custom",
        path: ["metrics", "timeToFirstDeath"],
        message: "finite elimination requires a finite first-death time",
      });
    }
    if (value.status === "complete") {
      const primaryMetric =
        value.objective === "sustained-dps"
          ? "dps"
          : value.objective === "ttk"
            ? "ttk"
            : value.objective === "first-death"
              ? "timeToFirstDeath"
              : value.objective === "final-elimination"
                ? "timeToElimination"
                : "damage";
      const metric = value.metrics[primaryMetric];
      const acceptsCensoring = ["ttk", "timeToFirstDeath", "timeToElimination"].includes(
        primaryMetric,
      );
      if (
        metric.status !== "value" &&
        !(acceptsCensoring && !value.killed && metric.status === "censored")
      ) {
        context.addIssue({
          code: "custom",
          path: ["metrics", primaryMetric],
          message: `complete ${value.objective} results require an objective-valid primary metric`,
        });
      }
    }
    const ttkStatus = value.metrics.ttk.status;
    if (value.killed) {
      if (value.status !== "complete") {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "only complete results may report a kill",
        });
      }
      if (ttkStatus !== "value") {
        context.addIssue({
          code: "custom",
          path: ["metrics", "ttk"],
          message: "a killed result requires a finite TTK value",
        });
      } else if (value.metrics.ttk.value < 0) {
        context.addIssue({
          code: "custom",
          path: ["metrics", "ttk", "value"],
          message: "a killed result requires a non-negative TTK value",
        });
      }
      if (value.censoring !== "not-censored") {
        context.addIssue({
          code: "custom",
          path: ["censoring"],
          message: "a killed result cannot be censored",
        });
      }
      return;
    }

    if (ttkStatus === "value") {
      context.addIssue({
        code: "custom",
        path: ["metrics", "ttk"],
        message: "a non-kill result cannot carry a finite TTK value",
      });
    }
    if (value.metrics.timeToElimination.status === "value") {
      context.addIssue({
        code: "custom",
        path: ["metrics", "timeToElimination"],
        message: "a non-kill result cannot carry a finite time to elimination",
      });
    }
    if (value.censoring === "right-censored") {
      if (value.status !== "complete" || ttkStatus !== "censored") {
        context.addIssue({
          code: "custom",
          path: ["censoring"],
          message: "right-censored results must be complete with a censored TTK",
        });
      }
    } else if (value.censoring === "invalid") {
      if (value.status === "complete" || !["undefined", "not-applicable"].includes(ttkStatus)) {
        context.addIssue({
          code: "custom",
          path: ["censoring"],
          message: "invalid censoring requires an interrupted/invalid result and undefined TTK",
        });
      }
    } else {
      context.addIssue({
        code: "custom",
        path: ["censoring"],
        message: "a non-kill result must be right-censored or invalid",
      });
    }
  });
export type CombatResult = z.infer<typeof CombatResultSchema>;

export const EngineRunSchema = z
  .object({
    status: z.enum(["complete", "incomplete", "cancelled", "invalid"]),
    result: CombatResultSchema,
    trace: TraceSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status !== value.result.status) {
      context.addIssue({
        code: "custom",
        path: ["result", "status"],
        message: "engine run status must match its result status",
      });
    }
    if (value.trace.runId !== value.result.runId) {
      context.addIssue({
        code: "custom",
        path: ["trace", "runId"],
        message: "engine run trace must match result run identity",
      });
    }
    if (value.result.traceId !== null && value.result.traceId !== value.trace.traceId) {
      context.addIssue({
        code: "custom",
        path: ["trace", "traceId"],
        message: "engine run trace identity must match result traceId",
      });
    }
  });
export type EngineRun = z.infer<typeof EngineRunSchema>;

export const ScheduledEventSchema = z
  .object({
    eventId: identifier,
    timeMs: nonNegativeInteger,
    sequence: positiveInteger,
    phase: z.enum(["input", "windup", "impact", "periodic", "expiry", "lifecycle", "checkpoint"]),
    kind: identifier,
    payload: JsonValueSchema,
    causeEventIds: uniqueIdentifiers,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.causeEventIds.includes(value.eventId)) {
      context.addIssue({
        code: "custom",
        path: ["causeEventIds"],
        message: "a scheduled event cannot cite itself as a cause",
      });
    }
  });
export type ScheduledEvent = z.infer<typeof ScheduledEventSchema>;

export const EventQueueSnapshotSchema = z
  .object({
    lastProcessedSequence: nonNegativeInteger,
    currentTimeSequence: nonNegativeInteger,
    nextSequence: positiveInteger,
    entries: z.array(ScheduledEventSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.entries.map((entry) => entry.eventId);
    const sequences = value.entries.map((entry) => entry.sequence);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "queued event IDs must be unique",
      });
    }
    if (new Set(sequences).size !== sequences.length) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "queued event sequence IDs must be unique",
      });
    }
    const maxSequence = sequences.reduce((maximum, sequence) => Math.max(maximum, sequence), 0);
    if (value.currentTimeSequence > value.lastProcessedSequence) {
      context.addIssue({
        code: "custom",
        path: ["currentTimeSequence"],
        message: "current-time sequence cursor cannot exceed the processed allocation maximum",
      });
    }
    if (value.nextSequence <= Math.max(maxSequence, value.lastProcessedSequence)) {
      context.addIssue({
        code: "custom",
        path: ["nextSequence"],
        message: "nextSequence must be greater than every allocated event sequence",
      });
    }
    for (let index = 1; index < value.entries.length; index += 1) {
      const previous = value.entries[index - 1]!;
      const current = value.entries[index]!;
      if (
        current.timeMs < previous.timeMs ||
        (current.timeMs === previous.timeMs && current.sequence <= previous.sequence)
      ) {
        context.addIssue({
          code: "custom",
          path: ["entries", index],
          message: "queue entries must be ordered by time then unique sequence",
        });
      }
    }
    const eventIndexById = new Map(value.entries.map((event, index) => [event.eventId, index]));
    for (const [index, event] of value.entries.entries()) {
      for (const [causeIndex, causeEventId] of event.causeEventIds.entries()) {
        const causeIndexInQueue = eventIndexById.get(causeEventId);
        if (causeIndexInQueue !== undefined && causeIndexInQueue >= index) {
          context.addIssue({
            code: "custom",
            path: ["entries", index, "causeEventIds", causeIndex],
            message: "queued causes must reference an earlier retained event",
          });
        }
      }
    }
  });

export const PendingActionSchema = z
  .object({
    actionId: identifier,
    continuationEventId: identifier.nullable(),
    origin: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("policy-action"), stepId: identifier }).strict(),
      z.object({ kind: z.literal("policy-wait"), stepId: identifier }).strict(),
    ]),
    command: ActionCommandSchema,
    state: z.enum(["scheduled", "windup", "interrupted", "complete"]),
    startedAtMs: nonNegativeInteger,
  })
  .strict();

export const PolicyStepProgressSchema = z
  .object({
    stepId: identifier,
    consumedRepeats: nonNegativeInteger,
    state: z.enum(["not-started", "active", "completed", "skipped"]),
  })
  .strict();

export const PolicyExecutionProgressSchema = z
  .object({
    policyId: identifier,
    revision: positiveInteger,
    nextStepId: identifier.nullable(),
    steps: z.array(PolicyStepProgressSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIdIssues(
      value.steps.map((step) => step.stepId),
      "steps",
      "policy progress step",
      context,
    );
    if (
      value.nextStepId !== null &&
      !value.steps.some((step) => step.stepId === value.nextStepId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["nextStepId"],
        message: "next policy step must exist in policy execution progress",
      });
    }
    const next = value.steps.find((step) => step.stepId === value.nextStepId);
    if (next && !["not-started", "active"].includes(next.state)) {
      context.addIssue({
        code: "custom",
        path: ["nextStepId"],
        message: "next policy step must reference executable progress",
      });
    }
  });

export const TriggerStateSchema = z
  .object({
    triggerId: identifier,
    ownerEntityId: identifier,
    armed: z.boolean(),
    stacks: nonNegativeInteger,
    internalCooldownUntilMs: nonNegativeInteger.nullable(),
  })
  .strict();

export const RngStreamSnapshotSchema = z
  .object({
    streamId: identifier,
    algorithm: identifier,
    seed: identifier,
    drawCount: nonNegativeInteger,
    state: z.array(nonNegativeInteger),
  })
  .strict();
export type RngStreamSnapshot = z.infer<typeof RngStreamSnapshotSchema>;

export const NumericalBranchStateSchema = z
  .object({
    branchId: identifier,
    mode: z.enum([
      "analytical-expectation",
      "average-state-approximation",
      "seeded-trajectory",
      "sampled-estimate",
    ]),
    accumulators: finiteNumberMap,
    labels: uniqueIdentifiers,
  })
  .strict();

export const SnapshotInterruptionSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none"), reason: z.null() }).strict(),
  z
    .object({
      state: z.literal("budget-exhausted"),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      state: z.literal("cancelled"),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      state: z.literal("invalid"),
      reason: z.string().min(1),
    })
    .strict(),
  z.object({ state: z.literal("completed"), reason: z.null() }).strict(),
]);
export type SnapshotInterruption = z.infer<typeof SnapshotInterruptionSchema>;

export const EngineSnapshotSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    runId: identifier,
    engineHash: ContentHashSchema,
    rulesetHash: ContentHashSchema,
    cohortHash: ContentHashSchema,
    policyHash: ContentHashSchema,
    resolvedScenarioHash: ContentHashSchema,
    candidateInputHash: ContentHashSchema,
    stateRevisions: z.record(identifier, positiveInteger),
    trace: TraceSchema,
    allocatedEventIds: uniqueIdentifiers,
    currentTimeMs: nonNegativeInteger,
    queue: EventQueueSnapshotSchema,
    entities: z.array(EntityStateSchema).min(1),
    retiredEntityIds: uniqueIdentifiers,
    buffs: z.array(BuffStateSchema),
    pendingActions: z.array(PendingActionSchema),
    policyProgress: PolicyExecutionProgressSchema,
    triggerState: z.array(TriggerStateSchema),
    rngStreams: z.array(RngStreamSnapshotSchema),
    numericalBranches: z.array(NumericalBranchStateSchema),
    status: z.enum(["running", "complete", "incomplete", "cancelled", "invalid"]),
    resumability: z.enum(["resumable", "non-resumable"]),
    interruption: SnapshotInterruptionSchema,
    result: CombatResultSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIdIssues(
      value.pendingActions.map((action) => action.actionId),
      "pendingActions",
      "pending action",
      context,
    );
    addDuplicateIdIssues(
      value.triggerState.map((trigger) => trigger.triggerId),
      "triggerState",
      "trigger",
      context,
    );
    addDuplicateIdIssues(
      value.numericalBranches.map((branch) => branch.branchId),
      "numericalBranches",
      "numerical branch",
      context,
    );
    addDuplicateIdIssues(
      value.rngStreams.map((stream) => stream.streamId),
      "rngStreams",
      "RNG stream",
      context,
    );
    for (const [index, entry] of value.queue.entries.entries()) {
      if (
        entry.timeMs < value.currentTimeMs ||
        (entry.timeMs === value.currentTimeMs && entry.sequence <= value.queue.currentTimeSequence)
      ) {
        context.addIssue({
          code: "custom",
          path: ["queue", "entries", index, "timeMs"],
          message:
            "snapshot queue events cannot precede currentTimeMs or remain behind the processed time and sequence frontier",
        });
      }
    }
    const entityIds = value.entities.map((entity) => entity.entityId);
    if (new Set(entityIds).size !== entityIds.length) {
      context.addIssue({
        code: "custom",
        path: ["entities"],
        message: "snapshot entity IDs must be unique",
      });
    }
    const knownEntityIds = new Set(entityIds);
    const retiredEntityIds = new Set(value.retiredEntityIds);
    for (const [index, entityId] of value.retiredEntityIds.entries()) {
      if (knownEntityIds.has(entityId)) {
        context.addIssue({
          code: "custom",
          path: ["retiredEntityIds", index],
          message: "retired entity IDs cannot remain active",
        });
      }
    }
    // A despawned identity stays retired; every other lifecycle identity stays accounted for.
    for (const [eventIndex, event] of value.trace.events.entries()) {
      for (const [effectIndex, effect] of event.effects.entries()) {
        if (effect.kind !== "lifecycle") continue;
        const retired = retiredEntityIds.has(effect.entityId);
        if (
          effect.transition === "despawn"
            ? !retired
            : !retired && !knownEntityIds.has(effect.entityId)
        ) {
          context.addIssue({
            code: "custom",
            path: ["trace", "events", eventIndex, "effects", effectIndex, "entityId"],
            message: "retained lifecycle trace effects must match the retired entity ledger",
          });
        }
      }
    }
    if (
      canonicalJson(Object.keys(value.stateRevisions).sort()) !==
      canonicalJson([...entityIds].sort())
    ) {
      context.addIssue({
        code: "custom",
        path: ["stateRevisions"],
        message: "snapshot state revisions must cover every entity exactly",
      });
    }
    if (value.trace.runId !== value.runId) {
      context.addIssue({
        code: "custom",
        path: ["trace", "runId"],
        message: "snapshot trace must match the snapshot run",
      });
    }
    const allocatedEventIds = new Set(value.allocatedEventIds);
    const representedEventIds = new Set([
      ...value.trace.events.map((event) => event.eventId),
      ...value.trace.events.flatMap((event) => event.causeEventIds),
      ...value.queue.entries.map((event) => event.eventId),
      ...value.queue.entries.flatMap((event) => event.causeEventIds),
    ]);
    for (const eventId of representedEventIds) {
      if (!allocatedEventIds.has(eventId)) {
        context.addIssue({
          code: "custom",
          path: ["allocatedEventIds"],
          message: `snapshot allocated event IDs must retain represented identity ${eventId}`,
        });
      }
    }
    for (const [index, event] of value.trace.events.entries()) {
      if (
        event.timeMs > value.currentTimeMs ||
        event.sequence > value.queue.lastProcessedSequence ||
        (event.timeMs === value.currentTimeMs && event.sequence > value.queue.currentTimeSequence)
      ) {
        context.addIssue({
          code: "custom",
          path: ["trace", "events", index],
          message: "snapshot trace events must remain behind the processed frontier",
        });
      }
    }
    const retainedTraceEventIds = new Set(value.trace.events.map((event) => event.eventId));
    const retainedTraceSequences = new Set(value.trace.events.map((event) => event.sequence));
    const queuedEventIndexById = new Map(
      value.queue.entries.map((event, index) => [event.eventId, index]),
    );
    for (const [index, event] of value.queue.entries.entries()) {
      if (retainedTraceEventIds.has(event.eventId) || retainedTraceSequences.has(event.sequence)) {
        context.addIssue({
          code: "custom",
          path: ["queue", "entries", index],
          message: "queued event identities cannot reuse an ID or sequence from the retained trace",
        });
      }
      for (const [causeIndex, causeEventId] of event.causeEventIds.entries()) {
        const queuedCauseIndex = queuedEventIndexById.get(causeEventId);
        if (
          queuedCauseIndex === undefined &&
          !retainedTraceEventIds.has(causeEventId) &&
          !value.trace.truncated
        ) {
          context.addIssue({
            code: "custom",
            path: ["queue", "entries", index, "causeEventIds", causeIndex],
            message: "queued causes must resolve to a retained trace or earlier queued event",
          });
        }
      }
    }
    const entitiesById = new Map(value.entities.map((entity) => [entity.entityId, entity]));
    for (const [entityIndex, entity] of value.entities.entries()) {
      if (entity.ownerEntityId !== null && !knownEntityIds.has(entity.ownerEntityId)) {
        context.addIssue({
          code: "custom",
          path: ["entities", entityIndex, "ownerEntityId"],
          message: "snapshot entity owners must reference known entities",
        });
      }
      for (const [buffIndex, buff] of entity.buffs.entries()) {
        if (!knownEntityIds.has(buff.sourceEntityId)) {
          context.addIssue({
            code: "custom",
            path: ["entities", entityIndex, "buffs", buffIndex, "sourceEntityId"],
            message: "snapshot entity buffs must reference known source entities",
          });
        }
      }
      for (const [abilityIndex, ability] of entity.abilities.entries()) {
        if (
          ability.origin.kind === "copied" &&
          !knownEntityIds.has(ability.origin.sourceEntityId)
        ) {
          context.addIssue({
            code: "custom",
            path: ["entities", entityIndex, "abilities", abilityIndex, "origin", "sourceEntityId"],
            message: "snapshot copied abilities must reference known source entities",
          });
        }
      }
    }
    for (const [entityIndex, entity] of value.entities.entries()) {
      const visited = new Set<string>([entity.entityId]);
      let ownerId = entity.ownerEntityId;
      while (ownerId !== null) {
        if (visited.has(ownerId)) {
          context.addIssue({
            code: "custom",
            path: ["entities", entityIndex, "ownerEntityId"],
            message: "snapshot entity ownership cannot contain cycles",
          });
          break;
        }
        visited.add(ownerId);
        ownerId = entitiesById.get(ownerId)?.ownerEntityId ?? null;
      }
    }
    for (const [index, buff] of value.buffs.entries()) {
      if (!knownEntityIds.has(buff.ownerEntityId) || !knownEntityIds.has(buff.sourceEntityId)) {
        context.addIssue({
          code: "custom",
          path: ["buffs", index],
          message: "snapshot buffs must reference known entities",
        });
      }
      if (buff.expiresAtMs !== null && buff.expiresAtMs < value.currentTimeMs) {
        context.addIssue({
          code: "custom",
          path: ["buffs", index, "expiresAtMs"],
          message: "snapshot buffs cannot already be expired",
        });
      }
    }
    const nestedBuffs = value.entities.flatMap((entity) => entity.buffs);
    const sortBuffs = (buffs: BuffState[]) =>
      [...buffs].sort((left, right) => {
        const leftKey = `${left.ownerEntityId}\u0000${left.buffId}`;
        const rightKey = `${right.ownerEntityId}\u0000${right.buffId}`;
        return leftKey.localeCompare(rightKey);
      });
    if (canonicalJson(sortBuffs(value.buffs)) !== canonicalJson(sortBuffs(nestedBuffs))) {
      context.addIssue({
        code: "custom",
        path: ["buffs"],
        message: "snapshot top-level buffs must exactly match entity buff state",
      });
    }
    for (const [index, trigger] of value.triggerState.entries()) {
      if (!knownEntityIds.has(trigger.ownerEntityId)) {
        context.addIssue({
          code: "custom",
          path: ["triggerState", index, "ownerEntityId"],
          message: "snapshot triggers must reference known owner entities",
        });
      }
    }
    for (const [index, pending] of value.pendingActions.entries()) {
      if (["scheduled", "windup"].includes(pending.state)) {
        const continuation = value.queue.entries.find(
          (event) => event.eventId === pending.continuationEventId,
        );
        if (pending.continuationEventId === null || !continuation) {
          context.addIssue({
            code: "custom",
            path: ["pendingActions", index, "continuationEventId"],
            message: "active pending actions require a queued continuation event",
          });
        } else if (continuation.timeMs < pending.startedAtMs) {
          context.addIssue({
            code: "custom",
            path: ["pendingActions", index, "continuationEventId"],
            message: "pending action continuations cannot precede the action start",
          });
        } else if (
          pending.command.kind === "wait" &&
          continuation.timeMs !== pending.startedAtMs + pending.command.durationMs
        ) {
          context.addIssue({
            code: "custom",
            path: ["pendingActions", index, "continuationEventId"],
            message: "pending wait continuation must match its declared duration",
          });
        }
      }
      if (
        ["interrupted", "complete"].includes(pending.state) &&
        pending.continuationEventId !== null
      ) {
        context.addIssue({
          code: "custom",
          path: ["pendingActions", index, "continuationEventId"],
          message: "terminal pending actions cannot retain continuations",
        });
      }
      if (pending.state !== "scheduled" && pending.startedAtMs > value.currentTimeMs) {
        context.addIssue({
          code: "custom",
          path: ["pendingActions", index, "startedAtMs"],
          message: "started pending actions cannot begin after snapshot time",
        });
      }
      const action = pending.command;
      const actor = entitiesById.get(action.actorId);
      if (!actor) {
        context.addIssue({
          code: "custom",
          path: ["pendingActions", index, "command", "actorId"],
          message: "pending actions must reference known actor entities",
        });
        continue;
      }
      if (
        action.kind === "ability" &&
        !actor.abilities.some((ability) => ability.abilityId === action.abilityId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["pendingActions", index, "command", "abilityId"],
          message: "pending actions must reference known abilities",
        });
      }
      if (
        action.kind === "item-active" &&
        !actor.inventory.some((item) => item.instanceId === action.itemInstanceId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["pendingActions", index, "command", "itemInstanceId"],
          message: "pending actions must reference known item instances",
        });
      }
      if (action.kind !== "move" && action.kind !== "wait") {
        const targetId =
          action.target.kind === "entity" ? action.target.entityId : action.target.actorId;
        if (!knownEntityIds.has(targetId)) {
          context.addIssue({
            code: "custom",
            path: ["pendingActions", index, "command", "target"],
            message: "pending actions must reference known target entities",
          });
        }
      }
    }
    const activeContinuations = value.pendingActions
      .filter((pending) => ["scheduled", "windup"].includes(pending.state))
      .map((pending) => pending.continuationEventId)
      .filter((id): id is string => id !== null);
    if (new Set(activeContinuations).size !== activeContinuations.length) {
      context.addIssue({
        code: "custom",
        path: ["pendingActions"],
        message: "active pending actions require unique continuation events",
      });
    }
    if (value.status === "complete") {
      if (value.result === null) {
        context.addIssue({
          code: "custom",
          path: ["result"],
          message: "complete snapshots require a result",
        });
      } else if (value.result.status !== "complete") {
        context.addIssue({
          code: "custom",
          path: ["result", "status"],
          message: "complete snapshots require a complete result",
        });
      }
    } else if (value.status === "running") {
      if (value.result !== null) {
        context.addIssue({
          code: "custom",
          path: ["result"],
          message: "running snapshots cannot carry a terminal result",
        });
      }
    } else if (value.result === null || value.result.status !== value.status) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: `${value.status} snapshots require a matching terminal result`,
      });
    }
    const expectedResumability = value.status === "running" ? "resumable" : "non-resumable";
    if (value.resumability !== expectedResumability) {
      context.addIssue({
        code: "custom",
        path: ["resumability"],
        message: `${value.status} snapshots must be ${expectedResumability}`,
      });
    }
    const expectedInterruption =
      value.status === "running"
        ? ["none", "budget-exhausted"]
        : [
            value.status === "complete"
              ? "completed"
              : value.status === "incomplete"
                ? "budget-exhausted"
                : value.status,
          ];
    if (!expectedInterruption.includes(value.interruption.state)) {
      context.addIssue({
        code: "custom",
        path: ["interruption", "state"],
        message: `${value.status} snapshots have an invalid interruption state`,
      });
    }
    if (value.resumability === "non-resumable") {
      if (value.queue.entries.length > 0 || value.pendingActions.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["queue"],
          message: "non-resumable snapshots cannot retain queued or pending work",
        });
      }
    }
    if (value.result !== null) {
      for (const [metricName, metric] of Object.entries(value.result.metrics)) {
        if (
          ["ttk", "timeToFirstDeath", "timeToElimination"].includes(metricName) &&
          ((metric.status === "value" && metric.value > value.currentTimeMs) ||
            (metric.status === "censored" && metric.horizonMs > value.currentTimeMs))
        ) {
          context.addIssue({
            code: "custom",
            path: ["result", "metrics", metricName],
            message: "snapshot result times and censoring horizons cannot exceed currentTimeMs",
          });
        }
      }
      if (
        value.result.runId !== value.runId ||
        value.result.resolvedScenarioHash !== value.resolvedScenarioHash ||
        value.result.candidateInputHash !== value.candidateInputHash ||
        (value.result.traceId !== null && value.result.traceId !== value.trace.traceId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["result"],
          message: "snapshot result identity must match the snapshot",
        });
      }
    }
  });
export type EngineSnapshot = z.infer<typeof EngineSnapshotSchema>;

export const StepBudgetSchema = z
  .object({
    maxEvents: positiveInteger,
    untilTimeMs: nonNegativeInteger.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.untilTimeMs !== null && value.untilTimeMs < 0) {
      context.addIssue({
        code: "custom",
        path: ["untilTimeMs"],
        message: "time cannot be negative",
      });
    }
  });
export type StepBudget = z.infer<typeof StepBudgetSchema>;

export const PolicyVisibleReadinessSchema = z
  .object({
    entityId: identifier,
    abilityId: identifier,
    ready: z.boolean(),
    cooldownRemainingMs: nonNegativeInteger,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ready && value.cooldownRemainingMs !== 0) {
      context.addIssue({
        code: "custom",
        path: ["cooldownRemainingMs"],
        message: "ready abilities require zero remaining cooldown",
      });
    }
  });

export const PolicyVisibleResourceSchema = z
  .object({
    resourceId: identifier,
    current: nonNegativeNumber,
    maximum: finiteNumber.positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.current > value.maximum) {
      context.addIssue({
        code: "custom",
        path: ["current"],
        message: "visible current resource cannot exceed maximum resource",
      });
    }
  });

export const PolicyVisibleBuffSchema = z
  .object({
    buffId: identifier,
    stacks: nonNegativeInteger,
    expiresAtMs: nonNegativeInteger.nullable(),
  })
  .strict();

export const PolicyVisibleEntitySchema = z
  .object({
    entityId: identifier,
    team: EntityTeamSchema,
    kind: EntityKindSchema,
    alive: z.boolean(),
    health: HealthStateSchema,
    resources: z.array(PolicyVisibleResourceSchema),
    visibleAbilityIds: uniqueIdentifiers,
    buffs: z.array(PolicyVisibleBuffSchema),
    position: PositionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.alive !== value.health.current > 0) {
      context.addIssue({
        code: "custom",
        path: ["alive"],
        message: "visible alive state must match positive current health",
      });
    }
    addDuplicateIdIssues(
      value.resources.map((resource) => resource.resourceId),
      "resources",
      "visible resource",
      context,
    );
    addDuplicateIdIssues(
      value.buffs.map((buff) => buff.buffId),
      "buffs",
      "visible buff",
      context,
    );
  });

export const PolicyVisibleStateSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    atTimeMs: nonNegativeInteger,
    actorEntityId: identifier,
    visibility: PolicyVisibilitySchema,
    entities: z.array(PolicyVisibleEntitySchema).min(1),
    readiness: z.array(PolicyVisibleReadinessSchema),
    visibleResourceIds: uniqueIdentifiers,
  })
  .strict()
  .superRefine((value, context) => {
    const entityIds = value.entities.map((entity) => entity.entityId);
    const entityIdSet = new Set(entityIds);
    if (new Set(entityIds).size !== entityIds.length) {
      context.addIssue({
        code: "custom",
        path: ["entities"],
        message: "policy-visible entity IDs must be unique",
      });
    }
    for (const [entityIndex, entity] of value.entities.entries()) {
      for (const [buffIndex, buff] of entity.buffs.entries()) {
        if (buff.expiresAtMs !== null && buff.expiresAtMs < value.atTimeMs) {
          context.addIssue({
            code: "custom",
            path: ["entities", entityIndex, "buffs", buffIndex, "expiresAtMs"],
            message: "policy-visible buffs cannot already be expired",
          });
        }
      }
    }
    if (value.visibility.visibleEntityIds.length !== entityIds.length) {
      context.addIssue({
        code: "custom",
        path: ["visibility", "visibleEntityIds"],
        message: "policy visibility must match the entities exposed to the policy",
      });
    }
    for (const visibleEntityId of value.visibility.visibleEntityIds) {
      if (!entityIdSet.has(visibleEntityId)) {
        context.addIssue({
          code: "custom",
          path: ["visibility", "visibleEntityIds"],
          message: `policy visibility entity ${visibleEntityId} is not exposed`,
        });
      }
    }
    if (!entityIdSet.has(value.actorEntityId)) {
      context.addIssue({
        code: "custom",
        path: ["actorEntityId"],
        message: "policy-visible state must expose its actor entity",
      });
    } else if (
      value.entities.find((entity) => entity.entityId === value.actorEntityId)?.team !== "actor"
    ) {
      context.addIssue({
        code: "custom",
        path: ["actorEntityId"],
        message: "policy-visible actor must belong to the actor team",
      });
    }
    const visibleResources = new Set(value.visibleResourceIds);
    for (const [entityIndex, entity] of value.entities.entries()) {
      for (const [resourceIndex, resource] of entity.resources.entries()) {
        if (!visibleResources.has(resource.resourceId)) {
          context.addIssue({
            code: "custom",
            path: ["entities", entityIndex, "resources", resourceIndex, "resourceId"],
            message: `resource ${resource.resourceId} is exposed without visibility declaration`,
          });
        }
      }
    }
    for (const visibleResourceId of value.visibleResourceIds) {
      if (
        !value.entities.some((entity) =>
          entity.resources.some((resource) => resource.resourceId === visibleResourceId),
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["visibleResourceIds"],
          message: `visible resource ${visibleResourceId} is not present in exposed state`,
        });
      }
    }
    for (const [index, readiness] of value.readiness.entries()) {
      const entity = value.entities.find((candidate) => candidate.entityId === readiness.entityId);
      if (!entity) {
        context.addIssue({
          code: "custom",
          path: ["readiness", index, "entityId"],
          message: `readiness references hidden entity ${readiness.entityId}`,
        });
      } else if (!entity.visibleAbilityIds.includes(readiness.abilityId)) {
        context.addIssue({
          code: "custom",
          path: ["readiness", index, "abilityId"],
          message: `readiness references non-visible ability ${readiness.abilityId}`,
        });
      }
    }
    const readinessKeys = new Set(
      value.readiness.map((readiness) => `${readiness.entityId}\u0000${readiness.abilityId}`),
    );
    for (const [entityIndex, entity] of value.entities.entries()) {
      for (const [abilityIndex, abilityId] of entity.visibleAbilityIds.entries()) {
        if (!readinessKeys.has(`${entity.entityId}\u0000${abilityId}`)) {
          context.addIssue({
            code: "custom",
            path: ["entities", entityIndex, "visibleAbilityIds", abilityIndex],
            message: "every visible ability requires exactly one readiness record",
          });
        }
      }
    }
    addDuplicateIdIssues(
      value.readiness.map((readiness) => `${readiness.entityId}\u0000${readiness.abilityId}`),
      "readiness",
      "policy readiness record",
      context,
    );
  });
export type PolicyVisibleState = z.infer<typeof PolicyVisibleStateSchema>;

export const EngineCommandSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
        kind: z.literal("apply-damage"),
        commandId: identifier,
        issuedAtMs: nonNegativeInteger,
        causeEventIds: uniqueIdentifiers,
        packet: DamagePacketSchema,
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
        kind: z.literal("schedule-event"),
        commandId: identifier,
        issuedAtMs: nonNegativeInteger,
        causeEventIds: uniqueIdentifiers,
        event: ScheduledEventSchema,
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
        kind: z.literal("cancel-event"),
        commandId: identifier,
        issuedAtMs: nonNegativeInteger,
        causeEventIds: uniqueIdentifiers,
        eventId: identifier,
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
        kind: z.literal("trace"),
        commandId: identifier,
        issuedAtMs: nonNegativeInteger,
        causeEventIds: uniqueIdentifiers,
        event: TraceEventSchema,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.kind === "schedule-event" && value.event.timeMs < value.issuedAtMs) {
      context.addIssue({
        code: "custom",
        path: ["event", "timeMs"],
        message: "scheduled events cannot precede command issue time",
      });
    }
    if (value.kind === "trace" && value.event.timeMs !== value.issuedAtMs) {
      context.addIssue({
        code: "custom",
        path: ["event", "timeMs"],
        message: "trace event time must match command issue time",
      });
    }
    if (
      (value.kind === "schedule-event" || value.kind === "trace") &&
      value.causeEventIds.some((cause) => !value.event.causeEventIds.includes(cause))
    ) {
      context.addIssue({
        code: "custom",
        path: ["event", "causeEventIds"],
        message: "nested events must preserve every command cause",
      });
    }
  });
export type EngineCommand = z.infer<typeof EngineCommandSchema>;

export const EngineEventSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    eventId: identifier,
    timeMs: nonNegativeInteger,
    sequence: positiveInteger,
    phase: z.enum(["input", "windup", "impact", "periodic", "expiry", "lifecycle", "checkpoint"]),
    kind: identifier,
    actorEntityId: identifier.nullable(),
    targetEntityIds: uniqueIdentifiers,
    causeEventIds: uniqueIdentifiers,
    payload: JsonValueSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.causeEventIds.includes(value.eventId)) {
      context.addIssue({
        code: "custom",
        path: ["causeEventIds"],
        message: "an event cannot cite itself as a cause",
      });
    }
  });
export type EngineEvent = z.infer<typeof EngineEventSchema>;

export const EngineStepResultSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    status: z.enum(["progress", "complete", "incomplete", "cancelled", "invalid"]),
    snapshot: EngineSnapshotSchema,
    emittedEvents: z.array(EngineEventSchema),
    result: CombatResultSchema.nullable(),
    reason: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const emittedIds = value.emittedEvents.map((event) => event.eventId);
    const emittedSequences = value.emittedEvents.map((event) => event.sequence);
    if (new Set(emittedIds).size !== emittedIds.length) {
      context.addIssue({
        code: "custom",
        path: ["emittedEvents"],
        message: "emitted event IDs must be unique",
      });
    }
    if (new Set(emittedSequences).size !== emittedSequences.length) {
      context.addIssue({
        code: "custom",
        path: ["emittedEvents"],
        message: "emitted event sequences must be unique",
      });
    }
    const queuedIds = new Set(value.snapshot.queue.entries.map((event) => event.eventId));
    const queuedSequences = new Set(value.snapshot.queue.entries.map((event) => event.sequence));
    if (
      value.emittedEvents.some(
        (event) => queuedIds.has(event.eventId) || queuedSequences.has(event.sequence),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["emittedEvents"],
        message: "emitted event identities cannot remain queued",
      });
    }
    const emittedIndexById = new Map(
      value.emittedEvents.map((event, index) => [event.eventId, index]),
    );
    const retainedTraceById = new Map(
      value.snapshot.trace.events.map((event) => [event.eventId, event]),
    );
    const retainedTraceBySequence = new Map(
      value.snapshot.trace.events.map((event) => [event.sequence, event]),
    );
    const allocatedEventIds = new Set(value.snapshot.allocatedEventIds);
    for (const [index, event] of value.emittedEvents.entries()) {
      if (!allocatedEventIds.has(event.eventId)) {
        context.addIssue({
          code: "custom",
          path: ["emittedEvents", index, "eventId"],
          message: "emitted event IDs must remain in the snapshot allocation ledger",
        });
      }
      const retainedById = retainedTraceById.get(event.eventId);
      const retainedBySequence = retainedTraceBySequence.get(event.sequence);
      const sharedTraceFieldsMatch =
        retainedById !== undefined &&
        retainedBySequence === retainedById &&
        retainedById.timeMs === event.timeMs &&
        retainedById.sequence === event.sequence &&
        retainedById.phase === event.phase &&
        retainedById.kind === event.kind &&
        retainedById.actorEntityId === event.actorEntityId &&
        canonicalJson(retainedById.targetEntityIds) === canonicalJson(event.targetEntityIds) &&
        canonicalJson(retainedById.causeEventIds) === canonicalJson(event.causeEventIds);
      if (
        (retainedById !== undefined || retainedBySequence !== undefined) &&
        !sharedTraceFieldsMatch
      ) {
        context.addIssue({
          code: "custom",
          path: ["emittedEvents", index],
          message: "emitted event identities must exactly match retained trace identities",
        });
      }
      if (
        event.timeMs > value.snapshot.currentTimeMs ||
        event.sequence > value.snapshot.queue.lastProcessedSequence ||
        (event.timeMs === value.snapshot.currentTimeMs &&
          event.sequence > value.snapshot.queue.currentTimeSequence)
      ) {
        context.addIssue({
          code: "custom",
          path: ["emittedEvents", index],
          message: "emitted events must remain behind the snapshot frontier",
        });
      }
      for (const [causeIndex, causeId] of event.causeEventIds.entries()) {
        const emittedCauseIndex = emittedIndexById.get(causeId);
        if (
          (emittedCauseIndex !== undefined && emittedCauseIndex >= index) ||
          queuedIds.has(causeId) ||
          (emittedCauseIndex === undefined &&
            !retainedTraceById.has(causeId) &&
            !value.snapshot.trace.truncated) ||
          (() => {
            const retainedCause = retainedTraceById.get(causeId);
            return (
              retainedCause !== undefined &&
              (retainedCause.timeMs > event.timeMs ||
                (retainedCause.timeMs === event.timeMs && retainedCause.sequence >= event.sequence))
            );
          })()
        ) {
          context.addIssue({
            code: "custom",
            path: ["emittedEvents", index, "causeEventIds", causeIndex],
            message: "emitted causes must reference an already executed event",
          });
        }
      }
    }
    for (let index = 1; index < value.emittedEvents.length; index += 1) {
      const previous = value.emittedEvents[index - 1]!;
      const current = value.emittedEvents[index]!;
      if (
        current.timeMs < previous.timeMs ||
        (current.timeMs === previous.timeMs && current.sequence <= previous.sequence)
      ) {
        context.addIssue({
          code: "custom",
          path: ["emittedEvents", index],
          message: "emitted events must be ordered by time then sequence",
        });
      }
    }
    const expectedSnapshotStatus = value.status === "progress" ? "running" : value.status;
    if (value.snapshot.status !== expectedSnapshotStatus) {
      context.addIssue({
        code: "custom",
        path: ["snapshot", "status"],
        message: `${value.status} step results require a ${expectedSnapshotStatus} snapshot`,
      });
    }
    if (value.status !== "progress" && value.result === null) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "terminal step results require a result",
      });
    }
    if (value.status === "progress" && value.result !== null) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "progress step results cannot carry a terminal result",
      });
    }
    if (value.status === "complete") {
      if (value.reason !== null || value.snapshot.interruption.state !== "completed") {
        context.addIssue({
          code: "custom",
          path: ["reason"],
          message: "complete step results cannot carry an interruption reason",
        });
      }
      if (
        value.result !== null &&
        (value.snapshot.result === null ||
          canonicalJson(value.snapshot.result) !== canonicalJson(value.result))
      ) {
        context.addIssue({
          code: "custom",
          path: ["result"],
          message: "complete step result must exactly match the snapshot result",
        });
      }
    } else if (["incomplete", "cancelled", "invalid"].includes(value.status)) {
      const interruptionState = value.status === "incomplete" ? "budget-exhausted" : value.status;
      if (
        value.reason === null ||
        value.snapshot.interruption.state !== interruptionState ||
        value.snapshot.interruption.reason !== value.reason
      ) {
        context.addIssue({
          code: "custom",
          path: ["reason"],
          message: `${value.status} step results require a reason matching the snapshot interruption`,
        });
      }
      if (
        value.result !== null &&
        (value.result.status !== value.status ||
          value.snapshot.result === null ||
          canonicalJson(value.snapshot.result) !== canonicalJson(value.result))
      ) {
        context.addIssue({
          code: "custom",
          path: ["result"],
          message: `${value.status} step result must exactly match the snapshot terminal result`,
        });
      }
    } else if (value.status === "progress") {
      if (value.snapshot.interruption.state === "budget-exhausted") {
        if (value.reason !== value.snapshot.interruption.reason) {
          context.addIssue({
            code: "custom",
            path: ["reason"],
            message:
              "budget-exhausted progress requires a reason matching the snapshot interruption",
          });
        }
      } else if (value.reason !== null) {
        context.addIssue({
          code: "custom",
          path: ["reason"],
          message: "progress without interruption cannot carry a reason",
        });
      }
    }
  });
export type EngineStepResult = z.infer<typeof EngineStepResultSchema>;

export const ExactComparisonTransferSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    result: CombatResultSchema,
    resolvedScenario: ResolvedScenarioSchema,
    run: RunManifestSchema,
    candidateInputHash: ContentHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.run.status !== "complete" || value.result.status !== "complete") {
      context.addIssue({
        code: "custom",
        path: ["result", "status"],
        message: "exact comparison requires a complete run and complete result",
      });
    }
    if (value.run.runId !== value.result.runId) {
      context.addIssue({
        code: "custom",
        path: ["run", "runId"],
        message: "run and result must share run identity",
      });
    }
    if (value.run.resolvedScenarioHash !== value.resolvedScenario.resolvedScenarioHash) {
      context.addIssue({
        code: "custom",
        path: ["run", "resolvedScenarioHash"],
        message: "run and transfer must reference the same resolved scenario",
      });
    }
    if (value.run.candidateInputHash !== value.candidateInputHash) {
      context.addIssue({
        code: "custom",
        path: ["candidateInputHash"],
        message: "transfer candidate input must match the run manifest",
      });
    }
    if (value.resolvedScenario.candidateInputHash !== value.candidateInputHash) {
      context.addIssue({
        code: "custom",
        path: ["candidateInputHash"],
        message: "transfer candidate input must match the resolved scenario provenance",
      });
    }
    if (value.result.resolvedScenarioHash !== value.resolvedScenario.resolvedScenarioHash) {
      context.addIssue({
        code: "custom",
        path: ["result", "resolvedScenarioHash"],
        message: "result and transfer must reference the same resolved scenario",
      });
    }
    if (value.result.candidateInputHash !== value.candidateInputHash) {
      context.addIssue({
        code: "custom",
        path: ["result", "candidateInputHash"],
        message: "result and transfer must reference the same candidate input",
      });
    }
    if (value.run.rulesetHash !== value.resolvedScenario.effective.rulesetManifestHash) {
      context.addIssue({
        code: "custom",
        path: ["run", "rulesetHash"],
        message: "run and scenario must share ruleset provenance",
      });
    }
    if (value.run.cohortHash !== value.resolvedScenario.effective.cohort.contentHash) {
      context.addIssue({
        code: "custom",
        path: ["run", "cohortHash"],
        message: "run and scenario must share cohort provenance",
      });
    }
    if (value.run.policyHash !== value.resolvedScenario.policyHash) {
      context.addIssue({
        code: "custom",
        path: ["run", "policyHash"],
        message: "run and scenario must share policy provenance",
      });
    }
    if (value.run.objective.kind !== value.result.objective) {
      context.addIssue({
        code: "custom",
        path: ["run", "objective"],
        message: "run and result must share objective identity",
      });
    }
    if (value.run.objective.aggregation === "coverage-then-ttk" && value.result.coverage === null) {
      context.addIssue({
        code: "custom",
        path: ["result", "coverage"],
        message: "coverage-first aggregation requires machine-readable kill coverage",
      });
    }
    if (value.result.coverage !== null) {
      const cohort = value.resolvedScenario.effective.cohort;
      const totalWeight = cohort.members.reduce((sum, member) => sum + member.weight, 0);
      if (
        value.result.coverage.totalCount !== cohort.members.length ||
        !scaleAwareEqual(value.result.coverage.totalWeight, totalWeight)
      ) {
        context.addIssue({
          code: "custom",
          path: ["result", "coverage"],
          message: "coverage denominator must match the transferred cohort",
        });
      }
    }
    for (const [metricName, metric] of Object.entries(value.result.metrics)) {
      if (metric.status === "censored" && metric.horizonMs !== value.run.objective.horizonMs) {
        context.addIssue({
          code: "custom",
          path: ["result", "metrics", metricName, "horizonMs"],
          message: "censored metric must match the transferred objective horizon",
        });
      }
      if (
        ["ttk", "timeToFirstDeath", "timeToElimination"].includes(metricName) &&
        metric.status === "value" &&
        metric.value > value.run.objective.horizonMs
      ) {
        context.addIssue({
          code: "custom",
          path: ["result", "metrics", metricName, "value"],
          message: "elapsed-time metric cannot exceed the transferred objective horizon",
        });
      }
    }
    if (value.run.evaluationMode.kind === "sampled-estimate") {
      const uncertainty = value.result.uncertainty;
      if (
        uncertainty === null ||
        uncertainty.confidenceLevel !== value.run.evaluationMode.confidenceLevel ||
        uncertainty.effectiveSampleCount < 2 ||
        uncertainty.effectiveSampleCount > value.run.evaluationMode.random.trialCount
      ) {
        context.addIssue({
          code: "custom",
          path: ["result", "uncertainty"],
          message: "sampled estimates require matching machine-readable uncertainty",
        });
      }
      const primaryMetric =
        value.run.objective.primaryMetric === "time-to-first-death"
          ? "timeToFirstDeath"
          : value.run.objective.primaryMetric === "time-to-elimination"
            ? "timeToElimination"
            : value.run.objective.primaryMetric;
      if (uncertainty !== null && !(primaryMetric in uncertainty.standardErrors)) {
        context.addIssue({
          code: "custom",
          path: ["result", "uncertainty", "standardErrors"],
          message: "sampled estimates require a standard error for the primary metric",
        });
      }
    } else if (value.result.uncertainty !== null) {
      context.addIssue({
        code: "custom",
        path: ["result", "uncertainty"],
        message: "non-sampled results cannot carry sampling uncertainty",
      });
    }
    if (
      canonicalJson(value.run.objective) !==
      canonicalJson(value.resolvedScenario.effective.objective)
    ) {
      context.addIssue({
        code: "custom",
        path: ["run", "objective"],
        message: "run and scenario must share objective configuration",
      });
    }
    if (
      canonicalJson(value.run.evaluationMode) !==
      canonicalJson(value.resolvedScenario.effective.evaluationMode)
    ) {
      context.addIssue({
        code: "custom",
        path: ["run", "evaluationMode"],
        message: "run and scenario must share evaluation configuration",
      });
    }
    if (!value.result.killed && value.run.objective.censoring === "fail-if-not-killed") {
      context.addIssue({
        code: "custom",
        path: ["result", "censoring"],
        message: "fail-if-not-killed objectives cannot transfer a non-kill result",
      });
    }
  });
export type ExactComparisonTransfer = z.infer<typeof ExactComparisonTransferSchema>;

export const WorkerMessageSchema = z.discriminatedUnion("direction", [
  z
    .object({
      schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
      direction: z.literal("command"),
      runId: identifier,
      payload: EngineCommandSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
      direction: z.literal("event"),
      runId: identifier,
      payload: EngineEventSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
      direction: z.literal("step"),
      payload: EngineStepResultSchema,
    })
    .strict(),
]);
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;

export const ContractSchemas = {
  RulesetManifest: RulesetManifestSchema,
  ScenarioSpec: ScenarioSpecSchema,
  ResolvedScenario: ResolvedScenarioSchema,
  EntityState: EntityStateSchema,
  ItemInstance: ItemInstanceSchema,
  ActionPolicy: ActionPolicySchema,
  ObjectiveSpec: ObjectiveSpecSchema,
  SearchConstraints: SearchConstraintsSchema,
  EvaluationMode: EvaluationModeSchema,
  RunManifest: RunManifestSchema,
  MechanicEvidence: MechanicEvidenceSchema,
  Trace: TraceSchema,
  CombatResult: CombatResultSchema,
  PolicyVisibleState: PolicyVisibleStateSchema,
  PolicyVisibleEntity: PolicyVisibleEntitySchema,
  SnapshotInterruption: SnapshotInterruptionSchema,
  EngineSnapshot: EngineSnapshotSchema,
  EngineCommand: EngineCommandSchema,
  EngineEvent: EngineEventSchema,
  EngineStepResult: EngineStepResultSchema,
  ExactComparisonTransfer: ExactComparisonTransferSchema,
  WorkerMessage: WorkerMessageSchema,
} as const;

export class ContractValidationError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(error: z.ZodError) {
    super(`contract validation failed: ${error.issues.map((issue) => issue.message).join("; ")}`);
    this.name = "ContractValidationError";
    this.issues = error.issues;
  }
}

export class SnapshotNotResumableError extends Error {
  constructor(status: EngineSnapshot["status"], interruption: SnapshotInterruption["state"]) {
    super(`snapshot cannot be resumed: status=${status}, interruption=${interruption}`);
    this.name = "SnapshotNotResumableError";
  }
}

export function parseContract<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    canonicalJson(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : "canonical JSON validation failed";
    throw new ContractValidationError(new z.ZodError([{ code: "custom", path: [], message }]));
  }
  const parsed = schema.safeParse(detachCanonicalData(value));
  if (!parsed.success) throw new ContractValidationError(parsed.error);
  return parsed.data;
}

export function assertResumableSnapshot(value: unknown): EngineSnapshot {
  const snapshot = parseContract(EngineSnapshotSchema, value);
  if (snapshot.status !== "running" || snapshot.resumability !== "resumable") {
    throw new SnapshotNotResumableError(snapshot.status, snapshot.interruption.state);
  }
  return snapshot;
}

function canonicalize(value: unknown, stack: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("canonical JSON cannot contain non-finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") {
    throw new TypeError(
      "canonical JSON cannot contain undefined, bigint, symbol, or function values",
    );
  }
  if (stack.has(value)) throw new TypeError("canonical JSON cannot contain cycles");
  stack.add(value);
  let result: string;
  if (Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Array.prototype && prototype !== null) {
      throw new TypeError("canonical JSON accepts ordinary arrays only");
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") {
        throw new TypeError("canonical JSON cannot contain symbol-keyed properties");
      }
      if (key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) {
        throw new TypeError("canonical JSON cannot contain non-enumerable properties");
      }
      if ("get" in descriptor || "set" in descriptor) {
        throw new TypeError("canonical JSON cannot contain accessor properties");
      }
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= 2 ** 32 - 1 || String(index) !== key) {
        throw new TypeError("canonical JSON arrays cannot contain extra properties");
      }
    }
    const entries: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new TypeError("canonical JSON cannot contain sparse arrays");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      entries.push(canonicalize(descriptor?.value, stack));
    }
    result = `[${entries.join(",")}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical JSON accepts plain objects only");
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") {
        throw new TypeError("canonical JSON cannot contain symbol-keyed properties");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) {
        throw new TypeError("canonical JSON cannot contain non-enumerable properties");
      }
      if ("get" in descriptor || "set" in descriptor) {
        throw new TypeError("canonical JSON cannot contain accessor properties");
      }
    }
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return `${JSON.stringify(key)}:${canonicalize(descriptor?.value, stack)}`;
      });
    result = `{${entries.join(",")}}`;
  }
  stack.delete(value);
  return result;
}

function detachCanonicalData(value: unknown): unknown {
  if (typeof value === "number" && Object.is(value, -0)) return 0;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const detached: unknown[] = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      detached[index] = detachCanonicalData(descriptor?.value);
    }
    return detached;
  }

  const detached = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    detached[key] = detachCanonicalData(descriptor?.value);
  }
  return detached;
}

function assertStructuredCloneSafe(value: unknown): void {
  try {
    globalThis.structuredClone(value);
  } catch {
    throw new TypeError("canonical JSON requires structured-clone-safe data");
  }
}

function assertAccessorAndProxySafe(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && ("get" in descriptor || "set" in descriptor)) {
      throw new TypeError("canonical JSON cannot contain accessor properties");
    }
    if (descriptor && "value" in descriptor) assertAccessorAndProxySafe(descriptor.value, seen);
  }
}

/** Stable key ordering is shared by hashes, cache identities, and replay files. */
export function canonicalJson(value: unknown): string {
  assertAccessorAndProxySafe(value);
  assertStructuredCloneSafe(value);
  return canonicalize(value, new Set<object>());
}

export async function hashCanonical(value: unknown): Promise<ContentHash> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

/** Parses and verifies a ruleset manifest before its hash is used as a replay identity. */
export async function assertRulesetManifestHash(
  value: unknown,
): Promise<HashVerifiedRulesetManifest> {
  const manifest = parseContract(RulesetManifestSchema, value);
  const manifestBytes = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== "manifestHash"),
  );
  if (manifest.manifestHash !== (await hashCanonical(manifestBytes))) {
    throw new ContractValidationError(
      new z.ZodError([
        {
          code: "custom",
          path: ["manifestHash"],
          message: "ruleset manifest hash must match canonical manifest bytes",
        },
      ]),
    );
  }
  deepFreeze(manifest);
  return manifest as HashVerifiedRulesetManifest;
}

export async function assertResolvedScenarioPolicyHash(
  value: unknown,
): Promise<HashVerifiedResolvedScenario> {
  const scenario = parseContract(ResolvedScenarioSchema, value);
  const [actualPolicyHash, actualScenarioHash] = await Promise.all([
    hashCanonical(scenario.effective.policy),
    hashCanonical(scenario.effective),
  ]);
  const cohortBytes = Object.fromEntries(
    Object.entries(scenario.effective.cohort).filter(([key]) => key !== "contentHash"),
  );
  const [actualCohortHash, actualCandidateInputHash] = await Promise.all([
    hashCanonical(cohortBytes),
    hashCanonical(scenario.candidateInput),
  ]);
  if (
    scenario.policyHash !== actualPolicyHash ||
    scenario.resolvedScenarioHash !== actualScenarioHash ||
    scenario.effective.cohort.contentHash !== actualCohortHash ||
    scenario.candidateInputHash !== actualCandidateInputHash
  ) {
    throw new ContractValidationError(
      new z.ZodError([
        {
          code: "custom",
          path:
            scenario.policyHash !== actualPolicyHash
              ? ["policyHash"]
              : scenario.effective.cohort.contentHash !== actualCohortHash
                ? ["effective", "cohort", "contentHash"]
                : scenario.candidateInputHash !== actualCandidateInputHash
                  ? ["candidateInputHash"]
                  : ["resolvedScenarioHash"],
          message: "resolved scenario hashes must match canonical effective bytes",
        },
      ]),
    );
  }
  deepFreeze(scenario);
  runtimeVerifiedScenarios.add(scenario);
  return scenario as HashVerifiedResolvedScenario;
}

/** Parses an external comparison transfer and verifies its canonical scenario identities. */
export async function assertExactComparisonTransfer(
  value: unknown,
): Promise<ExactComparisonTransfer> {
  const transfer = parseContract(ExactComparisonTransferSchema, value);
  const resolvedScenario = await assertResolvedScenarioPolicyHash(transfer.resolvedScenario);
  const verified = { ...transfer, resolvedScenario };
  deepFreeze(verified);
  return verified;
}

function deepFreeze(entry: unknown): void {
  if (entry === null || typeof entry !== "object" || Object.isFrozen(entry)) return;
  for (const value of Object.values(entry)) deepFreeze(value);
  Object.freeze(entry);
}
