# LoL Esports GPR Workbench

A better Global Power Rankings prototype for LoL esports. The app starts as a ranking workbench rather than a static table: ranking controls, tournament weights, selected-team explanations, team timelines, player timelines, season summaries, event summaries, and methodology notes.

## Status

The app serves the latest committed browser-safe snapshot from `public/data/`. It is not an official Riot ranking, and each public ranking claim should stay tied to the committed data source manifest, model version, config hash, and coverage window that produced it.

## Run

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run release:check
```

## Styling

The UI uses plain React components with product styles in `src/index.css`. Theme tokens, layout rules, table styling, loading states, and responsive behavior live there.

## Static Data Strategy

The frontend loads static JSON from:

```text
/data/ranking-summary.json
```

By default, Vercel, Cloudflare Pages, and other static hosts serve the committed files in `public/data/`. Set `VITE_RANKING_DATA_URL` only when you intentionally want the browser to load an externally hosted manifest, such as a Vercel Blob URL written by the optional scheduled job.

Static data can be generated without source inputs for a no-data smoke fixture:

```bash
npm run data:build
```

With no source arguments, this writes a valid `no-data` summary instead of falling back to seeded samples. The app does not recalculate rankings in React render. It loads a compact default board first, then lazy-loads compact per-filter shards from `public/data/snapshots/`. Event and region filters narrow the presented rows while preserving the global rating scale. Season filters publish the chronological model state through the selected season, so older years do not inherit current-year standings.

The normal local refresh workflow is:

```bash
npm run data:download
npm run data:crunch
npm run release:check
git add data/raw/manifest.json public/data/ranking-summary.json public/data/players.json public/data/team-history.json public/data/snapshots
git commit -m "Refresh LoL esports ranking data"
git push
```

`data:download` stores raw provider files under `data/raw/` and writes `data/raw/manifest.json`. Raw provider downloads are local inputs and are ignored by Git; the manifest is committed for provenance. By default the downloader fetches Oracle's Elixir CSVs and Leaguepedia ScoreboardGames from 2011-01-01 through today. `data:crunch` reads the local manifest and raw files, writes the full local calculation artifact to `data/derived/ranking-snapshot.full.json`, and writes the deployable client payload to `public/data/ranking-summary.json`, `public/data/players.json`, `public/data/team-history.json`, and `public/data/snapshots/*.json`.

Commit the generated `public/data` payload after review so the deployed client can load it as static JSON. Do not commit raw provider downloads or `data/derived/ranking-snapshot.full.json`. The full public snapshot files `public/data/ranking-snapshot.json` and `public/data/*.full.json` are intentionally blocked because they can exceed GitHub file limits; the compact manifest and shards are the browser contract. Riot GPR snapshots are not part of the local data-source manifest.

`data:download` treats Oracle's Elixir as the primary game-level source and Leaguepedia as the backup/gap-fill source. It discovers the public Oracle CSV files from the Oracle Google Drive folder, downloads the CSVs that overlap the requested date range, then downloads Leaguepedia Cargo data for the same range. If Google Drive returns a quota/HTML page instead of a CSV for a file, that file is skipped with a manifest warning instead of being recorded as usable data.

To override Oracle discovery with direct CSV URLs, include them in the download step:

```bash
npm run data:download -- --oracle-csv-url "https://example.com/path/to/oracle.csv"
npm run data:crunch
```

Useful download flags:

```bash
npm run data:download -- --start 2024-01-01 --end 2026-06-26
npm run data:download -- --oracle-required true
npm run data:download -- --oracle false
npm run data:download -- --leaguepedia false
```

To build from Oracle's Elixir CSVs:

```bash
npm run data:build:oracle -- data/raw/oracles-elixir/2026_LoL_esports_match_data_from_OraclesElixir.csv
```

Oracle rows are normalized into match records using `gameid`, side, team, result, kills, gold, objectives, game length, league, year, split, playoffs, patch, and data-completeness fields when present.

To build from a fetched Leaguepedia Cargo snapshot:

```bash
npm run fetch:leaguepedia -- --start 2026-01-01 --end 2026-06-26 --output data/raw/leaguepedia/leaguepedia-2026.json
npm run data:build:leaguepedia -- data/raw/leaguepedia/leaguepedia-2026.json
```

To combine both community sources for the algorithm:

```bash
npm run data:build -- --oracle-csv data/raw/oracles-elixir/2026_LoL_esports_match_data_from_OraclesElixir.csv --leaguepedia-json data/raw/leaguepedia/leaguepedia-2026.json
```

Oracle's Elixir has precedence for duplicate games because it carries richer game-stat fields. Leaguepedia Cargo fills gaps and supplies broad match/event coverage. Overlapping scored rows are merged only when canonical team/winner identity plus source IDs or team stat lines identify the same game; broad date/team/winner matching is reserved for result-only gap-fill rows so separate same-winner games in a series are preserved. Sponsor-era aliases such as DRX/Kiwoom DRX, OKSavingsBank BRION/HANJIN BRION, and DN Freecs/DN SOOPers are normalized before dedupe. Seeded data is explicitly marked as `sourceProvider: "seed"` and should be used only for local demo snapshots.

## Source Strategy

The intended pipeline has three layers:

- Oracle's Elixir CSVs: primary game-level match data source for scheduled snapshots and model inputs.
- Leaguepedia Cargo API: broad historical events, teams, players, rosters, and match metadata for enrichment and gap filling.
- Riot GPR snapshots: optional manual benchmark exports extracted from the public LoL Esports GPR page. They are not used as local model inputs and are not written into `data/raw/manifest.json`.

Fetch examples:

```bash
npm run fetch:leaguepedia -- --start 2026-01-01 --end 2026-06-26 --output data/raw/leaguepedia/leaguepedia-2026.json
npm run fetch:riot-gpr -- --year 2026 --milestone current --output data/raw/riot-gpr/riot-gpr-2026-current.json
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
- `LEAGUEPEDIA_MATCHES_JSON_URL`: optional JSON URL produced by `npm run fetch:leaguepedia`, used as match/event gap-fill for scheduled snapshots.
- `VITE_RANKING_DATA_URL`: public Blob URL the browser should load in production.

Deployed static files are immutable at runtime, so the scheduled function publishes to Blob rather than trying to modify files inside a deployment. If you use this mode, set `VITE_RANKING_DATA_URL` to the public Blob summary URL. The browser-facing Blob payload is the summary contract, not the full calculation artifact; it includes the public URLs for its shard, player-rating, and team-history companions. If no public source produces rows, the cron returns a `no-data` result instead of publishing seeded sample data.

## Model

The transparent local model is Elo-like and intentionally explainable:

- Seasonal hierarchy: published power is `LeagueAnchor + TeamStableOffset + RosterPriorOffset + Momentum + ContextAdjustment`, with uncertainty shown beside the score.
- Tournament context: EventK values put Worlds/MSI knockouts above international early stages, regional playoffs, and regular season.
- Recency: newer matches carry more weight.
- Result-first team Elo: game wins/losses update stable team offset. Kills, gold, and objectives are tracked in a separate shadow execution-residual ledger and are not allowed to affect their own pre-game prediction.
- Opponent strength: beating stronger teams moves rating more through the Elo expectation.
- League strength: international cross-league results update league Elo against the participating teams' pregame power, so beating a higher-rated representative carries more signal than beating a lower-rated one. Completed international tournaments also add a capped placement residual from actual stage advancement versus pre-event expectation. Same-region international games do not directly move league game Elo, so same-region finals are credited through the path and placement residual rather than double-counting the final itself.
- Series damping: each game uses `EventK / sqrt(bestOf)`, so a Bo5 carries more signal than a Bo1 without counting five times as much.
- Uncertainty: standings expose a rating band so low-connectivity or low-volume teams are not ranked with false precision.
- Eligibility: ranked rows carry total-volume, current-volume, staleness, uncertainty, and league-anchor gates. First-division minor regions can become eligible with enough scoped volume and current international signal; ERLs, NACL, EMEA Masters, academy, national, low-volume, and unknown-league rows remain visible as provisional ecosystem teams rather than being promoted as official top-board claims.
- Roster continuity: Oracle player rows are attached as observed game rosters. Complete lineup changes regress stable team offset toward the league anchor and widen uncertainty using role-value weights rather than raw returning-player counts.
- Momentum: recent overperformance is a capped, fast-decaying overlay; it affects current prediction without becoming permanent stable strength.
- Dynamic player shares: player timelines start from role priors, then apply impact multipliers for objective impact, award residual, recent form, availability, and role certainty. Public-data outputs include post-game sourced player ratings from Oracle player rows. Sourced player updates compare each player with the opposing same-role player in that game, so jungle/bot/support box-score baselines cannot inject rating mass by themselves, and final player ratings use league-aware baselines so domestic farming in lower-connectivity leagues is not presented on the same starting scale as LCK/LPL. Public ranked player rows require at least 20 sourced role games, at least 20 games for the displayed team in the active scope, and a team that is not `unanchored-league`; thinner, reserve, transfer-fragment, or unanchored player samples remain auditable through rating-proof and full-artifact rows with appearance flags instead of being promoted as top-board claims. Published walk-forward probabilities use prior-only player-rating residuals above each team's league baseline plus side-context adjustments after same-day prediction batches are frozen; metrics keep neutral team-only and player-adjusted deltas for auditability.
- Award residuals: current local sources do not contain dated MVP/POG/POTM/All-Pro records, so award residuals stay unapplied instead of being inferred from visible stats.
- Baseline comparisons: schema `13` walk-forward metrics compare the side-aware published model with coin-flip, pre-game win-rate, and neutral team-only baselines, including segment rows for contexts such as international, cross-region, side-known, patch-transition, and roster-change games. Region rows publish flagship-region strength separately from broad ecosystem team counts, so lower-tier ERL/academy/cup volume does not dilute the main LEC/LCK/LPL regional signal. The v0.26 model changes sourced player-rating scale semantics: previous v0.25 player ratings over-rewarded roles whose raw Oracle box-score baselines injected rating mass above `0.5 + 0.5` per same-role matchup and let lower-tier domestic ladders compound from the same `100` starting point as major leagues. v0.26 uses same-role matchup-relative sourced player performance and anchors final player baselines to league strength. v0.27 changes season snapshot semantics: a season shard publishes standings from the chronological model through that selected season instead of filtering today's global standings. v0.28 shrinks the published sourced-player edge by home-league tier, so ERL/academy/emerging domestic dominance is regressed toward its league baseline before appearing on the global player board or feeding pre-game player adjustments. v0.29 adds season-scoped player directory rows. v0.30 keeps low-sample sourced players out of ranked public player rows until they reach 20 sourced games, while preserving them in audit/proof outputs. v0.31 builds season-ranking models with season-scoped team profiles instead of only relabeling the row after ranking, and keeps developmental teams unanchored even when their parent league is certified. v0.32 caps emerging and unknown league published anchors before team/player baselines and removes players from unanchored-league teams from the public ranked player directory, preventing EMEA Masters-style ecosystem volume from making ERL or academy leagues appear stronger than first-division minor regions. v0.33 credits season-scoped player rows to the player's primary team in that scope and requires displayed-team sample volume, so transfer fragments and reserve appearances do not crowd public leaderboards. v0.34 recomputes eligibility after every season/event/region filter, adds a 30-game total-volume gate, and defaults the team table to ranked rows while keeping provisional teams in audit mode. Schema 13 adds player appearance provenance to `players.json` and rating-proof rows: each sourced player exposes total rated games, shown-team games, role games, team/role histories, and flags for multi-team or thin latest-team samples. The source pipeline `canonical-identity-stat-dedupe-v10` distinguishes Worlds, First Stand/FST MSI-level bracket games, EWC-style events, EWC qualifiers, Demacia Cup, EMEA Masters, generic LTA championship rows, and academic/world-name events, derives current team profiles from latest explicit home-league observations, preserves Team Secret Whales as distinct from Team Secret, and maps lower-division codes such as LFL2, PRMP, NL, and CT as LEC ecosystem leagues instead of relying on broad substring matches. The public artifact can show where GPR is adding predictive signal beyond a domestic record table and where calibration still lags.

Pre-1.0 breaking changes are encouraged when they improve accuracy, fairness, provenance, model clarity, or long-term maintainability. Breaking model/schema changes should bump the relevant version, regenerate affected snapshots, and document migration impact.

Riot's official model should be used as a benchmark layer, not as a formula clone.

Every generated snapshot includes `model.version`, `model.configHash`, active model parameters, source provider breakdowns, match coverage dates, source/data quality counts, and whether seeded sample data is present. Schema version `13` standing rows include rating components and latest rating-update ledger fields; league rows include expected wins, wins over expected, opponent-adjusted win rate, and average international opponent rating; region rows include flagship team/league counts and separate ecosystem counts. Walk-forward metrics also include aggregate and segment-level baseline comparisons against coin-flip, pre-game win-rate, and neutral team-only predictors, while full prediction rows expose the prior-only blue/red side adjustment used by the published probability. Compact sourced-player outputs carry latest Oracle observation provenance plus appearance provenance, so player/team/role claims can be traced back to the source game, file, date, event, shown-team games, and role games. Ranking claims should always be cited with the data source and model version that produced them.

See `MODEL_ROADMAP.md` for the predictive target, dynamic player-importance formula, roster-continuity model, and anti-leakage rules.

## Key Files

- `src/App.tsx`: main ranking workbench UI.
- `MODEL_ROADMAP.md`: predictive ranking target, model layering, player-share formula, validation order, and anti-leakage rules.
- `src/lib/model.ts`: transparent team and league rating calculations.
- `src/lib/playerModel.ts`: seeded player-share model plus sourced Oracle player-game rating updates.
- `src/lib/rosters.ts`: latest observed game-roster provenance and standings roster-basis derivation.
- `src/lib/rankingExplanations.ts`: static UI copy for public model-component explanations.
- `src/lib/snapshot.ts`: full snapshot builder, compact browser-summary builder, and filter-key logic.
- `src/data/teamIdentity.ts`: known team home league/region identities used when match rows lack explicit identity metadata.
- `src/lib/importers/oraclesElixir.ts`: Oracle's Elixir CSV parser and normalizer.
- `src/data/rankingConfig.ts`: event-tier K values and factor labels.
- `scripts/build-static-snapshot.ts`: writes the full derived artifact plus compact browser summary/shards.
- `scripts/fetch-leaguepedia.mjs`: Leaguepedia Cargo match fetcher.
- `scripts/fetch-riot-gpr-snapshot.mjs`: manual Riot GPR benchmark extractor. Its output must stay outside the local model input manifest.
- `api/recalculate-rankings.ts`: Vercel cron endpoint for scheduled recalculation.
- `tests/`: provenance, importer, merge, and cron safety tests.
- `vercel.json`: cron schedule.
