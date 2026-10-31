import { itemLabel, slotEditorModel } from "../../domains/dps/compare-view.ts";
import { buildGoldTotal } from "../../domains/dps/items.ts";
import type { SimulationResult } from "../../domains/dps/types.ts";
import type { ComparisonLabels } from "./types.ts";

const ICON_BASE = "https://ddragon.leagueoflegends.com/cdn/16.18.1/img/item/";

function itemIconUrl(id: number): string {
  return `${ICON_BASE}${id}.png`;
}

function ItemSelect({
  id,
  label,
  value,
  options,
  disabledIds,
  onChange,
  onRemove,
}: {
  id: string;
  label: string;
  value: number | 0;
  options: number[];
  disabledIds: Set<number>;
  onChange: (value: number | null) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="slot">
      {value > 0 ? (
        <img src={itemIconUrl(value)} alt="" width={26} height={26} />
      ) : (
        <span className="slot-empty" aria-hidden>
          ?
        </span>
      )}
      <select
        id={id}
        aria-label={label}
        value={value > 0 ? value : ""}
        onChange={(event) =>
          onChange(event.target.value === "" ? null : Number(event.target.value))
        }
      >
        <option value="">Choose an item…</option>
        {options.map((candidate) => (
          <option key={candidate} value={candidate} disabled={disabledIds.has(candidate)}>
            {itemLabel(candidate)}
          </option>
        ))}
      </select>
      {onRemove && (
        <button
          type="button"
          className="slot-remove"
          aria-label={`Remove ${label}`}
          onClick={onRemove}
        >
          ×
        </button>
      )}
    </div>
  );
}

interface DiffRow {
  key: string;
  label: string;
  a: number | null;
  b: number | null;
  format: (value: number) => string;
  lowerWins?: boolean;
  emphasis?: boolean;
  neutral?: boolean;
}

function diffRows(
  duration: number,
  a: SimulationResult | undefined,
  b: SimulationResult | undefined,
  costA: number,
  costB: number,
): DiffRow[] {
  const number = (value: number) => Math.round(value).toLocaleString();
  const oneDecimal = (value: number) => value.toFixed(1);
  const sources = [...new Set([...Object.keys(a?.sources ?? {}), ...Object.keys(b?.sources ?? {})])]
    .map((source) => ({
      source,
      weight: Math.max(Number(a?.sources[source] ?? 0), Number(b?.sources[source] ?? 0)),
    }))
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 6);
  return [
    {
      key: "damage",
      label: `Damage in ${duration}s`,
      a: a?.totalDamage ?? null,
      b: b?.totalDamage ?? null,
      format: number,
      emphasis: true,
    },
    { key: "dps", label: "DPS", a: a?.dps ?? null, b: b?.dps ?? null, format: number },
    {
      key: "ttk",
      label: "Time to kill",
      a: a?.ttk ?? null,
      b: b?.ttk ?? null,
      format: (value) => `${value}s`,
      lowerWins: true,
    },
    {
      key: "physical",
      label: "Physical share",
      a: a && a.totalDamage > 0 ? (a.split.physical / a.totalDamage) * 100 : null,
      b: b && b.totalDamage > 0 ? (b.split.physical / b.totalDamage) * 100 : null,
      format: (value) => `${Math.round(value)}%`,
      // A damage-type split describes the build; neither share is a win.
      neutral: true,
    },
    ...sources.map(({ source }) => ({
      key: `source-${source}`,
      label: source,
      a: a ? Number(a.sources[source] ?? 0) : null,
      b: b ? Number(b.sources[source] ?? 0) : null,
      format: oneDecimal,
    })),
    {
      key: "cost",
      label: "Cost",
      a: costA,
      b: costB,
      format: (value) => `${value.toLocaleString()}g`,
      lowerWins: true,
    },
  ];
}

function leadSide(row: DiffRow): "a" | "b" | null {
  if (row.neutral || row.a === null || row.b === null || row.a === row.b) return null;
  const aLeads = row.lowerWins ? row.a < row.b : row.a > row.b;
  return aLeads ? "a" : "b";
}

