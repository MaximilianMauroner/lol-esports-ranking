import type { ReactNode } from "react";
import type { WindowSummary } from "../../domains/dps/compare-view.ts";
import type { SampleComparison } from "../../domains/dps/types.ts";
import type { ComparisonLabels, DraftRow } from "./types.ts";

function windowVerdictText(
  summary: WindowSummary,
  labels: ComparisonLabels,
): { headline: string; detail: string; tone: "a" | "b" | "flat" } {
  if (summary.verdict === "all-killed") {
    return { headline: "Both kill", detail: "use TTK instead", tone: "flat" };
  }
  if (summary.verdict === "no-kills") {
    return { headline: "No kills yet", detail: "every target survives", tone: "flat" };
  }
  if (summary.verdict === "tie") {
    return {
      headline: "Too close to call",
      detail: `${Math.round(summary.aShare * 100)}% / ${Math.round(summary.bShare * 100)}% of targets`,
      tone: "flat",
    };
  }
  const leader = summary.verdict === "a" ? labels.shortA : labels.shortB;
  const share = summary.verdict === "a" ? summary.aShare : summary.bShare;
  const medianFavours = summary.medianDelta > 0 ? "a" : summary.medianDelta < 0 ? "b" : null;
  const magnitude = Math.abs(summary.medianDelta);
  // A median that points the other way is not evidence for the leader, so the
  // tile falls back to the share it actually won.
  const detail =
    magnitude >= 0.05 && medianFavours === summary.verdict
      ? `+${magnitude.toFixed(1)}% median · ${Math.round(share * 100)}% of targets`
      : `${Math.round(share * 100)}% of targets`;
  return { headline: leader, detail, tone: summary.verdict };
}

function narrative(
  current: WindowSummary | undefined,
  comparison: SampleComparison,
  labels: ComparisonLabels,
  drafts: DraftRow[],
  metric: "damage" | "ttk",
): string {
  if (current?.verdict === "all-killed") {
    return `Both builds kill every target inside ${current.duration}s, so applied damage cannot separate them. Time to kill can.`;
  }
  if (current?.verdict === "no-kills") {
    return `Neither build kills a target inside ${current.duration}s, so there is no first-crossing time to compare. Use a longer window, or the damage metric.`;
  }
  const draftRows = drafts.filter((row) => row.key !== "avg" && row.outcome !== "tie");
  const heavyWinner =
    draftRows.length >= 3 && draftRows.every((row) => row.outcome === draftRows[0]!.outcome)
      ? draftRows[0]!.outcome
      : null;
  const heavyLabel = heavyWinner === "a" ? labels.shortA : labels.shortB;
  const heavyDelta = Math.abs(draftRows[0]?.delta ?? 0).toFixed(1);
  const leader =
    current?.verdict === "a" ? labels.shortA : current?.verdict === "b" ? labels.shortB : null;
  const metricWord = metric === "ttk" ? "first-kill time" : "damage";
  if (heavyWinner && leader && heavyLabel !== leader) {
    return `${heavyLabel} wins every heavy draft by ${heavyDelta}%, while ${leader} leads overall because it takes the squishier half of the cohort.`;
  }
  if (heavyWinner && !leader) {
    return `The cohort is split, but ${heavyLabel} wins every heavy draft by ${heavyDelta}%.`;
  }
  if (leader) {
    return `${leader} leads on ${Math.round((current!.verdict === "a" ? current!.aShare : current!.bShare) * 100)}% of weighted targets, with a median ${Math.abs(comparison.medianRelativeDelta).toFixed(1)}% more ${metricWord}.`;
  }
  return `Neither item leads: ${comparison.ties} of ${comparison.count} targets tie at this fight length.`;
}

