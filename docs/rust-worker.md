# Rust refresh worker

The Rust worker is being added in stages for issue #84. Node remains the default
refresh worker. The web server and browser remain in TypeScript.

Malformed LoL Esports JSON responses use the warning text `Invalid JSON response`
in both workers. Only JSON parsing errors use this text; HTTP, network, retry, and
body-read errors keep their diagnostics. Earlier stored warnings remain readable.

The workspace requires Rust 1.98.0. From the repository root:

```sh
cargo +1.98.0 test --manifest-path worker/Cargo.toml --workspace --locked
cargo +1.98.0 build --manifest-path worker/Cargo.toml --package ranking-refresh --locked
pnpm exec tsx --tsconfig tsconfig.app.json scripts/check-rust-parity.ts
docker build -f Dockerfile.refresh -t ranking-refresh .
docker run --rm ranking-refresh contracts
```

On Fleet's coding VM, run compilation and tests through the `build` skill helper.
The image builds only the Rust workspace. It does not change the Railway start
command or publish bucket objects.

The contracts crate preserves JavaScript binary64 number formatting, rounding,
UTF-16 code-unit order, canonical JSON, hashes, and provider timestamps. Gzip
output can differ between workers. Stored identity uses the digest of validated
uncompressed bytes, as described in [storage identity](storage-identity.md).

`exp` and `log` preserve V8's evaluation order, including the NaN payload for
negative logarithm inputs. `pow` follows Node 24's
`use_std_math_pow` default and uses the platform math library after its
ECMAScript special cases. CI runs the golden tests on Linux and inside the
Debian worker image. Other platforms and Node versions need the same parity
proof before use.

Provider time parity covers four-digit calendar dates, minute/second clocks and
explicit numeric zones, including the bounded legacy space-separated forms.
Zone-less clocks use UTC with space, uppercase `T`, or lowercase `t` separators;
lowercase `t` no longer uses Node's legacy host time zone.
Malformed date fallbacks retain the first ten UTF-16 units and replace unpaired
surrogates with U+FFFD in both workers. Parsed dates and ASCII fallbacks keep their
existing behavior; stored date values are not rewritten.
Zone arithmetic must fit signed 32-bit seconds. Natural-language dates and V8's
extreme integer-overflow forms are outside this contract. For example, Node can
turn an offset of `+999999999:59` into an unrelated date through legacy overflow;
Rust rejects it. Add Node fixtures before an importer needs a new input form.

The browser and worker each own a model configuration. When changing the model,
update both `src/lib/modelConfig.ts` and
`worker/ranking-contracts/src/model-config.json`, plus both model version values.
CI compares parameters, version, and the independently computed live config
hash. This dual implementation is permanent while the browser uses TypeScript.
The Node worker remains necessary until shadow and cutover gates pass; its later
removal is a separate migration milestone.

## Raw source process

Build the release binary, then opt into the isolated raw preparation and recovery
process with `RANKING_RAW_SOURCE_WORKER=rust`. `RANKING_REFRESH_BINARY` can select
a different binary path; the default is `worker/target/release/ranking-refresh`.
An unknown worker selector fails before launch.

```sh
cargo +1.98.0 build --manifest-path worker/Cargo.toml --package ranking-refresh --release --locked
RANKING_RAW_SOURCE_WORKER=rust pnpm data:refresh
```

The CLI accepts `raw-source <input.json> <output.json>`. Its descriptor contract
matches the Node child: prepare emits canonical raw objects and receipt metadata;
restore checks the receipt authority, full object graph and each object's digest,
then reconstructs the files. It writes a descriptor only after success. Both
actions report Linux `VmHWM` as `childMaxRssBytes`.

Oracle preparation compares game inventories without loading inherited objects.
It preserves delta chains and replaces chains longer than 32 deltas with a new
baseline. Full baseline preparation moves existing row strings into its JSON
tree after releasing the CSV buffer. It does not keep a second complete row
tree beside canonical serialization. Discarded delta chains are released before
rebaseline; retained delta serialization releases the original source first.
These are permanent resource requirements, with no new stored format or reader.
Recovery verifies the baseline and all mutations before replacing the
destination. Reconstructed provider files and the manifest are staged; the
cross-filesystem fallback publishes the manifest last.

