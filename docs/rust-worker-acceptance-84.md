# Rust worker acceptance, 9 October 2026

This work continues the merged M0-M3 contracts. Node remains the default. A
model/config hash check does not certify a Rust ranking model.

## Current evidence

The existing local real input manifest names two Oracle CSVs (about 122 MiB),
eight Leaguepedia files and five LoL Esports reference files, covering
2025-01-01 through 2026-10-06. These are previously captured community/reference
inputs, not new live-feed approval or official ranking data.

The verifier is prepared to copy these files into isolated owned staging,
record every input hash and compare Node/native preparation and cross-worker
recovery. It will report each child's peak RSS and duration. The original files
must remain read-only. No successful real-corpus run is claimed here.

Compilation, frozen install and corpus execution are blocked locally by another
project's ownership of `fleet-build.service`. Admission returned 75; no command
was moved outside Fleet's 3 GiB/zero-swap controls. Rust 1.98.0 is available;
workspace formatting and the offline lockfile update pass.

Hosted run 37999800531 compiled the native layer, passed Clippy, Rust fixture
tests, model/config parity, ten raw-seam tests and 32 provider replay/failure
tests. The controlled 5,333-match corpus had zero differing objects. Node/native
prepare peak RSS was 418,656,256 / 311,906,304 bytes, and restore peak RSS was
295,510,016 / 252,702,720 bytes. Preparation took 1772 / 1361 ms; restore took
1032 / 787 ms. This is controlled pinned/synthetic provider input, not the two
real Oracle CSVs or current live-provider acceptance.

The MinIO step failed before server startup because the published Docker image
was inaccessible. CI now builds the same official release's source at pinned
commit `0d7408fc9969caf07de6a8c3a84f9fbb10a6739e` with Go 1.24.2 and binds the
owned test process to loopback. Only that process is stopped. The storage proof
remains pending; no MinIO acceptance is claimed from the failed image pull.
Review also found and repaired shared reqwest response-decoding features, which
would have rejected valid stored gzip objects on reuse.

The next M4 layer supplies native immutable raw/state object writes and shared
lease CAS. Tests compare Node/native bytes and metadata, alternative gzip
reuse, collision rejection and stale authority after a second host takes over.
Generation graph verification and fenced promotion are still Node-owned and
are not claimed ported. Rust never replaces the configured Railway command in
this change.

## Historical heap evidence

The earlier local #90 V8 abort was near 1570 MiB below the 3 GiB cgroup cap.
Existing retained process membership/start stamps omit the failing PID's
arguments, parent and application phase. They cannot distinguish setup from the
parity verifier. This historical attribution remains unresolved.

Current read-only production logs establish a separate Node daily-audit failure
after full snapshot serialization and before publication. See
[refresh health](refresh-health-80.md). The streamed state comparison repair
removes a known large temporary allocation but does not reconstruct the older
failure or certify production recovery. #93's future diagnostics remain intact.

## Remaining gates and owners

1. This thread: rebuild the current binary under admission controls; run isolated
   real-input M2 preparation/recovery and record hashes, zero differing objects,
   peak RSS and durations. Run the existing raw benchmark corpus separately.
2. Source/refresh owner: bounded read-only M3 provider acceptance into a temporary
   directory, with requests, retries, failures and coverage recorded. Previously
   recorded HTTP responses do not prove current provider availability. Do not
   start the tournament collector while #45 source-use rights are unverified.
3. This thread: complete M4 raw/state/public generation writes, exhaustive graph
   validation, receipts and final lease/ETag promotion. MinIO evidence must reject
   a lease change during publication in both workers.
4. This thread: M5 import/model/player/replay/projection and deferred state
   encodings, mini-generation fixture, full and one-match incremental parity with
   zero differing paths/state/reconciliation. No tolerances or gate changes.
5. This thread and release owner: M6 native parent, separate shadow prefix,
   read-only reuse of Node raw receipts and refusal of writes outside shadow.
   Measure storage/runtime and cost first. Max has approved 14 days around $1;
   ask only if the estimate exceeds $5. No provider requests in shadow.
6. Release owner: a clean 14-day observation and normal release gates before
   cutover. Preserve Node for the 30-day rollback period and verify seven days
   of production runs after cutover. No clean shadow or cutover is established.

The issue remains open. A local resource gate prevents execution, not independent
source work on #45/#46. No production service, variable, prefix or database was
changed, and no production credentials are used by local/CI storage tests.
