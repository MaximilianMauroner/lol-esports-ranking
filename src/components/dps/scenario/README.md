# Search settings panel

This isolated P23 panel consumes a P01 `ScenarioSpec`. The owner supplies the scenario and stores
the entire `SearchSettingsState`; production catalog loading and inventory legality belong to
the later integration. Test fixture data remains in `tests/`.

```tsx
const [state, dispatch] = useReducer(
  searchSettingsReducer,
  initialScenario,
  createSearchSettingsState,
);

return <SearchSettingsPanel state={state} onAction={dispatch} />;
```

Import the component from `./search-settings-panel` and the reducer, initializer, inspection and
serialization functions from `./search-settings-state`. Use `state={null}` while no defaults
are available; the panel shows an empty state without editable controls.

Route **all scenario actions** through `searchSettingsReducer`, including defaults requests,
responses, manual edits from other panels and resets. It delegates to the existing scenario
reducer and retains that reducer's revision and stale-response protections. Invalid numeric
edits also advance the scenario revision and mark the search settings group as manual.

Use **`inspectSearchSettings(state)` or `serializeSearchSettings(state)`** as the consumption
gate. A `contract-valid` inspection returns the effective scenario; successful serialization
returns its JSON. An `invalid` result returns issues and no serializable scenario. Do not consume
`state.scenario` through `scenarioDraft` or `inspectScenarioDraft` directly: while the raw amount
is invalid, the nested numeric field retains its previous value. Those generic helpers cannot
see the raw amount stored in the wrapper. Contract validity does not certify catalog or
inventory legality.

The raw amount remains exact (including blank text and leading zeros) across other edits and
default refreshes. Correcting it re-enables serialization. Explicit group replacement, group
reset or reset-all clears the raw amount. `reset-searchConstraints` delegates to the existing
`reset-field` action and restores the **entire** latest default group, including required and
excluded item IDs, candidate limit, pruning and group provenance. Ordinary control edits
preserve these fields. Changing the budget meaning retains the amount without converting it.

Provenance is reported for the whole `searchConstraints` group, matching P01. A manual group can
contain unchanged default values; individual controls do not claim independent provenance.
The default disclosure lists every configurable group value and its exact source record.

Run `pnpm exec vitest run --config tools/dps/vitest.config.ts tests/dps/ui/scenario`
for controller and static markup checks. Run `pnpm test:integration` for browser,
narrow viewport, route, and optimizer checks.
