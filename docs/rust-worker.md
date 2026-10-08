# Rust refresh worker

The Rust worker is being added in stages for issue #84. Node remains the default
refresh worker. The web server and browser remain in TypeScript.

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
baseline. Recovery verifies the baseline and all mutations before replacing the
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

CI runs the existing downloader failure cases with the native selector and a
recorded-response comparison against Node. The comparison covers multiple
Leaguepedia and schedule pages, duplicate events, details, files, manifests and
request order. Only process wall-clock fields vary between replay runs. Live
provider validation and completed compiled checks must be recorded before this
seam is ready. It is not enabled in production by this PR.
