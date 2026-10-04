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
