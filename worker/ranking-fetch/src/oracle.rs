use crate::{
    DRIVE_ID, Options, Result, USER_AGENT, absolute,
    http::{Http, Policy},
};
use reqwest::Url;
use serde_json::{Value, json};
use std::path::{Component, Path, PathBuf};

pub struct Outcome {
    pub files: Vec<PathBuf>,
    pub failures: Vec<Value>,
    pub folder_url: String,
    pub discovered_count: usize,
}

pub fn download(
    http: &mut Http,
    options: &Options,
    directory: &Path,
    start: &str,
    end: &str,
    warnings: &mut Vec<String>,
) -> Result<Outcome> {
    let urls = options
        .text("oracleCsvUrl")
        .map(str::to_owned)
        .or(std::env::var("ORACLES_ELIXIR_CSV_URL").ok())
        .unwrap_or_default();
    let folder_url = options
        .text("oracleDriveFolderUrl")
        .map(str::to_owned)
        .unwrap_or(format!("https://drive.google.com/drive/folders/{DRIVE_ID}"));
    let id_regex = regex::Regex::new(r"/folders/([^/?#]+)")?;
    let html_title = regex::Regex::new(r"(?i)<title>([^<]+)</title>")?;
    let id = options
        .text("oracleDriveFolderId")
        .map(str::to_owned)
        .or_else(|| id_regex.captures(&folder_url).map(|v| v[1].to_owned()))
        .unwrap_or(DRIVE_ID.into());
    let skipped_drive = options.disabled("oracleDrive") || options.enabled("skipOracleDrive");
    let mut sources = Vec::<(String, String)>::new();
    let mut failures = Vec::new();
    if !urls.is_empty() {
        for (index, url) in urls
            .split(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .enumerate()
        {
            let parsed = Url::parse(url)?;
            let name = parsed
                .path_segments()
                .and_then(Iterator::last)
                .filter(|v| v.contains('.'))
                .map(str::to_owned)
                .unwrap_or(format!("oracles-elixir-{}.csv", index + 1));
            sources.push((name, url.into()));
        }
    } else if !skipped_drive {
        let mut url = Url::parse("https://drive.google.com/embeddedfolderview")?;
        url.query_pairs_mut().append_pair("id", &id);
        url.set_fragment(Some("list"));
        let discovery = http.get(
            url,
            &[("user-agent", options.text_or("userAgent", USER_AGENT))],
            &Policy::default(),
        );
        let html = match discovery {
            Ok(response) => response.text().into_owned(),
            Err(error) => {
                let message = discovery_failure_message(&error.to_string());
                failures.push(
                    json!({"source":"Oracle Google Drive folder","url":folder_url,"error":message}),
                );
                warnings.push(format!("Oracle Google Drive discovery failed: {message}"));
                String::new()
            }
        };
        let pattern = regex::Regex::new(
            r#"https://drive\.google\.com/file/d/([^/]+)/view\?usp=drive_web[\s\S]*?<div class="flip-entry-title">([^<]+)</div>"#,
        )?;
        for entry in pattern.captures_iter(&html) {
            let name = entry[2]
                .replace("&amp;", "&")
                .replace("&quot;", "\"")
                .replace("&#39;", "'")
                .replace("&lt;", "<")
                .replace("&gt;", ">");
            if name.ends_with(".csv") {
                let mut url = Url::parse("https://drive.google.com/uc?export=download")?;
                url.query_pairs_mut().append_pair("id", &entry[1]);
                sources.push((name, url.into()));
            }
        }
    }
    if sources.is_empty() {
        warnings.push(if skipped_drive { "Oracle download was enabled, but Google Drive discovery was disabled and no direct Oracle CSV URL was provided.".into() } else { format!("No Oracle CSVs were discovered in {folder_url}.") });
    }
    let original_count = sources.len();
    let year = regex::Regex::new(r"^(\d{4})_")?;
    sources.retain(|(name, url)| {
        let mut components = Path::new(name).components();
        if !name.ends_with(".csv")
            || name.contains('\\')
            || !matches!(components.next(), Some(Component::Normal(_)))
            || components.next().is_some()
        {
            let message = "Oracle source name must be a plain CSV file name";
            failures.push(json!({"source":name,"url":url,"error":message}));
            warnings.push(format!(
                "Oracle source {name} was not downloaded: {message}"
            ));
            return false;
        }
        year.captures(name)
            .is_none_or(|v| v[1] >= start[..4] && v[1] <= end[..4])
    });
    if sources.is_empty() && original_count > 0 {
        warnings.push(format!("Oracle CSVs were discovered, but none matched the requested date range {start} through {end}."));
    }
    let mut paths = Vec::new();
    for (index, (name, url)) in sources.iter().enumerate() {
        let path = match options.text("oracleOutput") {
            Some(path) if sources.len() == 1 => absolute(path)?,
            Some(path) => {
                let mut path = path.to_owned();
                let position = path.rfind('.').unwrap_or(path.len());
                path.insert_str(position, &format!("-{}", index + 1));
                absolute(path)?
            }
            None => directory.join(name),
        };
        let downloaded = (|| -> Result<()> {
            let response = http.get(
                Url::parse(url)?,
                &[("user-agent", options.text_or("userAgent", USER_AGENT))],
                &Policy::default(),
            )?;
            let prefix = String::from_utf8_lossy(&response.body[..response.body.len().min(256)]);
            let prefix = prefix.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
            if response.content_type.contains("text/html")
                || prefix.starts_with("<!DOCTYPE html")
                || prefix.starts_with("<html")
            {
                let title = html_title.captures(prefix).map(|v| v[1].to_owned());
                return Err(title
                    .map_or_else(
                        || "download returned HTML instead of CSV".to_owned(),
                        |title| format!("download returned HTML ({title})"),
                    )
                    .into());
            }
            if !prefix.contains(',') {
                return Err("download did not look like CSV".into());
            }
            std::fs::create_dir_all(path.parent().ok_or("Oracle output has no parent")?)?;
            std::fs::write(&path, response.body)?;
            Ok(())
        })();
        if let Err(error) = downloaded {
            let message = error.to_string();
            failures.push(json!({"source":name,"url":url,"error":message}));
            warnings.push(format!(
                "Oracle source {name} was not downloaded: {message}"
            ));
            continue;
        }
        paths.push(path);
    }
    Ok(Outcome {
        files: paths,
        failures,
        folder_url,
        discovered_count: original_count,
    })
}

fn discovery_failure_message(message: &str) -> String {
    let status = message
        .strip_prefix("HTTP ")
        .and_then(|value| value.split_once(" from "))
        .and_then(|(status, _)| status.parse::<u16>().ok());
    match status {
        Some(status)
            if !(200..=299).contains(&status)
                && status != 429
                && !(500..=599).contains(&status) =>
        {
            format!("HTTP {status} from Oracle Google Drive folder")
        }
        _ => message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::Response;

    #[test]
    fn drive_file_names_cannot_escape_the_download_directory() {
        let root = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!(
                "oracle-paths-{}-{}",
                std::process::id(),
                crate::now_ms()
            ));
        let directory = root.join("downloads/nested");
        std::fs::create_dir_all(&directory).unwrap();
        let escaped = root.join("escape.csv");
        let absolute = root.join("absolute.csv");
        for path in [&escaped, &absolute] {
            std::fs::write(path, b"preserve existing file").unwrap();
        }
        let names = [
            "../../escape.csv".to_owned(),
            absolute.to_str().unwrap().to_owned(),
            "subdirectory/child.csv".to_owned(),
            "./dot.csv".to_owned(),
            "subdirectory/../child.csv".to_owned(),
            "2027_invalid/child.csv".to_owned(),
            "subdirectory\\child.csv".to_owned(),
            "2026_valid.csv".to_owned(),
        ];
        let html = names
            .iter()
            .enumerate()
            .map(|(id, name)| format!(
                r#"https://drive.google.com/file/d/{id}/view?usp=drive_web<div class="flip-entry-title">{name}</div>"#
            ))
            .collect::<String>();
        let mut responses = vec![Response {
            body: html.into_bytes(),
            content_type: "text/html".into(),
        }];
        responses.extend(names.iter().map(|_| Response {
            body: b"gameid,date\ngame,2026-01-01\n".to_vec(),
            content_type: "text/csv".into(),
        }));
        let mut http = Http::fixture(responses);
        let mut warnings = Vec::new();
        let outcome = download(
            &mut http,
            &Options::default(),
            &directory,
            "2026-01-01",
            "2026-12-31",
            &mut warnings,
        )
        .unwrap();
        let observed = (
            outcome.files,
            outcome.failures.len(),
            http.requests,
            std::fs::read(&escaped).unwrap(),
            std::fs::read(&absolute).unwrap(),
        );
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(observed.0, vec![directory.join("2026_valid.csv")]);
        assert_eq!(observed.1, names.len() - 1);
        assert_eq!(observed.2, 2, "invalid names must not be downloaded");
        assert_eq!(observed.3, b"preserve existing file");
        assert_eq!(observed.4, b"preserve existing file");
    }

    #[test]
    fn discovery_failure_matches_node_terminal_http_diagnostic() {
        for status in [403, 404] {
            assert_eq!(
                discovery_failure_message(&format!(
                    "HTTP {status} from https://drive.google.com/embeddedfolderview?id=fixture#list"
                )),
                format!("HTTP {status} from Oracle Google Drive folder")
            );
        }
        for message in [
            "Provider request exhausted retries: http-503",
            "Provider request failed after 5 attempt(s): fetch failed",
            "Provider request exceeded maxElapsedMs",
            "terminated",
            "HTTP 429 from https://drive.google.com/embeddedfolderview",
            "HTTP 503 from https://drive.google.com/embeddedfolderview",
        ] {
            assert_eq!(discovery_failure_message(message), message);
        }
    }
}
