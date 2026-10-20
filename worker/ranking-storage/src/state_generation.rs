use super::{JSON_TYPE, s3};
use ranking_contracts::{
    Result, Utf16Json, Utf16String, canonical_json_value, decode_gzip, parse_canonical_utf16_json,
    sha256,
};
use reqwest::Method;
use serde::{
    Deserialize,
    de::{MapAccess, Visitor, value::MapAccessDeserializer},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fmt};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(super) struct Authority {
    key: String,
    etag: String,
    bytes: u64,
    digest: String,
}

impl<'de> Deserialize<'de> for Authority {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Fields {
            key: String,
            etag: String,
            bytes: u64,
            digest: String,
        }
        struct ObjectVisitor;
        impl<'de> Visitor<'de> for ObjectVisitor {
            type Value = Authority;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a state manifest authority object")
            }

            fn visit_map<M: MapAccess<'de>>(
                self,
                map: M,
            ) -> std::result::Result<Self::Value, M::Error> {
                let fields = Fields::deserialize(MapAccessDeserializer::new(map))?;
                Ok(Authority {
                    key: fields.key,
                    etag: fields.etag,
                    bytes: fields.bytes,
                    digest: fields.digest,
                })
            }
        }
        deserializer.deserialize_map(ObjectVisitor)
    }
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
    let mut digest = Sha256::new();
    let bytes = decode_gzip(compressed, limit, |chunk| digest.update(chunk))?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compression, write::GzEncoder};
    use std::io::Write;

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    fn with_header(encoded: &[u8], flags: u8, fields: &[u8], checksum: bool) -> Vec<u8> {
        let mut header = encoded[..10].to_vec();
        header[3] = flags | if checksum { 2 } else { 0 };
        header.extend_from_slice(fields);
        if checksum {
            let crc = crc32fast::hash(&header) as u16;
            header.extend_from_slice(&crc.to_le_bytes());
        }
        header.extend_from_slice(&encoded[10..]);
        header
    }

    #[test]
    fn authority_requires_an_object_with_exact_required_fields() {
        let valid =
            r#"{"key":"state/generations/a.json","etag":"version","bytes":1,"digest":"digest"}"#;
        let authority: Authority = serde_json::from_str(valid).unwrap();
        assert_eq!(authority.key, "state/generations/a.json");
        assert_eq!(authority.bytes, 1);
        for invalid in [
            r#"["state/generations/a.json","version",1,"digest"]"#,
            r#"{"key":"state/generations/a.json","etag":"version","bytes":1}"#,
            r#"{"key":"state/generations/a.json","etag":"version","bytes":1,"digest":"digest","extra":true}"#,
            r#"{"key":"state/generations/a.json","etag":"version","bytes":1,"bytes":2,"digest":"digest"}"#,
            r#"{"key":"state/generations/a.json","etag":"version","bytes":1.5,"digest":"digest"}"#,
            r#"{"key":"state/generations/a.json","etag":"version","bytes":-1,"digest":"digest"}"#,
            r#"{"key":"state/generations/a.json","etag":"version","bytes":"1","digest":"digest"}"#,
            r#"{"key":null,"etag":"version","bytes":1,"digest":"digest"}"#,
        ] {
            assert!(
                serde_json::from_str::<Authority>(invalid).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn long_gzip_labels_and_optional_header_crc_preserve_identity() {
        let bytes = vec![b'x'; 70_000];
        let encoded = gzip(&bytes);
        let mut label = vec![b'a'; 65_536];
        label.push(0);
        let expected = (bytes.len() as u64, sha256(&bytes));
        for flag in [8, 16] {
            let transport = with_header(&encoded, flag, &label, false);
            assert_eq!(semantic_identity(&transport, expected.0).unwrap(), expected);
        }
        let mut fields = vec![0xff; 65_537]; // XLEN=65535 and the complete extra field.
        fields.extend_from_slice(&label);
        fields.extend_from_slice(&label);
        let transport = with_header(&encoded, 4 | 8 | 16, &fields, true);
        assert_eq!(semantic_identity(&transport, expected.0).unwrap(), expected);
    }

    #[test]
    fn gzip_consumer_receives_exact_payload_at_the_byte_limit() {
        for bytes in [vec![], vec![b'x'], vec![b'x'; 150_003]] {
            let encoded = gzip(&bytes);
            let mut delivered = Vec::new();
            let decoded = decode_gzip(&encoded, bytes.len() as u64, |chunk| {
                delivered.extend_from_slice(chunk);
            })
            .unwrap();
            assert_eq!(decoded, bytes.len() as u64);
            assert_eq!(delivered, bytes);
        }
    }

    #[test]
    fn gzip_expansion_cannot_exceed_the_consumer_byte_limit() {
        let bytes = vec![b'x'; 250_003];
        let encoded = gzip(&bytes);
        for limit in [0, 1, 31_337, 90_001, bytes.len() as u64 - 1] {
            let mut delivered = 0;
            let result = decode_gzip(&encoded, limit, |chunk| {
                delivered += chunk.len() as u64;
                assert!(delivered <= limit);
            });
            assert_eq!(result.unwrap_err(), "Gzip semantic size exceeds limit");
        }
    }

    #[test]
    fn concatenated_gzip_members_share_the_consumer_byte_limit() {
        let first = vec![b'a'; 40_009];
        let second = vec![b'b'; 60_013];
        let mut encoded = gzip(&first);
        encoded.extend_from_slice(&gzip(&second));
        let expected = [first, second].concat();
        let mut delivered = Vec::new();
        assert_eq!(
            decode_gzip(&encoded, expected.len() as u64, |chunk| {
                delivered.extend_from_slice(chunk);
            })
            .unwrap(),
            expected.len() as u64
        );
        assert_eq!(delivered, expected);

        let limit = 60_013;
        let mut delivered = 0;
        let result = decode_gzip(&encoded, limit, |chunk| {
            delivered += chunk.len() as u64;
            assert!(delivered <= limit);
        });
        assert_eq!(result.unwrap_err(), "Gzip semantic size exceeds limit");
    }

    #[test]
    fn corrupt_and_truncated_gzip_headers_are_rejected() {
        let encoded = gzip(b"payload");
        for length in 0..10 {
            assert!(semantic_identity(&encoded[..length], 7).is_err());
        }
        let mut wrong_method = encoded.clone();
        wrong_method[2] = 7;
        let mut wrong_magic = encoded.clone();
        wrong_magic[1] = 0;
        let mut bad_checksum = with_header(&encoded, 8, b"name\0", true);
        bad_checksum[15] ^= 1;
        let mut missing_checksum = encoded[..10].to_vec();
        missing_checksum[3] = 2;
        let mut missing_extra = encoded[..10].to_vec();
        missing_extra[3] = 4;
        missing_extra.extend_from_slice(&[3, 0, 1, 2]);
        let mut missing_name = encoded[..10].to_vec();
        missing_name[3] = 8;
        missing_name.extend_from_slice(b"unterminated");
        let mut missing_comment = missing_name.clone();
        missing_comment[3] = 16;
        for transport in [
            wrong_magic,
            wrong_method,
            with_header(&encoded, 0xe0, &[], false),
            bad_checksum,
            missing_checksum,
            missing_extra,
            missing_name,
            missing_comment,
        ] {
            assert!(semantic_identity(&transport, 7).is_err());
        }
    }

    #[test]
    fn concatenated_members_validate_crc_size_and_zero_padding() {
        let first = gzip(b"first ");
        let second = gzip(b"second");
        let expected = (12, sha256(b"first second"));
        let mut concatenated = first.clone();
        concatenated.extend_from_slice(&second);
        for suffix in [vec![], vec![0; 8], vec![0, 0, 255, 1]] {
            let mut transport = concatenated.clone();
            transport.extend_from_slice(&suffix);
            assert_eq!(semantic_identity(&transport, 12).unwrap(), expected);
        }
        assert!(semantic_identity(&concatenated, 11).is_err());
        for offset in [8, 4] {
            let mut corrupt = concatenated.clone();
            let index = corrupt.len() - offset;
            corrupt[index] ^= 1;
            corrupt.extend_from_slice(&[0; 8]);
            assert!(semantic_identity(&corrupt, 12).is_err());
        }
        assert!(semantic_identity(&concatenated[..concatenated.len() - 1], 12).is_err());
        concatenated.push(1);
        assert!(semantic_identity(&concatenated, 12).is_err());
    }
}
