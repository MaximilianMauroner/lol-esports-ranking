use chrono::{DateTime, NaiveDate, NaiveDateTime, SecondsFormat};

/// Accepted provider formats are explicit; a host timezone never affects a zone-less value.
pub fn provider_instant(value: &str) -> Option<i64> {
    if let Ok(date) = DateTime::parse_from_rfc3339(value) {
        return Some(date.timestamp_millis());
    }
    for format in [
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M",
    ] {
        if let Ok(date) = NaiveDateTime::parse_from_str(value, format) {
            return Some(date.and_utc().timestamp_millis());
        }
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()?
        .and_hms_opt(0, 0, 0)
        .map(|date| date.and_utc().timestamp_millis())
}

pub fn provider_datetime_utc(value: &str) -> Option<String> {
    DateTime::from_timestamp_millis(provider_instant(value)?)
        .map(|date| date.to_rfc3339_opts(SecondsFormat::Millis, true))
}

pub fn provider_date(value: &str) -> String {
    let prefix = value.chars().take(10).collect::<String>();
    if prefix.len() == 10
        && prefix.as_bytes().iter().enumerate().all(|(i, v)| {
            if i == 4 || i == 7 {
                *v == b'-'
            } else {
                v.is_ascii_digit()
            }
        })
    {
        return prefix;
    }
    provider_datetime_utc(value)
        .map(|date| date[..10].to_owned())
        .unwrap_or(prefix)
}
