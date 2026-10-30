# rift-delta

An independent League of Legends app. It combines team and league rankings,
match history, player timelines, tournament forecasts, and the full patch-pinned DPS lab.

This repository is the starting point for a connected League of Legends platform.
Read the [product purpose](docs/product.md) and the
[product specification](docs/product-specification.md) for its shared goals across
esports, build tools, personal analytics, and a desktop companion. Those documents
describe the product direction. They do not imply that every capability is available.

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

## Use the DPS lab

Open `/lab` from the shared navigation. The lab includes item comparison, a selected-target
trace, cohort filters, progression defaults, and worker-based optimization.
It retains patch 26.18 and Data Dragon 16.18.1. Fixture mode is explicit and still requires login.

Set `PROTOTYPE_ACCESS_PASSWORD` and `PROTOTYPE_SESSION_SECRET` in the server environment.
Run `pnpm dev` to serve both capabilities on one origin. Do not set `DATABASE_URL` for fixture use.
Use fresh local values for tests. Never copy production credentials into a browser variable.
`pnpm build` builds both journeys. `pnpm start` serves them from the Node server.

The private endpoints are `/api/dps/cohort`, `/api/dps/progression`, and `/api/dps/simulate`.
Login and logout are under `/api/dps/auth/`. All DPS data requests require a signed session.
The ranking pages remain public. Both development and production use the same DPS handlers.
No provider collection, migration, or bucket write runs on app startup.

For observed timeline skill progression, the web service needs `DATABASE_URL` and all five `DPS_ARCHIVE_*` settings from the [DPS setup guide](scripts/dps/README.md).
Without private archive access, skill progression uses an explicit legal fallback. Generic ranking bucket credentials cannot enable DPS archives.
Apply private settings only after operator approval. Behind a proxy, also verify the client-IP and ingress restrictions in that guide before enabling `DPS_TRUST_PROXY`.

Run `pnpm test:dps` for the imported DPS regression suite. `pnpm test` includes both suites.
The [DPS command reference](scripts/dps/README.md) lists namespaced operator commands.
Read [source attribution and evidence](docs/dps-source.md) before interpreting simulation results.

## Source ownership

The repository contains one private JavaScript application and a Rust Cargo
workspace. It has one JavaScript dependency set and no package split.

| Path | Owner |
| --- | --- |
| `src/domains/rankings/` | Ranking evidence, policy, queries, replay, and publication codecs. |
| `src/domains/dps/` | Damage simulation, optimizer, contracts, and retained-source rules. |
| `src/domains/tournaments/` | Schedule rules, forecasts, and deterministic simulations. |
| `src/lib/` | Five ranking safety implementations whose paths are bound by stored evidence. |
| `src/shared/`, `src/data/` | Deterministic ordering, shared presentation helpers, branding facts, and legal text. |
| `src/browser/`, `src/hooks/`, `src/components/`, `src/views/`, app entries | Browser state, UI, artifact I/O, and simulation worker. |
| `scripts/` | Production Node server, refresh, publication, storage, and operator commands. |
| `tools/` | Developer calibration, audits, assets, and test tools. |
| `tests/` | Tests and focused fixtures. |
| `worker/` | Native services, refresh code, and Rust contracts. |
| `ops/` | Tracked safety receipts. |
| `docs/` | Product purpose, requirements, principles, and lasting design decisions. |
| `.agents/artifacts/` | Ignored reports, plans, audit output, and local evidence. |

The receipt-pinned `scripts/benchmark-incremental-ranking.ts` is a developer
entry with tools ownership. Its path stays fixed for stored safety evidence.

Lint checks resolved import directions and public domain entries. Browser runtime
code cannot reach replay producers or publication plans. Ranking adapters own
private publication codecs. Views consume domain queries and types.
The test runner discovers `*Browser.test.ts` journeys and runs them one at a time.

### Extend the platform within these roots

Add a real business capability under `src/domains/<name>/`. Register its public
entries and domain dependencies in `tools/dev/ownership-policy.mjs`. The policy
derives purity and consumer permissions from that record. Unregistered domains
and undeclared public entries fail the boundary check. Do not add empty feature
directories before their first working consumer.

Keep web transport, request lifetime, caching, and navigation under `src/browser/`.
Put workflow screens under `src/views/` and shared controls under `src/components/`.
Keep domain calculations independent of React, browser state, provider calls,
storage, and native application effects. Shared definitions do not grant access
to private account or workspace data.

Add native engines and service binaries as real members of the existing `worker/`
Cargo workspace. A Rust API and analysis process can build and release separately
without moving that workspace. Retain the current Node authority until native
parity, cutover, and rollback requirements pass.

A second web deployment needs its own working entry, build output, route contract,
and release checks. Keep its browser entry under the existing browser roots.
Multiple Vercel projects do not require new top-level application folders or
placeholder package manifests. Create a shared package only when a real consumer
needs a separate build contract.

Keep contract generation, migration, and verification under `tools/`. Put retained
inputs and compatibility cases under `tests/`. Public assets stay under `public/`,
and generated payloads stay ignored. Keep reports and implementation plans under
ignored `.agents/artifacts/`. These boundaries support builds, personal analytics,
scouting, Riot integration, and a companion without changing the repository roots.

## Railway services

The web service builds `worker/Dockerfile.web` and starts with
`node scripts/start-serving.mjs`. The supervisor starts the Rust data origin and
the Node website server. Rust serves `/data/*` from verified bucket artifacts,
with the local reference payload as fallback. Node serves the Vite build and the
remaining website routes. The image builds from a source archive without Git metadata.

Build and check the same image locally:

```sh
docker build -f worker/Dockerfile.web -t rift-delta-web .
docker run --rm -e PORT=8080 -p 127.0.0.1:4173:8080 rift-delta-web
```

After startup, `/api/live` must return 200 and a `/data/ranking-summary.json`
response must include `X-Ranking-Runtime: rust`.

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

## Run the native local data service

Build and start the Unix service with an existing local data directory.

```sh
cargo +1.98.0 build --manifest-path worker/Cargo.toml --package league-platform --bin platform-api --locked
worker/target/debug/platform-api --data-root public/data --listen 127.0.0.1:4174
```

The listener accepts loopback addresses only. It serves `/data/`, `/api/live`, and `/api/ready`.
Readiness checks only local summary access. The root stays pinned until restart. All symlinks are refused.
Errors use safe fixed text. Conditional dates use standard HTTP forms.
This command checks local delivery only. Production uses the supervisor above,
which starts the native service with `--ranking-origin` for bucket access.

Run the explicit native proof after building the binary. Both paths must exist. The proof does not build or download inputs.

```sh
RANKING_NATIVE_HTTP_BINARY=worker/target/debug/platform-api \
RANKING_NATIVE_HTTP_RETAINED_DATA_DIR=data/reference/8adbc0a4239fd0dfba2094b3e70f60b513560de4/public/data \
pnpm exec tsx --tsconfig tsconfig.app.json --test tests/nativeRankingHttp.integration.ts
```
