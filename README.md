# LoL Esports Power Index

An independent team-strength prototype for LoL esports. The app presents a Power Index rather than a static table: ranking controls, tournament weights, selected-team explanations, team timelines, player timelines, season summaries, event summaries, and methodology notes.

Live site: [lol.lab4code.com](https://lol.lab4code.com/) · [Source code](https://github.com/MaximilianMauroner/lol-esports-ranking) · [Report feedback](https://github.com/MaximilianMauroner/lol-esports-ranking/issues/new?title=%5BFeedback%5D%20)

## Status

Generated ranking payloads are not committed to Git. Railway serves the active immutable `/data/*` generation from private bucket storage; local crunches write `.generated/ranking-data/`. It is not an official Riot ranking, and each ranking claim stays tied to its source manifest, model version, config hash, and coverage window.

## Run

```bash
pnpm install
pnpm run dev
```

Useful checks:

```bash
pnpm test
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run release:check
```

## Styling

The UI uses shadcn/ui-style React components in `src/components/ui` where they fit the surface, including controls and Recharts-backed dashboard charts. Product tokens and layout styles live in `src/index.css` and the files it imports.

## Static Data Strategy

The frontend loads static JSON from:

```text
/data/ranking-summary.json
```

Static hosts must set `VITE_RANKING_DATA_URL` to an external manifest URL or artifact directory, or run `pnpm data:materialize` before deployment. `pnpm static:preflight` fails clearly when neither source exists. `public/data/` is an ignored, disposable materialization target.

Static data can be generated without source inputs for a no-data smoke fixture:

```bash
pnpm run data:build
```

With no source arguments, this writes a valid `no-data` summary instead of falling back to seeded samples. The app does not recalculate rankings in React render. It loads a compact default board first, then lazy-loads compact per-filter shards from `/data/scopes/`. Event and region filters narrow the presented rows while preserving the global rating scale. Season filters publish the chronological model state through the selected season, so older years do not inherit current-year standings.

The normal local refresh workflow is:

```bash
pnpm run data:download
pnpm run data:crunch
pnpm run release:check
git add data/raw/manifest.json
git commit -m "Refresh LoL esports ranking data"
git push
```

`data:download` stores raw provider files under `data/raw/` and writes `data/raw/manifest.json`. Raw provider downloads are local inputs and are ignored by Git; the manifest is committed for provenance. `data:crunch` writes the full local audit artifact to `data/derived/ranking-snapshot.full.json` and the deployable client bundle to ignored `.generated/ranking-data/`.

Do not commit generated browser payloads, raw provider downloads, `data/derived/ranking-snapshot.full.json`, or other audit artifacts. Railway publishes the validated bundle to its private bucket. `pnpm data:materialize` validates the manifest and every referenced companion before copying the active local bundle into ignored `public/data/` for static hosting.

`data:download` treats Oracle's Elixir as the primary game-level source and Leaguepedia as the backup/gap-fill source. It discovers the public Oracle CSV files from the Oracle Google Drive folder, downloads the CSVs that overlap the requested date range, then downloads Leaguepedia Cargo data for the same range. If Google Drive returns a quota/HTML page instead of a CSV for a file, that file is skipped with a manifest warning instead of being recorded as usable data.

## Railway Server Deployment

`railway.toml` deploys the app as a Railway web service. With bucket credentials configured, the production server serves `/data/*`, readiness, homepage prerendering, and sitemap metadata from the active bucket generation before considering ignored local `.generated/ranking-data/`. Readiness returns 503 when no valid source exists.

Destructive ranking-state cleanup never runs under a refresh lease. `pnpm data:gc` acquires a non-expiring exclusive maintenance authority and performs a dry run; use `pnpm data:gc -- --execute` only after reviewing it. A crash intentionally leaves refresh blocked. After confirming the prior process terminated, recover only the exact printed identity with `pnpm data:gc -- --recover <owner> <fencing-token> --confirm-terminated`. There is no timeout or automatic maintenance takeover.

```bash
railway link
railway up
```

The Railway `web` service is connected to the `MaximilianMauroner/lol-esports-ranking` GitHub repository on the `main` branch, so Railway's native GitHub autodeploys rebuild and redeploy the service when new commits are pushed to `main`. The Railway build command runs typecheck, lint, tests, and the production build before the service starts.

This repository also includes `.github/workflows/railway-deploy.yml` as a manual fallback. Railway owns verification and bundling for that deployment, so the workflow does not duplicate the build before running:

```bash
railway up --ci --project 2bf26cbc-4cfa-4114-87c0-83b446f30816 --service d01fe39e-81a4-4230-b997-f13fe8af351b --environment production
```

To use the manual fallback, create a Railway project token for the `LoL Esports Power Index` project and save it as the GitHub Actions repository secret `RAILWAY_TOKEN`. The normal push-to-deploy path does not depend on that secret.

The legacy refresh uses the same local pipeline as development:

```bash
pnpm run data:refresh
```

On each run, the wrapper downloads provider data into a staging directory and hashes the ranking inputs while ignoring volatile fetch timestamps. Even when source bytes are unchanged, it invokes the snapshot builder's lightweight semantic preflight so code, model, config, calendar, temporal context, forced audits, and scheduled audits cannot be hidden by the outer fingerprint. A true semantic no-change performs zero reducer/model/provider/DAG/serialization work and does not promote a bucket generation; `RANKING_CRUNCH_MODE=full` always performs an independent replay.

The event-aware one-shot worker is:

```bash
pnpm run railway:refresh-once
```

`RANKING_REFRESH_MODE=shadow` probes overlapping LoL Esports schedule pages, records strictly confirmed completed matches, and never calls Oracle or Leaguepedia. `RANKING_REFRESH_MODE=gated` calls scored providers only when a confirmed pending match is due for ingestion or an explicitly enabled correction audit is due. Trigger state and a fencing lease live in the Railway bucket, exact reconciliations acknowledge pending matches, and successful gated publishes use immutable `rankings/generations/<run-id>/data/**` objects before promoting `rankings/active-generation.json`. The default remains `legacy` until shadow metrics have been reviewed.

The independent crunch engine control is `RANKING_CRUNCH_MODE=full|incremental-shadow|incremental`. Durable incremental state is restored from the active generation before crunching and staged under immutable content-addressed keys after a successful local publish. A missing, corrupt, or identity-incompatible checkpoint falls back to a full crunch without mixing old and new state. Shadow parity must succeed for the same exact compatibility, pipeline, code, model-version, and model-config identity before incremental activation; a mismatch resets and blocks that identity, publishes the full reference result, and uses `RANKING_ALERT_WEBHOOK_URL` when configured. Scheduled audits temporarily return an activated worker to shadow comparison. Source-fingerprint no-change runs still enter semantic preflight; only the builder may declare an exact no-change.

For cost/speed-constrained production refreshes, set `RANKING_REFRESH_LOOKBACK_DAYS=7` and choose a practical `RANKING_REFRESH_BOOTSTRAP_START`, such as `2025-01-01`. With an existing raw baseline, each scheduled run downloads only the rolling 7-day source window and merges those files into `data/raw` before crunching, so the ranking model still sees the restored baseline plus the current lookback window. If a fresh Railway container has no raw baseline, the refresh first restores `rankings/raw/files/**` from the Bucket; if no bucket baseline exists yet, it bootstraps once from `RANKING_REFRESH_BOOTSTRAP_START` through today and then subsequent scheduled runs use the lookback window. Earlier bootstrap dates improve historical coverage at the cost of slower first runs and larger raw storage; later dates are faster and cheaper but intentionally narrow the ranking context.

Use a Railway Storage Bucket for generated artifacts that should not live in Git. Railway Buckets are private S3-compatible storage, so the app proxies `/data/*` through the Railway server instead of exposing the bucket publicly. The refresh job uploads:

- `rankings/data/**`: legacy browser artifacts retained as a fallback.
- `rankings/generations/<run-id>/data/**` and `rankings/active-generation.json`: immutable gated browser generations and their active pointer.
- `rankings/private/objects/<category>/<sha256>`: immutable private reducer, provider, player, snapshot-model, and artifact state objects.
- `rankings/private/generations/<sha256>.json` and `rankings/private/audits/<sha256>.json`: immutable state manifests and parity/audit records referenced by the active pointer.
- `rankings/raw/objects/<sha256>` and `rankings/raw/generations/<sha256>.json`: immutable deduplicated source bytes plus a hashed manifest/state descriptor referenced by the active-generation CAS. The old shared raw layout is restore-only fallback.
- `rankings/latest-publish.json`: legacy/unversioned publish audit metadata.
- `rankings/artifacts/latest-full.json`: optional full audit/calculation artifact, uploaded only when `RANKING_BUCKET_UPLOAD_FULL_SNAPSHOT=true`.

Raw and private-state objects are globally content-addressed and uploaded create-only with digest verification. The active pointer references exact raw and private manifests, so interrupted uploads remain unreachable and stale workers cannot replace a successor's raw baseline. Retention keeps the active manifest, the latest valid manifest per recent UTC day, and only pointer-authorized permanent month-end/season/international boundaries. Newly staged unreachable objects receive a bounded grace period before collection; missing or corrupt reachability data fails the entire sweep closed.

Railway Bucket egress is free only when clients download directly from the bucket, such as through presigned URLs. When the web service proxies bucket objects to users, Railway counts that as service egress. For this app, keep the same-origin `/data/*` proxy and enable Railway CDN caching on the web service so cache hits are served from the edge without reaching the service. Presigned GET URLs are useful for ad hoc large downloads, but they add URL-expiry and browser CORS concerns to the app's JSON contract.

Recommended Railway variables:

- `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `REGION`, `ENDPOINT`: Railway Bucket S3 credentials. Use the Bucket service's variable-reference preset for the AWS SDK, or map these values manually.
- `RANKING_BUCKET_PREFIX`: object prefix for ranking artifacts. Defaults to `rankings`.
- `RANKING_BUCKET_UPLOAD_ENABLED`: set to `false` to crunch locally without uploading to the bucket. Defaults to enabled when bucket credentials exist.
- `RANKING_BUCKET_UPLOAD_FULL_SNAPSHOT`: set to `true` only when you need the full audit snapshot in the Bucket. Defaults to disabled because this artifact is large and the browser does not use it.
- `RANKING_BUCKET_REQUIRED`: set to `true` in production if refreshes should fail when bucket credentials are missing.
- `RANKING_BUCKET_FORCE_PATH_STYLE`: set to `true` only if the Bucket credentials tab says this bucket needs path-style S3 URLs.
- `RANKING_DURABLE_STATE_ENABLED`: set to `false` to disable private-state restore/staging even when Bucket credentials exist. Defaults to enabled.
- `RANKING_CRUNCH_MODE`: `full`, `incremental-shadow`, or `incremental`. This controls calculation, independently of the refresh trigger mode.
- `RANKING_INCREMENTAL_SHADOW_THRESHOLD`: consecutive same-identity parity matches required before `incremental` can activate. Defaults to `3`.
- `RANKING_INCREMENTAL_AUDIT_INTERVAL_MS`: maximum time between activated incremental shadow audits. Defaults to seven days.
- `RANKING_INCREMENTAL_FORCE_AUDIT`: set to `true` to force the next eligible incremental run through full-versus-incremental parity comparison.
- `RANKING_INCREMENTAL_STATE_DIR`: optional local materialization path for restored private state. The Bucket remains authoritative across fresh containers.
- `RANKING_DURABLE_RETENTION_DAYS`: rolling private and raw generation retention window. Defaults to `35`; active-pointer history authorizes permanent month-end, split, and international-event boundaries.
- `RANKING_DURABLE_STAGING_GRACE_MS`: minimum age for unreachable staged objects before maintenance may collect them. Defaults to 24 hours.
- `RANKING_MAINTENANCE_GC_AFTER_REFRESH`: opt in to a maintenance dry run after the refresh lease has been released. Defaults to disabled.
- `RANKING_MAINTENANCE_GC_EXECUTE`: with post-refresh maintenance enabled, opt in to deletion instead of the default dry run.
- `RANKING_MAINTENANCE_GC_TIMEOUT_MS`: timeout for the optional post-refresh maintenance child. A timeout can leave the non-expiring maintenance lock active by design; use the printed exact recovery command only after confirming the child terminated.
- `RANKING_REFRESH_ENABLED`: set to `true` to enable the background scheduler. Defaults to disabled; manual `POST /api/refresh` still works when `CRON_SECRET` is configured.
- `RANKING_REFRESH_MODE`: `legacy` (default), `shadow`, or `gated`. The web-process timer runs only in legacy mode; shadow/gated use the one-shot cron worker.
- `RANKING_TRIGGER_STATE_KEY` and `RANKING_REFRESH_LEASE_KEY`: optional bucket keys for durable detector state and the fencing lease.
- `RANKING_SCHEDULE_RECOVERY_HOURS`, `RANKING_SCHEDULE_MAX_OLDER_PAGES`, and `RANKING_SCHEDULE_REQUEST_TIMEOUT_MS`: bounded probe coverage and request deadline controls.
- `RANKING_CORRECTION_AUDIT_ENABLED`: set to `true` only after gated rollout to permit declared scored-source correction audits for already-completed games.
- `RANKING_ALERT_WEBHOOK_URL`: optional operational alert destination for probe failures, ingestion failures, and overdue pending matches.
- `RANKING_REFRESH_INTERVAL_MINUTES`: refresh cadence. Defaults to `60`.
- `RANKING_REFRESH_ON_START`: set to `true` to run a refresh immediately after the server starts. Defaults to disabled.
- `RANKING_REFRESH_LOOKBACK_DAYS`: optional rolling source-download window for scheduled refreshes. Production uses `7`.
- `RANKING_REFRESH_BOOTSTRAP_START`: source coverage start date to use when no raw baseline exists locally or in the bucket. A `2025-01-01` start is a cost/speed-oriented production setting, not a neutral accuracy default.
- `RANKING_REFRESH_START`: source coverage start date when no lookback window is configured. Defaults to `2011-01-01` for full-history ranking context.
- `RANKING_REFRESH_END`: optional fixed coverage end date. Defaults to the current UTC date.
- `RANKING_REFRESH_DOWNLOAD_ARGS`: optional extra downloader flags, such as `--oracle-required true`.
- `RANKING_BUCKET_RESTORE_RAW`: set to `false` to prevent restoring `rankings/raw/files/**` into `data/raw` before a refresh. Defaults to enabled when bucket credentials exist.
- `RANKING_DATA_MANIFEST_CACHE_CONTROL`: cache policy for `/data/ranking-summary.json`. Defaults to `public, max-age=0, s-maxage=300, stale-while-revalidate=3600, stale-if-error=86400`.
- `RANKING_DATA_CACHE_CONTROL`: cache policy for versioned `/data/*` companion artifacts. Defaults to `public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800, stale-if-error=604800`.
- `RANKING_GZIP_ENABLED`: set to `false` to disable gzip for JSON/text/SVG responses. Defaults to enabled.
- `ORACLES_ELIXIR_CSV_URL`: optional direct Oracle CSV URL override.
- `CRON_SECRET`: optional bearer token for manual `POST /api/refresh`.
- `RANKING_RAW_DIR` and `RANKING_PUBLIC_DATA_DIR`: optional paths if you also mount a Railway volume for raw state or generated public data. Bucket storage is the durable default for deployable artifacts.

`GET /api/live` reports process liveness, `GET /api/ready` verifies app and ranking data availability, and `GET /api/scheduler` exposes non-sensitive detector counts and timing. The legacy `GET /api/health` remains available. `POST /api/refresh` starts a manual recovery refresh when `Authorization: Bearer $CRON_SECRET` matches.

Railway's dedicated cron service should run `pnpm run railway:refresh-once` every 6 hours. The bucket is the shared durable state and publish target, so the cron container can exit after each invocation and the web service can serve the promoted generation independently.

To override Oracle discovery with direct CSV URLs, include them in the download step:

```bash
pnpm run data:download -- --oracle-csv-url "https://example.com/path/to/oracle.csv"
pnpm run data:crunch
```

Useful download flags:

```bash
pnpm run data:download -- --start 2024-01-01 --end 2026-06-26
pnpm run data:download -- --oracle-required true
pnpm run data:download -- --leaguepedia-required true
pnpm run data:download -- --lolesports-required true
pnpm run data:download -- --lolesports false
pnpm run data:download -- --oracle false
pnpm run data:download -- --leaguepedia false
```

To build from Oracle's Elixir CSVs:

```bash
pnpm run data:build:oracle -- data/raw/oracles-elixir/2026_LoL_esports_match_data_from_OraclesElixir.csv
```

Oracle rows are normalized into match records using `gameid`, side, team, result, kills, gold, objectives, game length, league, year, split, playoffs, patch, and data-completeness fields when present.

To build from a fetched Leaguepedia Cargo snapshot:

```bash
pnpm run fetch:leaguepedia -- --start 2026-01-01 --end 2026-06-26 --output data/raw/leaguepedia/leaguepedia-2026.json
pnpm run data:build:leaguepedia -- data/raw/leaguepedia/leaguepedia-2026.json
```

To combine both community sources for the algorithm:

```bash
pnpm run data:build -- --oracle-csv data/raw/oracles-elixir/2026_LoL_esports_match_data_from_OraclesElixir.csv --leaguepedia-json data/raw/leaguepedia/leaguepedia-2026.json --lolesports-json data/raw/lolesports/schedule-2026-01-01_to_2026-06-26.json
```

Oracle's Elixir has precedence for duplicate games because it carries richer game-stat fields. Leaguepedia Cargo fills gaps and supplies broad match/event coverage. LoL Esports schedule caches are treated as unsupported official-reference metadata: they can attach official event/match/game IDs and audit schedule/result state, but they are not standalone scored model inputs. Overlapping scored rows are merged only when canonical team/winner identity plus source IDs or team stat lines identify the same game; broad date/team/winner matching is reserved for result-only gap-fill rows so separate same-winner games in a series are preserved. Sponsor-era aliases such as DRX/Kiwoom DRX, OKSavingsBank BRION/HANJIN BRION, and DN Freecs/DN SOOPers are normalized before dedupe. Seeded data is explicitly marked as `sourceProvider: "seed"` and should be used only for local demo snapshots.

## Source Strategy

The intended free-data pipeline is layered:

- LoL Esports persisted site APIs: cached unsupported reference layer for schedule windows, event states, series results, match IDs, game IDs, side assignments, and VOD references.
- Oracle's Elixir CSVs: primary rich game-level and player-level stats source for scheduled snapshots and model inputs.
- Leaguepedia Cargo API: throttled backup/audit layer for broad historical events, aliases, result gap-fill, and match metadata.
- Data Dragon and CommunityDragon: static metadata/assets only, pinned where possible; never schedule/result inputs.
- PandaScore and Cito: explicit free-tier experiments only, behind manual keys/flags if added later; not default ranking provenance.
- Official LoL Esports ranking snapshots: optional manual benchmark exports extracted from the public LoL Esports rankings page. They are not used as local model inputs and are not written into `data/raw/manifest.json`.

Fetch examples:

```bash
pnpm run fetch:lolesports -- --start 2026-01-01 --end 2026-06-26 --output data/raw/lolesports/lolesports-2026.json
pnpm run fetch:leaguepedia -- --start 2026-01-01 --end 2026-06-26 --output data/raw/leaguepedia/leaguepedia-2026.json
pnpm run fetch:riot-gpr -- --year 2026 --milestone current --output data/raw/riot-gpr/riot-gpr-2026-current.json
```

LoL Esports persisted APIs are public site endpoints, not a supported official data API. Keep those responses cached, label them unsupported, and use them as reference metadata rather than as proof that a scored game row has rich stats.

Leaguepedia rate-limits aggressively. The fetcher uses pagination and a delay, but repeated ad hoc queries can still be throttled.

Official LoL Esports ranking snapshots can be compared against the generated browser standings as a local benchmark artifact:

```bash
pnpm run benchmark:riot-gpr -- --gpr data/raw/riot-gpr/riot-gpr-2026-current.json
```

The comparison reads `.generated/ranking-data/ranking-summary.json` plus the default generated shard and writes `data/derived/riot-gpr-benchmark-report.json`. It is a sanity benchmark, not a formula-clone gate: broad top-board disagreements are reported, while the command exits nonzero only when elite teams are implausibly displaced, too many top-band outliers accumulate, or too few teams match. Use `--top`, `--max-rank-delta`, `--max-large-deltas`, `--elite-top`, `--max-elite-rank-delta`, and `--min-matched` to tune the check for a calibration pass. Official LoL Esports ranking exports remain outside `data/raw/manifest.json` and are not a model input.

## Optional Vercel Blob Recalculation

The primary publish path is a validated immutable bucket generation. Static deployments materialize ignored files during deployment or use an external `VITE_RANKING_DATA_URL`. The Vercel cron path is optional and only needed when you want a deployed function to publish an external Blob-backed manifest. `vercel.json` configures a cron job:

```json
{
  "crons": [
    {
      "path": "/api/recalculate-rankings",
      "schedule": "0 6 * * *"
    }
  ]
}
```

The cron endpoint recalculates the same snapshot shape from URL-provided public-source inputs. With `BLOB_READ_WRITE_TOKEN` configured, it writes the latest browser manifest to Vercel Blob at `rankings/latest-summary.json`, plus compact filter shards, player ratings, and rating history. Full audit artifact upload should remain explicitly opt-in if that operational code path is enabled; use `RANKING_BLOB_UPLOAD_FULL_SNAPSHOT=true` as the intended Vercel Blob flag, mirroring Railway's full-snapshot opt-in. The default schedule is daily for Hobby-plan compatibility; use a more frequent expression on a plan that supports it.

Recommended Vercel environment variables:

- `CRON_SECRET`: required bearer token for `/api/recalculate-rankings`.
- `BLOB_READ_WRITE_TOKEN`: enables the cron function to publish `rankings/latest-summary.json`, compact filter shards, player ratings, and rating history.
- `RANKING_BLOB_UPLOAD_FULL_SNAPSHOT`: intended opt-in flag for publishing the large full audit snapshot to Vercel Blob if that upload path is implemented. Keep unset by default because the browser does not need the full artifact.
- `ORACLES_ELIXIR_CSV_URL`: optional direct CSV URL for scheduled Oracle's Elixir import.
- `LEAGUEPEDIA_MATCHES_JSON_URL`: optional JSON URL produced by `pnpm run fetch:leaguepedia`, used as match/event gap-fill for scheduled snapshots.
- `VITE_RANKING_DATA_URL`: public Blob URL the browser should load in production.

Deployed static files are immutable at runtime, so the scheduled function publishes to Blob rather than trying to modify files inside a deployment. If you use this mode, set `VITE_RANKING_DATA_URL` to the public Blob summary URL. The browser-facing Blob payload is the summary contract, not the full calculation artifact; it includes the public URLs for its shard, player-rating, and team-history companions. If no public source produces rows, the cron returns a `no-data` result instead of publishing seeded sample data.

## Model

The transparent local model is Elo-like and intentionally explainable. The public team table is a context-neutral latent-strength estimate: it answers how strong a team is against a representative field under average draft, side, matchup, patch, and current-roster conditions. Match probabilities are a forecast and validation layer, not the ranking target itself.

- Seasonal hierarchy: published power is `LeagueAnchor + TeamStableOffset + RosterPriorOffset + Momentum + ContextAdjustment`, with uncertainty shown beside the score.
- Tournament context: EventK values put Worlds/MSI knockouts above international early stages, regional playoffs, and regular season.
- Recency: newer matches carry more weight.
- Latent result budget: resolved series results, or true Bo1 games, create a neutral result residual, then split that evidence into durable stable team offset and capped fast-decaying form. Kills, gold, and objectives are tracked in a separate shadow execution-residual ledger and are not allowed to affect their own pre-game prediction.
- Opponent strength: beating stronger teams moves rating more through the Elo expectation.
- League strength: eligible international cross-league results update league Elo against the participating teams' pregame power, so beating a higher-rated representative carries more signal than beating a lower-rated one. Region strength is derived from league posteriors, not direct game updates. Completed international tournaments also add a capped placement residual from actual stage advancement versus pre-event expectation. Same-region international games do not directly move league game Elo, so same-region finals are credited through the path and placement residual rather than double-counting the final itself.
- Series-atomic updates: grouped Bo3/Bo5 source rows freeze the pre-series expectation and move team and league strength once on the final row. Sweeps get a small decisiveness bonus, but repeated source rows are not treated as independent full wins.
- Uncertainty: standings expose a rating band so low-connectivity or low-volume teams are not ranked with false precision.
- Eligibility: ranked rows carry total-volume, current-volume, staleness, uncertainty, and league-anchor gates. First-division minor regions can become eligible with enough scoped volume and current international signal; ERLs, NACL, EMEA Masters, academy, national, low-volume, and unknown-league rows remain visible as provisional ecosystem teams rather than being promoted as official top-board claims.
- Roster continuity: Oracle player rows are attached as observed game rosters. Complete lineup changes regress stable team offset toward the league anchor and widen uncertainty using role-value weights rather than raw returning-player counts.
- Momentum: recent overperformance is a capped, fast-decaying overlay; it affects current prediction without becoming permanent stable strength.
- Dynamic player shares: player timelines start from role priors, then apply impact multipliers for objective impact, award residual, recent form, availability, and role certainty. Public-data outputs include post-game sourced player ratings from Oracle player rows. Sourced player updates compare each player with the opposing same-role player in that game, so jungle/bot/support box-score baselines cannot inject rating mass by themselves, and final player ratings use league-aware baselines so domestic farming in lower-connectivity leagues is not presented on the same starting scale as LCK/LPL. Public ranked player rows require at least 20 sourced role games, at least 20 games for the displayed team in the active scope, and a team that is not `unanchored-league`; thinner, reserve, transfer-fragment, or unanchored player samples remain auditable through rating-proof and full-artifact rows with appearance flags instead of being promoted as top-board claims. Published walk-forward probabilities use prior-only player-rating residuals above each team's league baseline plus side-context adjustments after same-day prediction batches are frozen; metrics keep neutral team-only and player-adjusted deltas for auditability.
- Award residuals: current local sources do not contain dated MVP/POG/POTM/All-Pro records, so award residuals stay unapplied instead of being inferred from visible stats.
- Baseline comparisons: schema `13` walk-forward metrics compare the side-aware published model with coin-flip, pre-game win-rate, and neutral team-only baselines, including segment rows for contexts such as international, cross-region, side-known, patch-transition, and roster-change games. Region rows publish flagship-region strength separately from broad ecosystem team counts, so lower-tier ERL/academy/cup volume does not dilute the main LEC/LCK/LPL regional signal. Current Region Power rows are limited to regions that participate at international events: LCS, CBLOL, LEC, LCK, LPL, and LCP. PCS, VCS, LJL, and other domestic feeder or lower-tier ecosystems remain legitimate team data, but they are ignored as separate Region Power inputs unless they are part of the region power league layer. The v0.26 model changes sourced player-rating scale semantics: previous v0.25 player ratings over-rewarded roles whose raw Oracle box-score baselines injected rating mass above `0.5 + 0.5` per same-role matchup and let lower-tier domestic ladders compound from the same `100` starting point as major leagues. v0.26 uses same-role matchup-relative sourced player performance and anchors final player baselines to league strength. v0.27 changes season snapshot semantics: a season shard publishes standings from the chronological model through that selected season instead of filtering today's global standings. v0.28 shrinks the published sourced-player edge by home-league tier, so ERL/academy/emerging domestic dominance is regressed toward its league baseline before appearing on the global player board or feeding pre-game player adjustments. v0.29 adds season-scoped player directory rows. v0.30 keeps low-sample sourced players out of ranked public player rows until they reach 20 sourced games, while preserving them in audit/proof outputs. v0.31 builds season-ranking models with season-scoped team profiles instead of only relabeling the row after ranking, and keeps developmental teams unanchored even when their parent league is certified. v0.32 caps emerging and unknown league published anchors before team/player baselines and removes players from unanchored-league teams from the public ranked player directory, preventing EMEA Masters-style ecosystem volume from making ERL or academy leagues appear stronger than first-division minor regions. v0.33 credits season-scoped player rows to the player's primary team in that scope and requires displayed-team sample volume, so transfer fragments and reserve appearances do not crowd public leaderboards. v0.34 recomputes eligibility after every season/event/region filter, adds a 30-game total-volume gate, and defaults the team table to ranked rows while keeping provisional teams in audit mode. v0.35 updates the current top-tier region taxonomy to exactly LCS, CBLOL, LEC, LCK, LPL, and LCP for both scope filtering and Region Power. Schema 13 adds player appearance provenance to `players.json` and rating-proof rows: each sourced player exposes total rated games, shown-team games, role games, team/role histories, and flags for multi-team or thin latest-team samples. The source pipeline `canonical-identity-stat-dedupe-v10` distinguishes Worlds, First Stand/FST MSI-level bracket games, EWC-style events, EWC qualifiers, Demacia Cup, EMEA Masters, generic LTA championship rows, and academic/world-name events, derives current team profiles from latest explicit home-league observations, preserves Team Secret Whales as distinct from Team Secret, and maps lower-division codes such as LFL2, PRMP, NL, and CT as LEC ecosystem leagues instead of relying on broad substring matches. The public artifact can show where the Power Index adds predictive signal beyond a domestic record table and where calibration still lags.

Migration note: pre-1.0 model artifacts publish a stable canonical model version; exact experimental changes are identified by `model.configHash`. Schema `16` introduced the context-neutral latent team-strength target, series-atomic team and league-strength updates, and scoped team-history shards plus first-class region history.

Pre-1.0 breaking changes are encouraged when they improve accuracy, fairness, provenance, model clarity, or long-term maintainability. Before 1.0, keep the public model version stable, rely on `model.configHash` for exact model-parameter provenance, bump schema versions for public artifact shape changes, regenerate affected snapshots, and document migration impact.

Riot's official model should be used as a benchmark layer, not as a formula clone.

Every generated snapshot includes `model.version`, `model.configHash`, active model parameters, source provider breakdowns, match coverage dates, source/data quality counts, and whether seeded sample data is present. Current schema version `18` standing rows include rating components and latest latent-strength rating-update ledger fields; league rows include expected wins, wins over expected, opponent-adjusted win rate, and average international opponent rating; region rows include flagship team/league counts and separate ecosystem counts. Walk-forward metrics also include aggregate and segment-level baseline comparisons against coin-flip, pre-game win-rate, and neutral team-only predictors, while full prediction rows expose the prior-only blue/red side adjustment used by the published probability. Compact sourced-player outputs carry latest Oracle observation provenance plus appearance provenance and recent match context, and browser history is split into scoped team-history shards plus first-class region-history artifacts, so player/team/role/region claims can be traced back to the source game, file, date, event, shown-team games, role games, last played opponents, and model provenance. Ranking claims should always be cited with the data source, canonical pre-1.0 model version, config hash, and schema version that produced them.

See [docs/ideal-match-impact-model.md](/home/codex/work/lol-esports-ranking/docs/ideal-match-impact-model.md) for the predictive target, dynamic player-importance formula, roster-continuity model, and anti-leakage rules.

## Key Files

- `src/App.tsx`: main ranking workbench UI.
- [docs/ideal-match-impact-model.md](/home/codex/work/lol-esports-ranking/docs/ideal-match-impact-model.md): latent ranking target, model layering, player-share formula, validation order, and anti-leakage rules.
- `src/lib/model.ts`: transparent team and league rating calculations.
- `src/lib/playerModel.ts`: seeded player-share model plus sourced Oracle player-game rating updates.
- `src/lib/rosters.ts`: latest observed game-roster provenance and standings roster-basis derivation.
- `src/lib/rankingExplanations.ts`: static UI copy for public model-component explanations.
- `src/lib/snapshot.ts`: full snapshot builder, compact browser-summary builder, and filter-key logic.
- `src/data/teamIdentity.ts`: known team home league/region identities used when match rows lack explicit identity metadata.
- `src/lib/importers/oraclesElixir.ts`: Oracle's Elixir CSV parser and normalizer.
- `src/data/rankingConfig.ts`: event-tier K values and factor labels.
- `scripts/build-static-snapshot.ts`: writes the full derived artifact plus compact browser summary/shards.
- `scripts/refresh-data-if-changed.mjs`: Railway/local wrapper that downloads staged raw data on each scheduled run and crunches only when source content changed.
- `scripts/railway-bucket.mjs`: Railway Bucket S3 helper for publishing generated artifacts and proxying `/data/*`.
- `scripts/railway-server.mjs`: Railway production server for `dist/`, live `/data` artifacts, health checks, and the background refresh loop.
- `scripts/fetch-leaguepedia.mjs`: Leaguepedia Cargo match fetcher.
- `scripts/fetch-riot-gpr-snapshot.mjs`: manual official-ranking benchmark extractor. Its output must stay outside the local model input manifest.
- `api/recalculate-rankings.ts`: Vercel cron endpoint for scheduled recalculation.
- `tests/`: provenance, importer, merge, and cron safety tests.
- `railway.toml`: Railway web-service build, start, health check, and restart config.
- `vercel.json`: cron schedule.
