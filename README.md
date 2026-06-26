# LoL Esports GPR Workbench

A better Global Power Rankings prototype for LoL esports. The app starts as a ranking workbench rather than a static table: ranking controls, tournament weights, selected-team explanations, team timelines, player timelines, season summaries, event summaries, and methodology notes.

## Status

This is a scaffold that shows no ranking data until public match rows are imported. It is not an official Riot ranking and should not be presented as current truth until the ingest scripts are run and the model output is reviewed.

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
```

## Styling

The UI uses Tailwind CSS through the Vite plugin. Theme tokens live in `src/index.css`, and component styles are composed with Tailwind utilities in `src/App.css`.

## Static Data Strategy

The frontend loads static JSON from:

```text
/data/ranking-snapshot.json
```

Set `VITE_RANKING_DATA_URL` when you want the browser to load a hosted JSON object instead, such as a Vercel Blob URL written by the scheduled job.

Static data is generated explicitly:

```bash
npm run data:build
```

With no source arguments, this writes a valid `no-data` snapshot instead of falling back to seeded samples. The app does not recalculate rankings in React render. It selects precomputed snapshots from the generated JSON by season, event, and region. Filters narrow the presented rows while preserving one model version's global rating scale.

For a local demo with checked-in seeded samples:

```bash
npm run data:build -- --seeded-sample
```

To keep downloading separate from ranking calculation, use:

```bash
npm run data:download
npm run data:crunch
```

`data:download` stores raw files under `data/raw/` and writes `data/raw/manifest.json`. By default it downloads Oracle's Elixir CSVs, Leaguepedia ScoreboardGames from 2011-01-01 through today, and the current Riot GPR reference snapshot. `data:crunch` reads only the local manifest and raw files, then writes `public/data/ranking-snapshot.json`.

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
npm run data:build:oracle -- data/2026_LoL_esports_match_data_from_OraclesElixir.csv
```

Oracle rows are normalized into match records using `gameid`, side, team, result, kills, gold, objectives, game length, league, year, split, playoffs, patch, and data-completeness fields when present.

To build from a fetched Leaguepedia Cargo snapshot:

```bash
npm run fetch:leaguepedia -- --start 2026-01-01 --end 2026-06-26 --output data/leaguepedia-2026.json
npm run data:build:leaguepedia -- data/leaguepedia-2026.json
```

To combine both community sources for the algorithm:

```bash
npm run data:build -- --oracle-csv data/2026_LoL_esports_match_data_from_OraclesElixir.csv --leaguepedia-json data/leaguepedia-2026.json
```

Oracle's Elixir has precedence for duplicate games because it carries richer game-stat fields. Leaguepedia Cargo fills gaps and supplies broad match/event coverage. Seeded data is explicitly marked as `sourceProvider: "seed"` and should be used only for local demo snapshots.

## Source Strategy

The intended pipeline has three layers:

- Oracle's Elixir CSVs: primary game-level match data source for scheduled snapshots and model inputs.
- Leaguepedia Cargo API: broad historical events, teams, players, rosters, and match metadata for enrichment and gap filling.
- Riot GPR snapshots: official GPR comparison data extracted from the public LoL Esports GPR page.

Fetch examples:

```bash
npm run fetch:leaguepedia -- --start 2026-01-01 --end 2026-06-26 --output data/leaguepedia-2026.json
npm run fetch:riot-gpr -- --year 2026 --milestone current --output data/riot-gpr-2026-current.json
```

Leaguepedia rate-limits aggressively. The fetcher uses pagination and a delay, but repeated ad hoc queries can still be throttled.

## Vercel Scheduled Recalculation

`vercel.json` configures a cron job:

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

The cron endpoint recalculates the same static snapshot shape from public-source inputs. With `BLOB_READ_WRITE_TOKEN` configured, it writes the latest public-data JSON to Vercel Blob at `rankings/latest.json`. The default schedule is daily for Hobby-plan compatibility; use a more frequent expression on a plan that supports it.

