use super::{s3, state_generation::decode_gzip};
use ranking_contracts::{
    Result, Utf16Json, Utf16String, canonical_json_value, number_text, parse_utf16_json, sha256,
};
use reqwest::Method;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const PAGE_BYTES: u64 = 512_000;
const MAX_DEPTH: usize = 24;

struct Reader<'a> {
    bucket: &'a s3::Bucket,
    proofs: Vec<Value>,
}

/// Port of readVerifiedPublicArtifact without projections. Every referenced
/// member is freshly read; hydrated content is not a model execution result.
pub(super) fn verify(bucket: &s3::Bucket, digest: &str, bytes: u64) -> Result<String> {
    let mut reader = Reader {
        bucket,
        proofs: vec![],
    };
    let content = reader.read(digest, bytes)?;
    let content = if archive(&content) {
        validate_archive(&content)?;
        let hydrated = reader.visit(required(&content, "tree")?, &BTreeSet::new(), 0)?;
        if string_is(field(&content, "artifactKind"), "public-artifact-archive")
            && !strict_equal(
                field_opt(hydrated.value.as_ref(), "artifactKind"),
                field(&content, "originalKind"),
            )
        {
            return Err("Public archive original kind mismatch".into());
        }
        hydrated.value
    } else {
        Some(content)
    };
    let proofs = canonical_json_value(&json!(reader.proofs));
    let mut output = String::from("{");
    if let Some(content) = content {
        output.push_str("\"content\":");
        content.write_canonical(&mut output);
        output.push(',');
    }
    output.push_str(&format!("\"verifiedObjects\":{proofs}}}"));
    Ok(output)
}

struct Hydrated {
    // Missing inline values follow JSON.stringify's undefined property rules.
    value: Option<Utf16Json>,
    count: u64,
}

impl Reader<'_> {
    fn read(&mut self, digest: &str, bytes: u64) -> Result<Utf16Json> {
        if !valid_digest(digest) || !(1..=MAX_SAFE_INTEGER).contains(&bytes) {
            return Err("Invalid public object identity".into());
        }
        let key = format!("objects/sha256/{digest}");
        let object = self
            .bucket
            .request(Method::GET, &key, BTreeMap::new(), vec![])?;
        if object.status != 200 {
            return Err(format!(
                "Public object read failed with HTTP {}",
                object.status
            ));
        }
        let header = |key: &str| object.headers.get(key).map(String::as_str);
        if header("content-encoding") != Some("gzip")
            || header("content-length") != Some(object.body.len().to_string().as_str())
            || header("x-amz-meta-sha256") != Some(digest)
            || header("x-amz-meta-semantic-bytes") != Some(bytes.to_string().as_str())
            || header("x-amz-meta-encoding") != Some("gzip")
        {
            return Err("Public object metadata mismatch".into());
        }
        let mut semantic = Vec::new();
        let decoded = decode_gzip(&object.body, bytes, |chunk| {
            semantic.extend_from_slice(chunk)
        })
        .map_err(|_| "Public object gzip or semantic size is invalid")?;
        if decoded != bytes || sha256(&semantic) != digest {
            return Err("Public object semantic identity mismatch".into());
        }
        // Node's public reader parses JSON rather than requiring canonical text.
        // Lossy UTF-8 decoding and duplicate-key normalization preserve that seam.
        let mut envelope = parse_utf16_json(String::from_utf8_lossy(&semantic).as_bytes())
            .map_err(|_| "Invalid public object JSON")?;
        normalize(&mut envelope);
        if !string_is(field(&envelope, "artifactKind"), "public-semantic-artifact")
            || integer(field(&envelope, "schemaVersion")) != Some(1)
            || !field(&envelope, "content").is_some_and(Utf16Json::is_object)
        {
            return Err("Public object semantic envelope is invalid".into());
        }
        let full_key = if self.bucket.prefix.is_empty() {
            key
        } else {
            format!("{}/{key}", self.bucket.prefix)
        };
        self.proofs.push(json!({"key":full_key,"digest":digest,"compressedBytes":object.body.len(),"compressedSha256":sha256(&object.body)}));
        let Utf16Json::Object(mut entries) = envelope else {
            unreachable!()
        };
        let index = entries
            .iter()
            .position(|(key, _)| key == &Utf16String::from("content"))
            .unwrap();
        Ok(entries.swap_remove(index).1)
    }

    fn visit(
        &mut self,
        tree: &Utf16Json,
        ancestors: &BTreeSet<String>,
        depth: usize,
    ) -> Result<Hydrated> {
        if depth > MAX_DEPTH || !matches!(tree, Utf16Json::Object(_) | Utf16Json::Array(_)) {
            return Err("Invalid public archive tree".into());
        }
        if string_is(field(tree, "kind"), "inline") {
            let value = field(tree, "value");
            return Ok(Hydrated {
                count: own_key_count(value),
                value: value.map(clone_json),
            });
        }
        if string_is(field(tree, "kind"), "record") {
            let entries = array(required(tree, "entries")?)?;
            let mut result = BTreeMap::new();
            for entry in entries {
                let pair = array(entry)?;
                if pair.len() != 2 {
                    return Err("Invalid public archive record".into());
                }
                let Utf16Json::String(key) = &pair[0] else {
                    return Err("Invalid public archive record key".into());
                };
                if result.contains_key(key) {
                    return Err("Invalid public archive duplicate record key".into());
                }
                let hydrated = self.visit(&pair[1], ancestors, depth + 1)?;
                result.insert(key.clone(), hydrated.value);
            }
            return Ok(Hydrated {
                count: entries.len() as u64,
                value: Some(Utf16Json::Object(
                    result
                        .into_iter()
                        .filter_map(|(key, value)| value.map(|value| (key, value)))
                        .collect(),
                )),
            });
        }
        let list = string_is(field(tree, "kind"), "list");
        if !list && !string_is(field(tree, "kind"), "map") {
            return Err("Invalid public archive parts".into());
        }
        let parts = array(required(tree, "parts")?)?;
        if parts.is_empty() {
            return Err("Invalid public archive parts".into());
        }
        // Node validates every reference before starting the first child request.
        let references = parts.iter().map(reference).collect::<Result<Vec<_>>>()?;
        let mut values = vec![];
        let mut entries = BTreeMap::new();
        let mut count = 0;
        for (digest, bytes, expected_count) in references {
            if ancestors.contains(&digest) {
                return Err("Public archive reference cycle".into());
            }
            let child = self.read(&digest, bytes)?;
            validate_archive(&child)?;
            if !string_is(field(&child, "artifactKind"), "public-archive-node") {
                return Err("Public archive child kind mismatch".into());
            }
            let mut next = ancestors.clone();
            next.insert(digest);
            let hydrated = self.visit(required(&child, "tree")?, &next, depth + 1)?;
            if hydrated.count != expected_count {
                return Err("Public archive child count mismatch".into());
            }
            count += hydrated.count;
            if list {
                let Some(Utf16Json::Array(child_values)) = hydrated.value else {
                    return Err("Public archive list child must be an array".into());
                };
                values.extend(child_values);
            } else {
                let Some(Utf16Json::Object(child_entries)) = hydrated.value else {
                    return Err("Public archive map child must be an object".into());
                };
                for (key, value) in child_entries {
                    if entries.insert(key, value).is_some() {
                        return Err("Public archive duplicate record key".into());
                    }
                }
            }
        }
        Ok(Hydrated {
            count,
            value: Some(if list {
                Utf16Json::Array(values)
            } else {
                Utf16Json::Object(entries.into_iter().collect())
            }),
        })
    }
}

