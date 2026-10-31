import {
  groupSlices,
  sliceRow,
  THIN_SAMPLES,
  type SliceRow,
  type SliceTier,
} from "../../domains/dps/compare-view.ts";
import type { SampleComparison } from "../../domains/dps/types.ts";
import type { ComparisonLabels, DraftRow, LabDataset } from "./types.ts";

const TONE: Record<SliceTier, string> = {
  flips: "b",
  close: "close",
  settled: "a",
  undecided: "flat",
};

function sampleRange(range: { min: number; max: number }): string {
  return range.min === range.max
    ? `${range.min} sample${range.min === 1 ? "" : "s"}`
    : `${range.min} to ${range.max} samples`;
}

function Row({
  row,
  labels,
  onPick,
}: {
  row: SliceRow;
  labels: ComparisonLabels;
  onPick: ((row: SliceRow) => void) | null;
}) {
  const tone = TONE[row.tier];
  const share = Math.round(row.share * 100);
  const width = row.tier === "flips" ? 100 - share : share;
  const leader = row.tier === "flips" ? labels.shortB : labels.shortA;
  const reading =
    row.tier === "undecided"
      ? `${row.label}: every sample ties`
      : `${row.label}: ${leader} takes ${row.tier === "flips" ? 100 - share : share}% of ${row.count} samples`;
  const content = (
    <>
      <span className="slice-name">{row.label}</span>
      <span className={`slice-track ${tone}`} aria-hidden>
        {row.tier !== "undecided" && <i style={{ width: `${width}%` }} />}
      </span>
      <span className={`slice-share ${tone}`}>
        {row.tier === "undecided" ? "tie" : `${share}%`}
      </span>
      <span className="slice-n">
        {row.count}
        {row.count < THIN_SAMPLES ? "*" : ""}
      </span>
    </>
  );
  if (!onPick) {
    return (
      <div className="slice" title={reading}>
        {content}
      </div>
    );
  }
  return (
    <button
      className="slice"
      onClick={() => onPick(row)}
      title={`${reading}. Re-run on this group`}
    >
      {content}
    </button>
  );
}

export function EnemySlices({
  rows,
  labels,
  comparison,
  dataset,
  loading,
  onChampion,
  onRole,
}: {
  rows: DraftRow[];
  labels: ComparisonLabels;
  comparison: SampleComparison | null;
  dataset: LabDataset | null;
  loading: boolean;
  onChampion: (champion: string) => void;
  onRole: (role: string) => void;
}) {
  const summary = dataset?.summary;
  const whole = rows.find((row) => row.key === "avg");
  const stats = rows.filter((row) => row.key !== "avg");
  const toRow = (row: DraftRow): SliceRow =>
    sliceRow(row.key, row.label, {
      count: row.count,
      decided: row.decided,
      buildAWinRate: row.share,
    });
  const roles = groupSlices(
    (comparison?.byRole ?? []).map((group) => sliceRow(group.role, group.role, group)),
  );
  const champions = groupSlices(
    (comparison?.byChampion ?? []).map((group) => sliceRow(group.champion, group.champion, group)),
  );
  // Contested first, then the settled roles by share. Undecided rows carry no
  // share, so they sit at the end rather than leading as if they were the worst case.
  const roleRows = [
    ...roles.contested,
    ...[...roles.settled].sort((left, right) => left.share - right.share),
    ...roles.undecided,
  ];

  return (
    <section className="card slices" aria-labelledby="slices">
      <h2 id="slices">Which enemies change the answer</h2>
      <p className="sub">
        The same comparison, re-run on each group of the enemies in the cohort. {labels.shortA}{" "}
        takes the teal side of every bar.
      </p>

      {whole && (
        <div className="slice-lead">
          <Row row={toRow(whole)} labels={labels} onPick={null} />
        </div>
      )}

      {stats.length > 0 && (
        <>
          <div className="slice-head">
            <h3>Tanky enemies</h3>
            <span>top third of the cohort by that stat</span>
          </div>
          {stats.map((row) => (
            <Row key={row.key} row={toRow(row)} labels={labels} onPick={null} />
          ))}
        </>
      )}
      {stats.length === 0 && (
        <p className="note">
          {loading
            ? "Re-running the tanky groups…"
            : "Needs 6 or more snapshots to group the cohort by enemy stats."}
        </p>
      )}

      <div className="slice-head">
        <h3>Enemy role</h3>
        <span>{roleRows.length ? `${roleRows.length} roles` : "needs 2 samples per role"}</span>
      </div>
      {roleRows.map((row) => (
        <Row key={row.key} row={row} labels={labels} onPick={(picked) => onRole(picked.key)} />
      ))}

      <div className="slice-head">
        <h3>Enemy champion</h3>
        <span>
          {champions.contested.length + champions.settled.length + champions.undecided.length
            ? `${champions.contested.length + champions.settled.length + champions.undecided.length} champions with 2 or more samples`
            : "needs a champion seen twice"}
        </span>
      </div>
      {champions.contested.length > 0 ? (
        <>
          <p className="slice-tier">{labels.shortB} wins these</p>
          {champions.contested
            .filter((row) => row.tier === "flips")
            .map((row) => (
              <Row
                key={row.key}
                row={row}
                labels={labels}
                onPick={(picked) => onChampion(picked.key)}
              />
            ))}
          {champions.contested.some((row) => row.tier === "close") && (
            <p className="slice-tier">{labels.shortA} wins these, but takes under three quarters</p>
          )}
          {champions.contested
            .filter((row) => row.tier === "close")
            .map((row) => (
              <Row
                key={row.key}
                row={row}
                labels={labels}
                onPick={(picked) => onChampion(picked.key)}
              />
            ))}
        </>
      ) : (
        champions.settled.length > 0 && (
          <p className="note">No champion in the cohort argues with the headline.</p>
        )
      )}
      {champions.settled.length > 0 && (
        <p className="slice-tally">
          {labels.shortA} wins every sample against the other{" "}
          <b>{champions.settled.length} champions</b>
          {champions.settledRange && `, ${sampleRange(champions.settledRange)} each`}.
        </p>
      )}
      {champions.settled.length > 0 && (
        <details className="fold slice-fold">
          <summary>Show the other {champions.settled.length}</summary>
          {champions.settled.map((row) => (
            <Row
              key={row.key}
              row={row}
              labels={labels}
              onPick={(picked) => onChampion(picked.key)}
            />
          ))}
        </details>
      )}
      {champions.undecided.length > 0 && (
        <p className="note">
          {champions.undecided.length} champion
          {champions.undecided.length === 1 ? "" : "s"} tie on every sample at this fight length.
        </p>
      )}

      <p className="note">
        Each percentage is {labels.shortA}&apos;s share of that group&apos;s decided samples. A star
        marks fewer than {THIN_SAMPLES} samples, too few to decide a build. Role and champion rows
        re-run the whole lab on that group.
      </p>
      {summary && (
        <p className="note">
          Cohort median: {summary.health?.median ?? "—"} HP · {summary.bonusHealth?.median ?? "—"}{" "}
          bonus HP · {summary.armor?.median ?? "—"} armor · {summary.magicResist?.median ?? "—"} MR
          · minute {summary.minute?.median ?? "—"}.
        </p>
      )}
    </section>
  );
}
