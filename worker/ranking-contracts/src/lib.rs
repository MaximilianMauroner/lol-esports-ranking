//! Byte contracts shared by the refresh worker. Semantic identity never depends on gzip output.
mod json;
pub mod model;
mod numeric;
mod time;
mod v8_math;

pub use json::{
    Value, canonical_json, canonical_json_value, config_hash, js_json, js_pretty_json_value,
    stable_digest, stable_json,
};
pub use numeric::{js_exp, js_log, js_pow, js_round, number_text, to_fixed};
pub use time::{provider_date, provider_datetime_utc, provider_instant};

use flate2::{Compression, GzBuilder, bufread::GzDecoder};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

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

pub fn gunzip(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    if bytes.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "Empty gzip input",
        ));
    }
    let mut decoded = Vec::new();
    let mut remaining = bytes;
    loop {
        let mut member = GzDecoder::new(remaining);
        member.read_to_end(&mut decoded)?;
        remaining = member.into_inner();
        // Node stops at zero padding only after a complete validated member.
        // Footer zeros belong to the member and must never be trimmed first.
        if remaining.is_empty() || remaining[0] == 0 {
            return Ok(decoded);
        }
    }
}

#[cfg(test)]
mod gzip_tests {
    use super::{gunzip, gzip};

    #[test]
    fn complete_members_preserve_node_concatenation_and_padding() {
        let first = gzip(b"first").unwrap();
        let second = gzip(b"second").unwrap();
        assert_eq!(gunzip(&first).unwrap(), b"first");
        assert_eq!(gunzip(&gzip(b"").unwrap()).unwrap(), b"");
        let concatenated = [first.as_slice(), second.as_slice()].concat();
        assert_eq!(gunzip(&concatenated).unwrap(), b"firstsecond");
        for suffix in [
            vec![0],
            vec![0; 8],
            vec![0, 0, 255, 1],
            [vec![0], second].concat(),
        ] {
            assert_eq!(
                gunzip(&[first.as_slice(), &suffix].concat()).unwrap(),
                b"first"
            );
            assert_eq!(
                gunzip(&[concatenated.as_slice(), &suffix].concat()).unwrap(),
                b"firstsecond"
            );
        }
    }

    #[test]
    fn incomplete_or_corrupt_members_are_never_treated_as_padding() {
        let first = gzip(b"first").unwrap();
        let second = gzip(b"second").unwrap();
        assert!(gunzip(&[]).is_err());
        assert!(gunzip(&[0, 0]).is_err());
        for end in 0..first.len() {
            assert!(
                gunzip(&first[..end]).is_err(),
                "truncated first member at {end}"
            );
        }
        for end in 1..second.len() {
            assert!(
                gunzip(&[first.as_slice(), &second[..end]].concat()).is_err(),
                "truncated second member at {end}"
            );
        }
        for offset in [first.len() - 8, first.len() - 4] {
            let mut corrupt = first.clone();
            corrupt[offset] ^= 1;
            assert!(gunzip(&corrupt).is_err(), "CRC or ISIZE at {offset}");
            assert!(gunzip(&[corrupt.as_slice(), &[0; 8]].concat()).is_err());
            assert!(gunzip(&[second.as_slice(), corrupt.as_slice()].concat()).is_err());
        }
        assert!(gunzip(&[first.as_slice(), &[1, 2, 3]].concat()).is_err());
    }
}
