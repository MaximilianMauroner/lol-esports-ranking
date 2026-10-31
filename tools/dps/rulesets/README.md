# Offline retained-source tools

Use a trusted, stable local snapshot and a `PinnedSourceSet` manifest. These tools
do not fetch sources, publish catalogs, or establish whether declared hotfix and
region mappings are historically correct. Concurrent hostile replacement of
parent directories is outside the filesystem adapter's confinement guarantee.

Verify every declared artifact's retained bytes and source-set identity:

```sh
pnpm exec tsx tools/dps/rulesets/verify-retained.ts source-set.json retained-directory
```

Discover champion/item index IDs from selected artifact IDs in that manifest:

```sh
pnpm exec tsx tools/dps/rulesets/discover-retained.ts source-set.json retained-directory champion-index item-index
```

The second command verifies the entire declared source set before discovering
selected indices from the same in-memory bytes. It prints canonical JSON with
source-set identity, artifact identities, source pointers, all index records,
empty-name gaps, and `undiscoveredArtifactIds`. Selection order does not change
output. Unknown, duplicate, empty or unsupported selections fail. Any verification
or discovery error produces a nonzero exit and no partial report on stdout.

Discovery preserves unnamed, nonpurchasable and inactive-map item records.
Neither a successful report nor an empty undiscovered list proves a complete
ruleset inventory, legality, implemented mechanics or combat-complete coverage.
The report only covers the explicitly declared and selected sources.

Compile the selected pinned Data Dragon champion index, `championFull` detail,
and item index into one partial source catalog:

```sh
pnpm exec tsx tools/dps/rulesets/compile-retained-ddragon.ts source-set.json retained-directory champion-index champion-detail item-index
```

Every declared retained file is verified before output, including unselected
artifacts. The catalog includes numeric champion/item IDs, source pointers,
passive and four primary spell slots, empty-name gaps, selected artifact paths
and hashes, undiscovered artifact IDs, and a deterministic catalog hash. Changed
source bytes or source-set hotfix identity change that hash. The output is
explicitly `data-dragon-index-and-primary-slots-only` and `combatComplete:false`;
it does not supply alternate forms, mechanics, mode legality, regional hotfix
evidence, or a complete P02 inventory. Errors leave stdout empty.

Inventory retained Data Dragon rune trees and runes, summoner spells, and maps:

```sh
pnpm exec tsx tools/dps/rulesets/compile-retained-ddragon-auxiliary.ts source-set.json retained-directory runes-id summoner-id map-id
```

The command verifies every declared retained file before parsing the three
selected, pinned, same-version and same-locale sources. It preserves numeric IDs,
rune hierarchy, raw summoner mode tags, source pointers and empty-name gaps.
Changed selected or unselected bytes and changed source-set hotfix identity change
the canonical report hash. Missing, conflicting or corrupt sources fail without
partial stdout. Mode tags are source strings, including work-in-progress tags;
they do not establish active PC queues or maps. The report explicitly leaves PC
patch and active mode mapping unreviewed and combat completeness false.

Inventory raw item recipe links and source field names from a retained Data
Dragon item index:

```sh
pnpm exec tsx tools/dps/rulesets/compile-retained-ddragon-item-structure.ts source-set.json retained-directory item-index-id
```

The command verifies every declared source file, requires the selected pinned
Data Dragon item index, and reports every item ID and source pointer. `from`
preserves repeated components because the repetitions may express recipe
quantity; `into` links, raw effect keys and stat keys are recorded without
interpreting their values. Missing referenced item IDs and conflicting reverse
recipe links fail. One-sided `into` links remain explicit `linkGaps`, matching
what the source actually declares. The report hash includes the source-set
identity; failure leaves stdout empty. This inventory cannot certify item
mechanics, recipe availability, active maps or combat completeness.

Inventory one retained CommunityDragon character `.bin.json` source:

```sh
pnpm exec tsx tools/dps/rulesets/discover-retained-cdragon.ts source-set.json retained-directory cdragon-character-id
```

The command verifies every source-set file, then records every typed top-level
record path and its JSON pointer. It checks the character record's explicit
`mAbilities` links and each ability's `mRootSpell`/`mChildSpells` references
against the same retained bytes. Missing or conflicting referenced paths fail.
The report includes the CommunityDragon revision, URL, byte hash, retained
path, undiscovered artifact IDs and canonical report hash. It labels PC patch
mapping as unreviewed and combat completeness as false; extracted record links
alone do not determine spell behavior, forms, active game modes, or regional
hotfix application.

Match a retained CommunityDragon character directory listing to a retained Data
Dragon champion index:

```sh
pnpm exec tsx tools/dps/rulesets/compile-retained-cdragon-roster.ts source-set.json retained-directory champion-index-id character-directory-id
```

The command verifies every declared source file before parsing the two selected
artifacts. It requires every Data Dragon champion slug to have one exact directory
link and reports every other directory as unclassified. A directory link is only
a source path in the retained listing: it does not prove a `.bin.json` file exists, identify
alternate forms or mode assets, or establish a PC patch/CommunityDragon revision
mapping. This is an inventory of links in retained HTML source bytes; it does not
execute page scripts or certify the browser-rendered page. Missing, duplicate or
conflicting links fail without partial stdout.

CLI limits are 1 MiB for the manifest, 16 MiB per artifact and 64 MiB total retained
bytes. Programmatic callers can supply artifact/total limits. No decompression or
production database/bucket writes occur.

# Source mapping verification

`pnpm exec tsx tools/dps/rulesets/verify-source-mapping.ts <source-set.json> <retained-directory> <source-mapping.json>`
checks every declared retained file before validating the source mapping. The mapping binds one
PC patch, Data Dragon version, CommunityDragon revision, regional hotfix assignments, and explicit
mode/map/queue assignments to the verified source-set hash. Each region and mode names retained
artifact IDs as evidence. The command prints a compact hash and count report only after all checks
pass; it does not fetch, archive, publish, or certify complete mode or mechanic coverage.

Create a mapping through `buildSourceMapping` after `assertPinnedSourceSet`, then retain both
manifests and the raw artifact bytes. Reverify through `assertSourceMapping` or this command before
using an assignment. The current 26.18/16.18.1 source inventory has no accepted CommunityDragon
and mode/hotfix evidence bundle, so no real mapping manifest is published here.
