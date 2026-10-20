use crate::{Result, now_ms};
use ranking_contracts::limits::DOCUMENT_LIMIT;
use reqwest::{Url, blocking::Client};
use serde_json::{Value, json};
use std::{
    borrow::Cow,
    io::{self, Read},
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct Http {
    client: Client,
    pub requests: u64,
    pub retries: Vec<Value>,
    attempts: Vec<Value>,
    pub terminal_failure: bool,
}

pub struct Policy {
    pub attempts: u32,
    pub base_delay_ms: u64,
    pub leaguepedia: bool,
    pub body_limit: u64,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            attempts: 5,
            base_delay_ms: 500,
            leaguepedia: false,
            body_limit: DOCUMENT_LIMIT,
        }
    }
}

pub struct Response {
    pub body: Vec<u8>,
    pub content_type: String,
}

impl Response {
    pub fn text(&self) -> Cow<'_, str> {
        String::from_utf8_lossy(
            self.body
                .strip_prefix(&[0xef, 0xbb, 0xbf])
                .unwrap_or(&self.body),
        )
    }
    pub fn json(&self) -> Result<Value> {
        Ok(serde_json::from_str(&self.text())?)
    }
}

/// Match URLSearchParams.set: update the first pair, remove aliases, keep other pairs.
pub(crate) fn set_query_parameter(url: &mut Url, key: &str, value: &str) {
    let mut pairs = url
        .query_pairs()
        .map(|pair| (pair.0.into_owned(), pair.1.into_owned()))
        .collect::<Vec<_>>();
    let mut found = false;
    pairs.retain_mut(|(name, current)| {
        if name != key {
            return true;
        }
        if found {
            return false;
        }
        *current = value.to_owned();
        found = true;
        true
    });
    if !found {
        pairs.push((key.to_owned(), value.to_owned()));
    }
    url.query_pairs_mut().clear().extend_pairs(pairs);
}

impl Http {
    pub fn snapshot(&self) -> Value {
        json!({"requests":self.requests,"retryCount":self.retries.len(),"retries":self.retries,"attempts":self.attempts})
    }

