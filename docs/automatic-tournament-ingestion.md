# Automatic tournament ingestion

Railway's existing scored-data refresh downloads Leaguepedia `ScoreboardGames`
for the refresh date window. No event list, tournament-specific file, or new
Railway variable is required. The restored raw baseline and rolling downloads
are merged before ranking inputs are imported.

Tournament rows can lack a team's domestic league even when earlier domestic
results identify it. The shared source importer fills an unknown tournament
home league from the team's preceding domestic observation. It preserves explicit
leagues and leaves teams with no prior evidence unresolved. It does not use
future matches to resolve an earlier tournament game.

The source pipeline version changes with this attribution policy. The model
config hash therefore changes, so a checkpoint made with the earlier policy
cannot silently supply the new ranking. The raw storage format stays unchanged.

The automatic ingestion regression uses captured public
[2026 Demacia Cup Global Invitational records](https://lol.fandom.com/wiki/2026_Demacia_Cup_Global_Invitational)
and a small set of earlier sourced domestic results. A local Cargo server supplies
two refresh windows. The second refresh retains all 27 captured games across 15
series, with no manual manifest edit. Global and 2026 ledgers each retain one
rating update per completed series. The captured October 3–6 records are a test
fixture, not a complete current tournament feed.

```sh
pnpm exec tsx --tsconfig tsconfig.app.json --test tests/automaticTournamentIngestion.test.ts
```

Gated Railway workers run the existing daily audit by default, even when the
official schedule has no newly completed match. This discovers tournaments that
only Leaguepedia reports. The default interval is 24 hours. Explicit
`RANKING_DAILY_AUDIT_ENABLED=false` disables this path; shadow mode stays opt-in.
The audit uses the existing full comparison, lease, parity, promotion, and receipt
controls. It adds a daily full build to gated workers that had audits disabled
by default. No deployment, credentials, or publication controls are changed.
