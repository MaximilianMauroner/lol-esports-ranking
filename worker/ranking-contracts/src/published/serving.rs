use super::{IdentityMetadata, PublicIdentity, PublicationReceipt, PublicationRequest, full_key};
use super::{date::{receipt_iso, serving_date}, generation, publication, wire::*};
use crate::{Result, canonical_json_value, number_text, sha256};
use serde_json::Value;
use std::collections::BTreeSet;

pub struct ActivePointer {
    value: Value,
    publication: Option<PublicationRequest>,
}

impl ActivePointer {
    pub fn parse(body: &[u8], prefix: &str) -> Result<Self> {
        let publication = PublicationRequest::from_active(body, prefix)?;
        let value: Value = serde_json::from_slice(body)
            .map_err(|_| "Active generation pointer is invalid")?;
        if publication.is_some() && value["storageMode"] != "content-addressed-gzip-v1" {
            return Err("Receipt-bound active generation pointer has invalid storage authority".into());
        }
        Ok(Self { value, publication })
    }

    pub fn generation(&self) -> Option<&str> {
        self.value["generationId"].as_str().filter(|value| !value.is_empty())
    }

    pub fn content_addressed(&self) -> bool {
        self.value["storageMode"] == "content-addressed-gzip-v1"
    }

    pub fn receipt_key(&self) -> Option<String> {
        self.publication.as_ref().map(|request| request.relative_key().to_owned())
            .or_else(|| self.legacy_native().then(|| format!("generations/{}/publish.json", self.generation().unwrap_or_default())))
    }

    pub fn manifest_key(&self, prefix: &str) -> Result<String> {
        let generation = self.generation().ok_or("Missing active generation identity")?;
        let key = format!("generations/{}/manifest.json", normalized_path(generation));
        super::validate_storage_key(&key)?;
        if self.value["manifestKey"].as_str() != Some(full_key(prefix, &key).as_str()) {
            return Err("Active public generation manifest key is not canonical".into());
        }
        Ok(key)
    }

    pub fn immutable_binding(&self) -> Option<&str> {
        self.value.get("publicationReceiptDigest").or_else(|| self.value.get("manifestDigest"))
            .and_then(Value::as_str).filter(|value| !value.is_empty())
    }

    pub fn check_receipt(&mut self, metadata: IdentityMetadata<'_>, body: &[u8], prefix: &str) -> Result<ServingReceipt> {
        let binding = sha256(canonical_json_value(&self.value).as_bytes());
        if let Some(request) = self.publication.take() {
            return Ok(ServingReceipt { binding, kind: ReceiptKind::Bound(request.check(metadata, body)?) });
        }
        if !self.legacy_native() {
            return Err("Legacy pointer has no publication receipt".into());
        }
        check_legacy_receipt(&self.value, metadata, body, prefix)?;
        Ok(ServingReceipt { binding, kind: ReceiptKind::Legacy })
    }

    fn legacy_native(&self) -> bool {
        self.value.get("publicationSchemaVersion").is_none()
            && self.value["publicManifestSchemaVersion"].as_f64() == Some(2.0)
    }

    pub fn check_manifest(&self, metadata: IdentityMetadata<'_>, body: &[u8], receipt: Option<&ServingReceipt>) -> Result<ServingManifest> {
        let active = &self.value;
        let receipt_required = active.get("publicationSchemaVersion").is_some() || self.legacy_native();
        if receipt_required && receipt.is_none() {
            return Err("Active generation publication receipt is unavailable".into());
        }
        if receipt.is_some_and(|receipt| receipt.binding != sha256(canonical_json_value(active).as_bytes())) {
            return Err("Publication receipt belongs to another active pointer".into());
        }
        let hash = sha256(body);
        if !valid_digest(active["manifestDigest"].as_str().unwrap_or_default())
            || active["manifestDigest"] != hash
            || active["manifestBytes"].as_u64() != Some(body.len() as u64)
            || body.is_empty()
            || active["manifestEtag"].as_str().filter(|value| !value.is_empty()) != Some(metadata.etag)
            || metadata.headers.get("x-amz-meta-sha256") != Some(&hash)
        {
            return Err("Active public generation manifest authority mismatch".into());
        }
        let manifest = compatible_manifest(body, self.generation().ok_or("Missing generation identity")?, active.get("publicManifestSchemaVersion"))?;
        if let Some(ReceiptKind::Bound(receipt)) = receipt.map(|receipt| &receipt.kind) {
            let expected = &receipt.receipt["provenance"];
            let parsed = &manifest.manifest;
            let provenance = field(parsed, "provenance").ok_or("Missing public provenance")?;
            let model = field(parsed, "model").ok_or("Missing public model")?;
            for (key, actual) in [
                ("modelVersion", field(model, "version")),
                ("modelConfigHash", field(model, "configHash")),
                ("source", field(provenance, "source")),
                ("dataMode", field(provenance, "dataMode")),
                ("sourceProviders", field(provenance, "sourceProviders")),
            ] {
                let mut actual_json = String::new();
                write_json(actual.ok_or("Missing publication provenance")?, &mut actual_json);
                if actual_json != canonical_json_value(&expected[key]) {
                    return Err("Active generation publication provenance does not match public manifest".into());
                }
            }
        } else if self.legacy_native() && !matches!(receipt.map(|receipt| &receipt.kind), Some(ReceiptKind::Legacy)) {
            return Err("Legacy native publication receipt is unavailable".into());
        }
        Ok(manifest)
    }
}