export function VerdictBand({
  labels,
  level,
  metric,
  duration,
  windows,
  comparison,
  drafts,
  datasetLabel,
  recomputing,
  onDuration,
  onSwitchToTtk,
  children,
}: {
  labels: ComparisonLabels;
  level: number;
  metric: "damage" | "ttk";
  duration: number;
  windows: WindowSummary[];
  comparison: SampleComparison;
  drafts: DraftRow[];
  datasetLabel: string;
  recomputing: boolean;
  onDuration: (seconds: number) => void;
  onSwitchToTtk: () => void;
  children: ReactNode;
}) {
  const current = windows.find((summary) => summary.duration === duration);
  const aShare = current?.aShare ?? 0;
  const bShare = current?.bShare ?? 0;
  const saturated = current?.verdict === "all-killed";
  return (
    <section className="card band" aria-live="polite">
      <div>
        <p className="context">
          {labels.singleItem ? "Item under test" : "Build comparison"} · level {level} ·{" "}
          {metric === "ttk" ? "time to kill" : "damage"} · {datasetLabel}
          {recomputing && <span className="recomputing">recomputing…</span>}
        </p>
        <h1 className="question">
          <span className="side-a">{labels.a}</span> <span className="vs">vs</span>{" "}
          <span className="side-b">{labels.b}</span>
        </h1>
        <div className="tiles" role="group" aria-label="Fight length">
          {windows.map((summary) => {
            const text = windowVerdictText(summary, labels);
            const selected = summary.duration === duration;
            return (
              <button
                key={summary.duration}
                className={`tile ${selected ? "on" : ""}`}
                aria-pressed={selected}
                onClick={() => onDuration(summary.duration)}
              >
                <em>{summary.duration} seconds</em>
                <b className={`tone-${text.tone}`}>{text.headline}</b>
                <i>{text.detail}</i>
              </button>
            );
          })}
        </div>
        <div className="share">
          <div
            className={`winbar ${aShare + bShare === 0 ? "winbar-flat" : ""}`}
            role="img"
            aria-label={`${labels.shortA} leads ${Math.round(aShare * 100)} percent of decided targets`}
          >
            <i style={{ width: `${aShare * 100}%` }} />
          </div>
          <div className="share-labels">
            <span>
              <strong>{Math.round(aShare * 100)}%</strong> {labels.shortA} · {comparison.aWins} rows
            </span>
            <span>
              {comparison.ties} ties · {comparison.censored} censored
            </span>
            <span>
              {labels.shortB} <strong>{Math.round(bShare * 100)}%</strong> · {comparison.bWins} rows
            </span>
          </div>
        </div>
        <div className="callout">
          <b>Read</b>
          <span>{narrative(current, comparison, labels, drafts, metric)}</span>
          {saturated && metric === "damage" && (
            <button className="callout-action" onClick={onSwitchToTtk}>
              Switch to TTK
            </button>
          )}
        </div>
      </div>
      <div>{children}</div>
    </section>
  );
}

export function IdenticalBuildsBand({
  itemName,
  damage,
  dps,
  ttk,
  suggestions,
  onResetDefault,
}: {
  itemName: string;
  damage: number | null;
  dps: number | null;
  ttk: number | null;
  suggestions: Array<{ id: string; label: string; detail: string; apply: () => void }>;
  onResetDefault: () => void;
}) {
  return (
    <section className="card band band-flat" aria-live="polite">
      <div>
        <h1 className="question">Both builds are identical</h1>
        <p className="lede">
          Every target ties by construction, so no winner, no delta and no draft slices are shown.
          Change one item under test to ask a comparative question.
        </p>
        <div className="actions">
          <button className="primary" onClick={onResetDefault}>
            Reset to the observed default comparison
          </button>
        </div>
        {damage !== null && (
          <p className="note">
            The single build still simulates: {Math.round(damage).toLocaleString()} damage,{" "}
            {Math.round(dps ?? 0).toLocaleString()} DPS, TTK {ttk === null ? "censored" : `${ttk}s`}
            . Current inventory holds {itemName}.
          </p>
        )}
      </div>
      <div>
        {suggestions.length > 0 && (
          <>
            <p className="context">Try another item under test</p>
            <div className="suggestions">
              {suggestions.map((suggestion) => (
                <button key={suggestion.id} onClick={suggestion.apply}>
                  <strong>{suggestion.label}</strong>
                  <span>{suggestion.detail}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
