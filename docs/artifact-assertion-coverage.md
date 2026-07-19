# Artifact assertion coverage

This maps the assertions that existed in `tests/artifact.test.ts` at `6b212e5e` to their resumable-storage test homes. Clean CI uses a deterministic temporary artifact graph. Claims tied to the current downloaded dataset live in the explicit `test:release-data` gate and never silently skip.

| Original assertion group | Classification | Current coverage |
|---|---|---|
| Browser payload budgets and absence of full audit payloads | Clean invariant | `tests/artifact.test.ts`: compact artifacts and browser contracts |
| Eastern/western region ordering and score separation | Live golden | `scripts/release-data-assertions.ts`: live release profile |
| LYON, DRX, and GiantX records/order | Live golden | `scripts/release-data-assertions.ts`: live release profile |
| T1 and Gen.G MSI evidence/order | Live golden | `scripts/release-data-assertions.ts`: live release profile |
| HTML entity escaping | Clean invariant | `tests/artifact.test.ts`: recursive path/content assertion |
| Snapshot index, filter, URL, and shard consistency | Clean invariant | `tests/artifact.test.ts`: snapshot/checkpoint consistency |
| Checkpoint limits and boundary wiring | Clean invariant | `tests/artifact.test.ts`; the current named 2026 boundary remains release-gated |
| Manifest URL file reachability/tracking | Clean deployment invariant | Recursive materializer validation replaces file tracking; `git ls-files public/data` must remain empty |
| Team-history index/shard consistency | Clean invariant | `tests/artifact.test.ts`: history index resolution |
| Observed match/current standing/region history family separation | Clean invariant | `tests/artifact.test.ts`: history-family assertion |
| Confidence and lineup evidence limits | Clean invariant | `tests/artifact.test.ts`: confidence/lineup assertion |
| Tournament index, movement arithmetic, and generic boundaries | Clean invariant | `tests/artifact.test.ts`; named Worlds/EWC/MSI dates and participants remain release-gated |
| Model, generated-at, config, and run provenance | Clean invariant | `tests/materializeRankingData.test.ts`: all-representation mismatch matrix and atomic preservation |
| Source coverage and shard reconciliation | Clean invariant | `tests/artifact.test.ts`: exact coverage reconciliation |
| Match display records, series/source details, and scoped history | Clean invariant | `tests/artifact.test.ts`; the named HLE/Gen.G series remains release-gated |
| Rated team universe across artifacts and histories | Clean invariant | `tests/artifact.test.ts`: rated universe assertion |
| Ranked player universe | Clean invariant | `tests/artifact.test.ts`: player/rated-team assertion |
| Displayed-team and role sample thresholds | Clean invariant | Deterministic 20-game sourced roster fixture plus `tests/artifact.test.ts` sample assertions |

`tests/releaseData.release.ts` is intentionally outside the normal `*.test.ts` clean suite. `pnpm test:release-data` fails clearly without `.generated/ranking-data`. Tests exercise its explicit deterministic-fixture mode separately; production use defaults to the live golden profile.
