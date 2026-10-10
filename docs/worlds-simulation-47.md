# Worlds simulation and hub journey (#47)

This implementation exposes supported Worlds advancement forecasts in the opt-in
tournament hub. It retains the full nineteen-team 2026 field, preserves confirmed
Play-In/Swiss/knockout results and draws, and uses the existing published/internal
probability chain with frozen strength. It does not certify a full pre-event
2026 title forecast. The primary Swiss draw text still leaves material random
procedure choices unspecified, so those later-stage probabilities are unavailable.

## Rule evidence and supported boundary

Checked 9 October 2026: Riot's [Competitive Operations library](https://competitiveops.riotgames.com/en-US/library)
still lists the [2026 World Championship Event Specific Ruleset v1.0](https://cdn.sanity.io/files/dsfx7636/news_live/faa5ce974e58615911fbee931c6123e2785a8b46.pdf),
published 31 August 2026. The PDF SHA-256 is
`3907cf8389be3a06ff895ce863fb02346d5c9eac9a025595a77793222aa35eab`.
The engine records this source digest, descriptor IDs and check date in its run.
Earlier stage audits remain in [Play-In](worlds-2026-play-in-47.md),
[knockout](worlds-2026-knockout-47.md) and [2022 groups](worlds-2022-observed-groups-47.md).
Riot's [Worlds 2026 Primer](https://lolesports.com/en-US/news/worlds-2026-primer)
was also checked. Its initial Swiss/round draws sections confirm matched pools,
same-record opponents and rematch restrictions, and its quarterfinal section
confirms the two-step knockout draw. It does not define the missing Swiss slot
displacement, look-ahead or waiver distribution. Its real team names have not
been activated as fixture or forecast inputs.

| Rule | Implementation and regression evidence |
| --- | --- |
| §§4.2.1/4.2.2: four Play-In and fifteen direct seeds | `worldsSimulation.ts` requires nineteen distinct entrants and the complete 2026 seed sets, including LCP/CBLOL. Missing entrants block the event. |
| §4.1.1: Play-In winner enters Swiss | Existing exact Play-In engine supplies advancement and exclusive 17/18/19 finishes. Observed final winner must equal Swiss's Play-In entrant; chronology and cross-stage IDs are checked. |
| §4.3.2.1: four specific 2026 Swiss pools | `worlds2026Swiss.ts` uses the current pools, not 2025 tiers. Round one pairs 1–4 / 2–3, with no intra-region match. |
| §§4.1.2/4.3.3.1: equal records; three wins/three losses | Every observed draw contains each active team exactly once. Prior rounds must be complete. Round three uses Bo3 for 2–0/0–2 and Bo1 for 1–1; rounds four/five use Bo3. Reference replay yields exactly 2/3/3 qualifiers at 3–0/3–1/3–2. |
| §4.3.3.2: no rematches; possible official waiver when no eligible draw exists | Unobserved waivers are never chosen. A supplied waiver must name the exact repeated pair and carry evidence. It is rejected if a non-rematch pairing exists in that record bucket. The bounded existence check supplies no probability distribution. |
| §§4.3.2.3/4.3.3.2: drawn team moves to next available slot, including a conflict forced by a future draw | **Unavailable for simulation.** The text does not define the slot displacement/look-ahead order or how officials choose a waiver. Both paragraphs were checked in the current primary PDF. No uniform legal matching, rejection sampling, guessed redraw or prior-year rule is substituted. |
| §4.3.4: unrestricted knockout random pairing | From a known final Swiss draw or completed Swiss field, sample the two 3–0 opponents from three 3–2 teams without replacement, then randomly pair the remaining four. Anchor the 3–0 matches on opposite halves. This yields 36 distinct relevant brackets, each with probability 1/36. |
| §4.1.3/Appendix A: fixed Bo5 bracket | Sample winners along the existing seven match links; never re-seed. A supplied knockout draw instead uses the existing exact enumeration, with confirmed results fixed. |

The knockout calculation's 36 outcomes follow directly from the unrestricted
procedure: six ordered opponent selections, then six ordered placements of two
unordered remaining pairs on the two halves. Permuting the four remaining teams
has 24 equally likely orders, with four orders per placement. Exchanging the
names of the two halves cannot change neutral-model advancement or title odds.
This reduction makes no assertion about the restricted Swiss draw distribution.

Before a known round-five Swiss draw, exact Play-In-to-Swiss odds and observed
Swiss standings remain useful. Knockout/title aggregates stay unavailable when
their unresolved path requires an uncertified Swiss draw. From a known round-five
draw, all remaining Swiss matches are Bo3 qualification/elimination matches and
no further Swiss draw is needed. That is an explicit conditional forecast, not
a full pre-event forecast. A completed event is deterministic without ratings.
Unfinished series scores are rejected; no live game-state conditioning is claimed.

## Data and run contract

The UI reads an optional version-1 companion at
`/tournament-data/worlds/<URL-encoded event ID>.json`. Its types and structural
parser are in `worldsArtifacts.ts`. It pins event ID, information cutoff, state
revision, direct-entrant and per-stage evidence and the selected feed event's content key. Feed
corrections invalidate the companion and mounted worker. Missing or incoherent
companions leave the schedule useful with a specific unavailable explanation.
The 2026 result `matchId` reuses the shared schedule `series.id`. A matching
content key does not override a missing result or a conflicting team, winner,
score or best-of. Live and unresolved played-game evidence blocks advancement
forecasts until game-state conditioning is supported; it is not treated as an
unstarted series. A source `complete`/`completed` series whose normalized result
is unresolved also keeps advancement unavailable until its result is confirmed.
Cancelled source series keep advancement unavailable because this contract cannot
link a cancellation to a replacement, withdrawal, forfeit or adjudicated
advancement. Legitimate cancelled duplicates or replacement schedules remain
unsupported until retained linking evidence exists. Postponement does not imply
cancellation; the schedule and existing match cards remain available.
There is no companion producer, collector, bucket write or source activation
in this change; the source owner must provide a reviewed coherent companion.

Synthetic companions cannot attach to a source schedule, and synthetic evidence
cannot claim `source-observation` mode. The fifteen direct entrants require a
nonempty `directEntrantEvidence` provenance reference even before Swiss begins. Tags remain caller assertions, not source
authentication or permission to publish. Real entrants/draws/results require
licensed retained observations and reviewed canonical identity mappings under #45/#46.

The worker copies the state and model basis for each run. All hypothetical
matchups call `forecastTournamentSeries`; ratings, uncertainty, roster and
model/config never update after hypothetical wins. Snapshot data cutoff must
precede publication, which must precede the event cutoff. Every remaining active
team must have valid model input before any sampled aggregate is returned.
Eliminated teams' ratings are unnecessary. Side/pick rights and draft decisions
remain disclosed model limits, rather than invented advantages.

The downloaded run contains the supplied state/evidence, source/rule digest,
engine version, uint32 seed, snapshot/model/config/identity metadata, model
parameters and rating scale, frozen hypothetical inputs/probabilities, exact
counts, unrounded probabilities and elapsed time. It is local evidence, not a
published pre-match receipt or calibration eligibility claim.

Cumulative probabilities have field totals 16/8/4/2/1. Exclusive finish buckets
have totals 1/1/1/2/3/3/4/2/1/1 for 19th through champion and sum to one per team.
Observed advancement/elimination labels are distinct from estimates. Zero
sampled wins cannot establish elimination. Marginal 95% Wilson intervals retain
a positive upper bound at zero and describe sampling error only, not model
confidence or calibration. Observed stage outcomes have no sampling interval;
sampled zeros/ones cannot set the observation flags. Exact enumeration has no
sampling error.

## Worker and historical behavior

Sampling is bounded to 10,000 trials and yields approximately every 16 ms in a
dedicated worker. Cancellation terminates that worker, including synchronous
setup. Its handlers are invalidated first, so queued old progress, results and
errors cannot publish. Event/model changes, same-key schedule refreshes and navigation run the same
cleanup. A refresh clears the previous artifact and probabilities before loading
its companion. Rejected or timed-out companions cannot retain a rerunnable
baseline, and an old worker cannot replace that unavailable state. Run simulation
revalidates the companion before starting a new worker.
Four completed baselines are cached by the full state, basis and options. No
100,000-trial option is enabled without its own benchmark and acceptance evidence.
The UI uses shadcn cards, controls and tables; only finite text progress is shown.
Current draw/bracket links are visible, with older draws/results collapsed.

Worlds 2022 uses the existing separately sourced group replay in the worker.
The hub shows historical group labels, observed records and two clear qualifiers.
It does not apply modern Swiss rules or today's ratings to past matches. Boundary
ties remain `tiebreaker-rules-unavailable`, including complete twelve-game groups.
Extra tiebreaker games, certified group-to-fixed-bracket routing and dated past
model snapshots remain precise source/input gates. A historical cutoff in a
companion is a supplied evidence assertion; it is not independent temporal proof.
No historical forecast is synthesized from current data.

## Verification record

Verification uses `verify-lol-esports`. Max explicitly requested this existing
checkout, so no extra worktree was created. The owned fixture server uses
middleware and `publicDir: false`; it does not replace ignored public data.
Node is 24.21.0; pnpm is pinned 11.16.0. Frozen offline dependency verification
passed with scripts disabled. The browser harness's pinned Chromium was installed
after the first attempt found no matching browser executable.

- Focused format/model/reference suite: **68 passed**. It includes the new Swiss
  and composition checks plus all existing Worlds formats, tournament provider,
  public matchup and published-scale regressions. Tests cover deterministic
  completed and partial events, all entrants, corrupt state, cross-stage handoffs,
  probability overflow, missing inputs, abort, seeded counts, conservation and
  independent fair-model reference probabilities.
- Typecheck, affected lint and repository-wide lint: **passed**, including the
  final companion score/live validation. No existing nesting/branching metric
  rules are configured in the project ESLint or required workflow.
- Initial automated fixture browser journey: **passed**. It covers off-thread
  calculation, cancellation below 250 ms, no stale completion after cancellation,
  restart, source correction, completed event, incoherent-state fallback,
  pre-event Swiss unavailability, 2022 groups/ties and navigation to Matches.
  A later changed-artifact run timed out during severe VM memory pressure while
  repository lint was running. Its timeout is retained separately from the passed
  journey. Final isolated verification and model-error evidence are recorded in
  the local evidence directory below.
  The expanded journey also passed source refresh during a restarted run and
  navigation during computation (207.4 ms); cancellation was 27.6 ms in that
  run. These are fixture measurements, not official event acceptance.
  Final affected checks passed with sampling progress established before
  source refresh/navigation, plus confirmed-score coherence and live-state
  fallback. Cancellation was 20.4 ms and navigation 161.9 ms. The engine/worker
  precision rerun passed all eleven checks; the final companion/browser run
  passed all four checks. Observed cells were verified to have no Wilson interval.
- T3 collaborative preview: HTTP 200 for `/` and `/data/ranking-summary.json`,
  browser reachability and nineteen probability rows confirmed. No page overflow
  at 320/390/768/1280 px. The synthetic model run took about 1.30 s for 10,000
  trials, about 7,686 trials/s. Approximate whole-page JS heap was 50.4 MB; this
  is not worker peak memory or a production-size memory promise. T3 cancellation
  acknowledgement was 33 ms on a new state revision. The isolated automated
  rerun also passed with cancellation at 18.5 ms, including model-error fallback.
- Node synthetic fair-model benchmark: 10,000 trials in 669 ms, about 14,953
  trials/s, 101 MB peak process RSS including tsx. Stage totals were 16/8/4/2/1
  before display rounding. These are fixture/environment measurements.
- Production build: **passed** through the coding-vm Fleet helper with a
  3 GiB group cap, zero build swap and 1 GiB Node heap. It verified
  `dist/index.html`, emitted the dedicated Worlds worker and passed the bundle
  budget. The final run took 33.4 s with about 1.2 GiB peak group memory and zero swap.
  Earlier admission returned exit 75 while a foreign Auto Cron held the slot.
  No controls were bypassed and no foreign process was stopped.
- Full suite: **1,066 passed, 14 skipped, zero failures**. The guarded run uses
  the repository's complete test discovery,
  pinned reference data and serial browser order, with `--test-concurrency=1`.
  Native Rust integration skips remain conditional on a configured worker
  binary; they are not claimed as native verification. All four browser journeys
  passed. The run took 3 min 24 s, with about 1.4 GiB sampled peak group memory
  and zero swap. Final changed assertions were rechecked separately as above.
- This local verification record was completed on 9 October, before PR delivery
  and independent review. Current hosted CI and review evidence belong to the
  implementation PR and its reviewed head. Fixture acceptance does not establish
  official/live product acceptance.

### PR review repairs (10 October)

Two independent GPT-6.1 Sol agents reviewed the full diff, regressions, dead code
and redundant tests. Review identified three P2 defects: same-key companion
refresh retained the old forecast/worker, direct qualifiers lacked required
provenance before Swiss, and terminal source series with unresolved scores were
sampled as unplayed. Adjacent source-cancellation handling has the same last
root cause and now has an explicit unsupported boundary.
The lifecycle now has one request/worker owner; refresh invalidates
both and clears the baseline. The input, parser and source-label checks require
`directEntrantEvidence`. No compatibility path was added: this new companion
contract has no activated producer or stored published consumers.

The refresh and provenance repairs passed independent source verification.
The affected engine/client suite passed 15 tests with zero failures or skips.
Independent terminal/cancellation loader and feed checks passed 29 tests with
zero failures or skips. Affected lint passed after each repair.
The expanded browser regression covers valid-to-incoherent same-key refresh,
active sampling-to-request timeout, persistent unavailable state and recovery.
Its local run is pending: the Fleet helper returned admission exit 75 while a
foreign build owned the slot. No product test was launched on those admissions.
Hosted checks on the repair revision must establish runtime regression and
current type/build results before technical merge readiness. Earlier local
checks above remain evidence for unchanged code, not for the new browser path.

Local redacted evidence is retained in the Git-excluded
`.agents/artifacts/worlds-simulation-20261009/` directory. The two unrelated
regression review artifacts remain untouched. Implementation reconciled current
upstream first, including the merged #90 Power preview, and preserved the app's
binding to this checkout on main. A final upstream fetch found no base divergence.
The evidence directory also contains `implementation.patch`, including all new
files as well as the tracked diff, for local review without changing the binding.
No owned fixture server, browser preview or build process remains running.

## Remaining actions

The Worlds rules/source owner must obtain primary clarification of the Swiss
sequential displacement/look-ahead/waiver procedure before enabling full pre-event
later-stage forecasts. The same owner needs historical tie/bracket clauses and
as-of observations/model inputs. The #45/#46 source/delivery owner supplies
licensed observations, a coherent companion producer and verified real mapping
and publication evidence. The implementation owner delivers/reviews the change
through its PR, with hosted checks and native Rust conditions kept separate.
Max owns activation/deployment decisions.
#47 stays open: these supported forecasts and fixture checks do not complete
all of its full-event, historical and live acceptance conditions.
