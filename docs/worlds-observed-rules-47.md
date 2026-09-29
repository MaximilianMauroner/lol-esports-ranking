# Worlds observed-rules slice (#47)

This is an **offline replay contract**, not an official event feed or a Worlds forecast. The caller supplies all entrant identities, regions, draw tiers, evidence reference, completed draws, and winners. No collector, publication path, React route, or 2026 draw generator calls this module. Synthetic test IDs such as `one0` and `playin` are fixtures, not LoL Esports entrants.

## Primary rules checked on 2026-09-28

| Riot source clause | `worlds-2025-swiss-observed-v1` field/check | Regression |
| --- | --- | --- |
| [Worlds 2025 primer](https://lolesports.com/en-US/news/worlds-2025-primer), “Round 1”: five tier 1, six tier 2, five tier 3; tier 1 vs tier 3, tier 2 vs tier 2; no same-region match | 16 entrant IDs, tier counts, canonical LCK/LPL/LEC/LTA/LCP region IDs, round 1 pair validation | `worldsObservedRules.test.ts`: first round, incorrect tier, same region with mixed case/whitespace |
| Same primer, “Swiss Rounds 2–5”: same-record opponents, no rematch; redraw on a clash or forced later clash | Completed observed later rounds require equal records and no prior opponent; **no redraw or draw probabilities implemented** | equal-record and rematch cases |
| Same primer, “The Knockout Draw”: eight qualify, with records 2 at 3-0, 3 at 3-1, 3 at 3-2 | Wins reach 3 → advanced; losses reach 3 → eliminated; at most five rounds and eight advancers | replay, completeness and count checks |
| [MSI and Worlds 2026 update](https://lolesports.com/en-US/news/msi-and-worlds-updates), “Worlds 2026”: 19 entrants, four-team double-elimination Bo5 Play-In, one Swiss qualifier; seeding announced later | `season: 2026` explicitly returns `rules-unavailable` | unsupported-season case |

The 2025 primer lists Swiss Bo1/Bo3 but does not, in the checked text, provide a complete per-record series-format clause. This slice does not infer series scores or validate best-of for observed winners. It does not accept an absent or partly observed round as a complete state. It does not infer tier identities from a team name or current rating. It does not use 2025 tier routing for 2026.

## Unsupported states and remaining gates

`replayWorldsSwiss` requires separate caller supplied provenance for entrants/tiers and, when any round is replayed, matches/winners. Each reference is tagged `synthetic-fixture` or `source-observation` and copied into the supported result alongside the Riot **rules** source. The tag and reference are not authenticated; an official claim still requires an independently checked source artifact. The function returns `unsupported` for missing evidence, a missing season ruleset, invalid participant/round observations, and incomplete rounds. A valid replay still returns `forecast.status: unsupported`: conditional odds need certified draw sampling, a known full field and completed upstream Play-In path, observed draws, and pinned model inputs. This module contains no certified real-event entrant fixture.

Owner-only actions before live collection, publication, or an official 2026 forecast:

1. Record written provider usage rights and the permitted endpoints, rate limits, retention, correction handling, and publication terms. Keep the collector and UI flags off until that record is reviewed.
2. Capture representative complete source windows for all seven allowed competitions, with raw response timestamps/IDs, cursor traversal, correction order, and latency measurements. Compare the normalized feed to each raw window; retain the last-good artifact on incomplete reads. Attach the input windows, comparison report, and measured latency to the owner review.
3. Obtain the current official 2026 regulations or announcement clauses for Play-In routing, Swiss draw/redraw, series formats, seeding, and knockout bracket. Record dated URLs, exact clauses, and fixtures; return unsupported wherever a clause is absent. Do not transplant the 2025 draw tiers.
4. For activation, exercise fixture-backed browser journeys at 320/390/768/1280 px, stale/recovery behavior, keyboard navigation, cancel and stale-computation isolation, and record throughput/memory and cancellation time. Attach screenshots, browser logs, test command output, and the exact rules/model/state IDs used.
5. Require exact-head hosted Verify, production-shaped benchmark, and bundle, plus independent exact-head review and product gates. A billed-out, cancelled, or failing CI job is unresolved; do not waive it or merge on local results alone.

Local offline verification for this slice: `pnpm exec tsx --tsconfig tsconfig.app.json --test tests/worldsObservedRules.test.ts`, `pnpm run typecheck`, `pnpm run lint`, `pnpm test`, and `pnpm run bundle` (results recorded in the PR). No dev server or live source request is part of the test path.
