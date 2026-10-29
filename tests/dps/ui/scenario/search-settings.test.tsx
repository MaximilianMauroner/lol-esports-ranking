import { expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchSettingsPanel } from "../../../../src/components/dps/scenario/search-settings-panel.tsx";
import {
  budgetAmountText,
  createSearchSettingsState,
  inspectSearchSettings,
  searchSettingsReducer as reduce,
  serializeSearchSettings,
  type SearchSettingsState,
} from "../../../../src/components/dps/scenario/search-settings-state.ts";
import { scenarioDraft } from "../../../../src/components/dps/state/scenario-editor.ts";
import { ScenarioSpecSchema } from "../../../../src/domains/dps/contracts/index.ts";
import { provenance, sampleScenario } from "../../contracts/fixtures.ts";

const manual = provenance("manual", "other-panel", null);
const initial = () => createSearchSettingsState(sampleScenario);
const draft = (state: SearchSettingsState) => scenarioDraft(state.scenario);
const markup = (state: SearchSettingsState | null) =>
  renderToStaticMarkup(createElement(SearchSettingsPanel, { state, onAction: () => {} }));

function refreshedDefaults() {
  const value = structuredClone(sampleScenario);
  value.searchConstraints = {
    ...value.searchConstraints,
    budget: { kind: "total-final-inventory", amount: 15000 },
    slotCount: 6,
    bootRule: "optional",
    requiredItemIds: [2001],
    excludedItemIds: [2002],
  };
  value.inputProvenance.searchConstraints = provenance("observed", "new-search-defaults");
  return ScenarioSpecSchema.parse(value);
}

function refresh(state: SearchSettingsState) {
  state = reduce(state, { type: "request-defaults" });
  return reduce(state, {
    type: "receive-defaults",
    request: state.scenario.pendingDefaults!,
    value: refreshedDefaults(),
  });
}

test("untouched controls show exact defaults and serialize the P01 scenario", () => {
  const state = initial();
  expect(budgetAmountText(state)).toBe("7600");
  expect(inspectSearchSettings(state)).toEqual({
    status: "contract-valid",
    scenario: sampleScenario,
  });
  const serialized = serializeSearchSettings(state);
  expect(serialized.status).toBe("contract-valid");
  if (serialized.status === "contract-valid") {
    expect(ScenarioSpecSchema.parse(JSON.parse(serialized.json))).toEqual(sampleScenario);
  }
});

test("budget meaning, slots and boots preserve item IDs and all unrelated scenario fields", () => {
  let state = initial();
  state = reduce(state, { type: "edit-budget-kind", value: "total-final-inventory" });
  state = reduce(state, { type: "edit-budget-amount", text: "25000" });
  state = reduce(state, { type: "edit-slot-count", value: 6 });
  state = reduce(state, { type: "edit-boot-rule", value: "forbidden" });
  const scenario = draft(state);
  expect(scenario.searchConstraints).toEqual({
    ...sampleScenario.searchConstraints,
    budget: { kind: "total-final-inventory", amount: 25000 },
    slotCount: 6,
    bootRule: "forbidden",
  });
  expect({
    ...scenario,
    searchConstraints: sampleScenario.searchConstraints,
    inputProvenance: sampleScenario.inputProvenance,
  }).toEqual(sampleScenario);
  expect(scenario.inputProvenance.searchConstraints.kind).toBe("manual");
  expect(scenario.inputProvenance.searchConstraints.note).toContain("group");
  expect(inspectSearchSettings(state).status).toBe("contract-valid");
});

test("blank, whitespace, fractional, negative, exponent, nonnumeric and unsafe input remain visible and block serialization", () => {
  for (const text of [
    "",
    " ",
    "-1",
    "1.5",
    "1e3",
    "Infinity",
    "NaN",
    "12abc",
    "0x10",
    "9007199254740992",
  ]) {
    const state = reduce(initial(), { type: "edit-budget-amount", text });
    expect(budgetAmountText(state)).toBe(text);
    expect(draft(state).searchConstraints.budget.amount).toBe(7600);
    expect(state.scenario.revision).toBe(1);
    expect(inspectSearchSettings(state).status).toBe("invalid");
    const serialized = serializeSearchSettings(state);
    expect(serialized.status).toBe("invalid");
    expect("json" in serialized).toBe(false);
    expect(markup(state)).toContain('aria-invalid="true"');
  }
});

test("zero, leading zeros and safe integer boundary are accepted without reformatting the draft", () => {
  for (const text of ["0", "00025", "9007199254740991"]) {
    let state = reduce(initial(), { type: "edit-budget-amount", text: "-" });
    state = reduce(state, { type: "edit-budget-amount", text });
    expect(budgetAmountText(state)).toBe(text);
    const inspected = inspectSearchSettings(state);
    expect(inspected.status).toBe("contract-valid");
    if (inspected.status === "contract-valid") {
      expect(inspected.scenario.searchConstraints.budget.amount).toBe(Number(text));
    }
  }
});

