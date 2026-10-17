# LoL Esports Power Index

An independent team-strength model for LoL esports. The app shows team and league
rankings, match history, player timelines, and tournament forecasts.

This is not an official Riot ranking. Keep each ranking claim tied to its source
manifest, model config hash, schema version, and coverage window. A fixed reference
snapshot, synthetic fixture, or no-data payload is not current official data.

[Live site](https://lol.lab4code.com/) · [Source](https://github.com/MaximilianMauroner/lol-esports-ranking)

## Run locally

Use Node 24 and pnpm 11.16.0. Native worker work also needs Rust 1.98.0.

```sh
pnpm install --frozen-lockfile
pnpm data:pull
pnpm dev
```

`data:pull` restores a fixed Node reference snapshot. It verifies the complete
path and SHA-256 digest list before replacing `public/data/`. The immutable cache
is in `data/reference/`. It does not refresh providers or write to the bucket.
Tests read this cache directly and leave your local `public/data/` tree intact.

```sh
pnpm verify
pnpm build
pnpm ranking:baseline
```

`verify` checks types, source ownership, style, tracked-file hygiene, and tests.
`build` bundles the local payload. `ranking:baseline` checks the committed safety
receipt without network access or bucket mutation. On a shared coding VM, run
heavy checks one at a time through `heavy-check`.

To calculate rankings from provider inputs, use the following commands only when
the provider collection is authorized.

```sh
pnpm data:download
pnpm data:crunch
```

Provider downloads stay in ignored `data/raw/`. Review changes to the tracked
`data/raw/manifest.json` for source provenance. Full calculations stay in
`data/derived/`. Browser payloads stay in `public/data/`. With no input arguments,
`pnpm data:build` produces an explicit no-data payload. It does not use samples as
real rankings. `VITE_RANKING_DATA_URL` selects an external browser manifest.

## Source ownership

The repository contains one private JavaScript application and a five-crate Cargo
workspace. It has one JavaScript dependency set and no package split.

| Path | Owner |
| --- | --- |
| `src/lib/`, `src/data/`, `src/types.ts` | Shared rating engine, types, and read helpers. |
| `src/browser/`, `src/hooks/`, `src/components/`, `src/views/`, app entries | Browser state, UI, artifact I/O, and simulation worker. |
| `scripts/` | Production Node server, refresh, publication, storage, and operator commands. |
| `tools/` | Developer calibration, audits, assets, and test tools. |
| `tests/` | Tests and focused fixtures. |
| `worker/` | Native refresh seams and Rust contracts. |
| `ops/` | Tracked safety receipts. |
| `.agents/artifacts/` | Ignored reports, plans, audit output, and local evidence. |

Lint checks resolved import directions. Browser runtime code cannot reach replay
producers or publication plans. Type-only imports can use shared engine types.
The test runner discovers `*Browser.test.ts` journeys and runs them one at a time.

## Railway services

The web service builds with `pnpm run railway:build` and starts with
`node scripts/railway-server.mjs`. It serves the Vite build and prefers bucket
artifacts for `/data/*`, with the local reference payload as fallback.
The build works from a source archive without Git metadata.

The refresh service starts with `node scripts/refresh-once.mjs`. The committed
cron runs every six hours. Node remains the default refresh implementation.
The gated worker uses confirmed pending matches to decide when to call providers.
The web server has no background refresh unless `RANKING_REFRESH_ENABLED=true`.
Changes to production cadence, activation, deployment, or deletion need separate
authorization. A merge to `main` can cause Railway to deploy.

Bucket access uses `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `REGION`, and
`ENDPOINT`. `RANKING_BUCKET_PREFIX` defaults to `rankings`.
`RANKING_BUCKET_REQUIRED=true` rejects a refresh without credentials.
`RANKING_BUCKET_UPLOAD_ENABLED=false` disables uploads for local work.
`RANKING_REFRESH_MODE` selects `gated` or `shadow`.
`RANKING_REFRESH_LOOKBACK_DAYS` and `RANKING_REFRESH_BOOTSTRAP_START` select the
provider collection window. Do not put credentials in source files.

## Legal

See [LICENSE](LICENSE) and the [third-party notices](worker/THIRD_PARTY_NOTICES.md).
This project is not endorsed by Riot Games and does not reflect the views or
opinions of Riot Games or anyone officially involved in producing or managing
Riot Games properties. Riot Games and all associated properties are trademarks or
registered trademarks of Riot Games, Inc.
