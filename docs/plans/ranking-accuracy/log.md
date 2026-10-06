# Ranking accuracy implementation

Plan: https://tools.mauroner.net/artifacts/iIlzM7t9T6NOf6XFE5S6-ZuSaZMWaYIE

## Progress

- [x] M1
- [x] M2
- [x] M3 (warm-up support verified; real history blocked by provider quota)
- [ ] M4
- [ ] M5
- [ ] M6
- [ ] M7
- [ ] M8

## Decisions

- 2026-10-06: Max requested max-mode implementation. Use the recommended bounded local 2023/2024 history evaluation. No production download, replay, publication or runtime change is authorized.
- Baseline is committed event/season work at 9d7af625. Worktree and source copies are isolated.
- Required commands use Fleet coding-vm memory admission: 3 GiB, zero build swap, one build slot.

## Acceptance

```json
[
  {
    "id": "A1",
    "check": "Frozen real corpus, quality report, metric contract, and reproducible benchmark exist.",
    "proof": "Run new benchmark fixtures through pnpm test; repeat the frozen export; record coverage/exclusions and baseline scores.",
    "passes": false
  },
  {
    "id": "A2",
    "check": "Predictions use only eligible prior information and pairing rejects unsafe inputs.",
    "proof": "Extend tests/predictionModel.test.ts, tests/importers.test.ts, and causal suites with future membership/patch/correction mutations; add CLI duplicate, empty, mismatch and orientation fixtures. All pass.",
    "passes": false
  },
  {
    "id": "A3",
    "check": "Fractional state and probability precision survive updates and persistence.",
    "proof": "New sub-point accumulation/probability tests fail before the precision change and pass after; tests/ratingCheckpoint.test.ts and tests/incrementalRankingIntegration.test.ts show lossless state and exact resumed/full parity.",
    "passes": false
  },
  {
    "id": "A4",
    "check": "Warm-up benefit and cost are measured on the same scored cohort.",
    "proof": "With D1 authority, compare cold and 2023/2024-warmed runs, exclude warm-up rows from metrics, and report season/roster slices plus compute/memory. Otherwise keep blocked.",
    "passes": false
  },
  {
    "id": "A5",
    "check": "A bounded joint fit and uncertainty comparison avoid test leakage.",
    "proof": "Repeat seeded trials on frozen fit/validation folds; compare current, Elo and Glicko; run inactivity/roster and simulated interval-coverage checks; retain only supported uncertainty claims.",
    "passes": false
  },
  {
    "id": "A6",
    "check": "Series/placement comparisons use valid evidence without duplicate awards.",
    "proof": "Extend tests/seriesResolver.test.ts, tests/model.test.ts and event tests for stops, ties, atomic evidence and bounded expectations; compare likelihoods on real complete events. Missing events leave placement proof blocked.",
    "passes": false
  },
  {
    "id": "A7",
    "check": "Public layers and predictor composition have explicit evidence or policy.",
    "proof": "Run prior-cutoff board ablations and composition regression; tests/publishedRatingScale.test.ts, tests/publicMatchup.test.ts and artifact identity/ledger tests pass with reconciled totals.",
    "passes": false
  },
  {
    "id": "A8",
    "check": "Fair league comparison covers sparse evidence, connectivity and qualification bias.",
    "proof": "Run synthetic recovery/connectivity tests and held-forward league/event comparisons; tests/regionStrength.test.ts and tests/ratingUniverse.test.ts pass; record adopt/defer with reasons.",
    "passes": false
  },
  {
    "id": "A9",
    "check": "Accuracy adoption has separate evidence from non-regression.",
    "proof": "Run calibration:paired and superiority analysis on the locked fresh cohort with adequate event support. Document intervals, slices, cutoff and custodian. If no fresh cohort or no supported gain, keep the accuracy claim pending.",
    "passes": false
  },
  {
    "id": "A10",
    "check": "The selected implementation meets local and CI gates.",
    "proof": "pnpm verify, pnpm benchmark:incremental:gate and pnpm build pass under resource controls; required GitHub Checks pass on the final PR head. Keep local and CI results separate.",
    "passes": false
  },
  {
    "id": "A11",
    "check": "Changed public journeys preserve provenance, scales and history.",
    "proof": "Run affected verify-lol-esports L1-L6/L8, plus L7 if forecast/tournament paths change and L9; save live browser evidence separately from automated test results.",
    "passes": false
  },
  {
    "id": "A12",
    "check": "A release handoff has exact status, recovery, owners and remaining gates.",
    "proof": "Record model/config, reports, D1/D2, compatibility/removal conditions, CI/review/merge status, unresolved freshness/performance/forecast-proof gates, and named next actions. Production action remains blocked until D2.",
    "passes": false
  }
]
```

## Evidence

- Frozen dependency install passed with the Fleet guard.

- M1 regression reproduced before repair: duplicate game IDs and no cross-region rows passed the previous paired command. The new validator rejects these inputs.
- Metric contract is shared binary-brier-clipped-log-loss-v1. The unsafe legacy command is removed; the package command now uses the typed evaluator. Old unversioned exports must be regenerated, with no speculative fallback.
- Local 2023/2024 Oracle downloads were attempted once. Both returned HTML with Google Drive quota exceeded. The warm-up comparison is blocked; no sample or third-party substitution is used.
- Benchmark boundaries: exporter owns source I/O; evaluation data owns target/cohort conversion and audit; numerical evaluator owns validation/metrics; controls are read-only offline comparisons. No new production service or dependency.

- M1 closed: frozen exports reproduce exactly; typecheck and seven regression checks passed; baseline and data-quality evidence are in report.md. A1 closes. A2 retains unknown as-published source availability instead of claiming it.

- M2: full-precision state, probabilities, components and ledgers now survive series updates. The model/config identity changes to v0.2.1. Checkpoints from the old identity require a full replay. Public scale formatting stays in the public converters. No old engine or compatibility fallback was added.
- M2 verification: 84 focused precision, checkpoint, full/incremental replay and model tests passed. The first precision tests failed against the original rounded code. An exact float-share assertion now uses a tight tolerance. Two obsolete golden hashes were removed from the import-compaction test; full/lean semantic artifact equality and source-reference checks remain. The changed model identity and fractional player state made the old byte pins invalid.
- M3: the scored-start boundary is regression-tested across game, series, control and audit rows. Earlier games train state while scored denominators remain unchanged. Both 2023/2024 provider downloads failed with quota-exceeded HTML. No warm-up benefit or cost is claimed. Later experiments use the explicit cold-start corpus.
- M4-M7: offline tools use isolated source copies, a 24-trial serial search and fixed whole-event folds. Public boards use explicit prior match membership, quarterly cutoffs and the following 30 days. League fits retain team effects for selected entrants. These tools have no production callers.
- M5: the old placement pool scaling was reproduced above champion attainment. The replacement conserves the pool while bounding each entrant between participation and champion attainment. Placement residual state is now full precision. No real complete event exists to calibrate the change.
- Typecheck and lint passed before the simulation helper was added. The simulation's season type was then corrected to numeric; final required checks remain pending.
