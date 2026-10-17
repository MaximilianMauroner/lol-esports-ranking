# Repository instructions

- Pre-1.0 breaking changes are encouraged when they improve code quality or data accuracy.
- Keep ranking claims tied to the data source and model config that produced them.
- Do not present seeded or sample data as official LoL Esports data.
- Use shadcn/ui components from `src/components/ui` for controls and Recharts charts where they fit. Use custom components when shadcn does not fit the interaction or data density.
- Suggest methods that improve score accuracy.
- Keep league scores accurate and fair.
- Weight games by league strength. Give tournaments more weight than regular season games.
- Check for an existing dev server before starting one. Reuse an existing server for this worktree.

## Source ownership

- `src/domains/rankings/` and `src/domains/tournaments/` own business rules. Use their public entries. Keep domain code free of browser state, React, and Node effects.
- `src/lib/` holds five retained ranking safety implementations. Keep their exact paths. `src/shared/` holds deterministic ordering and shared presentation helpers. `src/data/` holds presentation facts and legal text.
- `src/browser/`, `src/hooks/`, `src/components/`, `src/views/`, and app entries own the browser. Keep replay producers, checkpoints, importers, and write plans out of its runtime graph.
- `scripts/` owns production Node code, storage, publication, and operator commands. It cannot import browser or developer code.
- `tools/` owns developer calibration, audits, assets, and verification tools. It can consume shared and production code. The receipt-pinned `scripts/benchmark-incremental-ranking.ts` is also a developer entry with tools ownership.
- `tests/` owns tests and fixtures. Discover serial browser journeys by `*Browser.test.ts`.
- `worker/` owns the Cargo workspace. `ops/` owns safety receipts.
- Lint enforces import directions after resolving paths. Keep the ownership policy in `tools/dev/ownership-policy.mjs`.
- Keep the move map in `tools/dev/platform-migration-map.json` rerunnable with `node tools/dev/migrate-platform.mjs --check`.
- Put reports, plans, audits, research captures, and handoffs in ignored `.agents/artifacts/`. Keep source fixtures and product assets in Git. `verify` checks tracked-file hygiene separately from Git-independent lint.

## Durable safety rules

- Do not move paths or change command arguments in `IMPLEMENTATION_EVIDENCE_CONTRACTS`. Stored rollout evidence binds these definitions.
- Preserve paths listed by `ops/ranking-restart/incident-ledger.json` unless a separately reviewed migration updates its `currentPaths`. Never edit the historical `baseline-receipt.json` during a source refactor.
- Node stays the default refresh path. Remove Node-only provider code and compatible diagnostic formatting only after shadow, cutover, and a 30-day rollback period.
- Keep an old stored-format reader until no active, rollback, audit, or recovery authority refers to that format. After new-format publication, a code-only rollback requires a compatible generation.
- Verify reference closure before granting publication authority to full, patch, or local artifacts. Preserve canonical identities, fencing, immutable-first publication, and provenance.
- Keep native and browser model constants in sync through parity checks. Keep synthetic acceptance separate from retained-input proof.
- Recovery first restores the previous complete generation. A forced full replay from verified raw authority needs separate recovery authorization.
- Production activation, provider collection, bucket changes, deployment, and deletion need explicit authorization. Green CI does not authorize them.
