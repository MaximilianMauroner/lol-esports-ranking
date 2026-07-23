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

## Completion audit

`docs/rollout-acceptance.json` supplies the versioned acceptance identity, while the required requirement IDs and their allowed proof kinds are fixed in `audit-plan-completion.mjs` so an edited input cannot weaken the audit. Completion evidence must be an array of immutable `ops/**` `{key, sha256}` references; the audit re-reads and digest-checks each object and validates it against the expected commit and deployment. Prose, inline bodies, missing objects, and fixtures cannot prove a live requirement. Live seven-day, deployment, coordination, rollback, and usage requirements remain `live-pending`; cadence, configuration, and cutover remain `authorization-gated` until separately authorized. `audit-plan-completion.mjs` exits nonzero unless every required item is proved.
