# Incremental ranking rollout runbook

This runbook describes evidence collection only. It does not authorize a deployment, Railway configuration change, cron change, live probe, cleanup, or cutover. Production-like fixtures must always retain the `production-like-fixture` label and must never be reported as live or official LoL Esports evidence.

## Safe defaults

- `RANKING_INCREMENTAL_SHADOW_ENABLED=false` keeps shadow mode on the schedule probe path only. Set it to `true` only for an authorized evidence deployment; one scored-provider ingestion then feeds the candidate and authoritative full comparison.
- `RANKING_DAILY_AUDIT_ENABLED=false` disables the daily authoritative comparison. The default interval is `86400000` ms. `lastSuccessfulDailyAuditAt` advances only after a clean comparison, promotion, and full-audit receipt.
- `railway.refresh.toml` remains on the six-hour cron. A cadence of five minutes or less requires a complete, exact-commit, exact-deployment, unexpired gate receipt; booleans are not accepted as proof.

## Evidence sequence

1. Deploy an explicitly authorized shadow revision with the candidate feature enabled. Record the exact commit and deployment IDs.
2. Store each immutable receipt at `ops/rollout-evidence/runs/<commit>/<runId>.json`. A repeated identical write may be reused; a different body for the same key is a conflict.
3. Collect at least seven consecutive UTC dates of live comparisons, at least seven changed and seven unchanged runs, with no mismatch, partial comparison, fallback, or failure. Unchanged runs must record zero broad fetch, full build, incremental build, upload, and byte/object writes; because no candidate comparison ran, their parity fields remain `null` and their comparison is explicitly non-authoritative. A zero-mutation daily audit is recorded separately as `daily-audit`: it requires exact semantic, complete-state, and all-checkpoint parity plus an authoritative full promotion, and does not count as either a changed run or a cheap unchanged probe.
4. Exercise deterministic `latest-append`, `same-day-insertion`, `historical-correction`, and `tournament-transition` scenarios. Fixtures must be labeled `production-like-fixture`; they can establish scenario coverage but never increase live changed/unchanged counts.
5. Run coordination evidence only in `ops/rollout-probes/<safe-id>.json`. It must not touch `active-generation.json` or the production refresh lease.
6. Rehearse rollback under separate authorization, complete a recent clean daily audit, and capture measured CPU seconds, integrated memory GB-seconds, service egress, bucket storage, and optional volume usage.
7. Run `pnpm rollout:shadow-gate`, `pnpm rollout:gate`, `pnpm rollout:cost`, and `pnpm validate:rollout`. The five-minute validator accepts only a bucket `{key, sha256}` gate-receipt reference. Every run, audit, full-audit receipt, coordination proof, and rollback proof nested in that receipt is also a `{key, sha256}` reference which the validator re-reads and digest-checks from storage before recomputing the decision. Inline/local proof JSON, missing keys, and stored decision booleans are rejected.

## Failure handling

Any mismatch, partial comparison, candidate fallback, checkpoint rejection, provider failure, lost lease, or receipt conflict remains in the evidence corpus. Do not promote a candidate from such a run. Daily-audit state parity compares the canonical corpus ledger, compatibility contract, and every checkpoint; a newly issued source receipt may have a different receipt digest without changing that corpus authority. Daily-audit failures remain due and retry later; a mismatch may be corrected by the authoritative full publication but does not advance the successful-audit timestamp.

## Railway pricing model

