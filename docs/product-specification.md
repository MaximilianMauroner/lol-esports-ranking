# League of Legends intelligence platform specification

This reference defines the target product across esports intelligence and scouting, builds and gameplay optimization, personal performance analytics, and a Windows and macOS companion. It preserves the requirements of the product foundation, version 0.2, prepared on 17 October 2026 for product owner Maximilian Mauroner. The [product purpose](product.md) explains why these capabilities belong together.

This is a product specification, not an implementation schedule or a claim of completed functionality. Category numbers do not set delivery order. Desktop framework, provider API, database, and hosting choices remain open. So do prices, quotas, deadlines, staffing, score weights, and formulas.

## Status and scope

Confirmed intent means a requirement requested by the product owner or necessary to preserve that request's meaning. The U requirements below record confirmed intent.

Proposed requirements define behavior and acceptance conditions that support that intent. The E, B, P, C, V, D, and X requirements have this status unless a capability is explicitly gated. Mandatory wording inside a proposed requirement defines its acceptance boundary. It does not mean the owner has approved an implementation or release.

A gated capability depends on suitable data, validated methods, permissions, platform support, or a separate activation decision. Unknown means that a decision or evidence remains absent. The decision register retains these unknowns. A historical observation describes a dated source assessment, not deployed availability or current validation.

All four categories are in scope, including shared accounts, saved work, historical analysis, scouting, monetization, and replay or video connections. Client integration, account authorization, overlays, recording, build or rune import, automatic match detection, and game-phase behavior remain gated. A supported implementation, explicit permissions, resource validation, and feature-specific review must precede activation. Manual preparation and review must remain useful when optional integrations are declined or unavailable.

An initial release need not support every champion, interaction, league, tournament format, region, queue, or historical window. Full live-game intelligence, automatic video understanding, and unrestricted private scrim access are not initial-release requirements. Windows and macOS are both targets. A staged beta must identify the unsupported platform. Native Linux and mobile applications are outside the requested scope.

DPM.lol, Coachless, Porofessor, and the supplied screenshot are user references for experience and organization. They do not establish competitor functionality, platform support, performance measurements, or data that can be imported. The companion's efficiency requirement does not depend on an asserted competitor benchmark.

### Confirmed intent

| ID | Confirmed intent |
| --- | --- |
| U-01 | A cohesive system rather than separate statistics tools. |
| U-02 | Esports tracking with statistics for teams and individual players. |
| U-03 | Team and player rankings, graphs, strengths, and weaknesses. |
| U-04 | Drafts and drafting performance should be evaluated and ranked. |
| U-05 | Player and team history should affect calculations and scouting. |
| U-06 | Tracking and updates should work automatically wherever feasible. |
| U-07 | Build tracking should calculate effective builds for a champion, rotation, and combat duration. |
| U-08 | Build development should cover levels 1 through 18 and situational power spikes, including a level-14 fight. |
| U-09 | A personal analysis experience inspired by DPM.lol and Coachless for reviewing performance and skill-related evidence. |
| U-10 | Professional competition, ranked players, scouting, itemization, leveling, pathing, and video should connect. |
| U-11 | A useful free product with paid access at greater depth, usage, or service tier. |
| U-12 | An installable, resource-efficient Porofessor-style alternative for both Windows and macOS, connected to the same platform. |
| U-13 | Incorporate what the existing `lol-esports-ranking` project already does. |

## Existing foundation and lasting constraints

U-13 requires reuse of the LoL Esports Power Index foundation. The source assessment dated 17 October 2026 identified team strength estimation, role-relative player ratings, league context, historical comparisons, descriptive player statistics, match navigation, competition tracking, automated source processing, and versioned provenance. That selected-file assessment did not establish production availability, model accuracy, or completed scouting, draft grading, simulation, personal analytics, video analysis, or desktop products.

Preserve source and snapshot semantics, identity handling, historical records, and traceability when extending that foundation. A neutral or average draft context in a team-strength model does not constitute draft grading. Descriptive player averages do not become score inputs without an explicit definition change and validation. Samples can cross teams or roles and must state their scope.

The same assessment recorded gated forecast activation and unsupported tournament calculations. It also recorded a six-hour gated ranking refresh, separate tournament refresh behavior, and schedule-derived live status. These are dated observations, not a current operational inventory. This specification does not authorize a change to production refresh cadence, provider collection, publication, configuration, deployment, or cleanup. Forecast activation requires complete identities, inputs, publication evidence, verified rules, and permissions. Schedule status does not establish live game telemetry.

## Esports intelligence, competition tracking, and scouting

### E-01: team profiles and overview reports

Provide a compact, understandable account of a team's strength, style, players, results, and preparation-relevant tendencies.

A team overview should contain its identity, competition and region, selected time window, observed lineup, record, strength estimate, trend, and data freshness. Users should be able to switch between the organization, a specific season, and a specific lineup without silently mixing them.

The detailed profile should cover domestic and international results, strength of opposition, rating trajectory, recent form, champion tendencies, side and pick-order patterns, and descriptive gameplay metrics where supported. Team composition and roster changes should remain dated historical facts rather than overwrite the past.

The proposed team report has these areas:

| Report area | Intended information |
| --- | --- |
| Header | Team identity, scope, team-strength assessment, and a separate draft assessment when validated. |
| Summary cards | Record, international record, relevant early-game metric, ranking position, and freshness. |
| Team summary | A short explanation of the strongest supported findings, each traceable to evidence. |
| Player table | Role, player, champion history, rating and performance context, games, relevant metrics, and strengths and weaknesses. |
| Draft section | Draft trends, signature picks, and separate longer-window versus recent-window comparisons. |
| Side and order section | Blue and red side, first or second pick where sourced, series-game position, samples, and results. |
| Off-meta section | Player-specific unusual picks, their definition, appearances, and outcomes. |
| Detail links | Matches, player pages, comparisons, methodology, and relevant video. |

Letter grades and percentiles remain design references. Their exact scales, thresholds, and formulas remain to be defined. Missing coverage must produce an unavailable state, not an invented neutral grade.

**Acceptance.** A user can open a team, identify the selected context and actual sample, inspect its players and trajectory, and trace each material assessment to a definition and supporting records.

### E-02: professional player profiles

Evaluate a player across time, roles, champions, teams, and competitive contexts without conflating them.

A profile should retain canonical identity, aliases, historical teams and roles, observed appearances, and verified account links. It should expose the player's current context while allowing season, event, team, role, and champion filtering.

Champion analysis should include frequency, recent use, sample size, role, opponent context, results, and performance distributions. Champion breadth should be descriptive before it becomes evaluative. The system must distinguish a large historical pool from a currently demonstrated competitive pool.

Strength and weakness summaries should separate observed statistics from contextual estimates and reviewer notes. Comparisons should identify whether they concern the player's current role, career, latest team, or a selected competition window.

Verified solo-queue accounts should open the personal-analysis module. Professional results and ranked results should remain separate views with an explicit connection, not become one blended win rate.

**Acceptance.** The same player can be followed through a transfer or role change without duplicate identity or misattributed history, and each comparison exposes its scope and evidence.

### E-03: ratings, rankings, and uncertainty

Answer specific competitive questions through clearly defined evaluations.

Keep the following quantities separate:

| Quantity | Question it answers |
| --- | --- |
| Team-strength estimate | How strong is this team under the model's stated reference conditions? |
| Individual performance assessment | How does this player's observed performance compare within a defined context? |
| Recent form | How has recent performance differed from the longer-run baseline? |
| Match or series probability | Given specified teams and conditions, how likely is an outcome under this model? |
| Draft assessment | How favorable is the chosen draft relative to stated alternatives and player context? |
| Metric percentile | Where does this observed or adjusted metric fall within a stated comparison population? |

An overall rating should show its model and version, scope, uncertainty, sample, and principal components. A rank should state the eligible population and treatment of ties or practically indistinguishable estimates.

Filtering needs explicit semantics. "Show teams in this event on the global scale" differs from "recalculate using this event's matches only." Both may be useful, but the interface must not silently swap between them. Historical pages must distinguish a reconstructed historical state from a forecast demonstrably published before play.

Newly formed, inactive, low-volume, or weakly connected teams should remain visible without receiving unjustified precision. The same principle applies to reserves, transfers, and small champion samples.

