# Ranking accuracy implementation

Plan: https://tools.mauroner.net/artifacts/iIlzM7t9T6NOf6XFE5S6-ZuSaZMWaYIE

## Progress

- [x] M1
- [x] M2
- [x] M3 (warm-up support verified; real history blocked by provider quota)
- [x] M4 (24 trials rejected; no calibrated interval claim)
- [ ] M5
- [x] M6 (six prior boards; policies retained)
- [x] M7 (hierarchical prototype evaluated and deferred)
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

- M2 research candidate, later rejected: full-precision state, probabilities, components and ledgers survived series updates in the archived v0.2.1 prototype. The final branch retains the original numerical engine. No alternate engine or compatibility fallback was added.
- M2 verification: 84 focused precision, checkpoint, full/incremental replay and model tests passed. The first precision tests failed against the original rounded code. An exact float-share assertion now uses a tight tolerance. Two obsolete golden hashes were removed from the import-compaction test; full/lean semantic artifact equality and source-reference checks remain. The changed model identity and fractional player state made the old byte pins invalid.
- M3: the scored-start boundary is regression-tested across game, series, control and audit rows. Earlier games train state while scored denominators remain unchanged. Both 2023/2024 provider downloads failed with quota-exceeded HTML. No warm-up benefit or cost is claimed. Later experiments use the explicit cold-start corpus.
- M4-M7: offline tools use isolated source copies, a 24-trial serial search and fixed whole-event folds. Public boards use explicit prior match membership, quarterly cutoffs and the following 30 days. League fits retain team effects for selected entrants. These tools have no production callers.
- M5: the old placement pool scaling was reproduced above champion attainment. The replacement bounds each entrant between participation and champion attainment. Rounded production residual and ledger semantics remain. Review found a floating-point pool closure failure. Binary-grid allocation and independent property checks now close it. No real complete event exists to calibrate the change.
- Typecheck and lint passed before the simulation helper was added. The simulation's season type was then corrected to numeric; final required checks remain pending.

- Decision after M4: all 24 historical precision/fit candidates failed the declared gate. Preserve the complete precision prototype in `e254c62`, restore the current numerical engine, and retain only verified correctness fixes. No accuracy claim or parameter adoption is made. The restored golden player checks are retained.
- Parent diagnosis after two likelihood failures: four real 2–2 groups were inferred as completed Bo3s, and three other series had valid scores with uncertified ordering. Repair minimum-format inference, keep impossible scores unknown, and sum legal paths for observed-score likelihood. These are source correctness fixes. The initial search predates this correction and is not relabeled.
- M6: 1,403 games across 35 events at six exact prior boards. Compression/head-to-head removal passed non-regression but superiority was inconclusive. Other ablations failed. Keep existing versioned ranking policies, with no predictive claim. Board composition now uses exact raw prior state and production's head-to-head helper.
- M7: all three league priors failed fairness guardrails. Synthetic recovery covers selected qualified leaders, zero-centered team effects and disconnected leagues. Diagonal 95% band coverage was 61.7%; current team heuristic coverage was 90%. Statistical labels are not supported. Evidence-band copy replaces the public likely-range claim.
- Delivery owner: this agent completes local checks, product journeys, PR and required reviews. Max owns fresh primary history, complete event coverage, unexamined outcomes and any named production action. No production access, publication or deployment is included.

## PR review record

PR: https://github.com/MaximilianMauroner/lol-esports-ranking/pull/79

Reviewed base `9d7af625`, head `986b347a`. Native issue finder and verifier both use gpt-5.6-sol. Parent uses gpt-6.1-sol. Reviews are read-only; one implementer owns the confirmed source and test repairs.

| Finding | Source and disposition | Current evidence |
| --- | --- | --- |
| Bounded pool float closure | Verifier and hosted CI; act on | Published review 5434908823; closed by binary-grid allocation in b2b9a59, guarded affected checks and independent conservation sweep. |
| Inactivity assertion precision | Verifier and hosted CI; act on | Published review 5434908823; closed by comparing the published precision boundary. Affected and hosted checks passed. |
| Export source/prediction orientation | Verifier; act on | Published review 5434933428; strict join validation and canonical outcome orientation passed affected and hosted checks. |
| Remaining likely-rank claim | Both reviewers; act on | Published review 5434933428; team drawer now says Rank from evidence band. Source/UI checks passed; live browser proof remains pending. |
| Domestic-member hierarchy center | Verifier; act on | Published review 5434933428; only observed domestic members define the center. Affected and hosted hierarchy checks passed. |
| Missing result provenance | Verifier; act on | Published review 5434933428; report and committed evidence.json distinguish historical model/source cohorts. Final corrected receipts remain pending. |
| Mixed-provider split series | Both reviewers; act on | Published review 5434963355. Unique scored duplicate anchors transfer full provider per-game IDs and ordinals. Real Fnatic/Karmine source audit passed. The later same-provider rematch and anchor-order findings below remain open. |
| Trusted impossible format promotion | Both reviewers; act on | Published review 5434963355. Trusted formats stay fixed and impossible scores resolve unknown. Affected and hosted checks passed. |

