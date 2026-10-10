# Refresh health investigation, 9–10 October 2026

Read-only checks at about 22:10 UTC distinguish the web service from the scheduled
refresh. Both use the #90 main revision. No deployment, retry, settings change,
production database read or bucket write was made.

## Read-only refresh on 10 October

At about 09:25 UTC, GitHub deployment 6955355437 has additional failures at
00:16:34 and 06:16:12 UTC, still with empty descriptions. Railway web deployment
214b422e-9784-4b94-bdf7-ae43d4a5eefa remains SUCCESS on #90. The actual public
origin, `https://lol.lab4code.com`, returns 200 from `/api/live` with that revision
and 200 from `/api/ready` with app ready and local data.

The latest ranking-refresh deployment, ce88568d-09b1-459c-a8d5-c58cc15bd2bd,
is CRASHED on the same revision. Its daily audit starts at 06:04:18.567 and
fails after 707,059 ms. It writes the full 80-snapshot artifact at 06:15:21;
V8 then reports ineffective mark-compacts and heap exhaustion, followed by
SIGABRT. No completed persistence or promotion stage is recorded. The broad
parent `provider-fetch` label still does not attribute this allocation to HTTP.
The six-hour cron and gated mode remain configured. The daily-audit selector
is unset (enabled default), and all Rust selectors remain unset (Node default).
This confirms enabled ingestion and a failed audit, not successful freshness.

## Isolated allocation evidence on 10 October

After a frozen owned install passed, the unchanged bounded diagnostic capture
reproduced a separate local failure on the current review stack. The recorded
parent PID, start stamp, arguments and numeric GC record identify baseline
setup. Its 1,811,939,328-byte V8 heap limit is below the 3 GiB group cap. The
capture exits 134 during `state.persist` / `state.canonical-gzip`, before
calibration, the incremental worker or verifier. Group peak is
2,113,863,680 bytes with zero swap. No cgroup OOM or timeout is recorded.

Full checkpoint encoding retains about 1.306 GB of heap before persistence.
The allocation sample is dominated by `encodeCanonical` in rating checkpoint
encoding. Persistence prepares two checkpoint canonical bodies of 48,600,502
and 49,283,035 bytes, then aborts during the next preparation. The eager plan
retains all prepared strings/buffers alongside the encoded checkpoints.

The follow-up repair prepares and synchronizes one checkpoint at a time, keeps
only its semantic reference between writes, then builds the same ordered
manifest. Caller state, gzip/semantic identity, collision checks, publication
accounting and exhaustive pre-promotion integrity remain enforced. All 63
storage tests and changed-file lint pass; full-corpus recovery is still pending.
The captured failure does not reconstruct the historical #90 abort or attribute
the production failure. It also does not explain the separate CI compute gate.

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

Current combined #94 CI also fails compute: run 38038885071 reports normalized
ratios 6.499275, 6.402536 and 6.559420 against strict `<6.5`. Memory, upload and
exact parity pass; bundle is skipped. #96 fails the same compute gate twice on
its unchanged source tree. The local setup allocation finding above supplies
no incremental CPU profile and does not explain these compute failures.

Owned frozen dependency installation has now passed. The sequential repair's
guarded typecheck/integration and bounded full-corpus capture did not launch:
the five-minute admission window ended at 09:59:51 UTC on 10 October with exit
75 while Auto Cron owned `fleet-build.service`. No resource waiter from this
thread remains. The slot uses 3 GiB with zero build swap. No foreign process was
stopped and no check ran outside the guard. Full-corpus recovery, real-input
daily-audit reproduction, the unchanged benchmark gate and bundle remain
required. The repair is reviewable with 63 passed storage tests, changed-file
lint and independent source review; those checks do not certify recovery.
No nesting or branching metric is configured in the current ESLint rules.

Owner: this refresh thread for source verification and isolated reproduction;
release owner for later deployment acceptance. Next action: use the next free
guarded slot, verify state reports and resource usage, then review the repair.
Production retry and post-release observation remain separate gates.

No compatibility path, model/config change or stored-data rewrite is added.
