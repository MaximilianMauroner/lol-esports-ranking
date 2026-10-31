import { useId } from "react";
import type { Provenance, SearchConstraints } from "../../../domains/dps/contracts/index.ts";
import { scenarioDraft } from "../state/scenario-editor.ts";
import {
  budgetAmountError,
  budgetAmountText,
  inspectSearchSettings,
  type SearchSettingsAction,
  type SearchSettingsState,
} from "./search-settings-state.ts";
import styles from "./search-settings.module.css";

const budgetLabels: Record<SearchConstraints["budget"]["kind"], string> = {
  "incremental-gold": "Additional gold",
  "total-final-inventory": "Total final inventory value",
};
const bootLabels: Record<SearchConstraints["bootRule"], string> = {
  required: "Required",
  optional: "Optional",
  forbidden: "Forbidden",
};

function ProvenanceDetails({ value }: { value: Provenance }) {
  return (
    <dl className={styles.provenance}>
      <dt>Kind</dt>
      <dd>{value.kind}</dd>
      <dt>Source</dt>
      <dd>{value.sourceId}</dd>
      <dt>Location</dt>
      <dd>{value.locator}</dd>
      <dt>Source hash</dt>
      <dd>{value.sourceHash ?? "Not provided"}</dd>
      <dt>Captured at</dt>
      <dd>{value.capturedAt ?? "Not recorded"}</dd>
      <dt>Note</dt>
      <dd>{value.note}</dd>
    </dl>
  );
}

/** Fully controlled. The owner stores state and dispatches through searchSettingsReducer. */
export function SearchSettingsPanel({
  state,
  onAction,
}: {
  state: SearchSettingsState | null;
  onAction: (action: SearchSettingsAction) => void;
}) {
  const id = useId();
  if (!state) {
    return (
      <section className={styles.panel} aria-labelledby={`${id}-heading`}>
        <h2 id={`${id}-heading`}>Search settings</h2>
        <p role="status">No scenario defaults available.</p>
      </section>
    );
  }
  const draft = scenarioDraft(state.scenario);
  const constraints = draft.searchConstraints;
  const defaults = state.scenario.defaults.searchConstraints;
  const provenance = draft.inputProvenance.searchConstraints;
  const amountError = budgetAmountError(state);
  const inspected = inspectSearchSettings(state);
  const issues =
    inspected.status === "invalid"
      ? inspected.issues.filter(
          (issue) =>
            issue.path.startsWith("searchConstraints") &&
            !(amountError && issue.path === "searchConstraints.budget.amount"),
        )
      : [];
  return (
    <section className={styles.panel} aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>Search settings</h2>
      <p className={styles.note}>
        Group provenance: <strong>{provenance.kind}</strong>. This source applies to the whole
        search settings group, including values retained from defaults.
      </p>
      <div className={styles.controls}>
        <div className={styles.field}>
          <label htmlFor={`${id}-kind`}>Budget meaning</label>
          <select
            id={`${id}-kind`}
            value={constraints.budget.kind}
            aria-describedby={`${id}-budget-help`}
            onChange={(event) =>
              onAction({
                type: "edit-budget-kind",
                value: event.target.value as SearchConstraints["budget"]["kind"],
              })
            }
          >
            {Object.entries(budgetLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor={`${id}-amount`}>Budget amount (gold)</label>
          <input
            id={`${id}-amount`}
            type="text"
            inputMode="numeric"
            required
            value={budgetAmountText(state)}
            aria-invalid={amountError ? true : undefined}
            aria-describedby={`${id}-budget-help${amountError ? ` ${id}-amount-error` : ""}`}
            onChange={(event) => onAction({ type: "edit-budget-amount", text: event.target.value })}
          />
          {amountError && (
            <p id={`${id}-amount-error`} className={styles.error} role="alert">
              {amountError}
            </p>
          )}
        </div>
        <div className={styles.field}>
          <label htmlFor={`${id}-slots`}>Inventory slot count</label>
          <select
            id={`${id}-slots`}
            value={constraints.slotCount}
            onChange={(event) =>
              onAction({ type: "edit-slot-count", value: Number(event.target.value) })
            }
          >
            {[1, 2, 3, 4, 5, 6].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor={`${id}-boots`}>Boot rule</label>
          <select
            id={`${id}-boots`}
            value={constraints.bootRule}
            onChange={(event) =>
              onAction({
                type: "edit-boot-rule",
                value: event.target.value as SearchConstraints["bootRule"],
              })
            }
          >
            {Object.entries(bootLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p id={`${id}-budget-help`} className={styles.note}>
        {constraints.budget.kind === "incremental-gold"
          ? "Additional gold available to spend beyond the current inventory."
          : "Maximum total value of the final inventory, including items already owned."}{" "}
        Enter a nonnegative whole number. Changing the budget meaning keeps the amount.
      </p>
      {issues.length > 0 && (
        <ul className={styles.error} role="alert">
          {issues.map((issue, index) => (
            <li key={`${issue.path}-${index}`}>{issue.message}</li>
          ))}
        </ul>
      )}
      <details>
        <summary>Current group source</summary>
        <ProvenanceDetails value={provenance} />
      </details>
      <details>
        <summary>Default search settings</summary>
        <dl className={styles.provenance}>
          <dt>Budget meaning</dt>
          <dd>{budgetLabels[defaults.budget.kind]}</dd>
          <dt>Budget amount</dt>
          <dd>{defaults.budget.amount} gold</dd>
          <dt>Inventory slot count</dt>
          <dd>{defaults.slotCount}</dd>
          <dt>Boot rule</dt>
          <dd>{bootLabels[defaults.bootRule]}</dd>
          <dt>Required item IDs</dt>
          <dd>{defaults.requiredItemIds.join(", ") || "None"}</dd>
          <dt>Excluded item IDs</dt>
          <dd>{defaults.excludedItemIds.join(", ") || "None"}</dd>
          <dt>Candidate limit</dt>
          <dd>{defaults.candidateLimit}</dd>
          <dt>Pruning</dt>
          <dd>{defaults.pruning}</dd>
        </dl>
        <p>Default group provenance</p>
        <ProvenanceDetails value={state.scenario.defaults.inputProvenance.searchConstraints} />
      </details>
      <p className={styles.note}>
        Reset restores the entire search settings group, including required and excluded item IDs,
        candidate limit and pruning.
      </p>
      <button type="button" onClick={() => onAction({ type: "reset-searchConstraints" })}>
        Reset search settings to defaults
      </button>
    </section>
  );
}
