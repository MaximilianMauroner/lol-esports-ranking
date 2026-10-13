# Worlds 2026 Swiss scenario preview

The Tournaments hub has a **Swiss preview** view for the Worlds 2026 Main Event. It is
available by default and does not need the forecast flag. The user chooses match
winners and valid draws, then sees records, advancement, elimination placings
and the quarterfinal draw groups. Two scenarios, A and B, can be compared,
copied and reset.

The preview is deterministic. It shows no odds and no win probabilities.
Riot's ruleset does not define the Swiss draw procedure precisely enough to
weight one valid draw over another (see the draw gap in
[the simulation notes](worlds-simulation-47.md)), so the preview only enforces
the rules that the ruleset defines.

## Starting points

- **Live draws and results.** Read from the Leaguepedia schedule feed for the
  Worlds 2026 Main Event (`Round 1` to `Round 5` series). This is available only
  when all eight Round 1 matches name two different teams. Each later round is
  used only when its full draw is published, the previous round is complete,
  and the draw follows the rules below. If a published draw breaks the rules,
  the live starting point is unavailable and the page says why. A partly
  published draw, or a round with fewer published matches than its size, is
  ignored with a note. The earlier rounds stay in use.
- **Qualified teams before the draw.** The sixteen Swiss seeds (§4.3.2.1 pools),
  each shown with its confirmed team, for example Gen.G in LCK 1 and G2 Esports
  in LEC 1. The teams come from the Round 1 draw tiers in
  [Riot's Worlds 2026 primer](https://lolesports.com/en-SG/news/worlds-2026-primer),
  which match the seed pools, and from the
  [CBLOL final](https://www.techtudo.com.br/noticias/2026/10/final-do-cblol-2026-los-bate-furia-em-revanche-do-primeiro-split-e-e-campea-edjogos.ghtml)
  on 10 October, which put LØS in CBLOL 1. They were checked on 13 October 2026
  and are listed in `QUALIFIED_TEAMS` in `swissScenario.ts`. The names match the
  team branding data, so the bracket shows each team's code and logo. The
  sixteenth place stays "Play-In winner" until the Play-In ends (15 to 18
  October) and the live draw names it. The user chooses the Play-In winner's
  region (§4.2.1: CBLOL, LCS, LEC or LCP) so that the Round 1 region rule applies
  to that slot. Until a region is chosen, the slot meets only a Pool 1 team from
  outside those regions (Gen.G or Anyone's Legend), so the draw stays valid for
  any Play-In winner.

  Saved scenarios and the draw rules use the seed slot IDs, not the team names,
  so the names do not change shared links.

Live draws and results are never editable. When a live result arrives for a
match the user had picked, the live result replaces the pick and the page says
so. A newly published live draw never changes a scenario built on seed slots:
saved picks apply only to the starting point they were made for.

If live draws become unavailable while the page starts from them, for example
because a new feed breaks the draw rules, the page shows only the start choice
and the reason. The live scenarios stay in the page address unchanged and come
back when live draws return. Choosing qualified teams starts two new scenarios.

## Bracket

The preview shows the whole Swiss stage as one bracket, the usual Swiss stage
diagram:

- **Columns.** Rounds 1 to 5, then the records after Round 5. Each column holds
  its record groups (0–0, then 1–0 and 0–1, and so on) with their match format
  (Bo1 or Bo3). Advanced groups (3–0, 3–1, 3–2) sit at the top of their column
  and eliminated groups (0–3, 1–3, 2–3, with their placings) at the bottom. In a
  16-team stage the size of each group does not depend on results
  (`SWISS_BRACKET`), so the full bracket is visible before any match.
- **Teams.** Each team shows its logo, code and seed slot. The full name is in
  the row title and in the match name, for example "Round 1: Gen.G against
  CTBC Flying Oyster". Places that no team has reached yet stay empty.
- **Picks.** A drawn round shows its matches inside each record group. A team row
  is the winner control. A picked winner moves to its next record group at once,
  before the next draw. Live results show the winner in green and cannot be
  changed; picks have a dashed outline.
- **Column header.** "Live draw" or "Your draw", "N to pick", and for a preview
  draw "Change pairings" and "Clear draw". The next round to draw shows "Fill a
  valid draw"; later rounds say which round they are drawn after. Before the
  Round 1 draw from qualified teams, Round 1 lists the four pools and which pool
  each one meets.
- **Next step.** A line above the bracket says what the scenario needs next. When
  a round can be drawn, it gives that round's draw rules and any rematch or
  no-valid-draw warning.
- **Standings.** Advanced, out and playing counts for the shown scenario, and a
  table of the teams whose record differs in the other scenario. It sits below
  the bracket, or beside it on screens at least 1700 px wide.
- **Narrow screens.** The bracket keeps its six columns and scrolls sideways in
  its own region; the page itself does not scroll sideways.
- **Controls.** Start from, Play-In region, scenario A or B, Copy, Reset and
  Undo. Undo steps back through picks, draws, Copy and Reset. Back, Forward,
  an edited link and a new starting point clear its history; a Play-In region
  change is not an Undo step.

## Rules applied

All references are to the
[2026 World Championship Event Specific Ruleset v1.0](https://cdn.sanity.io/files/dsfx7636/news_live/faa5ce974e58615911fbee931c6123e2785a8b46.pdf),
SHA-256 `3907cf8389be3a06ff895ce863fb02346d5c9eac9a025595a77793222aa35eab`,
rechecked on 12 October 2026.

| Rule | Preview behaviour |
| --- | --- |
| §4.1.2.1: five rounds, three wins advance, three losses eliminate | Records come from `applySwissWinner` in `worlds2026Swiss.ts`. Rounds have 8, 8, 8, 6 and 3 matches. |
| §4.1.2.1: Bo3 for advancement or elimination matches | `swissBestOf`: Bo3 when a team has two wins or two losses, otherwise Bo1. |
| §§4.1.2.1.3 to 4.1.2.1.5: elimination placings | Out in Round 3: 15th to 16th. Round 4: 12th to 14th. Round 5: 9th to 11th. |
| §4.3.2: Round 1 pools and regions | Pool 1 meets Pool 4, Pool 2 meets Pool 3, no two teams from one region. The Play-In winner without a chosen region is treated as possibly from any Play-In region. |
| §4.3.3: same record, no repeated match | Pairs must share a record and must not have met. A rematch is allowed only in a record group where no draw avoids one, because officials may then waive the rule. The page says when this happens. |
| §§4.3.2.3 and 4.3.3.2: "would force this scenario in a future draw" | A draw is valid only as a whole, so every team in the round must have a valid opponent. The text does not say whether officials also look ahead to later rounds, so the preview does not. |
| §4.3.4: quarterfinal draw | When eight teams have advanced, the page lists the 3–0 teams and the 3–2 teams they can meet on opposite halves. It does not simulate the knockout. |

"Fill a valid draw" takes the first valid pairing in starting-point order. It is
a convenience, not the official draw and not a prediction. "Change pairings"
swaps opponents inside a record group. Options that would break a rule are
shown disabled with the reason.

Changing a pick in an earlier round changes records. A later draw stays only
while its pairs still have the same records; otherwise it and the rounds after
it are cleared, and the page says so. Removing a pick clears every later round.

## Data handling

Scenario choices live in component state and in the page address (`start`,
`playin`, `scenario`, `a`, `b` hash parameters), so a view can be reloaded and
shared. The page reads them again after Back, Forward or an edited link. Each
match is stored as three characters: two team indexes and the winner. For live
draws, the team indexes follow the sorted team names, not the match times, so
a schedule change does not move saved picks to other teams.
The preview sends no requests of its own and never writes to the feed, health
file, rankings or any other live data.

## Code and checks

- Engine: `src/lib/swissScenario.ts`. It reuses `WORLDS_2026_SWISS_RULES`,
  `swissBestOf` and `applySwissWinner` from `src/lib/worlds2026Swiss.ts`.
- View: `src/components/SwissPreview.tsx`, opened from `src/views/TournamentsView.tsx`.
- `tests/swissScenario.test.ts` covers the confirmed team in each seed slot
  and its logo, the bracket group sizes against a played-out scenario, Round 1
  pools and regions, a full
  played-out scenario checked against the sourced `replayWorlds2026Swiss`
  validator, the 2/3/3 qualifier split and placings, cleared later draws,
  opponent swaps, the rematch waiver case, the live starting point with partly
  published rounds and moved match times, and the address format.
- `tests/swissPreviewBrowser.test.ts` covers the browser journey: confirmed
  teams in the seed slots and pools, the full bracket before the draw, picks
  moving to the next record group, keyboard picks, pairings, focus after swaps
  and scenario switches, compare, copy, reset, undo, reload, Back and edited
  links, the live starting point with locked results, live draws that become
  unavailable, and the page width from 320 to 1440 px with only the bracket
  scrolling sideways.