Run the cross-worker checks against isolated copies of raw inputs:

```sh
RANKING_RUST_TEST_BINARY="$PWD/worker/target/release/ranking-refresh" node --import tsx --test tests/rustRawSourceParity.test.ts
RANKING_REFRESH_BINARY="$PWD/worker/target/release/ranking-refresh" node --max-old-space-size=2048 --expose-gc --import tsx scripts/benchmark-incremental-ranking.ts --raw-seam-parity
node --max-old-space-size=2048 --import tsx scripts/verify-rust-raw-source.ts data/raw/manifest.json
```

These checks compare canonical object bytes, receipts, manifests and restored
files. Gzip transport bytes and timing fields can differ. The verifier prints
each process's peak RSS and duration. It never prepares in the original raw
directory. Existing optional legacy compressed-size fields stay readable until
all active stored receipts have moved to semantic identity. The Node selector
stays available until the migration's shadow and rollback observation gates pass.

## Provider downloads

`ranking-refresh fetch` accepts the download process flags and writes the provider
files and local manifest. Set `RANKING_PROVIDER_FETCH_WORKER=rust` to select it
from the Node refresh parent. `RANKING_REFRESH_BINARY` selects the binary path.
Node remains the default. The binary runs the HTTP work itself.

The fetch process discovers Oracle CSVs, pages Leaguepedia Cargo results at
1,200 ms intervals, and pages the LoL Esports reference endpoints at 250 ms
intervals. Oracle and LoL Esports use five attempts per request; Leaguepedia uses
seven and checks rate-limit bodies. Retry-After and jittered backoff must fit the
120-second request budget. Optional provider failures stay in the manifest;
required failures return a failed exit after writing the manifest.

Optional failure diagnostics keep the Node child-command text in
`ranking-fetch/src/lib.rs` so stored source receipts retain the same identity
while Node is the active reference and rollback worker. Remove this formatter
with the Node-only provider code after shadow, cutover and the 30-day rollback
period are complete. Existing stored receipts do not need a rewrite.

CI runs the existing downloader failure cases with the native selector and a
recorded-response comparison against Node. The comparison covers multiple
Leaguepedia and schedule pages, duplicate events, details, files, manifests and
request order. The comparison excludes process wall-clock fields and retry
delays whose jitter bounds are checked separately. Live
provider validation and completed compiled checks must be recorded before this
seam is ready. It is not enabled in production by this PR.

## Native storage primitives (M4 in progress)

`ranking-refresh storage <input.json> <output.json>` adds native immutable raw
and state object writes and the existing active-pointer lease protocol.
Descriptor actions are `sync-object`, `acquire-lease`, `renew-lease`,
`release-lease`, `verify-publication`, `verify-raw-generation`,
`verify-state-generation` and `verify-public-artifact`. The process uses the
existing bucket environment names and SigV4. Redirects are refused, relative keys cannot escape the selected prefix,
and credentials/transport URLs do not appear in failure diagnostics.

`sync-object` accepts a prepared gzip file, semantic SHA-256 and byte count.
It validates canonical uncompressed JSON before `If-None-Match: *` writes.
A collision requires a fresh GET, matching metadata and exact uncompressed
bytes. Gzip transport differences remain valid. Existing corruption is rejected
and never overwritten. Lease acquisition, renewal and release compare the same
`active-generation.json` ETag used by Node. A takeover changes the fencing token;
the old owner cannot renew or release the new authority.

The primitive layer has compiled loopback MinIO acceptance recorded in #84.
It is not yet selected by the Node parent. Generation manifests, exhaustive raw/state/public graph
verification, publication receipts, promotion and audit receipts still use Node.
M4 is incomplete until those paths are ported and the lease-change-during-
promotion check passes against MinIO. There is no Rust ranking model, replay,
projection or parent job yet. M5/M6 and production cutover remain pending.

