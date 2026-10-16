# Settle source fix v3

SOURCEONLY. Runtime UNRUN. New campaign UNRELEASED. Fresh independent FIXDIFF review and Root countersign PENDING. Max acceptance PENDING. No merge is authorized.

The new driver makes pause(ms) wait until its raw-time deadline. It starts the deadline at entry after postcondition-met. After each timer callback, it checks process.hrtime.bigint and schedules only the remaining interval. With a monotonic raw clock, returning requires elapsed raw time at least ms. The barrier starts after that return. Thus the postcondition-to-barrier gap cannot be shorter than 3000 ms. This does not depend on the guessed cached-libuv-clock cause.

## Exact changes

- abab-driver.mjs changes only the pause body. Its parameter and Promise return contract stay the same. All existing call sites remain unchanged.
- locked-abab.sh changes only the prep path to this new revision. It is a new copied source file and has never run.
- compare-abab.mjs is byte-identical to approved v2. Its SHA-256 is 15ebf3383424b63ae2739d2afc63ca79849df2ae1ebfbfac3cbc1b2d5d2b99bf.
- dependency-state-pins.json, input-manifest.json, and input-sha256.txt are byte-identical to v2. The 141 original hashes remain unchanged. No living input was repinned.
- input-self-sha256.txt changes only the revision paths. source-package.json updates revision state, source hashes, provenance, and pending gates. The five instrumentSources keys stay unchanged.
- commands.md uses the new prep path and a root-assigned NEW campaign parent. It documents the pending review, countersign, one-unit allocation, and future metadata policy. Every campaign command remains UNEXECUTED.
- diff.patch contains the complete executable source diff. revision-metadata.diff contains all changes to copied metadata and commands. All other new files are inventories, these reports, the targeted fake-clock control, its raw receipts, and source audit code and receipts. No old generated receipt, runtime file, native control, or fixture was copied.

## Verification

All controls extract and evaluate the exact pause source from the actual old or new driver. They do not execute the driver module. The fake process clock starts at a large integer nanosecond value. Fake timer callbacks advance that clock. No real timer, browser, network, fixture generation, IO cache warmup, or 3-second benchmark runs.

The exact results are as follows.

- Old early-0.507ms exits 1 at 2999493000 ns. It is old-red.
- New early-0.507ms exits 0 at 3000000000 ns. It is new-green.
- Old full-interval exits 0 at 3000000000 ns.
- New full-interval exits 0 at 3000000000 ns.
- Old repeated-early exits 1 at 2999493000 ns. It is old-red.
- New repeated-early exits 0 at 3000000000 ns after seven callbacks. It stays pending at each earlier callback, including at 2999999999 ns.

The fake scheduler has a 16-callback bound. Each advance is positive and no larger than the requested interval. The gate is the literal elapsed >= 3000000000 ns with no tolerance. checks/*.json records each original argv, actual numeric code, and stdout and stderr hashes. The raw stdout and stderr are adjacent files. Each control stdout records the actual driver hash, extracted function bytes and hash, script hash, timer advances, and elapsed time.

The driver, comparator, control, and launcher syntax checks PASS with code 0. The source audit PASS has code 0. It checks the old approved source hashes, complete diff confinement, byte equality, the unchanged 141-input map, the historical 750-entry inventory digest, and 18 source and review provenance hashes. The two input integrity commands PASS with code 0. Their raw receipts are saved. The final four integrity commands run after inventory creation. Their final raw result belongs to the caller tool record, outside the covered package, to avoid a self-referential receipt.

## Gates and limits

The configured settle and quiet periods remain 3000 ms. The comparator threshold remains 3000000000 ns. No rounding or threshold tolerance was added. The 15m outer budget, 13m host budget, 30s readiness and action bounds, memory and disk gates, lock order, runtime caps, viewport, actions, locators, ordering, positive control, and zero retries stay unchanged. The helper now also honors its existing 50 ms and 100 ms requests. No configuration value increases.

The comparator still counts every postloaded artifact attempt through context close, including control and teardown. It excludes only the exact uniquely tagged control pair. Initial-load handling, optimizer freeze, observer coverage, errors, terminal, source identity, dependency maps, fixture generation, and cached-control gates stay literal.

Timers can overshoot the deadline. Repeated early callbacks need extra timer wakeups until raw time reaches it. Existing hard budgets remain in force. The fake controls prove clock logic only. Actual runtime validity, resource readiness, and the four-unit campaign remain unproved. If real measurements are required now, that work is BLOCKED by this task's source-only restriction.

The first actual baseline ran once with code 0, but B1 stays BLOCKED. The independent review measured 2999.916099 ms, 2999.750251 ms, and 2999.493025 ms. This source fix cannot alter those gaps or give that run retroactive credit. No automatic retry or next head is released.

D1 remains FAIL. The old metadata self-entry claimed the empty-file hash. The independent review's 117 observer-covered runtime entries and 35 other metadata entries matched. These facts do not repair the original manifest or recover an exit. New inventories exclude their own hash file and detached digest. Root must hash and pin the final inventory externally. No original metadata or writer was changed.

## Ownership and next action

Root owns the fresh independent FIXDIFF review, external inventory pin and countersign, new campaign parent, and new explicit one-unit allocation. Max owns acceptance and any future merge go. CI is UNRUN. No PR or merge work occurred. Source review remains PENDING. This author grants no approval.

Model the Domain kept the raw deadline and remaining time inside pause(ms). Laziness Protocol limited the executable diff to the required body and revision path. Test Behavior, Not Implementation selected the elapsed-time contract and both early and valid callbacks. No nested agent was used because the brief forbids it. Real-surface verification is BLOCKED by the same explicit scope.

Standing rule from Max: BEFORE ANY merge, whether GitHub or any local merge/land step, STOP, report a short tldr covering what changes, verification and risks, and WAIT for Max's explicit go. Include this exact rule in every future delegate_task brief. No merge of any kind is authorized in the current run.
