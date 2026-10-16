# Independent fix-diff review v2: r3-lanes78-companion-fix-v2

## Result

**BLOCKED.** One new blocker, R1. Runtime is UNRUN. Max acceptance is PENDING. This review gives no merge authority and no runtime release.

Scoped result:

- B2, B4, S1, S3, S4 and S6 are acceptable at source level.
- S7: the provenance split is acceptable. The literal "new HTTP response" claim stays BLOCKED when the app cache serves the action.
- B1 and B3 are PARTIAL. The tsx, TMPDIR, Node cache, IPC, Vite runner and dependency-pin repairs are correct. R1 is still open: the Vite optimizer can write into the runtime root before the after-check.
- S2 selection proof and S5 pixel proof stay PENDING, as the author states.

Standing rule from Max: BEFORE ANY merge, whether GitHub or any local merge/land step, STOP, report a short tldr covering what changes, verification and risks, and WAIT for Max's explicit go. Include this exact rule in every future delegate_task brief. No merge of any kind is authorized in the current run.

## Integrity (verified externally)

| Check | Exit | Status |
|---|---|---|
| `sha256sum --strict --quiet --check inventory-self-sha256.txt` | 0 | PASSED |
| `sha256sum --strict --quiet --check inventory-sha256.txt` | 0 | PASSED |
| `sha256sum --strict --quiet --check external-inputs-sha256.txt` (76 lines, includes inspect.py) | 0 | PASSED |
| inventory-sha256.txt = `31bdcb73c6387e879435d23a0aa657b4e18da4792274666c3c5701b4b6760b5f` | - | Matches Root |
| inspect.py = `ea94e43a4ab50b7b9db16657cba1fde6e9f988a0a922dfe7077f0e80dcaffb4b` | - | Matches pin |
| `node --check` on 8 `.mjs` files | 0 | PASSED |
| `bash -n run-lanes78.sh` | 0 | PASSED |
| `node --check address91-recipe.mts` (type-strip parse) | 0 | PASSED |
| `node --check retained-v1-checks/address91-recipe.ts` | 1 | FAILED (S1, stays FAILED; bytes equal the .mts file) |
| `source-controls.mjs` rerun (hash-identical copy) | 0 | PASSED, 44 of 44 |

About the controls rerun: the author script requires its output under its own package `receipts/` directory, and that directory is read-only. My first attempt therefore exited 1 on that path assertion. That exit is not a control failure. I copied `source-controls.mjs` (`d7371d9d...`) and `source-guards.mjs` (`27b6a04e...`) with identical hashes into `rerun-src/` and ran them there. Output: `rerun-src/receipts/controls/source-controls.json` sha `c6919272848c872dde4f8a99319f657e44182091bc43d209523cb8d2aeb2b2db`.

## New finding

### R1 (BLOCKER): Vite optimizer can rewrite runtime-root `node_modules/.vite` before the after-check

- Where: `lanes78-driver.mjs:429` (plugin `lanes78-address91`), `:460` (createServer), `:462` (cacheDir is `<root>/node_modules/.vite`), `:378-380` (pin before), `:711` (pin after). The pinned Vite source is `t3-14557610/node_modules/vite/dist/node/chunks/node.js:31933-31941`.
- Mechanism (CONFIRMED in the pinned source): `getConfigHash` includes `plugins: config.plugins.map((p) => p.name)`. The driver adds the plugin `lanes78-address91`. The frozen `_metadata.json` has `configHash` `5e0aa88f`. Nothing in the package shows that this hash was made with the same plugin list.
- Reach (PLAUSIBLE): if the hash does not match, Vite re-optimizes at server start. It then replaces the deps directory in the runtime root. Dependency discovery during the session can do the same. The driver detects the drift only after the unit, at line 711. The unit then fails, so this is not a false pass. But the write outside the owned output has already happened, and the frozen optimizer pin no longer matches for later units. The author report (line 15) says this behavior is UNRUN and needs independent review. This review confirms the risk.
- Smallest compliant fix: before `createServer`, prove reuse without writes. Resolve the config with the exact plugin array. Compute configHash and lockfileHash with the algorithm from the pinned Vite dist. Compare them with the pinned `_metadata.json` and abort before the server starts if they differ. During the unit, block on any Vite optimizer or re-optimize log line. If this cannot be proven, the bounded-write claim stays BLOCKED. Do not copy the cache, warm up or add a rebuild exception.

### N4 (NIT, PLAUSIBLE, not verified): Chromium HOME-level writes

`run-lanes78.sh:24-31` does not redirect HOME or XDG_CACHE_HOME, and it does not take an inventory of them. Chromium can touch `~/.pki/nssdb`, and fontconfig can touch `~/.cache/fontconfig`. This is not a false pass, but the bounded-write evidence does not cover these paths. Fix: record them before and after, or redirect XDG_CACHE_HOME to the owned sibling. Keep the Playwright browser lookup unchanged.

### N5 (NIT, CONFIRMED): launcher checks are not strict

At `run-lanes78.sh:17-19`, `sha256sum --check` runs without `--strict`. Add `--strict`. The impact is low because the inventories are frozen.

