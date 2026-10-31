import { expect, test } from "vitest";
import { ScenarioSpecSchema } from "../../../../src/domains/dps/contracts/index.ts";
import {
  createScenarioEditor,
  inspectScenarioDraft,
  scenarioDraft,
  scenarioEditorReducer as reduce,
} from "../../../../src/components/dps/state/scenario-editor.ts";
import { provenance, sampleScenario } from "../../contracts/fixtures.ts";

const manual = provenance("manual", "scenario-editor-test", null);

function observedDefaults() {
  const value = structuredClone(sampleScenario);
  value.objective.horizonMs += 1000;
  value.inputProvenance.objective = provenance("observed", "recorded-default");
  return ScenarioSpecSchema.parse(value);
}

test("manual policy and required items survive unrelated edits and matching default refresh", () => {
  let state = createScenarioEditor(sampleScenario);
  const policy = { ...sampleScenario.policy, revision: sampleScenario.policy.revision + 1 };
  state = reduce(state, { type: "edit", field: "policy", value: policy, provenance: manual });
  state = reduce(state, {
    type: "edit",
    field: "searchConstraints",
    value: sampleScenario.searchConstraints,
    provenance: manual,
  });
  state = reduce(state, { type: "edit", field: "modeId", value: "test-mode", provenance: manual });
  state = reduce(state, { type: "request-defaults" });
  const defaults = observedDefaults();
  state = reduce(state, {
    type: "receive-defaults",
    request: state.pendingDefaults!,
    value: defaults,
  });
  const draft = scenarioDraft(state);
  expect(draft.policy).toEqual(policy);
  expect(draft.searchConstraints).toEqual(sampleScenario.searchConstraints);
  expect(draft.entities[0]!.inventory).toEqual(sampleScenario.entities[0]!.inventory);
  expect(draft.modeId).toBe("test-mode");
  expect(draft.objective).toEqual(defaults.objective);
  expect(draft.inputProvenance.policy.kind).toBe("manual");
  expect(draft.inputProvenance.objective).toEqual(defaults.inputProvenance.objective);
  expect(inspectScenarioDraft(state).status).toBe("contract-valid");
});

test("an edit after request invalidates the entire late response, including otherwise untouched fields", () => {
  let state = reduce(createScenarioEditor(sampleScenario), { type: "request-defaults" });
  const request = state.pendingDefaults!;
  state = reduce(state, { type: "edit", field: "modeId", value: "edited", provenance: manual });
  expect(reduce(state, { type: "receive-defaults", request, value: observedDefaults() })).toBe(
    state,
  );
  expect(scenarioDraft(state).objective).toEqual(sampleScenario.objective);
  expect(reduce(state, { type: "defaults-failed", request, message: "old failure" })).toBe(state);
});

test("new request supersedes old request even without an intervening edit", () => {
  let state = reduce(createScenarioEditor(sampleScenario), { type: "request-defaults" });
  const old = state.pendingDefaults!;
  state = reduce(state, { type: "request-defaults" });
  const current = state.pendingDefaults!;
  expect(current.requestId).not.toBe(old.requestId);
  expect(reduce(state, { type: "receive-defaults", request: old, value: observedDefaults() })).toBe(
    state,
  );
  expect(
    reduce(state, {
      type: "receive-defaults",
      request: { ...current, revision: 999 },
      value: observedDefaults(),
    }),
  ).toBe(state);
  state = reduce(state, { type: "receive-defaults", request: current, value: observedDefaults() });
  expect(scenarioDraft(state).objective).toEqual(observedDefaults().objective);
  expect(reduce(state, { type: "receive-defaults", request: current, value: sampleScenario })).toBe(
    state,
  );
});

test("invalid manual references remain visible drafts and cannot produce a contract-valid selection", () => {
  let state = createScenarioEditor(sampleScenario);
  state = reduce(state, {
    type: "edit",
    field: "actorEntityId",
    value: "missing",
    provenance: manual,
  });
  expect(scenarioDraft(state).actorEntityId).toBe("missing");
  const result = inspectScenarioDraft(state);
  expect(result.status).toBe("invalid");
  if (result.status === "invalid")
    expect(result.issues.some((issue) => issue.path === "actorEntityId")).toBe(true);
  state = reduce(state, { type: "request-defaults" });
  state = reduce(state, {
    type: "receive-defaults",
    request: state.pendingDefaults!,
    value: observedDefaults(),
  });
  expect(scenarioDraft(state).actorEntityId).toBe("missing");
  expect(inspectScenarioDraft(state).status).toBe("invalid");
  state = reduce(state, { type: "reset-field", field: "actorEntityId" });
  expect(inspectScenarioDraft(state).status).toBe("contract-valid");
});

