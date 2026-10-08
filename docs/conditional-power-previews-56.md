# Conditional Power previews (#56)

The supported slice includes a partial numeric preview for the stable-team
series-result component, an offline complete-input replay and a match card with
legal winner/score controls. Both calculations use production functions and
public endpoint conversion. The partial component requires an exact producer
state and pinned event mapping; a forecast alone cannot supply these inputs.
No production activation or real artifact publication occurs. The existing
forecast flag controls the card. Projected ranks and tournament simulation
strength changes are excluded.

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
| Event region, tier, phase, weighting and lifecycle | Schedule is insufficient | Pin explicit event metadata and the complete replay context; reject conflicting game regions |
| Team home-league identity | Competition labels do not establish membership | Require explicit, unambiguous latest historical home-league evidence matching each team profile |
| Future time, patch, sides and game order | Unknown | Require every game explicitly; one later UTC date only |
| Five-role lineup identities and player prior edges | Roster basis alone is insufficient | Require complete lineups and explicit available prior edges |
| Kills, gold, towers, dragons, barons and duration | Unknown | Require finite supplied values; absent objectives do not become zero |
| Other future series and future event placements | Unknown | Excluded; lifecycle and all other evidence are held fixed |

## Evaluation and units

`prepareConditionalPowerReplayBasis` implements the internal adapter in the
preview module. It clones a caller-supplied historical prefix, team directory
and explicit tournament lifecycle map. It derives causal historical player
edges with `createRatingReplayContext`, replays the complete prefix with
`replayRatingDates`, and uses the production checkpoint encoder/decoder to
validate state shape and pin the payload digest. Importer version, identity
taxonomy hash and raw prefix hash are included in the pre-state identity.
Every evaluation must parse that structured identity and verify the state's
payload digest through the production checkpoint schema before projection.
Missing pins, arbitrary labels and finite scoring-state changes under an
unchanged digest return unavailable. A deliberately changed valid state needs
a new checkpoint pin. This proves integrity of the pinned inputs; it does not
certify the producer's source evidence.
The preview pin also binds the complete `RatingReplayContext` with a separate
`contextDigest` from the existing canonical causal serializer. This covers the
authoritative matches, team directory, last UTC date, historical player edges,
roster bases, event calendar and lifecycle map. Coordinated corpus and directory
changes cannot retain the same pre-state identity. Object and map insertion order
do not change this digest; the production-sorted match order stays significant.
A changed source basis must be rebuilt with a new context and state pin. This is
an internal preview field, not a production checkpoint schema change.
No checkpoint file is written. Incomplete historical stats, lineups, profiles,
format or chronology are rejected before replay. Both the adapter and directly
supplied bases use the same historical series guard. The production canonical
resolver must prove a legal decisive final score for every historical series,
with official or provider format evidence for every game. Every historical
series must fit one UTC replay date, matching production's grouping at that
boundary. Ongoing, unknown or cross-date historical series are unsupported by
this complete-input slice. Fresh state and context pins prove input integrity;
they do not replace these completeness checks.

The source producer must identify the supplied prefix as complete, including
all games on its terminal UTC date. A caller-supplied hash does not certify
provider completeness. The adapter records the identities of historical games
whose production pregame player prior is unavailable, including cold starts.
It preserves production initial priors and never describes those gaps as
confirmed lineup evidence. Future games still need explicit available player
edges and complete inputs. This adapter is a supported implementation choice
within #56; defining it is not deferred to Max or the model owner.

`evaluateConditionalPowerReplay` accepts only caller-supplied synthetic games.
It clones state, context, games and player edges, calls `replayRatingDates`, then
`materializeRankingModel`. Both before and after use the same production standing
projection and `publishedRating` with the pinned scale. The delta is the difference
between those public endpoints, including rounding and clamping. It is not a
scaled probability, raw internal stable delta, history rank, or promise about a
future publication. The complete conditional result holds all supplied inputs
fixed. It does not assert that those future inputs are known for a real match.
The complete historical roster-basis map must match the production derivation
from the supplied corpus, including teams outside the selected series. Missing,
extra or changed entries return unavailable before the baseline projection.
Hypothetical raw/canonical game and series identities must be distinct from the
historical prefix. Each historical team's latest date must contain explicit,
consistent home-league source fields matching its profile. Absent or conflicting
membership evidence returns unavailable; the mutable directory fallback and
coincident league dates cannot supply that proof. Supplied hypothetical team
region overrides must match the directory, and every game region must match the
pinned event region.
Within both historical and hypothetical inputs, every raw, official and source
game alias must belong to one record. Repeated aliases within that record are
valid. Conflicting records return unavailable; the preview cannot drop evidence
or invent a replacement identity.
Every historical official, source and production-normalized series alias must
also belong to one canonical series. All games within that series may share an
alias. Cross-series reuse returns unavailable before replay or projection.
Supplied player edges must obey the current production cap and its zero-adjustment
rules below minimum coverage or at zero freshness. Explicit zero edges remain
supported; the preview never scales adjustments by an invented probability or
coverage formula.
Series and game timestamp offsets are normalized to UTC. All hypothetical games
must share one future UTC date after the pinned complete boundary; a timestamp's
local date prefix cannot choose the replay date.
Historical timestamps remain optional. The adapter rejects invalid or
date-contradictory supplied clocks and normalizes valid clocks to UTC ISO strings
before replay. It does not create times for date-only records. An existing pinned
basis with clocks that need normalization must be rebuilt through the adapter;
the evaluator cannot change those clocks without changing its historical state.
Every historical team and observed home league must also have the scoring and
clock entries produced by the engine. A new payload pin cannot make omitted
entries complete. The complete, sourced roster requirement applies to the two
selected participants; valid partial third-team roster evidence stays supported.

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

