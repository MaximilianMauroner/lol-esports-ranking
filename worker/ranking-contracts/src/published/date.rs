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
