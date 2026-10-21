# Handoff: region yearly timeline and shared chart hover

Date: 2026-10-21. Branch: `feat/region-yearly-timeline`, based on `4763ff6b` (main, #175).

## Status

- No product code changed. Only this handoff is committed.
- Feature playbook step 1 (`how`) is done: three explorers on `codex/gpt-6.1-sol` (low) returned. The explainer synthesis did not run.
- Steps 2 to 8 (architect, implementation, verification, interrogate review, PR) did not start.
- `pnpm install --frozen-lockfile` was interrupted. The host then restarted. `node_modules` is empty. `public/data` is not pulled.
- Warning: this file is under the ignored `.agents/artifacts/`. It was force-added on request. `node tools/dev/check-layout.mjs` (part of `pnpm verify`) rejects tracked files that match `.gitignore`. Remove this file from Git before a PR.

## Toolchain setup (Node 24, pnpm 11.16.0)

Repo pins and global defaults are unchanged. Global Node is v22.22.1 at `/usr/bin/node`.

```sh
mkdir -p ~/.cache/t3-node24 && cd ~/.cache/t3-node24
curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o SHASUMS256.txt
curl -fsSL https://nodejs.org/dist/latest-v24.x/node-v24.22.1-linux-x64.tar.xz -o node-v24.22.1-linux-x64.tar.xz
grep 'node-v24.22.1-linux-x64.tar.xz' SHASUMS256.txt | sha256sum -c -
tar -xJf node-v24.22.1-linux-x64.tar.xz
cat > ~/.cache/t3-node24/env.sh <<'EOF'
export COREPACK_HOME="$HOME/.cache/t3-node24/corepack"
export PATH="$HOME/.cache/t3-node24/shims:$HOME/.cache/t3-node24/node-v24.22.1-linux-x64/bin:$PATH"
EOF
source ~/.cache/t3-node24/env.sh
mkdir -p ~/.cache/t3-node24/shims
corepack enable --install-directory ~/.cache/t3-node24/shims pnpm
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm --version   # 11.16.0
```

The toolchain survived the restart. Before each command, run `source ~/.cache/t3-node24/env.sh`. Run every heavy command as `flock /tmp/t3-top5-heavy.lock <command>`. The lock file does not exist after the restart. `flock` makes it again.

## Chart inventory

Only `src/components/LineChart.tsx` and `src/components/ui/chart.tsx` import Recharts (`^3.10.0`). No chart uses `ChartTooltipContent`. No chart uses `syncId`.

| Chart | File | Page | X domain | Hover today |
| --- | --- | --- | --- | --- |
| `LineChart` | `src/components/LineChart.tsx:72` | shared | Unix ms, month/day ticks | Recharts `Tooltip` with custom `LineChartTooltip` (363-408), vertical cursor (178), active dots (199). Persistent mode is click-select. Legend `focusedSeriesId` state (88). No `accessibilityLayer`. `touch-pan-y` only. |
| `TeamHistoryLineChart` | `src/views/rankings/TeamHistoryLineChart.tsx:20` | board (`TeamsView.tsx:707`), team drawer (`TeamDetailDrawer.tsx:224`), team compare (`CompareAnalysis.tsx:445`) | Unix ms | Wraps `LineChart` persistent mode. Tooltip portals into a details panel (state at 22, 33). Stops click propagation (78). |
| `RegionTrendChart` | `src/views/rankings/CompareAnalysis.tsx:176` | region compare drawer | dates | Plain `LineChart` hover. Beside `CompareProfileChart`. |
| `RegionDepthChart` | `src/components/RegionDepthChart.tsx:30` | regions page (`RegionsView.tsx:104`) | Power (categorical rows) | Base UI `HoverCard` per dot (83-123), `tabIndex=0` dots, SVG `<title>` on score tick. |
| `RegionPowerSparkline` | `src/views/regions/RegionsView.tsx:205` | region detail drawer | point index (last 24 points) | None. Caption uses the full series, line uses 24 points. |
| `PowerLadder` | `src/views/rankings/PowerLadder.tsx:33` | board (`TeamsView.tsx:660`) | Power (rows) | Base UI hover card per row (90-129), SVG buttons with Enter/Space (58-62). |
| `TournamentBracket` | `src/views/tournaments/TournamentBracket.tsx:26` | tournaments | rounds | `hovered`/`pinned` state (28-29), mouse/focus handlers (225-228, 284-289), Escape clears. Diagram, not a statistical chart. |
| CSS bars | `CompareProfileChart` (`CompareAnalysis.tsx:87`), `TeamScoreCell` (`BoardCells.tsx:61`), `HeadToHead`, `CompareDock`, matchup bars (`TeamDetailDrawer.tsx:249`), `ComponentBar` (`PlayerDisclosure.tsx:164`), `RatingDelta` (`SeriesLedger.tsx:259`) | various | categories | `title` attributes or none. Bars are `aria-hidden`. |

Tests that touch charts: `tests/lineChartBrowser.test.ts` (no pointer moves), `tests/fixtures/chartCalendar.tsx`, `tests/regionDepthChart.test.ts`, `tests/compareClarity.test.ts`, `tests/tournamentBracketView.test.ts`, `tests/lineChart.test.ts`, `tests/teamHistoryChart.test.ts`, `tests/chartPoints.test.ts`.

Gotcha: `LineChart` draws a dashed gap for any interval over 21 days. Yearly points would all render as gaps unless the policy changes for a yearly axis.

## Data shape (proposed)

```ts
type RegionYearPoint = {
  season: number;          // from snapshotIndex[key].filter.season, full-year scopes only, no checkpoints
  region: RegionId;        // LCS, CBLOL, LEC, LCK, LPL, LCP (current taxonomy)
  score: number | null;    // PublicRankingShard.regions[].score; null when the region is absent that season
  asOf: string;            // scope results-through date
};
type RegionTimeline = {
  modelVersion: string;
  modelConfigHash: string;
  seasons: number[];       // shared year axis
  points: RegionYearPoint[];
};
```

Organizing structure: one table keyed by season, with one column per region. This maps to one Recharts row per year and one `Line` per region.

## Data feasibility

Feasible per code inspection. Not verified against a payload, because `public/data` is absent.

- Each published season shard (`snapshotIndex["<year>__All__All"].url`) carries `regions[].score`, `topThreeTeamRating`, `totalTeamRating`. These are values the publisher produced. No interpolation is needed.
- Meaning: season-end region power from the current model and config, replayed through that season. It is not the ranking published in that year. Label it "Season-end region power". Mark the current season as in progress.
- Cost: the manifest plus one full ranking shard per year. Today `usePublicArtifacts` loads only the selected scope. A multi-scope loader in `src/browser/rankings` is needed.
- Rejected: averaging `regionPowerSeries` per year (browser statistic, survivor bias from scope-end teams), team-history reconstruction, match-impact reconstruction.
- Placement: pure derivation in `src/domains/rankings/internal/queries/regionYearlySeries.ts`, exported through `src/domains/rankings/read.ts` (already `browserRuntime: true`). Fetching stays in `src/browser/rankings`.
- Open: which seasons the reference payload holds. Run `pnpm data:pull`, then read `public/data/ranking-summary.json` `snapshotIndex` keys.

## Hover design (proposed, not reviewed)

Interpretation of "hover works well": (a) one hover model for every chart, with the same tooltip look, cursor, nearest-point snapping, keyboard focus and touch; (b) charts on one page that share an axis sync their hover.

- Make `LineChart` the only time-series primitive. Use `ChartTooltipContent` from `src/components/ui/chart.tsx` as the one tooltip look. Delete `LineChartTooltip` styling that duplicates it.
- Enable Recharts `accessibilityLayer` for arrow-key point focus. Keep the vertical cursor and active dots. Use `trigger="hover"` for all charts and drop the click-only persistent mode, or keep it only where the details panel needs a pinned point.
- Add a `syncId` prop and use `syncMethod="value"` so charts with different row sets match by x value. Candidate sync groups: region compare drawer (trend chart), regions page (new timeline plus drawer chart), board (history chart).
- Replace `RegionPowerSparkline` with `LineChart` on a time axis, so the drawer uses the same model.
- `RegionDepthChart` and `PowerLadder` are categorical dot plots, not time axes. Keep them out of sync groups. Align their hover cards with the shared tooltip look.
- `TournamentBracket` and CSS bars are not plots. Leave them out of scope and say so in the PR.
- For a yearly axis, add an x-axis mode with integer year ticks and no 21-day gap rule.

## Next steps

1. `source ~/.cache/t3-node24/env.sh`, then `flock /tmp/t3-top5-heavy.lock pnpm install --frozen-lockfile` and `flock /tmp/t3-top5-heavy.lock pnpm data:pull`.
2. Read `snapshotIndex` season keys. Confirm at least two full-year seasons with `regions[]`. If not, stop and report to Max.
3. Run the `architect` step on the data shape and hover design above. Get two distinct sketches.
4. Implement: domain derivation, multi-scope loader, timeline panel in `RegionsView`, shared hover in `LineChart`, migrate callers, delete replaced hover code.
5. Verify with `.agents/skills/verify-lol-esports` L5 and L8 on port 43129: timeline, synced hover, mobile width, keyboard focus. Save snapshots to `.agents/artifacts/<run-id>/`.
6. Interrogate review on `codex/gpt-6.1-sol` with `reasoningEffort=high`.
7. Remove this handoff from Git. Open a draft PR with `file-pr`, then `link_pull_request`.

## Explorer tasks (T3)

- Chart inventory: `region-timeline-how-explorer-charts-1`, `codex/gpt-6.1-sol` low, completed.
- Published region data: `region-timeline-how-explorer-data-1`, `codex/gpt-6.1-sol` low, completed.
- Regions view, tests, placement: `region-timeline-how-explorer-regions-ui-1`, `codex/gpt-6.1-sol` low, completed.
