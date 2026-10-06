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

## Precision and joint fit decision

Retain the current numerical formula. Precision alone raised Brier by 0.000057 and log loss by 0.000133 on the inspected corpus. Cross-region Brier rose by 0.000168, so it failed the declared gate. All 24 seeded trials also failed that gate. Two trials improved the cross-region point estimate, but their event-bootstrap upper bounds exceeded 0.0005. No threshold was relaxed.

Trial 12 had the best fit loss in all three expanding windows. Its validation log losses were 0.620954, 0.642584 and 0.690524. The unchanged precision comparator scored 0.625519, 0.646724 and 0.683728. The third window worsened. Overall improvement did not establish cross-region improvement or an accuracy claim.

The full-precision implementation and its regression tests are preserved in commit `e254c62`. It is a rejected research candidate, not the selected production engine. Its focused state/checkpoint/full-versus-resumed checks passed. The search ran before the later series-format correction below. Do not treat these trials as fits of the corrected source policy or reuse their receipts with changed code. The search took 6m53s, with about 2.06 GiB peak group memory and zero build swap. Group-control trials and all bounds are saved with the receipts.

## Series and placement correctness

The real-data audit found four 2–2 groups inferred as completed Bo3s: one MSI series, two other 2026 event groups, and one CBLOL playoff group. A four-game score requires at least Bo5; a 2–2 prefix stays ongoing. Scores beyond the declared format or winning limit stay unknown. The source/config identity now changes for this correction. On the same 4,519 game rows, the corrected current model scores Brier 0.227741 and log loss 0.647115. It has 1,799 eligible binary series, down from 1,803. This is a correctness result, not held-out accuracy proof.

Three additional complete series had valid final scores but uncertain observed game order. The score likelihood sums legal stopping paths for a final score. It does not invent the observed order. The strict ordered-path utility remains available for certified-order evidence. Pre-series and conditional likelihoods stay separate. On 1,799 complete binary-format series, independent, 0.5-logit and 1-logit dependence controls scored pre-series score log loss 1.259877, 1.257767 and 1.255054. These scores use a different target from binary game log loss.

Placement pool scaling could put a favorite above the 11-point champion attainment. The bounded replacement preserves the realized pool and each entrant's feasible range. It does not constrain every champion to a positive residual. Existing completion/result-coverage and one-award gates remain. Real placement calibration is blocked because the frozen corpus has no complete result lifecycle. No zero-effect comparison is counted as a pass.

## Public board decision

Retain the current board policies. Six prior boards scored the following 30 days, with 1,403 shared games and 35 event clusters. The board and raw predictor are different compositions. These are fixed neutral-board forecasts, separate from side-aware walk-forward forecasts.

| Composition | Log loss | Non-regression gate |
| --- | ---: | --- |
| Current board | 0.656510 | Reference |
| Remove compression | 0.656211 | Passed; superiority inconclusive |
| Remove anchor relief | 0.655908 | Failed |
| Remove sparse blend | 0.655922 | Failed |
| Remove roster cap | 0.656686 | Failed |
| Remove head-to-head | 0.656441 | Passed; superiority inconclusive |
| Remove anchor shrinkage | 0.656729 | Failed |
| Raw prediction spine | 0.655945 | Failed |

All rank orders are saved at each cutoff. Composition is reconstructed from exact prior state and the same head-to-head helper used by production. A mismatch with the materialized board fails the experiment. Public conversion remains a separate scale. Compression and head-to-head removal have small, inconclusive gains. The existing versioned board rules remain ranking policies; this work makes no claim that they improve forecasts. Max can revise these policies with fresh evidence.

## Fair league comparison and uncertainty

Defer the hierarchical prototype. Tier, flat and weak prior variants scored log loss 0.647973, 0.650858 and 0.648672 on the shared known-member forward cohort. All failed cross-region and league guardrails despite lower overall loss than the current fixed board. The fits report seasonal offsets, connectivity, prior sensitivity, cross-league counts and provisional status. They do not replace top-three representative Region Power with league-average strength.

The synthetic hierarchy uses only qualified domestic leaders as international entrants and recovers league order while retaining team effects. Over 30 simulations, mean absolute league-offset error was 0.183 logits. Its nominal diagonal 95% bands covered 61.7% of known effects. The current heuristic team bands covered 90 of 100 simulated constant-strength differences. Neither result supports a statistical interval label. Time alone also does not increase the current team's heuristic uncertainty. This remains a limit of the retained model. The UI now calls these model evidence bands/ranges.

## Remaining external evidence

- Warm-up benefit/cost: blocked by Oracle's 2023/2024 download quota. Max supplies or authorizes usable primary files.
- Historical public availability and completeness: unknown without source-observation archives and an independent game ledger.
- Placement calibration: blocked until a real completed event has certified result coverage.
- Fresh accuracy proof: pending a locked candidate/protocol and an unexamined real cohort. No selected tuning candidate exists today.
- Publication and activation: not authorized. Public data, production state and service settings remain unchanged.
