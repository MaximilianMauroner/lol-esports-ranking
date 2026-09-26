# Player performance statistics review

Reviewed 2026-09-26 against commit `7856d386`, model `transparent-power-index-v0.2.0`, baseline config `fnv1a-169aeb58`. Video: [Andrew DiStefano, Invictus Gaming preview](https://youtu.be/hPchrdjnshs). The transcript discusses player metrics from 3:02 and team metrics from 12:19. Its ROI, vision-efficiency, and early/late-game formulas are not established by the narration.

An independent agent reviewed the formulas, existing score, importer, and local Oracle CSV coverage before implementation. It approved descriptive statistics with explicit coverage, and rejected immediate changes to live scoring. A larger metric value does not necessarily indicate a better player.

## Implemented

| Metric | Definition | Use and limits |
| --- | --- | --- |
| Kill participation | Per-game `(kills + assists) / teamkills` | Involvement; team kills must be positive and all three source cells present. Invalid ratios above 1 are unavailable. |
| Damage–gold share gap | Per-game damage share minus earned gold share | Resource/output context, shown in percentage points. Both shares must come from the same game. Not champion-adjusted efficiency or ROI. |
| Gold, XP, CS differences at 15 | Source `golddiffat15`, `xpdiffat15`, `csdiffat15` | Early advantage, including teammate assistance. Negative values and zero are meaningful. Reject values from games known to end before 15 minutes. |
| Champion damage/min and CS/min | Source `dpm`, `cspm` | Damage/farm context, strongly affected by champions, role, and game state. |
| Wards placed/cleared per minute | Source `wpm`, `wcpm` | Vision activity, not ward quality or vision efficiency. |

All summaries are arithmetic means of valid per-game observations, with observed and unavailable game counts per metric. KP is therefore not the ratio of pooled kills/assists to pooled team kills. Damage–gold gap is not a subtraction of separately averaged shares. Missing, malformed, nonfinite, and impossible observations remain unavailable. No imputation or league-wide bonus is applied.

Public summaries use the existing rated complete-role-matchup sample. They are available in default and season/checkpoint player scopes and may span multiple teams and roles. They are not current-lineup-only statistics. The team detail view exposes the player selector, source, sample scope, metric coverage, and descriptive limitations. No new statistics enter player ratings, the retrospective individual residual, team/league ratings, or match predictions.

## Source coverage

The local inputs were the existing 2025 and 2026 Oracle CSVs referenced by `data/raw/manifest.json`; these are third-party sourced data, not an official Riot ranking and not a September refresh. The independent raw-row check found 4,530 LPL player rows in the 2026 file, all missing the three at-15 fields. The implemented audit also validates values and applies the repository's importer taxonomy:

| Normalized 2026 league | Player observations | Valid KP | Each at-15 difference |
| --- | ---: | ---: | ---: |
| LPL | 4,530 | 4,530 | 0 |
| LCK | 3,490 | 3,470 | 3,490 |
| LEC | 2,460 | 2,450 | 2,460 |
| LCS | 1,570 | 1,570 | 1,570 |
| LCP | 2,210 | 2,200 | 2,210 |
| CBLOL | 1,730 | 1,730 | 1,730 |

The share gap and four per-minute metrics are available in all these observations. KP source presence is not equivalent to valid coverage: zero team kills give an undefined ratio. Normalized league groups can differ from raw league labels. Audit counts precede ranking eligibility, whereas UI counts use rated complete-role matchups.

Reproduce a report with file hashes, model/config, importer policy, and per-league/year coverage:

```sh
pnpm performance:audit data/raw/oracles-elixir/2025_LoL_esports_match_data_from_OraclesElixir.csv data/raw/oracles-elixir/2026_LoL_esports_match_data_from_OraclesElixir.csv
```

Overlapping game IDs are rejected rather than counted twice. The report counts normalized roster rows, not CSV headers or every raw row discarded by normalization.

## Other candidates and decisions

| Candidate | Decision |
| --- | --- |
| Resource-adjusted damage residual | Best next scoring experiment. Replace the existing damage/gold contribution rather than adding overlapping weights. Fit expected damage using prior games, role, champion, gold share, patch, duration, side, and opponent strength; shrink sparse groups toward role baselines. |
| Current-lineup performance and games together | Useful next descriptive addition. Use exact five-player identities and clearly separate latest-observed lineup from confirmed starters. Existing roster-continuity adjustments already affect the model. |
| Champion pool and pick concentration | Useful profile/draft context; no direct diversity bonus. Raw pool size and unique champions per game are sample-size dependent. |
| Lead conversion and objective control above expectation | Defer scoring until game-state expectations are fitted and tested. Ordinary win rate while ahead and objective totals duplicate result/strength signals. |
| Solo kills | Defer; local CSVs do not supply the required field. |
| International record | Already represented by opponent/event-adjusted evidence. A separate lifetime bonus would count the same results again. |
| Consistency | Potential uncertainty diagnostic; do not automatically penalize high-variance styles. |
| Domestic kill rates, farm, and objective totals as league-strength inputs | Reject direct use. They confound style and internal parity with cross-league strength. Keep international opponent-adjusted results as the anchor. |

Any future scoring experiment must train only on information available before each prediction, keep complete series or same-date batches out of their own training history, and compare chronological Brier score, log loss, and calibration against the existing model. Check individual leagues, international games, patches, roster changes, and unequal source coverage, using series-level uncertainty estimates. The current retrospective individual-residual control builder reads the supplied dataset and must not be reused as a pregame training baseline.

## Migration and validation

Public schema 24 adds optional versioned performance summaries (`observed-player-performance-v1`). Importer v15 and the diagnostic policy are included in the model config hash; the canonical model version stays unchanged. Regenerate browser artifacts together because the public reader enforces schema version. Existing player rows without the optional summaries show an unavailable state. No deployment or external publication is part of this change.

The regenerated local snapshot uses config `fnv1a-ffed541b` and scored coverage through 2026-07-26 (4,519 matches). Its lazy-loaded player directory is 1,679,291 bytes raw / 155,804 bytes gzip; the explicit raw budget is now 1.8 MB to accommodate the nine typed metrics across scopes. Total browser artifacts are 26,774,720 bytes, within the existing 30 MB budget. Source updates beyond the previous committed snapshot's July 16 cutoff can change displayed records independently of these diagnostic additions.

Tests cover signed/zero/missing values, invalid ratios, paired coverage, short games, aggregation, serialization, scoped summaries, and unchanged player/team/league scores and predictions when only the additional statistics change. The coverage CLI runs on local Oracle files, and browser verification checks populated and unavailable metrics.

Validation completed: 686 tests passed, typecheck/lint passed, and the production build passed its bundle budget (385 KB / 900 KB main JavaScript). The shared browser could not route to the local dev server, so browser verification used an isolated production bundle of the actual component and generated player rows. Desktop and 390px mobile checks covered populated stats, partial coverage, selection changes, an absent-summary test fixture, and horizontal overflow. This verifies the component; full app navigation through the shared browser remains unverified.

The three-run incremental gate passed artifact parity in every run, with one replayed match and three materialized scopes. It **failed performance budgets**: median compute 20,756 ms (target <15,000), maximum compute 22,764 ms, and maximum sampled production RSS 806,690,816 bytes (safety target <734,003,200). Maximum uploaded bytes were 2,048,773, below the existing 2,097,152-byte limit. No limits were relaxed for this gate. This is a remaining release limitation, separate from formula correctness and score invariance.

A one-run pre-change comparison used commit `7856d386` in an isolated checkout, with the same regenerated 4,519-match / 102-team / 356-player corpus adapted back to schema 23 and without the additional player summaries. It also failed the budgets: compute 18,440 ms and peak RSS 738,275,328 bytes, with artifact parity true and 2,022,425 uploaded bytes. This establishes that the existing budgets also fail without the feature on this corpus/host; one baseline run does not establish performance non-regression. The candidate's larger peaks remain a release concern. Local reports are retained under `.agent/artifacts/player-performance/`.