fn reference(value: &Utf16Json) -> Result<(String, u64, u64)> {
    if !matches!(field(value, "sha256"), Some(Utf16Json::String(_))) {
        // Node's strict metadata comparison rejects coercible nonstring digests
        // when the child is read, even if its reference regex accepts them.
        return Err("Invalid public archive reference digest".into());
    }
    let digest = js_text(field(value, "sha256"));
    let bytes = integer(field(value, "bytes")).ok_or("Invalid public archive reference bytes")?;
    let count = integer(field(value, "count")).ok_or("Invalid public archive reference count")?;
    if !valid_digest(&digest)
        || bytes == 0
        || bytes > PAGE_BYTES
        || count == 0
        || !string_is(field(value, "encoding"), "gzip")
    {
        return Err("Invalid public archive reference".into());
    }
    for key in ["startUtcDate", "endUtcDate"] {
        if let Some(date) = field(value, key) {
            let text = js_text(Some(date));
            if text.len() != 10
                || text.as_bytes()[4] != b'-'
                || text.as_bytes()[7] != b'-'
                || text
                    .bytes()
                    .enumerate()
                    .any(|(index, byte)| !matches!(index, 4 | 7) && !byte.is_ascii_digit())
            {
                return Err("Invalid public archive reference date".into());
            }
        }
    }
    if let Some(start) = field(value, "startUtcDate") {
        let end = required(value, "endUtcDate")?;
        if !truthy(end) || less_than(end, start) {
            return Err("Invalid public archive reference date range".into());
        }
    }
    if field(value, "path").is_some_and(|path| !matches!(path, Utf16Json::String(_))) {
        return Err("Invalid public archive reference path".into());
    }
    if let Some(start) = field(value, "keyStart") {
        let end = required(value, "keyEnd")?;
        let (Utf16Json::String(start), Utf16Json::String(end)) = (start, end) else {
            return Err("Invalid public archive key range".into());
        };
        if end < start {
            return Err("Invalid public archive key range".into());
        }
    }
    if let Some(year) = field(value, "year") {
        let text = js_text(Some(year));
        if text.len() != 4 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err("Invalid public archive reference year".into());
        }
    }
    Ok((digest, bytes, count))
}

