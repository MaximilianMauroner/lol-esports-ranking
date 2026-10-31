import { itemLabel, traceCycles } from "../../domains/dps/compare-view.ts";
import type { ProgressionApiResponse } from "../../domains/dps/datasets.ts";
import type { ProgressionRarity } from "../../domains/dps/progression.ts";
import type { SimulationResult, Target } from "../../domains/dps/types.ts";
import type { ComparisonLabels, LabDataset } from "./types.ts";

const COMPARISON_RULES = [
  "Builds are compared at their listed cost, not at equal gold.",
  "Expected-crit TTK is a first-crossing time, not a kill probability.",
];

function CycleTable({ result, label }: { result: SimulationResult; label: string }) {
  const { sources, cycles, applied } = traceCycles(result.events);
  if (cycles.length === 0) return <p className="note">No damage events in this window.</p>;
  return (
    <table className="diff trace">
      <caption className="sr-only">{label} damage per attack cycle</caption>
      <thead>
        <tr>
          <th scope="col">Cycle</th>
          {sources.map((source) => (
            <th scope="col" key={source} className="num">
              {source}
            </th>
          ))}
          <th scope="col" className="num">
            Cycle total
          </th>
          <th scope="col" className="num">
            Running
          </th>
        </tr>
      </thead>
      <tbody>
        {cycles.map((cycle) => (
          <tr key={cycle.time}>
            <th scope="row">{cycle.label}</th>
            {sources.map((source) => (
              <td key={source} className="num">
                {cycle.perSource[source] === undefined ? "—" : cycle.perSource[source]!.toFixed(1)}
              </td>
            ))}
            <td className="num emphasis-cell">{cycle.total.toFixed(1)}</td>
            <td className="num">{Math.round(cycle.running).toLocaleString()}</td>
          </tr>
        ))}
        <tr className="total-row">
          <th scope="row">Applied</th>
          <td className="num" colSpan={sources.length}>
            {result.killed ? `Target dies at ${result.ttk}s` : "Target survives the window"}
          </td>
          <td className="num emphasis-cell">{Math.round(applied).toLocaleString()}</td>
          <td className="num">overkill {Math.round(result.overkill).toLocaleString()}</td>
        </tr>
      </tbody>
    </table>
  );
}

export function TraceFold({
  labels,
  dataset,
  selectedTargetId,
  resultA,
  resultB,
  compared,
  onSelectTarget,
  onToggleCompared,
}: {
  labels: ComparisonLabels;
  dataset: LabDataset | null;
  selectedTargetId: string;
  resultA?: SimulationResult;
  resultB?: SimulationResult;
  compared: boolean;
  onSelectTarget: (id: string) => void;
  onToggleCompared: () => void;
}) {
  const targets: Target[] = dataset?.targets ?? [];
  const selected = targets.find((target) => target.id === selectedTargetId) ?? targets[0];
  const summary = resultA
    ? resultA.killed
      ? `killed at ${resultA.ttk}s`
      : "not killed in the window"
    : "waiting for a run";
  return (
    <details className="fold">
      <summary>
        Damage trace
        {selected
          ? ` · ${selected.champion} · ${Math.round(selected.health)} HP / ${Math.round(selected.armor)} armor`
          : ""}{" "}
        · {summary}
      </summary>
      <div className="fold-body">
        <label className="fl" htmlFor="target-sel">
          Selected target
        </label>
        <select
          id="target-sel"
          value={selectedTargetId}
          onChange={(event) => onSelectTarget(event.target.value)}
        >
          {targets.map((target) => (
            <option value={target.id} key={target.id}>
              {target.champion} · {target.role ?? "unknown role"} · {Math.round(target.health)} HP /{" "}
              {Math.round(target.armor)} armor
            </option>
          ))}
        </select>
        {resultA ? (
          <>
            <p className="trace-title">{labels.a}</p>
            <CycleTable result={resultA} label={labels.a} />
          </>
        ) : (
          <p className="note">Waiting for a run…</p>
        )}
        <button type="button" className="ghost" onClick={onToggleCompared} aria-expanded={compared}>
          {compared ? `Hide ${labels.shortB} trace` : `Show ${labels.shortB} trace`}
        </button>
        {compared && resultB && (
          <>
            <p className="trace-title">{labels.b}</p>
            <CycleTable result={resultB} label={labels.b} />
          </>
        )}
        <p className="note">
          One cycle per damage instant; on-hit sources repeat every attack. Values are damage after
          mitigation, capped at the target&apos;s remaining health.
        </p>
        {dataset && (
          <div className="prov">
            <span className={dataset.provenance === "riot" ? "badge b-riot" : "badge b-demo"}>
              {dataset.provenance === "riot" ? "Riot snapshots" : "Fixture / demo"}
            </span>
            <span>{dataset.note}</span>
          </div>
        )}
        {dataset && (
          <p className="note">
            {dataset.distinctMatchCount} distinct matches · {dataset.snapshotCount} snapshots ·{" "}
            {dataset.uniqueChampions.length} champions
          </p>
        )}
      </div>
    </details>
  );
}

