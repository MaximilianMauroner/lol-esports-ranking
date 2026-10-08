mod http;
mod leaguepedia;
mod lolesports;
mod oracle;

use http::Http;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
const USER_AGENT: &str = "lol-esports-power-index-local/0.1 (public data research)";
const DRIVE_ID: &str = "1gLSw0RLjBbtaNy0dgnGQDAZOHIgCe-HH";

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("UTC clock after epoch")
        .as_millis() as u64
}
fn timestamp() -> String {
    chrono::DateTime::from_timestamp_millis(now_ms() as i64)
        .expect("current timestamp")
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[derive(Default)]
pub(crate) struct Options(HashMap<String, Value>);
impl Options {
    fn parse(args: &[String]) -> Self {
        let mut values = HashMap::new();
        let mut index = 0;
        while index < args.len() {
            if let Some(key) = args[index].strip_prefix("--") {
                let value = if let Some(next) = args.get(index + 1).filter(|v| !v.starts_with("--"))
                {
                    index += 1;
                    json!(next)
                } else {
                    json!(true)
                };
                let mut camel = String::new();
                let mut upper = false;
                for character in key.chars() {
                    if character == '-' {
                        upper = true;
                    } else if upper {
                        camel.extend(character.to_uppercase());
                        upper = false;
                    } else {
                        camel.push(character);
                    }
                }
                values.insert(camel, value);
            }
            index += 1;
        }
        Self(values)
    }
    fn text(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(Value::as_str)
    }
    fn text_or<'a>(&'a self, key: &str, fallback: &'a str) -> &'a str {
        self.text(key).unwrap_or(fallback)
    }
    fn enabled(&self, key: &str) -> bool {
        self.0.get(key).is_some_and(|v| v == true || v == "true")
    }
    fn disabled(&self, key: &str) -> bool {
        self.0.get(key).is_some_and(|v| v == false || v == "false")
    }
    fn number(&self, key: &str, fallback: u64) -> u64 {
        self.text(key)
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite() && *v >= 0.0)
            .map(|v| v.floor() as u64)
            .unwrap_or(fallback)
    }
}

fn absolute(path: impl AsRef<Path>) -> Result<PathBuf> {
    let path = path.as_ref();
    Ok(if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    })
}
fn write_json(path: &Path, value: &Value) -> Result<()> {
    std::fs::create_dir_all(path.parent().ok_or("Output path has no parent")?)?;
    // The insertion/number byte contract is shared with raw materialization.
    std::fs::write(path, format!("{}\n", serde_json::to_string_pretty(value)?))?;
    Ok(())
}