pub struct ServingReceipt {
    binding: String,
    kind: ReceiptKind,
}

enum ReceiptKind {
    Bound(PublicationReceipt),
    Legacy,
}

impl ServingReceipt {
    pub fn check_public_member(&self, prefix: &str, identity: &PublicIdentity, stored_bytes: u64) -> Result<()> {
        if let ReceiptKind::Bound(receipt) = &self.kind {
            let key = full_key(prefix, &identity.relative_key());
            if !receipt.receipt["objects"].as_array().expect("validated members").iter()
                .any(|member| member["key"] == key && member["digest"] == identity.digest() && member["bytes"].as_u64() == Some(stored_bytes)) {
                return Err("Public artifact is absent from publication immutable closure".into());
            }
        }
        Ok(())
    }
}

pub struct ServingManifest {
    manifest: Json,
    body: Vec<u8>,
    cutover: bool,
}

impl ServingManifest {
    pub fn body(&self) -> &[u8] { &self.body }
    pub fn cutover(&self) -> bool { self.cutover }
    pub fn root(&self) -> Result<PublicIdentity> {
        let Some(Json::Object(entries)) = field(&self.manifest, "artifacts") else {
            return Err("Missing public artifacts".into());
        };
        let mut identity = None;
        for (path, candidate) in entries {
            if generation::logical_path(path)? == "/data/ranking-summary.json".into() {
                identity = Some(candidate);
            }
        }
        let identity = identity.ok_or("Public generation has no valid root artifact")?;
        let Some(Json::String(hash)) = field(identity, "sha256") else {
            return Err("Invalid public generation root digest".into());
        };
        let hash = String::from_utf16(&hash.code_units().collect::<Vec<_>>()).map_err(|_| "Invalid public root digest")?;
        PublicIdentity::new(&hash, integer(field(identity, "bytes")).ok_or("Invalid public root bytes")?)
    }
}

pub fn compatible_manifest(body: &[u8], generation: &str, schema: Option<&Value>) -> Result<ServingManifest> {
    let mut manifest = parse_json(String::from_utf8_lossy(body).as_bytes())?;
    let generation = Json::String(generation.into());
    let schema = schema.map(|value| parse_json(canonical_json_value(value).as_bytes())).transpose()?;
    let cutover = generation::validate(&manifest, &generation, schema.as_ref())?;
    let date = match field(&manifest, "generatedAt") {
        Some(Json::String(date)) => String::from_utf16(&date.code_units().collect::<Vec<_>>()).map_err(|_| "Invalid public generation date")?,
        _ => return Err("Invalid public generation date".into()),
    };
    if !serving_date(&date) {
        return Err("Unsupported public generation date".into());
    }
    let response = if cutover {
        let Json::Object(entries) = &mut manifest else { unreachable!() };
        for (key, value) in entries {
            if key.code_units().eq("schemaVersion".encode_utf16()) { *value = Json::Number(2.0); break; }
        }
        pretty_manifest(&manifest)?
    } else { body.to_vec() };
    Ok(ServingManifest { manifest, body: response, cutover })
}