CI's isolated MinIO check uses loopback-only test credentials and compares Node
and native object sets, bytes, metadata and lease pointer bytes. It also checks
semantic reuse with different gzip bytes, corruption, cross-host takeover and
stale renewal/release. A skipped local test does not supply MinIO evidence.

`verify-publication` is read-only. It reads `active-generation.json`, verifies
its receipt key/digest/length/ETag binding, parses the existing readiness schema,
checks pointer and receipt authorities, then freshly fetches every declared
immutable member and checks length, metadata SHA and semantic SHA. Public,
raw and state content objects are inflated one at a time. It returns the same
`found`/`receipt` result as Node's publication reader. Supported legacy pointers
return `legacy-publication-without-receipt-binding`; no stored reference or
compatibility reader changes.

This checks the receipt's declared closure. It does not independently prove that
all public archive, raw-source and checkpoint references are represented. That
generation graph validation, readiness writes and final lease/ETag promotion
remain required before M4 is complete. The action is not selected by the Node
parent and grants no promotion authority. The native reader is a permanent
storage integrity path while receipt-bound generations remain stored.

Pointer fencing retains Node's `Number` coercion; receipt tokens remain positive
safe integers. Receipt dates retain canonical four-digit and signed six-digit
ISO spelling through both JavaScript TimeClip endpoints. Provider and lease
timestamp contracts remain separate. Gzip decoding validates complete members
and their CRC/size before accepting concatenation or Node's zero-padding end
marker. These are permanent stored-input compatibility requirements. Existing
stored references need no migration.

The MinIO differential cases compare the complete reader result with Node and
exercise stale receipt/pointer bindings, malformed membership, prefix escapes,
alternate gzip transport, semantic corruption and missing members. They also
check that failed verification leaves no success descriptor or changed pointer.

`verify-raw-generation` accepts the existing relative raw receipt `reference`.
It fetches and decodes that receipt, validates the existing raw identity/source
receipt contract, then fetches every Oracle baseline/delta and Leaguepedia/
LoL Esports object referenced by the receipt. Each GET checks transport length,
gzip metadata, optional legacy compressed size, canonical JSON and semantic
digest/size. It keeps only scalar transport proofs after each member. The
result matches Node's raw authority verification: `key`, normalized `reference`,
parsed `receipt` and `verifiedObjects`.

This action verifies raw graph membership independently of a publication
receipt's declared list. It reuses the raw process's decoder and receipt parser;
there is no second raw contract. It does not reconstruct Oracle mutation chains,
prove public/checkpoint graph membership, stage readiness/audit receipts or
promote a pointer. The Node parent still owns those calls. Compiled MinIO and
affected raw prepare/restore checks must pass before this layer's acceptance is
claimed. No provider request or production write is part of verification.

Raw graph verification preserves escaped unpaired UTF-16 surrogates in stored
JSON strings and keys, including nested source-receipt inputs and child content.
The shared lossless codec sorts keys by UTF-16 units and checks exact Node
canonical bytes. It does not replace characters or rewrite stored objects.
This is a permanent stored-input contract. The older prepare/restore path still
uses Unicode scalar strings; this graph action does not certify that path for
inputs containing unpaired surrogates.

Optional stored `compressedBytes` fields stay readable under the existing raw
storage removal condition. Semantic references and this graph integrity path
remain required while raw receipt authorities are stored.

`verify-state-generation` is a GET-only state authority reader. Its descriptor
accepts `authority: { key, etag, bytes, digest }` with the existing full bucket
key. An optional `expectedManifestJson` carries the canonical Node manifest
bytes for the supplied-manifest comparison. This string seam preserves all
UTF-16 strings without changing the ordinary descriptor parser. The result
matches `assertStateManifestAuthority` with object verification enabled:
`manifest`, `key`, `etag`, `bytes`, `digest` and ordered `verifiedObjects`.

