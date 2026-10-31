import type { Provenance, SearchConstraints } from "../../../domains/dps/contracts/index.ts";
import {
  createScenarioEditor,
  inspectScenarioDraft,
  scenarioDraft,
  scenarioEditorReducer,
  type ScenarioEditorAction,
  type ScenarioEditorState,
} from "../state/scenario-editor.ts";

/** Keep this entire state in the controller: raw text is part of the draft. */
export type SearchSettingsState = Readonly<{
  scenario: ScenarioEditorState;
  budgetAmountText: string | null;
}>;

export type SearchSettingsAction =
  | ScenarioEditorAction
  | { type: "edit-budget-amount"; text: string }
  | { type: "edit-budget-kind"; value: SearchConstraints["budget"]["kind"] }
  | { type: "edit-slot-count"; value: number }
  | { type: "edit-boot-rule"; value: SearchConstraints["bootRule"] }
  | { type: "reset-searchConstraints" };

const manualProvenance: Provenance = {
  kind: "manual",
  sourceId: "scenario-search-settings",
  sourceHash: null,
  locator: "scenario.searchConstraints",
  capturedAt: null,
  note: "Search settings group manually edited; individual fields may retain default values.",
};

export function createSearchSettingsState(value: unknown): SearchSettingsState {
  return { scenario: createScenarioEditor(value), budgetAmountText: null };
}

export function budgetAmountText(state: SearchSettingsState): string {
  return (
    state.budgetAmountText ?? String(scenarioDraft(state.scenario).searchConstraints.budget.amount)
  );
}

function parseAmount(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

export function budgetAmountError(state: SearchSettingsState): string | null {
  return parseAmount(budgetAmountText(state)) === null
    ? "Enter a whole number from 0 to 9007199254740991."
    : null;
}

/** All scenario actions go through here so explicit resets also clear raw drafts. */
export function searchSettingsReducer(
  state: SearchSettingsState,
  action: SearchSettingsAction,
): SearchSettingsState {
  if (action.type === "reset-searchConstraints") {
    return {
      scenario: scenarioEditorReducer(state.scenario, {
        type: "reset-field",
        field: "searchConstraints",
      }),
      budgetAmountText: null,
    };
  }

  const constraints = scenarioDraft(state.scenario).searchConstraints;
  let next: SearchConstraints;
  let text = state.budgetAmountText;
  switch (action.type) {
    case "edit-budget-amount": {
      text = action.text;
      // Preserve the last numeric value while the separate raw draft blocks serialization.
      const amount = parseAmount(text) ?? constraints.budget.amount;
      next = { ...constraints, budget: { ...constraints.budget, amount } };
      break;
    }
    case "edit-budget-kind":
      next = { ...constraints, budget: { ...constraints.budget, kind: action.value } };
      break;
    case "edit-slot-count":
      next = { ...constraints, slotCount: action.value };
      break;
    case "edit-boot-rule":
      next = { ...constraints, bootRule: action.value };
      break;
    default: {
      const scenario = scenarioEditorReducer(state.scenario, action);
      if (scenario === state.scenario) return state;
      const replacesGroup =
        action.type === "reset-all" ||
        ((action.type === "reset-field" || action.type === "edit") &&
          action.field === "searchConstraints");
      return { scenario, budgetAmountText: replacesGroup ? null : text };
    }
  }
  return {
    scenario: scenarioEditorReducer(state.scenario, {
      type: "edit",
      field: "searchConstraints",
      value: next,
      provenance: manualProvenance,
    }),
    budgetAmountText: text,
  };
}

/** Use this gate, not the nested reducer's inspection, before consuming a scenario. */
export function inspectSearchSettings(state: SearchSettingsState) {
  const inspected = inspectScenarioDraft(state.scenario);
  const amountError = budgetAmountError(state);
  if (!amountError) return inspected;
  return {
    status: "invalid" as const,
    issues: [
      { path: "searchConstraints.budget.amount", message: amountError },
      ...(inspected.status === "invalid" ? inspected.issues : []),
    ],
  };
}

/** Invalid raw input never serializes as the previous valid amount. */
export function serializeSearchSettings(state: SearchSettingsState) {
  const inspected = inspectSearchSettings(state);
  if (inspected.status === "invalid") return inspected;
  return { status: "contract-valid" as const, json: JSON.stringify(inspected.scenario) };
}
