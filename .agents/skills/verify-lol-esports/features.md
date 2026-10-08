# Feature map

Reusable procedure map. Select affected journeys for each run. A source map
and offline receipts do not prove completed browser journeys.
Ranking claims must retain source manifest and model/config identity.

| ID | Public actions and expected result | Source / regression references | Reset |
| --- | --- | --- | --- |
| L1 | Open Rankings. Inspect source/coverage and methodology. A no-data manifest shows no-data state, not seeded teams. Reload preserves truthful provenance. | `src/App.tsx`, public artifact resolver; artifact identity and bootstrap tests | Restore default scope. |
| L2 | Change season/checkpoint, event and region filters; search a team and sort the board. Historical seasons use their chronological model state; narrowing preserves the global scale. | ScopeBar, TeamsView, public scopes; scope and checkpoint tests | Clear filters/search. |
| L3 | Select a team and player, inspect explanation, timeline, roster and history, then switch selection. Lazy shards belong to the selected entity and snapshot. | team/player views and history charts; profile, roster and timeline tests | Close detail. |
| L4 | Add up to four teams or regions to comparison, remove one, inspect analysis and head-to-head. Labels and chart colors remain stable and claims use the same scope. | CompareDock, CompareDrawer, CompareAnalysis, HeadToHead; compare and public matchup tests | Clear comparison. |
| L5 | Open Regions and inspect regional strength, strongest teams and depth. Scope changes update the same model universe without presenting an unfair raw league count. | RegionsView, region strength; region and rating-universe tests | Return to Rankings. |
| L6 | Open Matches, filter and paginate, follow team and series history. Entries and rating changes remain tied to the selected archive. Exercise older year and bounded-node history, reload and back navigation. | MatchesView and public archive modules; stable pagination, match ledger and rankingArchiveBrowser tests | Reset history scope. |
| L7 | With the documented tournament flag enabled in an owned instance, inspect schedule, Play-In, knockout and ledger paths. Schedule reference stays separate from scored rankings; predictions identify model and observed rules. | TournamentsView; tournamentBrowser, worldsObservedRules, canonical series and prediction tests | Stop flagged instance. |
| L8 | Open mobile-width and desktop pages, use keyboard controls, change views and reload deep links. No inaccessible controls, misleading error state or uncaught browser error. | app shell, URL state and UI controls; bootstrap and SEO tests | Restore viewport and default hash. |
| L9 | Run `pnpm ranking:baseline` on the committed receipt. It verifies identity without network or bucket mutation. | ranking restart baseline script and receipt tests | No remote state created. |
| L10 | Run the local automatic tournament ingestion regression. A second date-window refresh preserves domestic history, deduplicates overlapping games, and retains the new event in global and year ledgers with series-atomic rating updates. Check gated audit discovery with an unchanged official probe, explicit opt-out and shadow defaults. Then exercise L6 with the offline fixture. | automaticTournamentIngestion and refreshOnce tests; captured Demacia Cup 2026 fixture; ranking-source-import and teamProfiles | Remove owned temporary data and restore the saved local public payload. |
| L11 | In an isolated synthetic forecast fixture, expand Conditional Power preview. Select each winner and legal Bo1/3/5 score. Inspect current Power, model/date/snapshot, and explicit missing replay-state/event/future-input reasons. Use keyboard at 320/390/768/1280px. A basis refresh resets the selection; a live/completed source update closes selection and preserves the published pre-match odds. No numerical public delta or projected rank is supported by the current public receipt. | `conditionalPowerPreview`, `conditionalPowerReplay`, `ConditionalPowerPreview`; conditionalPowerReplay and tournamentForecastBrowser tests; `docs/conditional-power-previews-56.md` | Close details, restore viewport, stop the owned instance. |

Browser groups L1-L8 stay blocked until an allowed browser reaches the owned server. Missing
static data stays explicit. A disabled tournament hub is an intentional flag,
not a product failure. Production cadence, activation, artifact publication,
presigned delivery and deletion are outside this procedure's authority.
