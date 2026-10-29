# rift-delta DPS commands

Run these commands from the repository root with Node 24 and pnpm 11.16.0.
Use `pnpm dps:storage:status` for storage status and `pnpm dps:storage:audit` for the storage audit.
The migration command is `pnpm dps:db:migrate`. Static provider collection is `pnpm dps:data:sync`.
The ingestion entry is `pnpm dps:ingest:euw`. All writes and provider collection need operator authorization.
Use the `dps:archive:*` commands for archive reconciliation and recovery after approval.
The original `lol_dps` schema, archive keys, provenance, and format versions stay unchanged.

The lab at `/lab` requires `PROTOTYPE_ACCESS_PASSWORD` and `PROTOTYPE_SESSION_SECRET` on the server.
See `env.example` for the retained environment names. Do not set `DATABASE_URL` for fixture use.
Fixtures do not contain live Riot observations. Never use browser-prefixed variables for private credentials.

Developer ruleset and retained-source commands live in `tools/dps/rulesets`.
Run them with `pnpm exec tsx tools/dps/rulesets/<command>.ts`.
The historical planning contract and its validator remain under `tools/dps` for regression tests.
They describe the source project at its pinned baseline, not the current integration layout.

Source attribution and mechanics references are in `docs/dps-source.md`.
