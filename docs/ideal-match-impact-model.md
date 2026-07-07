# Ideal Match Impact Model

## Purpose

The ranking target is predictive current strength: who is most likely to beat
whom with current rosters, under known pre-game context. A match result should
therefore update the model in multiple places, but each update should answer a
different question:

- Team strength: did this team become more or less likely to beat future teams?
- Player strength: which players gained or lost evidence of individual value?
- Lineup strength: did this specific five-player unit show synergy or fragility?
- League strength: did this cross-league result change what we believe about the
  competitive baseline of each league?
- Region strength: did league-level evidence change the region-level aggregate?
- Confidence: did the match reduce or increase uncertainty?

The current model already has the right broad shape: league anchors, stable team
offsets, roster priors, momentum, event K values, series-atomic updates, uncertainty,
cross-league league updates, placement residuals, sourced player ratings, and
anti-leakage rules. The ideal version should make match impact explicit as an
auditable event ledger and split the update into stable, form, player, lineup,
league, region, and confidence channels.

## Core Principle

A result should not be scored as just `winner +K, loser -K`.

Every match should be scored as:

```text
PregameState + MatchContext + ObservedResult -> RatingUpdateEvent
```

The `RatingUpdateEvent` should publish enough information to answer:

```text
Why did Team B gain this many points after beating Team A?
How much was from opponent strength?
How much was from the event?
How much was from beating a hot team?
How much was from player-level performance?
How much propagated to leagues or regions?
How confident is the model after this match?
```

## Entity Layers

### TeamStableOffset

Longer-lived team strength above or below its league anchor. This should move
from repeated result evidence, high-information upsets, and confirmed roster
quality. It should not overreact to one lucky game.

### TeamForm

Fast-decaying recent form. This is where streaks, recent overperformance, and
streak breaks should mostly live. Form should help current prediction, but it
should decay quickly and stay capped.

### LineupSynergy

Evidence that a specific roster combination performs above or below the sum of
its players. This should be separate from permanent player skill so a player is
not punished too much for joining a weak team, and a team is not given permanent
credit for a lineup that no longer exists.

### PlayerSkill

Role-conditioned player value, ideally split into:

- `TeamResultShare`: the player's allocated share of the team result residual.
- `IndividualResidual`: same-role, opponent-adjusted, context-adjusted player
  performance after controlling for team result.
- `RecentPlayerForm`: fast-decaying individual form.
- `RoleCertainty`: confidence that the player is being evaluated in the right
  role and sample.

### LeagueAnchor

A league-level baseline that moves primarily from international or cross-league
matches and event placement residuals. It should be hierarchical and heavily
shrunk when evidence is sparse.

### RegionStrength

A region-level aggregate derived from league posteriors, not a raw count of
domestic wins. Region rows should publish confidence intervals and should keep
flagship strength separate from lower-tier ecosystem volume.

## Match Impact Pipeline

### 0. Choose the Canonical Update Unit

The rating unit should be a series when the source can identify one, and a game
only when the match is truly Bo1 or the source cannot safely group rows.

For a Bo3 or Bo5, compute the expectation from the pre-series state and score
the observed result as:

```text
SeriesOutcomeA = GamesWonA / GamesPlayed
SeriesResidualA = SeriesOutcomeA - ExpectedSeriesOutcomeA
```

A 3-0 should therefore carry more signal than a 3-2, but the five games should
not be treated as five fully independent rating updates. If the model processes
source rows game-by-game, it should still group them into an atomic
`RatingUpdateEvent` where possible. This avoids within-series artifacts where
Game 1 changes the expectation for Game 2 even though the useful pre-series
claim was "who is favored in this series?"

### 1. Freeze Pregame State

Before any match on a date updates the model, freeze all information available
before that match or date batch:

- team stable offsets
- team form
- league anchors
- region aggregates
- player ratings
- roster continuity
- lineup availability
- side assignment if known
- patch if known
- event, stage, best-of format, and tournament weight
- recent streak and form state, computed only from past matches
- uncertainty for teams, players, leagues, and regions
- source quality and missing-data flags

This freeze is mandatory. Streaks, player stats, game duration, side outcome,
and post-game execution from the match being predicted must not enter the
pregame expectation.

### 2. Compute Pregame Expectation

Each side gets a pregame power:

