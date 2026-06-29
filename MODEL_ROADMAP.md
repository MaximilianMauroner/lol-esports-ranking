# Model Roadmap

## Ranking Target

The ranking target is context-neutral latent current strength. Standings estimate how strong a team is against a representative field under average draft, side, matchup, patch, and current-roster conditions. Source-row walk-forward predictions remain a forecast and validation layer; they use known side context when the source supplies it.

```text
How strong is this team right now against a representative field, under average draft, side, matchup, and current-roster conditions?
```

This is not a trophy table, fame score, or retrospective achievement list. Every public ranking claim should identify the data source, model version, model config hash, coverage window, and whether the input includes seeded/demo data.

## Layer Shape

The mature score should be built as:

```text
GlobalPower =
LeagueAnchor
+ TeamStableOffset
+ RosterPriorOffset
+ Momentum
+ Context adjustments
+/- Uncertainty
```

Current implementation status:

- `transparent-gpr-v0.0.0` is the canonical public model version for every pre-1.0 artifact. Exact experimental lineage is identified by `model.configHash`, active parameters, schema version, and committed source/data provenance rather than by incrementing `v0.x` model numbers.
- The active pre-1.0 model retargets the public score as a context-neutral latent team-strength estimate and applies team/league strength movement atomically at resolved series level. Match outcomes are treated as evidence, not the ranking target itself. The active implementation allocates each result residual into durable `TeamStableOffset` and fast-decaying `Momentum`/form shares, exposes that allocation in the public rating-update ledger, keeps sourced player ratings as the active player layer, and publishes first-class region history from league-strength history. Draft, style-counter, lineup-synergy, and richer player/lineup propagation remain follow-up layers until source coverage and walk-forward validation can support them.
- Player ratings are sourced post-game outputs from Oracle player rows. A prior-only player-rating adjustment is now enabled for published predictions after clearing the walk-forward gate; team-only baseline probabilities remain available in metrics for auditability.
- Award/POG residuals are source-blocked in the current local pipeline: Oracle CSVs and Leaguepedia ScoreboardGames do not provide dated human MVP/POG/All-Pro signals, so `AwardResidualZ` remains unapplied rather than inferred from visible stats.
- Execution residuals are modeled only in a parallel shadow ledger until a walk-forward gate proves they improve forward prediction. Post-game kills, gold, and objectives update that shadow ledger after the date's predictions are emitted; they do not leak into their own pre-game prediction.

## Seasonal Anchoring and Rebuild Priors

At every season boundary, create league-level anchors from prior international evidence, regressed toward league priors/global mean by the league carryover policy. Initialize each team from its league anchor plus a value-weighted stable team offset, roster/player prior, momentum reset, context adjustment, and uncertainty band. A rebuilt team inherits its league baseline, not its org's full historical team rating. Returning-player continuity, player ratings, coach/org priors when sourced, patch retention, and uncertainty determine how much of the old team offset survives.

Momentum is reset or heavily decayed at season start and then rebuilt through the split as a capped, fast-decaying form layer. International games update both team offsets and league ratings when leagues differ. Completed international tournaments add a residual league-strength update based on actual stage advancement versus pre-event expectation, so regions with multiple deep runs receive meaningful credit without double-counting same-region finals.

Acceptance checks:

1. Full roster rebuild starts closer to the league anchor than a stable roster with the same prior results.
2. Stable rosters retain more old team offset than rebuilt rosters.
3. Domestic same-league games move team offsets but not league strength.
4. Cross-league international games move both team offset and league strength.
5. Two same-region Worlds finalists can increase their league through placement residual.
6. The same-region final game itself does not directly move league game Elo.
7. New or rebuilt teams carry higher uncertainty and therefore larger early K multipliers.
8. Momentum moves fast, decays, and is capped.
9. Public snapshots expose component totals and latest update ledger fields.
10. Walk-forward validation must justify each published predictive layer.

## Pre-1.0 Change Policy

The package is currently pre-1.0, so breaking changes are allowed and encouraged when they improve the system. Do not preserve a weak snapshot schema, model API, data shape, or UI contract just for compatibility.

Use breaking changes for:

- More accurate predictive modeling.
- Fairer league, region, player, or roster treatment.
- Stronger provenance and anti-leakage guarantees.
- Cleaner source ingestion and model calibration.
- Simpler long-term architecture.

When making a breaking pre-1.0 model change, keep the model version at `transparent-gpr-v0.0.0`, rely on `model.configHash` for exact model-parameter provenance, bump schema versions when the public artifact shape changes, regenerate affected snapshots, update docs/tests, and state the migration impact.

## Player Importance

Player importance must be dynamic, not role-fixed. Role weights are priors only:

