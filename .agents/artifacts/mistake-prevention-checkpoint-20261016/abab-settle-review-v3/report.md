# Independent FIXDIFF review: r3-abab-settle-fix-v3

**Verdict: APPROVE (source only).** Runtime UNRUN. New campaign UNRELEASED. Root countersign PENDING. Max acceptance PENDING. No merge is authorized.

Standing rule from Max: BEFORE ANY merge, whether GitHub or any local merge/land step, STOP, report a short tldr covering what changes, verification and risks, and WAIT for Max's explicit go. Include this exact rule in every future delegate_task brief. No merge of any kind is authorized in the current run.

## What changes

- `abab-driver.mjs:72-79`. Only the `pause(ms)` body changes. The new body sets a raw deadline from `process.hrtime.bigint()` at entry. After each timer callback, it reads the clock again. It returns only when the remaining raw time is not above zero. The call sites, signature, and Promise contract are unchanged.
- `locked-abab.sh:9`. Only the `prep` path changes, to the new revision.
- `compare-abab.mjs` is byte-identical to v2 (SHA 15ebf338...). The 3000000000 ns gate at line 103 is literal.
- `dependency-state-pins.json`, `input-manifest.json`, and `input-sha256.txt` are byte-identical to v2.
- `input-self-sha256.txt`, `commands.md`, and `source-package.json` change only revision paths, state text, and pending gates. The five `instrumentSources` keys are unchanged. `native-controls.mjs` leaves `sources` because it is not copied.

## Checks (all raw receipts in receipts/, each with argv, numeric exit, and stdout/stderr SHA-256)

- Four integrity commands: PASS, exits 0/0/0/0, with 2/141/1/56 OK entries and no other lines. The inventory SHA-256 is 108e28b81227bfa3fd8879ff0869b3a43348b971464aa1ac1937725f5ce51de3. This matches the Root observation.
- Inventory coverage: PASS. 56 of 58 package files are listed. Only `inventory-sha256.txt` and `inventory-self-sha256.txt` are excluded. There are no duplicates and no outside paths. The external observer and host stay pinned through the unchanged 141-entry input map.
- v2 base integrity: PASS, exit 0. The 750-entry v2 inventory digest is 5c883638..., which equals the countersigned `reviewedInventoryDigest`.
- Fresh diff: PASS. A fresh `diff -u` of v2 and v3 equals `diff.patch` and `revision-metadata.diff` exactly.
- Author pure controls, rerun: PASS. The results are old early exit 1, old full exit 0, old repeated exit 1, new early exit 0, new full exit 0, and new repeated exit 0. Each stdout is byte-identical to the author receipt. The controls extract the pause text from the real driver files (old 533e7bdb..., new 269e4c84...) and evaluate it in `vm`. The new repeated case stays pending at 2999999999 ns and resolves at exactly 3000000000 ns.
- Independent adversarial fake clock (`tools/adversarial.mjs`): PASS for new, 0 of 15 fail. Old is red, 9 of 15 fail. Five schedules ran for each of 3000, 100, and 50 ms: exact full, always 1 ns short, up to 2 ms early with halving, seeded random early, and 5 ms overshoot. The new code never resolves before the minimum. It reaches exactly the minimum when callbacks are short, and it finishes within 23 callbacks under a 64 bound.
- Source audit rerun: PASS, exit 0. Syntax: PASS for the driver, comparator, and control (`node --check`) and the launcher (`bash -n`), all exit 0. Node is v24.21.0.
- Node timer coercion (static source read through `--expose-internals`, no timer scheduled): a positive delay below 1 ms becomes 1 ms with no warning. The loop passes only `remaining > 0n`, so the negative and NaN warnings cannot fire. No new stderr line can appear.

## Why the fix holds the gate and does not loosen it

1. `emit` takes `hr` synchronously (`abab-driver.mjs:37`) at line 97, before `pause` entry at line 98.
2. The deadline is the entry time plus `ms * 1e6` ns, so the deadline is at least `post.hr + 3e9`.
3. `pause` returns only when the clock is at or past the deadline. `barrier` reads `hrBefore` at line 81, after that return. The clock is monotonic. So `hrBefore - post.hr >= 3000000000` always, which is the literal comparator gate.
4. There is no rounding, tolerance, fixed padding, or callback count. The exit test is the raw elapsed time only. The control window at line 240 gets the same guarantee.
5. The thresholds, the 15m/13m budgets, the 30 s bounds, the caps, the viewport, actions, order, retries 0, the control tag exclusion, and the dependency and no-install guards are unchanged. The pause(50) quiet loop and the pause(100) readiness loop now wait their full time. Their exit conditions read the clock or the file system directly, so their behavior does not change.

## Findings

No blocker. No should-fix item.

- N1 (nonblocking): `abab-driver.mjs:76`. The behavior of real libuv timers is proved only from the static Node source, not from a run. The brief does not permit a run. The worst-case overshoot is about 1 ms for each pause, and there are about 14 settle pauses. This is far inside the 13m/15m budgets. No fix is needed.
- N2 (nonblocking): `pause-control.mjs`. The control does not model the time between `postcondition-met` and `pause` entry. That time can only make the gap larger, because the clock is monotonic. Item 3 above proves this from the code. No fix is needed.
- N3 (informational): the `source-package.json` `sources` map no longer lists `native-controls.mjs`. This matches the documented choice not to copy it. The five `instrumentSources` keys that the comparator procedure uses are unchanged.
- No-comment scope: PASS. The diff adds no comments. No product file was touched.

## What stays open

- B1 for the old baseline stays BLOCKED, and D1 stays FAIL. This review cannot give any retroactive credit.
- The runtime proof that real windows are at least 3000 ms is UNPROVED until a new, released campaign unit runs.

## Owners and next action

- Root: externally pin the inventory digest 108e28b8..., countersign, then choose the NEW campaign parent and give one explicit one-unit allocation. All R3 runtime stays held while CH3 is the only heavy allocation.
- Max: acceptance and any merge go.
- CI: UNRUN. Merge status: none, and no merge is authorized.
- This reviewer: done. The manifest `review-sha256.txt` excludes itself. Its digest is reported outside the package.
