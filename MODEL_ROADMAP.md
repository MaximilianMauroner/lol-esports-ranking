# Model Roadmap

## Ranking Target

The ranking target is predictive current strength:

```text
Who is most likely to beat whom on the current patch, with current rosters, on neutral conditions?
```

This is not a trophy table, fame score, or retrospective achievement list. Every public ranking claim should identify the data source, model version, model config hash, coverage window, and whether the input includes seeded/demo data.

## Layer Shape

The mature score should be built as:

```text
GlobalPower =
Team result strength
+ League / region strength
+ Roster / player strength
+ Recent form
+ In-game execution
+ Context adjustments
+/- Uncertainty
```

Current implementation status:

- `transparent-gpr-v0.4.0` has the team-result Elo spine, event K values, best-of damping, recency decay, cross-league league strength, side adjustment support, patch/split/season retention, uncertainty bands, source provenance, and a dynamic player-share scaffold.
- Player/roster outputs are still demo-grade until sourced player-game stats, roster timelines, substitutions, and award data are imported.
- Execution features are imported or typed, but team Elo remains result-only until a backtest proves that execution residuals improve forward prediction.

## Pre-1.0 Change Policy

The package is currently pre-1.0, so breaking changes are allowed and encouraged when they improve the system. Do not preserve a weak snapshot schema, model API, data shape, or UI contract just for compatibility.

Use breaking changes for:

- More accurate predictive modeling.
- Fairer league, region, player, or roster treatment.
- Stronger provenance and anti-leakage guarantees.
- Cleaner source ingestion and model calibration.
- Simpler long-term architecture.

When making a breaking change, bump the model version or schema version as appropriate, regenerate affected snapshots, update docs/tests, and state the migration impact.

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
