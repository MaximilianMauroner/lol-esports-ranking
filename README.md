# LoL Esports GPR Workbench

A better Global Power Rankings prototype for LoL esports. The app starts as a ranking workbench rather than a static table: ranking controls, tournament weights, selected-team explanations, team timelines, player timelines, season summaries, event summaries, and methodology notes.

## Status

For static deployments, the app serves the latest committed browser-safe snapshot from `public/data/`. On Railway, the same `/data/*` payload can be served from Railway Bucket storage after refresh. It is not an official Riot ranking, and each public ranking claim should stay tied to the data source manifest, model version, config hash, and coverage window that produced it. While the model is pre-1.0, `model.version` is intentionally fixed at `transparent-gpr-v0.0.0`; use `model.configHash` and `schemaVersion` for exact iteration provenance.

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

By default, Vercel, Cloudflare Pages, and other static hosts serve the committed files in `public/data/`. Set `VITE_RANKING_DATA_URL` only when you intentionally want the browser to load an externally hosted manifest, such as a Vercel Blob URL written by the optional scheduled job.

Static data can be generated without source inputs for a no-data smoke fixture:

```bash
pnpm run data:build
```

With no source arguments, this writes a valid `no-data` summary instead of falling back to seeded samples. The app does not recalculate rankings in React render. It loads a compact default board first, then lazy-loads compact per-filter shards from `public/data/scopes/`. Event and region filters narrow the presented rows while preserving the global rating scale. Season filters publish the chronological model state through the selected season, so older years do not inherit current-year standings.

The normal local refresh workflow is:

```bash
pnpm run data:download
pnpm run data:crunch
pnpm run release:check
git add data/raw/manifest.json public/data/ranking-summary.json public/data/entities public/data/history public/data/scopes
git commit -m "Refresh LoL esports ranking data"
git push
```

`data:download` stores raw provider files under `data/raw/` and writes `data/raw/manifest.json`. Raw provider downloads are local inputs and are ignored by Git; the manifest is committed for provenance. By default the downloader fetches Oracle's Elixir CSVs and Leaguepedia ScoreboardGames from 2011-01-01 through today. `data:crunch` reads the local manifest and raw files, writes the full local calculation artifact to `data/derived/ranking-snapshot.full.json`, and writes the deployable client payload to `public/data/ranking-summary.json`, `public/data/entities/*.json`, `public/data/history/**/*.json`, and `public/data/scopes/*.json`.

Commit the compact generated `public/data` payload after review when you need static-host fallback files. Railway deployments can instead publish that payload to the private Railway Bucket during refresh. Do not commit raw provider downloads, `data/derived/ranking-snapshot.full.json`, or other full audit artifacts. The full public snapshot files `public/data/ranking-snapshot.json` and `public/data/*.full.json` are intentionally blocked because they can exceed GitHub file limits; the compact manifest and shards are the browser contract. Riot GPR snapshots are not part of the local data-source manifest.

`data:download` treats Oracle's Elixir as the primary game-level source and Leaguepedia as the backup/gap-fill source. It discovers the public Oracle CSV files from the Oracle Google Drive folder, downloads the CSVs that overlap the requested date range, then downloads Leaguepedia Cargo data for the same range. If Google Drive returns a quota/HTML page instead of a CSV for a file, that file is skipped with a manifest warning instead of being recorded as usable data.

## Railway Server Deployment

`railway.toml` deploys the app as a Railway web service. The production server serves the built Vite app from `dist/`, serves `/data/*` from local `public/data/` when a file is present, falls back to Railway Bucket storage when configured, and runs an hourly background refresh by default.

```bash
railway link
railway up
```

This repository also includes `.github/workflows/railway-deploy.yml` so pushes to `main` can deploy the existing Railway service through GitHub Actions. The workflow runs typecheck, lint, tests, and build first, then runs:

```bash
railway up --ci --project 2bf26cbc-4cfa-4114-87c0-83b446f30816 --service d01fe39e-81a4-4230-b997-f13fe8af351b --environment production
```

To activate push-to-deploy, create a Railway project token for the `lol-esports-ranking` project and save it as the GitHub Actions repository secret `RAILWAY_TOKEN`. The current Railway service was initially deployed from the local CLI, so `railway status` reports `source.repo: null`; native Railway GitHub autodeploy can also be enabled later by connecting the `MaximilianMauroner/lol-esports-ranking` repository to the `web` service in the Railway dashboard.

The hourly refresh uses the same local pipeline as development:

```bash
pnpm run data:refresh
```

On each run, the wrapper downloads provider data into a staging directory, hashes the source content while ignoring volatile fetch timestamps, and compares it with the last successful refresh. If the source digest is unchanged, it skips the expensive crunch step. If source data changed, it promotes the staged raw files into `data/raw/`, writes `data/raw/manifest.json` plus `data/raw/refresh-state.json`, runs the same snapshot builder used by `pnpm run data:crunch`, and uploads generated artifacts to the Railway Bucket.