## Prior findings, re-checked against the fix diff

- **B1 (PARTIAL).** The launcher makes the `${out}.tmp` sibling with mode 0700 and `umask 077`. It sets TMPDIR, TMP and TEMP to that directory and sets `TSX_DISABLE_CACHE=1`, `NODE_DISABLE_COMPILE_CACHE=1` and a private `NODE_COMPILE_CACHE` (`run-lanes78.sh:20-31`). `assertOwnedTemp` checks that the directory is not a symlink, that its realpath is itself, its uid and its mode 0700 (`source-guards.mjs:73-82`). The driver also asserts that `tmpdir()` and the cache variables match (`lanes78-driver.mjs:61-66`). Vite uses `configLoader: 'runner'`, so no config bundle is written in the root. Cleanup sends no signals and deletes no files. It finds survivors by pid plus startTicks (both strings, `driver:235`, `cleanup-owned.mjs:16`), finds processes that refer to the temp path in argv, and fails closed when the ownership receipt is missing. R1 is still open.
- **B2 (RESOLVED AT SOURCE).** `requireColdHistory` requires a nonempty closure, no overlap with `semanticCacheBefore`, and a full bag with no cache subtraction (`source-guards.mjs:32-36`). `auditPhases` checks setup, initial-navigation, sensitivity-control, teardown, every planned phase and every observed phase, in both PW and CDP. Unplanned phases after setup must have empty bags (`:46-71`). `auditInputBoundaries` compares the actual PW `timing.startTime` and the CDP `wallTime` with the trusted click epoch. A missing start time fails (`:135-151`). Duplicate and aborted requests stay in the bags. The per-step bags are literal in both PW and CDP (`driver:291-292`). Teardown is planned with an empty bag (`driver:701`). Sensitivity-control is planned with exactly one non-forbidden URL (`driver:670`). The controls cover each phase in both sources, the late initial request, and the pre-click request.
- **B3 (PARTIAL).** The shared store is disclosed. The pins cover 98 packages and 20011 files. They check realpath, the exact file inventory (added files fail), no symlinks and content hashes. They are checked before tsx (the preloader), and before and after the unit (`driver:382`, `:712`). Package-manager processes in either canonical sample are rejected (`source-guards.mjs:126-133`). The 47 optimizer files are pinned, but the pin only detects drift and does not prevent it (R1).
- **B4 (RESOLVED AT SOURCE).** The inspector path and SHA are pinned in `source-guards.mjs:6`, `release.template.json:26-27` and `external-inputs-sha256.txt:76`. `validateAdmission` checks the real `inspect.py` fields: `phase`, `at` (from 0 to 30 s old, with a parsed timestamp), `ready === true`, empty `errors`, `head`, `tree`, `status`, 680 blobs, PSI, memory, disk, `processMatches`, both process samples, `processInspectionErrors`, and the lock paths with acquired and released state. These field names match `inspect.py:121-195`. The exit receipt must show exitCode 0, signal null, no spawn error, the exact command and the pinned inspector (`driver:48-54`). There is no typed approved field and no observedAt trust. The inspector itself is UNRUN.
- **S1 (RESOLVED).** The FAILED label is preserved.
- **S2 (SOURCE OK, PROOF PENDING).** Each closure member records inline or archive storage, references, URL, digest and raw body path (`driver:179`). Each selected key has a JSON pointer and request, response and body sequence numbers (`driver:202-210`). Aggregate requests give no claim of correct selection.
- **S3 (SOURCE OK, spot check).** Geometry runs before each history phase (`driver:287`) and around each pick (`:604-657`). Runtime is UNRUN.
- **S4 (RESOLVED AT SOURCE).** A second main-frame navigation request, or one outside initial-navigation, blocks (`driver:510-513`). A second CDP `Page.frameNavigated` for the main frame also blocks (`:573-578`). Hash navigation inside the same document does not fire `frameNavigated`, so it stays allowed.
- **S5 (PENDING).** Correctly kept PENDING.
- **S6 (SOURCE TRACE OK, ACTUAL CLOSURE UNRUN).**
- **S7.** The record has `newHttpResponseClaim: false` and records cache reuse separately (`driver:297`). The literal claim stays BLOCKED when the action is cached.
- **N3.** Deferred by scope. Runtime PENDING.

## What still cannot be proven from source

- The bounded-write predicate, until R1 is fixed. Missing proof: an optimizer configHash and lockfileHash equality proof made before the server starts.
- The original strict lane 7/8 predicates. Missing proof: real runtime evidence for natural geometry, complete attempt bags, the sensitivity control, chart points, exits, cleanup and media. Also an actual digest catalog for S2 and S6, an exact pixel-to-raw-value mapping for S5, and a new HTTP response for S7 when the app cache serves the action.

## Conduct

Every read was read-only. I ran no Git command. I ran no server, browser, network call, install, build, product test, heavy-check or inspector. I wrote only in this directory. I used no nested agents.

## Open decisions

- Root: decide whether to order an R1 repair round or keep the bounded-write claim BLOCKED. Next action: Root decides before 23:50Z.
- Max: acceptance PENDING. No merge is authorized.
