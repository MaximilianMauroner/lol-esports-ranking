# Worlds observed knockout bracket slice (#47)

This is an offline 2025 fixture/state transition layered on the Swiss observed replay. The input must include a complete 2025 Swiss replay, an evidence reference for the **observed** quarterfinal draw, eight ordered bracket slots, and whole completed knockout rounds. The test IDs are synthetic. No bracket draw is generated and no live source or publisher calls the module.

| Primary Riot clause | Transition/check | Test |
| --- | --- | --- |
| [Worlds 2025 primer](https://lolesports.com/en-US/news/worlds-2025-primer), “The Knockout Draw”: eight Swiss qualifiers, 2 at 3-0, 3 at 3-1, 3 at 3-2 | Require 16 completed Swiss entrants and exact 2/3/3 qualifier records | `worldsObservedBracket.test.ts`, source and qualifier validation |
| Same clause: each 3-0 team draws a 3-2 team and the 3-0 teams go on opposite bracket sides | Check all four observed quarterfinal pairs and separate halves | draw restriction cases |
| Same clause: remaining teams drawn in sequence without restrictions; knockout schedule lists quarterfinals, semifinals, final, all Bo5 | Accept the supplied complete bracket only; carry winners along fixed QF→semi→final links | fixed-link full replay, invalid re-seed and incomplete-round cases |

The primer does not provide a machine-readable draw receipt or the probabilistic semantics of every draw/redraw step. The module therefore accepts only observed bracket positions and winners and always reports `forecast.status: unsupported`. It does not infer placements from rankings, simulate series scores, publish a champion, or claim a synthetic fixture is an official event result. The caller asserted `drawEvidence` reference is a trust boundary; official use requires checking the cited draw against a source artifact.

Owner-only gate for an official event: retain the dated draw video/transcript or official bracket artifact with slot IDs and timestamps; compare each slot and completed series winner against the source fixture; attach the comparison and correction history. Obtain the current 2026 draw and bracket clauses separately before any 2026 descriptor is enabled. The provider rights, complete windows, model, browser, CI, and product gates in [the preceding rules audit](worlds-observed-rules-47.md) remain in force.

Offline test steps: `pnpm exec tsx --tsconfig tsconfig.app.json --test tests/worldsObservedRules.test.ts tests/worldsObservedBracket.test.ts`, `pnpm run typecheck`, `pnpm run lint`, and the hosted exact-head Verify/production-shaped benchmark/bundle. Attach the command output, exact commit and source artifact identifiers before any integration.
