# Offline 2026 Worlds knockout odds (#47)

This module replays partial or complete observed knockout series and enumerates remaining winner paths. It starts from eight observed Swiss qualifiers and a known draw. The [Worlds composition and hub journey](worlds-simulation-47.md) now validates its Swiss handoff and calls it from the UI worker. The composition can sample the unrestricted knockout draw separately. No collector, receipt producer or deployment path calls it. Test identities and ratings are synthetic; #47 remains open.

## Primary rules checked on 2 October 2026

Riot's [Competitive Operations library](https://competitiveops.riotgames.com/en-US/library) lists the [2026 World Championship Event Specific Ruleset v1.0](https://cdn.sanity.io/files/dsfx7636/news_live/faa5ce974e58615911fbee931c6123e2785a8b46.pdf), published 31 August 2026.

| Clause | Descriptor/state behavior | Regression evidence |
| --- | --- | --- |
| §4.1.2: three Swiss wins advance; three losses eliminate | Require eight observed qualifiers, with 2/3/3 entrants at 3–0/3–1/3–2 | Reject missing qualifiers, duplicate IDs and invalid record counts |
| §4.3.4.1: 3–0 teams draw 3–2 teams; remaining four pair | Validate the supplied quarterfinal pairings | Reject a 3–0 versus 3–0 or 3–1 pairing |
| §4.3.4.2: those two matches are on opposite halves; remaining placements follow draw order | Preserve supplied eight-slot order and adjacent winner links | Reject same-half undefeated matches; verify semifinal pairings and no reseeding |
| §4.3.4.3: no additional draw restrictions | Do not add region or prior-opponent restrictions | Same-region/rematch data is not an input or invented gate |
| §4.1.3.1 and Appendix A Figure 3: eight-team Bo5 single elimination | Four quarterfinals, two semifinals, one final; exactly seven matches | 128 unresolved winner paths; reject downstream results without parents and illegal Bo5 scores |
| §4.1.3.1.1–.1.3: winners advance, losers finish 5–8/3–4/2; final winner is champion | Separate cumulative stage chances from exclusive finish buckets | Conservation totals 4 semifinals, 2 finals, 1 champion; completed bracket is deterministic |

The 2026 PDF calls the final winner the “2025 WCE Champion” in §4.1.3.1.3. This is a recorded editorial inconsistency. The module returns the generic `champion` result within the supplied 2026 event context, using the 2026 ruleset title, eight-team stage definition and bracket diagram. It does not certify that erroneous year text or treat it as a separate 2025 event.

The Swiss procedure remains a separate certification gate. §4.3.3.2 moves conflicting teams to the next available slot and permits an official waiver when no eligible draw exists. The text does not fully define the random distribution, slot displacement/look-ahead behavior or waiver choice. Uniform legal matchings are not assumed equivalent. This conditional observed knockout slice can proceed without guessing those semantics.

## Contract and limits

`replayWorlds2026Knockout` requires rules/event/state IDs, an as-of cutoff, tagged qualifier/draw evidence and tagged result evidence when supplied or needed. Evidence tags are caller assertions, not authentication. Qualifier records are supplied observations, not a certified full Swiss replay. Official use still requires retained licensed source artifacts and a reviewed Swiss handoff. Independently completed matches may be supplied in any order. Score orientation may be reversed with participant orientation. Illegal, duplicate, future, premature or reseeded results return unsupported. A downstream result cannot have an observation timestamp earlier than its required upstream results.

`forecastWorlds2026Knockout` enumerates at most 128 paths with observed winners fixed. Each unresolved matchup uses the existing #46 `forecastTournamentSeries` provider with frozen strength, uncertainty, roster, model/config and neutral independent games. All returned hypothetical rows retain provider provenance and sample-data warnings. The module writes no receipts and does not claim retrospective forecasts were published before play.

Exact means enumerated under that model. It does not mean calibrated, official, or faithful to side/pick choices. Selection rights and draft choices are explicitly outside the probability model. Live partial-series conditioning is not supported. Input rating data cutoff must precede or equal publication, which must precede or equal the event-state cutoff. Missing or incompatible inputs block the entire remaining forecast. Eliminated-team ratings are not required; a complete event yields deterministic results without ratings.

A team can already have reached a stage with probability one. Its deterministic reached/eliminated state is reported separately from its numerical probabilities. The exclusive finish buckets sum to one per team; cumulative semifinal/final/title chances are monotonic. Their field totals are 4/2/1. No Monte Carlo error is present.

## Verification and release

Focused check: `pnpm exec tsx --tsconfig tsconfig.app.json --test tests/worlds2026Knockout.test.ts`. Run typecheck, lint, existing observed-bracket and provider regressions. Hosted Checks runs the full suite, production-shaped benchmark and bundle. No browser acceptance is claimed for a module without a UI caller.

The composition now owns the supported handoff, worker/cancellation/UI. Future Swiss draw sampling and historical tiebreaker support remain explicit gates in its audit. The UI release switches are operator controls. Viewers should use the page and forecasts normally when released; they should not configure environment flags.

GO authorizes implementation and PRs, not merging or deployment. A merge to main must be treated as Railway production deployment and needs Max's authorization. This slice changes no flags. Max still owns provider rights, licensed observations, historical rules/as-of snapshots and release approval. Before an authorized merge, confirm the three production tournament flags are unset as specified in the reviewed rollout plan.
