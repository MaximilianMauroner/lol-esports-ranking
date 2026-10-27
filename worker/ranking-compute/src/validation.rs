use crate::wire::*;
use chrono::{DateTime, NaiveDate};
use ranking_contracts::{Result, compare_code_units};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
};

const MAX_DATE_BYTES: usize = 8 << 20;
const MAX_TEXT_BYTES: usize = 4096;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn identity(text: &str) -> Result<()> {
    if text.is_empty() || text.len() > MAX_TEXT_BYTES {
        return Err("invalid identity string".into());
    }
    Ok(())
}
fn text(text: &str) -> Result<()> {
    if text.len() > MAX_TEXT_BYTES {
        return Err("string exceeds bounds".into());
    }
    Ok(())
}
fn calendar(date: &str) -> bool {
    date.len() == 10
        && date.bytes().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
        && NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok()
}
fn form(form: Option<&Vec<Outcome>>) -> Result<()> {
    if form.is_some_and(|form| form.len() > 64) {
        return Err("form exceeds bounds".into());
    }
    Ok(())
}
fn roster(roster: Option<&Roster>) -> Result<()> {
    if let Some(roster) = roster {
        if roster.players.len() > 5
            || (roster.completeness.is_complete() && !matches!(roster.players.len(), 0 | 5))
        {
            return Err("invalid roster size".into());
        }
        let mut roles = HashSet::new();
        let mut players = HashSet::new();
        for player in &roster.players {
            identity(&player.id)?;
            if !roles.insert(player.role) || !players.insert(&player.id) {
                return Err("duplicate roster role or player".into());
            }
        }
    }
    Ok(())
}
fn count(value: Option<Bits>, integer: bool, headroom: usize) -> Result<()> {
    if value.is_some_and(|bits| {
        bits.0 < 0.0
            || bits.0 > MAX_SAFE_INTEGER - headroom as f64
            || (integer && bits.0.fract() != 0.0)
    }) {
        return Err("invalid count or count overflow".into());
    }
    Ok(())
}
fn unique<'a>(names: impl Iterator<Item = &'a str>) -> Result<HashMap<&'a str, usize>> {
    let mut indexes = HashMap::new();
    for (index, name) in names.enumerate() {
        text(name)?;
        if indexes.insert(name, index).is_some() {
            return Err("duplicate frame entity".into());
        }
    }
    Ok(indexes)
}
fn compare_option(left: Option<&String>, right: Option<&String>, fallback: &str) -> Ordering {
    compare_code_units(
        left.map_or(fallback, String::as_str),
        right.map_or(fallback, String::as_str),
    )
}
/// The canonical resolver's member order: UTC time, game number, official, source and record IDs.
fn member_order(left: &Member, right: &Member) -> Ordering {
    let (a, b) = (&left.ordering, &right.ordering);
    let games = a.game_number.0 - b.game_number.0;
    compare_option(a.datetime_utc.as_ref(), b.datetime_utc.as_ref(), "9999")
        .then(games.partial_cmp(&0.0).unwrap_or(Ordering::Equal))
        .then_with(|| compare_option(a.official_game_id.as_ref(), b.official_game_id.as_ref(), ""))
        .then_with(|| compare_option(a.source_game_id.as_ref(), b.source_game_id.as_ref(), ""))
        .then_with(|| compare_code_units(&left.id, &right.id))
}
/// The earliest nonempty member start time, which orders canonical series within a date.
pub(crate) fn series_start(series: &SeriesFrame) -> &str {
    series
        .members
        .iter()
        .filter_map(|member| member.ordering.datetime_utc.as_deref())
        .filter(|time| !time.is_empty())
        .min_by(|left, right| compare_code_units(left, right))
        .unwrap_or("")
}