```text
PregamePower =
  LeagueAnchor
  + TeamStableOffset
  + RosterPriorOffset
  + TeamForm
  + LineupSynergy
  + PlayerPriorAdjustment
  + ContextAdjustment
```

Then:

```text
ExpectedWinA = sigmoid((PregamePowerA - PregamePowerB) / Scale)
ExpectedWinB = 1 - ExpectedWinA
```

The result residual is:

```text
ResultResidualWinner = 1 - ExpectedWinWinner
ResultResidualLoser = 0 - ExpectedWinLoser
```

An upset is not a special case in the formula. It naturally has a larger
residual because the winner had a lower expected win probability.

### 2a. Separate Calibrated Elo from Published Ladder Elo

The internal Elo scale and the public rating scale should not be forced to do
the same job. The internal scale exists to produce calibrated win probabilities.
The public scale exists to communicate hierarchy. Right now the published range
is too narrow: elite teams can look only modestly separated from the field even
when the model has enough evidence that they belong in a top-ladder tier.

Add an explicit published rating transform:

```text
PublishedRating =
  PublishedAnchor
  + (InternalPower - InternalAnchor) * PublishedSpreadMultiplier
```

Initial target:

- `InternalAnchor`: current neutral team power, usually `1500`
- `PublishedAnchor`: `1800`
- `PublishedSpreadMultiplier`: start in the `3.0` to `3.5` range
- `PublishedMinimum`: about `1000`
- `PublishedMaximum`: about `3000`

This should make the public board feel more like a Grandmaster or Challenger
ladder:

- lower-ranked professional teams: roughly `1000` to `1500`
- solid regional professional teams: roughly `1500` to `1900`
- major-region playoff teams: roughly `1900` to `2250`
- international contenders: roughly `2250` to `2550`
- world-title favorites: roughly `2550` to `2850+`

This scale is for the curated professional-team rating universe. Random,
amateur, unresolved, or otherwise out-of-scope teams should be excluded before
the published transform is applied instead of forcing the scale to accommodate
them.

The transform must be monotonic, versioned in model parameters, and applied
consistently to team ratings, league anchors, rating components, history points,
movement deltas, uncertainty bands, comparison tables, and exported public
artifacts. Receipts should expose both the published rating and enough model
metadata to trace the internal calibrated rating that produced it.

Do not widen the public range by blindly increasing K values. If the actual
internal Elo unit is rescaled, the expected-score denominator, K factors,
uncertainty values, regression constants, caps, league-anchor adjustments, and
historical comparisons must all be rescaled together and pass walk-forward
calibration. The safer default is to keep calibrated internal Elo stable and add
a documented published ladder scale.

### 3. Build Match Quality Multipliers

The raw residual should be multiplied by auditable factors:

```text
UpdateWeight =
  EventWeight
  * SeriesWeight
  * OpponentQualityWeight
  * SurpriseWeight
  * StreakContextWeight
  * RosterReliabilityWeight
  * SourceQualityWeight
  * UncertaintyWeight
```

Each multiplier should be capped and serializable.

`EventWeight` should preserve the current intent: Worlds/MSI knockouts matter
more than regional playoffs, which matter more than regular season games.

`SeriesWeight` should count a Bo5 as more informative than a Bo1 without
counting five games as five independent full matches. The existing
`EventK / sqrt(bestOf)` direction is good.

`OpponentQualityWeight` should reward beating strong teams more than beating weak
teams, but it should not double-count the Elo residual. This multiplier should be
small and capped, or used only in explanation.

`SurpriseWeight` should be based on pregame probability. A 20 percent underdog
winning carries more information than a 70 percent favorite winning.

`RosterReliabilityWeight` should reduce permanent stable movement when lineups
are incomplete, when a team used substitutes, or when roster identity is
uncertain. It can increase uncertainty instead.

`SourceQualityWeight` should shrink updates when side, roster, league identity,
or source dedupe quality is poor.

`UncertaintyWeight` should let uncertain teams and leagues move more early, while
protecting established ratings from high volatility.

### 4. Allocate One Residual Budget

The match should create one core result residual, then allocate that evidence
budget across model layers:

```text
Evidence =
  ResultResidual
  * UpdateWeight

TeamStableDelta =
  StableShare * Evidence

TeamFormDelta =
  FormShare * Evidence + FormOnlyContextResidual

PlayerResultBudget =
  PlayerShareOfTeamResult * Evidence

LeagueDelta =
  LeagueShare * Evidence
```

This prevents double counting. A win should not independently create a full team
update, a full player update, and a full league update from the same surprise.
Those layers should explain where the same surprise should live.

## Streak and Form Modeling

### Do Not Reward Raw Streak Length Directly

A win streak is not automatically strong evidence. Ten wins against weak
opponents may mean less than three wins against elite opponents. The streak
feature should be schedule-adjusted:

```text
RecentFormResidual =
  EWMA(ActualWin - ExpectedWin)
  weighted by event tier, opponent quality, and recency
```

The streak value should be:

```text
StreakValue =
  log1p(ConsecutiveWins)
  * AveragePositiveResidualDuringStreak
  * AverageOpponentQualityDuringStreak
  * EventTierWeight
```

Then cap it:

```text
StreakValue = clamp(0, StreakCap, StreakValue)
```

### Breaking a Win Streak

If Team A is on a real win streak and Team B beats Team A, Team B should receive
extra current-form credit, because Team B has shown it can stop a team that was
overperforming expectations.

The update should be split:

```text
StableDeltaB =
  BaseStableDeltaB
  + SmallValidatedStableStreakShare * StreakBreakValue

FormDeltaB =
  BaseFormDeltaB
  + LargeFormStreakShare * StreakBreakValue

FormDeltaA =
  BaseFormDeltaA
  - StreakBreakDecay * StreakValueA
```

Most of the streak-break impact should go to form, not stable strength. The
stable bonus should be small or disabled until walk-forward validation proves it
improves prediction.

### When a Streak Break Should Matter More

Breaking a streak should matter more when:

- the streaking opponent had repeatedly beaten strong teams
- the streaking opponent was outperforming pregame expectations, not just
  farming weak opponents
- the match was on a major stage
- the winner was an underdog
- the winner won cleanly across a series
- the winner had a stable or known roster

### When a Streak Break Should Matter Less

Breaking a streak should matter less when:

- the streak was built mostly against weak teams
- the streaking team had lineup disruption
- the winner was already a heavy favorite
- the win was a single Bo1 with high side or patch uncertainty
- the source lacks roster, side, or event metadata
- the match was same-day after other unprocessed games that could create leakage

### Both Teams on Streaks

When both teams are hot, the game is high-information only if both streaks are
quality-adjusted. The winner should gain form credit for sustaining form against
a strong-form opponent. The loser should lose some form, but a close loss to an
elite opponent should not erase a validated streak.

```text
MutualStreakSignal =
  min(StreakValueA, StreakValueB)
  * EventWeight
  * SeriesConfidence
```

Apply this mostly to form and confidence. Stable strength should move through the
normal expected-result residual unless validation shows a durable effect.

## Outcome Matrix

### Favorite Beats Underdog Cleanly

Impact:

- small stable gain for favorite
- small stable loss for underdog
- possible form gain if the win was better than expected
- little or no league movement unless cross-league and representative quality is
  meaningful
- player gains mostly for players who beat same-role expectations

Reasoning: the result was expected, so it confirms rather than reveals.

### Favorite Beats Underdog Narrowly

Impact:

- favorite may gain little stable strength or even lose execution/form signal
- underdog may gain form or confidence if the model tracks margin/execution
- player residuals can reward underdog players who outperformed role
  expectations
- league movement should be minimal unless the underdog league was much weaker
  and the close result is validated as predictive

Reasoning: match result and match quality can disagree. The result channel says
the favorite won; the execution channel says the favorite underperformed.

### Underdog Beats Favorite

Impact:

- larger stable gain for underdog
- larger stable loss for favorite
- larger form gain for underdog
- confidence changes for both teams
- player result credit should be substantial, but not equal for all five players
- cross-league result should update league anchors if leagues differ and the
  event is valid for league strength

Reasoning: the result contradicted the pregame expectation.

### Underdog Beats Favorite on a Win Streak

Impact:

- all underdog-upset effects
- extra form gain for the winner from `StreakBreakValue`
- form reset or decay for the loser
- small stable bonus only if validated
- larger league signal if the match is cross-league and the streak came from
  high-quality opposition