fn pretty_manifest(value: &Json) -> Result<Vec<u8>> {
    enum Step<'a> { Value(&'a Json, usize), Key(&'a crate::Utf16String), Text(&'static str), Indent(usize) }
    let mut pending = vec![Step::Value(value, 0)];
    let mut output = String::new();
    const LIMIT: usize = 8 * 1024 * 1024;
    while let Some(step) = pending.pop() {
        match step {
            Step::Text(text) => output.push_str(text),
            Step::Indent(depth) => {
                if depth > LIMIT / 2 || output.len() + 1 + depth * 2 > LIMIT {
                    return Err("Legacy manifest cutover exceeds serving limit".into());
                }
                output.push('\n');
                output.push_str(&"  ".repeat(depth));
            }
            Step::Key(key) => { key.write_json(&mut output); output.push_str(": "); },
            Step::Value(Json::Undefined | Json::Null, _) => output.push_str("null"),
            Step::Value(Json::Bool(value), _) => output.push_str(if *value { "true" } else { "false" }),
            Step::Value(Json::Number(value), _) => output.push_str(&number_text(*value)),
            Step::Value(Json::String(value), _) => value.write_json(&mut output),
            Step::Value(Json::Array(values), depth) => {
                output.push('[');
                pending.push(Step::Text("]"));
                if !values.is_empty() { pending.push(Step::Indent(depth)); }
                for (index, value) in values.iter().enumerate().rev() {
                    pending.push(Step::Value(value, depth + 1));
                    pending.push(Step::Indent(depth + 1));
                    if index > 0 { pending.push(Step::Text(",")); }
                }
            }
            Step::Value(Json::Object(entries), depth) => {
                let mut entries = entries.iter().filter(|(_, value)| !matches!(value, Json::Undefined)).collect::<Vec<_>>();
                entries.sort_by(|(left, _), (right, _)| match (index_key(left), index_key(right)) {
                    (Some(left), Some(right)) => left.cmp(&right),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => std::cmp::Ordering::Equal,
                });
                output.push('{');
                pending.push(Step::Text("}"));
                if !entries.is_empty() { pending.push(Step::Indent(depth)); }
                for (index, (key, value)) in entries.into_iter().enumerate().rev() {
                    pending.push(Step::Value(value, depth + 1));
                    pending.push(Step::Key(key));
                    pending.push(Step::Indent(depth + 1));
                    if index > 0 { pending.push(Step::Text(",")); }
                }
            }
        }
        if output.len() >= LIMIT { return Err("Legacy manifest cutover exceeds serving limit".into()); }
    }
    output.push('\n');
    Ok(output.into_bytes())
}

fn index_key(key: &crate::Utf16String) -> Option<u32> {
    let units = key.code_units().collect::<Vec<_>>();
    if units.is_empty() || units.len() > 10 || (units.len() > 1 && units[0] == u16::from(b'0')) { return None; }
    let index = units.into_iter().try_fold(0u32, |value, unit| {
        if !(u16::from(b'0')..=u16::from(b'9')).contains(&unit) { return None; }
        value.checked_mul(10)?.checked_add(u32::from(unit - u16::from(b'0')))
    })?;
    (index < u32::MAX).then_some(index)
}

pub fn positive_number_text(value: &str) -> Option<u64> {
    publication::js_number_string(value)
        .filter(|value| value.is_finite() && *value > 0.0 && *value <= 9_007_199_254_740_991.0 && value.fract() == 0.0)
        .map(|value| value as u64)
}

pub fn normalized_path(value: &str) -> String {
    let replaced = value.replace('\\', "/");
    let mut parts = Vec::new();
    for part in replaced.split('/') {
        match part {
            "" | "." => {},
            ".." => { parts.pop(); },
            _ => parts.push(part),
        }
    }
    parts.join("/")
}