pub(crate) fn validate(request: &Request) -> Result<()> {
    let metadata = ranking_contracts::model::metadata();
    if request.schema != REQUEST_SCHEMA
        || request.model.version != metadata["modelVersion"]
        || request.model.config_hash != metadata["modelConfigHash"]
    {
        return Err("schema or model/config mismatch".into());
    }
    if request.dates.is_empty() || request.dates.len() > 3660 {
        return Err("date count exceeds bounds".into());
    }
    let mut previous = "";
    let mut series_count = 0;
    let mut match_ids = HashSet::new();
    for frame in &request.dates {
        if !calendar(&frame.utc_date)
            || !calendar(&frame.last_date)
            || frame.last_date < frame.utc_date
            || frame.utc_date.as_str() <= previous
        {
            return Err("invalid date or date order".into());
        }
        previous = &frame.utc_date;
        if frame.series.is_empty()
            || frame.series.len() > 4096
            || frame.authoritative_match_ids.len() > 16384
            || frame.teams.len() > 8192
            || frame.leagues.len() > 4096
            || frame.side_samples.len() > 4096
            || serde_json::to_vec(frame).map_err(|e| e.to_string())?.len() > MAX_DATE_BYTES
        {
            return Err("complete date exceeds bounds".into());
        }
        let mut members = HashSet::new();
        for id in &frame.authoritative_match_ids {
            identity(id)?;
            if !members.insert(id.as_str()) || !match_ids.insert(id.as_str()) {
                return Err("duplicate match identity".into());
            }
        }
        if !frame
            .authoritative_match_ids
            .windows(2)
            .all(|pair| compare_code_units(&pair[0], &pair[1]).is_lt())
        {
            return Err("authoritative match identities are not ordered".into());
        }
        for team in &frame.teams {
            identity(&team.team)?;
            form(team.form.as_ref())?;
            roster(team.last_roster.as_ref())?;
            text(team.last_patch.as_deref().unwrap_or(""))?;
            text(team.last_roster_fingerprint.as_deref().unwrap_or(""))?;
            for value in [team.wins, team.losses, team.factor_count] {
                count(value, true, frame.authoritative_match_ids.len())?;
            }
        }
        count(
            Some(frame.processed_match_count),
            true,
            frame.authoritative_match_ids.len(),
        )?;
        for league in &frame.leagues {
            form(league.form.as_ref())?;
            text(league.last_event.as_deref().unwrap_or(""))?;
            text(league.last_updated.as_deref().unwrap_or(""))?;
            if league
                .last_updated
                .as_ref()
                .is_some_and(|date| !calendar(date) || date > &frame.utc_date)
            {
                return Err("invalid league update date".into());
            }
            for value in [league.wins, league.losses, league.expected_wins] {
                count(value, false, frame.authoritative_match_ids.len())?;
            }
            count(
                league.match_count,
                true,
                frame.authoritative_match_ids.len(),
            )?;
        }
        for (_, sample) in &frame.side_samples {
            count(
                Some(sample.blue_wins),
                true,
                frame.authoritative_match_ids.len() * 2,
            )?;
            count(
                Some(sample.total),
                true,
                frame.authoritative_match_ids.len() * 2,
            )?;
            if sample.blue_wins.0 > sample.total.0 {
                return Err("side sample wins exceed total".into());
            }
        }
        unique(frame.teams.iter().map(|team| team.team.as_str()))?;
        unique(frame.leagues.iter().map(|league| league.league.as_str()))?;
        unique(frame.side_samples.iter().map(|(key, _)| key.as_str()))?;
        let mut teams_used = vec![false; frame.teams.len()];
        let mut leagues_used = vec![false; frame.leagues.len()];
        let mut use_team = |index: usize| match teams_used.get_mut(index) {
            Some(used) => {
                *used = true;
                Ok(())
            }
            None => Err("team index out of range"),
        };
        let mut use_league = |index: usize| match leagues_used.get_mut(index) {
            Some(used) => {
                *used = true;
                Ok(())
            }
            None => Err("league index out of range"),
        };
        let mut seen = HashSet::new();
        let mut series_ids = HashSet::new();
        for (index, series) in frame.series.iter().enumerate() {
            identity(&series.series_id)?;
            series_count += 1;
            if !series_ids.insert(series.series_id.as_str()) || series_count > 100_000 {
                return Err("duplicate series identity or series limit".into());
            }
            if index > 0 {
                let before = &frame.series[index - 1];
                if compare_code_units(series_start(before), series_start(series))
                    .then_with(|| compare_code_units(&before.series_id, &series.series_id))
                    .is_ge()
                {
                    return Err("canonical series are not ordered".into());
                }
            }
            if !matches!(series.best_of, 1 | 2 | 3 | 5) {
                return Err("unsupported series format".into());
            }
            if series.members.is_empty() || series.members.len() > 64 {
                return Err("invalid series member count".into());
            }
            if u64::from(series.wins[0]) + u64::from(series.wins[1]) > series.members.len() as u64 {
                return Err("series wins exceed members".into());
            }
            if series.continuity_retention == Some([ContinuityRetention::BaselineContraction; 2]) {
                return Err("an all-baseline continuity retention must be omitted".into());
            }
            for team in series.teams {
                use_team(team)?;
            }
            for league in series.leagues {
                use_league(league)?;
            }
            if !compare_code_units(
                &frame.teams[series.teams[0]].team,
                &frame.teams[series.teams[1]].team,
            )
            .is_lt()
            {
                return Err("canonical series teams are not ordered or distinct".into());
            }
            let mut wins = [0_u32; 2];
            let mut date_anchored = false;
            for (position, member) in series.members.iter().enumerate() {
                identity(&member.match_id)?;
                identity(&member.id)?;
                if !members.contains(member.match_id.as_str())
                    || !seen.insert(member.match_id.as_str())
                {
                    return Err("series date membership mismatch".into());
                }
                for value in [
                    &member.ordering.datetime_utc,
                    &member.ordering.official_game_id,
                    &member.ordering.source_game_id,
                ] {
                    text(value.as_deref().unwrap_or(""))?;
                }
                if member.match_id
                    != *member
                        .ordering
                        .official_game_id
                        .as_ref()
                        .or(member.ordering.source_game_id.as_ref())
                        .unwrap_or(&member.id)
                {
                    return Err("replay identity differs from source identity".into());
                }
                if let Some(time) = &member.ordering.datetime_utc {
                    let parsed = DateTime::parse_from_rfc3339(time)
                        .map_err(|_| "invalid member UTC time")?;
                    let date = parsed.format("%Y-%m-%d").to_string();
                    if parsed.offset().local_minus_utc() != 0 || date < frame.utc_date {
                        return Err("member time precedes its UTC date or is not UTC".into());
                    }
                    date_anchored |= date == frame.utc_date;
                } else {
                    date_anchored = true;
                }
                count(Some(member.ordering.game_number), true, 0)?;
                if member.ordering.game_number.0 < 1.0
                    || member.event_k.0 < 0.0
                    || member.event_weight.0 < 0.0
                {
                    return Err("invalid game number or event weight".into());
                }
                if position > 0 && member_order(&series.members[position - 1], member).is_gt() {
                    return Err("series members are not ordered".into());
                }
                for side in &member.sides {
                    use_team(side.team)?;
                    use_league(side.league)?;
                    text(&side.region)?;
                    roster(side.roster.as_ref())?;
                    if !series.teams.contains(&side.team) {
                        return Err("member team is outside canonical series".into());
                    }
                    for value in [
                        Some(side.kills),
                        Some(side.gold),
                        side.towers,
                        side.dragons,
                        side.barons,
                    ] {
                        count(value, false, 0)?;
                    }
                }
                if member.sides[0].team == member.sides[1].team || member.winner > 1 {
                    return Err("invalid member sides".into());
                }
                if member.sides[0].colour.is_some()
                    && member.sides[0].colour == member.sides[1].colour
                {
                    return Err("member side colours must differ".into());
                }
                let winner = member.sides[usize::from(member.winner)].team;
                wins[usize::from(winner != series.teams[0])] += 1;
                text(&member.patch)?;
                text(&member.event)?;
                text(&member.tier)?;
            }
            if !date_anchored {
                return Err("series has no member on its UTC date".into());
            }
            if wins != series.wins {
                return Err("series wins differ from member winners".into());
            }
            let final_member = &series.members[series.members.len() - 1];
            for side in &final_member.sides {
                let position = usize::from(side.team != series.teams[0]);
                if side.league != series.leagues[position] {
                    return Err("series league differs from final member".into());
                }
            }
        }
        if seen != members {
            return Err("incomplete authoritative date membership".into());
        }
        if teams_used.contains(&false) || leagues_used.contains(&false) {
            return Err("frame lists an unaffected entity".into());
        }
    }
    Ok(())
}
