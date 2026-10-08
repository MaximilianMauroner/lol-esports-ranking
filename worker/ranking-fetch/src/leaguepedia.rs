use crate::{
    Options, Result, USER_AGENT,
    http::{Http, Policy},
    timestamp, write_json,
};
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
            url.query_pairs_mut().append_pair("format", "csv")
                .append_pair("tables", "ScoreboardGames").append_pair("fields", &FIELDS.join(","))
                .append_pair("where", &format!("DateTime_UTC >= \"{start} 00:00:00\" AND DateTime_UTC <= \"{end} 23:59:59\" AND Team1 IS NOT NULL AND Team2 IS NOT NULL AND WinTeam IS NOT NULL"))
                .append_pair("order_by", "DateTime_UTC ASC").append_pair("limit", "500").append_pair("offset", &offset.to_string());
            let response = http.get(
                url,
                &[("user-agent", options.text_or("userAgent", USER_AGENT))],
                &policy,
            )?;
            let rows = csv_rows(&String::from_utf8_lossy(&response.body))?;
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
                        value
                            .trim()
                            .parse::<f64>()
                            .ok()
                            .filter(|v| v.is_finite())
                            .map_or(Value::Null, |v| json!(v))
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
        write_json(
            output,
            &json!({"source":"Leaguepedia Cargo ScoreboardGames","fetchedAt":timestamp(),"start":start,"end":end,"status":"failed","fetchTelemetry":http.snapshot(),"matches":[]}),
        )?;
        return Err(error);
    }
    write_json(
        output,
        &json!({"source":"Leaguepedia Cargo ScoreboardGames","sourceUrl":base,"fetchedAt":timestamp(),"start":start,"end":end,"matches":matches,"fetchTelemetry":http.snapshot()}),
    )
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