Reasoning: this is both an upset and evidence against the loser form layer.

### Favorite Breaks Underdog Win Streak

Impact:

- small stable gain from expected result
- moderate form gain if the underdog streak was high quality
- underdog form decays
- little league signal unless cross-league and the underdog league was
  previously outperforming

Reasoning: the favorite did its job, but stopping a legitimately hot underdog is
still useful current-form evidence.

### Winner Extends Own Streak

Impact:

- form increases if the win beat expectation
- stable strength moves only through normal result residual
- streak quality improves if opponent quality was high
- confidence in form increases

Reasoning: extending a streak should not compound rating blindly. The streak is
evidence only through opponent-adjusted residuals.

### Loser Played Well in a Loss

Impact:

- stable result channel still moves down
- execution residual or player residual can move up
- form loss is reduced if performance was above expectation
- confidence can tighten around a higher estimate if the opponent was elite

Reasoning: LoL match results are binary, but future prediction can improve from
high-quality losses if execution features validate.

### Winner Played Poorly in a Win

Impact:

- stable result channel moves up slightly
- execution/form may move down
- player residuals can punish weak same-role performances
- no major league credit from an ugly expected win

Reasoning: a win matters, but bad underlying play should not be hidden.

### Sweep

Impact:

- more evidence than a close series
- higher confidence movement
- stronger player and lineup signal if games were consistent
- league movement increases only by series-level damping, not by treating every
  game as fully independent

Reasoning: a 3-0 is stronger signal than a 3-2, but the series has shared patch,
matchup, prep, and roster context.

### Close Series

Impact:

- result movement is damped
- loser should lose less than in a sweep
- players can still gain if role-relative performance was strong
- confidence tightens that teams are near each other

Reasoning: a close Bo5 should move teams toward each other less aggressively than
a stomp.

### Reverse Sweep or Comeback

Impact:

- result channel follows the final series result
- form/lineup channel can credit adaptation and resilience only if such features
  are sourced and validated
- avoid adding narrative bonuses unless they improve walk-forward prediction

Reasoning: narratives can be useful, but only as sourced, validated features.

### Substitute or Incomplete Roster

Impact:

- reduce permanent stable movement
- increase lineup and player uncertainty
- allocate player credit only to actual participants
- treat the result as weaker evidence about the normal lineup
- still allow league movement, but shrink it by representative reliability

Reasoning: the match happened, but it may not identify the future strength of the
usual roster.

### New Roster Beats Strong Team

Impact:

- larger uncertainty-driven team gain
- roster prior updates quickly
- player/team result credit should be meaningful
- stable team movement should be capped until more games confirm the level

Reasoning: early evidence is valuable because uncertainty is high, but one match
should not fully define a rebuilt team.

### Same-League Domestic Match

Impact:

- team, player, form, lineup, and uncertainty update
- league anchor does not update
- region strength does not update directly

Reasoning: domestic games sort teams inside the league; they do not prove the
league is globally stronger unless connected to external evidence.

### Cross-League International Match

Impact:

- team, player, form, lineup, and uncertainty update
- league anchors update if the event is eligible for league-strength signal
- region aggregates update through league posterior changes
- representative quality, event tier, series strength, and connectivity should
  determine how much league evidence is transferred

Reasoning: this is the core bridge from team results to league strength.

### Same-Region Cross-League Match

Impact:

- update teams and players
- optionally update an intra-region league hierarchy layer
- do not directly inflate the whole region globally

Reasoning: LEC ecosystem matches can tell us about relative LEC ecosystem
strength without proving LEC gained ground on LCK, LPL, LCS, CBLOL, or LCP.

### Same-Region International Final

Impact:

- update teams and players
- do not double-count the final as direct region-vs-region evidence
- credit the region through bracket path and placement residuals

Reasoning: if two teams from the same region reach a final, the region already
proved strength through earlier cross-region wins and event placement.

### Patch Transition Match

Impact:

- stable movement can be lower if the patch is a known transition
- form and context movement can be higher
- player/champion features should be shadowed until validated
- uncertainty may widen for teams with patch-sensitive profiles

Reasoning: a patch can change the meaning of prior results.

## Player Update Design

### Player Updates Should Be Partly Shared and Partly Individual

The ideal player update should be:

