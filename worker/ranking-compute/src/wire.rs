use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub(crate) const REQUEST_SCHEMA: &str = "series-pass-batch-v1";
pub(crate) const RESPONSE_SCHEMA: &str = "series-pass-response-v1";

/// A finite binary64 value carried as 16 lowercase hex digits of its bits.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Bits(pub(crate) f64);
impl<'de> Deserialize<'de> for Bits {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        if text.len() != 16
            || !text
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err(serde::de::Error::custom("expected 16 lowercase hex bits"));
        }
        let value =
            f64::from_bits(u64::from_str_radix(&text, 16).map_err(serde::de::Error::custom)?);
        if !value.is_finite() {
            return Err(serde::de::Error::custom("nonfinite input bits"));
        }
        Ok(Self(value))
    }
}
impl Serialize for Bits {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        if !self.0.is_finite() {
            return Err(serde::ser::Error::custom("nonfinite calculation result"));
        }
        serializer.serialize_str(&format!("{:016x}", self.0.to_bits()))
    }
}

/// Requires an explicit `null` so a missing field never reads as an absent map key.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> std::result::Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize, Serialize)]
pub(crate) enum Role {
    Top,
    Jungle,
    Mid,
    Bot,
    Support,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Completeness {
    CompleteFiveRole,
    Partial,
}
impl Completeness {
    pub(crate) fn is_complete(self) -> bool {
        self == Self::CompleteFiveRole
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Colour {
    Blue,
    Red,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) enum Outcome {
    W,
    L,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ContinuityRetention {
    BaselineContraction,
    ProvenStrongerLineup,
}
/// A frame stored before the decision existed omits it, which means baseline. An explicit `null` is not that frame.
fn legacy_retention<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<[ContinuityRetention; 2]>, D::Error> {
    <[ContinuityRetention; 2]>::deserialize(deserializer).map(Some)
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SeriesState {
    Ongoing,
    Completed,
    Unknown,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelIdentity {
    pub(crate) version: String,
    pub(crate) config_hash: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    pub(crate) schema: String,
    pub(crate) model: ModelIdentity,
    pub(crate) dates: Vec<Frame>,
}

/// One complete authoritative UTC date: the pre-series state of every affected entity and the ordered series.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Frame {
    pub(crate) utc_date: String,
    pub(crate) last_date: String,
    pub(crate) authoritative_match_ids: Vec<String>,
    pub(crate) teams: Vec<TeamBefore>,
    pub(crate) leagues: Vec<League>,
    pub(crate) side_samples: Vec<(String, SideSample)>,
    pub(crate) processed_match_count: Bits,
    pub(crate) series: Vec<SeriesFrame>,
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SideSample {
    pub(crate) blue_wins: Bits,
    pub(crate) total: Bits,
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Factors {
    pub(crate) context: Bits,
    pub(crate) recency: Bits,
    pub(crate) execution: Bits,
    pub(crate) opponent: Bits,
    pub(crate) league: Bits,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Player {
    pub(crate) role: Role,
    pub(crate) id: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Roster {
    pub(crate) completeness: Completeness,
    pub(crate) players: Vec<Player>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TeamBefore {
    pub(crate) team: String,
    #[serde(deserialize_with = "present")]
    pub(crate) rating: Option<Bits>,
    #[serde(deserialize_with = "present")]
    pub(crate) execution_rating: Option<Bits>,
    #[serde(deserialize_with = "present")]
    pub(crate) uncertainty: Option<Bits>,
    #[serde(deserialize_with = "present")]
    pub(crate) momentum: Option<Bits>,
    #[serde(deserialize_with = "present")]
    pub(crate) roster_prior_offset: Option<Bits>,
    #[serde(deserialize_with = "present")]
    pub(crate) roster_continuity: Option<Bits>,
    #[serde(deserialize_with = "present")]
    pub(crate) previous_display_rating: Option<Bits>,
    #[serde(deserialize_with = "present")]
    pub(crate) wins: Option<Bits>,
    #[serde(deserialize_with = "present")]
    pub(crate) losses: Option<Bits>,
    #[serde(deserialize_with = "present")]
    pub(crate) form: Option<Vec<Outcome>>,
    #[serde(deserialize_with = "present")]
    pub(crate) factors: Option<Factors>,
    #[serde(deserialize_with = "present")]
    pub(crate) factor_count: Option<Bits>,
    #[serde(deserialize_with = "present")]
    pub(crate) last_roster: Option<Roster>,
    #[serde(deserialize_with = "present")]
    pub(crate) last_patch: Option<String>,
    #[serde(deserialize_with = "present")]
    pub(crate) last_roster_fingerprint: Option<String>,
    pub(crate) has_latest_rating_update: bool,
}
/// League record state. Requests carry it before the date; responses return it after a member or the date.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct League {
    pub(crate) league: String,
    #[serde(deserialize_with = "present")]
    pub(crate) score: Option<Bits>,
    #[serde(deserialize_with = "present")]
    pub(crate) previous_score: Option<Bits>,
    #[serde(deserialize_with = "present")]
    pub(crate) wins: Option<Bits>,
    #[serde(deserialize_with = "present")]
    pub(crate) losses: Option<Bits>,
    #[serde(deserialize_with = "present")]
    pub(crate) expected_wins: Option<Bits>,
    #[serde(deserialize_with = "present")]
    pub(crate) opponent_rating_sum: Option<Bits>,
    #[serde(deserialize_with = "present")]
    pub(crate) match_count: Option<Bits>,
    #[serde(deserialize_with = "present")]
    pub(crate) form: Option<Vec<Outcome>>,
    #[serde(deserialize_with = "present")]
    pub(crate) last_event: Option<String>,
    #[serde(deserialize_with = "present")]
    pub(crate) last_updated: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SeriesFrame {
    pub(crate) series_id: String,
    pub(crate) teams: [usize; 2],
    pub(crate) leagues: [usize; 2],
    pub(crate) best_of: u8,
    pub(crate) wins: [u32; 2],
    pub(crate) members: Vec<Member>,
    #[serde(
        default,
        deserialize_with = "legacy_retention",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) continuity_retention: Option<[ContinuityRetention; 2]>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MemberOrder {
    #[serde(deserialize_with = "present")]
    pub(crate) datetime_utc: Option<String>,
    pub(crate) game_number: Bits,
    #[serde(deserialize_with = "present")]
    pub(crate) official_game_id: Option<String>,
    #[serde(deserialize_with = "present")]
    pub(crate) source_game_id: Option<String>,
}
/// One game in its original A/B orientation. `matchId` is the replay identity; `id` is the match record ID.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Member {
    pub(crate) match_id: String,
    pub(crate) id: String,
    pub(crate) ordering: MemberOrder,
    pub(crate) sides: [Side; 2],
    pub(crate) winner: u8,
    pub(crate) international: bool,
    pub(crate) event_k: Bits,
    pub(crate) event_weight: Bits,
    pub(crate) patch: String,
    pub(crate) event: String,
    pub(crate) tier: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Side {
    pub(crate) team: usize,
    pub(crate) league: usize,
    pub(crate) region: String,
    #[serde(deserialize_with = "present")]
    pub(crate) colour: Option<Colour>,
    pub(crate) side_adjustment: Bits,
    #[serde(deserialize_with = "present")]
    pub(crate) player_adjustment: Option<Bits>,
    #[serde(deserialize_with = "present")]
    pub(crate) roster: Option<Roster>,
    pub(crate) kills: Bits,
    pub(crate) gold: Bits,
    #[serde(deserialize_with = "present")]
    pub(crate) towers: Option<Bits>,
    #[serde(deserialize_with = "present")]
    pub(crate) dragons: Option<Bits>,
    #[serde(deserialize_with = "present")]
    pub(crate) barons: Option<Bits>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Response {
    pub(crate) schema: &'static str,
    pub(crate) request_sha256: String,
    pub(crate) model: ModelIdentity,
    pub(crate) dates: Vec<DateResult>,
}
/// The affected state after the whole date, in frame order, plus the keys each map gained in insertion order.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DateResult {
    pub(crate) utc_date: String,
    pub(crate) series: Vec<SeriesTrail>,
    pub(crate) teams: Vec<TeamAfter>,
    pub(crate) leagues: Vec<League>,
    pub(crate) side_samples: Vec<(String, SideSample)>,
    pub(crate) inserted: Inserted,
    pub(crate) processed_match_count: Bits,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SeriesTrail {
    pub(crate) state: SeriesState,
    pub(crate) outcome_a: Bits,
    pub(crate) continuity: [ContinuityState; 2],
    pub(crate) input: SeriesInputTrail,
    pub(crate) result: SeriesResult,
    pub(crate) members: Vec<MemberTrail>,
}
/// Live team state after roster continuity, for the final member's sides.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContinuityState {
    pub(crate) roster_continuity: Option<Bits>,
    pub(crate) rating: Option<Bits>,
    pub(crate) execution_rating: Option<Bits>,
    pub(crate) uncertainty: Option<Bits>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SeriesInputTrail {
    pub(crate) current_power_rating: [Bits; 2],
    pub(crate) uncertainty: [Bits; 2],
    pub(crate) roster_continuity: [Option<Bits>; 2],
    pub(crate) observed_outcome: [Bits; 2],
    pub(crate) strength_signal: Bits,
    pub(crate) event_k: Bits,
    pub(crate) international: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SeriesResult {
    pub(crate) expected_outcome_a: Bits,
    pub(crate) expected_outcome_b: Bits,
    pub(crate) league_signal_share: Bits,
    pub(crate) team_form_share: Bits,
    pub(crate) series_residual_a: Bits,
    pub(crate) series_residual_b: Bits,
    pub(crate) series_result_evidence_a: Bits,
    pub(crate) series_result_evidence_b: Bits,
    pub(crate) uncertainty_multiplier_a: Bits,
    pub(crate) uncertainty_multiplier_b: Bits,
    pub(crate) roster_multiplier_a: Bits,
    pub(crate) roster_multiplier_b: Bits,
    pub(crate) stable_transfer_weight_a: Bits,
    pub(crate) stable_transfer_weight_b: Bits,
    pub(crate) applied_team_stable_share_a: Bits,
    pub(crate) applied_team_stable_share_b: Bits,
    pub(crate) base_stable_delta_a: Bits,
    pub(crate) base_stable_delta_b: Bits,
    pub(crate) base_form_delta_a: Bits,
    pub(crate) base_form_delta_b: Bits,
    pub(crate) base_league_delta_a: Bits,
    pub(crate) base_league_delta_b: Bits,
    pub(crate) series_delta_a: Bits,
    pub(crate) series_delta_b: Bits,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemberTrail {
    pub(crate) series_final: bool,
    pub(crate) game_k: Bits,
    pub(crate) recency: Bits,
    pub(crate) sides: [SideTrail; 2],
    pub(crate) league_history: Vec<LeaguePoint>,
    pub(crate) side_samples: Vec<(String, SideSample)>,
    pub(crate) processed_match_count: Bits,
}
/// The calculation and live team state after one member, for one side in match orientation.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SideTrail {
    pub(crate) snapshot_rating: Bits,
    pub(crate) local_execution_before: Bits,
    pub(crate) snapshot_league_score: Bits,
    pub(crate) snapshot_momentum: Bits,
    pub(crate) power_rating: Bits,
    pub(crate) execution_power_rating: Bits,
    pub(crate) current_power_rating: Bits,
    pub(crate) effective_rating: Bits,
    pub(crate) execution_effective_rating: Bits,
    pub(crate) live_rating_before: Bits,
    pub(crate) live_league_before: Bits,
    pub(crate) live_momentum_before: Bits,
    pub(crate) live_uncertainty_before: Bits,
    pub(crate) previous_components: Components,
    pub(crate) execution_index: Bits,
    pub(crate) execution_expected: Bits,
    pub(crate) execution_outcome: Bits,
    pub(crate) execution_delta: Bits,
    pub(crate) local_execution_rating: Option<Bits>,
    pub(crate) execution_rating: Option<Bits>,
    pub(crate) rating: Option<Bits>,
    pub(crate) series_delta: Bits,
    pub(crate) previous_display_rating: Option<Bits>,
    pub(crate) roster_prior_offset: Option<Bits>,
    pub(crate) published_roster_prior_offset: Bits,
    pub(crate) updated_roster_prior_offset: Bits,
    pub(crate) uncertainty: Option<Bits>,
    pub(crate) momentum: Option<Bits>,
    pub(crate) league_delta: Bits,
    pub(crate) updated_league_score: Bits,
    pub(crate) components: Components,
    pub(crate) display_rating: Bits,
    pub(crate) history_delta: Bits,
    pub(crate) history: HistoryValues,
    pub(crate) latest_rating_update: Ledger,
    pub(crate) factors: Factors,
    pub(crate) factor_sums: Option<Factors>,
    pub(crate) factor_count: Option<Bits>,
    pub(crate) wins: Option<Bits>,
    pub(crate) losses: Option<Bits>,
    pub(crate) form: Option<Vec<Outcome>>,
    pub(crate) last_patch: Option<String>,
    pub(crate) last_roster: Option<Source>,
    pub(crate) last_roster_fingerprint: Option<String>,
    pub(crate) league: League,
}
/// Numeric values of the team history point. Its all-team rank and source trace stay Node-owned.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryValues {
    pub(crate) rating: Bits,
    pub(crate) base_rating: Bits,
    pub(crate) league_adjustment: Bits,
    pub(crate) side_adjustment: Bits,
    pub(crate) delta: Bits,
    pub(crate) result: Outcome,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Components {
    pub(crate) league_anchor: Bits,
    pub(crate) team_stable_offset: Bits,
    pub(crate) roster_prior_offset: Bits,
    pub(crate) momentum: Bits,
    pub(crate) context_adjustment: Bits,
    pub(crate) uncertainty: Bits,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Ledger {
    pub(crate) team_stable_delta: Bits,
    pub(crate) league_game_delta: Bits,
    pub(crate) league_placement_delta: Bits,
    pub(crate) momentum_delta: Bits,
    pub(crate) roster_prior_delta: Bits,
    pub(crate) uncertainty_delta: Bits,
    pub(crate) side_adjustment: Bits,
    pub(crate) patch_adjustment: Bits,
    pub(crate) rating_target: &'static str,
    pub(crate) update_unit: &'static str,
    pub(crate) event_weight: Bits,
    pub(crate) result_evidence: Bits,
    pub(crate) base_team_stable_delta: Bits,
    pub(crate) base_team_form_delta: Bits,
    pub(crate) base_league_delta: Bits,
    pub(crate) uncertainty_multiplier: Bits,
    pub(crate) roster_volatility_multiplier: Bits,
    pub(crate) stable_transfer_weight: Bits,
    pub(crate) neutral_result_residual: Bits,
    pub(crate) series_strength_signal: Bits,
    pub(crate) team_stable_share: Bits,
    pub(crate) team_form_share: Bits,
    pub(crate) player_signal_share: Bits,
    pub(crate) lineup_signal_share: Bits,
    pub(crate) league_signal_share: Bits,
    pub(crate) direct_region_signal_share: Bits,
    pub(crate) player_signal_delta: Bits,
    pub(crate) lineup_signal_delta: Bits,
    pub(crate) direct_region_signal_delta: Bits,
    pub(crate) unavailable_channels: Vec<&'static str>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LeaguePoint {
    pub(crate) date: String,
    pub(crate) event: String,
    pub(crate) tier: String,
    pub(crate) league: String,
    pub(crate) region: String,
    pub(crate) opponent_league: String,
    pub(crate) opponent_region: String,
    pub(crate) result: Outcome,
    pub(crate) score: Bits,
    pub(crate) delta: Bits,
    pub(crate) wins: Bits,
    pub(crate) losses: Bits,
    pub(crate) expected_wins: Option<Bits>,
    pub(crate) wins_over_expected: Option<Bits>,
    pub(crate) opponent_adjusted_win_rate: Option<Bits>,
    pub(crate) average_opponent_rating: Option<Bits>,
    pub(crate) international_matches: Bits,
}
/// Where a stored object came from: the pre-date value, or a member side's observed value.
#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Source {
    Prior,
    Member {
        series: usize,
        member: usize,
        side: usize,
    },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamAfter {
    pub(crate) team: String,
    pub(crate) rating: Option<Bits>,
    pub(crate) execution_rating: Option<Bits>,
    pub(crate) uncertainty: Option<Bits>,
    pub(crate) momentum: Option<Bits>,
    pub(crate) roster_prior_offset: Option<Bits>,
    pub(crate) roster_continuity: Option<Bits>,
    pub(crate) previous_display_rating: Option<Bits>,
    pub(crate) wins: Option<Bits>,
    pub(crate) losses: Option<Bits>,
    pub(crate) form: Option<Vec<Outcome>>,
    pub(crate) factors: Option<Factors>,
    pub(crate) factor_count: Option<Bits>,
    pub(crate) last_roster: Option<Source>,
    pub(crate) last_patch: Option<String>,
    pub(crate) last_roster_fingerprint: Option<String>,
    pub(crate) latest_rating_update: Option<Source>,
}
#[derive(Serialize)]
pub(crate) struct Inserted {
    pub(crate) teams: TeamInsertions,
    pub(crate) leagues: LeagueInsertions,
}
/// Frame team indexes that each team-keyed map gained, in insertion order.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamInsertions {
    pub(crate) ratings: Vec<usize>,
    pub(crate) execution_ratings: Vec<usize>,
    pub(crate) uncertainties: Vec<usize>,
    pub(crate) momentums: Vec<usize>,
    pub(crate) roster_prior_offsets: Vec<usize>,
    pub(crate) roster_continuity: Vec<usize>,
    pub(crate) previous_display_ratings: Vec<usize>,
    pub(crate) wins: Vec<usize>,
    pub(crate) losses: Vec<usize>,
    pub(crate) forms: Vec<usize>,
    pub(crate) factor_sums: Vec<usize>,
    pub(crate) factor_counts: Vec<usize>,
    pub(crate) last_rosters: Vec<usize>,
    pub(crate) last_patches: Vec<usize>,
    pub(crate) last_roster_fingerprints: Vec<usize>,
    pub(crate) latest_rating_updates: Vec<usize>,
}
/// Frame league indexes that each league-keyed map gained, in insertion order.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LeagueInsertions {
    pub(crate) scores: Vec<usize>,
    pub(crate) previous_scores: Vec<usize>,
    pub(crate) wins: Vec<usize>,
    pub(crate) losses: Vec<usize>,
    pub(crate) expected_wins: Vec<usize>,
    pub(crate) opponent_rating_sums: Vec<usize>,
    pub(crate) forms: Vec<usize>,
    pub(crate) match_counts: Vec<usize>,
    pub(crate) last_events: Vec<usize>,
    pub(crate) last_updated: Vec<usize>,
}
