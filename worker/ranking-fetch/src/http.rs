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
    #[cfg(test)]
    fixtures: Option<std::collections::VecDeque<Response>>,
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
    #[cfg(test)]
    pub fn fixture(responses: Vec<Response>) -> Self {
        Self {
            fixtures: Some(responses.into()),
            ..Self::default()
        }
    }

    pub fn snapshot(&self) -> Value {
        json!({"requests":self.requests,"retryCount":self.retries.len(),"retries":self.retries,"attempts":self.attempts})
    }

    pub fn get(&mut self, url: Url, headers: &[(&str, &str)], policy: &Policy) -> Result<Response> {
        #[cfg(test)]
        if let Some(fixtures) = &mut self.fixtures {
            self.requests += 1;
            return fixtures
                .pop_front()
                .ok_or("Unexpected fixture request".into());
        }
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
                    self.attempts.push(entry);
                    let Some(reason) = reason else {
                        if !(200..=299).contains(&status) {
                            self.terminal_failure = true;
                            return Err(format!("HTTP {status} from {url}").into());
                        }
                        let body = body?;
                        return Ok(Response { body, content_type });
                    };
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

fn read_body(mut response: reqwest::blocking::Response, limit: u64) -> io::Result<Vec<u8>> {
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
    let mut buffer = [0; 65_536];
    loop {
        let count = response
            .read(&mut buffer)
            .map_err(|_| io::Error::other("terminated"))?;
        if count == 0 {
            return Ok(body);
        }
        if body.len() as u64 + count as u64 > limit {
            return Err(exceeded());
        }
        body.extend_from_slice(&buffer[..count]);
    }
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