/// Native provider download process; the Node selector remains the default until cutover.
pub fn run(args: &[String]) -> Result<()> {
    let options = Options::parse(args);
    let current = timestamp();
    let start = options.text_or("start", "2011-01-01");
    let end = options.text_or("end", &current[..10]);
    if start.len() != 10 || end.len() != 10 {
        return Err("Fetch requires YYYY-MM-DD start and end".into());
    }
    let out = absolute(options.text_or("outDir", "data/raw"))?;
    let manifest_path = absolute(
        options
            .text("manifest")
            .map(PathBuf::from)
            .unwrap_or(out.join("manifest.json")),
    )?;
    let oracle_skipped = options.disabled("oracle") || options.enabled("skipOracle");
    let league_skipped = options.disabled("leaguepedia") || options.enabled("skipLeaguepedia");
    let lol_skipped = options.disabled("lolesports")
        || options.enabled("skipLolesports")
        || options.enabled("skipLolEsports");
    let oracle_required = options.enabled("oracleRequired");
    let league_required = options.enabled("leaguepediaRequired");
    let lol_required =
        options.enabled("lolesportsRequired") || options.enabled("lolEsportsRequired");
    let mut warnings = Vec::new();
    let mut oracle_http = Http::default();
    let oracle = if oracle_skipped {
        warnings.push("Oracle download skipped by --oracle false or --skip-oracle.".into());
        oracle::Outcome {
            files: vec![],
            failures: vec![],
            discovered_count: 0,
            folder_url: options
                .text("oracleDriveFolderUrl")
                .map(str::to_owned)
                .unwrap_or(format!("https://drive.google.com/drive/folders/{DRIVE_ID}")),
        }
    } else {
        oracle::download(
            &mut oracle_http,
            &options,
            &out.join("oracles-elixir"),
            start,
            end,
            &mut warnings,
        )?
    };
    let league_path = absolute(
        options
            .text("leaguepediaOutput")
            .map(PathBuf::from)
            .unwrap_or(
                out.join("leaguepedia")
                    .join(format!("scoreboard-games-{start}_to_{end}.json")),
            ),
    )?;
    let mut league_http = Http::default();
    let league = if league_skipped {
        warnings.push(
            "Leaguepedia backup download skipped by --leaguepedia false or --skip-leaguepedia."
                .into(),
        );
        Outcome::default()
    } else {
        match leaguepedia::download(&mut league_http, &options, &league_path, start, end) {
            Ok(()) => Outcome {
                files: vec![league_path],
                failures: vec![],
            },
            Err(error) => {
                let message = error.to_string();
                warnings.push(format!(
                    "Leaguepedia backup download was not completed: {message}"
                ));
                Outcome {
                    files: vec![],
                    failures: vec![
                        json!({"source":"Leaguepedia Cargo ScoreboardGames","error":message}),
                    ],
                }
            }
        }
    };
    let lol_path = absolute(
        options
            .text("lolesportsOutput")
            .map(PathBuf::from)
            .unwrap_or(
                out.join("lolesports")
                    .join(format!("schedule-{start}_to_{end}.json")),
            ),
    )?;
    let mut lol_http = Http::default();
    let lol = if lol_skipped {
        warnings.push("LoL Esports schedule reference download skipped by --lolesports false or --skip-lolesports.".into());
        Outcome::default()
    } else {
        match lolesports::download(&mut lol_http, &options, &lol_path, start, end) {
            Ok(()) => Outcome {
                files: vec![lol_path],
                failures: vec![],
            },
            Err(error) => {
                let message = error.to_string();
                warnings.push(format!(
                    "LoL Esports schedule reference was not downloaded: {message}"
                ));
                Outcome {
                    files: vec![],
                    failures: vec![
                        json!({"source":"LoL Esports persisted schedule API","error":message}),
                    ],
                }
            }
        }
    };
    if options.0.contains_key("riotGpr")
        || options.enabled("skipRiotGpr")
        || options.0.contains_key("riotGprOutput")
    {
        warnings.push("Riot GPR is not part of the local data-source manifest. Use pnpm run fetch:riot-gpr explicitly for manual benchmark snapshots.".into());
    }
    if oracle.files.is_empty() {
        warnings.push("No Oracle CSVs were downloaded. Leaguepedia remains available as the backup/gap-fill source if its download succeeded.".into());
    }
    let source = |role, skipped, required, files: &[PathBuf], failures: &[Value]| json!({"role":role,"status":status(skipped,files.len(),failures.len()),"downloadedCount":files.len(),"downloadedThisRun":files.len(),"failedCount":failures.len(),"failedThisRun":failures.len(),"failures":failures,"skipped":skipped,"required":required});
    // Node inserts the three source groups in this order, independent of fetch order.
    let mut lol_source = source(
        "schedule-results-reference",
        lol_skipped,
        lol_required,
        &lol.files,
        &lol.failures,
    );
    lol_source["unsupportedApi"] = json!(true);
    let oracle_source = json!({"role":"primary","status":status(oracle_skipped,oracle.files.len(),oracle.failures.len()),"folderUrl":oracle.folder_url,"discoveredCount":oracle.discovered_count,"downloadedCount":oracle.files.len(),"downloadedThisRun":oracle.files.len(),"failedCount":oracle.failures.len(),"failedThisRun":oracle.failures.len(),"failures":oracle.failures,"skipped":oracle_skipped,"required":oracle_required});
    let league_source = source(
        "backup-gap-fill",
        league_skipped,
        league_required,
        &league.files,
        &league.failures,
    );
    let manifest = json!({"schemaVersion":1,"generatedAt":timestamp(),"start":start,"end":end,"files":{"leaguepediaJson":league.files,"oracleCsv":oracle.files,"lolEsportsJson":lol.files},"sources":{"lolesports":lol_source,"oracle":oracle_source,"leaguepedia":league_source},"warnings":warnings,"fetchTelemetry":{"requests":oracle_http.requests+league_http.requests+lol_http.requests,"retryCount":oracle_http.retries.len()+league_http.retries.len()+lol_http.retries.len()}});
    write_json(&manifest_path, &manifest)?;
    if oracle_required && !oracle.failures.is_empty() {
        return Err(format!(
            "Oracle download is required but {} Oracle source(s) failed.",
            oracle.failures.len()
        )
        .into());
    }
    if league_required && !league.failures.is_empty() {
        return Err(format!(
            "Leaguepedia backup download is required but failed: {}",
            league.failures[0]["error"].as_str().unwrap_or("")
        )
        .into());
    }
    if lol_required && !lol.failures.is_empty() {
        return Err(format!(
            "LoL Esports schedule reference download is required but failed: {}",
            lol.failures[0]["error"].as_str().unwrap_or("")
        )
        .into());
    }
    println!("Wrote local data manifest to {}", manifest_path.display());
    Ok(())
}

#[derive(Default)]
struct Outcome {
    files: Vec<PathBuf>,
    failures: Vec<Value>,
}
fn status(skipped: bool, downloaded: usize, failures: usize) -> &'static str {
    if skipped {
        "skipped"
    } else if downloaded > 0 && failures > 0 {
        "partial"
    } else if downloaded > 0 {
        "downloaded"
    } else if failures > 0 {
        "failed"
    } else {
        "unavailable"
    }
}
