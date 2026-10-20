mod member;

use crate::engine::{
    Model, SeriesInput, SideStats, clamp, expected_score, fixed, js_max, js_min, normalize,
};
use crate::wire::{
    Bits, Colour, Components, ContinuityState, DateResult, Factors, Frame, HistoryValues, Inserted,
    League, LeagueInsertions, LeaguePoint, Ledger, Member, MemberTrail, Outcome, Role, Roster,
    SeriesFrame, SeriesInputTrail, SeriesResult, SeriesState, SeriesTrail, Side, SideSample,
    SideTrail, Source, TeamAfter, TeamInsertions,
};
use chrono::{Datelike, NaiveDate};
use ranking_contracts::{Result, js_round};

const BASE_UNAVAILABLE_CHANNELS: [&str; 4] = [
    "draft-skill:source-missing",
    "matchup-style:shadow-unavailable",
    "lineup-synergy:shadow-unavailable",
    "direct-region:derived-from-league-posterior",
];
const TRANSFER_SHRUNK_CHANNEL: &str = "domestic-relative-strength:global-transfer-shrunk";

/// One JS `Map` restricted to frame entities: values by index plus the keys it gained, in order.
struct Table<T> {
    values: Vec<Option<T>>,
    inserted: Vec<usize>,
}
impl<T> Table<T> {
    fn new(values: impl Iterator<Item = Option<T>>) -> Self {
        Self {
            values: values.collect(),
            inserted: Vec::new(),
        }
    }
    fn get(&self, index: usize) -> Option<&T> {
        self.values[index].as_ref()
    }
    fn set(&mut self, index: usize, value: T) {
        if self.values[index].is_none() {
            self.inserted.push(index);
        }
        self.values[index] = Some(value);
    }
}
impl Table<f64> {
    fn num(&self, index: usize) -> Option<f64> {
        self.values[index]
    }
    fn bits(&self, index: usize) -> Option<Bits> {
        self.values[index].map(Bits)
    }
    /// `addRatingDelta`: a zero delta, including negative zero, writes nothing.
    fn add_delta(&mut self, index: usize, delta: f64, initial: f64) {
        if delta == 0.0 {
            return;
        }
        let value = self.num(index).unwrap_or(initial);
        self.set(index, value + delta);
    }
}

fn bits(value: Option<Bits>) -> Option<f64> {
    value.map(|bits| bits.0)
}

struct Teams<'f> {
    rating: Table<f64>,
    execution: Table<f64>,
    uncertainty: Table<f64>,
    momentum: Table<f64>,
    roster_prior: Table<f64>,
    continuity: Table<f64>,
    previous_display: Table<f64>,
    wins: Table<f64>,
    losses: Table<f64>,
    form: Table<Vec<Outcome>>,
    factor_sums: Table<Factors>,
    factor_count: Table<f64>,
    last_roster: Table<(Source, &'f Roster)>,
    last_patch: Table<String>,
    last_fingerprint: Table<String>,
    latest_update: Table<Source>,
}

struct Leagues {
    score: Table<f64>,
    previous_score: Table<f64>,
    wins: Table<f64>,
    losses: Table<f64>,
    expected_wins: Table<f64>,
    opponent_sum: Table<f64>,
    form: Table<Vec<Outcome>>,
    match_count: Table<f64>,
    last_event: Table<String>,
    last_updated: Table<String>,
}

/// The ordered series pass over one date. `frame` is the immutable pre-series snapshot; the tables are live state.
struct Pass<'f> {
    model: &'f Model,
    frame: &'f Frame,
    teams: Teams<'f>,
    leagues: Leagues,
    side_samples: Vec<(String, SideSample)>,
    processed: f64,
    recency: f64,
}

