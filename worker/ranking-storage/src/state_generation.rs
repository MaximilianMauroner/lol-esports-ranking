use super::{JSON_TYPE, s3};
use flate2::bufread::GzDecoder;
use ranking_contracts::{
    Result, Utf16Json, Utf16String, canonical_json_value, parse_canonical_utf16_json, sha256,
};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Read};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Authority {
    key: String,
    etag: String,
    bytes: u64,
    digest: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    artifact_kind: String,
    schema_version: u64,
    storage_mode: String,
    generation_id: String,
    run_id: String,
    // These fields are required and nullable, rather than optional properties.
    base_generation_id: Utf16Json,
    base_run_id: Utf16Json,
    canonical_ledger: Reference,
    source_receipt_digest: String,
    compatibility: Compatibility,
    checkpoints: Vec<Checkpoint>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Compatibility {
    model_version: Utf16String,
    model_config_hash: Utf16String,
    importer_version: Utf16String,
    taxonomy_version: Utf16String,
    rating_checkpoint_schema_version: u64,
    causal_prefix_schema_version: u64,
    public_artifact_schema_version: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Checkpoint {
    boundary: Boundary,
    #[serde(rename = "rawPrefix")]
    raw_prefix: RawPrefix,
    object: Reference,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Boundary {
    date: String,
    match_id: Utf16String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawPrefix {
    match_count: u64,
    digest: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reference {
    key: String,
    sha256: String,
    bytes: u64,
    storage_encoding: String,
    #[serde(default, deserialize_with = "legacy_size")]
    compressed_bytes: Option<u64>,
}

fn legacy_size<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<u64>, D::Error> {
    // A missing legacy size is valid; an explicitly null size is not.
    u64::deserialize(deserializer).map(Some)
}

/// Fresh GETs match Node's assertStateManifestAuthority. Member integrity does
/// not parse the ledger or checkpoint model; those encodings belong to M5.
pub(super) fn verify(
    bucket: &s3::Bucket,
    authority: Authority,
    expected: Option<&str>,
) -> Result<String> {
    if authority.etag.is_empty() || !positive_size(authority.bytes) || !digest(&authority.digest) {
        return Err("Invalid state manifest authority".into());
    }
    let prefix = if bucket.prefix.is_empty() {
        String::new()
    } else {
        format!("{}/", bucket.prefix)
    };
    let relative = authority
        .key
        .strip_prefix(&prefix)
        .ok_or("State authority is outside the state prefix")?;
    if !relative.starts_with("state/") {
        return Err("State authority is outside the state prefix".into());
    }
    let remote = bucket.request(Method::GET, relative, BTreeMap::new(), vec![])?;
    if remote.status != 200 {
        return Err(format!(
            "State manifest read failed with HTTP {}",
            remote.status
        ));
    }
    let header = |key: &str| remote.headers.get(key).map(String::as_str);
    if remote.etag != authority.etag
        || remote.body.len() as u64 != authority.bytes
        || header("content-length") != Some(authority.bytes.to_string().as_str())
        || header("content-type") != Some(JSON_TYPE)
        || header("x-amz-meta-sha256") != Some(authority.digest.as_str())
        || header("x-amz-meta-semantic-bytes") != Some(authority.bytes.to_string().as_str())
        || sha256(&remote.body) != authority.digest
    {
        return Err("State manifest authority changed".into());
    }
    let manifest = parse_manifest(&remote.body)?;
    if relative != format!("state/generations/{}.json", manifest.generation_id) {
        return Err("State manifest authority key does not match generationId".into());
    }
    if let Some(expected) = expected {
        parse_manifest(expected.as_bytes())?;
        if expected.as_bytes() != remote.body {
            return Err("State manifest authority does not match expected manifest".into());
        }
    }
    let mut proofs = vec![read_member(bucket, &manifest.canonical_ledger)?];
    for checkpoint in &manifest.checkpoints {
        proofs.push(read_member(bucket, &checkpoint.object)?);
    }
    let key = canonical_json_value(&json!(authority.key));
    let etag = canonical_json_value(&json!(remote.etag));
    let digest = canonical_json_value(&json!(authority.digest));
    let proofs = canonical_json_value(&json!(proofs));
    let body = std::str::from_utf8(&remote.body).map_err(|_| "Invalid state manifest UTF-8")?;
    Ok(format!(
        "{{\"bytes\":{},\"digest\":{digest},\"etag\":{etag},\"key\":{key},\"manifest\":{body},\"verifiedObjects\":{proofs}}}",
        authority.bytes
    ))
}

fn parse_manifest(bytes: &[u8]) -> Result<Manifest> {
    let value =
        parse_canonical_utf16_json(bytes).map_err(|_| "State manifest is not canonical JSON")?;
    let manifest = Manifest::deserialize(value).map_err(|_| "Invalid state manifest schema")?;
    if manifest.artifact_kind != "incremental-state-generation-manifest"
        || manifest.schema_version != 1
        || manifest.storage_mode != "content-addressed-state-gzip-v1"
        || !safe_id(&manifest.generation_id)
        || !safe_id(&manifest.run_id)
        || !nullable_id(&manifest.base_generation_id)
        || !nullable_id(&manifest.base_run_id)
        || !digest(&manifest.source_receipt_digest)
        || manifest.checkpoints.is_empty()
    {
        return Err("Invalid state manifest identity".into());
    }
    let compatibility = &manifest.compatibility;
    if [
        &compatibility.model_version,
        &compatibility.model_config_hash,
        &compatibility.importer_version,
        &compatibility.taxonomy_version,
    ]
    .iter()
    .any(|value| value.code_units().next().is_none())
        || [
            compatibility.rating_checkpoint_schema_version,
            compatibility.causal_prefix_schema_version,
            compatibility.public_artifact_schema_version,
        ]
        .iter()
        .any(|value| !positive_size(*value))
    {
        return Err("Invalid state manifest compatibility".into());
    }
    validate_reference(&manifest.canonical_ledger)?;
    let mut previous: Option<&Boundary> = None;
    for checkpoint in &manifest.checkpoints {
        validate_reference(&checkpoint.object)?;
        if !calendar_date(&checkpoint.boundary.date)
            || checkpoint.boundary.match_id.code_units().next().is_none()
            || checkpoint.raw_prefix.match_count > MAX_SAFE_INTEGER
            || !digest(&checkpoint.raw_prefix.digest)
        {
            return Err("Invalid state checkpoint boundary or raw prefix".into());
        }
        if previous.is_some_and(|previous| {
            (&previous.date, &previous.match_id)
                >= (&checkpoint.boundary.date, &checkpoint.boundary.match_id)
        }) {
            return Err("State checkpoints must have unique ordered boundaries".into());
        }
        previous = Some(&checkpoint.boundary);
    }
    Ok(manifest)
}

fn validate_reference(reference: &Reference) -> Result<()> {
    if !digest(&reference.sha256)
        || !positive_size(reference.bytes)
        || reference
            .compressed_bytes
            .is_some_and(|bytes| !positive_size(bytes))
        || reference.storage_encoding != "gzip"
        || reference.key != format!("state/objects/sha256/{}", reference.sha256)
    {
        return Err("Invalid state object reference".into());
    }
    Ok(())
}

fn read_member(bucket: &s3::Bucket, reference: &Reference) -> Result<Value> {
    let remote = bucket.request(Method::GET, &reference.key, BTreeMap::new(), vec![])?;
    if remote.status != 200 {
        return Err(format!(
            "State member read failed with HTTP {}",
            remote.status
        ));
    }
    let header = |key: &str| remote.headers.get(key).map(String::as_str);
    let compressed_bytes = remote.body.len() as u64;
    if !positive_size(compressed_bytes)
        || header("content-length") != Some(compressed_bytes.to_string().as_str())
        || reference
            .compressed_bytes
            .is_some_and(|bytes| bytes != compressed_bytes)
        || header("content-type") != Some(JSON_TYPE)
        || header("content-encoding") != Some("gzip")
        || header("x-amz-meta-sha256") != Some(reference.sha256.as_str())
        || header("x-amz-meta-semantic-bytes") != Some(reference.bytes.to_string().as_str())
        || header("x-amz-meta-encoding") != Some("gzip")
    {
        return Err("State member metadata mismatch".into());
    }
    let (bytes, digest) = semantic_identity(&remote.body, reference.bytes)?;
    if bytes != reference.bytes || digest != reference.sha256 {
        return Err("State member semantic identity mismatch".into());
    }
    let key = if bucket.prefix.is_empty() {
        reference.key.clone()
    } else {
        format!("{}/{}", bucket.prefix, reference.key)
    };
    Ok(
        json!({"key":key,"digest":reference.sha256,"compressedBytes":compressed_bytes,"compressedSha256":sha256(&remote.body)}),
    )
}

fn semantic_identity(compressed: &[u8], limit: u64) -> Result<(u64, String)> {
    let mut remaining = compressed;
    let mut bytes = 0;
    let mut digest = Sha256::new();
    let mut buffer = [0; 65_536];
    loop {
        let mut member = GzDecoder::new(remaining);
        loop {
            let size = member
                .read(&mut buffer)
                .map_err(|_| "State member gzip is corrupt")?;
            if size == 0 {
                break;
            }
            bytes += size as u64;
            if bytes > limit {
                return Err("State member semantic size mismatch".into());
            }
            digest.update(&buffer[..size]);
        }
        remaining = member.into_inner();
        // Match Node's concatenated members and zero-padding end marker.
        if remaining.is_empty() || remaining[0] == 0 {
            break;
        }
    }
    Ok((bytes, format!("{:x}", digest.finalize())))
}

fn positive_size(value: u64) -> bool {
    (1..=MAX_SAFE_INTEGER).contains(&value)
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}
fn nullable_id(value: &Utf16Json) -> bool {
    match value {
        Utf16Json::Null => true,
        Utf16Json::String(value) => String::from_utf16(&value.code_units().collect::<Vec<_>>())
            .is_ok_and(|value| safe_id(&value)),
        _ => false,
    }
}
fn calendar_date(value: &str) -> bool {
    value.len() == 10
        && chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .is_ok_and(|date| date.format("%Y-%m-%d").to_string() == value)
}
