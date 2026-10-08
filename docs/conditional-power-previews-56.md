# Conditional Power previews (#56)

The supported slice is an offline, complete-input conditional replay and a match
card that explains public unavailability. It does not activate production or
publish a preview artifact. The existing tournament forecast flag controls the
card. No projected ranks or changed tournament simulation strengths are included.

## Dependency state

PR #41 (#37 projection repair) and PR #42 (#38 public scope explanations) are
merged into this branch's base. #37 remains open for separately authorized
production replay/publication. This task does not perform that operation.
#46's forecast adapter and immutable receipts are present. Its public receipt
contains Power, uncertainty, roster basis, model/config and snapshot identity.
It does not contain `RatingRunState`, event weighting/lifecycle, roster identities
or the detailed inputs needed to replay a future series. The Rust #84 migration
and PRs #85–89 are separate work; no migration, CLI or contract changes belong here.

## Production input audit

`processRatingUtcDateBoundary` applies pending placement evidence, entity-local
time/patch/season/split decay, roster continuity and the production series update.
`processRatingSeriesForDate` takes one pre-date snapshot and updates team and league
result strength once on the decisive final game. Sweeps and longer series have
different production strength signals. Performance statistics train the separate
execution channel; that channel is shadow-only under the current config. They
must still be supplied to a complete replay, rather than filled with fake zeros.

| Input | Before a public match | Offline evaluator policy |
| --- | --- | --- |
| Canonical source participants, series and event | May be known in #45/#46 | Require exact IDs and an explicit internal team mapping |
| Format and final score | Format may be known | Accept only decisive Bo1/3/5 and legal terminal scores |
| Full internal state and league state | Absent from public receipts | Require a complete identified prior UTC boundary |
| Model/config and public scale | Present with a valid forecast basis | Match this evaluator's production config; validate the explicit output scale |
| Event tier, phase, weighting and lifecycle | Schedule is insufficient | Pin explicit event metadata and the complete replay context |
| Future time, patch, sides and game order | Unknown | Require every game explicitly; one later UTC date only |
| Five-role lineup identities and player prior edges | Roster basis alone is insufficient | Require complete lineups and explicit available prior edges |
| Kills, gold, towers, dragons, barons and duration | Unknown | Require finite supplied values; absent objectives do not become zero |
| Other future series and future event placements | Unknown | Excluded; lifecycle and all other evidence are held fixed |

## Evaluation and units

`evaluateConditionalPowerReplay` accepts only caller-supplied synthetic games.
It clones state, context, games and player edges, calls `replayRatingDates`, then
`materializeRankingModel`. Both before and after use the same production standing
projection and `publishedRating` with the pinned scale. The delta is the difference
between those public endpoints, including rounding and clamping. It is not a
scaled probability, raw internal stable delta, history rank, or promise about a
future publication. The complete conditional result holds all supplied inputs
fixed. It does not assert that those future inputs are known for a real match.

The returned offline result keeps a detached copy of the entire input tuple,
including pre-state, event/lifecycle context, game assumptions, roster/player
inputs, scale and chosen outcome. No evaluation cache or persisted preview store
exists. Every call evaluates its current tuple. The public card resets its
selection when its source or forecast basis changes and removes selectors when
play begins or the scheduled start passes. Actual completed rating impact remains
in the evidence ledger. Pre-match odds keep their existing immutable receipt.

The wrapper has no publishing, provider, acknowledgement or artifact-write API.
Errors return unavailable after any working-state changes have occurred only on
clones. Closing the selector has no write effect. There is no compatibility code
or public schema migration.

## Acceptance limits and checks

Controlled fixture parity covers both winners, all decisive Bo1/3/5 scores,
domestic/Worlds tiers, strong teams above the public soft cap, normal/compressed
scales and endpoint caps. Isolation checks compare all input data and caller
stores, trap writes on an input rating map, and reject provider calls. Unsupported
model, state, event, format, roster, stats, prior edges and scores fail closed.
The existing forecast browser journey checks public missing-data reasons,
keyboard/mobile selection, basis refresh, live closure and frozen receipt odds.

Full #56 acceptance remains blocked: numeric previews for real public matches
need an approved internal pre-state/provenance adapter plus verified event and
future-input assumptions. #46 public receipts do not supply those inputs. The
ranking/model owner must define that adapter and coverage policy in a later slice.
This PR must not close #56 or claim numerical public preview acceptance. Synthetic
fixture/browser evidence proves only the supported slice, not production or user
acceptance. #37's real generation reconciliation remains owned by its separately
authorized production replay. No model parameters change here.
