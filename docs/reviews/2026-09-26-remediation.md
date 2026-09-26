# Product report remediation

Report: https://tools.mauroner.net/artifacts/s4zCR_W-zor-LbvOx18xabXKPhcdLZGq

Baseline: origin/main `e5034be2`, clean isolated worktree. Full report and latest project threads read. Other threads settled/stopped. PR33 (`96b5a6fc`, issue32 schedule deduplication) and PR35 (`cc70fe02`, issue34 redundant test) excluded; both hosted checks successful at intake. Preserve all existing tests and others' changes.

| Findings | Issue | Status / evidence | PR |
|---|---|---|---|
| F01, F02, F09, F10, F11 | [#36](https://github.com/MaximilianMauroner/lol-esports-ranking/issues/36) | Implemented; responsive, skip-link and six sorting modes verified via tailnet. | [#40](https://github.com/MaximilianMauroner/lol-esports-ranking/pull/40) |
| F03, F12, Q01, Q02 | [#37](https://github.com/MaximilianMauroner/lol-esports-ranking/issues/37) | Producer repair and scoped fallback; filters and score orientation implemented. Live correction requires authorized replay/publication. | [#41](https://github.com/MaximilianMauroner/lol-esports-ranking/pull/41) |
| F04, F05, F07, F08, F15, Q03 | [#38](https://github.com/MaximilianMauroner/lol-esports-ranking/issues/38) | Implemented; provenance and rank units repaired after native review. | [#42](https://github.com/MaximilianMauroner/lol-esports-ranking/pull/42) |
| F06, F13, F14 | [#39](https://github.com/MaximilianMauroner/lol-esports-ranking/issues/39) | Ready state, inspector disclosures/wrapping, selected comparison range implemented. Acceptance in progress. | [#43](https://github.com/MaximilianMauroner/lol-esports-ranking/pull/43) |

Acceptance: T3 preview at 320/390/767/768/820/1024 and desktop; keyboard routes/filter preservation; meaningful regression checks. Serialize heavy work under nonblocking `/tmp/t3-heavy-tests-20260926.lock`. Exact-head native Prometheus (Astra/high), required CI and unresolved review gates before merge. No production deployment/publication. Reset watcher remains authoritative and must not be disabled/restarted.

Code verification and merge/release readiness are separate. No source/calculation claim is inferred solely from browser observations. Player-stat unavailability remains a declared coverage gap.

## Slice 1 — access and responsive rankings

Implemented F01/F02/F09/F10/F11. Cards through 1100px; fixed 190px desktop score column; full team name wraps with separate visible record. Labeled sort control exposes all six existing sort orders. Skip prevents hash navigation and focuses current main in loaded/loading/error shells. Empty dock is collapsed, + affordances remain explained, and clearing/removing the final pick returns focus to main. Intro is an optional native disclosure (no existing shadcn disclosure component).

Verification: original 694 tests/typecheck/lint/bundle passed. Initial browser failure recovered through tailnet. Responsive and keyboard acceptance subsequently passed; see latest evidence below.

PR40: https://github.com/MaximilianMauroner/lol-esports-ranking/pull/40. Prometheus found that TableCell nowrap still clipped card records at 320px; explicitly wrap the record cell and keep the numeric W/L on its own line. The follow-up accessibility/status repairs and browser acceptance passed. PR40 merged at b9c7639694249b6f965035ca6403ef807c6c1f39 after exact-head agreement and hosted checks.

## Slice 2 — match provenance and context

F03: SHA256-verified immutable live generation `run_20260926060805_transparent-power-index-v0-2-0_fnv1a-169aeb58`, model `transparent-power-index-v0.2.0` contains:

- `official-match\u0000115570934355614551`, final `LOLTMNT01_418707`, Jul6 BLG 3–0 LYON, deltas -32/-16, expectedA .873.
- `official-match\u0000115570934355614575`, final `LOLTMNT01_422152`, Jul9 BLG 3–1 HLE, deltas -23/-42, expectedA .578.

Producer trace: matchImpactLookup sums history deltas. ratingSeriesEngine subtracted uncompressed `powerRating` before from soft-capped `ratingFromComponents` after. Controlled strong-team replay reproduced winner delta -159; symmetric component projection fixes it. New `matchHistoryDeltaPolicy` participates in model config hash to invalidate incompatible checkpoints. Existing publication is not rewritten. Original integrity checks remain and old bad rows provide plain-language per-series fallback/report context (IDs, source, publication, model hash). Corrected production impacts require authorized full replay/publication after code release; no deployment performed here.

Q01: Gen.G's three 2026 `msi-bracket` points are FST 2026 on March17/19/21, weight2.786. This is a shared weighting tier, not MSI attendance. Inspector now names actual events/counts and identifies the shared tier in help. No match-truth change.

F12: visible labels, league-compatible event options, preserved raw identifiers with readable separators, clear filters. Q02: both desktop/mobile cumulative scores label A/B codes beside the score; series orientation is canonical team order, independent of winner-first presentation.

Regression: strong-team replay failed before and passed after. Scoped filter and legacy-invalid-record/report-context cases added. Full verification passed (697 tests, typecheck/lint/bundle) before the later combined run.

## Slice 3 — scope and metric bases

F04: season selection now names the full calendar-year window; checkpoint windows are explicitly separate. Coverage through the selected snapshot's rolling endpoint and publication date are separately labeled. No dates/data are invented from the last checkpoint.
F05: remove obsolete 100pt=64% claim; one generated example uses the same public scale and matchup engine as comparison, with neutral single-game, zero-uncertainty and series assumptions named. Numeric copy is disclosed on demand.
F07: tournament riser/faller is restricted to the board's filtered team IDs, including eligibility selection. Tournament auto-selection of all participants is explained.
F08: score says Published/Event endpoint, movement says History; visible board text supplies movement dates/basis; published update delta and trajectory basis clarified.
F15: region record sums flagship league series outcomes (leagueRatings updateLeagueRecord adds observed outcome and complement); tied Bo2 outcomes contribute .5/.5. Label series equivalents and explain a concrete example; no event weighting applies to these counts.
Q03: rank chart was subtracting Power attribution from rank positions. Tag rank deltas, stop cross-unit subtraction and sign reconciliation, and label Power annotations/components explicitly. Regression reproduces unchanged #1 with -26 Power, now without invented +26 adjustment.

T3 acceptance recovered via tailnet HTTPS port5174. Candidate at 320/390/767/768/820/1024/1280: no document overflow, full sampled identities/records/scores, mobile sort visible, empty dock absent. 320px screenshot: browser-screenshot-coding-tailbc92d-ts-net-muie1lv6-6159dc24.png. Tab/Enter on all three routes focuses main-content and preserves exact hash/filter state. Native Prometheus code PASS: PR40 head68f8b07; PR41 headcc31a923. Both exact-head hosted CI green. PR41 local 697 tests and bundle passed; local production gate failed as recorded below. Hosted Codex review on PR40 additionally requested accessible card field labels and compact excluded status; repairs remain in scope.

## Slice 4 — comparison and inspector clarity

F06: source reproduced `2 - selected` yielding Pick0/Pick-1 for ready region selections. Ready state now applies to 2–4 selections, retaining four-entry limit and oldest-replacement policy. Render regression covers 0–4 selections and enabled/disabled action.
F13: primary inspector summary retains rank, published/event Power, uncertainty, dates, record and change. Important copy wraps. Secondary evidence/definitions, component diagnostics and player coverage use native disclosures; player data gaps remain explicit. Tournament diagnostics do not reuse snapshot-only evidence.
F14: each metric names its actual selected minimum/maximum and better direction; explanation states selected-range normalization, 6% visibility floor and equal-value behavior. Exact numeric values remain prominent. Render regression uses a narrow 2000–2005 score range and lower-is-better uncertainty.

Latest native code verdicts: PR40 `6d261c1b12032e83db02dd39e6144dc43f1d41c2` PASS; PR41 `8586c0816f986d0eb95b02213137a2499d62694a` PASS; PR42 `74ea27c816a0159c967ecb30606833a67374a010` PASS. PR40/41 exact-head hosted checks passed. Earlier PR40 bot threads repaired, replied and resolved. Final combined verification and PR42/43 CI still pending.

Tailnet candidate: https://coding.tailbc92d.ts.net:5174/ . Local artifacts differ from the live report generation (local match coverage Jul26, publication Sep26); do not equate their numerical values. All six mobile sort selections change order and retain selected direction. LEC+MSI shows only G2/KC in board and movement; event endpoint date is visible. Rank tooltip says rank positions and explicitly separates Power annotations.

Local production-performance gate failed (26.412s max vs 15s; RSS743161856 vs734003200 bytes, parity true), but ran while checkout changed and is not exact-head evidence. Hosted PR41 predecessor gate passed. Final immutable candidate verification is still required; no threshold waiver.

## Final acceptance progress

PR40 merged with exact-head Prometheus PASS and hosted CI PASS. PR41 current head remains `8586c0816f986d0eb95b02213137a2499d62694a`, Prometheus/CI PASS; base is now main after the parent merge. PR42 follow-up fixes propagate persisted probability calibration through game/series/bands and keep YYYY-MM-DD artifact dates in UTC; timestamp formatting remains local. The timezone regression starts a fresh process with America/Los_Angeles before formatter import. Hosted review threads were answered with evidence and resolved.

Combined candidate `a6de066c7cc10ddc60bca02e00aa94d2534970a9`: all 706 tests, typecheck, lint and bundle PASS. Subsequent calendar regression and regional disclosure changes receive affected checks; final immutable performance gate pending. PR43 extends F13 to the region inspector: fractional-record explanation is visible; secondary diagnostics/definitions are disclosed and wrap.

Browser: dependent Matches league/event options, incompatible-event reset and Clear filters passed. MSI legacy failures remain rejected with scoped fallback and report URLs containing actual series/game IDs, model/config and publication context. Expanded BLG/HLE games say BLG 1–0 HLE through BLG 3–1 HLE, independent of winner-first row text. Region tray 0–4 states passed; clearing hides dock and focuses main. Comparison metric ranges and scale explanation are visible at320 without page overflow. Team inspector at320 shows primary summary and closed secondary disclosures; Escape closes and restores original row focus. Final desktop/mobile acceptance continues on tailnet.

Production remains unchanged by artifact operations: fixing the two published MSI impacts requires owner-authorized replay/publication in the established workflow. This is a release dependency, not a reason to suppress validation or invent data.