```text
PlayerDelta =
  KPlayer
  * (
      TeamResultShareWeight * TeamResultShare
      + IndividualResidualWeight * IndividualResidual
      + RecentFormWeight * RecentPlayerFormResidual
      + LineupInteractionWeight * LineupSynergyResidual
    )
```

Where:

```text
TeamResultShare =
  ResultResidualTeam
  * PlayerShare
  * Availability
  * RoleCertainty
```

And:

```text
IndividualResidual =
  ObservedPlayerImpact
  - ExpectedPlayerImpact(player, role, champion, opponent, side, patch, team)
```

### Dynamic Player Share

The current roadmap's dynamic share direction is correct. Role priors should be
only priors. A support with elite objective control and engage value should be
able to account for more roster value than an average mid. A bot laner should
not gain the same share in every meta. The share should depend on:

- role prior
- current player rating
- recent form
- availability
- role certainty
- opponent-adjusted objective impact
- champion/meta context when sourced
- team dependency on that role

### Same-Role Comparison Is Necessary but Not Sufficient

Same-role comparison prevents raw box-score inflation, but it should be
augmented with:

- opponent player strength
- opponent team strength
- champion matchup
- side context
- team economy allocation
- game length
- role-specific objectives
- team result control
- sample-size uncertainty

### Avoid Equal Credit for Team Wins

When Team B beats Team A, all five Team B players should not automatically gain
the same amount. A player can:

- hard carry the win and gain more than the team result share
- play adequately and gain only the team result share
- underperform in a win and gain little or lose individual residual
- overperform in a loss and gain individual residual despite the team result
- be a substitute and update only their own sample, not the normal starter's
  rating

### Transfer and Multi-Team Handling

Player ratings should follow the player, but player-team claims should be
scoped:

- global player skill follows canonical player identity
- shown-team player rows require enough games for that team and scope
- transfer fragments should stay auditable but not crowd ranked boards
- a player moving from LCK to a lower league should not immediately make the
  lower league globally elite
- a player farming lower-tier opponents should be shrunk by league and opponent
  quality before affecting global player rank

### Roster Prior Should Be a Lineup Delta

Roster prior should not permanently add absolute player strength on top of a
team rating that already includes prior wins from the same players. It should
represent the current lineup's value relative to the lineup baseline already
baked into `TeamStableOffset`:

```text
RosterPriorOffset =
  shrink(LineupConfidence)
  * (CurrentLineupValue - BakedInLineupBaseline)
```

When the same five-player roster keeps playing together, their wins should move
team stable strength and reduce uncertainty. The roster prior should then shrink
toward zero because the lineup is no longer new information. When a player
transfers, the new team receives a portable player-skill prior, and the old team
loses the portion of lineup value that player represented.

## League Update Design

### Use a Latent Hierarchy

League and region strength should be modeled as a hierarchy:

```text
TeamPower =
  GlobalMean
  + RegionOffset
  + LeagueOffset
  + TeamStableOffset
  + RosterPriorOffset
  + TeamForm
  + ContextAdjustment

LeagueAnchor =
  GlobalMean + RegionOffset + LeagueOffset
```

This structure lets domestic matches sort teams inside a league while
international matches move the league and region layers only when they provide
external evidence.

### League Updates Should Use Team Pregame Power

For cross-league matches:

```text
LeagueResidual =
  ActualWinLeagueA - ExpectedWinFromTeamPregamePowers
```

Do not score league strength as "LCK team beat LEC team, so LCK +flatK." The
quality of the specific representatives matters.

### Representative Quality

A league result should be weighted by how representative the team is:

```text
RepresentativeWeight =
  f(team rating percentile inside league,
    current league standing,
    event seed,
    roster reliability,
    recent form reliability,
    team uncertainty)
```

Examples:

- A league champion beating another league champion is strong league evidence.
- Seed expectation is region-specific: baseline keys include both region and
  seed, so an `LPL #1` and an `LCS #1` are not the same expectation.
- A third seed beating a first seed is stronger evidence for the third seed's
  league than a first seed beating a fourth seed.
- A result from a substitute roster is weaker evidence about the league.
- A single academy or ecosystem team should not move a flagship league anchor
  much.

### League K

