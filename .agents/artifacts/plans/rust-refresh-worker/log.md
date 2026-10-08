# Rust refresh worker: execution log

Plan: https://tools.mauroner.net/artifacts/fUiy-OiLobn0LbC4LBK_vTP8O9wbtjhH
Issue: #84

## Progress

- [ ] M0 prerequisite A: code-unit order for data, model config bump (#85)
- [ ] M0 golden fixtures exporter and UTC provider timestamps (stacked on #85)
- [ ] M0 prerequisite B: digest-based identity for stored objects (before M1)
- [ ] Start of M5: mini full-generation fixture (moved from M0, see decisions)
- [ ] M1 Rust contracts crate
- [ ] M2 Raw source worker
- [ ] M3 Provider fetch
- [ ] M4 Bucket writes, lease, promotion
- [ ] M5 Model, replay, projection
- [ ] M6a Parent job and shadow
- [ ] M6b Cutover

## Decisions

- 2026-10-07, Max: port the ranking model (two copies plus a cross-language parity job in CI).
- 2026-10-07, Max: allow a one-time output change (code-unit order, digest-based reuse checks).
- 2026-10-07, Max: run the 14-day shadow service at about $1; stop and ask if the estimate exceeds $5.
- 2026-10-07, Max: approve cutover after a clean shadow period.
- 2026-10-08, Max: start milestone 0.
- 2026-10-08, agent: split decision 2 into two PRs. Reason: the reuse checks change integrity verification in three storage paths and need their own review; the ordering change is mechanical.
- 2026-10-08, agent: apply code-unit order to all of `src/lib/**` and `scripts/**`, guarded by ESLint `no-restricted-properties`. Views and components keep `localeCompare` for display. Reason: a directory rule is easy to enforce; a list of worker-graph files would drift.
- 2026-10-08, agent: bump `sourcePipelineVersion` to `...-code-unit-order-v23`. Reason: ordering feeds series identity and replay tie-breaks; the bump changes the config hash (`fnv1a-2a9cb549` to `fnv1a-5eebb6ce`) and invalidates incremental state once.

- 2026-10-08, review: the digest-based identity change (reuse checks and reference format, decision 2) stays in M0, before M1. Reason: raw receipt references include `compressedBytes` (`parseRawObjectReference`, `scripts/raw-source-storage.mjs:601-606`). These lengths feed the receipt's canonical bytes, its `rawIdentityDigest`, and its key. Without the change, M2 key parity needs Node's exact zlib output: for a 1.6 MB Leaguepedia file at level 9, Node's zlib `1.3.2.1-motley` gives 127,153 bytes and system zlib 1.3 gives 127,522. Gzip bytes are therefore intentionally not a fixture.
- 2026-10-08, agent: move the mini full-generation fixture to the start of M5. Reason: only M5 consumes it, and the model can change before then; freezing it now would only cause churn.
- 2026-10-08, agent: parse zone-less provider timestamps as UTC in code (`src/lib/importers/providerTime.ts`). Reason: published `datetimeUtc` depended on the process time zone. Production is UTC (see Railway environment), and all 39,330 distinct local raw timestamps parse identically, so published output does not change and no config bump is needed.

## Deferred contracts

These byte contracts are not in the M0 fixtures. Each milestone adds them before it ports the code.

- M5: `$checkpointType` encoding and `digestCanonical` (`src/lib/ratingCheckpoint.ts`).
- M5: `$causal` encoding (`src/lib/causalRecompute.ts`).
- M5: checkpoint inventory `stableJson` and `fnv1a64` (`src/lib/ratingCheckpointInventory.ts`).
- M5: Oracle player-id FNV-32 after `trim`, `toLowerCase`, and `\s+` collapse (`src/lib/importers/oraclesElixir.ts`). JS `\s` and `trim` include U+FEFF; Rust `char::is_whitespace` does not.
- M6a: source fingerprint `stableJson` in `scripts/refresh-data-if-changed.mjs`. It writes `{a: undefined}` as the text `{"a":undefined}`.

M1 note: the cross-language CI job must compute the model config hash from the live parameters in both workers and compare them on every change. The fixture pins only the hash algorithm on samples, because a frozen copy of the live parameters would fail on every model change (Codex suggested it in #86; declined for that reason).

M1 note: `parseProviderInstant` falls back to V8 `Date.parse` for forms that do not match the zone-less pattern. The Rust port must copy that fallback for the forms it accepts, or reject them.

## Railway environment

- Time zone: UTC+0 in January and July. Source: production generation `run_20261008001549` on https://lol.lab4code.com publishes raw Oracle times `2026-01-23 13:26:53` and `2026-07-01 08:10:16` as `...13:26:53.000Z` and `...08:10:16.000Z` (public content objects, read on 2026-10-08).
- `LANG`: not needed after #85, because no data code uses locale collation.
- Node version: unknown. No repository source states it; `package.json` allows `>=24 <25`.

## Surprises

- Five copies of `compareCodeUnits` already existed (one export in `src/lib/incremental/types.ts`, four private). This PR keeps one shared `.mjs` helper so that plain `.mjs` scripts, such as the web server's storage modules, can import it without `tsx`.
- No `localeCompare` call used locale or options arguments, so the rewrite was mechanical (139 calls in 45 files, done with a TypeScript-AST codemod).

## Evidence for prerequisite A

Two full builds from the same raw manifest under the Fleet build guard (3 GiB cap, no swap): `main` b8a40529 peaked at 1.8 GiB in 77 s; the branch peaked at 1.6 GiB.

After removing volatile fields (timestamps, run ids, config hash, pipeline version):
- 161 of 299 public files are identical.
- Team ratings and uncertainty are identical for all 613 ranked team rows in 9 scopes; no current rank changes.
- 286 of 15,865 match rows list their two teams in the other order, because series identity sorts the two team names (for example `CTBC Flying Oyster` now sorts before `Chiefs Esports Club`). Their score, impact, and expected win share swap with them.
- `entities/teams.json` lists teams in code-unit order (for example `BNK FEARX` before `Bad Luck Gaming`).
- Four historical rank values change between teams with equal ratings.
- The `main` build reproduces the committed `public/data` apart from two wall-clock fields (`freshnessDays`, `asOf`).

## Baseline

- `main`-equivalent code (#81 final head 610f30e4, CI run 37686933886, AMD EPYC 7763): gate passed; normalized compute 5.918 / 5.886 / 5.884; computeMs 26,801 / 26,657 / 26,650; peak 672 / 660 / 569 MiB.
- #85 head 94c1d4b3 (CI run 37757838386, AMD EPYC 9V45): gate passed; normalized compute 6.075 / 6.074 / 6.074; peak 594 / 592 / 593 MiB; parity in all repetitions.
- Local: Node v24.21.0, zlib 1.3.2.1-motley-8002e91, cargo 1.98.0.

## Acceptance checks

```json
[
  {"id": "baseline", "check": "Baseline verify and gate results on origin/main are recorded", "proof": "Log entry with pnpm run verify result, gate peak memory, and normalized compute", "passes": true},
  {"id": "railway-env", "check": "Railway Node version, TZ, and LANG are recorded with their source", "proof": "Log entry naming the source", "passes": false},
  {"id": "fixtures-stable", "check": "Fixture export is deterministic", "proof": "Two exporter runs produce identical files (diff is empty)", "passes": true},
  {"id": "rust-contracts", "check": "Rust matches every golden fixture", "proof": "cargo test passes in CI; a changed fixture byte makes it fail", "passes": false},
  {"id": "raw-worker-parity", "check": "Rust raw source worker output equals Node's", "proof": "Equal prepared object keys, digests and canonical bytes on the benchmark corpus and data/raw; both peak memory values in the log", "passes": false},
  {"id": "fetch-parity", "check": "Rust fetch output equals Node's on recorded responses", "proof": "Test comparing staging files and manifest passes", "passes": false},
  {"id": "bucket-parity", "check": "Rust bucket writes equal Node's and respect the lease", "proof": "MinIO object set comparison passes; lease-change test blocks promotion", "passes": false},
  {"id": "model-parity", "check": "Full and incremental Rust builds equal Node's digests", "proof": "Benchmark spawn mode reports zero differing paths, equal state digests, equal reconciliation", "passes": false},
  {"id": "gate-memory", "check": "Rust worker passes the gate with margin", "proof": "Gate peak memory and normalized compute for both workers in the log", "passes": false},
  {"id": "shadow-clean", "check": "14 days of shadow runs match Node", "proof": "Daily comparison reports zero differing paths for all runs", "passes": false},
  {"id": "cutover", "check": "Production runs the Rust binary for 7 days without failure", "proof": "Railway run history and active generations served by the site", "passes": false}
]
```

`baseline`: CI verify and gate on the `main`-equivalent head, see Baseline.
`fixtures-stable`: `pnpm run fixtures:parity` twice, and once with `TZ=Asia/Seoul`, gave byte-identical files.
`railway-env` stays false: the time zone is verified and `LANG` no longer matters, but the Node version is unknown.

## Evidence for prerequisite B

- New raw and state references omit gzip length. New preparation normalizes reused legacy references; parsing stored receipts/manifests preserves their original transport fields and digests.
- Public, raw, and state reuse checks validate stored semantic bytes, gzip integrity, storage metadata, and actual transport length. Reuse metrics and publication membership use measured stored sizes.
- Stored modes remain raw v2 and state v1, with an optional legacy transport field. No rewrite of stored authorities is required. Compatibility remains until active, rollback, audit, and recovery references to the old format are retired. See `docs/storage-identity.md`.
- Full-audit and restart-baseline readers accept the new nested references. Audit snapshot descriptors keep measured gzip size because they describe the stored transport artifact.
- Initial guarded affected suite: 103/107 passed; four restart-baseline fixtures relied on gzip size from the semantic constructor. Fixtures and baseline transport verification were corrected. Guard: 3 GiB memory cap, zero swap; peak 949 MiB.
- Final validation and PR review results will be recorded on the prerequisite PR.

- Final affected suite: 111/111 passed, including alternate gzip sizes and measured closure, legacy authority reads, corrupt payload rejection, conditional-create races, and the >40 MB archive. Typecheck and lint passed. Guarded run: sampled peak about 946 MiB, zero swap. Full suite and CI gates pending.

- Full suite on first #88 head: 918/925 passed; seven bucket inventory tests exposed a missed semantic-reference reader. Finder, verifier, parent, and Codex bot confirmed the same P2. Published before repair. The two-file inventory repair passed 18/18 tests under the guard and six focused tests independently; declared legacy, publication, and audit transport measurements remain strict.

## M1 Rust contracts

- Added Cargo workspace `worker/`, the contracts crate and `ranking-refresh contracts`.
- Local Rust 1.98.0: formatting, Clippy with warnings denied, seven contract tests, CLI build and live Node/Rust model parity passed. Changed one golden number-text byte: the contract assertion failed; restored the fixture and all tests passed again.
- V8-compatible `exp`/`log` retain the pinned Node 24.21.0 evaluation order. Node 24 enables `use_std_math_pow`, so `pow` uses the native math library plus V8's ECMAScript special cases. No tolerance or model formula changes. License notices retained.
- Gzip roundtrip, concatenated members, corrupt checksum and truncated member checks passed. Gzip transport bytes may differ after #88; semantic digest fixtures are exact.
- Build path: separate `Dockerfile.refresh`, pinned Rust builder, Debian runtime. Railway can use this Dockerfile for the later shadow service. No service or cron command has changed. Docker is absent locally; image build, clean-target container fixtures and image live-config parity are CI checks.
- Local Rust checks used Fleet's 3 GiB memory cap, zero swap and one compiler job, sampled peak 494,477,312 bytes. The initial linker failure was Fleet's `cc` shim; explicit `/usr/bin/gcc` fixed the local invocation without changing project configuration.
- Node verify and unchanged benchmark gate are running. CI and independent PR review remain pending. Model configuration remains duplicated permanently while the browser uses TypeScript; documented in `docs/rust-worker.md`.

- M1 Node verify passed: 928 non-browser tests plus three isolated browser journeys (931 total), typecheck and lint. The local gate verifier hit Node's default ~1.5 GiB heap inside the3GiB cgroup; it did not complete. Retry requires explicit existing2GiB verifier heap, with the group cap retained. No gate waiver.
- First M1 CI Rust job passed all fixtures, CLI parity, Docker build, clean-target container fixtures and image parity. Node job inherited the #88 compute-gate failure.
- Independent finder/verifier confirmed P2 leap-second acceptance and P3 unused CLI dependency. Findings published before implementer repair. Six Node-generated rejection fixtures, exporter determinism, targeted Node tests2/2 and seven rebuilt Rust contract tests passed; verifier ran the rebuilt artifact independently. Both findings are closed in code. Rust repair run used3GiB/zero swap/one job; combined repair and initial M2 compilation peaked768,331,776 bytes.
- Codex reported that worker/rust-toolchain.toml does not select the toolchain for root manifest-path invocations. Verifier confirmed the behavior. Documentation, Docker build and container fixture commands now select `cargo +1.98.0` explicitly. No new compiler code; default and pinned rustc are both1.98.0 locally. Duplicate Codex leap-second finding maps to the already verified repair.

### Latest repair evidence, 2026-10-08

- M0 digest identity PR #88: required CI passed full verify, unchanged three-repetition gate and bundle. Maximum normalized compute 6.442109870868899 is below 6.50; effective peak RSS 697434112 bytes is below 734003200. No differing paths or identities. The prepared-state optimization passed 63 affected storage tests and 25 independent focused checks. Code/security reviews completed with no further findings; all threads resolved. PR remains open and ready against its parent. Local whole benchmark exhausted the configured parent heap; it is incomplete and does not supply the gate proof.
- M1 PR #89: 72 Node-generated low-year and bounded legacy-offset cases added. Current Rust CI run 37783588287 passes rebuilt golden fixtures, clean-target container fixtures, formatting, Clippy and live/image model configuration parity. Independent verifier confirms every provider-time fixture is executed. Extreme V8 integer-overflow date behavior is outside the provider grammar and documented in `docs/rust-worker.md`. Both new date findings are closed. Node gate and final bot feedback remain pending.
- M2 PR #91: CI run 37782056746 passes seven native-selected raw integration tests and the isolated 5333-match, 110-team, 356-player benchmark corpus comparison. Zero differing objects, three canonical object identities. Node prepare peak 417099776 bytes / 1219.953 ms; Rust prepare 310501376 bytes / 911.760 ms. Node restore peak 291860480 bytes / 659.228 ms; Rust restore 251342848 bytes / 590.148 ms. This is a corpus result, not the pending real local raw-data proof. The Node CI gate fails normalized compute at 6.7773; parity/memory pass. No threshold waiver or blind rerun.
- M2 review: manifest JavaScript pretty-number text and explicit-null importer repairs pass native integration in that CI run. Selector wiring/full Node verify pass there. Added literal `1.0` and unsafe-integer input coverage to prove parsed number normalization. A new confirmed finding shows all three raw-worker launch paths ignore the captured `options.env`; independent finder/verifier traced and reproduced it. Repair and new affected checks are required.
- M3 PR #92: five provider parity roots are confirmed and published: failure metadata/network telemetry, JavaScript numeric strings, decompression, BOM text/JSON handling, and Cargo query replacement. Implementer owns their repairs. CI also fails typecheck on normalized manifest collection type and Clippy on a regex compiled inside the Oracle loop; both additional findings are published. No compiled fetch parity or live-provider result yet.
- Local admission remains blocked by another project holding `fleet-build.service`; repeated guarded commands return 75. The 3 GiB memory limit, zero build swap and one shared slot remain in force. No unrelated owner was stopped. M4 through M6 remain unimplemented; shadow/cutover acceptance is still false and cannot be established by source checks.
- M2 captured-env repair now carries the supplied environment through all three calls, selector and spawn. Existing startup/recovery fixtures exercise opposite ambient selectors and a custom executable with real materialization/provenance outputs. Implementer focused strict typecheck and ESLint passed; independent source verification passed; parent reran selector/wiring checks 2/2 after repairing the affected old two-argument assertion. Guarded startup/recovery runtime checks returned admission 75; compiled/full checks must be supplied by the next valid run.
- M3 affected discovery confirmed and published a body-read failure gap: malformed gzip under HTTP 200 is retried as a send/network error, while Node performs one request and emits no failure telemetry artifact. The radix Number repair still double-rounds `0x2000000000000101` and its binary equivalent by one ULP; its original number thread remains open. Independent verifier reproduced both Node boundaries; implementer is repairing them. Suspected terminal HTTP/deadline error-string mismatches were dismissed after bounded probes proved existing parity. The zero-detail skipped-warning suspicion was dismissed: the downloader's limit zero is separate from the child-only details-disabled flag.

### Merge and affected-check refresh, 2026-10-08

- #85 merged bottom-up after exact-head CI, independent source/closure refresh and final feedback. Squash merge 09532af5deec5eaca4e3f7edf4796899adc979a3. Read-only reconciliation found no deployment/check/workflow for that merge; Railway deploy is manual-dispatch only and was not started. Production receipt names remain uninspected, with the disclosed ordering risk covered by the approved one-time digest change. Production acceptance remains false.
- #86 rebased onto the merged main. Old and new base trees and head trees are identical; independent finder/verifier confirm unchanged intended diff and reuse valid affected checks. New-head bot code/security reviews completed. No automatic CI run appeared; Checks was explicitly dispatched as run 37790898344. Its result remains a merge gate.
- Actual Node compute gates: #89 run 37783588287 failed normalized 6.771593594119191; #91 run 37785976017 failed 6.516666666666667; #92 run 37786871710 failed 6.648513077749911. Parity and memory passed in each. Rust jobs passed. Node runtime diff #88 to #89 contains only the parity check and fixture inputs, outside the benchmark path; the inherited compute margin is thin. Independent source review confirms repeated raw/public gzip inflation in final publication validation. The scoped-proof repair is published in #88 review 5457944341 and is in progress; its benefit is unmeasured, with no threshold change or waiver.
- #92 pending-body repair moves Oracle/LoL failed-response classification before body reads; Leaguepedia inspection stays intact. Parent diagnosed the twice-failed fixture: Node had persisted its result but unread HTTP responses kept the CLI alive. The corrected test compares the direct shared Node retry policy, cancels owned responses/sockets, and retains bounded native CLI checks plus prior complete-body CLI parity. Six Node reference cases, focused strict TypeScript, ESLint, formatting and diff checks passed. Independent source finder/verifier confirm regression/dead-code/redundant-test coverage. Six rebuilt native comparisons are explicitly skipped locally and remain required before closing the original finding.
- Guarded native build returned admission 75 and did not execute. The helper uses the user systemd scope; actual fleet-build.service remains active under another owner, MainPID 303354. An initial system-scope query incorrectly suggested release; the parent corrected the report to #90 and the coordinator. No foreign owner was stopped and no unconstrained build ran. Local full verification/gate remains blocked by admission; the earlier configured-parent-heap exhaustion is not a passing result.
- M4 through M6 remain unimplemented. Real raw-input acceptance, live provider acceptance, shadow and cutover are still pending. No production changes or deployment occurred.
