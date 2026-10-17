**Review result: FAIL.** There are two warnings and no critical findings. I found no wrong merge and no wrong score in the current data. Both warnings are about how the comparator counts and labels rows, and both need a fix or an explicit scope note before acceptance. I changed no files. The worktree is clean.

## Findings

### 1. [warning] The agreement counter still allows a Riot-only self-comparison
**Location.** `scripts/compare-season-matches.py:300-301`, with lines 194-202 and 275.

**Finding.** The new guard requires `cargoMatchId`, but that is the wrong invariant. `cargoMatchId` is set whenever a schedule row is selected (line 283). `expected_score` stays `None` when the Cargo team names do not map to the public names and `identity_conflict` is false (lines 196-202). In that case `correctScore` falls back to `riot_score` (line 275), so `riotScore == correctScore` is true by construction and the row counts as an agreement. Line 267 has the same fault in the other direction: `score == expected_score` with `None` adds a false `source-score-conflict`.

**Evidence.** I measured 0 such rows in the current data, so 953 displayed and 887 unique agreements are correct now. The report says the comparator also works for later captures, and in those the B R2 fault can come back.

**Suggestion.** Keep the Cargo score as its own field. Count `cargo_score is not None and riot_score == cargo_score`. On line 267, compare only when the Cargo score exists.

### 2. [warning] The report calls three source matches "duplicate", but the census does not flag them as duplicates
**Location.** `compare-season-matches.py:225-226` (duplicate detection) and the `step` choice in `export_report` (about line 420). The new prose is in `reports/season-2026-match-audit.md:155`.

**Finding.** Seven games are published twice:
- Oracle `LOLTMNT01_*` rows show them under "Team Secret Whales". Their basis is `unresolved-game` and their `cargoGameId` is `None`.
- Leaguepedia rows show the same games under "Team Secret".
- Both series point to the same Cargo `MatchId` (`Asia-Pacific_Round 1_1`, `Round 2_1`, `Round 4_1`).

Duplicates are detected only through a shared `cargoGameId`, so none of these 14 rows gets `duplicate-game`. As a result:
- The counts of 139 `duplicate-game` series and 80 extra published rows leave out these 7 extra games.
- The "Bad record path" column says "stage inference" for all seven conflict rows, including the three new Leaguepedia rows and the May 20 row. The real fault is a failed cross-provider link, which is merge or series grouping.

**Evidence.** In `comparison/series.json` the paired series share a `cargoMatchId`. In `comparison/games.json` the Oracle rows have `cargoGameId=None`. All 7 rows are in the 291 flagged series, so none of them passes as clean. The fault class and the path are wrong, not the flag itself.

**Suggestion.** Add a series-level duplicate check for distinct displayed series that share a Cargo `MatchId` and have the same scores. Route `teams-source-conflict` to "merge or series grouping". The smaller option is to say in the report that these 7 games are outside the count of 80 and to correct the path text.

### 3. [nit] Team naming in the new prose
At report line 155, the Leaguepedia-derived public rows show "Team Secret". "Team Secret (Vietnamese Team)" is Cargo's raw name. The sentence assigns the raw name to both.

### 4. [nit] The capture has only map-level winners
The round notes say the capture has "explicit match/map winner templates". It has only map-level `|winner=` fields. The parser counts those, which is correct for this pinned capture. If a later capture adds a match-level `|winner=`, the score goes up by one. That would show as a `source-score-conflict`, not as a silent pass.

### 5. [nit] The Games of Legends captures have no receipts
`gol-wildcard.txt` and `gol-demacia.txt` have no request or hash receipts, unlike the Liquipedia files. The claim "no usable match list" is supported, because both pages have empty Game/Score/Patch/Date tables.

## What I verified (read-only and Python inspection)
- **Archive.** No member was removed or changed. 10 members were added. The smaller file is a compression change only. The archive SHA matches, and every archive member is byte-identical to the worktree file.
- **Replay.** I extracted the archive into `/tmp` and ran the comparator there with `python3 -I`. The CSV, the report, and `summary.json` are byte-identical to the committed files. This was a Python replay only, not a project runtime check.
- **Liquipedia parse.** All 14 matches parse. Scores equal the per-map winner counts. The ICT to UTC dates are correct. The trailing sections have no winner fields. Each match links to exactly one Cargo match. All 17 linked displayed series agree with Cargo on score. Teams differ only in the 4 Secret Whales matches.
- **LEVIATÁN alias.** Only Riot uses that spelling (26 slots). 20 Riot-linked Leviatan series have scores. All 20 agree with Cargo and none disagree. The alias-coverage file says 5 of these were linked before and 15 are new.
- **Counts.** 953 displayed and 887 unique agreements reproduce. There are 0 Riot-only self-matches. `same-provider-only` has 7 series and 30 games (6 LCP, 1 DCup), and all 7 are already flagged.
- **CSV.** 2,945 unique game rows in 1,192 series. Line endings are LF only. 42 rows have Liquipedia columns.
- **`initial-verification.json`.** It matches lines 1598-1604 of `verify-output.txt` (1,236 tests, 1,208 passed, 7 failed, 21 skipped). `tsc -b` and `eslint` ran before the tests in the same `&&` chain, so the "passed typecheck and lint" claim is supported.
- **Parity script and `final-focused.sh`.** The relative imports resolve to the repo root. The baseline `.gitignore` has `node_modules` with no slash, so a symlinked dependency folder keeps the porcelain check clean.

## Remaining limits
- No focused, player-parity, full verify, or bundle check has run on the current head. All of them wait for a host allocation.
- 30 games still have no second provider.
- The Team Secret and Secret Whales identity is unresolved.
- Production attribution is limited to the public provider and game ID.
- The ID schema migration is deferred.

## Open decisions
- **Max:** accept, or require fixes for, warnings 1 and 2. The next step is one small comparator fix round, then a re-review of only that diff.
- **Maintainer:** owns the Team Secret identity conflict.
- No merge was attempted or is authorized.

Dispatch ledger: in-thread. This was a single read-only review and nothing was delegated.
