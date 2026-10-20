//! Byte contracts shared by the refresh worker. Semantic identity never depends on gzip output.
mod gzip;
mod json;
pub mod limits;
pub mod model;
mod numeric;
pub mod published;
mod time;
mod utf16_json;
mod v8_math;

pub use gzip::decode_gzip;
pub use json::{
    Value, canonical_json, canonical_json_value, config_hash, js_json, js_pretty_json_value,
    stable_digest, stable_json,
};
pub use numeric::{js_exp, js_log, js_pow, js_round, number_text, to_fixed};
pub use time::{provider_date, provider_datetime_utc, provider_instant};
pub use utf16_json::{Utf16Json, Utf16String, parse_canonical_utf16_json};

use flate2::{Compression, GzBuilder};
use sha2::{Digest, Sha256};
use std::io::Write;

pub type Result<T> = std::result::Result<T, String>;

pub fn compare_code_units(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn gzip(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut encoder = GzBuilder::new()
        .mtime(0)
        .write(Vec::new(), Compression::best());
    encoder.write_all(bytes)?;
    encoder.finish()
}

pub fn gunzip(bytes: &[u8], limit: u64) -> std::io::Result<Vec<u8>> {
    let mut decoded = Vec::new();
    decode_gzip(bytes, limit, |chunk| decoded.extend_from_slice(chunk))
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    Ok(decoded)
}

#[cfg(test)]
mod gzip_tests {
    use super::{gunzip, gzip};

    #[test]
    fn complete_members_preserve_node_concatenation_and_padding() {
        let first = gzip(b"first").unwrap();
        let second = gzip(b"second").unwrap();
        assert_eq!(gunzip(&first, 11).unwrap(), b"first");
        assert_eq!(gunzip(&gzip(b"").unwrap(), 11).unwrap(), b"");
        let concatenated = [first.as_slice(), second.as_slice()].concat();
        assert_eq!(gunzip(&concatenated, 11).unwrap(), b"firstsecond");
        for suffix in [
            vec![0],
            vec![0; 8],
            vec![0, 0, 255, 1],
            [vec![0], second].concat(),
        ] {
            assert_eq!(
                gunzip(&[first.as_slice(), &suffix].concat(), 11).unwrap(),
                b"first"
            );
            assert_eq!(
                gunzip(&[concatenated.as_slice(), &suffix].concat(), 11).unwrap(),
                b"firstsecond"
            );
        }
    }

    #[test]
    fn incomplete_or_corrupt_members_are_never_treated_as_padding() {
        let first = gzip(b"first").unwrap();
        let second = gzip(b"second").unwrap();
        assert!(gunzip(&[], 11).is_err());
        assert!(gunzip(&[0, 0], 11).is_err());
        for end in 0..first.len() {
            assert!(
                gunzip(&first[..end], 11).is_err(),
                "truncated first member at {end}"
            );
        }
        for end in 1..second.len() {
            assert!(
                gunzip(&[first.as_slice(), &second[..end]].concat(), 11).is_err(),
                "truncated second member at {end}"
            );
        }
        for offset in [first.len() - 8, first.len() - 4] {
            let mut corrupt = first.clone();
            corrupt[offset] ^= 1;
            assert!(gunzip(&corrupt, 11).is_err(), "CRC or ISIZE at {offset}");
            assert!(gunzip(&[corrupt.as_slice(), &[0; 8]].concat(), 11).is_err());
            assert!(gunzip(&[second.as_slice(), corrupt.as_slice()].concat(), 11).is_err());
        }
        assert!(gunzip(&[first.as_slice(), &[1, 2, 3]].concat(), 11).is_err());
    }
}
