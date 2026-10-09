# Tournament source and delivery acceptance, 9 October 2026

The merged #57/#60 foundations remain default-off. This work adds isolated
publication fencing, a retained-source audit and a public delivery observer.
It does not certify a live source, activate a collector or change ratings.

## Retained source evidence

The audit read five existing schedule captures from 9-26 July 2026 without
changing them or making provider requests. Input hashes and byte counts are in
the mapping review companion. These are ranking reference captures from the
unsupported persisted site API. The source-use decision in
[#45's recorded comment](https://github.com/MaximilianMauroner/lol-esports-ranking/issues/45#issuecomment-5868131782)
still applies: polling and public redistribution rights are unverified.

| Family | Representative retained observations | Missing evidence |
| --- | --- | --- |
| LCS | 6 completed series in the 9 July capture; 2 upcoming and 2 unresolved in the 26 July capture | Complete current discovery and correction ordering |
| LEC | 8 completed in the 9 July capture; upcoming/live/completed/unresolved on 26 July | Current discovery and timed recovery |
| LPL | 16 completed on 9 July; 3 upcoming and 9 completed on 26 July | Current discovery and timed recovery |
| LCK | 18 completed on 9 July | Upcoming/live lifecycle |
| MSI | 10 completed and 1 live on 11 July | Complete pagination and measured latency |
| Worlds | No scoped observations | Representative permitted capture |
| First Stand | No scoped observations | Representative permitted capture |

Counts are per capture and can overlap. They are not unique season totals.
The broad captures contain detail-limit and earlier-boundary warnings.
Successful absent rows do not prove an empty competition. Ranking coverage in
#78/#81 does not close these gaps.

The current collector can make 137 logical requests per run: one first page,
16 cursor pages and 120 details. With three attempts each, the upper bound is
411 HTTP attempts. Running that maximum every minute would make 197,280 logical
requests, or 591,840 attempts, per day. These bounds require an approved budget;
no timer or cadence was enabled. Existing targets of 120 seconds delivery and
three missed active intervals for stale state remain unmeasured.

`scripts/audit-tournament-source.ts` records retained coverage, input identities,
source participant IDs and exact-name review candidates. It never accepts a
mapping from a display name, and it never calls a provider. A native Node test
passes with a 128 MiB heap: one stable ID observed under two names remains an
ambiguous review candidate and its source file remains unchanged.

## Durable isolated publication

`scripts/tournament-feed-storage.ts` requires the separate `tournaments` prefix.
It writes immutable canonical feed objects with conditional creation, validates
their metadata/content and promotes through the same pointer ETag that owns its
lease. Complete unchanged observations update pointer health without creating
new feed content. Older and incomplete observations retain the last good feed.
Readers verify the content and recheck the pointer ETag.

The test covers takeover before verification and during the final conditional
write, corrections, unchanged health, corrupt content and ranking-prefix
rejection. Runtime acceptance is pending guarded dependency setup and hosted CI.
There is no CLI, scheduler or production caller. The existing local collector
and serving adapter are not connected to this bucket publisher. That integration
and a real multi-host service run remain required before activation.

## Participant and forecast delivery evidence

The audit found 39 distinct source team IDs. Twenty-one have one exact-name
candidate in the current served team directory; 18 need alias or organization
review. Those numbers do not mean 21 accepted mappings.

[The explicit mapping review](tournament-team-mapping-review-46.json) records
eight stable identity bindings for T1, G2, FlyQuest, Anyone's Legend, Hanwha Life
Esports, Dplus KIA, BNK FEARX and Karmine Corp. Source IDs, retained capture
digests, canonical ranking IDs and domestic competition agree. This is a narrow
offline review record for independent PR assessment. It is not installed as the
public crosswalk, does not cover every participant, and does not claim current
Worlds entrants. Other aliases remain unmapped.

The public team directory was read through its immutable content URL. Its
validated SHA-256 is
`1bc7d1bfb807a577df5fd60cbab94b25bc69d692b4f1a8118d31b2f2b427403d`,
26,313 decoded bytes, with 110 teams. The manifest model is
`transparent-power-index-v0.2.0` / `fnv1a-5eebb6ce`, generated at
2026-10-09T00:09:36.062Z. A legacy logical-directory request timed out; the
immutable URL succeeded and matched the manifest. This does not prove all
public delivery paths are healthy.

A read-only public check returned HTTP 404 for `/tournament-data/feed.json`,
`/tournament-data/forecasts/team-ids.json` and
`/tournament-data/forecasts/ledger.json`. No real public forecast ledger or
before-play delivery is established. The collaborative browser showed the
working ranking board with Rankings/Regions/Matches navigation. That is web
health evidence, not tournament acceptance.

The separate #47 owner reports an optional Worlds companion at
`/tournament-data/worlds/<encoded event ID>.json`, bound to the selected event
content key. That work owns its engine/UI and has no active producer or source
publication. This feed/forecast layer does not create, serve or certify that
companion, and cannot count its synthetic UI checks as #45/#46 source acceptance.

`observeForecastDelivery` fetches an independently served ledger with no redirect
or token-bearing URL, records exact response/receipt hashes and local completion
time, and requires an identical immutable receipt before its scheduled start.
The origin Date header cannot backdate that observation. The offline receipt
store persists the observation through its existing write-once, fsync path.
Synthetic tests cover missing/changed receipts, late observation, HTTP failure,
URL restrictions and an 8 MiB body budget. Those tests still need hosted execution.
Independent source execution with a transport shim passed all three new feed
tests and the new delivery cases. This does not supply AWS/MinIO, typecheck or
browser acceptance.

Every observation and receipt retains `evaluationEligible: false`. Scheduled
start is not proof of actual first play. An approved source, independently
trusted actual-play boundary and reviewer certification remain required. The
existing Bo1/3/5, score-conditioned and upcoming/live/finished suites are the
affected product checks; no missing ratings, team IDs or formats are invented.

## Remaining gates

1. Source owner/Max: confirm polling and public redistribution terms, or name an
   approved replacement. No response or elapsed time is approval.
2. This thread: complete compiled/hosted publisher and delivery tests, then the
   isolated browser journeys when dependencies and resource admission permit.
   No nesting or branching metric is configured; normal ESLint remains required.
3. Source/collector owner: supply representative permitted coverage for all
   seven families, corrections, request counts, latency, stale recovery and a
   real multi-host run before connecting and enabling the publisher.
4. Forecast owner/reviewer: complete the participant crosswalk against that
   source, publish a real immutable ledger and retain independent delivery and
   actual-play observations. Certify the provenance contract before eligibility.

No compatibility path was added. The permanent separation from ranking storage
and false evaluation eligibility protect independent source/provenance gates.
The offline review file can be replaced by a certified revision after approval;
stored receipts and their original mapping revisions must remain immutable.
Both issues stay open.
