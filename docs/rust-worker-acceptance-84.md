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

Hosted [run 38000404426](https://github.com/MaximilianMauroner/lol-esports-ranking/actions/runs/38000404426)
passed both required jobs on PR #95. It built the official MinIO release's source
at pinned commit `0d7408fc9969caf07de6a8c3a84f9fbb10a6739e` with Go 1.24.2 and
bound the owned test process to loopback. The MinIO test passed without skips:
Node/native immutable bytes and metadata match, valid alternative gzip is reused,
corrupt collisions remain untouched, shared lease acquisition/renewal matches,
and stale native authority cannot renew or release after a Node host takes over.
Native release permits Node reacquisition with a higher fencing token. This also
verifies the repair that disables shared reqwest response-decoding features.
The earlier inaccessible image pull supplied no storage acceptance evidence.

The same run passed Clippy, Rust fixtures, raw/provider integration, worker-image
build and image model/config parity. The controlled 5,333-match raw corpus again
had zero differing objects. Node/native prepare peak RSS was
419,794,944 / 311,762,944 bytes; restore peak RSS was
293,191,680 / 252,416,000 bytes. Preparation took 1012 / 803 ms and restore took
590 / 489 ms. These remain pinned/synthetic inputs. They do not clear real-input
M2 or current provider M3 acceptance.

Typecheck, lint, 1,052 unit/integration tests, all three browser suites, the
unchanged three-repeat incremental benchmark and the bundle passed. Fifteen
opt-in native tests were skipped in the main job; the MinIO test ran separately
in the Rust job. Maximum incremental peak RSS was 635,723,776 bytes, normalized
compute was 6.2643 against a 6.5 limit, and upload was 1,527,742 bytes against a
2 MiB limit. Exact parity and zero differing paths/identities passed. This does
not supersede PR #94's failed run or certify the daily-audit allocation repair.

The next M4 layer supplies native immutable raw/state object writes and shared
lease CAS. Tests compare Node/native bytes and metadata, alternative gzip
reuse, collision rejection and stale authority after a second host takes over.
Generation graph verification and fenced promotion are still Node-owned and
are not claimed ported. Rust never replaces the configured Railway command in
this change.

## Current local diagnostic evidence

Owned frozen Node installation passed on 10 October. The bounded capture then
exited 134 during full baseline checkpoint persistence, before calibration,
incremental measurement or verifier. Process stamps/arguments and the GC PID
identify the parent, with a 1,811,939,328-byte V8 heap limit. Group peak was
2,113,863,680 bytes and swap was zero. Retained checkpoint encodings and eager
canonical body preparation are measured contributors. Sequential persistence
has passed the 63 storage tests; full-corpus recovery remains unverified.

This current local attribution does not recover the missing evidence for the
older #90 abort. It supplies no incremental CPU profile, real-input M2/M3
acceptance or clean shadow. Both #94 and #96 currently fail the unchanged
compute gate; their memory/upload/parity results do not waive that gate.

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
