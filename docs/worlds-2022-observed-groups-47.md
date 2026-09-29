# Worlds 2022 observed group replay audit (#47)

Source checked 2026-09-29: Riot Games, [Worlds 2022 Primer](https://lolesports.com/en-US/news/worlds-2022-primer), sections “How are these teams split into their Groups?” and “Group Stage: October 7-10; October 13-16”. This records rules, not rights to ingest or publish live data.

| Source statement | Offline descriptor/transition | Synthetic regression |
| --- | --- | --- |
| Twelve direct entrants are split into pools A/B/C and four Play-In qualifiers join them; each group has four teams. | One observed group requires one entrant from each direct pool and one Play-In qualifier. No draw is generated. | Pool and group-size rejection. |
| No group may contain two teams from the same region. | Canonicalized region uniqueness within the observed group. | Mixed-case same-region rejection. |
| Each group competitor plays every other competitor twice. | Twelve unique game IDs, exactly two games for each of six pairs. | Complete 6/4/2/0 standings, incomplete and repeated-pair rejection. |
| The top two in each group advance to knockouts. | Only a complete group with a clear second/third win boundary yields qualifier IDs. | Exact two qualifiers and unresolved boundary tie. |

The primer does not give a tiebreaker procedure. A tie at the qualification boundary returns `tiebreaker-rules-unavailable`, including when all twelve scheduled games are observed. Extra games and a group-to-bracket handoff need a separate source and fixture. The replay has no historical rating inputs and always returns `historical-model-inputs-unavailable` for forecasts. Entrant/game references are supplied by the caller and tagged as synthetic or source observations; no fixture here claims an official observed result. This pure module is not wired to collection, publication, or the tournament UI.

Owner-only activation actions: confirm source-use rights, obtain licensed entrant/group and result observations with durable references, source the 2022 tiebreaker clauses and complete tie fixtures, source as-of rating/model inputs, and verify product journeys before enabling collection or published forecasts. Recheck `pnpm exec tsx --test tests/worlds2022ObservedGroups.test.ts`, `pnpm run typecheck`, `pnpm run lint`, and the required hosted Checks job on the exact activation head.
