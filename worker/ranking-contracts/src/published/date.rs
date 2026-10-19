// Receipt Date/toISOString accepts expanded years and the full ECMAScript
// TimeClip range. Provider and lease chrono timestamp contracts stay separate.
pub(super) fn receipt_iso(value: &str) -> bool {
    let bytes = value.as_bytes();
    let (year, width) = match bytes {
        [b'+' | b'-', ..] if bytes.len() == 27 => {
            let Some(absolute) = decimal_digits(&bytes[1..7]) else {
                return false;
            };
            if (bytes[0] == b'+' && absolute < 10_000) || (bytes[0] == b'-' && absolute == 0) {
                return false;
            }
            (
                if bytes[0] == b'-' {
                    -absolute
                } else {
                    absolute
                },
                7,
            )
        }
        _ if bytes.len() == 24 => {
            let Some(year) = decimal_digits(&bytes[..4]) else {
                return false;
            };
            (year, 4)
        }
        _ => return false,
    };
    let rest = &bytes[width..];
    if rest[0] != b'-'
        || rest[3] != b'-'
        || rest[6] != b'T'
        || rest[9] != b':'
        || rest[12] != b':'
        || rest[15] != b'.'
        || rest[19] != b'Z'
    {
        return false;
    }
    let [
        Some(month),
        Some(day),
        Some(hour),
        Some(minute),
        Some(second),
        Some(millisecond),
    ] = [(1, 3), (4, 6), (7, 9), (10, 12), (13, 15), (16, 19)]
        .map(|(start, end)| decimal_digits(&rest[start..end]))
    else {
        return false;
    };
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => return false,
    };
    if day < 1 || day > days || hour > 23 || minute > 59 || second > 59 {
        return false;
    }
    let instant = (year, month, day, hour, minute, second, millisecond);
    ((-271_821, 4, 20, 0, 0, 0, 0)..=(275_760, 9, 13, 0, 0, 0, 0)).contains(&instant)
}

fn decimal_digits(bytes: &[u8]) -> Option<i64> {
    bytes.iter().try_fold(0, |value, byte| {
        byte.is_ascii_digit()
            .then(|| value * 10 + i64::from(*byte - b'0'))
    })
}

pub(super) fn serving_date(value: &str) -> bool {
    if let Some(valid) = iso_date(value) {
        return valid;
    }
    let value = value.trim();
    if value.bytes().all(|byte| byte.is_ascii_digit()) && !value.is_empty() {
        return value.parse::<i64>().is_ok_and(|year| {
            year <= 12 || (32..=99).contains(&year) || (100..=275_760).contains(&year)
        });
    }
    if chrono::DateTime::parse_from_rfc2822(value).is_ok_and(|date| {
        use chrono::Timelike;
        date.timestamp_millis().abs() <= 8_640_000_000_000_000 && date.nanosecond() < 1_000_000_000
    }) {
        return true;
    }
    [
        "%B %d, %Y",
        "%b %d, %Y",
        "%B %d %Y",
        "%b %d %Y",
        "%m/%d/%Y",
        "%Y/%m/%d",
    ]
    .iter()
    .any(|format| chrono::NaiveDate::parse_from_str(value, format).is_ok())
}

fn iso_date(value: &str) -> Option<bool> {
    let bytes = value.as_bytes();
    let signed = matches!(bytes.first(), Some(b'+' | b'-'));
    let width = if signed { 7 } else { 4 };
    let year = decimal_digits(bytes.get(usize::from(signed)..width)?)?;
    let year = if bytes.first() == Some(&b'-') {
        if year == 0 {
            return Some(false);
        }
        -year
    } else {
        year
    };
    let mut offset = width;
    let mut month = 1;
    let mut day = 1;
    if bytes.get(offset) == Some(&b'-') {
        month = decimal_digits(bytes.get(offset + 1..offset + 3)?)?;
        offset += 3;
        if bytes.get(offset) == Some(&b'-') {
            day = decimal_digits(bytes.get(offset + 1..offset + 3)?)?;
            offset += 3;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Some(false);
    }
    let mut hour = 0;
    let mut minute = 0;
    let mut second = 0;
    let mut millis = 0;
    let mut zone = 0;
    if bytes.get(offset) == Some(&b'T') {
        if offset != width + 6 {
            return Some(false);
        }
        hour = decimal_digits(bytes.get(offset + 1..offset + 3)?)?;
        if bytes.get(offset + 3) != Some(&b':') {
            return Some(false);
        }
        minute = decimal_digits(bytes.get(offset + 4..offset + 6)?)?;
        offset += 6;
        if bytes.get(offset) == Some(&b':') {
            second = decimal_digits(bytes.get(offset + 1..offset + 3)?)?;
            offset += 3;
            if bytes.get(offset) == Some(&b'.') {
                offset += 1;
                let start = offset;
                while bytes.get(offset).is_some_and(u8::is_ascii_digit) {
                    if offset - start < 3 {
                        millis = millis * 10 + i64::from(bytes[offset] - b'0');
                    }
                    offset += 1;
                }
                if offset == start {
                    return Some(false);
                }
                for _ in offset - start..3 {
                    millis *= 10;
                }
            }
        }
        if hour > 24
            || minute > 59
            || second > 59
            || (hour == 24 && (minute != 0 || second != 0 || millis != 0))
        {
            return Some(false);
        }
        if bytes.get(offset) == Some(&b'Z') {
            offset += 1;
        } else if matches!(bytes.get(offset), Some(b'+' | b'-')) {
            let sign = if bytes[offset] == b'+' { 1 } else { -1 };
            let hours = decimal_digits(bytes.get(offset + 1..offset + 3)?)?;
            if bytes.get(offset + 3) != Some(&b':') {
                return Some(false);
            }
            let minutes = decimal_digits(bytes.get(offset + 4..offset + 6)?)?;
            if hours > 23 || minutes > 59 {
                return Some(false);
            }
            zone = sign * (hours * 60 + minutes) * 60_000;
            offset += 6;
        }
    }
    if offset != bytes.len() {
        return Some(false);
    }
    let adjusted_year = year - i64::from(month <= 2);
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let shifted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let days = era * 146_097 + year_of_era * 365 + year_of_era / 4 - year_of_era / 100
        + day_of_year
        - 719_468;
    let instant =
        days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1000 + millis - zone;
    Some(instant.abs() <= 8_640_000_000_000_000)
}

#[cfg(test)]
mod tests {
    use super::receipt_iso;
    #[test]
    fn receipt_timestamp_uses_canonical_iso_and_ecmascript_timeclip() {
        for value in [
            "0000-02-29T00:00:00.000Z",
            "2024-02-29T23:59:59.999Z",
            "9999-12-31T23:59:59.999Z",
            "+010000-01-01T00:00:00.000Z",
            "-000001-01-01T00:00:00.000Z",
            "-271821-04-20T00:00:00.000Z",
            "+275760-09-13T00:00:00.000Z",
        ] {
            assert!(receipt_iso(value), "{value}");
        }
        for value in [
            "2023-02-29T00:00:00.000Z",
            "2024-04-31T00:00:00.000Z",
            "2024-02-29T23:59:60.000Z",
            "2024-02-29T24:00:00.000Z",
            "2024-02-29T00:00:00Z",
            "2024-02-29T00:00:00.000+00:00",
            "+009999-01-01T00:00:00.000Z",
            "-000000-01-01T00:00:00.000Z",
            "-271821-04-19T23:59:59.999Z",
            "+275760-09-13T00:00:00.001Z",
        ] {
            assert!(!receipt_iso(value), "{value}");
        }
    }
}
