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

The native `verify-publication` action advances the existing receipt-bound
reader. Its differential MinIO cases must compare valid results and reject
malformed or corrupt authority/closure cases with no pointer writes. This is
declared-closure validation, not a complete graph/promotion acceptance gate.
Include Node-readable pointer numeric coercions, canonical expanded receipt
years and both TimeClip endpoints. Gzip cases must cover validated zero padding,
concatenation, corrupt CRC/size, truncated members and nonzero trailing junk.
Record compiled current-source execution with zero skips before claiming that
layer's MinIO acceptance. A missing local MinIO/Go binary or conditional skip is
a blocked local check; the required hosted MinIO job supplies separate evidence.

The native `verify-raw-generation` layer enumerates membership from the raw
receipt and checks each referenced object through the existing raw decoder.
Compare its complete result and scalar transport proofs with Node's current
pre-promotion raw authority check. Include baselines, deltas, both narrow
providers, alternative gzip bytes, optional legacy lengths, missing members,
metadata/semantic corruption, noncanonical JSON and contradictory receipt
identity. Include Node-valid unpaired UTF-16 strings and keys in receipt inputs
and child content, exact code-unit key ordering and canonical escape spelling.
Existing prepare/restore parity must remain intact; its earlier scalar-string
limitation is a separate acceptance boundary. Failures must leave no success
descriptor, repaired object or changed active pointer. Compiled current-source execution is required; implemented
tests and conditional skips do not establish acceptance. This raw membership
layer does not replay mutation chains or complete public/state graph validation,
readiness/audit writes or promotion.

The native `verify-state-generation` layer must match Node's complete
`assertStateManifestAuthority` result with object verification enabled. Its
internal descriptor uses a full authority key and optional canonical
`expectedManifestJson` string; stored state contracts do not change. Verify
manifest ETag/metadata/length/SHA, generation-key binding, exact schema, nullable
bases, safe counts, exact UTC dates and UTF-16 checkpoint order. Preserve
nonempty compatibility strings and optional legacy transport lengths.
Each fresh member read must check gzip transport and semantic identity with
bounded inflation, including concatenated members and CRC failures. Node's
member integrity authority does not require JSON/model decoding; keep that
separate M5 gate. Require compiled MinIO equality and failure cases with zero
skips, no success descriptor on failure and unchanged pointer/object inventory.
Real-input memory evidence remains separate from these synthetic storage cases.

Before finishing M4, require current-source compiled acceptance for native
public archive reads. Compare hydrated content and every fresh transport proof
with Node, including producer-generated multi-level archives, UTF-16 keys,
noncanonical public envelopes, duplicate JSON properties, optional range/year
fields, alternate/long gzip headers and failed child reads. Check archive
count/type/depth boundaries, unchanged pointer/inventory and no success
descriptor on failure. The staged public JSON parser's finite-number and
128-level input bounds remain compatibility work against Node JSON.parse;
documenting them does not complete acceptance or authorize parent selection.

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