Rates were verified on 2026-07-23: memory `$0.00000386/GB-second`, CPU `$0.00000772/vCPU-second`, volume `$0.00000006/GB-second`, service egress `$0.05/GB`, and bucket storage `$0.015/GB-month`. Bucket operations and bucket egress are free. Hobby billing is `max($5, metered usage)`, with $5 of included usage/minimum. See [Railway pricing documentation](https://docs.railway.com/pricing), [bucket billing documentation](https://docs.railway.com/storage-buckets/billing), and [Railway plan pricing](https://railway.com/pricing).

Service uploads to a bucket count as service egress even though bucket egress is free. Missing measurement is `unknown`, never an inferred zero. A run's aggregate CPU or integrated-memory measurement remains unknown when any child process is unmeasured, and the raw-source subprocess is recorded explicitly even when no resource telemetry is available. Bucket storage attribution is likewise unknown until measured; it is not a zero-cost bucket. The report shows separate resource and usage costs and explicit 2026, 2027, and 2028 corpus/run/storage growth assumptions.

Completion cost evidence is narrower than a projection: it must be a live, production-metered monthly report that explicitly excludes public traffic, contains measured CPU, memory, volume (zero is valid when no volume exists), service-upload egress, and bucket storage components, and has a natively recomputed eligible nontraffic total of at most `$5`. Partial reports, traffic-inclusive reports, and overages—including a reproduced `$76.58` total—remain `live-pending`.

## Completion audit

`docs/rollout-acceptance.json` is a descriptive, versioned mirror. The required IDs, evidence mappings, and status classes are fixed in `audit-plan-completion.mjs`, so editing the input cannot weaken the audit. Live completion evidence must be immutable `ops/**` `{key, sha256}` references re-read from bucket authority and checked against the expected commit and deployment. Prose, inline bodies, missing objects, local objects, and fixtures cannot prove a live or authorization-gated requirement. `audit-plan-completion.mjs` exits nonzero unless every required item is proved.

Seven repository-only requirements use a separate local authority and never count as live evidence: provider retry/call-site/deadline/next-attempt/backup behavior, complete immutable terminal receipts, storage-delivery integration, retention floors and fail-closed inventory, authoritative full fallback, atomic generation publication, and ranking provenance. Commit the implementation and its focused tests first, then generate ignored evidence for that exact clean commit:

```sh
COMMIT=<40-character-lowercase-commit>
pnpm rollout:implementation-evidence -- --subject-commit "$COMMIT" --authority-dir "$PWD/.rollout-evidence" --repository-root "$PWD"
```

The producer runs only fixed native commands and writes canonical, create-only objects under `.rollout-evidence/objects/sha256/<digest>` plus `.rollout-evidence/subjects/<commit>/manifest.json`. The artifacts contain no deployment, expiry, timestamp, or absolute-path claims. Digests are derived from `git show <subject>:<path>` and checked against working bytes. Resolution independently requires the same clean HEAD, reruns every fixed command without an injectable runner, and requires byte-identical fresh outcomes; stored pass counters are never trusted.

The authority must be the real, unsymlinked `<repository>/.rollout-evidence` child. Readers and writers reject external roots, traversal, symlinked roots/ancestors/objects, non-regular files, noncanonical JSON, digest mismatch, stale sources, dirty tracked or untracked files, and an old subject after HEAD advances. File descriptors use no-follow opens, regular-file checks, and `/proc/self/fd` realpath containment before and after I/O; inability to verify containment fails closed.

Validate that explicit local authority with:

```sh
pnpm validate:rollout -- --subject-commit "$COMMIT" --implementation-authority "$PWD/.rollout-evidence" --repository-root "$PWD"
```

Before live evidence is supplied, the expected result is a nonzero exit with `7 proved`, `0 contradicted`, `0 missing`, `8 live-pending`, and `5 authorization-gated`. The live-pending set explicitly includes seven-day shadow, deployment-bound gate, coordination, rollback, p95 freshness within 15 minutes of provider availability, latest-game `<15s`/`<750MB`/`<2MB` with no full rewrite, compressed generation `<=2.5MB` plus postmigration bucket `<350MB` with resolvable retained manifests, and measured nontraffic Railway usage under `$5`. Five-minute cadence, production config, incremental cutover, production storage-delivery cutover, and retention deletion remain authorization-gated. Repository evidence categorically cannot satisfy any of them.

The three production measurement rows have strict native live schemas. Each object is storage-resolved and digest-bound to the exact commit, deployment, environment, run, recorded time, and expiry. Freshness records the scored-provider first-capable-response basis and reports upstream delay separately; latest-game evidence records compute, peak RSS, upload bytes, and full-rewrite bytes; storage evidence records full-generation compressed bytes, postmigration bucket bytes, and resolution of every retained manifest. Threshold failures, fixtures, inline objects, stale metadata, or extra/missing fields do not prove a row.

Authorization transitions use `ranking-rollout-production-action-receipt`, never a generic rollout gate decision. A receipt proves exactly one action and contains an explicit human approval identity/ID/time, successful production execution time, exact commit/deployment/environment, expiry, and action-specific assertions. Cadence must actually be active at five minutes in gated mode; production config must be applied; incremental cutover must be active; presigned delivery and proxy fallback must both be active; retention deletion must bind the exact human-approved inventory digest. Cross-action receipts, generic booleans/gates, inline values, and local repository authority remain authorization-gated.

In gated or shadow refresh mode, cadence rejection, invalid lease configuration, lease-acquisition failure, and lease-acquisition skip are terminal runs too. When bucket storage and rollout identity are available they pass through the same immutable rollout-evidence hook as post-lease outcomes. If storage itself is unavailable, startup still fails closed and does not claim that a receipt was written.
