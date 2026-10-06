---
name: verify-lol-esports
description: Verify LoL Power Index ranking and archive journeys using isolated static data. Use when checking changed ranking, match history, comparison or tournament paths.
---

# Verify LoL Esports Power Index

Read `AGENTS.md`, `README.md`, and [features.md](features.md). Use an isolated
worktree, not a running refresh owner's checkout. Select journeys affected by product work in the requested window.
Record revision, manifest
model/config/schema, source coverage, chosen port and process handle. Never
present fixture or no-data payloads as official rankings.

Check active owners, memory, load, disk and listeners. Use Node 24 and the
pinned pnpm version. Run `pnpm install --frozen-lockfile`. Start one owned static
instance on an unused loopback port:

```sh
pnpm dev --host 127.0.0.1 --port 43129 --strictPort
```

Require HTTP 200 for `/` and `/data/ranking-summary.json`. Inspect the actual
manifest before browser actions. Leave `VITE_RANKING_DATA_URL` unset so the
instance reads its own committed `public/data` tree. Do not run remote refresh,
bucket cleanup, baseline recapture, provider downloads or deployments.
`pnpm ranking:baseline` verifies the committed receipt without bucket mutation.

Establish where the browser runs. Prefer the environment-port preview target.
If it needs a network address, bind the owned instance with `--host 0.0.0.0`
and use its actual reachable address. HTTP readiness alone is not browser proof.
Use T3 preview status/open/navigate/snapshot and current role/name locators.
If preview open explicitly reports unsupported or unavailable, use an available
headless Chromium browser against the same owned instance and report that fallback.
Run journeys serially. Record browser reachability separately from HTTP.
If navigation fails, recheck readiness and retry once. Keep absent shards,
unavailable model evidence, harness failures and confirmed UI regressions
separate. Preserve intended expectations when a product fails.

Supporting checks are `pnpm verify`, public artifact tests, archive browser
tests and tournament tests. Do not repeat memory benchmarks owned by another
agent or run `release:check` merely for a procedure edit. Tests do not replace
live browser actions.

For automatic tournament ingestion, run
`pnpm exec tsx --tsconfig tsconfig.app.json --test tests/automaticTournamentIngestion.test.ts tests/refreshOnce.test.ts`.
It runs the Railway refresh wrapper against a local Cargo fixture, checks baseline
preservation across two date windows, and checks both year and global ledgers.
The refresh tests also check discovery when the official probe has no new match,
explicit audit opt-out, shadow defaults, and success receipt requirements.
These tests use no provider or bucket credentials and make no production writes.
For L6, generate an isolated offline fixture from its captured games and domestic
evidence. Compare the ledger before and after home-league resolution, select the
event in both All seasons and its year, expand a series, and reload its deep link.
Label the fixture as offline verification, preserve source/model provenance, and
restore the worktree's committed public artifacts after captures.

Before captures, exclude the owned `.agents/artifacts/<run-id>/` directory
through Git's local exclude file and confirm it with `git check-ignore`. Do not
assume the repository's singular `.agent/artifacts/` rule covers this path.
Stop the exact server session, confirm its port closes, and retain redacted
evidence in that excluded run directory. Static journeys should
not change provider or bucket state. Remove only owned downloads or captures
not needed as evidence. Report CI, review, merge and acceptance separately.
