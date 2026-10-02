# Offline 2026 Worlds Play-In (#47)

This slice implements only the observed four-slot Play-In bracket and its conditional remaining-match odds. No collector, UI, server, receipt writer or production artifact imports it. The tests use synthetic team IDs and model snapshots. It does not complete #47 or certify live following.

## Primary rules checked on 2 October 2026

Riot's [Competitive Operations library](https://competitiveops.riotgames.com/en-US/library) lists the [2026 World Championship Event Specific Ruleset, v1.0](https://cdn.sanity.io/files/dsfx7636/news_live/faa5ce974e58615911fbee931c6123e2785a8b46.pdf) with a 31 August 2026 publication date. These are primary rules, not permission to collect or publish entrant/result data.

| Clause | Descriptor/state behavior | Evidence in tests/worlds2026PlayIn.test.ts |
| --- | --- | --- |
| §4.2.1: CBLOL second qualifier; LCS, LEC and LCP third qualifiers | Exactly one supplied entrant per seed; include all four regardless of region strength | Reject missing/duplicate seeds or IDs |
| §4.3.1: random opening selection, no pools/restrictions | Require a supplied, tagged four-slot opening draw; pair slots 0–1 and 2–3 | Reject missing draw evidence, duplicate and unknown slots; no generated draw |
| §4.1.1.1 and .1.1: four entrants, six Bo5 series, one qualifier | Two opening matches, upper/lower matches, lower final and final; no reset or extra seventh match | 64 exact unresolved winner paths; legal terminal Bo5 scores |
| §4.1.1.1.2–.1.5: explicit winner/loser routing | Fixed links; upper winner reaches round 4; lower loser finishes 19th; round 3 loser 18th; final loser 17th | Reject premature results/reseeding; replay independent partial rounds; final loser may have only one match loss |
| §4.1.1.1: winner enters Swiss; Riot's [MSI and Worlds update](https://lolesports.com/en-US/news/msi-and-worlds-updates), Worlds 2026 format paragraph, also says one team advances to Swiss | Output is `advanceToSwissProbability`, never title or knockout qualification | Deterministic completed state and one-slot conservation |
| §4.1.4.2: rounds 1–3 game-one RoFS by coin flip/equivalent; upper finalist gets game-one RoDS; §4.1.4.6: previous game loser gets subsequent RoFS | State routing is supported; conditional probabilities explicitly assume neutral independent games. Human side/pick choices and their effects are not modeled | Assumption/provenance assertion and parity with the existing #46 provider |
| §4.4.1.1: Play-In 15–18 October | Readiness deadline in the published roadmap; no automatic activation | No scheduled or production entry point |

The ruleset has editorial inconsistencies: §4.1.1.1.5 calls the Play-In destination the “Bracket Stage,” whereas its overview and Riot's separate Worlds 2026 announcement both specify Swiss. The descriptor uses the two explicit Swiss statements and records both sources. It does not reinterpret that phrase as direct knockout qualification. A source update that changes these clauses requires a reviewed descriptor revision. The v1.0 text's references to MSI in §1.1 and a 2025 champion in §4.1.3.1.3 are also not authorities for this Play-In API.

Swiss/knockout clauses are available in this ruleset, but are not implemented here. In particular §4.3.3.2 uses a move-to-next-available-slot rule and permits officials to waive the rematch restriction when no eligible draw exists. A future sampler must certify that procedure and its probability distribution. It must not substitute uniform legal matchings or guess an official waiver.

## Contract and model limits

`replayWorlds2026PlayIn` pins rules, event, state revision and as-of cutoff. Entrants, draw and completed results need separate evidence references. The `synthetic-fixture` / `source-observation` tags are caller assertions, not authentication. A source observation must be checked against retained licensed artifacts before any official claim. Completed observations after the cutoff, illegal scores, duplicate match IDs, unknown slots and results whose upstream matches are absent fail closed. Equivalent reordered observations and swapped participant/score orientation produce the same state.

`forecastWorlds2026PlayIn` enumerates at most 64 remaining winner paths on that supplied draw. Confirmed winners remain fixed. Each possible unresolved matchup uses `forecastTournamentSeries` from #46 with one frozen `ForecastBasis`. The returned `hypotheticalMatchups` retain snapshot, scale-derived ratings, uncertainty, roster, model/config, identity revision, data mode and warnings. Their IDs start with `hypothetical:`. The module never writes them to feeds or receipts, never claims they were actually published before play, and never changes model strength after a hypothetical result.

“Exact” means enumerated rather than sampled, using the existing provider's probabilities and precision. It does not establish model calibration or official side/draft fidelity. No Monte Carlo error is present. Game-one upper-finalist RoDS and other selection choices remain a disclosed model limitation. Game-score-conditioned live series, unresolved opening draws and full Worlds odds are outside this slice.

Each team's Swiss/17th/18th/19th finish probabilities sum to one. Across the complete field, each of those four mutually exclusive outcomes occupies one slot. Deterministic statuses come from observed bracket results, not numerical zero/one estimates. Missing or incompatible ratings and snapshots later than the event cutoff return unsupported for the entire remaining forecast. A fully completed bracket returns deterministic outcomes without requiring eliminated teams' ratings.

## Checks and next gates

Focused check: `pnpm exec tsx --tsconfig tsconfig.app.json --test tests/worlds2026PlayIn.test.ts`. Also run typecheck, lint, affected #46/observed-state regressions, and required hosted Checks. Serialize installs/builds/full suites with `/tmp/t3-heavy-tests-20260926.lock`; run one worker.

Later #47 PRs own certified Swiss sampling, exact observed knockout odds, Monte Carlo/worker/UI and the 2022 tiebreaker/handoff. Max supplies provider-rights decisions, licensed observations, historical rules/snapshots and independent receipt-delivery evidence. The known synthetic Hub first-load timeout remains an activation stability follow-up under #45.

A merge to main must be treated as a Railway production deployment. This GO authorizes implementation and PRs only. Before any separately authorized merge, Max must confirm production `VITE_TOURNAMENT_HUB_ENABLED`, `VITE_TOURNAMENT_FORECASTS_ENABLED` and `TOURNAMENT_COLLECTOR_ENABLED` are unset. This slice changes no deployment settings or shared UI/server files.