/// Values the canonical series result assigns to its two teams, read by a member's team.
struct ByTeam<'s> {
    teams: [usize; 2],
    result: &'s SeriesResult,
    observed: [f64; 2],
    strength: f64,
}
impl ByTeam<'_> {
    fn get(&self, team: usize, values: [Bits; 2], default: f64) -> f64 {
        if team == self.teams[0] {
            values[0].0
        } else if team == self.teams[1] {
            values[1].0
        } else {
            default
        }
    }
}

pub(crate) fn date(model: &Model, frame: &Frame) -> Result<DateResult> {
    let teams = &frame.teams;
    let leagues = &frame.leagues;
    let mut pass = Pass {
        model,
        frame,
        teams: Teams {
            rating: Table::new(teams.iter().map(|t| bits(t.rating))),
            execution: Table::new(teams.iter().map(|t| bits(t.execution_rating))),
            uncertainty: Table::new(teams.iter().map(|t| bits(t.uncertainty))),
            momentum: Table::new(teams.iter().map(|t| bits(t.momentum))),
            roster_prior: Table::new(teams.iter().map(|t| bits(t.roster_prior_offset))),
            continuity: Table::new(teams.iter().map(|t| bits(t.roster_continuity))),
            previous_display: Table::new(teams.iter().map(|t| bits(t.previous_display_rating))),
            wins: Table::new(teams.iter().map(|t| bits(t.wins))),
            losses: Table::new(teams.iter().map(|t| bits(t.losses))),
            form: Table::new(teams.iter().map(|t| t.form.clone())),
            factor_sums: Table::new(teams.iter().map(|t| t.factors)),
            factor_count: Table::new(teams.iter().map(|t| bits(t.factor_count))),
            last_roster: Table::new(
                teams
                    .iter()
                    .map(|t| t.last_roster.as_ref().map(|roster| (Source::Prior, roster))),
            ),
            last_patch: Table::new(teams.iter().map(|t| t.last_patch.clone())),
            last_fingerprint: Table::new(teams.iter().map(|t| t.last_roster_fingerprint.clone())),
            latest_update: Table::new(
                teams
                    .iter()
                    .map(|t| t.has_latest_rating_update.then_some(Source::Prior)),
            ),
        },
        leagues: Leagues {
            score: Table::new(leagues.iter().map(|l| bits(l.score))),
            previous_score: Table::new(leagues.iter().map(|l| bits(l.previous_score))),
            wins: Table::new(leagues.iter().map(|l| bits(l.wins))),
            losses: Table::new(leagues.iter().map(|l| bits(l.losses))),
            expected_wins: Table::new(leagues.iter().map(|l| bits(l.expected_wins))),
            opponent_sum: Table::new(leagues.iter().map(|l| bits(l.opponent_rating_sum))),
            form: Table::new(leagues.iter().map(|l| l.form.clone())),
            match_count: Table::new(leagues.iter().map(|l| bits(l.match_count))),
            last_event: Table::new(leagues.iter().map(|l| l.last_event.clone())),
            last_updated: Table::new(leagues.iter().map(|l| l.last_updated.clone())),
        },
        side_samples: frame.side_samples.clone(),
        processed: frame.processed_match_count.0,
        recency: model.recency_weight(js_max(
            0.0,
            (epoch_ms(&frame.last_date)? - epoch_ms(&frame.utc_date)?) / 86_400_000.0,
        ))?,
    };
    let series = frame
        .series
        .iter()
        .enumerate()
        .map(|(index, series)| pass.series(index, series))
        .collect::<Result<Vec<_>>>()?;
    Ok(pass.finish(series))
}

/// `Date.parse` of a UTC calendar date, in milliseconds relative to a fixed epoch.
fn epoch_ms(date: &str) -> Result<f64> {
    let date = NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|e| e.to_string())?;
    Ok(f64::from(date.num_days_from_ce()) * 86_400_000.0)
}

