use crate::wire::{Bits, Components, Role, Roster, SeriesResult};
use ranking_contracts::{Result, js_pow, js_round, to_fixed};
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Model {
    pub(crate) initial_team_rating: f64,
    initial_league_rating: f64,
    league_elo_weight: f64,
    recency_half_life_days: f64,
    win_probability_elo_scale: f64,
    win_probability_uncertainty_scale: f64,
    win_probability_uncertainty_floor: f64,
    normal_uncertainty: f64,
    pub(crate) minimum_uncertainty: f64,
    pub(crate) maximum_uncertainty: f64,
    uncertainty_k_scale: f64,
    uncertainty_k_multiplier_floor: f64,
    uncertainty_k_multiplier_ceiling: f64,
    roster_volatility_k_ceiling: f64,
    pub(crate) rating_update_recency_weight: f64,
    pub(crate) latent_strength_result_budget_shares: Shares,
    domestic_stable_transfer_weights_by_tier: HashMap<String, f64>,
    published_team_stable_offset_config: StableOffsetConfig,
    published_roster_prior_config: RosterPriorConfig,
    pub(crate) roster_continuity_floor: f64,
    pub(crate) roster_change_uncertainty_penalty: f64,
    roster_continuity: RosterContinuityConfig,
    pub(crate) momentum_game_decay: f64,
    pub(crate) momentum_cap: f64,
    player_rating_prediction_published_weight: f64,
    execution_residual: ExecutionResidual,
    league_tiers: LeagueTiers,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Shares {
    team_stable: f64,
    team_form: f64,
    league_anchor: f64,
    pub(crate) player_signal_shadow: f64,
    pub(crate) lineup_signal_shadow: f64,
    pub(crate) direct_region_shadow: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StableOffsetConfig {
    positive_soft_cap: f64,
    positive_overflow_scale: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RosterPriorConfig {
    minimum_games: f64,
    full_scale_win_rate: f64,
    floor_scale_win_rate: f64,
    floor_scale: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RosterContinuityConfig {
    role_value_weights: HashMap<Role, f64>,
    requires_complete_lineups: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionResidual {
    execution_residual_weights: ExecutionWeights,
    execution_residual_cap: f64,
    execution_residual_update_weight: f64,
}

#[derive(Deserialize)]
struct ExecutionWeights {
    kills: f64,
    gold: f64,
    objectives: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeagueTiers {
    league_tier_definitions: HashMap<String, TierDefinition>,
    exact_league_tiers: HashMap<String, String>,
    emerging_league_pattern_rules: Vec<Pattern>,
    league_connectivity_shrinkage_matches: f64,
    league_effective_rating_caps_by_tier: HashMap<String, f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TierDefinition {
    prior_rating: f64,
}

#[derive(Deserialize)]
struct Pattern {
    source: String,
    flags: String,
}

/// Series-level inputs of the production series-result update, in canonical series order.
pub(crate) struct SeriesInput<'a> {
    pub(crate) leagues: [&'a str; 2],
    pub(crate) current_power_rating: [f64; 2],
    pub(crate) uncertainty: [f64; 2],
    pub(crate) roster_continuity: [Option<f64>; 2],
    pub(crate) best_of: u8,
    pub(crate) observed_outcome: [f64; 2],
    pub(crate) strength_signal: f64,
    pub(crate) event_k: f64,
    pub(crate) international: bool,
}

/// One side's raw game statistics, oriented as the source match records them.
pub(crate) struct SideStats {
    pub(crate) kills: f64,
    pub(crate) gold: f64,
    pub(crate) objectives: f64,
}

impl Model {
    pub(crate) fn live() -> Result<Self> {
        let model: Self = serde_json::from_value(ranking_contracts::model::parameters())
            .map_err(|e| e.to_string())?;
        for pattern in &model.league_tiers.emerging_league_pattern_rules {
            if pattern.flags != "i"
                || !matches!(
                    pattern.source.as_str(),
                    r"\bacademy\b"
                        | r"\bchallengers?\b"
                        | r"\bdevelopment\b"
                        | r"\bdivision\s*2\b"
                        | r"\bd2\b"
                        | r"\belite\b"
                        | r"\bnational\b"
                        | r"\bproving grounds\b"
                        | r"\bsecondary\b"
                )
            {
                return Err("unsupported live league pattern".into());
            }
        }
        Ok(model)
    }

    fn tier<'a>(&'a self, league: &str) -> &'a str {
        let normalized = league.trim_matches(js_space).to_uppercase();
        if normalized.is_empty() || normalized == "UNKNOWN" {
            return "unknown";
        }
        if let Some(tier) = self.league_tiers.exact_league_tiers.get(&normalized) {
            return tier;
        }
        let chars: Vec<_> = league.chars().map(|c| c.to_ascii_lowercase()).collect();
        for rule in &self.league_tiers.emerging_league_pattern_rules {
            let body = &rule.source[2..rule.source.len() - 2];
            if body == r"division\s*2" {
                for start in 0..chars.len() {
                    if starts_word(&chars, start, "division") {
                        let mut end = start + 8;
                        while end < chars.len() && js_space(chars[end]) {
                            end += 1;
                        }
                        if chars.get(end) == Some(&'2') && boundary_after(&chars, end + 1) {
                            return "emerging";
                        }
                    }
                }
            } else {
                let variants: Vec<&str> = if body == "challengers?" {
                    vec!["challenger", "challengers"]
                } else {
                    vec![body]
                };
                if variants.iter().any(|word| {
                    (0..chars.len()).any(|start| {
                        starts_word(&chars, start, word)
                            && boundary_after(&chars, start + word.len())
                    })
                }) {
                    return "emerging";
                }
            }
        }
        "unknown"
    }

    pub(crate) fn league_prior(&self, league: &str) -> f64 {
        self.league_tiers.league_tier_definitions[self.tier(league)].prior_rating
    }

    pub(crate) fn effective_league_rating(&self, league: &str, raw: f64, matches: f64) -> f64 {
        let prior = self.league_prior(league);
        let connectivity =
            matches / (matches + self.league_tiers.league_connectivity_shrinkage_matches);
        let rating = prior + connectivity * (raw - prior);
        match self
            .league_tiers
            .league_effective_rating_caps_by_tier
            .get(self.tier(league))
        {
            Some(cap) => js_min(rating, *cap),
            None => rating,
        }
    }

    pub(crate) fn power_rating(&self, team_rating: f64, league_rating: f64) -> f64 {
        team_rating + (league_rating - self.initial_league_rating) * self.league_elo_weight
    }

    pub(crate) fn league_adjustment(&self, team_rating: f64, league_rating: f64) -> f64 {
        js_round(self.power_rating(team_rating, league_rating) - team_rating)
    }

    pub(crate) fn components(
        &self,
        team_rating: f64,
        league_score: f64,
        roster_prior_offset: f64,
        momentum: f64,
        uncertainty: f64,
    ) -> Result<Components> {
        let config = &self.published_team_stable_offset_config;
        let raw = team_rating - self.initial_team_rating;
        let stable = if raw <= config.positive_soft_cap {
            raw
        } else {
            config.positive_soft_cap
                + (raw - config.positive_soft_cap) * config.positive_overflow_scale
        };
        Ok(Components {
            league_anchor: Bits(js_round(league_score)),
            team_stable_offset: Bits(js_round(stable)),
            roster_prior_offset: Bits(fixed(roster_prior_offset, 1)?),
            momentum: Bits(fixed(momentum, 1)?),
            context_adjustment: Bits(fixed(0.0, 1)?),
            uncertainty: Bits(js_round(uncertainty)),
        })
    }

    pub(crate) fn published_roster_prior(&self, raw: f64, wins: f64, losses: f64) -> Result<f64> {
        let config = &self.published_roster_prior_config;
        if raw <= 0.0 {
            return Ok(raw);
        }
        let games = wins + losses;
        if games < config.minimum_games {
            return Ok(raw);
        }
        let win_rate = if games > 0.0 {
            wins / games
        } else {
            config.full_scale_win_rate
        };
        if win_rate >= config.full_scale_win_rate {
            return Ok(raw);
        }
        if win_rate <= config.floor_scale_win_rate {
            return fixed(raw * config.floor_scale, 1);
        }
        let range = config.full_scale_win_rate - config.floor_scale_win_rate;
        let progress = if range > 0.0 {
            (win_rate - config.floor_scale_win_rate) / range
        } else {
            1.0
        };
        fixed(
            raw * (config.floor_scale + (1.0 - config.floor_scale) * progress),
            1,
        )
    }

    pub(crate) fn roster_prior_offset(
        &self,
        player_adjustment: Option<f64>,
        previous: Option<f64>,
    ) -> f64 {
        match player_adjustment {
            None => previous.unwrap_or(0.0),
            Some(adjustment) => adjustment * self.player_rating_prediction_published_weight,
        }
    }

    pub(crate) fn recency_weight(&self, days: f64) -> Result<f64> {
        fixed(js_pow(2.0, -days / self.recency_half_life_days), 3)
    }

    pub(crate) fn next_uncertainty(&self, current: f64, event_k: f64, cross_league: bool) -> f64 {
        let context = normalize(event_k, 12.0, 34.0) * 8.0;
        let cross = if cross_league { 7.0 } else { 0.0 };
        clamp(
            current - 5.0 - context - cross,
            self.minimum_uncertainty,
            self.maximum_uncertainty,
        )
    }

    pub(crate) fn execution_index(&self, own: &SideStats, other: &SideStats) -> f64 {
        let weights = &self.execution_residual.execution_residual_weights;
        let kill = (own.kills - other.kills) / js_max(own.kills + other.kills, 1.0);
        let gold = (own.gold - other.gold) / js_max(own.gold + other.gold, 1.0);
        let objective =
            (own.objectives - other.objectives) / js_max(own.objectives + other.objectives, 1.0);
        let cap = self.execution_residual.execution_residual_cap;
        clamp(
            kill * weights.kills + gold * weights.gold + objective * weights.objectives,
            -cap,
            cap,
        )
    }

    pub(crate) fn execution_soft_outcome(&self, binary: f64, index: f64) -> f64 {
        let weight = self.execution_residual.execution_residual_update_weight;
        clamp((1.0 - weight) * binary + weight * (0.5 + index), 0.0, 1.0)
    }

    pub(crate) fn roster_continuity(&self, prior: &Roster, current: &Roster) -> Option<f64> {
        let complete = |roster: &Roster| roster.completeness.is_complete();
        if self.roster_continuity.requires_complete_lineups
            && (!complete(prior) || !complete(current))
        {
            return None;
        }
        let mut retained = 0.0;
        let mut total = 0.0;
        for player in &current.players {
            let value = self
                .roster_continuity
                .role_value_weights
                .get(&player.role)
                .copied()
                .unwrap_or(0.0);
            total += value;
            if prior
                .players
                .iter()
                .rev()
                .find(|prior| prior.role == player.role)
                .is_some_and(|prior| prior.id == player.id)
            {
                retained += value;
            }
        }
        if total <= 0.0 {
            return None;
        }
        Some(retained / total)
    }

    fn transfer(&self, international: bool, league: &str, opponent: &str) -> f64 {
        if league != opponent && international {
            return 1.0;
        }
        let weight = self.domestic_stable_transfer_weights_by_tier[self.tier(league)];
        if league == opponent {
            return weight;
        }
        js_min(
            weight,
            self.domestic_stable_transfer_weights_by_tier[self.tier(opponent)],
        )
    }

    pub(crate) fn series_result(&self, input: &SeriesInput) -> Result<SeriesResult> {
        let [league_a, league_b] = input.leagues;
        let raw = 1.0
            / (1.0
                + js_pow(
                    10.0,
                    (input.current_power_rating[1] - input.current_power_rating[0])
                        / self.win_probability_elo_scale,
                ));
        let combined =
            (js_pow(input.uncertainty[0], 2.0) + js_pow(input.uncertainty[1], 2.0)).sqrt();
        let penalty = clamp(
            1.0 - combined / self.win_probability_uncertainty_scale,
            self.win_probability_uncertainty_floor,
            1.0,
        );
        let probability = 0.5 + (raw - 0.5) * penalty;
        let points = if input.best_of == 2 {
            probability
        } else {
            series_points(probability, input.best_of)
        };
        let expected_a = fixed(clamp(points, 0.0, 1.0), 4)?;
        let expected_b = fixed(clamp(1.0 - points, 0.0, 1.0), 4)?;
        let shares = &self.latent_strength_result_budget_shares;
        let league_share = if league_a != league_b
            && league_a != "Unknown"
            && league_b != "Unknown"
            && input.international
        {
            shares.league_anchor
        } else {
            0.0
        };
        let stable_share = (1.0 - league_share) * shares.team_stable;
        let form_share = (1.0 - league_share) * shares.team_form;
        let residual_a = input.observed_outcome[0] - expected_a;
        let residual_b = input.observed_outcome[1] - expected_b;
        let evidence_a =
            input.event_k * input.strength_signal * self.rating_update_recency_weight * residual_a;
        let evidence_b = -evidence_a;
        let uncertainty = |sigma: f64| {
            clamp(
                1.0 + (sigma - self.normal_uncertainty) / self.uncertainty_k_scale,
                self.uncertainty_k_multiplier_floor,
                self.uncertainty_k_multiplier_ceiling,
            )
        };
        let roster = |continuity: Option<f64>| {
            continuity.map_or(1.0, |c| {
                clamp(1.0 + (1.0 - c) * 0.5, 1.0, self.roster_volatility_k_ceiling)
            })
        };
        let uncertainty_a = uncertainty(input.uncertainty[0]);
        let uncertainty_b = uncertainty(input.uncertainty[1]);
        let roster_a = roster(input.roster_continuity[0]);
        let roster_b = roster(input.roster_continuity[1]);
        let transfer_a = self.transfer(input.international, league_a, league_b);
        let transfer_b = self.transfer(input.international, league_b, league_a);
        let stable_a = evidence_a * stable_share;
        let stable_b = evidence_b * stable_share;
        Ok(SeriesResult {
            expected_outcome_a: Bits(expected_a),
            expected_outcome_b: Bits(expected_b),
            league_signal_share: Bits(league_share),
            team_form_share: Bits(form_share),
            series_residual_a: Bits(residual_a),
            series_residual_b: Bits(residual_b),
            series_result_evidence_a: Bits(evidence_a),
            series_result_evidence_b: Bits(evidence_b),
            uncertainty_multiplier_a: Bits(uncertainty_a),
            uncertainty_multiplier_b: Bits(uncertainty_b),
            roster_multiplier_a: Bits(roster_a),
            roster_multiplier_b: Bits(roster_b),
            stable_transfer_weight_a: Bits(transfer_a),
            stable_transfer_weight_b: Bits(transfer_b),
            applied_team_stable_share_a: Bits(stable_share),
            applied_team_stable_share_b: Bits(stable_share),
            base_stable_delta_a: Bits(stable_a),
            base_stable_delta_b: Bits(stable_b),
            base_form_delta_a: Bits(evidence_a * form_share),
            base_form_delta_b: Bits(evidence_b * form_share),
            base_league_delta_a: Bits(evidence_a * league_share),
            base_league_delta_b: Bits(evidence_b * league_share),
            series_delta_a: Bits(js_round(stable_a * uncertainty_a * roster_a * transfer_a)),
            series_delta_b: Bits(js_round(stable_b * uncertainty_b * roster_b * transfer_b)),
        })
    }
}

/// `Number(value.toFixed(digits))`.
pub(crate) fn fixed(value: f64, digits: u8) -> Result<f64> {
    to_fixed(value, digits)?
        .parse::<f64>()
        .map_err(|e| e.to_string())
}
/// `Math.max`, including NaN and signed zero.
pub(crate) fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_positive() { a } else { b }
    } else if a > b {
        a
    } else {
        b
    }
}
/// `Math.min`, including NaN and signed zero.
pub(crate) fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_negative() { a } else { b }
    } else if a < b {
        a
    } else {
        b
    }
}
/// `Math.min(max, Math.max(min, value))`.
pub(crate) fn clamp(value: f64, min: f64, max: f64) -> f64 {
    js_min(max, js_max(min, value))
}
pub(crate) fn normalize(value: f64, min: f64, max: f64) -> f64 {
    clamp((value - min) / (max - min), 0.0, 1.0)
}
pub(crate) fn expected_score(rating_a: f64, rating_b: f64) -> f64 {
    1.0 / (1.0 + js_pow(10.0, (rating_b - rating_a) / 400.0))
}
fn series_points(probability: f64, games: u8) -> f64 {
    let mut result = 0.0;
    for wins in (games / 2 + 1)..=games {
        let mut coefficient = 1.0;
        for index in 1..=wins {
            coefficient = (coefficient * f64::from(games + 1 - index)) / f64::from(index);
        }
        result += coefficient
            * js_pow(probability, f64::from(wins))
            * js_pow(1.0 - probability, f64::from(games - wins));
    }
    result
}
fn word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}
fn starts_word(chars: &[char], start: usize, text: &str) -> bool {
    (start == 0 || !word(chars[start - 1]))
        && chars[start..]
            .iter()
            .copied()
            .take(text.len())
            .eq(text.chars())
}
fn boundary_after(chars: &[char], end: usize) -> bool {
    end == chars.len() || chars.get(end).is_some_and(|c| !word(*c))
}
fn js_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
