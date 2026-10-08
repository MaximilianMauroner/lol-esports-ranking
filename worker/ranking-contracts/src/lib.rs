//! Byte contracts shared by the refresh worker. Semantic identity never depends on gzip output.
mod json;
pub mod model;
mod numeric;
mod time;
mod v8_math;

pub use json::{
    Value, canonical_json, canonical_json_value, config_hash, js_json, stable_digest, stable_json,
};
pub use numeric::{js_exp, js_log, js_pow, js_round, number_text, to_fixed};
pub use time::{provider_date, provider_datetime_utc, provider_instant};

use flate2::{Compression, GzBuilder, read::MultiGzDecoder};
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
    let mut decoded = Vec::new();
    MultiGzDecoder::new(bytes).read_to_end(&mut decoded)?;
    Ok(decoded)
}
