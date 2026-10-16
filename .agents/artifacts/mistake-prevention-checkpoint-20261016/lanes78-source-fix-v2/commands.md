# Commands for a future allocation

All runtime commands below are UNEXECUTED. This source package has no runtime release. Root must first obtain an independent fix diff review and countersign the exact inventory. Read `proof-spec.md` and `demand-source-trace.md`. Keep all failed outputs. Run no automatic retry, warmup, install, browser test, build, generator, or replacement inspector.

Standing rule from Max: BEFORE ANY merge, whether GitHub or any local merge/land step, STOP, report a short tldr covering what changes, verification and risks, and WAIT for Max's explicit go. Include this exact rule in every future delegate_task brief. No merge of any kind is authorized in the current run.

## Assign exact new paths

Root assigns one allocation with these values. Every placeholder must be replaced. The source root is fixed by the canonical inspector. No baseline or ABAB run is part of this allocation.

```bash
PACKAGE=/home/codex/.local/state/pstack/mistake-prevention-20261015/max-update/r3-lanes78-companion-fix-v2
RUNTIME_ROOT=/home/codex/.t3/worktrees/lol-esports-ranking/t3-14557610
RUN_OUT='<existing canonical parent>/<new allocated run directory>'
RELEASE_JSON='<root-owned new allocation release JSON>'
NATIVE_DIR='<root-assigned fresh metadata directory>'
BEFORE_EXIT='<existing canonical parent>/<new before numeric exit receipt.json>'
AFTER_EXIT='<existing canonical parent>/<new after numeric exit receipt.json>'
BROWSER_LOCK=/home/codex/.local/state/pstack/mistake-prevention-20261015/browser.lock
cd "$RUNTIME_ROOT"
```

Confirm no concurrent store writer, no ABAB overlap, no active owner conflict, and no install activity against `/home/codex/work/lol-esports-ranking/node_modules/.pnpm`. This store is shared. Confirm the frozen optimizer and the unchanged metadata pins. Do not call the dependencies private. Do not copy a cache or start a store custodian.

Verify the package against Root's detached inventory pin. These checks do not constitute review.

```bash
sha256sum --check "$PACKAGE/inventory-self-sha256.txt"
sha256sum --check "$PACKAGE/inventory-sha256.txt"
sha256sum --check "$PACKAGE/external-inputs-sha256.txt"
```

## Capture the canonical before admission

Use the canonical inspector path below. Its SHA256 is `ea94e43a4ab50b7b9db16657cba1fde6e9f988a0a922dfe7077f0e80dcaffb4b`. The recorder calls exactly `python3 inspect.py "$NATIVE_DIR" before`. It records the real numeric exit, signal, command, stdout, and stderr. It never substitutes another inspector.

```bash
set +e
node --max-old-space-size=128 "$PACKAGE/record-native.mjs" "$NATIVE_DIR" before "$BEFORE_EXIT"
before_recorder_exit=$?
set -e
printf 'before_recorder_exit=%s\n' "$before_recorder_exit"
```

Retain `$NATIVE_DIR/before-native.json`, its 680-source-blobs receipt, and `$BEFORE_EXIT` with its stdout and stderr files. Root must inspect the actual record and status. Do not proceed on a missing or nonzero exit. No native command was called during package authoring.

Complete a new external release from `release.template.json`. Bind the real before directory, body hash, recorder receipt hash, canonical inspector path and hash, derived heavy lock, review hash, and Root countersign hash. Confirm no concurrent store writer through Root's actual process and ownership check. Set the release only for this one unit. Its JSON `at` must remain at most 30 seconds old when the driver checks it. Release-typed freshness or approved fields do not count.

## Launch once after release

Run one foreground unit. The browser lock stays inside heavy-check. Retain the terminal's actual final code and signal. The observer records the actual heavy-check child close. The launcher records the actual driver exit and its owned cleanup exit separately.

```bash
set +e
node --max-old-space-size=128 "$PACKAGE/observe.mjs" "$RUN_OUT" -- \
  /home/codex/.local/bin/heavy-check --repo "$RUNTIME_ROOT" --timeout 15m --lock-timeout 0 -- \
  flock -n -E 76 "$BROWSER_LOCK" \
  bash "$PACKAGE/run-lanes78.sh" "$RUNTIME_ROOT" "$RUN_OUT/driver" "$RELEASE_JSON"
actual_caller_exit=$?
set -e
printf 'actual_caller_exit=%s\n' "$actual_caller_exit"
```

The launcher creates `$RUN_OUT/driver.tmp` with mode 0700. It sets TMPDIR, TMP, TEMP, TSX_DISABLE_CACHE=1, NODE_DISABLE_COMPILE_CACHE=1, and a private Node compile path before any tsx or Playwright code loads. A preloader failure still invokes owned cleanup and remains a failure. The driver verifies package code pins before and after. It checks the full existing optimizer against optimizer-pins.json before and after and rejects drift. The Vite runner avoids a config bundle in `.vite-temp`.

Keep the original 900-second outer ceiling, 1536 MiB driver heap, PSI full avg60 at most 5%, available memory at least 1536 MiB, free disk at least 4 GiB, and at most 900 seconds and 30 samples for readiness. The existing 780-second driver budget and 30-second actions and quiet bounds remain unchanged. No new readiness loop or retry was added. Missing or timed-out output is preserved.

## Capture the canonical after result

After the actual caller has returned, capture exactly `python3 inspect.py "$NATIVE_DIR" after` through the same recorder. Do not invoke it while the allocation still owns either lock.

```bash
set +e
node --max-old-space-size=128 "$PACKAGE/record-native.mjs" "$NATIVE_DIR" after "$AFTER_EXIT"
after_recorder_exit=$?
set -e
printf 'after_recorder_exit=%s\n' "$after_recorder_exit"
```

Retain `$NATIVE_DIR/after-native.json`, its source blobs, the actual numeric exit receipt, and its raw stdout and stderr. Check the actual owned port, descendant absence, and acquired and released locks. A browser that retains an inherited heavy lock fails cleanup. Never signal an outside process or alter heavy-check or flock. The owned cleanup inventory retains temporary files and every inspection error. It deletes no failed evidence. Missing cleanup stays PENDING.

## Obtain independent evidence review

Read every PW, CDP, server, initial, postloaded, control, and teardown row. Reconcile every attempt and terminal event with raw bodies and HTTP receipts. Preserve aggregate closure identity and exact selected-key maps. Inspect the mounted SVG geometry against saved current-unit raw values. Props alone grant no pixel credit.

Lane 8 must record earlier response sequences when it uses app cache. No new HTTP response may be claimed for a zero-request action. Block the literal new-response claim if it cannot be met. Do not change the oracle wording or predicate. Root must countersign any independent interpretation of the original coverage.

Retain actual companion PNGs and finalized video hashes. Hash `artifact-sha256.json` after the observer returns. The inventory excludes itself. Nonregular temporary entries are listed without following them. Do not infer gate credit from a zero exit or source parse.

The separate T3 visible journey remains required, with its own run and tab identity. The T3 fallback rule is unchanged. Companion media gives no T3 or R4 acceptance. CI, review, runtime evidence, merge, and Max acceptance remain separate. No merge is authorized.
