use super::{JSON_TYPE, read_active, s3};
use ranking_contracts::{Result, gunzip, sha256};
use reqwest::Method;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const LEGACY_FIELDS: &[&str] = &[
    "schemaVersion",
    "generationId",
    "fencingToken",
    "promotedAt",
    "manifestKey",
    "storageMode",
    "manifestDigest",
    "manifestBytes",
    "manifestEtag",
    "stateManifestKey",
    "stateManifestDigest",
    "rawReceiptKey",
    "rawReceiptDigest",
    "rawReceiptBytes",
    "rawReceiptCompressedBytes",
    "sourceReceiptDigest",
    "rawIdentityDigest",
    "leaseKey",
    "leaseOwner",
    "leaseFencingToken",
    "leaseAcquiredAt",
    "leaseExpiresAt",
    "leaseRenewedAt",
    "leaseReleasedAt",
];
const BINDING_FIELDS: &[&str] = &[
    "publicationReceiptKey",
    "publicationReceiptDigest",
    "publicationReceiptBytes",
    "publicationReceiptEtag",
];

/// Verifies the same receipt-bound immutable closure as Node's publication
/// reader. This does not validate generation graphs or authorize promotion.
pub(super) fn verify(bucket: &s3::Bucket) -> Result<Value> {
    let (active, etag) = read_active(bucket)?;
    if etag.is_none() {
        return Ok(json!({"found":false,"reason":"active-generation-missing"}));
    }
    if !receipt_bound(&active)? {
        return Ok(json!({"found":false,"reason":"legacy-publication-without-receipt-binding"}));
    }
    let generation = text(&active["generationId"])?;
    safe_id(generation)?;
    let key = format!("generations/{generation}/publish.json");
    if text(&active["publicationReceiptKey"])? != full_key(bucket, &key) {
        return Err("Active generation publication receipt binding is incomplete".into());
    }
    let object = bucket.request(Method::GET, &key, BTreeMap::new(), vec![])?;
    let digest = text(&active["publicationReceiptDigest"])?;
    let bytes = positive_integer(&active["publicationReceiptBytes"])?;
    if object.status != 200
        || object.etag != text(&active["publicationReceiptEtag"])?
        || object.body.len() as u64 != bytes
        || sha256(&object.body) != digest
        || header(&object, "content-length") != Some(bytes.to_string().as_str())
        || header(&object, "content-type") != Some(JSON_TYPE)
        || header(&object, "content-encoding").is_some()
        || header(&object, "x-amz-meta-sha256") != Some(digest)
        || header(&object, "x-amz-meta-semantic-bytes") != Some(bytes.to_string().as_str())
    {
        return Err("Active generation publication receipt authority mismatch".into());
    }
    let receipt: Value = serde_json::from_slice(&object.body)
        .map_err(|_| "Invalid generation publication receipt JSON")?;
    validate_receipt(&receipt, generation, &bucket.prefix)?;
    assert_pointer(&active, &receipt)?;
    for member in receipt["objects"]
        .as_array()
        .ok_or("Invalid publication objects")?
    {
        verify_member(bucket, member)?;
    }
    Ok(json!({"found":true,"receipt":receipt}))
}

fn receipt_bound(active: &Value) -> Result<bool> {
    let keys = active
        .as_object()
        .ok_or("Active generation pointer is invalid")?;
    if !keys.contains_key("publicationSchemaVersion") {
        if BINDING_FIELDS.iter().any(|key| keys.contains_key(*key)) {
            return Err(
                "Legacy active generation pointer has contradictory publication receipt fields"
                    .into(),
            );
        }
        let native = active["publicManifestSchemaVersion"].as_f64() == Some(2.0);
        if keys.keys().any(|key| {
            !LEGACY_FIELDS.contains(&key.as_str())
                && !(native
                    && ["publicManifestSchemaVersion", "previousGeneration"]
                        .contains(&key.as_str()))
        }) {
            return Err(
                "Legacy active generation pointer has unsupported native authority fields".into(),
            );
        }
        return Ok(false);
    }
    if active["publicationSchemaVersion"].as_f64() != Some(1.0) {
        return Err("Active generation pointer publication schema is unsupported".into());
    }
    text(&active["publicationReceiptKey"])?;
    digest(&active["publicationReceiptDigest"])?;
    positive_integer(&active["publicationReceiptBytes"])?;
    text(&active["publicationReceiptEtag"])?;
    Ok(true)
}

