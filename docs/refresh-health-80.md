# Refresh health investigation, 9 October 2026

Read-only checks at about 22:10 UTC distinguish the web service from the scheduled
refresh. Both use the #90 main revision. No deployment, retry, settings change,
production database read or bucket write was made.

## Serving and failed work

GitHub deployment 6955355437 still records success at 07:30:15 UTC and failures
at 12:14:03 and 18:17:27. Its descriptions are empty. The preceding #93
deployment 6947954476 remains inactive after its recorded recovery.

Railway project `2bf26cbc-4cfa-4114-87c0-83b446f30816`, production environment:

- `web`, deployment `214b422e-9784-4b94-bdf7-ae43d4a5eefa`, is SUCCESS with a
  RUNNING instance. `/api/live` returns HTTP 200 and the #90 revision;
  `/api/ready` returns HTTP 200 with app ready and local data. The collaborative
  browser loads the ranking board. This establishes current serving health,
  not refresh freshness or long-term availability.
- `ranking-refresh`, deployment `4be8597b-ab6d-4073-9d62-a50c6d5d80cf`, is
  CRASHED. The build completed. The 18:06:27 daily-audit run failed after
  653,092 ms with a V8 heap-limit error and SIGABRT. The prior deployment's
  12:02:28 daily audit failed in the same way.

The refresh logs finish provider downloads, write a three-scope candidate, then
write the full 80-snapshot artifact. Full public serialization completes at
18:16:46 with 26,816 imported games, 5,414 rated games, 305 public artifacts and
32,281,989 public bytes. At 18:17:20, V8 reports allocation failure and ineffective
mark-compacts. No completed state-persistence or promotion stage is recorded.
The parent labels the entire child command `provider-fetch`; that label does
not establish that an HTTP request failed or caused the allocation.

Both services resolve Node 24.21.0 and pnpm 11.16.0 through Railpack. The refresh
has `RANKING_REFRESH_MODE=gated`; `RANKING_DAILY_AUDIT_ENABLED` is unset, so #78's
enabled daily audit default applies. `RANKING_RAW_SOURCE_WORKER` and
`RANKING_PROVIDER_FETCH_WORKER` are unset, so Node remains active. `TZ` and
`LANG` are unset in service variables; the actual image defaults are unverified.
Service `NODE_OPTIONS` is 8192 MiB, but the refresh child explicitly uses the
2048 MiB old-space ceiling from `refresh-worker-memory.mjs`. No heap ceiling
was changed during this investigation.

Oracle reported Google Drive quota exhaustion. Leaguepedia fetched 215 rows
and LoL Esports fetched 51 schedule events and 50 details. These warnings are
separate from the later confirmed heap failure. Ingestion is enabled and runs;
these failed audits do not prove successful publication or current coverage.

## Source repair and limits

The daily audit compares complete incremental state after the full snapshot.
Its comparison previously kept two full canonical state strings, then built
checkpoint strings again for equality, digests and mismatch traversal. The
repair computes the same SHA-256 identities in bounded chunks and reuses the
checkpoint digests. Successful comparisons skip mismatch traversal. Integrity,
comparison outcomes, report fields and publication gates remain in place.

This removes a concrete large temporary allocation. It does **not** establish
the exact allocation that killed the production process. The preceding full
checkpoint replay and retained full snapshot are other possible contributors.
An isolated real-input daily-audit reproduction is required before claiming
that the production failure is repaired.

The separate historical local #90 abort was near a 1570 MiB V8 heap limit below
the 3 GiB Fleet group limit. Its retained process stamps did not capture the
failing PID's arguments, parent or application phase. Setup versus verifier
attribution remains unproved. #93 improves future receipts; it cannot recover
that missing historical evidence.

## Checks and remaining gate

Passed: two canonical digest checks compare exact hashes with the existing
serializer, including UTF-16 key order, Map/Set, sparse arrays, number text,
flush boundaries and mutations. `git diff --check` passes.

Hosted #94 run 37997888569 passed typecheck, lint, 1,051 unit/integration tests
and all three browser suites. Fourteen opt-in native tests were skipped.
The production-shaped benchmark preserved exact parity, zero differing paths,
one-match replay and its compute/upload targets, but failed the unchanged
734,003,200-byte RSS safety limit: first-repetition peak was 742,895,616 bytes.
The next repetitions were 596,500,480 and 600,629,248 bytes. Bundle was skipped.
This is a real failing gate and is not waived.

That measured worker uses the `pending-match` gated path. The changed state
comparison runs only in shadow/daily-audit branches, so the measured failure
does not isolate that helper as its cause. Earlier #90 CI peaked at
631,705,600 bytes; the runner executions are not a controlled A/B comparison.
The retained stages locate the higher first-run memory in replay/player/state
work. An admitted diagnostic run is needed to explain it. The separate full
verifier peaked at 2,015,375,360 bytes and is explicitly outside the incremental
production RSS gate; it must not explain the measured-worker failure.

Later [PR #95 run 38000404426](https://github.com/MaximilianMauroner/lol-esports-ranking/actions/runs/38000404426)
passed the same unchanged incremental gate and bundle, with the #94 repair in
its stack and Node still selected. Its three peaks were 596,459,520,
582,643,712 and 635,723,776 bytes, with exact parity and zero differing paths or
identities. Maximum normalized compute was 6.2643 and upload was 1,527,742 bytes.
This adds evidence of variation between runner executions. It does not isolate
the cause, replace #94's failing required check, or reproduce the daily audit.

Blocked: frozen dependency installation returned admission 75 while another
project owned `fleet-build.service`. The enforced slot is 3 GiB with zero build
swap. No owner was stopped and no build was run outside the guard. Real-input
reproduction, the unchanged benchmark gate and bundle remain required.
No nesting or branching metric is configured in the current ESLint rules.

Owner: this refresh thread for source verification and isolated reproduction;
release owner for later deployment acceptance. Next action: use the next free
guarded slot, verify state reports and resource usage, then review the repair.
Production retry and post-release observation remain separate gates.

No compatibility path, model/config change or stored-data rewrite is added.