fn archive(value: &Utf16Json) -> bool {
    string_is(field(value, "artifactKind"), "public-artifact-archive")
        || string_is(field(value, "artifactKind"), "public-archive-node")
}
fn validate_archive(value: &Utf16Json) -> Result<()> {
    if integer(field(value, "formatVersion")) != Some(1)
        || !field(value, "tree").is_some_and(truthy)
    {
        return Err("Invalid public archive format".into());
    }
    Ok(())
}
fn field<'a>(value: &'a Utf16Json, key: &str) -> Option<&'a Utf16Json> {
    let Utf16Json::Object(entries) = value else {
        return None;
    };
    let key = Utf16String::from(key);
    entries
        .iter()
        .rev()
        .find(|(entry, _)| entry == &key)
        .map(|(_, value)| value)
}
fn field_opt<'a>(value: Option<&'a Utf16Json>, key: &str) -> Option<&'a Utf16Json> {
    value.and_then(|value| field(value, key))
}
fn strict_equal(left: Option<&Utf16Json>, right: Option<&Utf16Json>) -> bool {
    match (left, right) {
        (None, None) | (Some(Utf16Json::Null), Some(Utf16Json::Null)) => true,
        (Some(Utf16Json::Bool(left)), Some(Utf16Json::Bool(right))) => left == right,
        (Some(Utf16Json::String(left)), Some(Utf16Json::String(right))) => left == right,
        (Some(Utf16Json::Number(left)), Some(Utf16Json::Number(right))) => {
            left.as_f64() == right.as_f64()
        }
        _ => false,
    }
}
fn required<'a>(value: &'a Utf16Json, key: &str) -> Result<&'a Utf16Json> {
    field(value, key).ok_or_else(|| format!("Missing public archive {key}"))
}
fn array(value: &Utf16Json) -> Result<&[Utf16Json]> {
    match value {
        Utf16Json::Array(values) => Ok(values),
        _ => Err("Invalid public archive array".into()),
    }
}
fn string_is(value: Option<&Utf16Json>, text: &str) -> bool {
    matches!(value,Some(Utf16Json::String(value)) if value == &Utf16String::from(text))
}
fn integer(value: Option<&Utf16Json>) -> Option<u64> {
    let Some(Utf16Json::Number(value)) = value else {
        return None;
    };
    let number = value.as_f64()?;
    (number.is_finite()
        && number.fract() == 0.0
        && (0.0..=MAX_SAFE_INTEGER as f64).contains(&number))
    .then_some(number as u64)
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn truthy(value: &Utf16Json) -> bool {
    match value {
        Utf16Json::Null => false,
        Utf16Json::Bool(value) => *value,
        Utf16Json::Number(value) => value.as_f64() != Some(0.0),
        Utf16Json::String(value) => value.code_units().next().is_some(),
        _ => true,
    }
}
fn own_key_count(value: Option<&Utf16Json>) -> u64 {
    match value {
        Some(Utf16Json::Array(values)) => values.len() as u64,
        Some(Utf16Json::Object(entries)) => entries.len() as u64,
        Some(Utf16Json::String(value)) => value.code_units().count() as u64,
        _ => 0,
    }
}
fn js_text(value: Option<&Utf16Json>) -> String {
    match value {
        None => "undefined".into(),
        Some(Utf16Json::Null) => "null".into(),
        Some(Utf16Json::Bool(value)) => value.to_string(),
        Some(Utf16Json::Number(value)) => number_text(value.as_f64().unwrap()),
        Some(Utf16Json::String(value)) => {
            String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())
        }
        Some(Utf16Json::Array(values)) => values
            .iter()
            .map(|value| {
                if matches!(value, Utf16Json::Null) {
                    String::new()
                } else {
                    js_text(Some(value))
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Utf16Json::Object(_)) => "[object Object]".into(),
    }
}
fn less_than(left: &Utf16Json, right: &Utf16Json) -> bool {
    let left = js_text(Some(left));
    let right = js_text(Some(right));
    // Dates are nonnumeric strings. ToPrimitive yields strings for JSON arrays
    // too, so the relational comparison uses UTF-16 ordering.
    Utf16String::from(left.as_str()) < Utf16String::from(right.as_str())
}
fn normalize(value: &mut Utf16Json) {
    match value {
        Utf16Json::Array(values) => values.iter_mut().for_each(normalize),
        Utf16Json::Object(entries) => {
            let mut unique = BTreeMap::new();
            for (key, mut value) in std::mem::take(entries) {
                normalize(&mut value);
                unique.insert(key, value);
            }
            *entries = unique.into_iter().collect();
        }
        _ => {}
    }
}
fn clone_json(value: &Utf16Json) -> Utf16Json {
    match value {
        Utf16Json::Null => Utf16Json::Null,
        Utf16Json::Bool(value) => Utf16Json::Bool(*value),
        Utf16Json::Number(value) => Utf16Json::Number(value.clone()),
        Utf16Json::String(value) => Utf16Json::String(value.clone()),
        Utf16Json::Array(values) => Utf16Json::Array(values.iter().map(clone_json).collect()),
        Utf16Json::Object(entries) => Utf16Json::Object(
            entries
                .iter()
                .map(|(key, value)| (key.clone(), clone_json(value)))
                .collect(),
        ),
    }
}