## Remaining source and authority dependencies

The public #46 receipt is a forecast receipt, not a lossless state checkpoint.
Published ratings and components are rounded, scaled, capped or compressed.
They cannot recover the raw residuals that the production update consumes.
The current worktree contains a raw manifest, but no complete raw historical
corpus in `data/raw/`. Its external file references are not accessed here.

| Missing input | Exact fields or evidence | Responsible source and next action |
| --- | --- | --- |
| Reproducible historical pre-state | Complete `MatchRecord` prefix with decisive historical series and explicit latest `teamAHomeLeague`/`teamBHomeLeague`, `TeamProfile` directory, lifecycle map, importer/taxonomy/prefix identity and complete UTC boundary | Ranking corpus/artifact producer (`scripts/build-static-snapshot.ts`, #46/#37) must provide an authorized offline immutable copy. The adapter now reconstructs the state; no implementation decision from Max is needed. |
| Raw internal state if a checkpoint is supplied instead | Team `ratings`, `executionRatings`, `rosterPriorOffsets`, `momentums`, `uncertainties`; raw league scores/counts/records; full histories, decay dates, roster state, event trackers and terminal identities | Existing production checkpoint/corpus producer owns the evidence. Compact public standings and forecast receipts are insufficient. This slice reconstructs from a complete corpus rather than introducing a new checkpoint/public contract. |
| Real event assumptions | Canonical event/team/series mapping, region, tier, phase, lifecycle and pinned event calendar | Canonical schedule/event producer must provide the sourced mapping. Schedule labels alone cannot establish weighting or terminal placement evidence. |
| Future game inputs | Five-role player IDs, causal player edges, patch, side assignment, UTC date/time, ordered games, kills/gold/objectives/duration | Official/provider lineup and game sources own confirmations. Before play, performance stats are unknown. Full future deltas remain unavailable unless every input is explicitly supplied as a hypothetical assumption. |

`evaluateConditionalPowerResultComponent` applies only the production stable-team
result deltas to a detached snapshot. `calculateSeriesResultUpdate` is the shared
production boundary; the engine still applies its original form, league and
execution updates. No model parameter changes accompany this extraction.

The component freezes snapshot player priors, lineup continuity, momentum,
uncertainty, league scores, records and historical evidence. It recomputes the
production standing projection after changing only the two stable ratings.
The scheduled UTC date selects event weighting. Time decay, patch changes,
placements, other future matches and game-performance training are excluded.
These assumptions appear on the card. The number is labeled **Stable-team result
component**; the full future Power delta remains unavailable.

`createConditionalPowerResultReceipt` produces all legal outcomes from exact
state and the same public forecast basis. Both baseline endpoints must match
current public Power. Receipts bind model/config, scale, event/source state,
identity-map revision, snapshot, dates and the state/context digest.
`publishConditionalPowerResultOffline` persists immutable local receipts;
`readConditionalPowerResultsOffline` validates them. `conditionalPowerResultArtifact`
assembles the optional `forecasts/power-previews.json` companion in memory for
`/tournament-data/forecasts/power-previews.json`. It does not deliver or publish it.
The UI loads it read-only and rejects stale or ambiguous inputs. No raw state
enters the browser bundle. Missing companions preserve the existing unavailable
state. Production delivery remains a separately authorized producer action.

The Rust owner confirmed no overlapping ownership of the shared TypeScript series
calculation or snapshot projection. Migration, CLI, contracts, benchmark and
harness work remain with that owner.

Completed lifecycle boundaries after the pinned pre-state are unsupported in
this slice. Prefix-only event trackers cannot apply a newly completed future
event's placement evidence. The evaluator rejects that assumption explicitly;
historical pending placement evidence remains part of the production replay.

Historical canonical series crossing UTC dates are also unsupported. Production
resolves each date's subset separately, so incomplete subsets have no decisive
series-result update. The adapter rejects that corpus; removing its games would
violate the complete-prefix requirement. Broader support needs a separately scoped
production atomicity change coordinated with #84.

Each historical canonical series must have one event name, league, phase, region
and tier across its games. Production uses the final game's scoring context, so
conflicting rows cannot establish a consistent pre-state. Supplied official event
IDs must agree. Historical records with all IDs absent or with one compatible
supplied ID remain supported.

## Acceptance limits and checks

Controlled fixture parity covers both winners, all decisive Bo1/3/5 scores,
domestic/Worlds tiers, strong teams above the public soft cap, normal/compressed
scales and endpoint caps. Isolation checks compare all input data and caller
stores, trap writes on an input rating map, and reject provider calls. Unsupported
model, state, event, format, roster, stats, prior edges and scores fail closed.
The existing forecast browser journey checks public missing-data reasons,
keyboard/mobile selection, basis refresh, live closure and frozen receipt odds.

The numeric companion is implemented and verified with controlled offline inputs.
Real public-match coverage still requires the ranking producer's authorized exact
state and a reviewed schedule-to-production event mapping. The local public
reference omits raw state and cannot recover it from rounded Power. No provider
or production access is performed here. Future statistics cannot be obtained
before play, so complete future deltas remain unavailable by design; the stable
component is the supported calculation permitted by #56.

Controlled/browser evidence does not establish real-generation or user acceptance.
Keep #56 open while those source and delivery requirements remain unsatisfied.
#37's real generation reconciliation remains owned by its separately authorized
production replay. Historical heap disposition is a separate merge hold; passing
preview tests cannot waive it.
