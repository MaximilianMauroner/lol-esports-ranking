---
name: verify-lol-esports
description: Verify the LoL Esports Power Index web UI with T3 preview and isolated static data. Use for ranking, search, details, comparison, match archive, region, and tournament changes.
---

# Verify LoL Esports Power Index

Read `AGENTS.md`, `README.md`, and [the feature index](features/README.md).
Read each selected feature guide before setup. The browser is the primary user
interface. L9 and L10 cover local operator commands. Native services and provider
refreshes need their own checks and authorization.

## Launch

Check active agents, `git status --short`, `git worktree list`, `ss -ltnp`,
`free -m`, and `df -h .`. Reuse an existing server for this worktree if its owner
permits driving it. Do not stop or replace that server during cleanup.
Otherwise use a disposable worktree at the revision under test. Keep evidence
outside that worktree. Uncommitted changes do not enter a new worktree. To verify
such changes, use the current checkout only if no refresh owner uses it.

Use Node 24 and pnpm 11.16.0. For L10, run only the dependency install below,
then use its feature guide to generate the payload instead of `pnpm data:pull`.
For the reference ranking journeys, run both commands:

```sh
pnpm install --frozen-lockfile
pnpm data:pull
```

This reaches a usable ranking board from an empty data directory. No database,
migration, or login is needed. `data:pull` downloads a fixed public GitHub snapshot,
checks its complete path and SHA-256 digest list, and replaces `public/data`.
It writes a cache in `data/reference`. Use an owned checkout because Git cannot
restore ignored payloads. A reference snapshot is not a current official ranking.
For an existing owned payload, record provenance before reuse.

Leave `VITE_RANKING_DATA_URL` unset. Check `.env` files for overrides. Start Vite
in a retained terminal session on the unused port 43129:

```sh
pnpm dev --host 127.0.0.1 --port 43129 --strictPort
```

Record the checkout, revision, port, terminal session, and listener PID. Require
Vite's ready message, then run Doctor. The browser must show the loaded board,
not just an HTTP response. If the remote browser needs a network address, bind
the owned server to `0.0.0.0` and use its reachable address. Record that choice.
Stop the exact session as described in Cleanup, including after failed attempts.

Rankings use local static files. Tournaments can call the live Leaguepedia feed.
Do not open Tournaments in an offline proof without an owned local
`public/tournament-data/feed.json` override. The existing tournament browser tests
use fixture middleware at that HTTP boundary. Record its synthetic provenance.
Do not run provider collection, bucket changes, publication, baseline recapture,
or deployment. Do not treat a dry-run name as evidence that these actions are safe.

## Doctor

Run this read-only check from the chosen checkout before driving or after a fault:

```sh
node --version
pnpm --version
ss -ltnp 'sport = :43129'
curl --fail --silent --show-error http://127.0.0.1:43129/ -o /dev/null
curl --fail --silent --show-error http://127.0.0.1:43129/data/ranking-summary.json
```

Compare the listener PID with the process you started and inspect
`/proc/<listener-pid>/cwd` on Linux. It must resolve to the chosen checkout.
Inspect the returned manifest's schema, source coverage, data mode, model identity,
and config identity. Keep the complete manifest as evidence. A wrong checkout,
missing payload, invalid manifest, or unintended remote URL fails Doctor.
A browser reachability failure is separate from HTTP readiness.

## Drive

Call T3 `preview_status`, then `preview_open` with `profileId: "incognito"` and
`reuseExistingTab: false`. Retain the returned `tabId` for every browser call.
Use `preview_navigate` with
`target: {kind: "environment-port", port: 43129, path: "/#rankings?scope=all"}`.
Read `preview_snapshot` before each action and use its current ARIA refs.
Do not operate a tab while a human owns it.

For the first proof, run L2's search journey. Wait for the heading
`Team Power Index`, a loaded table, and the search input with placeholder
`Find a team`. Use `preview_type` to enter a team name observed in that table.
Capture the filtered board and its address. Click the button whose accessible
name is `Clear search for ` followed by that name. Capture the restored board.
Reload the filtered address with `preview_press` using Control-R, or call
`preview_evaluate` with `location.reload()`. Check that the same search and results
return. Navigating to the same hash alone does not prove a full reload.
Read [L2](features/l2.md) for the remaining filter and address journeys.

Use `preview_select` only for native selects. Use `preview_click` for custom
controls. Read DOM or network state with `preview_evaluate` when needed, but never
set internal application state to make a proof pass. Run journeys serially.
If navigation fails, run Doctor and retry once. Follow T3's browser fallback
rules if preview is unavailable or repeatedly fails. Record the raw error and
fallback. HTTP readiness and automated test results do not replace browser proof.

## Evidence

Create `.agents/artifacts/<run-id>/` in the source checkout, outside disposable
worktrees. Exclude that exact directory in Git's local exclude file and confirm
with `git check-ignore`. Do not assume the singular `.agent/artifacts` rule covers it.

Save a run record with revision, setup, selected journeys, commands, actions,
addresses, pass or failure results, and cleanup. Save the manifest and before,
action, and after snapshots. Use `preview_snapshot` with `save: true`, then copy
its `screenshotPath` into the run directory. Call `preview_snapshot` again without `save` to capture semantic text and
action history. The saved-image call returns only the image path. Record actions
in the run record when the tool truncates its history. A final screenshot alone does not prove the action.

Verify visible state and side effects. Search must update the URL and rendered
rows, then survive a reload. For local operator journeys, inspect their output
files and receipts. Capture requests to confirm the browser journey only reads
data. Mocks belong at an existing external HTTP boundary, not in UI state.
A missing fixture precondition fails that journey. Record the reason in its
feature guide's Gotchas. Keep harness failures separate from product failures.
Keep ranking claims tied to the captured source and model configuration.

## Cleanup

Close only the browser tab you created with `t3_preview_close`. Send Ctrl-C to
the retained server session and wait for its exit. If needed, signal only its
recorded PID after checking ownership. Never kill by process name. Confirm the
listener closes with `ss -ltnp 'sport = :43129'`. Leave a reused server running.

Remove only owned scratch payloads, fixture overrides, and disposable worktrees.
Check the worktree for unexpected edits first. Never remove the source checkout
or evidence directory. Confirm the manifest, snapshots, screenshots, and run
record still exist after cleanup. Report local checks, CI, review, merge, and
user acceptance separately.

## Helpers

This skill ships no helper scripts. It uses package commands and T3 preview.
Existing browser tests under `tests/*Browser.test.ts` provide selectors and
fixture recipes. Supporting checks include `pnpm verify`, artifact tests,
archive tests, and tournament tests. Run heavy commands on hostname `coding`
through `heavy-check`, one at a time. Do not run `release:check` for a skill edit.

Use `/maintain-verification-skill` to update the feature map as the app changes.
