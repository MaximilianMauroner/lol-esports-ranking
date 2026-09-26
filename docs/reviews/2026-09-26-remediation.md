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