```text
LeagueDelta =
  LeagueK
  * LeagueResidual
  * EventWeight
  * SeriesWeight
  * RepresentativeWeight
  * ConnectivityWeight
  * SourceQualityWeight
  * UncertaintyWeight
```

`ConnectivityWeight` should shrink leagues with few international edges toward
their prior. It should also prevent a small number of off-season or qualifier
games from moving an entire league too far.

### Posterior Update and Sparse-Graph Diagnostics

The ideal league update should behave like a posterior update with variance, not
only a point Elo:

```text
ObservationVariance =
  BaseLeagueObservationVariance / max(Epsilon, UpdateWeight)

Gain =
  LeagueSigma^2 / (LeagueSigma^2 + ObservationVariance)

LeagueDelta =
  Gain * LeagueResidualOnRatingScale

LeagueSigmaAfter^2 =
  (1 - Gain) * LeagueSigma^2
```

Sparse leagues should shrink toward their prior using both weighted degree and
opponent diversity:

```text
WeightedDegree =
  sum(eligibleInternationalMatchWeights)

OpponentDiversity =
  (sum(weights)^2) / sum(weights^2)

Connectivity =
  WeightedDegree / (WeightedDegree + Tau)

EffectiveLeagueAnchor =
  PriorAnchor
  + Connectivity
  * DiversityFactor
  * (RawLeagueAnchor - PriorAnchor)
```

Public league rows should expose:

- posterior sigma
- confidence interval
- weighted international matches
- opponent diversity
- representative count
- connected-to-global-anchor flag
- shrinkage amount toward prior

### Placement Residual

Game-level cross-league updates are not enough. A tournament can reveal league
strength through depth and bracket path:

```text
PlacementResidual =
  ActualStagePoints - ExpectedStagePointsBeforeEvent
```

This should credit:

- multiple teams from a league advancing deep
- a league outperforming seed expectation
- avoiding over-penalizing a team eliminated by another elite team from the same
  league
- same-region finals through event path, not direct final-game league Elo

### League Confidence

Every league row should expose confidence:

- number of eligible cross-league matches
- recency of international evidence
- number of distinct representative teams
- average opponent strength
- placement evidence
- uncertainty interval
- shrinkage amount toward prior

League rankings without confidence intervals will overstate sparse regions.

## Region Update Design

Region strength should be derived from league posteriors:

```text
RegionStrength =
  weighted aggregate of flagship LeagueAnchors
  + international placement depth
  + cross-region residuals
  +/- uncertainty
```

For a flagship aggregate:

```text
RegionScore =
  sum(LeagueConfidence * RepresentativeSlotWeight * LeagueAnchor)
  / sum(LeagueConfidence * RepresentativeSlotWeight)

RegionSigma =
  sqrt(sum((Weight^2) * LeagueSigma^2))
  / sum(Weight)
```

The region layer should not count every domestic ecosystem game. It should
separate:

- flagship top-tier strength
- broader ecosystem depth
- lower-tier development signal
- current international confidence

For regions that contain multiple leagues or feeder ecosystems, the model should
avoid double-counting. Domestic feeder strength can inform depth, but it should
not make the flagship region stronger without cross-region evidence.

## Recommended RatingUpdateEvent Schema

Each match update should serialize an event like:

```text
RatingUpdateEvent {
  matchId
  date
  event
  stage
  bestOf
  patch
  teamA
  teamB
  winner

  pregame: {
    teamAPower
    teamBPower
    expectedWinA
    expectedWinB
    teamAComponents
    teamBComponents
    leagueAAnchor
    leagueBAnchor
    teamAForm
    teamBForm
    teamAStreakValue
    teamBStreakValue
    teamAUncertainty
    teamBUncertainty
  }

  context: {
    eventWeight
    seriesWeight
    surpriseWeight
    opponentQualityWeight
    streakContextWeight
    rosterReliabilityWeight
    sourceQualityWeight
    uncertaintyWeight
  }

  deltas: {
    teamAStableDelta
    teamBStableDelta
    teamAFormDelta
    teamBFormDelta
    teamAUncertaintyDelta
    teamBUncertaintyDelta
    leagueADelta
    leagueBDelta
    regionADelta
    regionBDelta
  }

  playerDeltas: [
    {
      playerId
      teamId
      role
      playerShare
      teamResultShare
      individualResidual
      lineupResidual
      playerDelta
      uncertaintyDelta
      sourceGameId
    }
  ]

  provenance: {
    provider
    sourceFile
    sourceUrl
    seededSample
    missingFields
    modelVersion
    configHash
  }
}
```