    pub fn get(&mut self, url: Url, headers: &[(&str, &str)], policy: &Policy) -> Result<Response> {
        self.terminal_failure = false;
        let started = Instant::now();
        let mut last_error = String::from("Provider request exceeded maxElapsedMs");
        let rate_limited = regex::Regex::new(r#"(?i)["']?code["']?\s*:\s*["']ratelimited["']"#)?;
        for attempt in 1..=policy.attempts {
            let remaining = Duration::from_secs(120).saturating_sub(started.elapsed());
            if remaining.is_zero() {
                break;
            }
            self.requests += 1;
            let attempt_start = now_ms();
            let mut request = self.client.get(url.clone()).timeout(remaining);
            for (key, value) in headers {
                request = request.header(*key, *value);
            }
            let (reason, retry_after) = match request.send() {
                Ok(response) => {
                    let status = response.status().as_u16();
                    let retry_after = response
                        .headers()
                        .get("retry-after")
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_owned);
                    let content_type = response
                        .headers()
                        .get("content-type")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_owned();
                    let status_reason = if status == 429 || (500..=599).contains(&status) {
                        Some(format!("http-{status}"))
                    } else {
                        None
                    };
                    // Leaguepedia inspects bodies for rate limits. Other providers
                    // classify failures from headers even when a body never arrives.
                    let body = if policy.leaguepedia || (200..=299).contains(&status) {
                        read_body(response, policy.body_limit)
                    } else {
                        Ok(Vec::new())
                    };
                    if let Err(error) = &body
                        && error.kind() == io::ErrorKind::FileTooLarge
                    {
                        self.terminal_failure = true;
                        self.attempts.push(json!({"attempt":attempt,"startedAtMs":attempt_start,"finishedAtMs":now_ms(),"status":status,"retryable":false,"reason":"body-limit"}));
                        return Err(error.to_string().into());
                    }
                    let reason = if policy.leaguepedia
                        && body
                            .as_ref()
                            .is_ok_and(|body| rate_limited.is_match(&String::from_utf8_lossy(body)))
                    {
                        Some("leaguepedia-body-ratelimited".to_owned())
                    } else {
                        status_reason
                    };
                    let mut entry = json!({"attempt":attempt,"startedAtMs":attempt_start,"finishedAtMs":now_ms(),"status":status,"retryable":reason.is_some()});
                    if let Some(reason) = &reason {
                        entry["reason"] = json!(reason);
                    }
                    let Some(reason) = reason else {
                        if !(200..=299).contains(&status) {
                            self.attempts.push(entry);
                            self.terminal_failure = true;
                            return Err(format!("HTTP {status} from {url}").into());
                        }
                        let body = body.map_err(|error| {
                            self.terminal_failure = true;
                            let timeout = error.kind() == io::ErrorKind::TimedOut
                                || error
                                    .get_ref()
                                    .and_then(|error| error.downcast_ref::<reqwest::Error>())
                                    .is_some_and(reqwest::Error::is_timeout);
                            let message = if timeout {
                                "Provider request exceeded maxElapsedMs"
                            } else {
                                "terminated"
                            };
                            entry["reason"] =
                                json!(if timeout { "max-elapsed" } else { "body-error" });
                            entry["error"] = json!(message);
                            message
                        });
                        self.attempts.push(entry);
                        return Ok(Response {
                            body: body?,
                            content_type,
                        });
                    };
                    self.attempts.push(entry);
                    last_error = format!("Provider request exhausted retries: {reason}");
                    (
                        reason,
                        retry_after
                            .as_deref()
                            .and_then(|v| retry_after_ms(v, now_ms())),
                    )
                }
                Err(error) => {
                    let timeout = error.is_timeout();
                    let message = if timeout {
                        "Provider request exceeded maxElapsedMs"
                    } else {
                        "fetch failed"
                    };
                    last_error = format!(
                        "Provider request failed after {} attempt(s): {message}",
                        self.requests
                    );
                    self.attempts.push(json!({"attempt":attempt,"startedAtMs":attempt_start,"finishedAtMs":now_ms(),"status":null,"retryable":true,"reason":if timeout {"max-elapsed"} else {"network-error"},"error":message}));
                    if timeout {
                        break;
                    }
                    ("network-error".to_owned(), None)
                }
            };
            if attempt == policy.attempts {
                break;
            }
            let delay = retry_delay(
                attempt,
                policy.base_delay_ms,
                retry_after,
                rand::random::<f64>(),
            );
            if started
                .elapsed()
                .saturating_add(Duration::from_millis(delay))
                > Duration::from_secs(120)
            {
                break;
            }
            let mut entry = json!({"attempt":attempt,"delayMs":delay,"reason":reason});
            if let Some(retry_after) = retry_after {
                entry["retryAfterMs"] = json!(retry_after);
            }
            self.retries.push(entry);
            std::thread::sleep(Duration::from_millis(delay));
        }
        self.terminal_failure = true;
        Err(last_error.into())
    }
}

fn read_body(response: reqwest::blocking::Response, limit: u64) -> io::Result<Vec<u8>> {
    let exceeded = || {
        io::Error::new(
            io::ErrorKind::FileTooLarge,
            "Provider response body exceeds byte limit",
        )
    };
    if response
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Err(exceeded());
    }
    let mut body = Vec::new();
    response.take(limit + 1).read_to_end(&mut body)?;
    if body.len() as u64 > limit {
        return Err(exceeded());
    }
    Ok(body)
}

fn retry_after_ms(value: &str, now: u64) -> Option<u64> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(seconds) = value.parse::<f64>()
        && seconds.is_finite()
        && seconds >= 0.0
    {
        return Some((seconds * 1000.0).ceil() as u64);
    }
    let date = chrono::DateTime::parse_from_rfc2822(value)
        .ok()?
        .timestamp_millis();
    Some((i128::from(date) - i128::from(now)).max(0) as u64)
}