fn validate_receipt(receipt: &Value, generation: &str, prefix: &str) -> Result<()> {
    exact_keys(
        receipt,
        &[
            "artifactKind",
            "schemaVersion",
            "status",
            "generationId",
            "preparedAt",
            "prefix",
            "fencing",
            "provenance",
            "authorities",
            "objects",
        ],
    )?;
    if receipt["artifactKind"] != "ranking-generation-publication-readiness"
        || receipt["schemaVersion"].as_f64() != Some(1.0)
        || receipt["status"] != "ready"
        || receipt["generationId"] != generation
        || receipt["prefix"] != prefix
    {
        return Err("Invalid generation publication receipt schema or scope".into());
    }
    let prepared = text(&receipt["preparedAt"])?;
    let parsed = super::parsed_time(&receipt["preparedAt"])?;
    if super::iso(parsed) != prepared {
        return Err("Invalid generation publication preparedAt".into());
    }
    exact_keys(&receipt["fencing"], &["token", "owner", "promotionEtag"])?;
    positive_integer(&receipt["fencing"]["token"])?;
    text(&receipt["fencing"]["owner"])?;
    text(&receipt["fencing"]["promotionEtag"])?;
    let provenance = &receipt["provenance"];
    exact_keys(
        provenance,
        &[
            "modelVersion",
            "modelConfigHash",
            "source",
            "dataMode",
            "sourceProviders",
        ],
    )?;
    for key in ["modelVersion", "modelConfigHash", "source", "dataMode"] {
        text(&provenance[key])?;
    }
    let providers = provenance["sourceProviders"]
        .as_array()
        .ok_or("Invalid publication source providers")?;
    let mut seen = BTreeSet::new();
    for provider in providers {
        if !seen.insert(text(provider)?) {
            return Err("Duplicate publication source provider".into());
        }
    }
    let authorities = &receipt["authorities"];
    let state = authorities.get("stateManifest").is_some();
    let expected: &[&str] = if state {
        &["publicManifest", "rawReceipt", "stateManifest"]
    } else {
        &["publicManifest", "rawReceipt"]
    };
    exact_keys(authorities, expected)?;
    for &name in expected {
        validate_identity(&authorities[name], prefix, false)?;
    }
    let base = if prefix.is_empty() {
        String::new()
    } else {
        format!("{prefix}/")
    };
    if authorities["publicManifest"]["key"]
        != format!("{base}generations/{generation}/manifest.json")
        || authorities["rawReceipt"]["key"]
            != format!(
                "{base}raw/objects/sha256/{}",
                text(&authorities["rawReceipt"]["digest"])?
            )
        || (state
            && authorities["stateManifest"]["key"]
                != format!("{base}state/generations/{generation}.json"))
    {
        return Err("Generation publication authority key is not canonical".into());
    }
    let members = receipt["objects"]
        .as_array()
        .filter(|a| !a.is_empty())
        .ok_or("Publication immutable closure is empty")?;
    let mut keys = BTreeSet::new();
    for member in members {
        validate_identity(member, prefix, true)?;
        if !keys.insert(text(&member["key"])?) {
            return Err("Publication immutable closure has duplicate membership".into());
        }
    }
    for &name in expected {
        let authority = &authorities[name];
        if !members.iter().any(|member| {
            member["key"] == authority["key"]
                && member["digest"] == authority["digest"]
                && equal(&member["bytes"], &authority["bytes"])
        }) {
            return Err("Publication authority is absent from immutable closure".into());
        }
    }
    Ok(())
}

fn validate_identity(value: &Value, prefix: &str, outcome: bool) -> Result<()> {
    exact_keys(
        value,
        if outcome {
            &["key", "digest", "bytes", "outcome"]
        } else {
            &["key", "digest", "bytes"]
        },
    )?;
    let key = relative_key(prefix, text(&value["key"])?)?;
    s3::validate_key(key)?;
    let hash = digest(&value["digest"])?;
    positive_integer(&value["bytes"])?;
    let parts: Vec<_> = key.split('/').collect();
    match parts.as_slice() {
        ["objects", "sha256", suffix] | ["raw" | "state", "objects", "sha256", suffix]
            if *suffix == hash => {}
        ["generations", id, "manifest.json"] => safe_id(id)?,
        ["state", "generations", name] => safe_id(
            name.strip_suffix(".json")
                .ok_or("Invalid state manifest key")?,
        )?,
        _ => {
            return Err(
                "Publication object uses a mutable or unknown namespace or mismatched digest"
                    .into(),
            );
        }
    }
    if outcome
        && !matches!(
            value["outcome"].as_str(),
            Some("uploaded" | "unchanged" | "reused")
        )
    {
        return Err("Invalid generation publication object outcome".into());
    }
    Ok(())
}

