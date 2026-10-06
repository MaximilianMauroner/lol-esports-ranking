# Reproduce the ranking experiments

Run from the repository root with Node 24 and the pinned pnpm version. On Fleet coding-vm, put each command through the build skill helper. Run jobs in sequence. All outputs below are local evidence, not production artifacts.

## Freeze the input

Copy usable real provider files and their manifest into an owned cache. Resolve manifest paths relative to that manifest. Do not substitute sample data. Keep the baseline export and the input files unchanged. The exporter rejects no-data and seeded games.

```sh
pnpm calibration:export . <frozen-manifest> <baseline.json> 2025-01-01
```

The optional last argument sets the first scored date. Earlier rows still train state and controls. They do not enter the game, series, control or coverage denominators. Source identity describes the scored cohort. Training identity describes all replay input. This supports a warm/cold comparison on identical scored games.

## Fit the current engine

```sh
pnpm calibration:search <frozen-manifest> docs/plans/ranking-accuracy/protocol.json <search-directory>
```

The 24-trial budget includes the unchanged candidate, five parameter-group controls, and 18 seeded joint trials. The 12 bounds are declared in `scripts/lib/ranking-experiments.ts`. Probability Elo scale stays fixed, so uncertainty shrinkage cannot trade against another fitted probability scale. Event weights and their ordering stay fixed.

Each trial runs the real exporter in an isolated source copy. The search does not add runtime configuration or mutate production constants. It selects a trial separately on each expanding fit window, then reports that trial's forward validation score. Validation outcomes never choose that fold's trial. Both years have been examined before this work, so this procedure supplies exploratory evidence only.

Receipts bind protocol, source code, raw file contents and parameters. A resume rejects a changed identity or altered saved predictions. Reusing a matching receipt requires its predictions and fold scores to match. Use a new output directory for a changed experiment. A failed trial stops the search. It does not consume a replacement draw or choose a new seed.

## Compare series evidence

```sh
pnpm calibration:series <frozen-manifest> <precision-export.json> <series-directory>
```

Compare binary series outcome plus decisiveness bonus with two offline alternatives. The first uses game residual evidence scaled by the square root of the observed game count. The second uses the gradient of an ordered-path likelihood with a common three-point latent logit mixture, then applies the same scaling. Both keep one atomic team/league award at completed series boundaries and retain event importance separately. Dependence is fixed at 1 logit unit for this comparison. It is not fitted or asserted to be the true correlation.

The likelihood utility handles Bo1/Bo2/Bo3/Bo5, legal stopping, incomplete prefixes, ties, and a separate probability for each game. The hypothesis report scores pre-series paths and conditional paths separately. Ordered-path log loss is a different target from binary game or series-winner log loss. Do not compare their absolute scores as if they were the same metric. No complete placement event is available in the frozen corpus. Placement calibration therefore remains blocked even if game predictions match when placement is disabled.

## Compare public boards and league effects

```sh
pnpm calibration:hypotheses <frozen-manifest> <precision-export.json> <hypotheses.json>
```

Build six prior-only quarterly boards. Score known teams' next 30 days with a fixed neutral board, and save full rank orders at each cutoff. These forecasts do not include current side information or update during that window. Compare compression, anchor relief, sparse standing blend, roster record cap, head-to-head and league-anchor shrinkage one at a time, then compare the raw prediction spine. Excluded teams and the scored denominator stay shared across these comparisons. This is a board experiment, not the side-aware walk-forward forecast benchmark.

The league prototype fits one seasonal effect per league and team effects relative to its observed domestic members. Domestic games identify team differences. International games identify league differences while retaining the traveling teams' offsets. A named league anchors zero; each league's observed team effects have zero mean. Tier, flat and weak priors test prior sensitivity. Graph connectivity, cross-league game counts and diagonal curvature are reported. Curvature scales omit covariance and are not calibrated confidence intervals. The prototype has no production callers.

Synthetic recovery uses qualified domestic leaders as international entrants. A second simulation checks the current team heuristic band against known constant logistic strength differences. Simulations are diagnostics. Their assumptions and coverage do not prove coverage on real esports data.

## Decide and lock

```sh
pnpm calibration:paired <baseline.json> <candidate.json>
```

The event-cluster non-regression gate is separate from superiority. Empty or event-poor cohorts cannot pass. Keep fresh accuracy claims pending until the candidate, input policy, protocol and evaluation cutoff are locked before the new outcomes are examined. Max owns access to a fresh real corpus and any named production activation. No experiment command publishes artifacts, changes a service, or accesses production storage.
