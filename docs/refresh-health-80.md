# Refresh health and recovery

[Issue #80](https://github.com/MaximilianMauroner/lol-esports-ranking/issues/80)
tracks deployment diagnosis and recovery. Current observations, run receipts,
check results and owners belong in that issue and ignored
`.agents/artifacts/refresh-live-20261009/`. A GitHub deployment failure alone does
not establish a web outage or a source regression.

## Read-only diagnosis

Check GitHub deployment status history and the platform's services separately.
Record the web and refresh revisions, build/start/job stages, run cause, terminal
status and UTC times. Check the real origin's `/api/live` and `/api/ready` and
verify the affected viewer journey. A successful readiness response proves
serving at that time, not ranking freshness or a successful ingestion run.

For refresh, inspect bounded service logs through provider download, full
snapshot/public serialization, state persistence, graph verification and
promotion. The parent `provider-fetch` label covers an entire child command;
it does not attribute every later error to an HTTP request. Distinguish provider
quota/retry warnings, V8 heap exhaustion, cgroup OOM, timeout and failed integrity.
Do not access production databases or trigger a deployment/retry to diagnose.

Verify #78's cron, gated mode and daily-audit selector through read-only platform
configuration. An unset `RANKING_DAILY_AUDIT_ENABLED` enables the current default.
Unset raw/provider Rust selectors leave Node active. Enabled ingestion does not
prove successful publication. The explicit child flags in
`refresh-worker-memory.mjs` determine its heap ceiling; a larger service
`NODE_OPTIONS` does not override them.

## Bounded source repairs

Daily-audit/shadow state comparison uses bounded SHA-256 updates and reuses
checkpoint digests. Exact canonical identity and mismatch reports remain the
contract. Successful equality does not construct two complete canonical state
strings or traverse the mismatch tree.

Checkpoint persistence prepares and synchronizes one checkpoint at a time.
Only semantic references and scalar write results survive between writes.
The checkpoint encoder, ordered manifest, caller immutability, semantic/gzip
identity, immutable collision/retry checks and publication accounting remain.
Exhaustive graph verification still precedes promotion. This is a permanent
memory requirement. The eager preparation API remains for active plan/fixture
callers; remove it only after those callers migrate. Existing legacy references
remain readable under the storage migration's removal conditions.

These repairs remove measured temporary allocations. They do not prove the
exact allocation that killed an earlier production process. A later diagnostic
receipt cannot recover missing historical PID arguments, parent or phase.

## Verification and release gates

Use an isolated copy of pinned raw input. Preserve every source hash, coverage,
model/config identity, stored reference and publication integrity check. Record
which process failed and whether setup, measured worker or verifier completed.
Use the shared build helper, 3 GiB group cap and zero build swap on coding-vm.
Respect admission exit 75 and release only owned resources.

Run affected storage/comparison/integration tests, typecheck and lint. The
production-shaped benchmark retains its corpus, calibration, three repetitions,
strict compute target, RSS safety cap, upload budget and exact parity. Inspector
captures are diagnostic evidence, not passing benchmark receipts. A timeout or
bounded-log cap must remain explicit. See
[benchmark diagnostics](benchmark-diagnostics.md) for the capture contract.

Keep local checks, required CI, review, merge, deployment and product recovery
separate. Pass required checks before merging. Production retry/settings changes
need their own authorization. The release owner observes the next authorized
normal release; this refresh thread owns source verification and isolated
reproduction. Keep #80 open while exact allocation or real-input daily-audit
recovery remains unverified.

No model/config change, stored-data rewrite or production heap override is part
of these source repairs.
