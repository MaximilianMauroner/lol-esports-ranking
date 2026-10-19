mod engine;

use chrono::NaiveDate;
use engine::{FIELDS, Model};
use ranking_contracts::{Result, compare_code_units, sha256};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::{
    collections::{BTreeMap, HashSet},
    fs::File,
    io::Read,
};

pub const MAX_BATCH_BYTES: u64 = 64 << 20;
const MAX_DATE_BYTES: usize = 8 << 20;

#[derive(Clone, Copy, Debug)]
struct Bits(f64);
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
        serializer.serialize_str(&format!("{:016x}", self.0.to_bits()))
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Team {
    team: String,
    league: String,
    current_power_rating: Bits,
    uncertainty: Bits,
    #[serde(deserialize_with = "Option::<Bits>::deserialize")]
    roster_continuity: Option<Bits>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    teams: [Team; 2],
    best_of: u8,
    observed_outcome_a: Bits,
    observed_outcome_b: Bits,
    strength_signal: Bits,
    event_k: Bits,
    international: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Series {
    series_id: String,
    match_ids: Vec<String>,
    input: Input,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Date {
    utc_date: String,
    authoritative_match_ids: Vec<String>,
    series: Vec<Series>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelIdentity {
    version: String,
    config_hash: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    schema: String,
    model: ModelIdentity,
    dates: Vec<Date>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SeriesOutput {
    series_id: String,
    match_ids: Vec<String>,
    result: BTreeMap<&'static str, Bits>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DateOutput {
    utc_date: String,
    authoritative_match_ids: Vec<String>,
    series: Vec<SeriesOutput>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    schema: &'static str,
    request_sha256: String,
    model: ModelIdentity,
    dates: Vec<DateOutput>,
}

fn identity(text: &str) -> Result<()> {
    if text.is_empty() || text.len() > 4096 || text.chars().any(char::is_control) {
        return Err("invalid identity string".into());
    }
    Ok(())
}
fn validate(request: &Request) -> Result<()> {
    let metadata = ranking_contracts::model::metadata();
    if request.schema != "series-result-batch-v1"
        || request.model.version != metadata["modelVersion"]
        || request.model.config_hash != metadata["modelConfigHash"]
    {
        return Err("schema or model/config mismatch".into());
    }
    if request.dates.is_empty() || request.dates.len() > 3660 {
        return Err("date count exceeds bounds".into());
    }
    let mut previous = "";
    let mut series_ids = HashSet::new();
    let mut match_ids = HashSet::new();
    for date in &request.dates {
        if date.utc_date.len() != 10
            || !date.utc_date.bytes().enumerate().all(|(i, c)| {
                if i == 4 || i == 7 {
                    c == b'-'
                } else {
                    c.is_ascii_digit()
                }
            })
            || NaiveDate::parse_from_str(&date.utc_date, "%Y-%m-%d").is_err()
            || date.utc_date.as_str() <= previous
        {
            return Err("invalid date or date order".into());
        }
        previous = &date.utc_date;
        if date.series.is_empty()
            || date.series.len() > 4096
            || date.authoritative_match_ids.len() > 16384
            || serde_json::to_vec(date).map_err(|e| e.to_string())?.len() > MAX_DATE_BYTES
        {
            return Err("complete date exceeds bounds".into());
        }
        let mut members = HashSet::new();
        for id in &date.authoritative_match_ids {
            identity(id)?;
            if !members.insert(id.as_str()) || !match_ids.insert(id.as_str()) {
                return Err("duplicate match identity".into());
            }
        }
        if !date
            .authoritative_match_ids
            .windows(2)
            .all(|pair| compare_code_units(&pair[0], &pair[1]).is_lt())
        {
            return Err("authoritative match identities are not ordered".into());
        }
        let mut seen = HashSet::new();
        for series in &date.series {
            identity(&series.series_id)?;
            if !series_ids.insert(series.series_id.as_str()) || series_ids.len() > 100_000 {
                return Err("duplicate series identity or series limit".into());
            }
            if series.match_ids.is_empty() || series.match_ids.len() > 64 {
                return Err("invalid series member count".into());
            }
            for id in &series.match_ids {
                identity(id)?;
                if !members.contains(id.as_str()) || !seen.insert(id.as_str()) {
                    return Err("series date membership mismatch".into());
                }
            }
            let input = &series.input;
            if !matches!(input.best_of, 1 | 2 | 3 | 5) {
                return Err("unsupported series format".into());
            }
            for team in &input.teams {
                identity(&team.team)?;
                if team.league.len() > 4096 {
                    return Err("league string exceeds bounds".into());
                }
            }
            if input.teams[0].team == input.teams[1].team {
                return Err("series teams must differ".into());
            }
        }
        if seen != members {
            return Err("incomplete authoritative date membership".into());
        }
    }
    Ok(())
}

pub fn calculate_batch(bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.len() as u64 > MAX_BATCH_BYTES {
        return Err("request exceeds 64 MiB".into());
    }
    let request: Request = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    validate(&request)?;
    let model = Model::live()?;
    let mut dates = Vec::with_capacity(request.dates.len());
    for date in request.dates {
        let mut series_outputs = Vec::with_capacity(date.series.len());
        for series in date.series {
            let values = model.calculate(&series.input)?;
            series_outputs.push(SeriesOutput {
                series_id: series.series_id,
                match_ids: series.match_ids,
                result: FIELDS.into_iter().zip(values).collect(),
            });
        }
        dates.push(DateOutput {
            utc_date: date.utc_date,
            authoritative_match_ids: date.authoritative_match_ids,
            series: series_outputs,
        });
    }
    let output = serde_json::to_vec(&Response {
        schema: "series-result-response-v1",
        request_sha256: sha256(bytes),
        model: request.model,
        dates,
    })
    .map_err(|e| e.to_string())?;
    if output.len() as u64 > MAX_BATCH_BYTES {
        return Err("response exceeds 64 MiB".into());
    }
    Ok(output)
}

pub fn run(input: &str, output: &str) -> Result<()> {
    let mut bytes = Vec::new();
    File::open(input)
        .map_err(|e| e.to_string())?
        .take(MAX_BATCH_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let response = calculate_batch(&bytes)?;
    std::fs::write(output, response).map_err(|e| e.to_string())
}
