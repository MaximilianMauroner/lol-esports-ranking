# Incremental gate runner calibration

The incremental production-shaped gate now limits compute time in runner
calibration units, not wall-clock milliseconds. The old 15,000 ms limit failed
identical code on slow GitHub-hosted runners and passed it on fast ones.

## Root cause

GitHub-hosted `ubuntu-latest` runners execute this workload at different
speeds. All runs below use the same image (`ubuntu-24.04` 20260927.320.1).

| Evidence | Result |
| --- | --- |
| Code before `#79`, 16 runs | Median computeMs from 7,904 to 15,858 ms (2.0x) |
| Main after `#79` and branches on it, 6 runs | Median computeMs from 10,534 to 18,573 ms (1.76x) |
| Main `4c3d4dd4`, run 37607429268 (centralus) | 10,534 ms, passed |
| Main `4c3d4dd4`, run 37618176049 (westus) | 18,044 ms, failed |
| Same SHA `6b99704f`, two runs started together | 10,983 and 13,281 ms |
| Repetitions inside one run | 0.2% to 4% spread; repetition 1 is not slower |
| Stages, these two main runs | Every stage slowed 1.5x to 1.8x: replay 5.9 to 10.3 s, restore 1.07 to 1.80 s, promotion 0.87 to 1.43 s |
| Verifier full build (outside the timed window) | Slowed by the same 1.77x |

The slowdown is uniform and comes from the runner. It is not warm-up,
transpilation, I/O, or a single phase. computeMs times only
`refreshDataIfChanged`. Fixture setup, baseline seeding, lease acquisition, and
the verifier are outside the window. The raw-source child process starts inside
the window, as it does in production.

Garbage collection is not the cause. A local profile showed 1.6 s of
main-process GC in a 21.8 s window. Main-process CPU time (25.5 s) exceeded wall
time, so the window is CPU-bound. This CPU time excludes the raw-source child
process.

A wall-clock limit cannot work on this runner pool. In the same 30 jobs,
`tsc -b` took 8.6 to 16.1 s, so runner speed varies about 1.86x. A limit must
exceed the slowest runner's value plus about 4% noise (1.94 times the fastest
runner's value). To catch a 2x regression on the fastest runner, it must stay
below 2 times that value. This leaves a 3% window, and any code or data growth
closes it.

Code and corpus growth also used up the margin. Commit `#79` added about 16%
compute, and the checked-in corpus grows with each data refresh. The 15,000 ms
limit came from the July pipeline rewrite (`#13`) without a recorded derivation.

## Calibration evidence

The same CI jobs run `tsc -b`, a single-threaded, allocation-heavy JavaScript
workload. Its duration tracks the gate's runner factor. I/O-bound unit tests do
not: they slow about 1.3x where the gate slows 2.3x.

| Code | Runs | Compute time (s) / tsc time (s) |
| --- | ---: | --- |
| Before `#79` | 16 | 0.91 to 1.07, while computeMs ranges 7,904 to 15,858 |
| Main after `#79` and branches on it | 6 | 1.11 to 1.19, while computeMs ranges 10,534 to 18,573 |
| Corpus +18% (`fix/team-previews-demacia-cup`) | 4 | 1.69 to 1.80 |
| coding-vm (i7-6700K), main | 1 | 1.19 (21.006 s / 17.7 s) |

The ratio removes the runner factor. It keeps real code and data growth visible.

## Gate

`scripts/benchmark-calibration.ts` runs a fixed, seeded workload that uses only
Node built-ins. Ranking code changes cannot change its duration. Its mix follows
the refresh CPU profile: a large live object graph, Map updates and float math,
canonical JSON, SHA-256, and gzip. Before each repetition, the benchmark runs it
in a fresh process with the refresh worker's V8 flags.

Each repetition must satisfy `computeMs / median(calibrationMs) < 6.5`. For an
even number of runs, the median is the mean of the two middle values. The
benchmark output reports unrounded `normalizedCompute`, the calibration runs,
raw `computeMs`, `mainCpuMs`, and the runner CPU model. `mainCpuMs` is the main
worker's CPU time and excludes the raw-source child process.

The limit is 1.4 times main's value on coding-vm (4.64). On the observed CI
runners, main measures about 4.0, so the limit is about 1.6 times main's value.
1.4 is the geometric midpoint between no change and a 2x regression.

| Local gate on coding-vm, main `4c3d4dd4` | computeMs | calibrationMs | normalizedCompute | Result |
| --- | --- | --- | --- | --- |
| Before (15,000 ms limit) | 21,170 / 20,829 / 21,006 | not measured | not measured | failed |
| After (6.5 limit) | 21,225 / 21,402 / 21,525 | 4,426 / 4,611 / 4,634 | 4.603 / 4.642 / 4.668 | passed |

A 2x compute regression fails on every observed host. It gives about 9.3 on
coding-vm and about 7.7 to 8.3 on CI. If a CI runner's value differs from
coding-vm's by up to 25% in either direction, main still passes (at most 5.8)
and a 2x regression still fails (at least 7.0). A 1.5x regression fails on
coding-vm (about 7.0), but on CI it gives about 6.1 to 6.2 and can pass. The
+18% corpus branch used about 1.47 times main's raw compute on a CI runner of
similar speed. It would fail on coding-vm and would likely pass on CI.

## Limits and maintenance

- Two GitHub CI samples of main's ranking code (PR #83 runs) measured
  `normalizedCompute` below coding-vm's 4.64:
  - [Run 37631526444](https://github.com/MaximilianMauroner/lol-esports-ranking/actions/runs/37631526444)
    on an AMD EPYC 7763: 4.040 to 4.045, about 13% below.
  - [Run 37641207104](https://github.com/MaximilianMauroner/lol-esports-ranking/actions/runs/37641207104)
    on an AMD EPYC 9V74: 3.860 / 4.053 / 4.142, median 4.053, about 13% below.

  Both samples are within the 15% transfer band; see the
  [measurement record](https://github.com/MaximilianMauroner/lol-esports-ranking/pull/83#issuecomment-6039595377).
  The band applies to the median `normalizedCompute` of one run. A single
  repetition can fall outside it when runner speed drifts between repetitions.
  For example, repetition 1 of run 37641207104 is 16.8% below 4.64. Evidence
  across additional runner regions remains limited. If a run median falls
  outside the band, replace the workload; do not raise the limit.
- Measure the limit again after a Node major upgrade (`NODE_VERSION` in
  `.github/workflows/checks.yml`) or a calibration workload change. Do not
  change it to admit a slower refresh without a recorded budget decision.
- The gate no longer has a wall-clock compute target. Memory, upload, parity,
  and scope targets are unchanged.