fn series_state(best_of: u8, wins: [u32; 2], games: usize) -> SeriesState {
    let games = games as u64;
    let [a, b] = wins.map(u64::from);
    let best_of = u64::from(best_of);
    if games > best_of {
        return SeriesState::Unknown;
    }
    if best_of == 2 {
        return if games == 2 {
            SeriesState::Completed
        } else {
            SeriesState::Ongoing
        };
    }
    let needed = best_of / 2 + 1;
    if a > needed || b > needed {
        SeriesState::Unknown
    } else if a.max(b) >= needed {
        SeriesState::Completed
    } else {
        SeriesState::Ongoing
    }
}

fn strength_signal(games: usize, best_of: u8, wins: [u32; 2]) -> f64 {
    let needed = u32::from(best_of / 2) + 1;
    if wins[0].max(wins[1]) < needed {
        return 1.0;
    }
    let unused = js_max(0.0, f64::from(best_of) - games as f64);
    let bonus = if best_of > 1 {
        js_min(0.18, unused * 0.06)
    } else {
        0.0
    };
    1.0 + bonus
}

fn objectives(side: &Side) -> f64 {
    bits(side.towers).unwrap_or(0.0)
        + bits(side.dragons).unwrap_or(0.0)
        + bits(side.barons).unwrap_or(0.0) * 2.0
}

fn stats(side: &Side) -> SideStats {
    SideStats {
        kills: side.kills.0,
        gold: side.gold.0,
        objectives: objectives(side),
    }
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::Top => "Top",
        Role::Jungle => "Jungle",
        Role::Mid => "Mid",
        Role::Bot => "Bot",
        Role::Support => "Support",
    }
}

/// `rosterFingerprint`: complete rosters only, players stably sorted by role.
fn fingerprint(roster: &Roster) -> Option<String> {
    if !roster.completeness.is_complete() {
        return None;
    }
    let mut players: Vec<_> = roster.players.iter().collect();
    players.sort_by_key(|player| player.role as u8);
    Some(
        players
            .iter()
            .map(|player| format!("{}:{}", role_name(player.role), player.id))
            .collect::<Vec<_>>()
            .join("|"),
    )
}

fn push_form(form: Option<&Vec<Outcome>>, outcome: Outcome, keep: usize) -> Vec<Outcome> {
    let mut next = form.cloned().unwrap_or_default();
    next.push(outcome);
    let start = next.len().saturating_sub(keep);
    next.split_off(start)
}

fn outcome(won: bool) -> Outcome {
    if won { Outcome::W } else { Outcome::L }
}