fn assert_pointer(active: &Value, receipt: &Value) -> Result<()> {
    let authorities = &receipt["authorities"];
    let pairs = [
        ("manifestKey", "publicManifest", "key"),
        ("manifestDigest", "publicManifest", "digest"),
        ("manifestBytes", "publicManifest", "bytes"),
        ("rawReceiptKey", "rawReceipt", "key"),
        ("rawReceiptDigest", "rawReceipt", "digest"),
        ("stateManifestKey", "stateManifest", "key"),
    ];
    let mismatched = pairs.iter().any(|(field, authority, property)| {
        active
            .get(*field)
            .is_some_and(|value| !equal(value, &authorities[*authority][*property]))
    });
    if mismatched
        || active["manifestKey"] != authorities["publicManifest"]["key"]
        || (active.get("fencingToken").is_some()
            && !equal(&active["fencingToken"], &receipt["fencing"]["token"]))
        || (active.get("stateManifestKey").is_some()
            && active["stateManifestDigest"] != authorities["stateManifest"]["digest"])
    {
        return Err("Active generation pointer and publication receipt authorities differ".into());
    }
    Ok(())
}

fn verify_member(bucket: &s3::Bucket, member: &Value) -> Result<()> {
    let key = relative_key(&bucket.prefix, text(&member["key"])?)?;
    let object = bucket.request(Method::GET, key, BTreeMap::new(), vec![])?;
    let bytes = positive_integer(&member["bytes"])?;
    let hash = text(&member["digest"])?;
    if object.status != 200
        || object.body.len() as u64 != bytes
        || header(&object, "content-length") != Some(bytes.to_string().as_str())
        || header(&object, "x-amz-meta-sha256") != Some(hash)
    {
        return Err("Generation publication object authority mismatch".into());
    }
    let compressed = key.starts_with("objects/sha256/")
        || key.starts_with("raw/objects/sha256/")
        || key.starts_with("state/objects/sha256/");
    let semantic = if compressed {
        gunzip(&object.body).map_err(|_| "Generation publication object gzip is corrupt")?
    } else {
        object.body
    };
    if sha256(&semantic) != hash {
        return Err("Generation publication object digest mismatch".into());
    }
    Ok(())
}

fn exact_keys(value: &Value, expected: &[&str]) -> Result<()> {
    let record = value
        .as_object()
        .ok_or("Invalid generation publication record")?;
    if record.len() != expected.len() || expected.iter().any(|key| !record.contains_key(*key)) {
        return Err("Invalid generation publication fields".into());
    }
    Ok(())
}
fn text(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "Invalid publication string".into())
}
fn digest(value: &Value) -> Result<&str> {
    let value = text(value)?;
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Invalid publication digest".into());
    }
    Ok(value)
}
fn positive_integer(value: &Value) -> Result<u64> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && *n > 0.0 && *n <= SAFE_INTEGER && n.fract() == 0.0)
        .map(|n| n as u64)
        .ok_or_else(|| "Invalid publication byte count or token".into())
}
fn safe_id(id: &str) -> Result<()> {
    if !id.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err("Invalid generation publication generationId".into());
    }
    Ok(())
}
fn relative_key<'a>(prefix: &str, key: &'a str) -> Result<&'a str> {
    if prefix.is_empty() {
        return Ok(key);
    }
    key.strip_prefix(&format!("{prefix}/"))
        .ok_or_else(|| "Publication object is outside configured prefix".into())
}
fn full_key(bucket: &s3::Bucket, key: &str) -> String {
    if bucket.prefix.is_empty() {
        key.into()
    } else {
        format!("{}/{key}", bucket.prefix)
    }
}
fn header<'a>(object: &'a s3::Object, name: &str) -> Option<&'a str> {
    object.headers.get(name).map(String::as_str)
}
fn equal(left: &Value, right: &Value) -> bool {
    if left.is_number() && right.is_number() {
        left.as_f64() == right.as_f64()
    } else {
        left == right
    }
}
