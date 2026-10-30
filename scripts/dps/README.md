# rift-delta DPS commands

Run these commands from the repository root with Node 24 and pnpm 11.16.0.
Use `pnpm dps:storage:status` for storage status and `pnpm dps:storage:audit` for the storage audit.
The migration command is `pnpm dps:db:migrate`. Static provider collection is `pnpm dps:data:sync`.
The ingestion entry is `pnpm dps:ingest:euw`. All writes and provider collection need operator authorization.
Use the `dps:archive:*` commands for archive reconciliation and recovery after approval.
The original `lol_dps` schema, archive keys, provenance, and format versions stay unchanged.
Configure the private archive with `DPS_ARCHIVE_BUCKET`, `DPS_ARCHIVE_ENDPOINT`, `DPS_ARCHIVE_REGION`, `DPS_ARCHIVE_ACCESS_KEY_ID`, and `DPS_ARCHIVE_SECRET_ACCESS_KEY`.
DPS never falls back to generic ranking bucket credentials. The existing private bucket can be used without moving its data.

The web service also needs these archive variables and `DATABASE_URL` to serve observed timeline skill progression.
Without configured archive access, the progression API returns an explicit legal fallback with a configuration note.
Set the approved private archive values on the web service before deployment to retain timeline progression.
Applying these settings to a live service needs operator approval.

The lab at `/lab` requires `PROTOTYPE_ACCESS_PASSWORD` and `PROTOTYPE_SESSION_SECRET` on the server.
See `env.example` for the retained environment names. Do not set `DATABASE_URL` for fixture use.
Behind a trusted reverse proxy, set `DPS_TRUST_PROXY=true` only when that proxy overwrites or appends the client IP in `X-Forwarded-For`. Block direct public access to the Node server so that all clients pass through this proxy. The login limiter uses the nearest forwarded IP.
Keep this setting off for direct public connections. Without a trusted client-IP proxy, users share the proxy address and its login lockout.
Verify the ingress header behavior before enabling this setting. Local tests do not verify production ingress.
Fixtures do not contain live Riot observations. Never use browser-prefixed variables for private credentials.

Developer ruleset and retained-source commands live in `tools/dps/rulesets`.
Run them with `pnpm exec tsx tools/dps/rulesets/<command>.ts`.
The historical planning contract and its validator remain under `tools/dps` for regression tests.
They describe the source project at its pinned baseline, not the current integration layout.

Source attribution and mechanics references are in `docs/dps-source.md`.
