# Year-partitioned public artifacts

Public history can grow beyond 40 MB. The ranking formula, chronological replay,
source reconciliation, and scope-dependent values stay the same. Storage uses
immutable pages under the existing fenced generation authority.

## Storage contract

- UTC calendar year is separate from ranking season and checkpoint scope.
- Match storage page IDs encode the opening year and the local page number.
  A page contains at most 25 complete series. An append in a new year does not
  renumber prior-year pages. Incremental publication selects new page IDs from
  the generated catalog. This covers year rollover, legacy page migration, and
  new season or checkpoint scopes. A correction can replace old pages and later outputs.
- A complete series belongs to its earliest game's UTC year. Catalog references
  carry its full date range. Both year views can find a series that crosses New Year.
- Archive format 1 splits large lists and records into immutable nodes. Each
  reference has SHA-256, decoded bytes, gzip encoding, count, and applicable year,
  date range, record path, and key range. Scope and source/model identity come from
  the digest-bound logical artifact and generation manifest. Values from distinct
  scopes remain distinct unless their complete semantic content is identical.
- Archive nodes are at most 512,000 decoded bytes. The packing target is 480,000
  bytes to allow the envelope and index overhead. Large catalogs also split.
  An indivisible series above the target fails with its identity. No game is dropped.
- The ranking manifest keeps its 250,000-byte limit. Ranking scope payloads up to
  1,000,000 bytes remain inline. Larger non-default scopes use archive nodes.
  The default scope keeps its 1,000,000-byte logical limit.
- A generation mapping above 250,000 bytes becomes an immutable, paged artifact
  directory. The stored root keeps the ranking entry and one directory reference.
  Browser lookups fetch only directory pages that can contain the requested path.
  Root serving does not hydrate the complete directory.
- There is no aggregate archive size failure. Size is telemetry.
  Player directories use bounded nodes instead of a growing monolithic size gate.

The semantic root binds its entire nested closure. Publication receipts include
all uploaded and reused nodes. Promotion still requires the live lease and the
same pointer compare-and-swap. Restore and rollback validate nested hashes,
counts, receipt membership, and provenance. A missing or corrupt node fails.
GC traverses retained archive references. An invalid inventory produces no
removal candidates. GC remains read-only.

## Browser behavior

Ranking bootstrap loads the current summary, requested ranking scope, and the
existing compact tournament directory used by ranking filters. History
is requested separately. Match browsing keeps the all-years view and newest-first
order. The optional year selector fetches matching catalog nodes and visible game
pages. Team charts fetch selected entities. Region history fetches the selected
scope. Requests within each archive traversal are sequential. Match pages retain
the current request plus a small recent cache. Old asynchronous page responses
cannot enter a newer catalog. Missing pages show an error and a retry action.

Small inline artifacts and retained legacy artifacts use the same view projection.
Local development JSON files remain logical inspection artifacts. The production
bucket and the browser fixture use bounded content-addressed transport. This
change does not turn local JSON fallback into a paged HTTP service.

## Measurements and checks

Run the read-only local audit with:

```sh
pnpm data:artifact-audit public/data
```

The checked-in corpus on 2 October 2026 has 261 logical artifacts and 26,774,720
JSON bytes. Families: matches 13,292,007; history 7,968,139; scopes 3,731,609;
entities 1,703,930; summary 79,035. Paths assign 6,411,815 bytes to 2025,
5,159,988 to 2026, and 15,202,917 to shared scopes. Shared is not an inferred year.
Prepared storage is 2,273,072 compressed bytes and 321 nodes before deduplication.
The audit's peak RSS was 204,849,152 bytes. The largest inline ranking scope is
770,934 semantic bytes. History nodes stay below the 512,000-byte cap.
These are local measurements, not official production evidence.

Synthetic tests reconstruct 2-, 5-, and 10-year archives, check prior-year leaf
reuse, and check year-range queries. A separate synthetic archive above 40 MB
publishes to test storage, restores with a fresh client, publishes the next
generation, and validates reuse, rollback, corrupt/missing nodes, and failed
publication. Existing incremental tests cover duplicate-ledger recovery,
correction replay, scope semantics, and full/incremental parity. Regression
tests also verify catalog closure and full parity for a year rollover, legacy
page migration, a new checkpoint, and a correction that moves a series to a new
storage year. The browser journey verifies non-empty team charts and detail history.

The shared-host performance gate measured a 20,945 ms maximum across three
repetitions against the unchanged 15,000 ms limit. Memory (731,299,840 bytes),
upload (2,038,344 bytes), and parity passed. An unchanged-main smoke comparison
also failed time at 18,588 ms. This comparison is one sample, not proof of equal
performance. CI must run the same unmodified gate on the final head.

The full builder serializes one logical output at a time. Incremental byte metrics
also release each prepared output before the next one. Hash-only comparisons do
not gzip payloads. This bounds output buffering across logical artifacts, not the
ranking model, raw baseline, publication receipt, or an entire reconstructed
logical history view. Those remain measured memory costs.

## Release acceptance

[PR #72](https://github.com/MaximilianMauroner/lol-esports-ranking/pull/72)
merged as `e0f385969eb95c4847b2e66b93989870d2dd9cbd`. Release acceptance
[completed on 3 October 2026](https://github.com/MaximilianMauroner/lol-esports-ranking/pull/72#issuecomment-5969594058): deployed-reader acceptance, two successful refreshes,
format-1 active and rollback closure, and stable retained inventory. This meets
the removal condition for the temporary version-0 writer.

Publication now always uses format 1 when an artifact needs archive nodes.
`RANKING_PUBLIC_ARCHIVE_WRITE_VERSION` is obsolete and has no effect. Small inline
artifacts keep the storage contract above. This cleanup does not change Railway
variables or perform production writes. Max owns later deployment and variable
cleanup. Local checks and CI do not establish deployment or production acceptance.

## Compatibility removal

Legacy readers remain in the browser resolver/schema and storage authorities
because active, rollback, and retained audit generations can have inline payloads
and flat mappings. Keep these readers and storage authorities while supported
active, rollback, or retained audit generations need them. The temporary
version-0 writer and its aggregate and directory gates have been removed.
Remove browser legacy fallback only after supported data no longer needs it and
the supported stale-client/cache interval ends. Max must define that interval.

Keep a narrowly scoped old-format verifier for retained immutable receipts for
as long as those receipts are supported. This is an archival obligation. It does
not authorize new legacy publication after the migration.
