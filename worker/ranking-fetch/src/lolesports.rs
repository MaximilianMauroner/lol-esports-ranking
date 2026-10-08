use crate::{
    Options, Result,
    http::{Http, Policy, set_query_parameter},
    timestamp, write_json,
};
use reqwest::Url;
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path, time::Duration};

const API_KEY: &str = "0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z";
const WARNING: &str = "LoL Esports persisted APIs are public site endpoints, not a supported official data API. Cache responses and use them as reference metadata only.";

pub fn download(
    http: &mut Http,
    options: &Options,
    output: &Path,
    start: &str,
    end: &str,
) -> Result<()> {
    let base = options
        .text("lolesportsBaseUrl")
        .or(options.text("lolesportsBase"))
        .unwrap_or("https://esports-api.lolesports.com/persisted/gw");
    let older = options.number("lolesportsOlderPages", options.number("lolesportsOlder", 4));
    let newer = options.number("lolesportsNewerPages", options.number("lolesportsNewer", 1));
    let limit = options.number("lolesportsDetailLimit", 250) as usize;
    let locale = "en-US";
    let headers = [
        ("x-api-key", API_KEY),
        (
            "user-agent",
            "lol-esports-power-index-local/0.1 (unsupported lolesports reference cache)",
        ),
    ];
    let mut pages = Vec::new();
    let mut warnings = vec![WARNING.to_owned()];
    let fetch = |http: &mut Http, path: &str, key: Option<(&str, &str)>| -> Result<Value> {
        let mut url = Url::parse(&format!("{base}/{path}"))?;
        set_query_parameter(&mut url, "hl", locale);
        if let Some((key, value)) = key {
            set_query_parameter(&mut url, key, value);
        }
        let response = http.get(url, &headers, &Policy::default())?;
        response.json().map_err(|_| "Invalid JSON response".into())
    };
    let result = (|| -> Result<Value> {
        let initial = fetch(http, "getSchedule", None)?;
        pages.push(page("initial", None, &initial));
        for (direction, count) in [("older", older), ("newer", newer)] {
            let mut token = initial["data"]["schedule"]["pages"][direction]
                .as_str()
                .map(str::to_owned);
            for _ in 0..count {
                let Some(value) = token.filter(|v| !v.is_empty()) else {
                    break;
                };
                let response = fetch(http, "getSchedule", Some(("pageToken", &value)))?;
                pages.push(page(direction, Some(&value), &response));
                token = response["data"]["schedule"]["pages"][direction]
                    .as_str()
                    .map(str::to_owned);
                std::thread::sleep(Duration::from_millis(250));
            }
        }
        let mut seen = HashSet::new();
        let mut events = pages
            .iter()
            .filter_map(|p| p["events"].as_array())
            .flatten()
            .filter(|event| {
                let key = event["match"]["id"]
                    .as_str()
                    .or(event["id"].as_str())
                    .filter(|v| !v.is_empty())
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        format!(
                            "{}:{}:{}",
                            event["startTime"].as_str().unwrap_or("unknown"),
                            event["league"]["slug"].as_str().unwrap_or("unknown"),
                            event["blockName"].as_str().unwrap_or("unknown")
                        )
                    });
                seen.insert(key)
            })
            .cloned()
            .collect::<Vec<_>>();
        events.sort_by(|a, b| {
            ranking_contracts::compare_code_units(
                a["startTime"].as_str().unwrap_or(""),
                b["startTime"].as_str().unwrap_or(""),
            )
        });
        let selected = events
            .iter()
            .filter(|event| {
                let date = event["startTime"]
                    .as_str()
                    .unwrap_or("")
                    .chars()
                    .take(10)
                    .collect::<String>();
                date.as_str() >= start && date.as_str() <= end
            })
            .cloned()
            .collect::<Vec<_>>();
        if selected.len() > limit {
            warnings.push(format!("LoL Esports event-detail fetch limited to {limit} of {} schedule events. Increase --detail-limit to cache more game IDs.",selected.len()));
        }
        let mut details = Vec::new();
        for event in selected.iter().take(limit) {
            let Some(id) = event["match"]["id"]
                .as_str()
                .or(event["id"].as_str())
                .filter(|v| !v.is_empty())
            else {
                continue;
            };
            match fetch(http, "getEventDetails", Some(("id", id))) {
                Ok(response) => {
                    let mut detail = json!({"id":id});
                    if let Some(event) = response["data"].get("event") {
                        detail["event"] = event.clone();
                    }
                    details.push(detail);
                    std::thread::sleep(Duration::from_millis(250));
                }
                Err(error) => warnings.push(format!(
                    "LoL Esports getEventDetails failed for {id}: {error}"
                )),
            }
        }
        let mut dates = events
            .iter()
            .filter_map(|e| e["startTime"].as_str())
            .filter(|v| !v.is_empty())
            .map(|v| v.chars().take(10).collect::<String>())
            .collect::<Vec<_>>();
        dates.sort_by(|a, b| ranking_contracts::compare_code_units(a, b));
        if let Some(earliest) = dates.first().filter(|v| v.as_str() > start) {
            warnings.push(format!("LoL Esports schedule cache starts at {earliest}, after requested start {start}; increase --older-pages for a wider reference window."));
        }
        if let Some(latest) = dates.last().filter(|v| v.as_str() < end) {
            warnings.push(format!("LoL Esports schedule cache ends at {latest}, before requested end {end}; increase --newer-pages for a wider reference window."));
        }
        Ok(
            json!({"source":format!("{base}/getSchedule"),"fetchedAt":timestamp(),"locale":locale,"start":start,"end":end,"unsupportedApi":true,"pageLimits":{"olderPages":older,"newerPages":newer,"detailLimit":limit},"events":selected,"schedulePages":pages,"eventDetails":details,"fetchTelemetry":http.snapshot(),"warnings":warnings}),
        )
    })();
    match result {
        Ok(value) => write_json(output, &value),
        Err(error) => {
            if http.terminal_failure {
                write_json(
                    output,
                    &json!({"source":format!("{base}/getSchedule"),"fetchedAt":timestamp(),"locale":locale,"start":start,"end":end,"status":"failed","fetchTelemetry":http.snapshot(),"events":[],"schedulePages":[],"eventDetails":[],"warnings":warnings}),
                )?;
            }
            Err(error)
        }
    }
}

fn page(direction: &str, token: Option<&str>, response: &Value) -> Value {
    let schedule = &response["data"]["schedule"];
    let mut page = json!({"direction":direction});
    if let Some(token) = token {
        page["requestedPageToken"] = json!(token);
    }
    for key in ["updated", "pages"] {
        if let Some(value) = schedule.get(key) {
            page[key] = value.clone();
        }
    }
    page["events"] = schedule
        .get("events")
        .filter(|v| v.is_array())
        .cloned()
        .unwrap_or(json!([]));
    page
}
