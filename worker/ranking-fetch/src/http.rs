use crate::{Result, now_ms};
use reqwest::{Url, blocking::Client};
use serde_json::{Value, json};
use std::{
    borrow::Cow,
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
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            attempts: 5,
            base_delay_ms: 500,
            leaguepedia: false,
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
                        response.bytes().map(|body| body.to_vec())
                    } else {
                        Ok(Vec::new())
                    };
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
                        let body = body.map_err(|_| "terminated")?;
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