export function HeadToHead({
  labels,
  slotsA,
  slotsB,
  supportedItems,
  duration,
  resultA,
  resultB,
  manualNote,
  itemWarnings,
  onSharedChange,
  onSideChange,
  onAddShared,
  onAddSide,
  onResetDefault,
}: {
  labels: ComparisonLabels;
  slotsA: Array<number | 0>;
  slotsB: Array<number | 0>;
  supportedItems: number[];
  duration: number;
  resultA?: SimulationResult;
  resultB?: SimulationResult;
  manualNote: string;
  itemWarnings: string[];
  onSharedChange: (aIndex: number, bIndex: number, value: number | null) => void;
  onSideChange: (side: "a" | "b", index: number, value: number | null) => void;
  onAddShared: () => void;
  onAddSide: (side: "a" | "b") => void;
  onResetDefault: () => void;
}) {
  const model = slotEditorModel(slotsA, slotsB);
  const usedA = new Set(slotsA.filter((id): id is number => id > 0));
  const usedB = new Set(slotsB.filter((id): id is number => id > 0));
  const costA = buildGoldTotal(slotsA.filter((id): id is number => id > 0));
  const costB = buildGoldTotal(slotsB.filter((id): id is number => id > 0));
  const rows = diffRows(duration, resultA, resultB, costA, costB);
  const sharedCost = buildGoldTotal(model.shared.map((slot) => slot.id));

  return (
    <section className="card" aria-labelledby="h2h">
      <h2 id="h2h">Head to head</h2>
      <p className="sub">Pick the items under test; the rest of the build stays shared.</p>

      <div className="under-test">
        <div>
          <span className="fl">Only in A</span>
          {model.onlyA.map((slot, position) => (
            <ItemSelect
              key={`a-${slot.index}`}
              id={`only-a-${slot.index}`}
              label={`Build A item ${position + 1}`}
              value={slot.id}
              options={supportedItems}
              disabledIds={new Set([...usedA].filter((id) => id !== slot.id))}
              onChange={(value) => onSideChange("a", slot.index, value)}
              onRemove={
                model.onlyA.length + model.shared.length > 1
                  ? () => onSideChange("a", slot.index, null)
                  : undefined
              }
            />
          ))}
          <button type="button" className="ghost" onClick={() => onAddSide("a")}>
            + item only in A
          </button>
        </div>
        <div>
          <span className="fl">Only in B</span>
          {model.onlyB.map((slot, position) => (
            <ItemSelect
              key={`b-${slot.index}`}
              id={`only-b-${slot.index}`}
              label={`Build B item ${position + 1}`}
              value={slot.id}
              options={supportedItems}
              disabledIds={new Set([...usedB].filter((id) => id !== slot.id))}
              onChange={(value) => onSideChange("b", slot.index, value)}
              onRemove={
                model.onlyB.length + model.shared.length > 1
                  ? () => onSideChange("b", slot.index, null)
                  : undefined
              }
            />
          ))}
          <button type="button" className="ghost" onClick={() => onAddSide("b")}>
            + item only in B
          </button>
        </div>
      </div>

      <details className="fold shared-fold">
        <summary>
          <span className="shared-icons" aria-hidden>
            {model.shared.slice(0, 5).map((slot) => (
              <img
                key={slot.id}
                src={itemIconUrl(slot.id)}
                alt=""
                width={22}
                height={22}
              />
            ))}
          </span>
          Shared core · {model.shared.length} item{model.shared.length === 1 ? "" : "s"} ·{" "}
          {sharedCost.toLocaleString()}g
        </summary>
        <div className="fold-body">
          <div className="shared-slots">
            {model.shared.map((slot, position) => (
              <ItemSelect
                key={`shared-${slot.aIndex}`}
                id={`shared-${slot.aIndex}`}
                label={`Shared item ${position + 1}`}
                value={slot.id}
                options={supportedItems}
                disabledIds={new Set([...usedA, ...usedB].filter((id) => id !== slot.id))}
                onChange={(value) => onSharedChange(slot.aIndex, slot.bIndex, value)}
                onRemove={() => onSharedChange(slot.aIndex, slot.bIndex, null)}
              />
            ))}
            <button type="button" className="ghost" onClick={onAddShared}>
              + shared item
            </button>
          </div>
          <p className="note">Shared edits apply to both builds. {manualNote}</p>
          <button type="button" className="ghost" onClick={onResetDefault}>
            Reset to the observed level default
          </button>
        </div>
      </details>

      {itemWarnings.length > 0 && (
        <div className="build-warnings" role="note">
          {itemWarnings.map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
        </div>
      )}

      <table className="diff">
        <thead>
          <tr>
            <th scope="col">Measure</th>
            <th scope="col" className="num">
              {labels.shortA}
            </th>
            <th scope="col" className="num">
              {labels.shortB}
            </th>
            <th scope="col" className="num">
              Δ
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const lead = leadSide(row);
            const delta = row.a !== null && row.b !== null ? row.a - row.b : null;
            return (
              <tr key={row.key} className={row.emphasis ? "emphasis" : undefined}>
                <th scope="row">{row.label}</th>
                <td className={`num ${lead === "a" ? "lead" : ""}`}>
                  {row.a === null ? "censored" : row.format(row.a)}
                </td>
                <td className={`num ${lead === "b" ? "lead" : ""}`}>
                  {row.b === null ? "censored" : row.format(row.b)}
                </td>
                <td className="num delta-cell">
                  {delta === null
                    ? "—"
                    : Math.abs(delta) < 0.05
                      ? "±0"
                      : `${delta > 0 ? "+" : "−"}${row.format(Math.abs(delta))}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="note">
        One observed target, the same opener for both builds. Δ is {labels.shortA} minus{" "}
        {labels.shortB}. Cohort-wide results are in the verdict above.
      </p>
    </section>
  );
}
