# Rust refresh worker: execution log

Plan: https://tools.mauroner.net/artifacts/fUiy-OiLobn0LbC4LBK_vTP8O9wbtjhH
Issue: #84

## Progress

- [ ] M0 prerequisite A: code-unit order for data, model config bump (this PR)
- [ ] M0 prerequisite B: digest-based reuse checks for state, raw, and public objects
- [ ] M0 golden fixtures exporter
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

## Acceptance checks

```json
[
  {"id": "baseline", "check": "Baseline verify and gate results on origin/main are recorded", "proof": "Log entry with pnpm run verify result, gate peak memory, and normalized compute", "passes": false},
  {"id": "railway-env", "check": "Railway Node version, TZ, and LANG are recorded with their source", "proof": "Log entry naming the source", "passes": false},
  {"id": "fixtures-stable", "check": "Fixture export is deterministic", "proof": "Two exporter runs produce identical files (diff is empty)", "passes": false},
  {"id": "rust-contracts", "check": "Rust matches every golden fixture", "proof": "cargo test passes in CI; a changed fixture byte makes it fail", "passes": false},
  {"id": "raw-worker-parity", "check": "Rust raw source worker output equals Node's", "proof": "Equal prepared object keys and bytes on the benchmark corpus and data/raw; both peak memory values in the log", "passes": false},
  {"id": "fetch-parity", "check": "Rust fetch output equals Node's on recorded responses", "proof": "Test comparing staging files and manifest passes", "passes": false},
  {"id": "bucket-parity", "check": "Rust bucket writes equal Node's and respect the lease", "proof": "MinIO object set comparison passes; lease-change test blocks promotion", "passes": false},
  {"id": "model-parity", "check": "Full and incremental Rust builds equal Node's digests", "proof": "Benchmark spawn mode reports zero differing paths, equal state digests, equal reconciliation", "passes": false},
  {"id": "gate-memory", "check": "Rust worker passes the gate with margin", "proof": "Gate peak memory and normalized compute for both workers in the log", "passes": false},
  {"id": "shadow-clean", "check": "14 days of shadow runs match Node", "proof": "Daily comparison reports zero differing paths for all runs", "passes": false},
  {"id": "cutover", "check": "Production runs the Rust binary for 7 days without failure", "proof": "Railway run history and active generations served by the site", "passes": false}
]
```

`baseline` stays false: `pnpm run verify` passed on the branch, but the gate was not run locally; CI runs it.
`railway-env` stays false: no source in the repository states the Railway Node version, `TZ`, or `LANG`.