For production, set `RANKING_REFRESH_LOOKBACK_DAYS=7` and `RANKING_REFRESH_BOOTSTRAP_START=2025-01-01`. With an existing raw baseline, each hourly run downloads only the rolling 7-day source window and merges those files into `data/raw` before crunching, so the ranking model still sees the full 2025-to-current coverage. If a fresh Railway container has no raw baseline, the refresh first restores `rankings/raw/files/**` from the Bucket; if no bucket baseline exists yet, it bootstraps once from `RANKING_REFRESH_BOOTSTRAP_START` through today and then subsequent hourly runs use the lookback window.

Use a Railway Storage Bucket for generated artifacts that should not live in Git. Railway Buckets are private S3-compatible storage, so the app proxies `/data/*` through the Railway server instead of exposing the bucket publicly. The refresh job uploads:

- `rankings/data/**`: the browser manifest, shard, entity, and history artifacts normally served from `/data/*`.
- `rankings/artifacts/latest-full.json`: the full audit/calculation artifact that is too large for Git.
- `rankings/raw/manifest.json`: the data-source manifest for provenance.
- `rankings/raw/files/**`: the raw source baseline used to restore a fresh Railway container before lookback-only refreshes.
- `rankings/raw/refresh-state.json` and `rankings/latest-publish.json`: refresh/publish audit metadata.

Recommended Railway variables:

- `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `REGION`, `ENDPOINT`: Railway Bucket S3 credentials. Use the Bucket service's variable-reference preset for the AWS SDK, or map these values manually.
- `RANKING_BUCKET_PREFIX`: object prefix for ranking artifacts. Defaults to `rankings`.
- `RANKING_BUCKET_UPLOAD_ENABLED`: set to `false` to crunch locally without uploading to the bucket. Defaults to enabled when bucket credentials exist.
- `RANKING_BUCKET_REQUIRED`: set to `true` in production if refreshes should fail when bucket credentials are missing.
- `RANKING_BUCKET_FORCE_PATH_STYLE`: set to `true` only if the Bucket credentials tab says this bucket needs path-style S3 URLs.
- `RANKING_REFRESH_ENABLED`: set to `false` to disable the background scheduler. Defaults to enabled.
- `RANKING_REFRESH_INTERVAL_MINUTES`: refresh cadence. Defaults to `60`.
- `RANKING_REFRESH_ON_START`: set to `false` to skip the startup refresh. Defaults to enabled.
- `RANKING_REFRESH_LOOKBACK_DAYS`: optional rolling source-download window for scheduled refreshes. Production uses `7`.
- `RANKING_REFRESH_BOOTSTRAP_START`: source coverage start date to use when no raw baseline exists locally or in the bucket. Production uses `2025-01-01`.
- `RANKING_REFRESH_START`: source coverage start date when no lookback window is configured. Defaults to `2011-01-01` for full-history ranking context.
- `RANKING_REFRESH_END`: optional fixed coverage end date. Defaults to the current UTC date.
- `RANKING_REFRESH_DOWNLOAD_ARGS`: optional extra downloader flags, such as `--oracle-required true`.
- `RANKING_BUCKET_RESTORE_RAW`: set to `false` to prevent restoring `rankings/raw/files/**` into `data/raw` before a refresh. Defaults to enabled when bucket credentials exist.
- `ORACLES_ELIXIR_CSV_URL`: optional direct Oracle CSV URL override.
- `CRON_SECRET`: optional bearer token for manual `POST /api/refresh`.
- `RANKING_RAW_DIR` and `RANKING_PUBLIC_DATA_DIR`: optional paths if you also mount a Railway volume for raw state or generated public data. Bucket storage is the durable default for deployable artifacts.

The server endpoint `GET /api/health` reports whether a refresh is running, bucket configuration status, and the last refresh result. `POST /api/refresh` starts a manual refresh when `Authorization: Bearer $CRON_SECRET` matches.

Railway's native cron service can run the one-shot command `pnpm run railway:refresh` on `0 * * * *`, but a separate cron service needs shared persistent storage or an external publish target if its output should update the web service. The default single web-service setup avoids that split by refreshing the files served by the same running process.

To override Oracle discovery with direct CSV URLs, include them in the download step:

```bash
pnpm run data:download -- --oracle-csv-url "https://example.com/path/to/oracle.csv"
pnpm run data:crunch
```

Useful download flags:

```bash
pnpm run data:download -- --start 2024-01-01 --end 2026-06-26
pnpm run data:download -- --oracle-required true
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
pnpm run data:build -- --oracle-csv data/raw/oracles-elixir/2026_LoL_esports_match_data_from_OraclesElixir.csv --leaguepedia-json data/raw/leaguepedia/leaguepedia-2026.json
```

Oracle's Elixir has precedence for duplicate games because it carries richer game-stat fields. Leaguepedia Cargo fills gaps and supplies broad match/event coverage. Overlapping scored rows are merged only when canonical team/winner identity plus source IDs or team stat lines identify the same game; broad date/team/winner matching is reserved for result-only gap-fill rows so separate same-winner games in a series are preserved. Sponsor-era aliases such as DRX/Kiwoom DRX, OKSavingsBank BRION/HANJIN BRION, and DN Freecs/DN SOOPers are normalized before dedupe. Seeded data is explicitly marked as `sourceProvider: "seed"` and should be used only for local demo snapshots.

## Source Strategy

The intended pipeline has three layers:

- Oracle's Elixir CSVs: primary game-level match data source for scheduled snapshots and model inputs.
- Leaguepedia Cargo API: broad historical events, teams, players, rosters, and match metadata for enrichment and gap filling.
- Riot GPR snapshots: optional manual benchmark exports extracted from the public LoL Esports GPR page. They are not used as local model inputs and are not written into `data/raw/manifest.json`.

Fetch examples:

```bash
pnpm run fetch:leaguepedia -- --start 2026-01-01 --end 2026-06-26 --output data/raw/leaguepedia/leaguepedia-2026.json
pnpm run fetch:riot-gpr -- --year 2026 --milestone current --output data/raw/riot-gpr/riot-gpr-2026-current.json
```

Leaguepedia rate-limits aggressively. The fetcher uses pagination and a delay, but repeated ad hoc queries can still be throttled.

## Optional Vercel Blob Recalculation

The primary publish path is local refresh, commit `public/data`, push, and deploy the static app. The Vercel cron path is optional and only needed when you want a deployed function to publish an external Blob-backed manifest instead of using the committed static files. `vercel.json` configures a cron job:

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

The cron endpoint recalculates the same snapshot shape from URL-provided public-source inputs. With `BLOB_READ_WRITE_TOKEN` configured, it writes the latest browser manifest to Vercel Blob at `rankings/latest-summary.json`, plus compact filter shards, player ratings, rating history, and the full audit artifact. The default schedule is daily for Hobby-plan compatibility; use a more frequent expression on a plan that supports it.

Recommended Vercel environment variables:

- `CRON_SECRET`: required bearer token for `/api/recalculate-rankings`.
- `BLOB_READ_WRITE_TOKEN`: enables the cron function to publish `rankings/latest-summary.json`, compact filter shards, player ratings, rating history, and the full audit artifact.
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
- Baseline comparisons: schema `13` walk-forward metrics compare the side-aware published model with coin-flip, pre-game win-rate, and neutral team-only baselines, including segment rows for contexts such as international, cross-region, side-known, patch-transition, and roster-change games. Region rows publish flagship-region strength separately from broad ecosystem team counts, so lower-tier ERL/academy/cup volume does not dilute the main LEC/LCK/LPL regional signal. Current Region Power rows are limited to regions that participate at international events: LCS, CBLOL, LEC, LCK, LPL, and LCP. PCS, VCS, LJL, and other domestic feeder or lower-tier ecosystems remain legitimate team data, but they are ignored as separate Region Power inputs unless they are part of the region power league layer. The v0.26 model changes sourced player-rating scale semantics: previous v0.25 player ratings over-rewarded roles whose raw Oracle box-score baselines injected rating mass above `0.5 + 0.5` per same-role matchup and let lower-tier domestic ladders compound from the same `100` starting point as major leagues. v0.26 uses same-role matchup-relative sourced player performance and anchors final player baselines to league strength. v0.27 changes season snapshot semantics: a season shard publishes standings from the chronological model through that selected season instead of filtering today's global standings. v0.28 shrinks the published sourced-player edge by home-league tier, so ERL/academy/emerging domestic dominance is regressed toward its league baseline before appearing on the global player board or feeding pre-game player adjustments. v0.29 adds season-scoped player directory rows. v0.30 keeps low-sample sourced players out of ranked public player rows until they reach 20 sourced games, while preserving them in audit/proof outputs. v0.31 builds season-ranking models with season-scoped team profiles instead of only relabeling the row after ranking, and keeps developmental teams unanchored even when their parent league is certified. v0.32 caps emerging and unknown league published anchors before team/player baselines and removes players from unanchored-league teams from the public ranked player directory, preventing EMEA Masters-style ecosystem volume from making ERL or academy leagues appear stronger than first-division minor regions. v0.33 credits season-scoped player rows to the player's primary team in that scope and requires displayed-team sample volume, so transfer fragments and reserve appearances do not crowd public leaderboards. v0.34 recomputes eligibility after every season/event/region filter, adds a 30-game total-volume gate, and defaults the team table to ranked rows while keeping provisional teams in audit mode. v0.35 updates the current top-tier region taxonomy to exactly LCS, CBLOL, LEC, LCK, LPL, and LCP for both scope filtering and Region Power. Schema 13 adds player appearance provenance to `players.json` and rating-proof rows: each sourced player exposes total rated games, shown-team games, role games, team/role histories, and flags for multi-team or thin latest-team samples. The source pipeline `canonical-identity-stat-dedupe-v10` distinguishes Worlds, First Stand/FST MSI-level bracket games, EWC-style events, EWC qualifiers, Demacia Cup, EMEA Masters, generic LTA championship rows, and academic/world-name events, derives current team profiles from latest explicit home-league observations, preserves Team Secret Whales as distinct from Team Secret, and maps lower-division codes such as LFL2, PRMP, NL, and CT as LEC ecosystem leagues instead of relying on broad substring matches. The public artifact can show where GPR is adding predictive signal beyond a domestic record table and where calibration still lags.

Migration note: pre-1.0 model artifacts now publish the canonical model version `transparent-gpr-v0.0.0`; exact experimental changes are identified by `model.configHash`. Schema `16` keeps the context-neutral latent team-strength target, uses series-atomic team and league-strength updates, and splits public history into scoped team-history shards plus first-class region history.

Pre-1.0 breaking changes are encouraged when they improve accuracy, fairness, provenance, model clarity, or long-term maintainability. Before 1.0, keep the public model version at `transparent-gpr-v0.0.0`, rely on `model.configHash` for exact model-parameter provenance, bump schema versions for public artifact shape changes, regenerate affected snapshots, and document migration impact.

Riot's official model should be used as a benchmark layer, not as a formula clone.

Every generated snapshot includes `model.version`, `model.configHash`, active model parameters, source provider breakdowns, match coverage dates, source/data quality counts, and whether seeded sample data is present. Schema version `16` standing rows include rating components and latest latent-strength rating-update ledger fields; league rows include expected wins, wins over expected, opponent-adjusted win rate, and average international opponent rating; region rows include flagship team/league counts and separate ecosystem counts. Walk-forward metrics also include aggregate and segment-level baseline comparisons against coin-flip, pre-game win-rate, and neutral team-only predictors, while full prediction rows expose the prior-only blue/red side adjustment used by the published probability. Compact sourced-player outputs carry latest Oracle observation provenance plus appearance provenance and recent match context, and browser history is split into scoped team-history shards plus first-class region-history artifacts, so player/team/role/region claims can be traced back to the source game, file, date, event, shown-team games, role games, last played opponents, and model provenance. Ranking claims should always be cited with the data source, canonical pre-1.0 model version, config hash, and schema version that produced them.

See `MODEL_ROADMAP.md` for the predictive target, dynamic player-importance formula, roster-continuity model, and anti-leakage rules.

## Key Files

- `src/App.tsx`: main ranking workbench UI.
- `MODEL_ROADMAP.md`: latent ranking target, model layering, player-share formula, validation order, and anti-leakage rules.
- `src/lib/model.ts`: transparent team and league rating calculations.
- `src/lib/playerModel.ts`: seeded player-share model plus sourced Oracle player-game rating updates.
- `src/lib/rosters.ts`: latest observed game-roster provenance and standings roster-basis derivation.
- `src/lib/rankingExplanations.ts`: static UI copy for public model-component explanations.
- `src/lib/snapshot.ts`: full snapshot builder, compact browser-summary builder, and filter-key logic.
- `src/data/teamIdentity.ts`: known team home league/region identities used when match rows lack explicit identity metadata.
- `src/lib/importers/oraclesElixir.ts`: Oracle's Elixir CSV parser and normalizer.
- `src/data/rankingConfig.ts`: event-tier K values and factor labels.
- `scripts/build-static-snapshot.ts`: writes the full derived artifact plus compact browser summary/shards.
- `scripts/refresh-data-if-changed.mjs`: Railway/local wrapper that downloads staged raw data hourly and crunches only when source content changed.
- `scripts/railway-bucket.mjs`: Railway Bucket S3 helper for publishing generated artifacts and proxying `/data/*`.
- `scripts/railway-server.mjs`: Railway production server for `dist/`, live `/data` artifacts, health checks, and the background refresh loop.
- `scripts/fetch-leaguepedia.mjs`: Leaguepedia Cargo match fetcher.
- `scripts/fetch-riot-gpr-snapshot.mjs`: manual Riot GPR benchmark extractor. Its output must stay outside the local model input manifest.
- `api/recalculate-rankings.ts`: Vercel cron endpoint for scheduled recalculation.
- `tests/`: provenance, importer, merge, and cron safety tests.
- `railway.toml`: Railway web-service build, start, health check, and restart config.
- `vercel.json`: cron schedule.
