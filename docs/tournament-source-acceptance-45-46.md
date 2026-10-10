# Tournament source and forecast acceptance

The merged #57/#60 foundations remain default-off. Isolated publication fencing,
source audit and public delivery observation do not activate a live collector or
change ratings. Current source reports, observations and checks belong in
[issue #45](https://github.com/MaximilianMauroner/lol-esports-ranking/issues/45),
[issue #46](https://github.com/MaximilianMauroner/lol-esports-ranking/issues/46)
and ignored `.agents/artifacts/refresh-live-20261009/`.

## Source and operational gates

The retained ranking reference captures use unsupported persisted site APIs.
[The recorded source-use decision](https://github.com/MaximilianMauroner/lol-esports-ranking/issues/45#issuecomment-5868131782)
requires the source owner to confirm polling and public redistribution terms or
name an approved replacement before staged/production polling or publication.
Successful endpoint access, captures and code merges do not supply that approval.
Ranking ingestion #78 and coverage #81 are separate from live-feed acceptance.

Require representative discovery, lifecycle and correction evidence for LCS,
LEC, LPL, LCK, MSI, Worlds and First Stand. Preserve unknown format/team/status
values. Record pagination and date boundaries; a partial successful page cannot
prove an empty competition. `audit-tournament-source.ts` can inspect retained
captures without new provider requests or runtime name joins.

The existing collector's maximum is 137 logical requests per run: one first
page, 16 cursor pages and 120 details. Three attempts each allow 411 HTTP
attempts. At the maximum every minute, that is 197,280 logical requests or
591,840 attempts per day. These are bounds, not an approved cadence or source
SLA. Obtain an approved budget and measure requests, 429/Retry-After response,
source-to-viewer latency, freshness, partial failure and recovery before enabling
collection. A real multi-host service run is required for operational acceptance.

## Isolated publication

`tournament-feed-storage.ts` requires a separate tournaments prefix. It writes
immutable canonical feed objects with conditional creation, validates metadata
and content, and promotes through the ETag that owns the lease. Complete
unchanged observations update health without new content. Older/incomplete
observations retain last-good content. Readers verify content and recheck the
pointer ETag.

Dependency-backed tests cover corrections, last-good/unchanged behavior,
corruption, ranking-prefix rejection and takeover before verification and
at final CAS. They use simulated storage. A separate Rust MinIO test does not
certify this publisher. No CLI, scheduler or production serving caller connects
this isolated publisher yet. Add and verify that integration against the approved
source before activation; do not interpret an isolated module as a live service.

## Participant mapping

[The explicit mapping review](tournament-team-mapping-review-46.json) pins
retained capture identities, canonical ranking IDs and the served directory
identity for eight reviewed stable bindings. It is an offline partial record,
not an installed public crosswalk or a current Worlds entrant claim. Other
participants require identity/alias/organization review. Exact-name candidates
never become automatic mappings or runtime join keys.

Complete mappings against the approved current source and valid ranking rows.
Missing participants, scales, model/config, formats or pre-series inputs retain
typed unavailability. Do not invent ratings or coerce unsupported formats.

## Immutable ledger and public delivery

`observeForecastDelivery` reads an independently served ledger with no redirect
or token-bearing URL. It validates an identical immutable receipt, records exact
response/receipt hashes and local completion time, and requires completion before
scheduled start. Origin Date cannot backdate observation. The existing offline
write-once/fsync store persists this evidence; it is not a production ledger
publisher or a full response-body archive.

Dependency-backed tests cover identity/timing, missing/changed receipts, HTTP
failure, URL restrictions, store immutability and the 8 MiB body limit. Adapter
and isolated browser tests cover supported Bo1/3/5, score-conditioned live odds,
and frozen upcoming/live/finished receipts. Synthetic journeys prove these
behaviors, not real-source/public delivery or actual-play provenance.

Keep `evaluationEligible: false` until a reviewer certifies the provenance
contract with real immutable ledger publication, independent public delivery
and a trusted actual-first-play boundary. Scheduled start alone is insufficient.
Corrections must retain original mapping revisions and stored receipts.

## Worlds companion boundary

The separate #47 engine/UI owner reads an optional companion at
`/tournament-data/worlds/<encoded event ID>.json`, bound to the selected event
content key. For 2026, each result's `matchId` must equal the selected feed
`series.id`. Confirmed result IDs, winner, score and best-of must agree even
when the event key matches. Live/unresolved played-game evidence keeps precise
advancement unavailable until live game conditioning exists.

This source/forecast layer does not create or certify that companion. The
Worlds UI adds no producer, publication or source activation. Its synthetic UI
checks cannot substitute for #45/#46 acceptance.

## Owners and release gates

The source owner/Max confirms permitted source use. The source/collector owner
then proves seven-family coverage, corrections, approved budget, latency,
freshness/recovery and multi-host publication. The forecast owner/reviewer
completes current mappings, immutable ledger, public delivery and actual-play
certification. This thread owns independent implementation and affected checks.

Keep source checks, local/hosted tests, review, merge, deployment and product
acceptance separate. Required CI/bundle and isolated browser journeys must pass;
no check is waived by the external source gate. Keep both issues open while real
source or delivery evidence is missing. No compatibility path is added. Separate
ranking/tournament storage and false evaluation eligibility are permanent
integrity requirements. Certified mapping revisions may replace offline review
records, but published receipts and their original revisions remain immutable.
