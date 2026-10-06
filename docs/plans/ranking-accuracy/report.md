# Ranking accuracy evidence

## Frozen baseline

The baseline replays the real local Oracle and Leaguepedia corpus through 2026-07-26. It has 4,519 games, 1,833 canonical series and 61 event groups. Historical source availability and total missing-game coverage are unknown. These are latest-corrected historical comparisons, not an untouched holdout or published forecast calibration.

| Predictor | Brier | Log loss |
| --- | ---: | ---: |
| current | 0.227749 | 0.647134 |
| elo | 0.228559 | 0.648995 |
| glicko | 0.231412 | 0.660960 |
| winRate | 0.232571 | 0.657390 |
| coinFlip | 0.250000 | 0.693147 |
| teamOnly | 0.233500 | 0.659484 |
| playerAdjusted | 0.227424 | 0.646438 |

Elo uses tournament K values and a frozen UTC-date period. Glicko uses Glicko-1 updates and a symmetric uncertainty-adjusted probability, with independent-game evidence as an explicit control assumption. Neither control is presented as a tuned final replacement. The team-only model includes the team and league rating spine. All rows use the same source cohort.

## Temporal and coverage audit

- Both source threads inspected 2025 and 2026. All existing-period results remain exploratory.
- Whole events that cross fit/validation boundaries are withheld. The declared protocol is in [protocol.json](protocol.json).
- There are 276 canonical series with low-confidence formats. The series target excludes Bo2 ties and incomplete/unknown series.
- No imported placement tournament lifecycle has complete result coverage. Placement calibration is blocked, not passed.
- Oracle 2023 and 2024 downloads returned Google Drive quota-exceeded HTML. Warm-up evidence is blocked by the provider.
- Raw normalization and source precedence can incorporate later corrections. Input observation archives are absent, so historical public availability cannot be certified.
- Five independent event clusters is the minimum numerical-bootstrap admission rule. It is not a guarantee of statistical power or interval coverage. Small gains remain inconclusive.

| Fit through | Validate through | Fit games | Validation games | Validation events |
| --- | --- | ---: | ---: | ---: |
| 2025-03-31 | 2025-06-30 | 539 | 697 | 5 |
| 2025-06-30 | 2025-09-30 | 1375 | 834 | 11 |
| 2025-09-30 | 2025-12-31 | 2308 | 264 | 6 |

## Verification

- Two new frozen exports were byte-identical.
- Seven benchmark/control regression checks passed, including duplicate/outcome/orientation/source rejection, empty/event-poor gates, shared metrics, whole-event folds, prior-only controls, and the Glicko update.
- Typecheck passed. All commands used Fleet coding-vm admission with 3 GiB group memory and zero build swap.
- Required full project checks, CI, PR review, merge and product journeys are pending implementation. Production data is unchanged.
