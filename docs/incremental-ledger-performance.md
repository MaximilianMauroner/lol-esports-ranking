# Incremental ledger performance diagnosis

The incremental build hashes the same complete match and team input four times
per ledger row. It computes equal scoring and artifact digests, then computes
the same digest in two provider-availability callback calls. Reuse one computed
digest for both channels and pass it to one provider-availability lookup.
The canonical input, hash algorithm, stored ledger, and receipt dates stay the
same. No compatibility path is added.

## Baseline and evidence

Diagnosis started on 4 October 2026 against main
`e0f385969eb95c4847b2e66b93989870d2dd9cbd` and writer-cleanup head
`3a6f523184c4b1392ea96e4aca273c5fba96cbf6`.
[PR #73's record](https://github.com/MaximilianMauroner/lol-esports-ranking/pull/73#issuecomment-5970668237)
contains the original gate failures: main 15,096 ms, cleanup 15,344 and
15,070 ms, and local maximum 24,282 ms against the unchanged 15,000 ms target.
Memory, upload, corpus, and parity passed. Runner variation was a hypothesis.

One CPU profile per source used copies of the benchmark's existing synthetic
fixture. The complete refresh measured 22,511 ms on exact main and 24,871 ms on
cleanup. The stage named replay includes the complete incremental build, not
only rating replay. Ledger construction took about 1.6 seconds in both profiles;
checkpoint selection and causal validation were also significant costs.
These shared-host samples locate work. They do not prove a cleanup regression
or establish a gate pass.

A focused ledger probe used all 2,540 imported matches from that unchanged
fixture. Five alternating before/after runs measured 1,483–1,732 ms before and
364–431 ms after. Deep equality of the complete ledger passed, including both
digest channels, the overall digest, roster-bound inputs, and receipt dates.
The repair removes measured duplicate work. It does not establish the exact
cause of runner timing variation or guarantee performance from one retry.

Regression checks cover provider availability for existing and appended matches,
roster corrections, digest verification, checkpoint causality, and incremental
publication parity. The required three-repeat performance gate, corpus, timing,
memory, upload, correctness, and benchmark methodology remain unchanged.
Run local heavy checks under `/tmp/t3-heavy-tests-20260926.lock`.

This performance repair is separate from writer cleanup. No merge, deployment,
production data access, provider activation, or live refresh is part of diagnosis.

## Controlled follow-up on 6 October 2026

The reference is current main `9fa408e8`; the performance head is `7401c599`.
Fresh copies of the same complete synthetic seed used the production worker
memory settings. The shared heavy-test lock serialized the workers. These
diagnostic worker runs did not execute the separate semantic-parity verifier
and do not establish a required-gate pass.

| Order | Source | Refresh ms | Sampled peak RSS bytes |
| --- | --- | ---: | ---: |
| 1 | main | 24,576 | 680,316,928 |
| 2 | performance head | 21,476 | 753,582,080 |
| 3 | performance head | 21,055 | 682,672,128 |
| 4 | main | 21,072 | 711,450,624 |

Corpus checks passed in each diagnostic. Host telemetry showed little CPU and
memory pressure in the later runs, but a background file audit remained active.
Aggregate host I/O wait was 3.1–10.5% during these workers. That includes the
workers' own I/O and does not prove its cause. These are not established
uncontended-runner measurements.
The same source had different RSS peaks. These results do not prove that runner
variation is the only cause of the earlier timing or memory failure.

A separate CPU capture located checkpoint selection, causal proofs,
publication verification, and garbage collection. A five-pair arithmetic hash
trial did not improve the existing hash and was rejected. Required canonical
digests and publication closure checks remain. Reusing an earlier publication
proof would miss object mutations before promotion.

Checkpoint selection recursively canonicalizes the already encoded JSON
checkpoint only to feed the decoder's JSON parser. That transport step took
about 450 ms in the CPU capture. Native JSON serialization removes this work.
The decoder still recomputes the canonical payload digest and validates schema,
identities, state, boundary, and event proof. Stored checkpoint bytes and encoded
special values remain unchanged. This adds no compatibility path. Supported
restored bundles are parsed JSON, rather than arbitrary programmatic objects.

Full-gate timing and memory remain unwaived until the changed-source gate runs.
The transport improvement alone does not establish that the performance target
is met.
