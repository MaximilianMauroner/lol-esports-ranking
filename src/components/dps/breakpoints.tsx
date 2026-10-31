import { breakpointGrid } from "../../domains/dps/compare-view.ts";
import type { BreakpointPoint, ComparisonLabels } from "./types.ts";

function cellStyle(delta: number, maxAbsDelta: number) {
  const rounded = Math.round(delta);
  if (rounded === 0 || maxAbsDelta === 0) return undefined;
  const weight = 0.14 + 0.46 * Math.min(1, Math.abs(delta) / maxAbsDelta);
  // Side A is teal and side B is ice everywhere in the lab; red stays reserved
  // for warnings, so a build that leads is never coloured like a fault.
  return rounded > 0
    ? { background: `rgba(52, 211, 189, ${weight.toFixed(2)})` }
    : { background: `rgba(161, 228, 249, ${weight.toFixed(2)})` };
}

export function BreakpointHeat({
  points,
  duration,
  labels,
}: {
  points: BreakpointPoint[];
  duration: number;
  labels: ComparisonLabels;
}) {
  if (points.length === 0) {
    return (
      <>
        <p className="context">Where it flips</p>
        <p className="note">Waiting for the grid…</p>
      </>
    );
  }
  const grid = breakpointGrid(points);
  const flat = grid.flatArmorValues;
  if (grid.rows.length === 0) {
    return (
      <>
        <p className="context">Where it flips · applied damage in {duration}s</p>
        <p className="lede">
          Nothing flips at this fight length. Across every armor and bonus-health point in the
          sweep, both builds apply the same damage to the selected target.
        </p>
        <p className="note">
          Armor {flat[0]} to {flat[flat.length - 1]}, bonus health {grid.bonusHealthValues[0]} to{" "}
          {grid.bonusHealthValues[grid.bonusHealthValues.length - 1]}. A shorter window, or the TTK
          metric, separates the builds.
        </p>
      </>
    );
  }
  return (
    <>
      <div className="heat-head">
        <p className="context">Where it flips · applied damage in {duration}s</p>
        <p className="legend">
          <span className="swatch swatch-a" aria-hidden /> {labels.a} ahead
          <span className="swatch swatch-b" aria-hidden /> {labels.b} ahead
        </p>
      </div>
      <div className="heat-scroll">
        <table className="heat">
          <caption className="sr-only">
            Applied damage difference between {labels.a} and {labels.b} by target armor and bonus
            health
          </caption>
          <thead>
            <tr>
              <th scope="col">Armor</th>
              {grid.bonusHealthValues.map((value) => (
                <th scope="col" key={value} className="num">
                  {value === 0 ? "0 bonus HP" : value.toLocaleString()}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {flat.length > 0 && (
              <tr className="flat-row">
                <th scope="row" className="num">
                  {flat[0]} – {flat[flat.length - 1]}
                </th>
                <td colSpan={grid.bonusHealthValues.length}>No difference in applied damage</td>
              </tr>
            )}
            {grid.rows.map((row) => (
              <tr key={row.armor}>
                <th scope="row" className="num">
                  {row.armor}
                </th>
                {row.cells.map((cell) => (
                  <td
                    key={cell.bonusHealth}
                    className="num heat-cell"
                    style={cellStyle(cell.delta, grid.maxAbsDelta)}
                  >
                    {Math.round(cell.delta) === 0
                      ? "0"
                      : `${cell.delta > 0 ? "+" : "−"}${Math.abs(Math.round(cell.delta)).toLocaleString()}`}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">
        Rows are target armor, columns are bonus health, values are damage applied to the selected
        target in {duration}s. Armor is swept against the selected target&apos;s own health pool.
      </p>
    </>
  );
}
