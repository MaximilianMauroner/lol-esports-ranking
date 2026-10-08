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

`exp` and `log` preserve V8's evaluation order. `pow` follows Node 24's
`use_std_math_pow` default and uses the platform math library after its
ECMAScript special cases. CI runs the golden tests on Linux and inside the
Debian worker image. Other platforms and Node versions need the same parity
proof before use.

Provider time parity covers four-digit calendar dates, minute/second clocks and
explicit numeric zones, including the bounded legacy space-separated forms.
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