test("reset restores the latest default and its provenance only on explicit action", () => {
  let state = reduce(createScenarioEditor(sampleScenario), {
    type: "edit",
    field: "objective",
    value: { ...sampleScenario.objective, horizonMs: 20000 },
    provenance: manual,
  });
  state = reduce(state, {
    type: "edit",
    field: "modeId",
    value: "manual-mode",
    provenance: manual,
  });
  state = reduce(state, { type: "request-defaults" });
  const request = state.pendingDefaults!;
  state = reduce(state, { type: "receive-defaults", request, value: observedDefaults() });
  expect(scenarioDraft(state).objective.horizonMs).toBe(20000);
  state = reduce(state, { type: "reset-field", field: "objective" });
  expect(scenarioDraft(state).objective).toEqual(observedDefaults().objective);
  expect(scenarioDraft(state).inputProvenance.objective.kind).toBe("observed");
  expect(scenarioDraft(state).modeId).toBe("manual-mode");
  state = reduce(state, { type: "request-defaults" });
  const stale = state.pendingDefaults!;
  state = reduce(state, { type: "reset-all" });
  expect(scenarioDraft(state)).toEqual(observedDefaults());
  expect(reduce(state, { type: "receive-defaults", request: stale, value: sampleScenario })).toBe(
    state,
  );
});

test("malformed or wrong-scenario defaults keep existing data and expose actionable errors", () => {
  for (const value of [null, {}, { ...sampleScenario, scenarioId: "different" }]) {
    let state = reduce(createScenarioEditor(sampleScenario), { type: "request-defaults" });
    state = reduce(state, { type: "receive-defaults", request: state.pendingDefaults!, value });
    expect(scenarioDraft(state)).toEqual(sampleScenario);
    expect(state.defaultsIssues.length).toBeGreaterThan(0);
    expect(state.pendingDefaults).toBeNull();
  }
});

test("current fetch failures are visible and a new request clears the error", () => {
  let state = reduce(createScenarioEditor(sampleScenario), { type: "request-defaults" });
  state = reduce(state, {
    type: "defaults-failed",
    request: state.pendingDefaults!,
    message: "No defaults available",
  });
  expect(state.defaultsIssues).toEqual([{ path: "", message: "No defaults available" }]);
  expect(scenarioDraft(state)).toEqual(sampleScenario);
  state = reduce(state, { type: "request-defaults" });
  expect(state.defaultsIssues).toEqual([]);
});

test("provenance cannot label a manual edit as observed, and input/output aliases cannot mutate state", () => {
  const input = structuredClone(sampleScenario);
  let state = createScenarioEditor(input);
  input.entities[0]!.health.current -= 1;
  expect(scenarioDraft(state)).toEqual(sampleScenario);
  expect(() =>
    reduce(state, {
      type: "edit",
      field: "modeId",
      value: "manual",
      provenance: provenance("observed", "forged"),
    }),
  ).toThrow("manual input provenance");
  const objective = { ...sampleScenario.objective };
  state = reduce(state, { type: "edit", field: "objective", value: objective, provenance: manual });
  objective.horizonMs += 1;
  const draft = scenarioDraft(state);
  draft.objective.horizonMs += 2;
  expect(scenarioDraft(state).objective).toEqual(sampleScenario.objective);
  expect(JSON.parse(JSON.stringify(scenarioDraft(state)))).toEqual(scenarioDraft(state));
});

test("draft-only schema failures do not silently repair rank or inventory overrides", () => {
  const entities = structuredClone(sampleScenario.entities);
  entities[0]!.abilities[0]!.rank = 99;
  let state = reduce(createScenarioEditor(sampleScenario), {
    type: "edit",
    field: "entities",
    value: entities,
    provenance: manual,
  });
  expect(inspectScenarioDraft(state).status).toBe("invalid");
  state = reduce(state, { type: "request-defaults" });
  state = reduce(state, {
    type: "receive-defaults",
    request: state.pendingDefaults!,
    value: observedDefaults(),
  });
  expect(scenarioDraft(state).entities[0]!.abilities[0]!.rank).toBe(99);
  expect(scenarioDraft(state).entities[0]!.inventory).toEqual(entities[0]!.inventory);
});

test("new defaults can invalidate a preserved policy without replacing that manual draft", () => {
  let state = reduce(createScenarioEditor(sampleScenario), {
    type: "edit",
    field: "policy",
    value: sampleScenario.policy,
    provenance: manual,
  });
  const changed = structuredClone(sampleScenario);
  changed.entities[0]!.abilities = [];
  changed.policy.steps = changed.policy.steps.filter((step) => step.action.kind === "basic-attack");
  const defaults = ScenarioSpecSchema.parse(changed);
  state = reduce(state, { type: "request-defaults" });
  state = reduce(state, {
    type: "receive-defaults",
    request: state.pendingDefaults!,
    value: defaults,
  });
  expect(scenarioDraft(state).policy).toEqual(sampleScenario.policy);
  expect(inspectScenarioDraft(state).status).toBe("invalid");
  state = reduce(state, { type: "reset-field", field: "policy" });
  expect(inspectScenarioDraft(state).status).toBe("contract-valid");
  defaults.entities[0]!.health.current -= 1;
  expect(scenarioDraft(state).entities[0]!.health.current).toBe(
    sampleScenario.entities[0]!.health.current,
  );
});