```text
Top:     0.18
Jungle:  0.22
Mid:     0.22
Bot:     0.20
Support: 0.18
```

Each starter gets an impact multiplier:

```text
ImpactMultiplier =
clamp(
  0.70,
  1.45,
  1
  + 0.12 * ObjectiveImpactZ
  + 0.06 * AwardResidualZ
  + 0.04 * RecentFormZ
)
```

Then:

```text
RawPlayerShare =
BaseRoleShare
* ImpactMultiplier
* Availability
* RoleCertainty

PlayerShare = RawPlayerShare / sum(team raw shares)
```

This lets an elite support represent more roster value than an average mid laner when objective control, vision, engage timing, opponent-adjusted impact, and residual human-signal features support that conclusion.

## Human Signals

MVP, POG, POTM, All-Pro, and role awards are useful but noisy. They should be stored as features, not treated as truth.

Use residualized award signal:

```text
AwardResidual =
HumanSignal
- ExpectedHumanSignal(role, visible stats, team win rate, team rank)
```

That asks whether voters rated a player above what ordinary visible stats and team success already explain.

Current status: no configured local source provides dated human MVP/POG/POTM/All-Pro records. These fields must stay absent and `AwardResidualZ` must remain `0` for sourced public data until a provenanced award importer is added. Do not synthesize human signals from Oracle GPR, KDA, damage, or team success.

## Roster Moves

Roster continuity should be value-weighted:

```text
Continuity = sum(PlayerShare for returning players)
```

Not:

```text
returning_players / 5
```

If a high-impact support accounts for 24% of team value, losing that support should hurt more than losing a 16% weak-side top. Roster changes should also widen uncertainty until new evidence arrives.

Current pre-1.0 standings expose whether each team has a complete latest Oracle game roster (`sourced`), partial roster evidence (`assumed-continuous`), or no roster evidence (`unknown`). The model compares the current complete lineup against the prior complete lineup using role-value weights; lower continuity regresses only the stable team offset toward the league anchor and raises uncertainty before prediction. A rebuilt team therefore keeps the league baseline but does not inherit the old org roster's full peak rating. Player standings are rated from sourced Oracle player-game stats after each game. Prior player ratings, momentum, and known side context also produce pre-game adjustments for published walk-forward predictions; the metrics retain neutral team-only and player-adjusted deltas for auditability.

Migration impact from `v0.11.0` to `v0.12.0`: league Elo and region summaries now use the participating teams' pregame power when scoring international cross-league games. A league receives more credit for a win against a high-rated representative and less credit for an expected win against a lower-rated representative. Public snapshot schema `5` adds `expectedWins`, `winsOverExpected`, `opponentAdjustedWinRate`, and `averageOpponentRating` to league rows.

Migration impact from `v0.15.0` to `v0.16.0`: public snapshot schema `6` adds walk-forward baseline comparisons for coin-flip, pre-game win-rate, and team-only predictors. The published GPR metrics can now be audited against a no-skill baseline and a domestic-record-style baseline using only pre-game state.

Migration impact from `v0.16.0` to `v0.17.0`: public snapshot schema `7` extends each walk-forward baseline comparison with segment-level accuracy, Brier, log-loss, and published-vs-baseline deltas. This makes international, cross-region, side-known, patch-transition, roster-change, Bo1, and Bo3/Bo5 contexts auditable instead of relying only on aggregate validation metrics.

Migration impact after `v0.17.0`: public snapshot schema `8` adds compact latest-observation provenance to sourced-player proof rows and the player directory: source game id, source URL when present, source file, latest observed date, and latest observed event. Ratings are unchanged, but player/team/role mapping claims are easier to audit against Oracle rows.

Migration impact from `v0.17.0` to `v0.18.0`: source pipeline `canonical-identity-stat-dedupe-v4` maps additional EMEA and LATAM secondary-league abbreviations to their competitive regions, including EBL, HLL, LPLOL, LES, LIT, RL, NEXO, CCWS, HC, IC, LRN, LRS, and LTS. Public snapshot schema `9` adds `dataQuality` counts for source providers, data completeness, missing patch/side/source ids, roster coverage, and unresolved identity summaries.

Migration impact from `v0.18.0` to `v0.19.0`: source pipeline `canonical-identity-stat-dedupe-v5` treats FST, EWC, Asia Masters, KeSPA, and Demacia Cup style events as competition-only international events when deriving home leagues and event K. Public snapshot schema `10` changes `snapshot.regions` from region-name strings to full flagship-region strength rows, with `teamCount`/`leagueCount` for the scored flagship layer and `ecosystemTeamCount`/`ecosystemLeagueCount` for the broader mapped ecosystem.