Recommended Vercel environment variables:

- `CRON_SECRET`: required bearer token for `/api/recalculate-rankings`.
- `BLOB_READ_WRITE_TOKEN`: enables the cron function to publish `rankings/latest.json`.
- `ORACLES_ELIXIR_CSV_URL`: optional direct CSV URL for scheduled Oracle's Elixir import.
- `LEAGUEPEDIA_MATCHES_JSON_URL`: optional JSON URL produced by `npm run fetch:leaguepedia`, used as match/event gap-fill for scheduled snapshots.
- `VITE_RANKING_DATA_URL`: public Blob URL the browser should load in production.
- `ALLOW_SEEDED_SNAPSHOT`: optional local/demo escape hatch. When set to `true`, the endpoint may calculate seeded output for inspection, but seeded output is never published to Blob.

Deployed static files are immutable at runtime, so the scheduled function publishes to Blob rather than trying to modify `public/data/ranking-snapshot.json` inside a deployment. If no public source produces rows, the cron publishes a `no-data` snapshot instead of seeded sample data.

## Model

The transparent local model is Elo-like and intentionally explainable:

- Tournament context: EventK values put Worlds/MSI knockouts above international early stages, regional playoffs, and regular season.
- Recency: newer matches carry more weight.
- Result-only team Elo: game wins/losses update team strength; kills, gold, game time, and objectives are not team-rating multipliers.
- Opponent strength: beating stronger teams moves rating more through the Elo expectation.
- League strength: international cross-league results update league Elo, and team power is an 80/20 blend of team Elo and league Elo.
- Series damping: each game uses `EventK / sqrt(bestOf)`, so a Bo5 carries more signal than a Bo1 without counting five times as much.
- Uncertainty: standings expose a rating band so low-connectivity or low-volume teams are not ranked with false precision.
- Dynamic player shares: player timelines start from role priors, then apply impact multipliers for objective impact, award residual, recent form, availability, and role certainty. Current outputs remain demo-grade until sourced player-game stats and award data are imported.

Pre-1.0 breaking changes are encouraged when they improve accuracy, fairness, provenance, model clarity, or long-term maintainability. Breaking model/schema changes should bump the relevant version, regenerate affected snapshots, and document migration impact.

Riot's official model should be used as a benchmark layer, not as a formula clone.

Every generated snapshot includes `model.version`, `model.configHash`, active model parameters, source provider breakdowns, match coverage dates, and whether seeded sample data is present. Ranking claims should always be cited with the data source and model version that produced them.

See `MODEL_ROADMAP.md` for the predictive target, dynamic player-importance formula, roster-continuity model, and anti-leakage rules.

## Key Files

- `src/App.tsx`: main ranking workbench UI.
- `MODEL_ROADMAP.md`: predictive ranking target, model layering, player-share formula, validation order, and anti-leakage rules.
- `src/lib/model.ts`: transparent team and player rating calculations.
- `src/lib/snapshot.ts`: static snapshot builder and filter-key logic.
- `src/data/teamIdentity.ts`: known team home league/region identities used when match rows lack explicit identity metadata.
- `src/lib/importers/oraclesElixir.ts`: Oracle's Elixir CSV parser and normalizer.
- `src/data/sampleData.ts`: seeded sample matches and rosters.
- `src/data/rankingConfig.ts`: event-tier K values and factor labels.
- `scripts/build-static-snapshot.ts`: writes `public/data/ranking-snapshot.json`.
- `scripts/fetch-leaguepedia.mjs`: Leaguepedia Cargo match fetcher.
- `scripts/fetch-riot-gpr-snapshot.mjs`: Riot GPR page snapshot extractor.
- `api/recalculate-rankings.ts`: Vercel cron endpoint for scheduled recalculation.
- `tests/`: provenance, importer, merge, and cron safety tests.
- `vercel.json`: cron schedule.
