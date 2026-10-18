use super::{IdentityMetadata, JSON_TYPE, date::receipt_iso, full_key};
use crate::{Result, gunzip, sha256};
use serde_json::{Value, json};
use std::collections::BTreeSet;

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

pub struct PublicationRequest {
    active: Value,
    prefix: String,
    generation: String,
    key: String,
}

impl PublicationRequest {
    pub fn from_active(active_json: &[u8], prefix: &str) -> Result<Option<Self>> {
        let active: Value = serde_json::from_slice(active_json)
            .map_err(|_| "Active generation pointer is invalid")?;
        if !receipt_bound(&active)? {
            return Ok(None);
        }
        let generation = text(&active["generationId"])?;
        safe_id(generation)?;
        let key = format!("generations/{generation}/publish.json");
        if text(&active["publicationReceiptKey"])? != full_key(prefix, &key) {
            return Err("Active generation publication receipt binding is incomplete".into());
        }
        Ok(Some(Self {
            generation: generation.into(),
            active,
            prefix: prefix.into(),
            key,
        }))
    }

    pub fn relative_key(&self) -> &str {
        &self.key
    }

    pub fn check(self, metadata: IdentityMetadata<'_>, body: &[u8]) -> Result<PublicationReceipt> {
        let digest = text(&self.active["publicationReceiptDigest"])?;
        let bytes = positive_integer(&self.active["publicationReceiptBytes"])?;
        let header = |name: &str| metadata.headers.get(name).map(String::as_str);
        if metadata.etag != text(&self.active["publicationReceiptEtag"])?
            || body.len() as u64 != bytes
            || sha256(body) != digest
            || header("content-length") != Some(bytes.to_string().as_str())
            || header("content-type") != Some(JSON_TYPE)
            || header("content-encoding").is_some()
            || header("x-amz-meta-sha256") != Some(digest)
            || header("x-amz-meta-semantic-bytes") != Some(bytes.to_string().as_str())
        {
            return Err("Active generation publication receipt authority mismatch".into());
        }
        let receipt: Value = serde_json::from_slice(body)
            .map_err(|_| "Invalid generation publication receipt JSON")?;
        validate_receipt(&receipt, &self.generation, &self.prefix)?;
        assert_pointer(&self.active, &receipt)?;
        Ok(PublicationReceipt {
            receipt,
            prefix: self.prefix,
        })
    }
}

pub struct PublicationReceipt {
    receipt: Value,
    prefix: String,
}

impl PublicationReceipt {
    pub fn members(&self) -> impl Iterator<Item = PublicationMember<'_>> {
        self.receipt["objects"]
            .as_array()
            .expect("validated publication objects")
            .iter()
            .map(|member| PublicationMember {
                member,
                prefix: &self.prefix,
            })
    }

    pub fn result_json(&self) -> String {
        serde_json::to_string(&json!({"found":true,"receipt":self.receipt}))
            .expect("JSON publication result")
    }
}

pub struct PublicationMember<'a> {
    member: &'a Value,
    prefix: &'a str,
}

impl PublicationMember<'_> {
    pub fn relative_key(&self) -> &str {
        relative_key(
            self.prefix,
            self.member["key"]
                .as_str()
                .expect("validated publication key"),
        )
        .expect("validated publication prefix")
    }

    pub fn check(&self, metadata: IdentityMetadata<'_>, body: &[u8]) -> Result<()> {
        let bytes = positive_integer(&self.member["bytes"])?;
        let hash = text(&self.member["digest"])?;
        let header = |name: &str| metadata.headers.get(name).map(String::as_str);
        if body.len() as u64 != bytes
            || header("content-length") != Some(bytes.to_string().as_str())
            || header("x-amz-meta-sha256") != Some(hash)
        {
            return Err("Generation publication object authority mismatch".into());
        }
        let key = self.relative_key();
        let compressed = key.starts_with("objects/sha256/")
            || key.starts_with("raw/objects/sha256/")
            || key.starts_with("state/objects/sha256/");
        let actual = if compressed {
            sha256(&gunzip(body).map_err(|_| "Generation publication object gzip is corrupt")?)
        } else {
            sha256(body)
        };
        if actual != hash {
            return Err("Generation publication object digest mismatch".into());
        }
        Ok(())
    }
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
    if !receipt_iso(prepared) {
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
    super::validate_storage_key(key)?;
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
        || active
            .get("fencingToken")
            .is_some_and(|value| js_number(value) != receipt["fencing"]["token"].as_f64())
        || (active.get("stateManifestKey").is_some()
            && active["stateManifestDigest"] != authorities["stateManifest"]["digest"])
    {
        return Err("Active generation pointer and publication receipt authorities differ".into());
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
fn equal(left: &Value, right: &Value) -> bool {
    if left.is_number() && right.is_number() {
        left.as_f64() == right.as_f64()
    } else {
        left == right
    }
}

// The Node reader applies Number() only to the pointer's fencing token. JSON
// arrays coerce through their comma-joined string, unlike primitive booleans.
fn js_number(value: &Value) -> Option<f64> {
    let number = match value {
        Value::Null => Some(0.0),
        Value::Bool(value) => Some(if *value { 1.0 } else { 0.0 }),
        Value::Number(value) => value.as_f64(),
        Value::String(value) => js_number_string(value),
        Value::Array(values) => match values.as_slice() {
            [] => Some(0.0),
            [Value::Bool(_) | Value::Object(_)] => None,
            [value] => js_number(value),
            _ => None,
        },
        Value::Object(_) => None,
    };
    number.filter(|value| value.is_finite())
}

fn js_number_string(value: &str) -> Option<f64> {
    let value = value.trim_matches(|c| {
        matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}'
            | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}')
    });
    if value.is_empty() {
        return Some(0.0);
    }
    for (prefixes, radix) in [(["0x", "0X"], 16), (["0o", "0O"], 8), (["0b", "0B"], 2)] {
        if let Some(digits) = prefixes
            .iter()
            .find_map(|prefix| value.strip_prefix(*prefix))
        {
            if digits.is_empty() {
                return None;
            }
            return digits.bytes().try_fold(0.0, |number, byte| {
                let digit = match byte {
                    b'0'..=b'9' => byte - b'0',
                    b'a'..=b'f' => byte - b'a' + 10,
                    b'A'..=b'F' => byte - b'A' + 10,
                    _ => return None,
                };
                (digit < radix).then_some(number * f64::from(radix) + f64::from(digit))
            });
        }
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || b"+-.eE".contains(&byte))
    {
        return None;
    }
    value.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::js_number;
    use serde_json::json;

    #[test]
    fn pointer_token_number_coercion_matches_json_number_contract() {
        for value in [
            json!(1),
            json!("1"),
            json!(true),
            json!([1]),
            json!([["1"]]),
            json!("\u{feff}\u{2028}+1.0e0\u{00a0}"),
            json!("0x1"),
            json!("0o1"),
            json!("0b1"),
            json!(".1e1"),
        ] {
            assert_eq!(js_number(&value), Some(1.0), "{value}");
        }
        for value in [
            json!([true]),
            json!([1, 0]),
            json!({}),
            json!("1_0"),
            json!("+0x1"),
            json!("\u{0085}1"),
            json!("inf"),
            json!("Infinity"),
            json!("1e999"),
            json!("NaN"),
        ] {
            assert_eq!(js_number(&value), None, "{value}");
        }
        for value in [
            json!(null),
            json!(false),
            json!([]),
            json!([null]),
            json!([[[]]]),
            json!(""),
        ] {
            assert_eq!(js_number(&value), Some(0.0), "{value}");
        }
    }
}