The manifest GET binds metadata, ETag, length, SHA-256, canonical bytes and
generation key. The existing exact schema, nullable base IDs, positive safe
versions, raw-prefix identity, UTC dates and UTF-16 checkpoint ordering remain.
The compatibility parser requires a nonempty `modelConfigHash` string, as Node
does; it does not introduce a digest rule for existing stored manifests.
Each fresh ledger/checkpoint GET checks gzip metadata, optional legacy transport
size, compressed SHA and uncompressed semantic size/SHA. Inflation uses a fixed
64 KiB buffer and retains no semantic member tree. Member integrity deliberately
does not parse canonical JSON or model/replay contents: Node's authority check
does not certify those deferred M5 encodings either.

The state reader scans optional gzip filename/comment fields without a new
length limit. It checks optional header CRC, deflate payload CRC and member
size before accepting concatenation or zero padding. Other native gzip readers
still use the library's 65,535-byte filename/comment limit; this action does not
certify those paths for longer Node-valid headers. That remains a separate
native stored-input acceptance boundary, alongside raw prepare/restore's
unpaired-surrogate limitation.

This internal action adds no selector, active-pointer read, model execution,
readiness/audit write or promotion. Public graph traversal, agreement between
the three generation authorities and final lease/ETag CAS remain M4 gates.
Node remains the default parent. Existing state references require this integrity
path permanently; remove optional legacy `compressedBytes` support only after
all active stored state manifests have moved to semantic references. No stored
object rewrite or production access is needed.

The MinIO differential cases cover full-result equality, prefix handling,
unpaired UTF-16 strings, dates/order/schema errors, legacy gzip sizes, opaque
member contents, fresh missing/mutated members and complete gzip CRC checks.
They compare the unchanged active pointer and bucket inventory. These are
synthetic storage acceptance, not real-input memory or ranking-model parity.

`verify-public-artifact` accepts scalar `sha256` and `bytes` for an existing
public object. It returns hydrated `content` and ordered transport
`verifiedObjects`. Each root and archive child gets a fresh prefix-bound GET
with gzip metadata, transport length and semantic size/SHA validation. The
shared decoder uses a fixed 64 KiB buffer and checks header CRC, payload CRC,
ISIZE, concatenation and Node's zero-padding end marker. Hydration still needs
memory for the requested content; bounded inflation is not a full-view memory
acceptance claim.

The reader follows archive format version 1 with the existing 512,000-byte
child budget and depth 24. It checks every record entry shape and key before
child reads, then reference ranges, counts, list/map child types and original
kind. It reads all parts, without year or record projection. A record entry
whose inline node has no value stays an own undefined property, as in Node.
A map merge therefore rejects the same key from another child. Only the final
JSON omits the property.

Public envelopes use a separate parser with JSON.parse semantics: whitespace,
escapes, last duplicate key wins and unpaired UTF-16 strings. Numbers are
binary64. Overflow becomes positive or negative infinity for validation,
coercion and equality, and the output writes it as null. Parsing, output,
String coercion and drop use explicit stacks. Nesting has no fixed limit; the
stored object size and available memory bound it. Raw/state canonical parsing
keeps its strict grammar, finite numbers and 128-level bound.

Node's JSON.parse also has no fixed nesting limit, but recursive Node code is
limited by its call stack. Its String coercion and canonical serializer can
fail on deeply nested values, while the native reader uses explicit stacks.
The differential cases test 500 levels; deeper input is not a Node parity
claim. Parent selection still requires compiled differential acceptance.

This action writes only its local success descriptor. It grants no generation
authority, readiness or promotion permission. Full public manifest/directory
validation, agreement with raw/state authorities, readiness/audit writes and
final lease/ETag CAS remain M4 work. Archive format compatibility is permanent
while stored public archive nodes are referenced. No rewrite or new reader for
existing objects is required.

The real raw-source verifier now records source coverage, filenames, SHA-256 and
byte counts along with both workers' prepare/restore memory and duration. It
checks copied input identities and rejects duplicate flattened filenames before
starting workers. That guard prevents equal outputs from silently proving parity
on an incomplete input corpus. Original raw inputs remain untouched.

See [migration acceptance](rust-worker-acceptance-84.md) for current evidence and
remaining gates. The native CLI is additive; no compatibility reader or stored
reference changes. Existing legacy transport references and Node rollback paths
retain the removal conditions stated above.
