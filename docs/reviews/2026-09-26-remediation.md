# Product report remediation

Report: https://tools.mauroner.net/artifacts/s4zCR_W-zor-LbvOx18xabXKPhcdLZGq

Baseline: origin/main `e5034be2`, clean isolated worktree. Full report and latest project threads read. Other threads settled/stopped. PR33 (`96b5a6fc`, issue32 schedule deduplication) and PR35 (`cc70fe02`, issue34 redundant test) excluded; both hosted checks successful at intake. Preserve all existing tests and others' changes.

| Findings | Issue | Status / evidence | PR |
|---|---|---|---|
| F01, F02, F09, F10, F11 | #36 | In progress. Live 768px score width32/scroll68; skip activation routes Matches to Rankings. Table hides col elements without matching cells. Mobile card allocates too little team width; header-only sorting. | Pending |
| F03, F12, Q01, Q02 | #37 | Next: trace versioned artifacts, filters and score orientation. | Pending |
| F04, F05, F07, F08, F15, Q03 | #38 | Next: coverage and metric provenance. | Pending |
| F06, F13, F14 | #39 | F06 source confirms unconditional 2-selected subtraction. Inspector/scale investigation pending. | Pending |

Acceptance: T3 preview at 320/390/767/768/820/1024 and desktop; keyboard routes/filter preservation; meaningful regression checks. Serialize heavy work under nonblocking `/tmp/t3-heavy-tests-20260926.lock`. Exact-head native Prometheus (Astra/high), required CI and unresolved review gates before merge. No production deployment/publication. Reset watcher remains authoritative and must not be disabled/restarted.

Code verification and merge/release readiness are separate. No source/calculation claim is inferred solely from browser observations. Player-stat unavailability remains a declared coverage gap.

## Slice 1 — access and responsive rankings

Implemented F01/F02/F09/F10/F11. Cards through 1100px; fixed 190px desktop score column; full team name wraps with separate visible record. Labeled sort control exposes all six existing sort orders. Skip prevents hash navigation and focuses current main in loaded/loading/error shells. Empty dock is collapsed, + affordances remain explained, and clearing/removing the final pick returns focus to main. Intro is an optional native disclosure (no existing shadcn disclosure component).

Verification: typecheck, lint, all 694 tests passed; bundle check pending final log inspection. Live pre-fix reproduction recorded above. T3 preview subsequently failed open/navigation/evaluation and timed out, so post-fix viewport/keyboard acceptance is pending browser recovery; do not claim UI PASS or merge readiness from source checks alone.

PR40: https://github.com/MaximilianMauroner/lol-esports-ranking/pull/40. Prometheus found that TableCell nowrap still clipped card records at 320px; explicitly wrap the record cell and keep the numeric W/L on its own line. Browser acceptance remains pending.

## Slice 2 — match provenance and context

F03: SHA256-verified immutable live generation `run_20260926060805_transparent-power-index-v0-2-0_fnv1a-169aeb58`, model `transparent-power-index-v0.2.0` contains:

- `official-match\u0000115570934355614551`, final `LOLTMNT01_418707`, Jul6 BLG 3–0 LYON, deltas -32/-16, expectedA .873.
- `official-match\u0000115570934355614575`, final `LOLTMNT01_422152`, Jul9 BLG 3–1 HLE, deltas -23/-42, expectedA .578.

Producer trace: matchImpactLookup sums history deltas. ratingSeriesEngine subtracted uncompressed `powerRating` before from soft-capped `ratingFromComponents` after. Controlled strong-team replay reproduced winner delta -159; symmetric component projection fixes it. New `matchHistoryDeltaPolicy` participates in model config hash to invalidate incompatible checkpoints. Existing publication is not rewritten. Original integrity checks remain and old bad rows provide plain-language per-series fallback/report context (IDs, source, publication, model hash). Corrected production impacts require authorized full replay/publication after code release; no deployment performed here.

Q01: Gen.G's three 2026 `msi-bracket` points are FST 2026 on March17/19/21, weight2.786. This is a shared weighting tier, not MSI attendance. Inspector now names actual events/counts and identifies the shared tier in help. No match-truth change.

F12: visible labels, league-compatible event options, preserved raw identifiers with readable separators, clear filters. Q02: both desktop/mobile cumulative scores label A/B codes beside the score; series orientation is canonical team order, independent of winner-first presentation.

Regression: strong-team replay failed before and passed after. Scoped filter and legacy-invalid-record/report-context cases added. Full verification pending shared heavy-work lock.

## Slice 3 — scope and metric bases

F04: season selection now names the full calendar-year window; checkpoint windows are explicitly separate. Coverage through the selected snapshot's rolling endpoint and publication date are separately labeled. No dates/data are invented from the last checkpoint.
F05: remove obsolete 100pt=64% claim; one generated example uses the same public scale and matchup engine as comparison, with neutral single-game, zero-uncertainty and series assumptions named. Numeric copy is disclosed on demand.
F07: tournament riser/faller is restricted to the board's filtered team IDs, including eligibility selection. Tournament auto-selection of all participants is explained.
F08: score says Published/Event endpoint, movement says History; visible board text supplies movement dates/basis; published update delta and trajectory basis clarified.
F15: region record sums flagship league series outcomes (leagueRatings updateLeagueRecord adds observed outcome and complement); tied Bo2 outcomes contribute .5/.5. Label series equivalents and explain a concrete example; no event weighting applies to these counts.
Q03: rank chart was subtracting Power attribution from rank positions. Tag rank deltas, stop cross-unit subtraction and sign reconciliation, and label Power annotations/components explicitly. Regression reproduces unchanged #1 with -26 Power, now without invented +26 adjustment.

T3 acceptance recovered via tailnet HTTPS port5174. Candidate at 320/390/767/768/820/1024/1280: no document overflow, full sampled identities/records/scores, mobile sort visible, empty dock absent. 320px screenshot: browser-screenshot-coding-tailbc92d-ts-net-muie1lv6-6159dc24.png. Tab/Enter on all three routes focuses main-content and preserves exact hash/filter state. Native Prometheus code PASS: PR40 head68f8b07; PR41 headcc31a923. Both exact-head hosted CI green. PR41 local 697 tests and bundle passed; local production gate still running. Hosted Codex review on PR40 additionally requested accessible card field labels and compact excluded status; repairs remain in scope.