Migration impact from `v0.19.0` to `v0.20.0`: source pipeline `canonical-identity-stat-dedupe-v6` derives team profiles from all match-side home-league observations instead of depending on source-file overwrite order, keeps known/manual identities authoritative, and treats EMEA Masters/`EM` as a competition-only ecosystem event for home-league derivation. Event taxonomy now recognizes `WLD`/`WLDs` as Worlds-tier, classifies EWC online qualifiers and academic/university world events as `qualifier`, and treats Demacia Cup/`DCup` as an LPL regional cup rather than an international league-strength event. ERLs, NACL, EMEA Masters, and similar lower-tier ecosystem leagues are now `emerging`; they remain visible in ecosystem views but stay `unanchored-league` on the eligible global board even when they have many cross-ecosystem matches. Schema remains `10`.

Migration impact from `v0.20.0` to `v0.21.0`: published walk-forward match probabilities now apply the existing prior-only blue/red side adjustment when the source row has known side assignments. Same-day prediction batching is unchanged, so side results from games on the predicted date cannot affect each other. Neutral team-only, player-adjusted, execution-baseline, and execution-adjusted variants remain available as comparison baselines. Source pipeline `canonical-identity-stat-dedupe-v7` also derives team profiles from the latest explicit non-competition home-league observation, ignores later `Unknown` placeholders and generic `LTA` championship rows for home-league derivation, uses the same derived profile path in scheduled recalculation, preserves Leaguepedia `LFL2` separately from `LFL`, maps `LFL2`, `PRMP`, `NL`, and `CT` as LEC ecosystem leagues, and flags unknown league tiers in the data-quality audit. Public snapshot schema `11` renames the walk-forward target from `neutral-game` to `published-game` and full prediction rows expose `teamASide`, `teamBSide`, `teamASideAdjustment`, and `teamBSideAdjustment`.

Migration impact from `v0.21.0` to `v0.22.0`: source pipeline `canonical-identity-stat-dedupe-v8` treats First Stand/FST as an MSI-level international bracket event instead of a minor international cup. This gives recent First Stand cross-region games the same team and league-strength K as MSI bracket games while keeping FST as a competition-only league for home-league derivation. Public snapshot schema remains `11`.

Migration impact from `v0.22.0` to `v0.23.0`: team power now uses `team rating + (league rating - 1500) * league weight` instead of a convex team/league blend. This preserves same-league team-rating gaps while still applying regional strength as an auditable offset. Public snapshot schema and source pipeline stay unchanged.

Migration impact from `v0.23.0` to `v0.24.0`: source pipeline `canonical-identity-stat-dedupe-v9` keeps Oracle as the stat/roster source for duplicate games but enriches retained Oracle rows with Leaguepedia qualifier event metadata when Leaguepedia identifies the duplicate as an online qualifier. This prevents EWC online qualifiers from being scored as minor international league-strength events. Public snapshot schema remains `11`.

Migration impact from `v0.24.0` to `v0.25.0`: team power is now a seasonal hierarchy: `LeagueAnchor + TeamStableOffset + RosterPriorOffset + Momentum + ContextAdjustment`, with uncertainty published beside the score. Team result updates move the stable offset; roster rebuilds scale the old offset and widen uncertainty; momentum is a capped fast-decaying form layer; international cross-league games still update league strength; completed international events add a capped placement residual from actual stage points versus pre-event expected stage points. Same-region international games, including same-region Worlds finals, do not directly update league game Elo; those leagues receive credit through the prior cross-region path and placement residual. Public snapshot schema `12` adds `ratingComponents` and `ratingUpdate` to standing and full history rows.

Migration impact from `v0.26.0` to `v0.27.0`: season snapshot shards now publish the chronological model state through the selected season instead of filtering the current global standings. Event and region shards still preserve the global rating scale. Public schema remains `13`, but older season rankings are not comparable to regenerated v0.27 season shards because the top-level standings, ranks, records, league summaries, and region summaries now come from the selected season's model state.

Migration impact from `v0.27.0` to `v0.28.0`: sourced player ratings now shrink each player's same-role domestic edge by home-league tier before publishing a global player score or using that edge in pre-game player adjustments. Tier-one leagues publish the full player edge, tier-two nearly full, tier-three partial, and emerging/unknown leagues are strongly regressed toward their league baseline. This keeps ERL/academy/minor domestic dominance from crowding the global top-player board while preserving the underlying same-role stat signal for local comparison and future calibration. Public schema remains `13`, but player ranks are not comparable to v0.27.

Migration impact from `v0.28.0` to `v0.29.0`: the public player directory now includes season-scoped player rows for year-wide snapshots, and the browser switches player lists when the year filter changes instead of always showing the global all-time/current player board. Public schema remains `13`; regenerated `players.json` is required.

