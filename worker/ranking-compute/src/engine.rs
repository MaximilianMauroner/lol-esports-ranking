use crate::{Bits, Input};
use ranking_contracts::{Result, js_pow, js_round, to_fixed};
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Model {
    win_probability_elo_scale: f64,
    win_probability_uncertainty_scale: f64,
    win_probability_uncertainty_floor: f64,
    normal_uncertainty: f64,
    uncertainty_k_scale: f64,
    uncertainty_k_multiplier_floor: f64,
    uncertainty_k_multiplier_ceiling: f64,
    roster_volatility_k_ceiling: f64,
    rating_update_recency_weight: f64,
    latent_strength_result_budget_shares: Shares,
    domestic_stable_transfer_weights_by_tier: HashMap<String, f64>,
    league_tiers: LeagueTiers,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Shares {
    team_stable: f64,
    team_form: f64,
    league_anchor: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeagueTiers {
    exact_league_tiers: HashMap<String, String>,
    emerging_league_pattern_rules: Vec<Pattern>,
}

#[derive(Deserialize)]
struct Pattern {
    source: String,
    flags: String,
}

pub(crate) const FIELDS: [&str; 24] = [
    "expectedOutcomeA",
    "expectedOutcomeB",
    "leagueSignalShare",
    "teamFormShare",
    "seriesResidualA",
    "seriesResidualB",
    "seriesResultEvidenceA",
    "seriesResultEvidenceB",
    "uncertaintyMultiplierA",
    "uncertaintyMultiplierB",
    "rosterMultiplierA",
    "rosterMultiplierB",
    "stableTransferWeightA",
    "stableTransferWeightB",
    "appliedTeamStableShareA",
    "appliedTeamStableShareB",
    "baseStableDeltaA",
    "baseStableDeltaB",
    "baseFormDeltaA",
    "baseFormDeltaB",
    "baseLeagueDeltaA",
    "baseLeagueDeltaB",
    "seriesDeltaA",
    "seriesDeltaB",
];

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

    fn transfer(&self, international: bool, league: &str, opponent: &str) -> f64 {
        if league != opponent && international {
            return 1.0;
        }
        let weight = self.domestic_stable_transfer_weights_by_tier[self.tier(league)];
        if league == opponent {
            return weight;
        }
        weight.min(self.domestic_stable_transfer_weights_by_tier[self.tier(opponent)])
    }

    pub(crate) fn calculate(&self, input: &Input) -> Result<[Bits; 24]> {
        let [a, b] = &input.teams;
        let raw = 1.0
            / (1.0
                + js_pow(
                    10.0,
                    (b.current_power_rating.0 - a.current_power_rating.0)
                        / self.win_probability_elo_scale,
                ));
        let combined = (js_pow(a.uncertainty.0, 2.0) + js_pow(b.uncertainty.0, 2.0)).sqrt();
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
        let expected_a = round_probability(points)?;
        let expected_b = round_probability(1.0 - points)?;
        let shares = &self.latent_strength_result_budget_shares;
        let league_share = if a.league != b.league
            && a.league != "Unknown"
            && b.league != "Unknown"
            && input.international
        {
            shares.league_anchor
        } else {
            0.0
        };
        let stable_share = (1.0 - league_share) * shares.team_stable;
        let form_share = (1.0 - league_share) * shares.team_form;
        let residual_a = input.observed_outcome_a.0 - expected_a;
        let residual_b = input.observed_outcome_b.0 - expected_b;
        let evidence_a = input.event_k.0
            * input.strength_signal.0
            * self.rating_update_recency_weight
            * residual_a;
        let evidence_b = -evidence_a;
        let uncertainty = |sigma: f64| {
            clamp(
                1.0 + (sigma - self.normal_uncertainty) / self.uncertainty_k_scale,
                self.uncertainty_k_multiplier_floor,
                self.uncertainty_k_multiplier_ceiling,
            )
        };
        let roster = |continuity: Option<Bits>| {
            continuity.map_or(1.0, |c| {
                clamp(
                    1.0 + (1.0 - c.0) * 0.5,
                    1.0,
                    self.roster_volatility_k_ceiling,
                )
            })
        };
        let uncertainty_a = uncertainty(a.uncertainty.0);
        let uncertainty_b = uncertainty(b.uncertainty.0);
        let roster_a = roster(a.roster_continuity);
        let roster_b = roster(b.roster_continuity);
        let transfer_a = self.transfer(input.international, &a.league, &b.league);
        let transfer_b = self.transfer(input.international, &b.league, &a.league);
        let stable_a = evidence_a * stable_share;
        let stable_b = evidence_b * stable_share;
        let values = [
            expected_a,
            expected_b,
            league_share,
            form_share,
            residual_a,
            residual_b,
            evidence_a,
            evidence_b,
            uncertainty_a,
            uncertainty_b,
            roster_a,
            roster_b,
            transfer_a,
            transfer_b,
            stable_share,
            stable_share,
            stable_a,
            stable_b,
            evidence_a * form_share,
            evidence_b * form_share,
            evidence_a * league_share,
            evidence_b * league_share,
            js_round(stable_a * uncertainty_a * roster_a * transfer_a),
            js_round(stable_b * uncertainty_b * roster_b * transfer_b),
        ];
        if values.iter().any(|v| !v.is_finite()) {
            return Err("nonfinite calculation result".into());
        }
        Ok(values.map(Bits))
    }
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}
fn round_probability(value: f64) -> Result<f64> {
    to_fixed(clamp(value, 0.0, 1.0), 4)?
        .parse::<f64>()
        .map_err(|e| e.to_string())
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