fn check_legacy_receipt(active: &Value, metadata: IdentityMetadata<'_>, body: &[u8], prefix: &str) -> Result<Value> {
    let header = |name: &str| metadata.headers.get(name).map(String::as_str);
    let value: Value = serde_json::from_slice(body).map_err(|_| "Invalid legacy native publication receipt JSON")?;
    if header("content-length") != Some(body.len().to_string().as_str())
        || header("content-type") != Some(super::JSON_TYPE)
        || header("content-encoding").is_some()
        || header("x-amz-meta-sha256") != Some(sha256(body).as_str())
        || header("x-amz-meta-semantic-bytes") != Some(body.len().to_string().as_str())
        || canonical_json_value(&value).as_bytes() != body
    {
        return Err("Legacy native publication receipt authority mismatch".into());
    }
    let required = ["schemaVersion", "publishedAt", "prefix", "generationId", "artifactCount", "uploadedCount", "uploadedBytes", "unchangedCount", "unchangedBytes", "artifacts", "unchanged", "skipped", "storageMode", "authorities"];
    let record = value.as_object().ok_or("Invalid legacy native receipt")?;
    if required.iter().any(|key| !record.contains_key(*key))
        || record.keys().any(|key| !required.contains(&key.as_str()) && !["storage", "refreshTelemetry"].contains(&key.as_str()))
        || value["schemaVersion"].as_u64() != Some(2)
        || value["storageMode"] != "content-addressed-gzip-v1"
        || value["generationId"] != active["generationId"] || value["prefix"] != prefix
        || !value["publishedAt"].as_str().is_some_and(receipt_iso)
        || !value["skipped"].is_array()
    { return Err("Invalid legacy native publication receipt schema".into()); }
    publication::safe_id(active["generationId"].as_str().ok_or("Invalid legacy generation")?)?;
    let uploaded = value["artifacts"].as_array().ok_or("Invalid legacy uploaded objects")?;
    let unchanged = value["unchanged"].as_array().ok_or("Invalid legacy unchanged objects")?;
    let mut keys = BTreeSet::new();
    for entry in uploaded.iter().chain(unchanged) {
        check_legacy_entry(entry, prefix)?;
        if !keys.insert(entry["key"].as_str().unwrap()) { return Err("Duplicate legacy publication reference".into()); }
    }
    let sum = |entries: &[Value]| entries.iter().try_fold(0u64, |sum, entry| sum.checked_add(entry["bytes"].as_u64().unwrap()).ok_or("Legacy receipt byte overflow"));
    if value["artifactCount"].as_u64() != Some((uploaded.len() + unchanged.len()) as u64)
        || value["uploadedCount"].as_u64() != Some(uploaded.len() as u64)
        || value["uploadedBytes"].as_u64() != Some(sum(uploaded)?)
        || value["unchangedCount"].as_u64() != Some(unchanged.len() as u64)
        || value["unchangedBytes"].as_u64() != Some(sum(unchanged)?)
    { return Err("Legacy publication counters are inconsistent".into()); }
    let authorities = value["authorities"].as_object().ok_or("Invalid legacy publication authorities")?;
    if authorities.len() != 2 || !authorities.contains_key("publicManifest") || !authorities.contains_key("rawReceipt") {
        return Err("Legacy publication authorities are incomplete".into());
    }
    for authority in authorities.values() {
        check_legacy_entry(authority, prefix)?;
        if authority["contentType"] != super::JSON_TYPE
            || uploaded.iter().chain(unchanged).filter(|entry| *entry == authority).count() != 1 {
            return Err("Legacy publication authority is not bound to one receipt entry".into());
        }
    }
    for (field, authority, property) in [
        ("manifestKey", "publicManifest", "key"), ("manifestDigest", "publicManifest", "digest"),
        ("manifestBytes", "publicManifest", "bytes"), ("rawReceiptKey", "rawReceipt", "key"),
        ("rawReceiptDigest", "rawReceipt", "digest"), ("rawReceiptCompressedBytes", "rawReceipt", "bytes"),
    ] {
        if active[field] != value["authorities"][authority][property] {
            return Err("Legacy pointer is not bound to its schema-v2 publication receipt".into());
        }
    }
    Ok(value)
}

fn check_legacy_entry(value: &Value, prefix: &str) -> Result<()> {
    let record = value.as_object().ok_or("Invalid legacy publication entry")?;
    if record.keys().any(|key| !["key", "bytes", "contentType", "digest"].contains(&key.as_str()))
        || !value["key"].as_str().is_some_and(|key| !key.is_empty() && (prefix.is_empty() || key.starts_with(&format!("{prefix}/"))))
        || !value["bytes"].as_u64().is_some_and(|bytes| (1..=9_007_199_254_740_991).contains(&bytes))
        || !value["contentType"].as_str().is_some_and(|value| !value.is_empty())
        || !value["digest"].as_str().is_some_and(valid_digest)
    { return Err("Invalid legacy publication entry".into()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cutover_pretty_json_preserves_insertion_integer_key_order_and_utf16() {
        let value = parse_json(br#"{"z":"\ud800","2":"second","1":"first","a":[{},[],true]}"#).unwrap();
        let pretty = pretty_manifest(&value).unwrap();
        assert_eq!(String::from_utf8(pretty).unwrap(), "{\n  \"1\": \"first\",\n  \"2\": \"second\",\n  \"z\": \"\\ud800\",\n  \"a\": [\n    {},\n    [],\n    true\n  ]\n}\n");
    }

    #[test]
    fn unknown_and_contradictory_pointer_authorities_are_rejected() {
        for value in [
            serde_json::json!({"generationId":"x", "publicationReceiptKey":"unexpected"}),
            serde_json::json!({"generationId":"x", "publicManifestSchemaVersion":3}),
            serde_json::json!({"generationId":"x", "unknownAuthority":true}),
            serde_json::json!({"generationId":"x", "publicationSchemaVersion":1}),
        ] {
            assert!(ActivePointer::parse(&serde_json::to_vec(&value).unwrap(), "rankings").is_err());
        }
    }
}