test("invalid amount survives other controls, unrelated edits and accepted default refresh", () => {
  let state = reduce(initial(), { type: "edit-budget-amount", text: "1.2" });
  state = reduce(state, { type: "edit-budget-kind", value: "total-final-inventory" });
  state = reduce(state, { type: "edit-slot-count", value: 4 });
  state = reduce(state, { type: "edit-boot-rule", value: "optional" });
  state = reduce(state, {
    type: "edit",
    field: "modeId",
    value: "manual-mode",
    provenance: manual,
  });
  state = refresh(state);
  expect(budgetAmountText(state)).toBe("1.2");
  expect(draft(state).modeId).toBe("manual-mode");
  expect(draft(state).searchConstraints.budget.kind).toBe("total-final-inventory");
  expect(draft(state).searchConstraints.requiredItemIds).toEqual([1001]);
  expect(inspectSearchSettings(state).status).toBe("invalid");
  expect(state.scenario.defaults.searchConstraints.budget.amount).toBe(15000);
});

test("editing an invalid amount invalidates an already pending defaults response", () => {
  let state = reduce(initial(), { type: "request-defaults" });
  const request = state.scenario.pendingDefaults!;
  state = reduce(state, { type: "edit-budget-amount", text: "" });
  expect(reduce(state, { type: "receive-defaults", request, value: refreshedDefaults() })).toBe(
    state,
  );
  expect(budgetAmountText(state)).toBe("");
});

test("unmodified group follows refreshed defaults; explicit group reset restores latest group and provenance", () => {
  expect(budgetAmountText(refresh(initial()))).toBe("15000");
  let state = reduce(initial(), { type: "edit-budget-amount", text: "" });
  state = reduce(state, {
    type: "edit",
    field: "modeId",
    value: "manual-mode",
    provenance: manual,
  });
  state = refresh(state);
  state = reduce(state, { type: "reset-searchConstraints" });
  expect(budgetAmountText(state)).toBe("15000");
  expect(draft(state).searchConstraints).toEqual(refreshedDefaults().searchConstraints);
  expect(draft(state).inputProvenance.searchConstraints).toEqual(
    refreshedDefaults().inputProvenance.searchConstraints,
  );
  expect(draft(state).modeId).toBe("manual-mode");
  expect(inspectSearchSettings(state).status).toBe("contract-valid");
});

test("external group replacement and explicit resets clear raw drafts, unrelated reset does not", () => {
  const state = reduce(initial(), { type: "edit-budget-amount", text: "broken" });
  expect(budgetAmountText(reduce(state, { type: "reset-field", field: "modeId" }))).toBe("broken");
  for (const action of [
    { type: "reset-all" } as const,
    { type: "reset-field", field: "searchConstraints" } as const,
    {
      type: "edit",
      field: "searchConstraints",
      value: sampleScenario.searchConstraints,
      provenance: manual,
    } as const,
  ]) {
    expect(budgetAmountText(reduce(state, action))).toBe("7600");
    expect(inspectSearchSettings(reduce(state, action)).status).toBe("contract-valid");
  }
});

test("slot conflicts retain required IDs and fail the shared schema until resolved", () => {
  const value = structuredClone(sampleScenario);
  value.searchConstraints.requiredItemIds = [1001, 2001];
  let state = reduce(createSearchSettingsState(value), { type: "edit-slot-count", value: 1 });
  expect(draft(state).searchConstraints.requiredItemIds).toEqual([1001, 2001]);
  expect(inspectSearchSettings(state).status).toBe("invalid");
  expect(markup(state)).toContain("required items cannot exceed the slot count");
  state = reduce(state, { type: "edit-slot-count", value: 2 });
  expect(inspectSearchSettings(state).status).toBe("contract-valid");
});

test("serialization also respects unrelated invalid scenario drafts", () => {
  const state = reduce(initial(), {
    type: "edit",
    field: "actorEntityId",
    value: "missing",
    provenance: manual,
  });
  expect(serializeSearchSettings(state).status).toBe("invalid");
});

test("markup uses native labeled controls, accessible errors, exact default source and honest group reset", () => {
  const html = markup(reduce(initial(), { type: "edit-budget-amount", text: "-2" }));
  const input = html.match(/<input[^>]+>/)![0];
  const id = input.match(/id="([^"]+)"/)![1];
  expect(html).toContain(`<label for="${id}">Budget amount (gold)</label>`);
  expect(input).toContain('value="-2"');
  expect(input).toContain('inputMode="numeric"');
  expect(input).toContain('aria-invalid="true"');
  expect(input).toContain('aria-describedby="');
  expect(html).toContain('role="alert"');
  expect(html).toContain("Group provenance: <strong>manual</strong>");
  expect(html).toContain("Default group provenance");
  expect(html).toContain("p01-contract-fixtures");
  expect(html).toContain("7600");
  expect(html).toContain("including required and excluded item IDs");
  expect(html).toContain('type="button"');
  expect((html.match(/<select /g) ?? []).length).toBe(3);
  for (const select of html.matchAll(/<select id="([^"]+)"/g)) {
    expect(html).toContain(`<label for="${select[1]}">`);
  }
});

test("empty defaults render an explicit empty state and no editable controls", () => {
  const html = markup(null);
  expect(html).toContain("No scenario defaults available.");
  expect(html).toContain('role="status"');
  expect(html).not.toContain("<input");
  expect(html).not.toContain("<select");
  expect(html).not.toContain("<button");
});