This capability is subject to the policy review in [Evidence, permissions, and release quality](#evidence-permissions-and-release-quality). Competitive scouting assessments are not assumed to be exempt from that review merely because they are called ratings.

**Acceptance.** A user can explain what a rating measures, distinguish it from forecast probability, and inspect why a row is ranked, provisional, or unavailable.

### E-04: strengths, weaknesses, graphs, and comparisons

Make patterns visible and comparable without hiding context behind a composite score.

Candidate dimensions include laning, resource acquisition, damage output, resource and output balance, vision activity, champion familiarity, objective-related patterns, and performance variation. More advanced assessments such as lead conversion, fight execution, or effective vision require appropriate supporting evidence and separately validated definitions.

Recommended visualizations include rating and rank timelines, metric distributions, paired comparison charts, champion-by-patch heatmaps, matchup matrices, draft-frequency charts, and resource and output plots. A radar chart may be a secondary summary, but the underlying values, units, and samples should remain inspectable.

Every metric display should provide its unit, direction of interpretation, population, patch and time window, sample count, coverage, and whether it is raw or adjusted. "More" should not automatically mean "better." A statistic that depends on team assignments or champion style should not become a universal player-quality label.

Allow comparison of teams, lineups, and players at matching scopes. Provide a visible warning when users intentionally compare unlike roles, patches, queue types, or competition levels.

**Acceptance.** Users can compare entities with consistent definitions and open the exact observations behind a graph or strength label.

### E-05: draft intelligence and preparation

Evaluate draft decisions in the context of the players, patch, opponent, and available choices, rather than rewarding a draft because the stronger team won.

Draft history should retain picks, bans, order, assigned roles where known, side, game number, series context, and the applicable format. Format-specific restrictions, including cross-game champion restrictions where applicable, must come from verified rules rather than be assumed universal.

A preparation view should show player champion proficiency, team pick and ban tendencies, contested picks, flexible assignments, unusual picks, and opponent-specific patterns. Raw frequencies and results should remain available beside adjusted assessments.

The proposed draft model should take a point-in-time draft state and compare legal alternatives. Relevant inputs include the patch, participants, pre-existing player champion histories, available champions, composition properties, and known format restrictions. Future results must not leak into a pre-match assessment.

Its output should separate the following assessments:

- Composition characteristics and tradeoffs, such as damage profile, range, engage options, scaling, and target access, where defined and supported.
- Player-specific feasibility, including demonstrated familiarity, role allocation, and uncertainty for unfamiliar champions.
- A model-based assessment relative to stated alternatives, with assumptions and confidence limits.

A proposed "draft contribution" can compare a pre-draft prediction with a draft-conditioned prediction while holding the specified team and player baseline fixed. Such a difference is model-based, not proof of the causal value of the picks. The exact definition and validation must precede a numerical grade.

Support season and recent-window draft summaries, side and pick-order analysis, signatures, and off-meta picks. "Off-meta" requires a displayed reference population and frequency threshold, not merely the designer's judgment. Small samples should be shown but not promoted into strong conclusions.

**Acceptance.** A user can replay a draft state, inspect relevant player histories, compare legal alternatives, and see why the assessment differs without using the match result as its justification.

### E-06: scouting workspace

Turn profiles into a repeatable process for finding and evaluating players.

Proposed components are candidate search, shortlists, side-by-side comparison, saved filters, evidence-backed notes, and shareable reports. Search should support role, competition, champion experience, time window, activity, and relevant performance dimensions where data and permissions allow.

A candidate report should distinguish observed record, adjusted estimates, supporting matches and clips, reviewer interpretation, and unresolved questions. A "fit" assessment must state the requested role or team needs and should not masquerade as an objective universal score.

Linked ranked history can provide additional champion or practice evidence. It should not automatically outweigh organized competition or be assumed to transfer directly to professional play. Unverified alternate accounts must not be silently attached to a person.

Private organizational notes, uploads, and candidate lists are proposed paid-workspace features. They should never enter public profiles or shared training datasets by default.

**Acceptance.** A scout can create a candidate comparison and report with reproducible scopes, verified identities, accessible evidence, and clearly separated private commentary.

### E-07: competition tracking and forecasting

Follow competitions and inspect the competitive implications of results using the same team and player foundation.

The tournament experience should include schedules, confirmed scores, brackets, standings, historical events, and navigation to participating entities. It must distinguish confirmed source status from schedule-based estimates, and show source freshness and unresolved results.

Forecasts should state whether they concern a game, series, stage, or tournament. Each should preserve the information cutoff, rating basis, roster assumption, format, side treatment, and source state. A hypothetical result must not be written into actual match history.

Series-score conditioning differs from live game-state prediction. The platform should not claim the latter when it only knows the number of completed game wins. Tournament simulation should use a verified ruleset and explicitly reject unsupported draw or tiebreaker cases.

A scenario workspace may let users fix hypothetical outcomes and inspect consequences. Frozen inputs and reproducible runs should make it possible to explain why the output changed. Observed outcomes, model probabilities, and scenario assumptions should remain visually distinct.

**Acceptance.** Users can follow a supported event, inspect its teams, and reproduce available forecasts while unsupported cases give specific reasons instead of guessed probabilities.

### E-08: automatic reports and updates

Keep team and player reports current without manual collection and recalculation after every match.

Refreshes should detect new or corrected source records, normalize identities, validate inputs, recompute affected outputs, and publish a coherent version. They should preserve the last valid dataset when a provider fails and expose the new health warning.

Reports should distinguish "last source check," "latest covered match," and "analysis generated at." An automatic summary should reference its input snapshot so a later source correction can invalidate or regenerate it.

Narrative generation is optional. Deterministic summaries should be sufficient for core reports. An AI-written paragraph must not invent causal explanations or replace missing statistics with confident prose.

**Acceptance.** A new supported match or correction produces an auditable updated report, and a failed refresh does not silently present old data as fresh.

## Build tracking and gameplay optimization

### B-01: scenario definition

Compare item and ability choices for a specific champion and situation, not only display popular six-item builds.

Every simulation should begin with an explicit scenario. A "normal rotation" should be a named, editable sequence or behavior profile, not an undocumented assumption that applies to every player and champion.

| Input group | Proposed inputs |
| --- | --- |
| Rules and identity | Champion, role, map and mode, game patch, mechanics implementation version. |
| Player state | Level, ability ranks, inventory, available gold, health and resource state, relevant stacks and cooldowns. |
| Configuration | Runes, summoner spells, buffs, and other supported modifiers. |
| Enemy state | Target champion or synthetic target, level, health, defenses, shields, and relevant effects. |
| Combat behavior | Duration, attack and ability sequence, attack uptime, hit assumptions, movement interruptions, and target switching. |
| Purchase constraints | Existing items, allowed sells, inventory capacity, candidate item set, and future gold assumptions. |
| Objective | Burst, sustained damage, time to kill, or another explicitly implemented objective. |

Not every input must be implemented in the first release. Unsupported mechanics must block the affected calculation or produce a visible limitation. Omitting a mechanic silently is not an acceptable approximation.

Default scenarios should provide a usable starting point. Advanced controls should let a player or analyst reproduce and challenge the result.

### B-02: combat simulation

Calculate what happens under a declared combat model and explain the contribution of each choice.

The engine should model the supported attacks, abilities, item effects, cooldowns, resources, damage mitigation, and event ordering. Timing matters. A total-damage formula without a sequence model is not automatically a valid eight-second rotation simulation.

Recommended outputs include total damage, damage by source and type, damage over time, actual attacks and casts executed, resource usage, and time to kill when the target dies within the modeled window. "Damage per second" must state the denominator and should not conceal a long inactive period.

Critical hits and other stochastic mechanics need a stated treatment. The treatment can be an expected value, a sampled distribution, or a deterministic scenario. Sampled results need a seed and enough reporting to reproduce them. An expected-damage calculation must not be presented as a guaranteed kill.

Survivability requires a defined incoming-damage and behavior model. Without one, show defensive statistics or constrained damage tradeoffs rather than claiming an optimized survival probability. The same boundary applies to utility, healing, crowd control, target access, and team-wide value.

The engine should produce a calculation breakdown that can be tested independently of the interface. Confidence in a forecast and correctness of deterministic combat arithmetic are different validation problems.

**Acceptance.** Supported scenarios can be reproduced, their event breakdown can be inspected, and independently specified test cases establish the implemented mechanics within documented tolerances.

### B-03: feasible purchase-path optimization

Find strong purchase sequences that a player can actually follow throughout a game.

A path is an ordered sequence of inventory transitions. Each purchase point must respect previously owned items, component upgrades, available gold, inventory space, and the implemented purchase restrictions. Selling must include the permitted return and its effect on later purchases.

The optimizer should support two related modes:

**Checkpoint optimization.** Given the current inventory and budget, compare the feasible purchases for a particular fight or objective window.

**Path optimization.** Compare complete sequences across several checkpoints, carrying each purchase forward and considering the declared future gold or timing assumptions.

The objective may emphasize the next fight, later strength, or an explicit combination. No hidden weighting should decide how much an early advantage is worth relative to a later one. A comparison can show several non-dominated alternatives rather than force one universal winner.

The result should record candidate coverage, search method, stopping condition, and search duration. Use "best found under these constraints" when the search has not proven a global optimum.

**Acceptance.** Every recommended inventory can be reached from the previous one, spending reconciles, and a user can inspect the immediate and later consequences of deviating from the original path.

### B-04: levels 1 through 18 and power curves

Show how builds develop across the champion's progression, including meaningful purchase checkpoints.

The interface should support level-based, gold-based, and time-based views. Level does not by itself determine inventory or elapsed game time. A time curve therefore needs either an observed match trajectory or a clearly declared progression scenario.

Recommended views are a purchase timeline, output-versus-gold curve, level and checkpoint comparison, damage-over-combat-time chart, and crossover view showing where one path becomes stronger than another under the chosen assumptions.

Display components as well as completed items. A build that looks stronger at completion may have a different intermediate curve. Ability-rank changes, item completions, and other supported state changes should appear at their actual checkpoints.

Comparisons should use consistent axes and conditions. Do not compare one build with more total gold or a different enemy defense profile without labeling that difference.

**Acceptance.** Users can inspect a complete level-1-to-18 scenario, understand the gold and time assumptions, and identify where purchase or leveling decisions change the comparison.

### B-05: situational fight windows

Compare a level-14 purchase for an important immediate fight, including its effect on later purchases.

The following scenario is an example, not a fixed product default:

```text
Champion: a supported ADC
Level: 14
Current inventory: supplied by the user or imported from a match
Available gold: supplied or observed
Fight duration: 8 seconds
Targets: a defined frontline target, a defined lower-defense target, or both
Current plan: continue toward the next completed item
Question: which affordable purchase is strongest for this fight,
and how does it affect later checkpoints?
```

The comparison should show the original path, the strongest immediate alternative found, and relevant defensive or target-specific alternatives if those objectives are implemented. It should state the purchase cost, gold left, expected output, supported defensive effects, and the future completion delay under the chosen income assumptions.

The result should also identify sensitivity. Does the preferred option change for a shorter fight, less attack uptime, different target defenses, or a different budget? An apparent optimum that depends on one fragile assumption should be presented as such.

This example defines a required workflow without asserting a numerical result.

### B-06: observed build tracking

Connect simulated comparisons with what players actually buy and how those games unfold.

Observed build pages should show item and component sequences, purchase timing where available, ability leveling, runes, sample counts, and results within explicit patch, champion, role, queue, and competition scopes.

Professional, ranked, and other supported samples should remain selectable rather than being pooled automatically. Users should be able to open the original matches behind a build path and compare those states with a simulator scenario.

Keep common purchases, associations with observed outcomes, and simulated results distinct.

Proposed analytical safeguards include controlling comparisons for relevant game states and avoiding comparisons that require one group to survive or earn enough gold to complete a later item. A higher completed-item win rate is not, by itself, evidence that purchasing the item caused more wins.

**Acceptance.** A user can inspect a real build sequence, see the sample and timing limitations, and create a simulation from it without treating observational results as causal proof.

### B-07: personalization from player history

Use history to select relevant scenarios and explain recommendations without changing game mechanics arbitrarily.

Personal history may inform observed gold and level trajectories, recurring purchase choices, champion familiarity, and typical situations. Execution assumptions such as attack uptime or skillshot success should only be inferred when suitable evidence exists. Otherwise they remain editable user inputs.

The same champion, inventory, and combat inputs must produce the same mechanical calculation for every account. Personalization belongs in scenario selection, supported behavioral assumptions, and interpretation, not unexplained account-specific damage multipliers.

Show both a reference execution scenario and a player-informed scenario when available. Players should be able to inspect and override the difference. The system should not trap users in recommendations based on habits they are trying to improve.

**Acceptance.** The interface can explain which historical observations changed the scenario, and the user can reproduce both personalized and reference results.

### B-08: saved scenarios and cross-product use

Make a build comparison reusable across preparation, personal review, and scouting.

Saved scenarios should retain champion and patch, all inputs, model and mechanics version, search configuration, output, and evidence links. Sharing must preserve permissions. A patch update should mark an older scenario as historical until it is explicitly rerun or regenerated.

Opening a purchase point from a match should import only available fields. A hindsight comparison using later enemy inventories must be labeled separately from a comparison restricted to information available at that purchase time.

**Acceptance.** A saved scenario can be reopened from any relevant module, reproduced on its original version, or rerun on a new patch without overwriting the historical result.

## Personal performance analytics

### P-01: player identity, accounts, and history

Provide a persistent profile for a player while keeping separate accounts and competition contexts identifiable.

The profile should support authorized account linking, identity verification, account aliases, region and shard context, and selectable account-level or combined views. Historical names should not become the only join key. Account discovery and ownership verification are different operations.

Queue and mode, role, champion, patch, season, and date filters should apply consistently across profile statistics and match lists. Ranked progression should be based on observed official records rather than invented historical values where snapshots were never collected.

A profile refresh should expose its actual coverage, last successful update, and incomplete history. The product should not promise an entire career simply because a player account is found.

**Acceptance.** A player can connect an eligible account, see the available history, and understand what is included or missing without duplicate or misattributed matches.

### P-02: match-history and match-detail review

Let the player move from a season-level pattern to the specific games and decisions that support it.

Match history should include results, champion and role, relevant statistics, items, runes, and time context. Match details should add teammate and opponent context, purchase and ability-leveling timelines, and available event or position data.

The review should separate match outcome from individual measurements. A won game can contain a recurring weakness, and a loss is not sufficient evidence that the player performed poorly.

A timestamped event should state whether it was observed, reconstructed from sampled data, manually annotated, or detected from video. Unsupported details should remain absent rather than be reverse-engineered into an apparently exact timeline.

**Acceptance.** A user can open a match from any profile graph, inspect its available evidence, and move a purchase or gameplay moment into the relevant analysis tool.

### P-03: descriptive and contextual performance analysis

Explain how the player performs relative to their own history and an appropriate comparison population.

The initial analytical vocabulary should include raw metrics, distributions, within-player trends, and cohort comparisons. Candidate areas are farming, early advantage, resource acquisition, damage context, participation, deaths and their timing, vision activity, champion familiarity, and supported objective-related behavior.

A comparison population should be explicitly defined by relevant factors such as role, champion, patch, queue, rank band, and sample window. Not every factor will be available or appropriate for every metric. The comparison must state what was and was not accounted for.

The interface should distinguish these analysis types:

| Analysis type | Example of the question |
| --- | --- |
| Descriptive | What happened in the observed games? |
| Relative | How does this compare with a specified cohort? |
| Longitudinal | How has the player changed across comparable periods? |
| Model-adjusted | How different is the observed result from a stated expectation? |
| Predictive | What does a model estimate using only the information available beforehand? |

An overall performance summary can be useful if its dimensions and uncertainty are visible. It must not claim to reveal hidden MMR or a player's "true rank." Any numerical skill-like evaluation needs the policy and methodology review in [Evidence, permissions, and release quality](#evidence-permissions-and-release-quality).

**Acceptance.** A player can distinguish a raw statistic from an adjusted assessment and identify the population and evidence supporting the comparison.

### P-04: recurring strengths, weaknesses, and change

Identify repeated patterns rather than overreact to one match or one noisy statistic.

A pattern should state its time window, number of supporting and contrary examples, comparison basis, and confidence limitations. A recent deterioration should trigger investigation of plausible changes such as champion mix, role, patch, opponents, or play context before it becomes a strong ability claim.

A pattern can be presented as a hypothesis, for example, "Purchase timing is worth reviewing in these games." The product should not state that a habit caused losses unless an appropriate method supports that claim.

Avoid psychological labels such as "tilted," "lazy," or "unmotivated" based on gameplay records. Performance observations do not establish personality or intent.

**Acceptance.** Each highlighted strength or weakness links to relevant games, has a meaningful sample, and distinguishes observation from interpretation.

### P-05: improvement workflow

Convert analysis into an inspectable, manageable improvement process.

A player should be able to choose a focus, define its observable measure, save example matches or clips, and review a later comparable sample. The product should support a small number of active focuses rather than require an elaborate coaching schedule.

One improvement workflow starts with a baseline for a supported purchase-timing metric. The player inspects representative games, tests another purchase path in the simulator, and compares later games under a similar context.

Progress displays should show the metric and sample, not only a gamified score. The system should distinguish observed improvement from evidence that the platform itself caused it.

**Acceptance.** A user can record a clear focus, attach evidence, and review the next sample using the same definition and scope.

### P-06: champion, build, and scouting connections

Use the personal profile as part of the same analytical system that serves competitive players and scouts.

Champion pages should connect the player's history to observed build paths and saved simulations. Match reviews should launch comparisons from an actual inventory state. Verified professional identities should link to esports profiles while keeping competition types separate.

A scouting view should reuse the same metric definitions and evidence while presenting a different workflow. Private player notes and videos should not become public scouting material automatically. Comparisons should respect both source access and the player's sharing choices.

**Acceptance.** The same authorized match and player identifiers work across personal analysis, esports profiles, build comparisons, and saved reports without duplicate calculations or permission changes.

## Lightweight Windows and macOS desktop companion

### C-01: installed application and product role

Provide a resource-efficient alternative to the user's current companion experience, with a usable installed application on both Windows and macOS.

The application is an interface to the same product, not a separate statistics service. It should reuse esports profiles, personal histories, metric definitions, saved build scenarios, reports, and permissions. Where an identical analysis is opened in the website and companion, the inputs, version, and result should agree.

Its core value is convenient preparation and post-game review. Automatic client awareness, optional capture, and approved game-phase integrations can add value later without becoming mandatory dependencies. Another launcher, advertising platform, or unrelated background service is not required by this specification. Copying every competitor feature is outside the requirement.

Define supported operating-system versions and processor architectures before release. Both platforms belong in the product plan. Platform-specific features can differ where integrations are unsupported, provided the difference is documented. A working Windows build is not evidence that the macOS application or its integrations work.

The installed experience should support a normal window, user-controlled background behavior, an optional tray or menu-bar entry, and an explicit quit action. Closing the window, minimizing it, and exiting the application must have clear meanings. Autostart should be opt-in. Quitting should stop the application's helpers rather than leave unexpected background processes.

**Acceptance.** Supported Windows and macOS installations can open a shared profile, access a saved build, and review a match. Lifecycle behavior is documented and tested on both platforms. Unsupported native features are visible rather than silently simulated.

### C-02: account access, authorization, and local security

Connect the companion to the correct platform account and authorized game identity without weakening the website's privacy model.

Use the same platform account, entitlements, workspace roles, and verified player links as the website. A locally detected game account is a separate observation. It does not prove ownership, authorize access to private data, or silently replace the active platform identity.

Use a reviewed authentication flow and platform-protected credential storage. Do not ask users to enter their Riot password into the application or embed production provider secrets in a distributable client. Short-lived access, revocation, account switching, and sign-out should be explicit parts of the design.

Client credentials, local authorization files, access tokens, and private API responses must not appear in logs, crash reports, shared links, or synced settings. Scope local access narrowly and do not expose a helper endpoint to other machines by default. Any local bridge needs authentication and a defined trust boundary.

Separate account-linking consent from notification, client-access, recording, microphone, and upload permissions. Users should be able to use the manual preparation and review workflow while declining optional integrations. Account switching must clear or isolate private cached material belonging to the previous user.

**Acceptance.** The same authorized account works across both interfaces. Tests cover logout, revocation, and cache isolation between accounts. Optional permissions can be denied without breaking the core companion. Diagnostics contain no secrets.

### C-03: permitted client integration and match lifecycle

Reduce manual navigation when a supported client integration is available, while remaining useful when it is absent or unavailable.

Define a small platform-adapter contract for the exact states and fields the application needs. Prefer bounded event-driven updates where a supported mechanism exists. Where polling is necessary, specify its cadence, backoff, cancellation, and maximum work. Do not repeatedly scan unrelated processes or files merely to keep an idle interface current.

Integration must use permitted mechanisms and remain read-only by default. Do not inspect protected game memory, inject code, evade anti-cheat controls, reveal deliberately hidden identities, or automate gameplay. Successful technical access is not evidence of permission. The policy checks in [Evidence, permissions, and release quality](#evidence-permissions-and-release-quality) still apply.

The proposed lifecycle has these states:

| State | Companion behavior | Required fallback or restriction |
| --- | --- | --- |
| Game or client absent | Open saved work and profiles normally. Keep integration work dormant. | No repeated high-frequency discovery loops. |
| Client detected, account unresolved | Offer authorized account resolution or manual selection. | Do not infer verified ownership from a display name. |
| Preparation or lobby | Show the user's selected profile, champion history, and saved plans. | Use only supported fields and permitted preparation features. |
| Champion selection, if supported | Display explicitly reviewed informational features. | No hidden-player identification or assumption that every proposed recommendation is allowed. |
| Game starting or in progress | Enter quiet mode and suppress optional heavy work by default. | No new live assistant behavior without its own release gate. |
| Game ended, data pending | Show that review data is not ready and schedule bounded retries. | An ended game is not proof that complete source data is available. |
| Match data available | Link the canonical match and existing review workflow. | Validate player and match identity and avoid duplicate imports or charges. |
| Client disconnected or integration broken | Retain manual navigation and show the affected capability as unavailable. | Do not retain stale game context as though it were current. |

Document what each adapter actually supports on each OS. Isolate adapter failures from the UI and saved-work functions. A game or client update should be able to disable the affected adapter without making the application unusable.

**Acceptance.** Supported state transitions, disconnects, account changes, retries, and stale events pass integration tests on each advertised platform. A missing integration leaves a complete manual workflow. No state is inferred more strongly than its evidence permits.

### C-04: preparation, saved builds, and profile access

Make shared platform analysis accessible before a match.

The preparation view should provide the active player's recent performance context, a selected champion's history, saved build scenarios, ability-leveling plans, and relevant permitted opponent and team research. Esports profiles and scouting reports should remain reachable, but the companion need not load an entire tournament workspace every time it starts.

A saved plan should show its patch, scenario, date, mechanics support, and whether it is a simulation, an observed build, or a manually selected plan. Old plans can remain readable as historical records. They should not silently become current-patch recommendations.

Users should be able to compare a small number of alternatives, inspect assumptions, pin a plan, and open the complete analysis in the website. A desktop view must not simplify away the difference between an observed popular build and a simulated purchase path.

Item-set or rune-page import is a proposed gated convenience. It is not a confirmed existing capability. Its release requires a verified permitted interface and platform support. Show a preview, require an explicit user action, report success or failure, and avoid overwriting unrelated saved configurations. Do not extend import into automatic purchases, spell selection, or gameplay execution.

**Acceptance.** A build or profile saved on the website can be opened with its original context in the companion, compared with an alternative, and preserved across sessions. Unsupported import stays unavailable rather than being approximated through unreviewed input automation.

### C-05: quiet in-game mode and optional display features

Avoid interfering with the game while keeping any separately approved, user-selected information accessible.

The baseline companion should remain useful without an overlay. Entering a game should not start a live advisor, begin recording, steal focus, or produce repeated notifications. Suppress heavy local analysis and nonessential background jobs by default. Provide a manual quiet-mode control when reliable game-state detection is unavailable.

Any overlay is a separate optional feature with its own permission, compatibility, and performance tests. Define exactly what is displayed, when it can appear, and how the user dismisses it. A user-pinned preparation reference is a candidate for review, not a blanket assumption of permission for all in-game guidance.

Live purchase instructions, automatic pathing advice, champion-select assessments, and information derived from a current session require feature-specific evaluation before release. Do not treat the existence of a post-game simulator as authorization to convert it into real-time decision instructions. Previously unknown or deliberately hidden game information must not be exposed.

Test supported display modes, monitor changes, resolution and scaling, focus behavior, and approved hotkeys separately on each platform. Hotkeys should be opt-in and narrowly registered. They must not become general keystroke recording. A display or hotkey failure must not disrupt gameplay or prevent the user from closing the companion.

**Acceptance.** With optional features disabled, the application remains quiet and within its in-game resource budget. Any enabled overlay has a documented feature boundary, independent review, a reliable off switch, and platform-specific acceptance evidence.

### C-06: post-game review and processing handoff

Make the transition from playing to evidence-based review short and reliable.

When a match is confirmed and source data is available, the companion should open the same canonical match detail as the website. That detail includes outcome, relevant personal metrics, purchase and leveling history where sourced, recurring-pattern context, and evidence links. It should not invent missing information because a local event says the game ended.

A purchase checkpoint can open the shared simulator with available inputs already filled. A finding can be saved to an improvement focus or an authorized scouting report. The companion should submit heavy historical analysis, video processing, or large searches through the same bounded job system, with visible progress, cancellation, quota impact, and failure states.

Prefer one concise, optional review-ready notification to multiple alerts. Store a pending review pointer through application restarts without retrying an upload or paid job twice. Reconnecting after a network failure should reconcile job state before resubmitting work.

**Acceptance.** One supported completed game becomes a review, a saved purchase comparison, and optionally an improvement note with consistent identifiers. Pending data, duplicate lifecycle events, restarts, canceled jobs, and network outages do not create duplicate matches or usage charges.

### C-07: shared work, synchronization, and bounded offline access

Preserve saved work and permissions when users switch between the website and companion. Do not require a full platform download.

Synchronize saved builds, chosen comparisons, review notes, reports, and relevant account preferences through versioned records. Keep machine-specific settings such as capture paths, display placement, and locally granted permissions on the appropriate device. Do not copy authentication secrets or OS permission grants between devices.

Use bounded local storage for recently opened public material and deliberately cached personal work. Show the source date, patch, analysis version, and offline or stale state. Offline access is not a promise of fresh statistics, complete match history, or local execution of every server-side calculation.

Editing offline should retain a base revision and expose conflicts instead of silently overwriting newer website changes. Reconnection must reauthorize queued operations. Server-side revocation can prevent new access, but cannot instantly erase a disconnected copy. Do not claim otherwise. As a proposed default, private team reports and recordings should not be available offline until a separately reviewed retention and cache policy exists.

Clear caches on request, bound size and age, and support safe account unlinking. Paid-only data cached legitimately needs a documented expiration policy. An expired entitlement must not authorize new paid jobs. Essential access to the user's own notes should follow the chosen ownership and export policy rather than an accidental cache behavior.

**Acceptance.** A supported saved-work round trip between web and desktop preserves versions and permissions. Concurrent edits expose conflicts. Offline results are visibly historical. Sign-out and access changes are tested against both local caches and queued jobs.

### C-08: resource efficiency and performance budgets

Demonstrate low resource use under representative conditions, including while the game is running.

Measure the whole application process tree, including interface renderers, the native shell, helpers, updaters, capture processes, and local analysis workers. Moving work into another companion-owned process does not remove it from the budget. Moving work to the server can reduce local load, but server cost and network usage still need separate measurement.

The implementation should use lazy feature loading, bounded caches, limited polling, cancelable jobs, and dormant optional modules. Closing an analysis view should release its subscriptions and unnecessary data. Recording, video decoding, large local searches, and bulk background sync must not run by default during a match.

The resource test matrix covers these modes:

| Mode | Measurements | Proposed acceptance condition |
| --- | --- | --- |
| Cold start | Time to useful UI, peak memory, CPU, disk and network work. | Remains within the agreed startup budget with a representative account. |
| Idle or background | Stable memory, CPU wakeups, disk and network activity, helper count. | No continuous expensive work, unbounded growth, or polling unrelated to enabled features. |
| Preparation | Profile and build load latency, peak memory, canceled-request cleanup. | Core views remain responsive without loading unrelated historical datasets. |
| In game, optional features off | Whole-process memory, CPU, and GPU load, frame-time comparison, network and disk activity. | Meets the agreed quiet-mode budget and game-impact threshold. |
| Optional overlay | Incremental memory, GPU, and CPU cost, focus and input behavior, frame-time change. | Cost is measured separately and the feature can be disabled completely. |
| Optional recording | Added resource use, recording quality, disk growth, upload backlog. | Separate opt-in budget. Storage limits and interruption behavior work. |
| Post-game review | Time to usable results once source data is available, peak resource use, job progress. | UI stays usable and local work remains bounded while remote jobs run. |
| Repeated sessions | Resource trend across games, sleep and wake, disconnects, and window reopenings. | No monotonic leak, duplicate worker accumulation, or repeated orphan jobs. |
| Exit and uninstall | Remaining companion-owned processes, tasks, credentials, and caches. | Quit ends active local work. Uninstall follows the disclosed data-retention choice. |

Record the OS, hardware, application build, enabled features, dataset size, measurement definition, and test duration. Windows and macOS memory counters need explicit definitions. Differently named process metrics should not be presented as directly interchangeable measurements. Report distributions and peaks where relevant, not only averages.

Compare game behavior with and without the companion under repeatable conditions. Record frame-time and low-frame-rate behavior in addition to average FPS. Disclose normal test variability. Test repeated matches and a sustained session before concluding that the application has no leak.

**Open budget decision.** Exact MB, CPU, frame-time, startup, disk, network, and battery targets remain open. Record them before release testing, using representative target devices and workflows. Do not claim "lightweight," "zero FPS impact," or superiority over another application without the corresponding measurements. Any competitor comparison must use a reproducible, equivalent configuration.

**Acceptance.** Approved numerical budgets exist, the complete process tree meets them in each shipped mode on both advertised platforms, sustained-session evidence is retained, and expensive optional features have separately visible costs and off switches.

### C-09: replay, recording, and video connections

Connect play sessions to the platform's review evidence without making capture a mandatory background workload.

The baseline should support opening linked recordings, external timestamps, and existing authorized clips. Where supported and permitted, a later module can attach a local recording or bookmark to the canonical match and game clock. A bookmark without a usable recording should remain a note, not pretend that a clip exists.

Recording, replay buffering, screen capture, microphone capture, game audio, and uploads need separate understandable controls. Recording should be opt-in. Do not capture the entire desktop or microphone merely because match review is enabled. Show when capture is active and provide an immediate stop action.

Specify disk quotas, retention, save location, low-storage behavior, upload limits, interruption recovery, and account ownership. Defer encoding, indexing, and uploads during play unless the user explicitly enables a separately benchmarked mode. Private footage must not be uploaded or reused for training by default.

Video processing should reuse the evidence service and job accounting in the web platform. Platform-specific capture support is a release matrix item, not a reason to block ordinary statistics or manual clip links on either OS.

**Acceptance.** A supported recording or link can open at the correct reviewed moment, users can see and control capture, storage, and upload behavior, and turning capture off removes its background workload. Unavailable capture never disables the basic companion.

### C-10: settings, notifications, accessibility, and diagnostics

Give users direct control over the application's behavior and make failures understandable.

Provide explicit settings for startup, close and quit behavior, background operation, quiet mode, refresh activity, notifications, shortcuts, optional overlays, recording, upload timing, cache limits, account and workspace selection, and optional diagnostic reporting. Defaults should favor a quiet, low-resource experience.

The companion should support keyboard navigation, readable scaling, visible focus, a text or table alternative to important charts, and reduced-motion preferences. Window layout should remain usable on different screen sizes rather than reproduce a wide website inside a small fixed window.

Offer a local status page that identifies integration health, current data freshness, active jobs, enabled optional modules, and resource-test information where available. Errors should identify the affected feature and recovery action without asking users to disable security protections.

Diagnostic bundles should be user-initiated, reviewable, and redacted. Include component versions and relevant error codes, not authentication tokens, private report contents, recordings, or unrelated process information. Recording and usage telemetry must not be conflated with necessary application diagnostics.

**Acceptance.** A user can identify and disable every optional background feature, understand an unavailable integration, export a safe diagnostic report, and operate the main preparation and review workflow without relying solely on mouse interactions.

### C-11: packaging, updates, and maintenance

Make installation and ongoing updates predictable on both supported operating systems.

Publish versioned installers and a support matrix covering OS versions, architectures, integrations, and known limitations. Define platform-appropriate signing and distribution checks before public release. Keep signing keys and provider credentials in controlled release infrastructure, not in the desktop package.

Updates must verify authenticity and integrity, preserve compatible user settings, and have a documented recovery path. Do not install or restart during a match or silently grant new permissions. When automatic game detection is unavailable, use an explicit choice to defer or install rather than assume it is safe to restart.

Version the shared service contract and local storage schema. Define which application versions remain supported and how an incompatible or security-sensitive version degrades. A rollback must not revive revoked access or write newer saved-work data using an incompatible schema.

Disable a broken optional adapter independently where feasible. Update failures should leave a usable last-supported application or a specific recovery screen. Uninstall should stop helpers and startup entries and offer a clear choice about local user-owned data. It should not silently delete cloud reports or the user's account.

**Acceptance.** Install, upgrade, interrupted update, unsupported version, logout, and uninstall scenarios pass on each supported platform. An in-game session is not interrupted by automatic installation. Signed release artifacts and recovery evidence are retained.

### C-12: minimum desktop release and acceptance matrix

Ship a complete small companion before adding resource-intensive optional features.

The proposed minimum desktop release supports installation on Windows and macOS, shared platform sign-in, and manual selection of an authorized player. Users can open a profile and saved build, enter explicit quiet mode, review a completed match, and synchronize a note or scenario. They can quit cleanly. Automatic client detection can join that slice only when the integration gate is satisfied.

This slice should not require an overlay, recording, automatic video analysis, local model execution, rune import, or live recommendations. Those features remain documented product options with separate activation decisions. The application should be useful without them.

Maintain a release checklist for both OS targets covering the user journey, support matrix, accounts and permissions, source freshness, offline behavior, update recovery, cancellation, usage metering, accessibility, and full-process resource measurements. Test client-unavailable and permission-denied cases as ordinary supported states, not exceptional afterthoughts.

**Acceptance.** A user completes the preparation-to-review journey on both advertised platforms with identical shared analysis, no compulsory optional integrations, and measured compliance with the accepted resource budgets. A single-platform beta is labeled as such until the second platform passes the same core acceptance gate.

## How the categories work together

### Connected workflows

| Starting point | Next step | Shared information |
| --- | --- | --- |
| Esports player profile | Open a verified ranked profile | Canonical player identity and verified account link, with separate competition context. |
| Team draft history | Examine a player's champion-specific evidence | Champion, role, patch, participant, and pre-draft information cutoff. |
| Personal or professional match | Open a purchase point in the simulator | Observed inventory, gold and level where available, time, patch, and known enemy state. |
| Saved build scenario | Compare with actual matches | Scenario constraints, mechanics version, and compatible observed samples. |
| Scouting comparison | Open supporting clips and games | Metric definition, selected sample, evidence references, and permissions. |
| Tournament forecast | Inspect the team-strength basis | Snapshot, model and configuration, roster assumption, identities, and cutoff. |
| Improvement focus | Review subsequent relevant games | Stable metric definition, selected context, and dated baseline. |
| Website preparation page | Open the saved plan in the companion | Account and workspace, player and champion, patch, scenario revision, and access checks. |
| Desktop match completion | Open the personal match review | Canonical match identity, data-ready status, participant context, and idempotent job reference. |
| Companion purchase review | Run a shared build comparison | Observed purchase state, known information cutoff, simulator version, and usage accounting. |
| Optional desktop bookmark or capture | Open a video evidence moment | Match and video link, game-clock offset, capture permission, and retained recording availability. |
| Desktop review note | Continue on the website or in a private scouting report | Versioned saved work, provenance, conflict handling, and unchanged permissions. |

### Distinct entities and contexts

An organization, a five-player lineup, a person, and an account are different entities. A match, a game within a series, and a tournament are different levels of evidence. Keeping them distinct prevents a transfer, reserve appearance, or series format from corrupting analysis.

A professional player's solo queue can inform preparation without being treated as identical to stage performance. A simulated damage advantage can inform item comparison without becoming an expected match win-rate increase.

A locally detected game account is not automatically a verified person or authorized workspace user. A game-ended event is not a complete match record. A desktop installation is an interface and permission context, not a new competing source of truth for ratings or saved analysis.

### Common evidence object

Every assessment should support a reference to a common analysis record containing the question, entity and context, selected data, calculation version, result, assumptions, limitations, and source evidence.

For example, a scouting report should reference the same saved build simulation the player can open, not copy its number into an unrelated database. A historical report may remain pinned to its original evidence while displaying that a newer analysis exists.

### Integration acceptance test

A representative end-to-end test should start with an esports player, open a verified account, inspect a match, create a valid purchase scenario, save its result, open it in the Windows and macOS companion, add an authorized review note, and return to the website to attach the evidence to a report. The player, match, patch, source, calculation version, and permission context should survive each transition.

A second journey starts with a saved plan in the companion. The user prepares, enters quiet mode, and completes a match whose data is initially pending. Once data is available, the user opens the review and synchronizes an improvement focus. Test both OS targets and include revoked permissions, an old patch, offline operation, duplicate client events, and interrupted jobs.

These tests demonstrate integration. Sharing a navigation bar or embedding the website alone does not.

## Replay, video, pathing, and leveling

### V-01: evidence navigation

Connect findings to relevant gameplay without making video processing a prerequisite for all analytics.

The initial evidence workflow can support external video links, manually added timestamps, annotations, and available structured match events. The companion should open those same references without needing to record anything. Later versions may add opt-in local capture, uploaded recordings, and automatic detection where access and reliability permit. Capture lifecycle and resource requirements are specified in C-09.

A clip reference should contain the match, video source, timestamp interval, viewpoint, patch where known, access permissions, and any timing offset between the recording and game clock.

### V-02: pathing and gameplay sequences

Desired review areas include jungle routes, camp sequencing where observed, recalls, lane movement, objective setup, purchases, ability leveling, and fight sequences.

Position samples do not establish continuous movement. An observed action does not establish the player's intention. Broadcast footage may omit relevant information, and a full-information replay should not be used to judge a decision as though the player had that same information at the time.

Path comparisons should therefore disclose viewpoint, time resolution, missing intervals, and whether the path is observed or inferred. Reference routes should match relevant role, champion, patch, and game conditions rather than be labeled universally optimal.

### V-03: leveling analysis

Ability leveling belongs in both match review and simulation. Users should be able to inspect an observed skill order, compare supported alternatives at relevant levels, and see the effect on a defined combat sequence.

The simulator should enforce champion-specific leveling rules in its supported ruleset. A different skill order may affect more than modeled damage. Unmodeled utility or gameplay consequences should remain visible as limitations.

### V-04: automatic video analysis

Automated event detection, clip extraction, path reconstruction, and narrative review are gated expansion features. Each requires an evidence source, evaluation dataset, accuracy measure, and failure behavior.

A detected event should carry detection confidence separately from confidence in the resulting gameplay assessment. Users should be able to correct an annotation without rewriting the original source evidence.

Processing should be asynchronous, cancelable, bounded in cost, and permission-aware. The absence of a video should not prevent a profile or build comparison from working. Private recordings should not be reused for shared models without a separately authorized arrangement.

**Acceptance for V-01 through V-04.** Users can move from a supported finding to the relevant gameplay evidence, and the system clearly marks missing visibility, inferred events, and unsupported automatic analysis.

## Shared data and analysis foundation

### D-01: logical entities

The following is a proposed domain model, not a mandate for a particular database or service architecture.

| Entity | Responsibility |
| --- | --- |
| Person or player | Stable identity, aliases, and verified links to accounts. |
| Game account | Source and platform identifier, display history, ownership verification, and access state. |
| Organization or team | Competitive identity and dated aliases. Separate from one lineup. |
| Roster or lineup membership | Player, team, role, effective dates, and observed versus officially confirmed status. |
| Competition, event, or stage | Season, ruleset, region, participant structure, schedule, and bracket context. |
| Series and game | Distinct outcome units, participant identities, timestamps, format, and source references. |
| Player-game observation | Champion, role, items, statistics, timeline availability, and field-level coverage. |
| Draft state or action | Picks, bans, order, participants, restrictions, and information cutoff. |
| Patch or mechanics ruleset | Versioned champion, item, rune, ability, and supported interaction definitions. |
| Metric definition | Formula, units, aggregation, eligibility, comparison population, and limitations. |
| Analysis snapshot | Data and configuration versions, scope, provenance, output, and generation and coverage timestamps. |
| Build scenario or result | Declared inputs, purchase constraints, search configuration, output, and reproducibility record. |
| Video or annotation | Recording reference, timing, viewpoint, provenance, confidence, and access controls. |
| Workspace, report, or focus | Saved user work, evidence references, permissions, and version history. |
| Entitlement or usage record | Allowed capabilities, metered work, quota state, and billing reference. |
| Desktop installation or session | Application and OS version, narrowly necessary capability state, user-authorized settings, and revocable session reference. |
| Local integration event | Adapter and version, observed client state, timestamps, confidence of match mapping, and deduplication key. Never assumed to be a complete match record. |
| Sync revision or pending operation | Saved-object version, originating authorized session, conflict state, and an idempotent operation key. |
| Capture artifact or bookmark | Match and video reference, game-clock mapping, local versus uploaded status, consent, retention, and missing-recording state. |
| Capability or release matrix | Supported OS version and architecture, integration and mechanics scope, application and service compatibility, and validation record. |

### D-02: source contracts and coverage

Each provider integration needs a documented contract that defines available fields, historical coverage, update behavior, source identity rules, error handling, usage rights, rate limits, and retention restrictions. Existing repository support for a provider does not establish commercial rights for every new use.

Build a field-to-feature coverage matrix before promising a feature. For example, a source with final inventories but no purchase events cannot support an exact purchase timeline. A source with match outcomes but no complete drafts cannot support all draft-order analyses.

The 17 October 2026 source check described Data Dragon as a source of versioned champion, item, and rune assets and data. It noted that updates can lag game patches. Use it as one checked input rather than assume it establishes a complete, immediately current simulation ruleset. [P2]

For each mechanic, retain its evidence, implementation version, supported patches, and validation status. A mechanics catalog and a statistics feed solve different problems.

### D-03: identity and temporal correctness

Use stable source identifiers and a reviewed canonical mapping. Names should help discovery, not silently establish identity. Preserve aliases, source conflicts, and reversible corrections.

Record both when a game or roster event happened and when the system learned about it. This supports analysis reconstructed from corrected historical data and analysis restricted to evidence available at an earlier time.

Forecast receipts need a demonstrable pre-play publication basis. Recomputing an old prediction after the outcome is known does not make it an authentic historical forecast.

### D-04: metric contracts

Every published metric should define its formula, unit, aggregation method, valid sample, missing-value behavior, comparison population, patch and time window, direction of interpretation, and descriptive or model-adjusted status.

Zero and missing are different states. An average of per-game ratios is not interchangeable with a ratio of pooled totals. Source coverage should be counted per metric, not assumed from the existence of the match row.

A model feature and a user-facing diagnostic can share source data without having the same meaning. Adding another correlated statistic should not silently count the same evidence twice in a composite score.

### D-05: automatic processing and publication

Processing retains raw evidence from a source check or authorized import. It reconciles identities, validates coverage, and produces versioned analytical inputs. Profile, rating, and report calculations use those inputs. Publication preserves a coherent version with visible freshness and health information.

Use incremental processing where validated, with correction and backfill paths and a full rebuild comparison. A refresh should be idempotent. Repeating the same input must not duplicate games, usage charges, or rating updates.

Publish compatible outputs together. Maintain a recoverable last-valid version and distinguish a failed health check from changed match content. Historical reports may remain pinned while newly generated reports use corrected data.

### D-06: privacy and lifecycle

Public-source observations, account-authorized data, private team uploads, and user annotations need separate permission classes. Enforce permissions in retrieval, exports, caches, reports, and background jobs, not only in page navigation.

Define retention, deletion, account-unlinking, and source-correction behavior before storing private recordings or profiles. Online access to an embedded private clip must be rechecked after access is withdrawn. Retaining or exporting a copy requires an explicitly agreed retention rule. A disconnected copy cannot be assumed remotely erasable.

Include desktop caches, credentials, pending uploads, local notes, and installation sessions in the lifecycle. Reauthorize deferred operations after reconnecting. Private workspace content should not be cached offline by default until its retention and revocation limitations have been reviewed. Diagnostic and update systems must obey the same privacy boundary.

## Interface and engineering principles

### X-01: product navigation

The web product should have recognizable entry points for esports, players, builds, and saved work. Within esports, rankings, teams and players, matches, and tournaments should remain directly accessible. The companion should use the same labels and object identifiers, with a smaller preparation and review-focused navigation and links to full web views.

The active scope should persist during navigation, including selected patch, season or time window, role, champion, competition, and comparison set. A destination that requires a different scope should explain the change.

Use progressive detail. The overview should answer the main question. An evidence panel should expose definitions and assumptions. Detailed views should support investigation. Core analysis should not require a conversation with an AI assistant.

### X-02: visual and interaction requirements

The team report needs a compact hierarchy with enough detail for comparisons and evidence review. On large screens, content should remain in a readable bounded layout rather than stretch into an unstructured full-width table. On narrow screens, comparisons and detail panels should preserve labels and units.

Charts need readable axes, comparison scope, samples, and non-color-only distinctions. Important limitations should be near the affected result, not buried in a methodology page. Loading, empty, stale, partial, unsupported, private, and failed states should be distinguishable.

Filters and saved comparisons should be shareable where permissions allow. Keyboard access and a usable text or table alternative should exist for important visual information.

### X-03: shared analysis and application boundaries

Shared numerical models must remain independent of desktop lifecycle, capture, local caches, synchronization, and updates. Source adapters, canonical identities, metric definitions, simulations, evidence, accounts, permissions, and usage need clear contracts. Windows and macOS integrations have separate supported-capability boundaries. These requirements do not select a technology stack or require separate services. Existing components remain useful where they meet the requirements.

Heavy historical jobs and simulations should not block interface rendering. Cache keys must include relevant data, patch, configuration, and permission context. Long-running work needs cancellation, progress, bounded concurrency, and clear failure handling.

Run expensive shared calculations through shared services and jobs by default. A local computation can be added when its latency, privacy, cost, and resource tradeoffs justify it and the result uses the same versioned rules. Desktop framework and local communication choices remain open under Q-13. They require a representative two-platform prototype. A framework name alone does not establish a memory advantage. Validate deep links and local messages, minimize exposed native capabilities, and do not let externally loaded content invoke unrestricted native functions.

AI may help explain or retrieve evidence. Numerical calculations and permissions should not depend on generated prose. AI output must cite internal evidence and be invalidated when its basis changes.

### X-04: shared performance and desktop efficiency

Low resource use is a core requirement of category 4 and should also shape the shared interfaces. Do not require every client to load complete historical datasets or run large analyses locally. Small preparation and review payloads should be independently loadable from the full scouting and tournament workspaces.

Measure page payload, first-use latency, filter and comparison latency, browser memory, background CPU, simulation time, ingestion cost, update lag, and total desktop process-tree usage. Separate cold and warm behavior and use representative data sizes. Service-side work displaced from the desktop must still meet cost and latency targets.

C-08 defines the desktop test modes and budgeting process. C-12 defines the minimum desktop release journey. Numerical targets should be approved from measured baselines and target devices before release testing. Neither a small installer nor a responsive empty window establishes that the active companion meets its memory and game-performance goals.

## Monetization and access

### Confirmed commercial direction

The product should offer a useful free baseline and paid access beyond some combination of functionality, analytical depth, usage, and organizational needs. Exact prices and quotas have not been chosen.

The charging boundary remains open. A service or usage tier is the proposed interpretation. Charging based on a particular in-game rank is not a settled decision.

### Proposed tier boundaries

| Access level | Candidate scope, subject to validation |
| --- | --- |
| Free | Basic public profiles, competition tracking, core personal review, core Windows and macOS companion access, methodology and evidence access, and a limited useful simulation allowance. |
| Individual paid | Deeper comparisons, more saved work, larger simulation allowances, advanced trend analysis, and optional video processing, available through web and companion under the same entitlement. |
| Team or organization paid | Private workspaces, candidate lists, shared reports, role-based access, collaborative review, and higher analysis limits. |

A paid tier should add useful analysis or workflow capacity rather than merely hide whether a number is stale or unsupported. Data sources, metric definitions, uncertainty, and essential privacy controls should not become premium-only truthfulness features.

One platform subscription should cover the same analytical capability across web, Windows, and macOS, subject to a documented device and session policy. Do not charge twice for reopening the same existing result on a second interface. Resource efficiency, quit controls, security updates, and the ability to turn off recording or overlays should not be premium-only features. An advertising or bundling strategy must not negate the quiet, low-resource requirement.

### Metering and unit economics

Candidate cost drivers are source access, historical storage, cache misses, simulation compute, video minutes, generated summaries, report generation, and private workspace retention. Measure actual cost per successful workflow before selecting quotas.

Show the expected charge or quota effect before expensive work starts. Distinguish queued, running, completed, failed, and canceled jobs. Define retry and failed-job charging rules explicitly, and make usage records auditable.

Desktop reconnects, repeated game-ended events, or switching to the website must reconcile the existing job before starting another billable operation. Explain offline entitlement limits, queued upload costs, and post-cancellation processing behavior. Keep ordinary synchronization of an existing result separate from a newly requested calculation.

A public API, bulk export, or raw-data resale product is not automatically included in the vision. Such a feature would require separate source-rights and policy review.

## Evidence, permissions, and release quality

### Historical policy checkpoints

The source specification records a limited primary-source policy check dated 17 October 2026. The statements below describe that historical check. They are not a fresh policy audit or approval of this product.

The 17 October 2026 check recorded prohibitions on replacement official skill ladders and MMR or Elo calculators, identification of deliberately hidden players, decision-dictating applications, and previously unknown game-session information. The check recorded specific opt-in for public custom-match history. Otherwise, access was limited to the player through Riot Sign On, or RSO. RSO required production-level API access. [P2]

The same check recorded product registration and review requirements. Monetization required an Approved or Acknowledged status, a free access tier, and added value in charged content. It also recorded a prohibition on betting or gambling functionality. [P1]

Release requires feature-specific review for ratings, live assistance, private-match sharing, or paid access. Do not assume that a research label, a renamed score, or an existing implementation establishes permission. Review third-party dataset, video, logo, and redistribution rights separately with the relevant provider or qualified adviser.

### Methodology validation

| Area | Proposed release evidence |
| --- | --- |
| Descriptive metrics | Hand-checked fixtures, units, missing and zero cases, aggregation rules, and source coverage. |
| Rankings and ratings | Defined target, documented baselines, sensitivity tests, historical scope tests, and uncertainty and eligibility behavior. |
| Forecasts | Chronological evaluation, pre-play information checks, calibration, Brier score and log loss reporting, and breakdowns across relevant contexts. |
| Draft evaluation | Legal-state reconstruction, player-history cutoff tests, sparse-sample behavior, and separation of strength from draft effects. |
| Combat simulation | Independently specified mechanics fixtures, timing and event-order tests, supported interaction matrix, and patch regression checks. |
| Purchase optimization | Feasibility tests plus comparison with exhaustive search on small cases. Honest search-limit reporting. |
| Personal improvement | Consistent baseline and follow-up scopes, evidence-linked findings, and no unsupported causal claims. |
| Video and pathing | Labeled evaluation examples, viewpoint and timing checks, detection error reporting, and correction workflow. |
| Access and billing | Cross-workspace isolation, permission-aware caches and exports, idempotent usage accounting, and failure and retry tests. |
| Desktop core | End-to-end preparation and review on each supported OS version and architecture, client-absent operation, lifecycle correctness, and matching web and desktop analysis versions. |
| Desktop resources | Whole-process-tree benchmarks, sustained-session and leak checks, quiet in-game behavior, and separate overlay and capture budgets against recorded thresholds. |
| Local integrations | Feature-specific permitted-use review, supported interface evidence, account and state changes, stale events, least privilege, and no fallback to invasive access. |
| Sync and device privacy | Conflict handling, sign-out, account switching, pending-operation reauthorization, offline cache rules, token redaction, and private-workspace isolation. |
| Desktop distribution | Installer and update integrity, compatibility gates, interrupted update and recovery, clean quit and uninstall, and no unrequested in-game restart. |

Model accuracy, arithmetic correctness, source completeness, and approval are separate gates. Passing one does not establish the others. An independent reviewer should inspect consequential scoring and simulation changes. Another model's agreement is not certification.

### Cross-product definition of done

A feature is ready for a bounded release when its input coverage and permitted use are known. Its calculation and interface satisfy the specified workflow. Edge cases are tested. Its evidence and limitations are visible. Its resource and cost behavior is measured. Failure and rollback behavior are understood.

The release record should state the supported scope, source and data cutoff, code and calculation versions, validation evidence, remaining limitations, and owner of ongoing maintenance. Desktop releases must also state supported OS versions and architectures, enabled integrations, application and service compatibility, approved resource budgets, and per-platform measurements. Optional capture or overlays need their own acceptance record.

A fixture demonstration is not evidence of live provider coverage. A successful build is not evidence of correct model behavior. A merged pull request is not evidence that its required production configuration or data has been activated.

## Capability dependencies and release boundaries

Delivery consists of complete bounded workflows. Category numbers do not require sequential delivery, and none of the proposed capabilities authorizes immediate implementation or production activation.

Esports expansion depends on verified source coverage, canonical identities, metric definitions, uncertainty, and retained source and snapshot semantics. New descriptive statistics remain separate from scoring until their effect on a score's meaning is reviewed. Draft grades remain experimental until their target, legal alternatives, information cutoff, and evaluation are defined.

Simulation depends on a named champion and mechanics support matrix, independent arithmetic and timing fixtures, feasible purchase transitions, and declared progression assumptions. The level-14 comparison requires an affordable immediate choice and its later consequences. Coverage expands only after mechanics and patches pass validation.

Connected personal analysis depends on permitted account linking and bounded, disclosed match coverage. A match must open a saved purchase comparison, and a finding must support review of a later comparable sample. Scouting adds verified professional identities, reproducible comparisons, evidence access, and private workspace permissions.

Desktop feasibility depends on stable shared contracts, representative Windows and macOS prototypes, permission checks, and numerical resource budgets. It can proceed alongside esports, build, and personal workflows. C-12 defines the minimum complete companion. Advanced draft grading, automatic video understanding, overlays, recording, and client detection are not prerequisites. A core release must still pass both advertised platforms' preparation-to-review, lifecycle, privacy, synchronization, and resource gates.

Automatic video conclusions depend on a useful evidence-linking and manual-review workflow, authorized sources, labeled evaluation data, and measured detection errors. Wider league and queue coverage depends on both data quality and usage rights. Native conveniences require their own permission, reliability, compatibility, and resource evidence. Platform parity never justifies invasive access.

Paid access can precede advanced features once a useful bounded workflow, required approvals, and measured costs exist. New features must preserve the companion's accepted quiet-mode budget. Consequential changes require new whole-process measurements rather than silent budget relaxation.

Feature delivery records need the user outcome, requirement IDs, verified existing basis, scope and exclusions, inputs and permissions, calculation meaning, missing-data behavior, versions, cross-product identifiers, and acceptance evidence. They must also record job, storage, metering, publication, and recovery effects. Desktop records add the platform matrix, game-phase behavior, manual fallback, local permissions, resource budgets, and agreement with web analysis. These records assign release owners and unresolved decisions outside this durable reference.

A descriptive change must not silently change scoring. Synthetic fixtures do not prove provider coverage. Historical reconstruction does not become a pre-play forecast. A successful build or a desktop shell does not establish the full product journey. Installing the core companion must not enable overlays, recording, autostart, new native permissions, or live assistance without the corresponding user choice and release gate.

## Open decisions and principal risks

### Decision register

| ID | Decision still required | Why it matters |
| --- | --- | --- |
| Q-01 | Which audience is the first primary user? The options are esports followers, individual players, coaches, and scouts. | Determines the first complete workflow and willingness-to-pay research. |
| Q-02 | Which competitions, regions, queues, and historical windows are supported first? | Determines data acquisition, coverage claims, and operating cost. |
| Q-03 | Which rating or performance outputs are permitted, and how are they defined? | Determines model design, presentation, and approval requirements. |
| Q-04 | What exactly constitutes a draft grade? | Determines its target, reference alternatives, necessary inputs, and validation. |
| Q-05 | Which champions, mechanics, and combat objectives enter the first simulator? | Determines test scope and whether "best build" claims are defensible. |
| Q-06 | How are default rotations, uptime, and target profiles chosen? | Determines the usefulness and stability of build results. |
| Q-07 | How are accounts and professional identities verified? | Determines whether connected scouting profiles are trustworthy. |
| Q-08 | Which video sources and processing rights are available? | Determines clip linking, upload support, automation, and storage cost. |
| Q-09 | Which functions remain free, and what usage is charged? | Determines product accessibility, unit economics, and billing design. |
| Q-10 | What performance, freshness, and resource budgets apply? | Determines infrastructure choices and release acceptance. |
| Q-11 | What belongs in public profiles versus private team workspaces? | Determines permissions, sharing, deletion, and model-data boundaries. |
| Q-12 | Which Windows and macOS versions and architectures are supported first, and is beta delivery staged? | Both platforms are in scope. This defines the actual test matrix and honest availability claims. |
| Q-13 | Which desktop shell or framework and local integration mechanisms pass representative benchmarks and permission checks? | Determines memory, security, compatibility, and maintenance burden without assuming a framework is automatically lightweight. |
| Q-14 | Which companion functions are available in preparation, champion selection, in-game, and post-game phases? | Prevents a permitted review feature from silently becoming unreviewed live assistance. |
| Q-15 | Which overlays, imports, recording, audio, and upload features are included, and what are their defaults? | Determines consent, independent release gates, performance costs, and platform differences. |
| Q-16 | What can be cached offline, for how long, and how are revocation and conflicting edits handled? | Determines privacy, useful disconnected behavior, and the limits of remote deletion claims. |
| Q-17 | How are desktop releases signed, updated, recovered, and retired? | Determines safe distribution, compatibility, and avoidance of mid-game disruption. |

### Principal risks and required checks

**Data availability and commercial rights.** The product may be able to display final statistics but not reconstruct exact drafts, purchases, paths, or private matches. Verify fields and rights using representative retained examples before promising the corresponding workflow.

**Misleading scores.** A visually polished rating can still measure the wrong thing or mostly reflect team strength and sample composition. Define the target, test alternatives, expose uncertainty, and keep descriptive metrics separate from claims about underlying ability.

**Simulation maintenance.** Patch changes and interactions between champions and items can invalidate results. Maintain a versioned support matrix, independent fixtures, and a visible incomplete or unsupported state.

**Personalization without evidence.** Generic match history may not reveal attack uptime, execution, or intention. Only derive supported inputs and allow user overrides. Do not invent player-specific mechanics.

**Source and identity errors.** Transfers, team aliases, duplicate records, and unverified accounts can distort scouting. Retain source provenance and reversible mappings, and test these cases explicitly.

**Scope growth.** A professional scouting suite, simulator, personal analytics site, two-platform companion, and video system are several substantial workflows. Deliver bounded complete workflows, with shared contracts, rather than partially implementing every screen. Keep optional native features out of the companion's minimum release slice.

**Cost and reliability.** Unbounded simulation, history refresh, or video processing can overwhelm the service. Measure representative workloads, introduce cancellation and quotas, and preserve a usable last-valid state during failures. Moving work off the desktop reduces one budget only if the service cost, latency, and availability remain acceptable.

**Desktop resource regression.** A small prototype may become expensive once authentication, web content, helpers, overlays, and recording are active. Benchmark the whole application, repeated sessions, and game frame times after consequential changes. Do not relax budgets silently.

**Native integration and distribution.** Client changes, unsupported interfaces, malicious local messages, or a faulty update can disrupt the application or game session. Isolate adapters, minimize privileges, validate native boundaries and update authenticity, and preserve a manual fallback on each OS.

**Offline privacy.** Cached private reports or recordings can outlive a disconnected session's authorization. Default to no offline private-team cache until retention is explicitly designed, reauthorize queued work, and document that disconnected copies are not instantly remotely revocable.

**Permissions and trust.** Public availability of one record does not grant every downstream use. Separate data rights, product approval, account authorization, and private workspace access. Independently check the consequential uncertainties before launch.

## Requirement relationships

| Component IDs | Product responsibility | User intent supported |
| --- | --- | --- |
| E-01, E-02 | Team and professional-player profiles. | U-02, U-03, U-05, U-13 |
| E-03, E-04 | Ratings, histories, comparisons, and strengths and weaknesses. | U-03, U-05, U-13 |
| E-05 | Draft intelligence and preparation. | U-04, U-05 |
| E-06 | Candidate scouting and reports. | U-02, U-05, U-10 |
| E-07, E-08 | Competition tracking, supported forecasts, and automatic reports. | U-02, U-06, U-13 |
| B-01, B-02 | Scenario definition and combat calculation. | U-07 |
| B-03, B-04, B-05 | Purchase paths, level progression, and fight windows. | U-07, U-08 |
| B-06, B-07, B-08 | Observed builds, personalization, and reusable scenarios. | U-01, U-05, U-07, U-10 |
| P-01, P-02, P-03 | Personal identity, history, and contextual performance. | U-05, U-09 |
| P-04, P-05, P-06 | Recurring patterns, improvement, and scouting connections. | U-05, U-09, U-10 |
| C-01, C-02, C-03 | Windows and macOS application, authorized accounts, and gated client lifecycle integration. | U-01, U-06, U-12 |
| C-04, C-05, C-06 | Preparation, quiet in-game behavior, optional displays, and connected post-game review. | U-01, U-07, U-09, U-10, U-12 |
| C-07, C-08 | Versioned synchronization, bounded offline access, and measured resource efficiency. | U-01, U-12 |
| C-09, C-10 | Optional capture and evidence connections, controls, accessibility, and safe diagnostics. | U-10, U-12 |
| C-11, C-12 | Packaging, updates, platform support, and a complete desktop release slice. | U-12 |
| V-01, V-02, V-03, V-04 | Video evidence, pathing, leveling, and gated automation. | U-10 |
| D-01 through D-06 | Shared identities, source contracts, metrics, processing, and privacy. | U-01, U-05, U-06, U-10 |
| X-01 through X-04 | Connected interface, engineering boundaries, and resource efficiency. | U-01, U-12 |
| [Monetization and access](#monetization-and-access) | Free and paid access and usage economics. | U-11 |

## Primary sources and observation dates

The source specification records these primary-source checks on 17 October 2026. This document retains their basis without claiming a new policy check. Product review, data rights, commercial agreements, account authorization, and private workspace permissions remain separate gates. Policies and source capabilities require a new check before a dependent release.

| Reference | Source | Historical use |
| --- | --- | --- |
| P1 | [Riot general developer policies](https://developer.riotgames.com/policies/general) | Product review, monetization, free access, added value, and gambling restrictions. |
| P2 | [Riot League of Legends documentation and policies](https://developer.riotgames.com/docs/lol) | Ranking and game-integrity limits, custom-match access, Riot Sign On, and Data Dragon versioning. |

The historical repository assessment supports the reuse constraints above. Its source-file inventory, inspection log, and implementation reports are not continuing product requirements.

[P1]: https://developer.riotgames.com/policies/general
[P2]: https://developer.riotgames.com/docs/lol
