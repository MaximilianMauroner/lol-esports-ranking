# Bounded benchmark diagnostics

The benchmark can record phase markers and bounded Inspector profiles for local
diagnosis. `RANKING_BENCHMARK_DIAGNOSTICS` enables recording only in the benchmark
process and its benchmark children. An unset variable leaves recording disabled.
Diagnostic timings include instrumentation overhead and are not gate receipts.

The guarded launcher is `scripts/benchmark-diagnostics.mjs --capture-run DIR`.
It requires a fresh directory containing only a pinned `manifest.json`, the
build helper's 3 GiB cgroup with zero swap and group OOM handling, and ends after
20 minutes. It keeps the existing benchmark command, flags, thresholds,
calibration, corpus, three repetitions, parity and integrity checks. The caller
must record source, corpus and environment identities in the manifest before use.

Only the first repetition collects profiles: allocation sampling for parent and
verifier full builds, and CPU sampling for the measured refresh. Each profile has
a time and byte limit. Phase events contain scalar counts, memory and CPU values;
overlapping spans are not a causal call tree. External profile URLs and unknown
arguments are hashed. Native error messages and stderr are retained as byte counts
and hashes, with bounded error codes and known numeric GC classifications.
Profiles, events and launcher records together are limited to less than 32 MiB.

Worker constructor errors, asynchronous errors, premature exits and readiness
timeouts save the first incomplete failure record with mode `0600`. The worker
references its control port before Inspector initialization. A pending promise
alone does not keep a worker alive. Failure cleanup terminates only the worker
created by that lifecycle; the build helper owns process-group cleanup.

The dependency-preparation launcher is separate and runs only a frozen install.
It does not run the benchmark. Neither launcher retries failed admission or work.
Use owned dependencies and keep local capture outputs out of commits.

The synthetic lifecycle regression uses no ranking corpus and collects no
Inspector profile:

```sh
node --expose-gc --import tsx --test tests/diagnosticProfileLifecycle.test.mjs
```

## Recorded baseline failure and repair

The 10 October capture on the reviewed stack ends with status 134 during
baseline setup, before any calibration/incremental measurement. A matching
parent process stamp, arguments, GC PID and phase markers distinguish it from
verifier work. The allocation profile captures large retained checkpoint
encodings; persistence then retains successive approximately 49 MB canonical
checkpoint bodies. Group memory stays below 3 GiB and build swap stays zero.
The instrumented capture is incomplete and supplies no passing gate receipt.

Sequential checkpoint persistence now uses the same checkpoint encoder and
immutable writer, retaining references rather than all prepared bodies. The
manifest keeps its ordering, compatibility, semantic identity and stored layout;
full graph verification still precedes promotion. This is a permanent memory
requirement, not a compatibility mode. The eager preparation API remains used
by existing plan/fixture callers. No stored data is rewritten or new schema is
introduced. Full-corpus recovery and the current compute cause require another
admitted capture; this observation cannot fill missing historical attribution.
