import {
  ProvenanceSchema,
  ScenarioSpecSchema,
  type Provenance,
  type ScenarioSpec,
} from "../../../domains/dps/contracts/index.ts";

export const scenarioFields = [
  "rulesetManifestHash",
  "modeId",
  "actorEntityId",
  "entities",
  "cohort",
  "policy",
  "objective",
  "evaluationMode",
  "searchConstraints",
] as const satisfies readonly (keyof ScenarioSpec)[];
export type ScenarioField = (typeof scenarioFields)[number];

type Overrides = {
  [K in ScenarioField]?: { value: ScenarioSpec[K]; provenance: Provenance };
};
export type DraftIssue = Readonly<{ path: string; message: string }>;
export type DefaultsRequest = Readonly<{ requestId: number; revision: number }>;

/** UI draft state only. Contract validity does not certify catalog or inventory legality. */
export type ScenarioEditorState = Readonly<{
  defaults: ScenarioSpec;
  overrides: Overrides;
  revision: number;
  requestSequence: number;
  pendingDefaults: DefaultsRequest | null;
  defaultsIssues: readonly DraftIssue[];
}>;

type EditAction = {
  [K in ScenarioField]: {
    type: "edit";
    field: K;
    value: ScenarioSpec[K];
    provenance: Provenance;
  };
}[ScenarioField];

export type ScenarioEditorAction =
  | EditAction
  | { type: "reset-field"; field: ScenarioField }
  | { type: "reset-all" }
  | { type: "request-defaults" }
  | { type: "receive-defaults"; request: DefaultsRequest; value: unknown }
  | { type: "defaults-failed"; request: DefaultsRequest; message: string };

export function createScenarioEditor(value: unknown): ScenarioEditorState {
  return {
    defaults: ScenarioSpecSchema.parse(value),
    overrides: {},
    revision: 0,
    requestSequence: 0,
    pendingDefaults: null,
    defaultsIssues: [],
  };
}

/** Detached draft retains invalid edits until the user explicitly fixes or resets them. */
export function scenarioDraft(state: ScenarioEditorState): ScenarioSpec {
  const values = Object.fromEntries(
    scenarioFields.flatMap((field) => {
      const override = state.overrides[field];
      return override ? [[field, override.value]] : [];
    }),
  );
  const provenance = Object.fromEntries(
    scenarioFields.flatMap((field) => {
      const override = state.overrides[field];
      return override ? [[field, override.provenance]] : [];
    }),
  );
  return structuredClone({
    ...state.defaults,
    ...values,
    inputProvenance: { ...state.defaults.inputProvenance, ...provenance },
  });
}

export function inspectScenarioDraft(state: ScenarioEditorState) {
  const parsed = ScenarioSpecSchema.safeParse(scenarioDraft(state));
  if (parsed.success) return { status: "contract-valid" as const, scenario: parsed.data };
  return {
    status: "invalid" as const,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
}

function advance(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER)
    throw new RangeError("scenario editor revision exhausted");
  return value + 1;
}

function matchesRequest(state: ScenarioEditorState, request: DefaultsRequest): boolean {
  return (
    state.pendingDefaults !== null &&
    state.pendingDefaults.requestId === request.requestId &&
    state.pendingDefaults.revision === request.revision &&
    state.revision === request.revision
  );
}

export function scenarioEditorReducer(
  state: ScenarioEditorState,
  action: ScenarioEditorAction,
): ScenarioEditorState {
  switch (action.type) {
    case "edit": {
      const provenance = ProvenanceSchema.parse(action.provenance);
      if (provenance.kind !== "manual")
        throw new TypeError("manual edits require manual input provenance");
      return {
        ...state,
        overrides: {
          ...state.overrides,
          [action.field]: { value: structuredClone(action.value), provenance },
        },
        revision: advance(state.revision),
        pendingDefaults: null,
        defaultsIssues: [],
      };
    }
    case "reset-field": {
      const overrides = { ...state.overrides };
      delete overrides[action.field];
      return {
        ...state,
        overrides,
        revision: advance(state.revision),
        pendingDefaults: null,
        defaultsIssues: [],
      };
    }
    case "reset-all":
      return {
        ...state,
        overrides: {},
        revision: advance(state.revision),
        pendingDefaults: null,
        defaultsIssues: [],
      };
    case "request-defaults": {
      const requestId = advance(state.requestSequence);
      return {
        ...state,
        requestSequence: requestId,
        pendingDefaults: { requestId, revision: state.revision },
        defaultsIssues: [],
      };
    }
    case "defaults-failed":
      if (!matchesRequest(state, action.request)) return state;
      return {
        ...state,
        pendingDefaults: null,
        defaultsIssues: [{ path: "", message: action.message }],
      };
    case "receive-defaults": {
      if (!matchesRequest(state, action.request)) return state;
      const parsed = ScenarioSpecSchema.safeParse(action.value);
      if (!parsed.success)
        return {
          ...state,
          pendingDefaults: null,
          defaultsIssues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        };
      if (parsed.data.scenarioId !== state.defaults.scenarioId)
        return {
          ...state,
          pendingDefaults: null,
          defaultsIssues: [{ path: "scenarioId", message: "defaults belong to another scenario" }],
        };
      return {
        ...state,
        defaults: parsed.data,
        revision: advance(state.revision),
        pendingDefaults: null,
        defaultsIssues: [],
      };
    }
  }
}
