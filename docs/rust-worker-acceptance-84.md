# Rust worker acceptance gates

[Issue #84](https://github.com/MaximilianMauroner/lol-esports-ranking/issues/84)
records current evidence and decisions. Run reports, source identities and
resource receipts belong in ignored `.agents/artifacts/refresh-live-20261009/`.
[The worker guide](rust-worker.md) describes commands and compatibility.
Node remains the default. Model/config hash parity is not a Rust ranking model.

## M2: real raw preparation and recovery

Build the current binary under Fleet admission. Run `verify-rust-raw-source.ts`
on isolated copies of retained raw input. Record coverage, filenames, byte counts
and SHA-256 for every input, plus the binary identity. Reject duplicate flattened
filenames and changed input during staging. Keep the original manifest and raw
files read-only.

Require equal Node/Rust receipts, exact canonical object bytes and manifests,
zero differing objects, and equal restored files from Node transport objects.
Record each process's peak RSS and duration. Gzip transport bytes can differ
under the existing semantic storage identity contract. The separate controlled
raw benchmark remains useful but cannot substitute for real-input acceptance.

## M3: provider acceptance

Use a bounded permitted read-only probe into owned temporary storage. Record
endpoints, request/retry counts, elapsed time, coverage, warnings, failures and
response identities. Compare both workers against the same recorded response;
two independently changing live responses cannot certify exact parity.
Keep required/optional failure, pagination, body decoding, rate-limit and retry
budgets intact. An unavailable provider is a remaining source gate.

Do not start tournament polling or redistribution while #45's source-use gate
is unverified. Previously successful HTTP responses and synthetic fixtures do
not establish current provider availability or approved live-feed usage.

## M4: bucket storage and publication

The additive native CLI supplies immutable raw/state object writes and shared
lease CAS. Its MinIO acceptance must run with no skips against an owned loopback
service and pinned release. Compare Node/native object bytes and metadata,
alternative gzip reuse, corruption rejection without overwrite, cross-host
lease acquisition/renewal, stale-owner rejection, release and higher-token
reacquisition. These primitive checks do not certify generation promotion.

Complete public/raw/state generation writes, exhaustive graph validation,
publication/audit receipts and final lease/ETag promotion. Reject missing or
mutated members, changed authority during publication and final-CAS races in
both workers against MinIO. Preserve previous-generation rollback references
and all stored compatibility readers. Generation graph/promotion remain
Node-owned until the native implementation passes these gates.

## M5: the ranking model

Port import/model/player/replay/projection and the explicitly deferred state
encodings. Require a mini-generation fixture, full replay and one-match
incremental parity with zero differing public/state/reconciliation paths.
Keep code-unit ordering, binary64 semantics, model version/config and source
provenance exact. No tolerances, invented inputs or weakened checks.
Rust and TypeScript model copies with cross-language CI are already authorized;
the dual model is permanent while the browser uses TypeScript.

## M6: parent, shadow and cutover

Implement the native parent, separate shadow prefix, read-only reuse of Node raw
receipts and refusal of writes outside shadow. Shadow makes no extra provider
requests. Measure storage/runtime and cost before starting the service.

Max approved 14 days around $1, with a stop-and-ask gate only if the estimate
exceeds $5. That authorization does not certify readiness or a clean observation
period. A clean 14-day shadow and normal release gates precede cutover. Preserve
Node for 30 days of rollback and verify seven days of production runs after
cutover. No merge, contract CI or synthetic run establishes these observations.

## Diagnosis and owners

Keep historical V8 evidence separate from current controlled reproductions.
#93's future receipts cannot establish an earlier missing allocation phase.
See [refresh recovery](refresh-health-80.md) for the diagnosis and release gates.

This thread owns source/parity/resource verification and native migration.
Source owners supply permitted current provider evidence. The release owner
owns shadow/service activation and production observations within the recorded
approval. Keep #84 open until the remaining migration and observation gates pass.