fn retry_delay(attempt: u32, base: u64, retry_after: Option<u64>, random: f64) -> u64 {
    let exponential =
        (base as f64 * 2.0_f64.powi((attempt.saturating_sub(1)) as i32)).min(30_000.0);
    let backoff = ranking_contracts::js_round(exponential * (0.5 + random.clamp(0.0, 1.0)))
        .min(30_000.0) as u64;
    backoff.max(retry_after.unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ranking_contracts::limits::DOCUMENT_LIMIT;
    use std::io::{Read, Write};

    fn serve(status: u16, headers: &str, body: Vec<u8>) -> (Url, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!(
            "http://{}/fixture",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let headers = headers.to_owned();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
            }
            let _ = stream.write_all(
                format!("HTTP/1.1 {status} Fixture\r\nConnection: close\r\n{headers}\r\n")
                    .as_bytes(),
            );
            let _ = stream.write_all(&body);
        });
        (url, server)
    }

    #[test]
    fn provider_http_bodies_are_bounded() {
        let oversized = vec![b'x'; DOCUMENT_LIMIT as usize + 1];
        let chunked = [
            format!("{:x}\r\n", oversized.len()).into_bytes(),
            oversized.clone(),
            b"\r\n0\r\n\r\n".to_vec(),
        ]
        .concat();
        let compressed = ranking_contracts::gzip(&oversized).unwrap();
        for (headers, body) in [
            ("Transfer-Encoding: chunked\r\n".to_owned(), chunked),
            (
                format!("Content-Length: {}\r\n", oversized.len()),
                Vec::new(),
            ),
            (String::new(), oversized),
            (
                format!(
                    "Content-Encoding: gzip\r\nContent-Length: {}\r\n",
                    compressed.len()
                ),
                compressed,
            ),
        ] {
            let (url, server) = serve(200, &headers, body);
            let mut http = Http {
                client: Client::builder().no_proxy().build().unwrap(),
                ..Http::default()
            };
            let result = http.get(url, &[], &Policy::default());
            server.join().unwrap();
            let error = result.err().expect("oversized provider body was accepted");
            assert!(error.to_string().contains("limit"), "{error}");
            assert_eq!(http.requests, 1);
            assert!(http.terminal_failure);
        }
    }

    #[test]
    fn provider_http_accepts_the_exact_document_limit() {
        let body = vec![b'x'; DOCUMENT_LIMIT as usize];
        let (url, server) = serve(
            200,
            &format!("Content-Length: {}\r\n", body.len()),
            body.clone(),
        );
        let mut http = Http {
            client: Client::builder().no_proxy().build().unwrap(),
            ..Http::default()
        };
        let response = http.get(url, &[], &Policy::default()).unwrap();
        server.join().unwrap();
        assert_eq!(response.body, body);
    }

    #[test]
    fn oversized_leaguepedia_rate_limit_bodies_do_not_retry() {
        let (url, server) = serve(429, "", vec![b'x'; 65_537]);
        let mut http = Http {
            client: Client::builder().no_proxy().build().unwrap(),
            ..Http::default()
        };
        let policy = Policy {
            leaguepedia: true,
            body_limit: 32,
            base_delay_ms: 0,
            ..Policy::default()
        };
        let result = http.get(url, &[], &policy);
        server.join().unwrap();
        let error = result
            .err()
            .expect("oversized rate limit body was accepted");
        assert!(error.to_string().contains("limit"), "{error}");
        assert_eq!(http.requests, 1);
        assert!(http.retries.is_empty());
        assert!(http.terminal_failure);
    }

    #[test]
    fn oracle_csv_downloads_can_exceed_the_document_limit() {
        let mut body = b"gameid,date\n".to_vec();
        body.resize(DOCUMENT_LIMIT as usize + 1, b'x');
        let size = body.len() as u64;
        let (url, server) = serve(200, &format!("Content-Length: {size}\r\n"), body);
        let directory = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!(
                "oracle-body-{}-{}",
                std::process::id(),
                crate::now_ms()
            ));
        let options = crate::Options::parse(&["--oracle-csv-url".into(), url.into()]);
        let mut http = Http {
            client: Client::builder().no_proxy().build().unwrap(),
            ..Http::default()
        };
        let outcome = crate::oracle::download(
            &mut http,
            &options,
            &directory,
            "2026-01-01",
            "2026-12-31",
            &mut Vec::new(),
        )
        .unwrap();
        server.join().unwrap();
        let length = std::fs::metadata(directory.join("oracles-elixir-1.csv"))
            .unwrap()
            .len();
        std::fs::remove_dir_all(directory).unwrap();
        assert!(outcome.failures.is_empty());
        assert_eq!(outcome.files.len(), 1);
        assert_eq!(length, size);
    }

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
        let mut http = Http {
            client: Client::builder().no_proxy().build().unwrap(),
            ..Http::default()
        };
        let (folder_url, folder_server) =
            serve(200, "Content-Type: text/html\r\n", html.into_bytes());
        let response = http.get(folder_url, &[], &Policy::default()).unwrap();
        folder_server.join().unwrap();
        let mut warnings = Vec::new();
        let mut failures = Vec::new();
        let sources =
            crate::oracle::drive_sources(&response.text(), &mut warnings, &mut failures).unwrap();
        assert_eq!(
            sources,
            vec![(
                "2026_valid.csv".into(),
                "https://drive.google.com/uc?export=download&id=7".into()
            )]
        );
        let csv = b"gameid,date\ngame,2026-01-01\n".to_vec();
        let (mut url, server) = serve(200, "Content-Type: text/csv\r\n", csv.clone());
        url.set_path(&sources[0].0);
        let options = crate::Options::parse(&["--oracle-csv-url".into(), url.into()]);
        let outcome = crate::oracle::download(
            &mut http,
            &options,
            &directory,
            "2026-01-01",
            "2026-12-31",
            &mut warnings,
        )
        .unwrap();
        server.join().unwrap();
        assert!(outcome.failures.is_empty());
        assert_eq!(
            std::fs::read(directory.join("2026_valid.csv")).unwrap(),
            csv
        );
        let observed = (
            outcome.files,
            failures.len(),
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
    fn direct_oracle_urls_keep_safe_fallback_names() {
        for (segment, expected) in [
            ("season.CSV", "oracles-elixir-1.csv"),
            ("season.Csv", "oracles-elixir-1.csv"),
            ("season.json", "oracles-elixir-1.csv"),
            ("download", "oracles-elixir-1.csv"),
            ("season.csv", "season.csv"),
        ] {
            let body = b"gameid,date\ngame,2026-01-01\n".to_vec();
            let (mut url, server) = serve(200, "Content-Type: text/csv\r\n", body.clone());
            url.set_path(segment);
            let directory = std::env::current_dir()
                .unwrap()
                .join("target")
                .join(format!(
                    "oracle-direct-{}-{}",
                    std::process::id(),
                    crate::now_ms()
                ));
            let options = crate::Options::parse(&["--oracle-csv-url".into(), url.into()]);
            let mut http = Http {
                client: Client::builder().no_proxy().build().unwrap(),
                ..Http::default()
            };
            let outcome = crate::oracle::download(
                &mut http,
                &options,
                &directory,
                "2026-01-01",
                "2026-12-31",
                &mut Vec::new(),
            )
            .unwrap();
            if http.requests > 0 {
                server.join().unwrap();
            }
            let downloaded = std::fs::read(directory.join(expected));
            if directory.exists() {
                std::fs::remove_dir_all(&directory).unwrap();
            }
            assert!(
                outcome.failures.is_empty(),
                "{segment}: {:?}",
                outcome.failures
            );
            assert_eq!(outcome.files, vec![directory.join(expected)]);
            assert_eq!(downloaded.unwrap(), body);
        }
    }

    #[test]
    fn retry_after_preserves_budget_and_server_minimum() {
        assert_eq!(retry_after_ms("1.2345", 0), Some(1235));
        assert_eq!(
            retry_after_ms("Wed, 21 Oct 2015 07:28:00 GMT", 1_445_412_479_000),
            Some(1000)
        );
        assert_eq!(retry_after_ms("invalid", 0), None);
        assert_eq!(retry_delay(1, 500, Some(40_000), 0.0), 40_000);
        assert_eq!(retry_delay(1, 500, None, 0.5), 500);
        assert_eq!(retry_delay(20, 500, None, 1.0), 30_000);
    }
}