Migration impact from `v0.29.0` to `v0.30.0`: ranked public player rows now require `minimumRankedSourcedPlayerGames = 20`, so substitute/reserve and other thin samples remain in the full artifact and rating-proof audit trail but do not occupy global top-player leaderboard slots. Source pipeline `canonical-identity-stat-dedupe-v10` also preserves Team Secret Whales as a distinct identity from Team Secret, and scoped season standings display the home league observed inside that season rather than leaking the team's latest profile. Public schema remains `13`, but player ranks, team identities, and scoped year labels are not comparable to v0.29.

Migration impact from `v0.30.0` to `v0.31.0`: season snapshots now rebuild standings with team profiles derived from the selected season's match-side home-league observations, so a team that was NLC in 2025 and LEC in 2026 is ranked, anchored, and eligibility-gated against the correct season league instead of inheriting its latest/global profile. Academy, challenger, and youth teams are also treated as developmental rows for eligibility even when their parent league is tier-three or higher. Public schema remains `13`, but season standings, team ranks, league anchors, and eligibility are not comparable to v0.30.

Migration impact from `v0.31.0` to `v0.32.0`: emerging and unknown leagues now apply a published effective-rating cap before team anchors, player baselines, and league summaries are serialized. Emerging leagues such as LFL, PRM, NLC, NACL, and academy ecosystems can still move below the cap and can keep local performance signal, but they cannot publish a league anchor above the tier-three first-division minor prior unless their tier mapping is explicitly promoted. Ranked public player-directory rows also exclude players whose team standing is `unanchored-league`; those sourced rows remain available in the full local artifact for audit. Public schema remains `13`, but lower-tier team and player ratings are not comparable to v0.31.

Migration impact from `v0.32.0` to `v0.33.0`: season-scoped public player rows are rebuilt from the active season's appearances, credited to the player's primary team in that scope, and gated by both role games and displayed-team games. Multi-team players still keep appearance provenance, but narrow transfer fragments and substitute/reserve samples no longer publish as top-board player claims. Event scopes without a scoped public player population no longer fall back to the global player list. Public schema remains `13`, but player ranks and player/team labels are not comparable to v0.32.

Migration impact from `v0.33.0` to `v0.34.0`: team eligibility is recomputed after applying season, event, or region filters instead of carrying the all-time/global eligibility object into scoped shards. The default eligibility config now requires 30 total scoped games in addition to current-volume, staleness, uncertainty, and league-anchor checks. The public team table defaults to ranked rows, while provisional low-volume or unanchored rows remain available in audit mode with explicit reasons. Public schema remains `13`, but scoped team ranks and eligibility are not comparable to v0.33.

Migration impact from `v0.38.0` to `v0.39.0`: the public ranking target is now documented and serialized as context-neutral latent team strength rather than direct match-winner prediction. Team result residuals are allocated into durable stable-strength and fast-decaying form shares instead of all durable team movement, and compact browser `ratingUpdate` rows expose `resultEvidence`, `neutralResultResidual`, `seriesStrengthSignal`, `teamStableShare`, `teamFormShare`, and eligible `leagueSignalShare`. Full derived audit snapshots also keep inactive player/lineup/direct-region shadow shares. Public schema `15` is not comparable to v0.38 because team stable offsets are intentionally less reactive while form absorbs more short-term evidence.

Migration impact from `v0.39.0` to `v0.40.0`: team stable/form and league game-strength updates now use the resolved series as the canonical update unit. Pregame predictions and execution-residual evidence still run per source game row, but non-final series rows publish `series-member-no-team-update` ledgers with zero team/league movement and the final row publishes the full `series-atomic` residual. Public schema remains `15`, but rating movement is not comparable to v0.39 because Bo3/Bo5 rows are no longer counted as multiple damped rating events.

## Validation Order

Build and validate layers in this order:

1. Clean game-level team plus league Elo.
2. Uncertainty bands.
3. Roster continuity.
4. Role-conditioned player ratings.
5. Dynamic player-share weighting.
6. Award / POG residuals.
7. Execution residuals.
8. Patch, side, and context adjustments.
9. Walk-forward backtesting and calibration.
10. Public output with component explanations.

Backtest with walk-forward prediction only. Random train/test splits leak future information. Evaluate log loss, Brier score, calibration, international games, Bo1 versus Bo3/Bo5, patch transitions, roster changes, region-crossing matches, and support/player-transfer impact.

## Anti-Leakage Rules

Pre-game predictions may use only information available before the game:

- Past results and player stats.
- Known roster, substitutions, patch, side, event, stage, and format.
- Past region strength and past award signals.

They must not use:

- Final stats from the predicted game.
- POG/MVP from the predicted game.
- Game duration or post-game execution stats from the predicted game.
- Future roster moves, awards, or patch results.

Post-game rating updates may use post-game information, but prediction inputs must stay clean.
