use crate::{
    Options, Result, USER_AGENT,
    http::{Http, Policy, set_query_parameter},
    timestamp, write_json,
};
use num_bigint::BigUint;
use num_traits::ToPrimitive;
use reqwest::Url;
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path, time::Duration};

const FIELDS: [&str; 12] = [
    "OverviewPage",
    "Team1",
    "Team2",
    "WinTeam",
    "LossTeam",
    "DateTime_UTC",
    "Patch",
    "GameId",
    "Team1Kills",
    "Team2Kills",
    "Team1Gold",
    "Team2Gold",
];

pub fn download(
    http: &mut Http,
    options: &Options,
    output: &Path,
    start: &str,
    end: &str,
) -> Result<()> {
    let base = options
        .text("leaguepediaBaseUrl")
        .or(options.text("leaguepediaBase"))
        .unwrap_or("https://lol.fandom.com/wiki/Special:CargoExport");
    let policy = Policy {
        attempts: 7,
        base_delay_ms: 1000,
        leaguepedia: true,
    };
    let mut matches = Vec::new();
    let mut offset = 0;
    let result = (|| -> Result<()> {
        loop {
            let mut url = Url::parse(base)?;
            for (key, value) in [
                ("format", "csv".to_owned()),
                ("tables", "ScoreboardGames".to_owned()),
                ("fields", FIELDS.join(",")),
                (
                    "where",
                    format!(
                        "DateTime_UTC >= \"{start} 00:00:00\" AND DateTime_UTC <= \"{end} 23:59:59\" AND Team1 IS NOT NULL AND Team2 IS NOT NULL AND WinTeam IS NOT NULL"
                    ),
                ),
                ("order_by", "DateTime_UTC ASC".to_owned()),
                ("limit", "500".to_owned()),
                ("offset", offset.to_string()),
            ] {
                set_query_parameter(&mut url, key, &value);
            }
            let response = http.get(url, &[("user-agent", USER_AGENT)], &policy)?;
            let rows = csv_rows(&response.text())?;
            let Some(header) = rows.first() else {
                return Err("Leaguepedia CargoExport returned an unexpected CSV schema".into());
            };
            if !FIELDS
                .iter()
                .all(|field| header.contains(&field.replace('_', " ")))
            {
                return Err("Leaguepedia CargoExport returned an unexpected CSV schema".into());
            }
            let count = rows.len() - 1;
            for row in &rows[1..] {
                let fields = header
                    .iter()
                    .enumerate()
                    .map(|(index, key)| {
                        (
                            key.as_str(),
                            row.get(index).map(String::as_str).unwrap_or(""),
                        )
                    })
                    .collect::<HashMap<_, _>>();
                let get = |key| fields.get(key).copied().unwrap_or("");
                let number = |key| {
                    let value = get(key);
                    if value.is_empty() {
                        Value::Null
                    } else {
                        js_number(value).map_or(Value::Null, |v| json!(v))
                    }
                };
                matches.push(json!({"id":get("GameId"),"date":get("DateTime UTC").chars().take(10).collect::<String>(),"datetimeUtc":get("DateTime UTC"),"event":get("OverviewPage"),"patch":get("Patch"),"teamA":get("Team1"),"teamB":get("Team2"),"winner":get("WinTeam"),"loser":get("LossTeam"),"teamAKills":number("Team1Kills"),"teamBKills":number("Team2Kills"),"teamAGold":number("Team1Gold"),"teamBGold":number("Team2Gold")}));
            }
            if count < 500 {
                break;
            }
            offset += count;
            std::thread::sleep(Duration::from_millis(1200));
        }
        Ok(())
    })();
    if let Err(error) = result {
        if http.terminal_failure {
            write_json(
                output,
                &json!({"source":"Leaguepedia Cargo ScoreboardGames","fetchedAt":timestamp(),"start":start,"end":end,"status":"failed","fetchTelemetry":http.snapshot(),"matches":[]}),
            )?;
        }
        return Err(error);
    }
    write_json(
        output,
        &json!({"source":"Leaguepedia Cargo ScoreboardGames","sourceUrl":base,"fetchedAt":timestamp(),"start":start,"end":end,"matches":matches,"fetchTelemetry":http.snapshot()}),
    )
}

fn js_number(value: &str) -> Option<f64> {
    let value = value.trim_matches(|c| {
        matches!(c,
        '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
    });
    if value.is_empty() {
        return Some(0.0);
    }
    let radix = match value.as_bytes().get(..2) {
        Some([b'0', b'x' | b'X']) => Some(16),
        Some([b'0', b'b' | b'B']) => Some(2),
        Some([b'0', b'o' | b'O']) => Some(8),
        _ => None,
    };
    let number = if let Some(radix) = radix {
        let digits = &value[2..];
        if digits.is_empty() || !digits.chars().all(|digit| digit.is_digit(radix)) {
            return None;
        }
        // Parse the integer exactly, then round once as JavaScript Number does.
        BigUint::parse_bytes(digits.as_bytes(), radix)?.to_f64()?
    } else {
        value.parse::<f64>().ok()?
    };
    number.is_finite().then_some(number)
}

pub(crate) fn csv_rows(input: &str) -> Result<Vec<Vec<String>>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut characters = input.chars().peekable();
    while let Some(character) = characters.next() {
        match character {
            '"' if quoted && characters.peek() == Some(&'"') => {
                characters.next();
                field.push('"');
            }
            '"' => quoted = !quoted,
            ',' if !quoted => {
                row.push(std::mem::take(&mut field));
            }
            '\r' | '\n' if !quoted => {
                if character == '\r' && characters.peek() == Some(&'\n') {
                    characters.next();
                }
                row.push(std::mem::take(&mut field));
                if row.iter().any(|v| !v.is_empty()) {
                    rows.push(std::mem::take(&mut row));
                }
                row.clear();
            }
            _ => field.push(character),
        }
    }
    if quoted {
        return Err("Leaguepedia CargoExport returned malformed CSV".into());
    }
    row.push(field);
    if row.iter().any(|v| !v.is_empty()) {
        rows.push(row);
    }
    Ok(rows)
}