This ledger should be available in the full artifact and summarized in compact
public rows.

## Anti-Double-Counting Rules

1. Result residual drives stable team movement.
2. Streak break is mostly form movement, not a second full stable result.
3. Player result share is allocated from the team residual; it does not create
   additional team rating mass.
4. Individual player residual is controlled for team result.
5. League update uses the same pregame expectation, but is shrunk and capped so
   one team does not redefine an entire league.
6. Region update is derived from league posterior movement, not applied as a
   second direct game update unless a separate region model is explicitly
   validated.
7. Tournament placement residual is event-level and should not duplicate every
   game-level league delta.

## Validation Gates

No new channel should publish as active scoring until it clears walk-forward
validation against the current model and simple baselines.

Required segments:

- all matches
- international matches
- cross-region matches
- cross-league same-region matches
- Bo1
- Bo3/Bo5
- playoffs
- regular season
- upset buckets by pregame probability
- streak-break games
- both-teams-streaking games
- roster-change games
- substitute/incomplete-roster games
- patch-transition games
- side-known games
- lower-tier or unanchored-league games
- player-heavy prediction games

Metrics:

- log loss
- Brier score
- calibration curve
- accuracy as secondary
- expected calibration error
- segment sample counts
- confidence interval for each segment delta

Promotion rule:

```text
Promote a channel only if it improves log loss or Brier score overall
and does not materially harm high-priority segments.
```

If a channel improves only a narrow segment, publish it as a scoped adjustment
for that segment rather than a global rule.

## Minimum Viable Implementation Path

### Step 1: Define the Canonical Update Unit

Create a pregame-frozen update unit for either a Bo1 game or grouped Bo3/Bo5
series. For grouped series, score `gamesWon / gamesPlayed` from the pre-series
state and emit one atomic update event.

Benefit: avoids within-series ordering artifacts and makes sweep versus close
series impact explicit.

### Step 2: Add a Match Impact Ledger

Create a typed `RatingUpdateEvent` that records current team, league, player, and
context deltas. This can initially mirror existing calculations without changing
scores.

Benefit: makes every later scoring change auditable.

### Step 3: Formalize Pregame Form and Streak Features

Add pregame-only form state:

- quality-adjusted win streak
- quality-adjusted loss streak
- EWMA result residual
- recent opponent strength
- recent event quality

Keep streak-break stable deltas disabled or tiny until validated.

Benefit: directly addresses the Team A streak / Team B win case without
narrative hand-waving.

### Step 4: Split Team Stable and Team Form Updates More Explicitly

Stable strength should move slowly. Form should absorb hot/cold streak effects.
This keeps current prediction responsive without turning one tournament run into
permanent strength.

### Step 5: Split Player Ratings into Components

Publish and validate:

- team result share
- individual residual
- recent player form
- lineup synergy
- uncertainty

Benefit: a player can gain in a loss, lose in a win, and avoid carrying team
rating artifacts forever.

### Step 6: Add Cross-League Representative Weighting

League updates should account for whether the teams are first seeds, lower
seeds, rebuilt rosters, substitutes, or low-confidence representatives.

Benefit: a single odd result stops over-moving an entire league.

### Step 7: Add League Confidence and Sparse-Graph Diagnostics

Publish posterior sigma, confidence intervals, weighted international matches,
opponent diversity, representative count, and shrinkage amount for every league.

Benefit: makes sparse-league uncertainty visible instead of turning weak
connectivity into false precision.

### Step 8: Upgrade Region Strength to a Posterior Aggregate

Region rows should aggregate league posteriors with uncertainty and explicitly
separate flagship strength from ecosystem depth.

Benefit: fairer regions and cleaner APAC/feeder ecosystem handling.

### Step 9: Promote Only Through Shadow Validation

Run streak, execution, player, league representative, and region aggregation
changes in shadow mode first. Promote each only with walk-forward evidence.

### Step 10: Add a Grandmaster-Style Published Rating Scale

Add a versioned display-scale layer after calibrated team power is computed. The
first implementation should preserve internal prediction math, then publish a
wider ladder-style Elo range with top teams landing around Grandmaster or
Challenger-like values instead of clustering in a narrow 1500 to 1700 band.

