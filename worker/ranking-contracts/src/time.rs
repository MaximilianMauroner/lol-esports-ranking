use chrono::{DateTime, Datelike, Days, Duration, NaiveDate, Timelike};

/// Accepted provider formats are explicit; a host timezone never affects a zone-less value.
pub fn provider_instant(value: &str) -> Option<i64> {
    if !value.is_ascii() || value.len() < 10 || &value[4..5] != "-" || &value[7..8] != "-" {
        return None;
    }
    let year = decimal(&value[..4])? as i32;
    let month = decimal(&value[5..7])?;
    let day = decimal(&value[8..10])?;
    if !(1..=31).contains(&day) {
        return None;
    }
    // Date.parse rolls valid day fields into the next month, including February 30.
    let date =
        NaiveDate::from_ymd_opt(year, month, 1)?.checked_add_days(Days::new(u64::from(day - 1)))?;
    if value.len() == 10 {
        return Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis());
    }
    let separator = value.as_bytes()[10];
    if !matches!(separator, b'T' | b't' | b' ') {
        return None;
    }
    let (clock, offset) = parse_zone(&value[11..])?;
    // Only the uppercase provider grammar assigns UTC to timestamps without a zone.
    if separator == b't' && offset.is_none() {
        return None;
    }
    let (hour, minute, second, millis) = parse_clock(clock, separator == b' ' && offset.is_some())?;
    let instant = date
        .and_hms_milli_opt(hour % 24, minute, second, millis)?
        .checked_add_signed(Duration::days(i64::from(hour == 24)))?
        .and_utc()
        .timestamp_millis();
    instant.checked_sub(i64::from(offset.unwrap_or(0)) * 1000)
}

fn parse_zone(value: &str) -> Option<(&str, Option<i32>)> {
    if let Some(clock) = value.strip_suffix(['Z', 'z']) {
        return Some((clock, Some(0)));
    }
    let Some(index) = value.find(['+', '-']) else {
        return Some((value, None));
    };
    let zone = &value[index + 1..];
    let (hour, minute) = match zone.len() {
        4 => (decimal(&zone[..2])?, decimal(&zone[2..])?),
        5 if &zone[2..3] == ":" => (decimal(&zone[..2])?, decimal(&zone[3..])?),
        _ => return None,
    };
    if hour > 23 || minute > 59 {
        return None;
    }
    let seconds = (hour * 3600 + minute * 60) as i32;
    Some((
        &value[..index],
        Some(if value.as_bytes()[index] == b'-' {
            -seconds
        } else {
            seconds
        }),
    ))
}

fn parse_clock(value: &str, truncate_midnight_fraction: bool) -> Option<(u32, u32, u32, u32)> {
    let (clock, fraction) = match value.split_once('.') {
        Some((clock, fraction))
            if clock.len() == 8
                && !fraction.is_empty()
                && fraction.bytes().all(|digit| digit.is_ascii_digit()) =>
        {
            (clock, fraction)
        }
        Some(_) => return None,
        None => (value, ""),
    };
    if !matches!(clock.len(), 5 | 8) || &clock[2..3] != ":" {
        return None;
    }
    let hour = decimal(&clock[..2])?;
    let minute = decimal(&clock[3..5])?;
    let second = if clock.len() == 8 && &clock[5..6] == ":" {
        decimal(&clock[6..])?
    } else if clock.len() == 5 {
        0
    } else {
        return None;
    };
    // Seconds 60 are invalid in Node. Hour 24 is valid only at exact midnight.
    // Its legacy space-plus-zone parser truncates sub-milliseconds before this check.
    if hour > 24
        || minute > 59
        || second > 59
        || (hour == 24
            && (minute != 0
                || second != 0
                || fraction
                    .bytes()
                    .take(if truncate_midnight_fraction {
                        3
                    } else {
                        fraction.len()
                    })
                    .any(|digit| digit != b'0')))
    {
        return None;
    }
    let millis = fraction
        .bytes()
        .take(3)
        .chain(std::iter::repeat(b'0'))
        .take(3)
        .fold(0, |millis, digit| millis * 10 + u32::from(digit - b'0'));
    Some((hour, minute, second, millis))
}

fn decimal(value: &str) -> Option<u32> {
    if value.is_empty() || !value.bytes().all(|digit| digit.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

pub fn provider_datetime_utc(value: &str) -> Option<String> {
    let date = DateTime::from_timestamp_millis(provider_instant(value)?)?;
    let year = date.year();
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    Some(format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        date.month(),
        date.day(),
        date.hour(),
        date.minute(),
        date.second(),
        date.timestamp_subsec_millis()
    ))
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
