# Detail and Players demand

This is a source trace at HEAD `d38add5f228e67022a3001e27a820ad76657f37f` and tree `10c19882806045f340674c6627b4715929ee020e`. No fixture was generated. Actual object digests and raw body receipts remain UNRUN.

## History has one index and one selected scope

`App.tsx:148-150,180-183,300-307,473-482` keeps Players and history demand separate. Opening comparison supplies its actual team keys. Opening detail supplies the detail team through `TeamsView.tsx:295-341`. Closing detail does not clear the comparison keys.

`usePublicArtifacts.ts:140-144,210-234,518-550` loads the history index and then the `All__All__All` scope with `/series` selected record keys. No other history family is requested by this sequence. `writePlan.ts:58-61,130-132,149-151,166-169` supplies the logical paths. They are the following paths.

- `/data/history/team-series/index.json` is the index.
- The emitted index entry `scopeIndex.All__All__All.url` is the scope. Its filename follows `schema.ts:842-848`.
- Every archive member reachable from the index is required.
- Every archive member reachable from the scope under the actual `/series` key selection is required. An index, record wrapper, or archive catalog needed to reach a selected leaf is part of this closure.

The closure walker follows the same reference paths and key ranges as `archive.mjs:122-165`. A small object stays inline under `archive.mjs:16`. An inline All scope contains aggregate team series. Its request cannot identify the selected teams. No selected-only byte claim is made.

Lane 7 requires the full nonempty history closure and no earlier member in the observed semantic cache. Both request streams must show no history before the first comparison input. Removing the first team can use the already retained objects. It still requires the exact remaining chart IDs and values.

Opening the old detail in lane 8 requires only its uncached index and All scope members. Opening the new comparison requires only its uncached selected history members. These sets can be empty after lane 7. Each action records its actual zero-request cache reuse separately. Earlier response sequence numbers remain attached to every oracle value. They belong to this same actual unit, never an imported run.

## Players has one directory closure

`TeamsView.tsx:1592-1597` invokes `onRequestPlayers` only when the Players disclosure opens. `App.tsx:148,300,548` connects that callback to `loadPlayers`. `usePublicArtifacts.ts:185-206` fetches the player directory once that flag is true.

The full legitimate closure is `/data/entities/players.json`, or its emitted `playerDirectoryUrl`, plus every reachable archive member. The directory includes both `players` and `currentLineups`. It has no separate lineup request. Closed Players permits none of that closure in either stream. Empty fixture rosters do not remove the directory request requirement.

## Other actions permit zero artifact requests

Row picks, comparison and detail close controls, clearing picks, and Data and sources permit zero new artifact attempts. Initial ranking summary, ranking scope prefetches, and tournament movement index demand remain in the initial ledger. They are not a new allowance for any later action. The tagged sensitivity fetch uses an actual initial immutable object outside every history and player closure. It permits exactly that one tagged attempt in each stream and no server arrival.

The source closure above is fixed before future admission. The driver saves the full actual emitted logical path, member URL, digest, storage type, and raw emitted body path before browser start. Its pre-action plans record the actual selected IDs and cache intersection. Every extra attempt fails. Neither the logical list nor an aggregate request proves selection. Mounted chart labels, series keys, raw values, and pixel mapping are separate requirements.

Root must review this logical closure before release. Actual emitted closure receipts are still PENDING. If an extra legitimate artifact is found, preserve the failed output and request a new source review. Do not add an allowance during a run.