Finder full-diff dead-code and redundant-test checks passed. It found no obsolete caller or removable duplicate test. Regression review remains failed until the later rematch findings close. Seventeen focused checks and read-only corpus audits passed in discovery. Final local checks and product journeys are still pending; another owner holds Fleet's build slot. Hosted Checks on `986b347a` failed (842 passed, 2 failed); hosted typecheck and lint passed. The configured Codex review bot returned a quota notice, which does not establish a clean bot review. No approval, merge, production publication or deployment occurred.

The first floating residual repair closed the original CI case but failed an independent five-entrant conservation counterexample. Parent diagnosed summation roundoff before the same implementer repaired it. Expected allocation now uses a binary precision grid of 2^32 units per stage point. Scaled pool/bounds must be safe integers; deterministic remainder allocation conserves both entrant and regrouped league totals. This quantization is below 2.33e-10 stage points per entrant and does not change the retained rounded rating/residual semantics. The placement policy identity is `highest-attainment-bounded-grid-pool-centered-league-residual-v4`. That repair first used source v18; the duplicate-cohort correction and base integration below supersede it. No compatibility engine was added.

After the foreign job released Fleet's slot, the implementer's final 86 affected tests passed under the 3 GiB group limit and zero build swap (peak 366 MB, 2.259 seconds). The next full verify passed typecheck/lint and 852/854 tests. The two failing fixture formats were then corrected; current-head full verification remains pending. Existing public artifacts and production state remain unchanged.

## Source repair closure

The v18 replay is rejected. It added eight duplicate Leaguepedia rows because primary deduplication incorrectly required compatible clocks. Pipeline v19 restores clock-independent exact-stat and stable-ID deduplication. Clock, duration and bidirectional uniqueness checks still protect provider series anchors. The independent verifier restored all 4,519 frozen scored games, removed all eight duplicates and retained the Fnatic/Karmine Corp completed 3–1 Bo5. `git diff --check` passed. Two model sweep fixtures now explicitly declare Bo5; all 50 model tests passed. Final full verification is pending.

The intended base advanced to ingestion commit `95cc30e5`. Its home-league source policy must be retained during branch integration, with a new combined source identity before the final replay. No input corpus, public artifact or production resource changes are included.

Integrated `95cc30e5` without changing the frozen manifest. The combined source pipeline is `canonical-identity-stat-dedupe-feasible-series-player-performance-home-league-v20`. The merge conflict was only the source-policy identity; both policies remain active. Final checks will include the inherited ingestion tests.

Independent integration review passed at `53581490`: feasible-series normalization, clock-independent dedup, unique anchors/rematch separation, prior domestic home-league resolution and snapshot scopes all remain intact. Combined identity v20 and placement policy v4 are present; no conflict markers or new source defect were found. No test or CI result is implied by this read-only check.

## Hosted CI wake: 53581490

Hosted Checks passed typecheck and lint, then passed 859 of 860 tests. The only failure was the valid same-day rematch fixture, which retained three games instead of four. Independent finder and verifier confirmed that same-provider scoreboard fingerprints collapse distinct Leaguepedia game IDs. This behavior also exists on base `95cc30e5`; it is not a new dedup regression. Reversed Leaguepedia input also exposes FIFO selection of the wrong exact-stat Oracle candidate, which loses its verified series anchor. Both findings are published in native review `5435228447` before repair. The same implementer owns the narrow source/test fixes; full local checks remain blocked by another Fleet build owner.

The v21 repair is pushed as `c4cf3aa`. Independent affected source closure, dead-code and redundant-test checks passed; `git diff --check` passed. Shared source-key ownership now protects distinct same-provider game IDs across retained Oracle aliases and both duplicate queues. Weak snapshots do not erase known IDs. Preferred/reserved anchors are input-order independent, and one exact LP ID cannot verify multiple Oracle games. The new assertions cover original/reversed orders, repeated/missing/exact IDs, mixed provider aliases and result-only paths, plus same-ID corrected-clock ambiguity. The eight real clock-correction regression remains. Earlier 4,519-game source audits do not certify the final v21 cohort.

## Hosted CI wake: c4cf3aa

Hosted run `37542415883` passed install, typecheck and lint, then 862 of 863 tests. All new v21 source regressions passed. Clock-independent dedup, stable-provider identity and anchor-order/ambiguity threads are verified and resolved, with hosted results in replies `4201176445`, `4201176671` and `4201176878`.

| Finding | Source and disposition | Evidence and repair |
| --- | --- | --- |
| Canonical-event fixture conflicts with stable IDs | Hosted CI and both native reviewers; act on | The test declares two distinct Oracle IDs but expects one game. Base 95cc30e5 collapsed those IDs through a fingerprint. The v21 identity repair correctly retains them. Published review 5435392958. Set both fixture sourceGameId values explicitly to undefined; retain the assertion and production contract. This exercises canonicalEventKey rather than an ID short circuit. |

Both reviewers passed affected source/dead-code/redundant-test review; canonical-label and stable-ID tests cover distinct behavior. The implementer made the fixture-only correction, and the verifier confirmed the actual diff follows the fingerprint path with unchanged assertions and production source. `git diff --check` passed. The fixture correction still needs new-head execution. The hosted incremental gate and bundle were skipped after Verify failed. Final local checks, frozen replay/experiments and browser journeys remain blocked by foreign Fleet build owner PID744036. No threshold or resource-control waiver applies. The prepared serial verification sequence remains unexecuted. Bot review remains quota-blocked. No approval, merge, production publication or deployment occurred.