Implementation requirements:

- keep internal Elo, expected win probability, and validation metrics on the
  calibrated scale
- publish `ratingScale` metadata with anchor, multiplier, min, max, and version
- transform rating components and history points so chart deltas reconcile with
  displayed standings
- keep raw calibrated rating available in full audit artifacts
- update copy from generic "rating" to "Power Index" or "published Elo" where
  needed so users understand the number is a ladder-scale presentation
- compare old and new public distributions before release; the top board should
  show meaningful separation without changing rank order from the internal
  model

Acceptance target:

- current published professional standings should span roughly `1000` to `2850`
- at least the best international contenders should clear `2400`
- the top team should feel visually distinct without requiring artificial
  one-match jumps
- win probabilities before and after the display-scale change should be
  identical for the same internal model state

## Acceptance Examples

### Team B Beats Team A, Same League, No Streak

Expected behavior:

- Team B stable and form increase according to result residual.
- Team A stable and form decrease.
- Player deltas are allocated by result share and individual residual.
- League and region do not directly move.
- Confidence tightens if both teams were uncertain.

### Team B Beats Team A, Team A Had a High-Quality Win Streak

Expected behavior:

- Team B gets normal upset or result credit.
- Team B gets additional form credit from breaking a high-quality streak.
- Team A loses part of its form layer.
- Stable streak bonus is small unless validated.
- Player deltas reward the players who actually outperformed.
- If cross-league, Team B's league gets extra evidence only through capped
  cross-league update and representative weighting.

### Team B Beats Team A, Team A Had a Low-Quality Win Streak

Expected behavior:

- Team B gets the normal result credit.
- Streak-break bonus is small because the streak was schedule-adjusted.
- League movement is not inflated by the raw streak length.

### Team B Upsets Team A at Worlds Knockouts

Expected behavior:

- large team stable and form update
- meaningful player result share and individual residual updates
- league anchors update if teams are from different leagues
- region aggregate moves through the league posterior
- public ledger shows event weight, expected win probability, and surprise
  weight

### Team B Wins with a Substitute

Expected behavior:

- Team B gains result evidence, but normal-lineup stable gain is damped.
- The substitute receives player credit.
- Lineup uncertainty remains high.
- League update is shrunk because representative reliability is lower.

### Team B Loses a Close Bo5 to Team A

Expected behavior:

- Team B loses some stable result credit, but less than in a sweep.
- Team B can gain execution or player residual if performance exceeded
  expectation.
- Confidence may tighten that both teams are close.
- League movement follows event/series residuals, not raw winner-only logic.

## Modeling Decisions Still Needed

Before implementation, decide:

- exact caps for `StreakValue`, `StreakBreakValue`, and form deltas
- whether streak break ever affects stable strength before validation
- whether same-region cross-league games update a separate intra-region league
  hierarchy
- how to define representative quality when source seed data is missing
- how much player individual residual can override team result share
- whether execution residuals become active globally or only in validated
  segments
- what public compact fields are needed without bloating `ranking-summary.json`
- whether the first Grandmaster-style rating range is a pure published transform
  or a full internal Elo rescale; default to the published transform
- exact published scale parameters, including anchor, multiplier, min, max, and
  labels for elite bands
- whether public compact artifacts should expose both internal calibrated rating
  and published ladder Elo, or keep internal rating only in full audit artifacts

## Recommendation

The next model should keep the current explainable Elo-like spine, but make every
match update multi-channel and auditable. Widening the public Elo range is a
presentation and provenance problem first, not just a bigger K value. The model
should separate what the match taught the model:

```text
Result -> stable team signal
Recent residual -> form signal
Player source rows -> player and lineup signal
Cross-league result -> league signal
League posterior -> region signal
Source and volume -> confidence signal
```

For the user's example, if Team A is on a strong win streak and Team B beats
Team A, Team B should gain more than it would from beating a neutral-form Team A.
But that extra gain should mostly be current form and confidence, with only a
small stable-strength effect unless walk-forward validation proves that streak
breaks predict future wins. If Team A and Team B are from different leagues, the
same result should also update league strength, but only through a capped,
representative-weighted, cross-league residual so one team does not overdefine an
entire league or region.