export function EvidenceFold({
  progression,
  level,
  loading,
  error,
  excludedNames,
  rarity,
}: {
  progression: ProgressionApiResponse | null;
  level: number;
  loading: boolean;
  error: string;
  excludedNames: string[];
  rarity: (ProgressionRarity & { lowSample: boolean; sampleCount: number }) | null;
}) {
  const selection = progression?.selection;
  return (
    <details className="fold">
      <summary>
        Evidence · observed Yunara inventory at level {level}
        {progression ? ` · ${progression.exactLevel.distinctMatchCount} matches` : ""}
      </summary>
      <div className="fold-body">
        {loading && <p className="note">Loading observed inventory states…</p>}
        {error && <p className="warn">{error} Using the last known state.</p>}
        {progression && selection && (
          <>
            <div className="kpis">
              <span>
                <strong>{progression.exactLevel.sampleCount}</strong> observations
              </span>
              <span>
                <strong>{progression.exactLevel.distinctMatchCount}</strong> distinct matches
              </span>
              <span>
                Mode <strong>{selection.modeCompletedLegendary}</strong> completed legendaries
              </span>
              <span>
                Median <strong>{selection.medianCompletedLegendary}</strong>
              </span>
              <span>
                Mean <strong>{selection.meanCompletedLegendary.toFixed(2)}</strong>
              </span>
            </div>
            <div className="evidence-grid">
              <div>
                <h3>Completed legendary count</h3>
                {selection.distribution.map((row) => (
                  <div className="bar-row" key={row.count}>
                    <span>
                      <strong>{row.count}</strong> items
                    </span>
                    <span className="track" aria-hidden>
                      <i className="pos" style={{ left: 0, width: `${row.percent}%` }} />
                    </span>
                    <span className="num">{row.percent}%</span>
                  </div>
                ))}
              </div>
              <div>
                <h3>Common observed core</h3>
                {selection.commonPatterns.slice(0, 3).map((pattern) => (
                  <p key={pattern.itemIds.join(",")}>
                    {pattern.itemNames.join(" + ") || "No completed legendary"} ·{" "}
                    <strong>{pattern.percent}%</strong>
                  </p>
                ))}
                <p className="note">
                  Boots are counted separately:{" "}
                  {selection.commonBootId ? itemLabel(selection.commonBootId) : "none observed"} (
                  {selection.commonBootTier}). Components and wards are not legendaries.
                </p>
              </div>
            </div>
            {excludedNames.length > 0 && (
              <p className="warn">
                The observed default also contained {excludedNames.join(", ")}, which the combat
                engine does not model. It is excluded from both builds rather than simulated as a
                statless item.
              </p>
            )}
            {rarity && (
              <p>
                This inventory holds <strong>{rarity.count}</strong> completed legendaries, ahead of{" "}
                <strong>{Math.max(0, Math.min(100, rarity.progressionPercentile))}%</strong> of
                observed Yunara states at this level ({rarity.tailObservations} of{" "}
                {rarity.sampleCount} had at least {rarity.count}).{" "}
                {rarity.lowSample ? "Low-sample estimate. " : ""}
                Economic progression only; not player skill or win probability.
              </p>
            )}
            <p className="note">
              {selection.fallbackUsed ? selection.fallbackLabel : "Exact level sample used"}.{" "}
              {selection.lowSample ? "Low-sample estimate: fewer than 20 exact observations." : ""}
            </p>
            <p className="note">{progression.dedupeRule}</p>
            <p className="note">
              Skill ranks Q{progression.skill.ranks.q} W{progression.skill.ranks.w} E
              {progression.skill.ranks.e} R{progression.skill.ranks.r} ·{" "}
              {progression.skill.provenance === "timeline"
                ? "archived timeline-derived"
                : "legal fallback"}
              {progression.skill.sampleCount > 0 ? ` · n=${progression.skill.sampleCount}` : ""}.{" "}
              {progression.skill.note}
            </p>
            <p className="note">{progression.note}</p>
          </>
        )}
      </div>
    </details>
  );
}

export function LimitsFold({
  modelWarnings,
  assumptions,
}: {
  modelWarnings: string[];
  assumptions: string;
}) {
  const total = modelWarnings.length + COMPARISON_RULES.length;
  return (
    <details className="fold">
      <summary>Model limits · {total} assumptions this answer depends on</summary>
      <div className="fold-body">
        <div className="evidence-grid">
          <div>
            <h3>Damage model</h3>
            {modelWarnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
            {modelWarnings.length === 0 && <p className="note">Waiting for a run…</p>}
          </div>
          <div>
            <h3>Comparison rules</h3>
            {COMPARISON_RULES.map((rule) => (
              <p key={rule}>{rule}</p>
            ))}
          </div>
        </div>
        {assumptions && <p className="note">{assumptions}</p>}
      </div>
    </details>
  );
}

export { COMPARISON_RULES };