impl<'f> Pass<'f> {
    fn league_name(&self, league: usize) -> &'f str {
        &self.frame.leagues[league].league
    }

    fn effective_league(&self, league: usize, raw: Option<f64>, matches: Option<f64>) -> f64 {
        let name = self.league_name(league);
        self.model.effective_league_rating(
            name,
            raw.unwrap_or_else(|| self.model.league_prior(name)),
            matches.unwrap_or(0.0),
        )
    }

    fn snapshot_league(&self, league: usize) -> f64 {
        let before = &self.frame.leagues[league];
        self.effective_league(league, bits(before.score), bits(before.match_count))
    }

    fn live_league(&self, league: usize) -> f64 {
        self.effective_league(
            league,
            self.leagues.score.num(league),
            self.leagues.match_count.num(league),
        )
    }

    fn league_state(&self, league: usize) -> League {
        let tables = &self.leagues;
        League {
            league: self.league_name(league).to_owned(),
            score: tables.score.bits(league),
            previous_score: tables.previous_score.bits(league),
            wins: tables.wins.bits(league),
            losses: tables.losses.bits(league),
            expected_wins: tables.expected_wins.bits(league),
            opponent_rating_sum: tables.opponent_sum.bits(league),
            match_count: tables.match_count.bits(league),
            form: tables.form.get(league).cloned(),
            last_event: tables.last_event.get(league).cloned(),
            last_updated: tables.last_updated.get(league).cloned(),
        }
    }

    fn continuity(&mut self, team: usize, observed: Option<&Roster>) {
        let (Some(observed), Some((_, prior))) = (observed, self.teams.last_roster.get(team))
        else {
            return;
        };
        let Some(continuity) = self.model.roster_continuity(prior, observed) else {
            return;
        };
        let model = self.model;
        let initial = model.initial_team_rating;
        self.teams.continuity.set(team, continuity);
        let retention =
            model.roster_continuity_floor + (1.0 - model.roster_continuity_floor) * continuity;
        let rating = self.teams.rating.num(team).unwrap_or(initial);
        let execution = self.teams.execution.num(team).unwrap_or(initial);
        self.teams
            .rating
            .set(team, initial + retention * (rating - initial));
        self.teams
            .execution
            .set(team, initial + retention * (execution - initial));
        if continuity < 1.0 {
            let uncertainty = self
                .teams
                .uncertainty
                .num(team)
                .unwrap_or(model.maximum_uncertainty);
            self.teams.uncertainty.set(
                team,
                clamp(
                    uncertainty + model.roster_change_uncertainty_penalty * (1.0 - continuity),
                    model.minimum_uncertainty,
                    model.maximum_uncertainty,
                ),
            );
        }
    }

    fn series(&mut self, index: usize, series: &'f SeriesFrame) -> Result<SeriesTrail> {
        let model = self.model;
        let frame = self.frame;
        let last = series.members.len() - 1;
        let final_member = &series.members[last];
        for side in &final_member.sides {
            self.continuity(side.team, side.roster.as_ref());
        }
        let continuity = final_member.sides.each_ref().map(|side| ContinuityState {
            roster_continuity: self.teams.continuity.bits(side.team),
            rating: self.teams.rating.bits(side.team),
            execution_rating: self.teams.execution.bits(side.team),
            uncertainty: self.teams.uncertainty.bits(side.team),
        });
        let games = series.members.len();
        let state = series_state(series.best_of, series.wins, games);
        let outcome_a = match series.wins[0].cmp(&series.wins[1]) {
            std::cmp::Ordering::Equal => 0.5,
            std::cmp::Ordering::Greater => 1.0,
            std::cmp::Ordering::Less => 0.0,
        };
        let observed = [outcome_a, 1.0 - outcome_a];
        let strength = strength_signal(games, series.best_of, series.wins);
        let final_offsets = final_member.sides.each_ref().map(|side| {
            model.roster_prior_offset(
                side.roster.as_ref(),
                bits(side.player_adjustment),
                bits(frame.teams[side.team].roster_prior_offset),
            )
        });
        let offsets = [
            if final_member.sides[0].team == series.teams[0] {
                final_offsets[0]
            } else {
                final_offsets[1]
            },
            if final_member.sides[1].team == series.teams[1] {
                final_offsets[1]
            } else {
                final_offsets[0]
            },
        ];
        let current_power_rating = [0, 1].map(|s| {
            let before = &frame.teams[series.teams[s]];
            let power = model.power_rating(
                bits(before.rating).unwrap_or(model.initial_team_rating),
                self.snapshot_league(series.leagues[s]),
            );
            power + offsets[s] + bits(before.momentum).unwrap_or(0.0)
        });
        let uncertainty = series
            .teams
            .map(|team| bits(frame.teams[team].uncertainty).unwrap_or(model.maximum_uncertainty));
        let roster_continuity = series.teams.map(|team| self.teams.continuity.num(team));
        let input = SeriesInput {
            leagues: series.leagues.map(|league| self.league_name(league)),
            current_power_rating,
            uncertainty,
            roster_continuity,
            best_of: series.best_of,
            observed_outcome: observed,
            strength_signal: strength,
            event_k: final_member.event_k.0,
            international: final_member.international,
        };
        let result = model.series_result(&input)?;
        let by_team = ByTeam {
            teams: series.teams,
            result: &result,
            observed,
            strength,
        };
        let mut local: Vec<Option<f64>> = frame
            .teams
            .iter()
            .map(|team| bits(team.execution_rating))
            .collect();
        let members = series
            .members
            .iter()
            .enumerate()
            .map(|(position, member)| {
                let series_final = state == SeriesState::Completed && member.id == final_member.id;
                self.member(
                    [index, position],
                    series,
                    member,
                    series_final,
                    &by_team,
                    &mut local,
                )
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(SeriesTrail {
            state,
            outcome_a: Bits(outcome_a),
            continuity,
            input: SeriesInputTrail {
                current_power_rating: current_power_rating.map(Bits),
                uncertainty: uncertainty.map(Bits),
                roster_continuity: roster_continuity.map(|value| value.map(Bits)),
                observed_outcome: observed.map(Bits),
                strength_signal: Bits(strength),
                event_k: final_member.event_k,
                international: final_member.international,
            },
            result,
            members,
        })
    }

    /// `updateLeagueStrength`. Its writes to copied score maps are discarded in Node, so only records change here.
    fn league_update(
        &mut self,
        member: &Member,
        by_team: &ByTeam,
        team: [usize; 2],
        league: [usize; 2],
        current_power: [f64; 2],
        base_league: [f64; 2],
    ) -> Result<[f64; 2]> {
        let [name_a, name_b] = league.map(|l| self.league_name(l));
        if league[0] == league[1]
            || name_a == "Unknown"
            || name_b == "Unknown"
            || !member.international
        {
            return Ok([0.0, 0.0]);
        }
        let delta = [fixed(base_league[0], 3)?, fixed(base_league[1], 3)?];
        let result = by_team.result;
        for s in 0..2 {
            let observed = by_team.get(team[s], by_team.observed.map(Bits), 0.0);
            let expected = by_team.get(
                team[s],
                [result.expected_outcome_a, result.expected_outcome_b],
                0.0,
            );
            self.league_record(member, league[s], observed, expected, current_power[1 - s]);
        }
        Ok(delta)
    }

    fn league_record(
        &mut self,
        member: &Member,
        league: usize,
        observed: f64,
        expected: f64,
        opponent: f64,
    ) {
        let tables = &mut self.leagues;
        let wins = tables.wins.num(league).unwrap_or(0.0);
        tables.wins.set(league, wins + observed);
        let losses = tables.losses.num(league).unwrap_or(0.0);
        tables.losses.set(league, losses + 1.0 - observed);
        let expected_wins = tables.expected_wins.num(league).unwrap_or(0.0);
        tables.expected_wins.set(league, expected_wins + expected);
        let opponent_sum = tables.opponent_sum.num(league).unwrap_or(0.0);
        tables.opponent_sum.set(league, opponent_sum + opponent);
        if observed != 0.5 {
            let form = push_form(tables.form.get(league), outcome(observed > 0.5), 6);
            tables.form.set(league, form);
        }
        let matches = tables.match_count.num(league).unwrap_or(0.0);
        tables.match_count.set(league, matches + 1.0);
        tables.last_event.set(league, member.event.clone());
        tables.last_updated.set(league, self.frame.utc_date.clone());
    }

    fn apply_league_delta(&mut self, league: usize, delta: f64) {
        if delta == 0.0 {
            return;
        }
        let current = self
            .leagues
            .score
            .num(league)
            .unwrap_or_else(|| self.model.league_prior(self.league_name(league)));
        self.leagues.previous_score.set(league, current);
        self.leagues.score.set(league, current + delta);
    }

    fn league_point(
        &self,
        member: &Member,
        [own, opponent]: [usize; 2],
        score: f64,
        delta: [f64; 2],
    ) -> Result<LeaguePoint> {
        let league = member.sides[own].league;
        let tables = &self.leagues;
        let wins = tables.wins.num(league).unwrap_or(0.0);
        let losses = tables.losses.num(league).unwrap_or(0.0);
        let matches = tables.match_count.num(league).unwrap_or(0.0);
        let expected = tables.expected_wins.num(league).unwrap_or(0.0);
        let over_expected = wins - expected;
        let international = matches > 0.0;
        let optional = |value: f64, digits: u8| -> Result<Option<Bits>> {
            Ok(if international {
                Some(Bits(fixed(value, digits)?))
            } else {
                None
            })
        };
        Ok(LeaguePoint {
            date: self.frame.utc_date.clone(),
            event: member.event.clone(),
            tier: member.tier.clone(),
            league: self.league_name(league).to_owned(),
            region: member.sides[own].region.clone(),
            opponent_league: self.league_name(member.sides[opponent].league).to_owned(),
            opponent_region: member.sides[opponent].region.clone(),
            result: outcome(delta[own] >= delta[opponent]),
            score: Bits(fixed(score, 1)?),
            delta: Bits(fixed(delta[own], 1)?),
            wins: Bits(wins),
            losses: Bits(losses),
            expected_wins: optional(expected, 2)?,
            wins_over_expected: optional(over_expected, 2)?,
            opponent_adjusted_win_rate: optional(
                clamp((over_expected + matches * 0.5) / matches, 0.0, 1.0),
                3,
            )?,
            average_opponent_rating: optional(
                tables.opponent_sum.num(league).unwrap_or(0.0) / matches,
                1,
            )?,
            international_matches: Bits(matches),
        })
    }

    fn record(&mut self, team: usize, won: bool) {
        let table = if won {
            &mut self.teams.wins
        } else {
            &mut self.teams.losses
        };
        let count = table.num(team).unwrap_or(0.0);
        table.set(team, count + 1.0);
        let form = push_form(self.teams.form.get(team), outcome(won), 5);
        self.teams.form.set(team, form);
    }

    fn add_factors(&mut self, team: usize, next: &Factors) {
        let current = self
            .teams
            .factor_sums
            .get(team)
            .copied()
            .unwrap_or(Factors {
                context: Bits(0.0),
                recency: Bits(0.0),
                execution: Bits(0.0),
                opponent: Bits(0.0),
                league: Bits(0.5),
            });
        self.teams.factor_sums.set(
            team,
            Factors {
                context: Bits(current.context.0 + next.context.0),
                recency: Bits(current.recency.0 + next.recency.0),
                execution: Bits(current.execution.0 + next.execution.0),
                opponent: Bits(current.opponent.0 + next.opponent.0),
                league: Bits(current.league.0 + next.league.0),
            },
        );
        let count = self.teams.factor_count.num(team).unwrap_or(0.0);
        self.teams.factor_count.set(team, count + 1.0);
    }

    fn record_side_sample(&mut self, member: &Member) -> Vec<(String, SideSample)> {
        let blue_won = if member.sides[0].colour == Some(Colour::Blue) {
            Some(member.winner == 0)
        } else if member.sides[1].colour == Some(Colour::Blue) {
            Some(member.winner == 1)
        } else {
            None
        };
        let Some(blue_won) = blue_won else {
            return Vec::new();
        };
        let patch = if member.patch.is_empty() {
            "all"
        } else {
            member.patch.as_str()
        };
        let mut touched = Vec::with_capacity(2);
        for key in [patch, "all"] {
            let index = match self.side_samples.iter().position(|(name, _)| name == key) {
                Some(index) => index,
                None => {
                    self.side_samples.push((
                        key.to_owned(),
                        SideSample {
                            blue_wins: Bits(0.0),
                            total: Bits(0.0),
                        },
                    ));
                    self.side_samples.len() - 1
                }
            };
            let sample = &mut self.side_samples[index].1;
            *sample = SideSample {
                blue_wins: Bits(sample.blue_wins.0 + if blue_won { 1.0 } else { 0.0 }),
                total: Bits(sample.total.0 + 1.0),
            };
            touched.push((key.to_owned(), *sample));
        }
        touched
    }

    fn record_team_context(&mut self, member: &'f Member, [series, position, side]: [usize; 3]) {
        let team = member.sides[side].team;
        if !member.patch.is_empty() {
            self.teams.last_patch.set(team, member.patch.clone());
        }
        let Some(roster) = member.sides[side].roster.as_ref() else {
            return;
        };
        let Some(fingerprint) = fingerprint(roster).filter(|text| !text.is_empty()) else {
            return;
        };
        self.teams.last_roster.set(
            team,
            (
                Source::Member {
                    series,
                    member: position,
                    side,
                },
                roster,
            ),
        );
        self.teams.last_fingerprint.set(team, fingerprint);
    }

    fn finish(self, series: Vec<SeriesTrail>) -> DateResult {
        let teams = (0..self.frame.teams.len())
            .map(|t| {
                let tables = &self.teams;
                TeamAfter {
                    team: self.frame.teams[t].team.clone(),
                    rating: tables.rating.bits(t),
                    execution_rating: tables.execution.bits(t),
                    uncertainty: tables.uncertainty.bits(t),
                    momentum: tables.momentum.bits(t),
                    roster_prior_offset: tables.roster_prior.bits(t),
                    roster_continuity: tables.continuity.bits(t),
                    previous_display_rating: tables.previous_display.bits(t),
                    wins: tables.wins.bits(t),
                    losses: tables.losses.bits(t),
                    form: tables.form.get(t).cloned(),
                    factors: tables.factor_sums.get(t).copied(),
                    factor_count: tables.factor_count.bits(t),
                    last_roster: tables.last_roster.get(t).map(|(source, _)| *source),
                    last_patch: tables.last_patch.get(t).cloned(),
                    last_roster_fingerprint: tables.last_fingerprint.get(t).cloned(),
                    latest_rating_update: tables.latest_update.get(t).copied(),
                }
            })
            .collect();
        let leagues = (0..self.frame.leagues.len())
            .map(|l| self.league_state(l))
            .collect();
        let Pass {
            teams: t,
            leagues: l,
            ..
        } = self;
        DateResult {
            utc_date: self.frame.utc_date.clone(),
            series,
            teams,
            leagues,
            side_samples: self.side_samples,
            inserted: Inserted {
                teams: TeamInsertions {
                    ratings: t.rating.inserted,
                    execution_ratings: t.execution.inserted,
                    uncertainties: t.uncertainty.inserted,
                    momentums: t.momentum.inserted,
                    roster_prior_offsets: t.roster_prior.inserted,
                    roster_continuity: t.continuity.inserted,
                    previous_display_ratings: t.previous_display.inserted,
                    wins: t.wins.inserted,
                    losses: t.losses.inserted,
                    forms: t.form.inserted,
                    factor_sums: t.factor_sums.inserted,
                    factor_counts: t.factor_count.inserted,
                    last_rosters: t.last_roster.inserted,
                    last_patches: t.last_patch.inserted,
                    last_roster_fingerprints: t.last_fingerprint.inserted,
                    latest_rating_updates: t.latest_update.inserted,
                },
                leagues: LeagueInsertions {
                    scores: l.score.inserted,
                    previous_scores: l.previous_score.inserted,
                    wins: l.wins.inserted,
                    losses: l.losses.inserted,
                    expected_wins: l.expected_wins.inserted,
                    opponent_rating_sums: l.opponent_sum.inserted,
                    forms: l.form.inserted,
                    match_counts: l.match_count.inserted,
                    last_events: l.last_event.inserted,
                    last_updated: l.last_updated.inserted,
                },
            },
            processed_match_count: Bits(self.processed),
        }
    }
}

fn display(components: &Components) -> f64 {
    components.league_anchor.0
        + components.team_stable_offset.0
        + components.roster_prior_offset.0
        + components.momentum.0
        + components.context_adjustment.0
}
