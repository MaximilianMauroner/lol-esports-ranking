use super::{
    IdentityMetadata, JSON_TYPE, ObjectProof, PublicIdentity, PublicObject, ReferenceGraph,
    archive::{PAGE_BYTES, Reader},
    directory, references, result_json, validate_storage_key,
    wire::*,
};
use crate::{Result, Utf16String, canonical_json_value, sha256};
use serde::{
    Deserialize,
    de::{MapAccess, Visitor, value::MapAccessDeserializer},
};
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
};
use url::Url;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const ROOT: &str = "/data/ranking-summary.json";

pub struct ManifestAuthority {
    pub(super) key: String,
    pub(super) etag: String,
    pub(super) bytes: u64,
    pub(super) digest: String,
}

pub enum GenerationScope {
    Structure,
    Artifacts,
}

impl<'de> Deserialize<'de> for ManifestAuthority {
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
            type Value = ManifestAuthority;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a public manifest authority object")
            }

            fn visit_map<M: MapAccess<'de>>(
                self,
                map: M,
            ) -> std::result::Result<Self::Value, M::Error> {
                let fields = Fields::deserialize(MapAccessDeserializer::new(map))?;
                Ok(ManifestAuthority {
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

pub struct SuppliedGeneration {
    authority: ManifestAuthority,
    context: Json,
    relative: String,
}

impl SuppliedGeneration {
    pub fn new(authority: ManifestAuthority, context_json: &str, prefix: &str) -> Result<Self> {
        let context = parse_json(context_json.as_bytes())?;
        if !matches!(context, Json::Object(_)) || !nonempty_string(field(&context, "generationId"))
        {
            return Err("Invalid public generation context".into());
        }
        let generation = field(&context, "generationId").expect("validated context generationId");
        let Json::String(generation_text) = generation else {
            unreachable!()
        };
        // An S3 authority key is a Unicode scalar string. Preserve the UTF-16
        // context for equality, but refuse a generation whose key cannot encode it.
        let generation_key = String::from_utf16(&generation_text.code_units().collect::<Vec<_>>())
            .map_err(|_| "Public generation context cannot form an S3 key")?;
        let relative = safe_path(&format!(
            "generations/{}/manifest.json",
            safe_path(&generation_key)
        ));
        validate_storage_key(&relative)?;
        let expected_key = if prefix.is_empty() {
            relative.clone()
        } else {
            format!("{}/{relative}", prefix)
        };
        if authority.key != expected_key
            || authority.etag.is_empty()
            || !valid_digest(&authority.digest)
            || !(1..=MAX_SAFE_INTEGER).contains(&authority.bytes)
        {
            return Err("Invalid public manifest authority".into());
        }
        Ok(Self {
            authority,
            context,
            relative,
        })
    }

    pub fn relative_key(&self) -> &str {
        &self.relative
    }

    pub fn check(
        self,
        metadata: IdentityMetadata<'_>,
        body: &[u8],
        scope: GenerationScope,
        load: &mut dyn FnMut(&PublicIdentity) -> Result<PublicObject>,
    ) -> Result<GenerationVerification> {
        let authority = self.authority;
        let header = |name: &str| metadata.headers.get(name).map(String::as_str);
        let bytes_text = authority.bytes.to_string();
        if metadata.etag != authority.etag
            || body.len() as u64 != authority.bytes
            || header("content-length") != Some(bytes_text.as_str())
            || header("content-type") != Some(JSON_TYPE)
            || header("content-encoding").is_some()
            || header("x-amz-meta-sha256") != Some(authority.digest.as_str())
            || header("x-amz-meta-semantic-bytes") != Some(bytes_text.as_str())
            || sha256(body) != authority.digest
        {
            return Err("Public manifest authority changed".into());
        }
        let generation =
            field(&self.context, "generationId").expect("validated context generationId");
        let mut manifest = parse_json(String::from_utf8_lossy(body).as_bytes())?;
        let mut reader = Reader::new(load);
        directory::expand(&mut reader, &mut manifest)?;
        let converted = validate(
            &manifest,
            generation,
            field(&self.context, "publicManifestSchemaVersion"),
        )?;
        if converted {
            let _ = take(&mut manifest, "schemaVersion");
            let Json::Object(entries) = &mut manifest else {
                unreachable!()
            };
            entries.push(("schemaVersion".into(), Json::Number(2.0)));
        }
        let artifacts = match scope {
            GenerationScope::Structure => None,
            GenerationScope::Artifacts => Some(read_artifacts(&mut reader, &manifest)?),
        };
        Ok(GenerationVerification {
            authority,
            etag: metadata.etag.to_owned(),
            manifest,
            artifacts,
            converted,
            proofs: reader.proofs,
        })
    }
}

pub struct GenerationVerification {
    authority: ManifestAuthority,
    etag: String,
    manifest: Json,
    artifacts: Option<Json>,
    converted: bool,
    proofs: Vec<ObjectProof>,
}

impl GenerationVerification {
    pub fn canonical_date(
        &self,
    ) -> std::result::Result<super::CanonicalDate, super::UnsupportedDate> {
        let Some(Json::String(value)) = field(&self.manifest, "generatedAt") else {
            unreachable!("validated generation date string")
        };
        let text = String::from_utf16(&value.code_units().collect::<Vec<_>>())
            .map_err(|_| super::UnsupportedDate)?;
        if !super::date::receipt_iso(&text) {
            return Err(super::UnsupportedDate);
        }
        Ok(super::CanonicalDate(text))
    }

    pub fn reference_graph(&self) -> Result<ReferenceGraph> {
        let Some(Json::Object(entries)) = &self.artifacts else {
            return Err("Public generation artifacts have not been verified".into());
        };
        references::ReferenceGraph::from_artifacts(entries)
    }

    pub fn result_json(&self, prefix: &str) -> String {
        let scalars = canonical_json_value(&json!({
            "key": self.authority.key, "etag": self.etag, "bytes": self.authority.bytes,
            "digest": self.authority.digest, "needsNodeDateValidation": true,
            "schemaConverted": self.converted,
        }));
        let mut parsed = result_json("manifest", &self.manifest, &self.proofs, prefix);
        if let Some(artifacts) = &self.artifacts {
            parsed.pop();
            parsed.push_str(",\"artifacts\":");
            write_json(artifacts, &mut parsed);
            parsed.push_str(",\"rootArtifact\":");
            write_json(
                field(artifacts, ROOT).expect("validated root artifact"),
                &mut parsed,
            );
            parsed.push('}');
        }
        format!("{},{}", &scalars[..scalars.len() - 1], &parsed[1..])
    }
}

/// Match the active Node reader's canonical identity selection, including its
/// second path normalization and last mapping for aliases of the same path.
fn read_artifacts(reader: &mut Reader<'_>, manifest: &Json) -> Result<Json> {
    let Some(Json::Object(entries)) = field(manifest, "artifacts") else {
        return Err("Invalid public generation artifact mappings".into());
    };
    let mut identities = BTreeMap::new();
    let mut paths = Vec::new();
    for (path, identity) in entries {
        let canonical = logical_path(path)?;
        if identities.insert(canonical.clone(), identity).is_none() {
            paths.push(canonical);
        }
    }
    let mut selected = BTreeSet::new();
    let mut artifacts = Vec::new();
    for path in paths {
        let canonical = logical_path(&path)?;
        if !selected.insert(canonical.clone()) {
            continue;
        }
        let Some(identity) = identities.get(&canonical) else {
            continue;
        };
        // The structural validator accepts Node's coercible digest spelling.
        // The artifact GET additionally requires the stored scalar metadata to
        // equal the digest field, so a non-string digest cannot pass that read.
        if !matches!(field(identity, "sha256"), Some(Json::String(_))) {
            return Err("Invalid public generation artifact digest".into());
        }
        let digest = js_text(field(identity, "sha256"));
        let bytes = integer(field(identity, "bytes")).expect("validated artifact bytes");
        artifacts.push((canonical, reader.read_artifact(&digest, bytes)?));
    }
    let artifacts = Json::Object(artifacts);
    if !field(&artifacts, ROOT).is_some_and(truthy) {
        return Err("Public generation has no valid root artifact".into());
    }
    Ok(artifacts)
}

pub(super) fn validate(manifest: &Json, generation: &Json, schema: Option<&Json>) -> Result<bool> {
    let version = integer(field(manifest, "schemaVersion"));
    let valid_pair = match schema {
        None | Some(Json::Undefined) => version == Some(1),
        Some(value) => integer(Some(value)) == Some(2) && version == Some(2),
    };
    let model = field(manifest, "model").ok_or("Missing public manifest model")?;
    let provenance = field(manifest, "provenance").ok_or("Missing public manifest provenance")?;
    let artifacts = field(manifest, "artifacts").ok_or("Missing public manifest artifacts")?;
    if !matches!(manifest, Json::Object(_))
        || !string_is(
            field(manifest, "artifactKind"),
            "public-artifact-generation-manifest",
        )
        || !valid_pair
        || !string_is(field(manifest, "storageMode"), "content-addressed-gzip-v1")
        || !same_string(field(manifest, "generationId"), generation)
        || !same_string(field(manifest, "runId"), generation)
        || !matches!(field(manifest, "generatedAt"), Some(Json::String(_)))
        || !matches!(model, Json::Object(_))
        || !nonempty_string(field(model, "version"))
        || !nonempty_string(field(model, "configHash"))
        || !matches!(provenance, Json::Object(_))
        || !nonempty_string(field(provenance, "source"))
        || !nonempty_string(field(provenance, "dataMode"))
        || !matches!(field(provenance, "sourceProviders"), Some(Json::Array(providers)) if providers.iter().all(|provider| nonempty_string(Some(provider))))
        || !string_is(field(manifest, "rootArtifact"), ROOT)
        || !matches!(artifacts, Json::Object(entries) if !entries.is_empty())
        || field(artifacts, ROOT).is_none()
    {
        return Err("Invalid public generation manifest structure".into());
    }
    if let Some(reference) =
        field(manifest, "artifactDirectory").filter(|value| !matches!(value, Json::Undefined))
        && (version != Some(2)
            || !valid_digest(&js_text(field(reference, "sha256")))
            || !integer(field(reference, "bytes"))
                .is_some_and(|bytes| (1..=PAGE_BYTES).contains(&bytes))
            || !string_is(field(reference, "encoding"), "gzip"))
    {
        return Err("Invalid public artifact directory authority".into());
    }
    let Json::Object(entries) = artifacts else {
        unreachable!()
    };
    for (path, identity) in entries {
        let canonical = logical_path(path)?;
        let digest = js_text(field(identity, "sha256"));
        if !matches!(identity, Json::Object(_))
            || !matches!(field(identity, "logicalPath"), Some(Json::String(value)) if value == &canonical)
            || !string_is(
                field(identity, "objectUrl"),
                &format!("/data/objects/sha256/{digest}"),
            )
            || !same_string(field(identity, "generationId"), generation)
            || !valid_digest(&digest)
            || !integer(field(identity, "bytes")).is_some_and(|bytes| bytes > 0)
            || !string_is(field(identity, "encoding"), "gzip")
            || !string_is(field(identity, "storageEncoding"), "gzip")
            || !matches!(field(identity, "transportEncodings"), Some(Json::Array(values)) if values.len() == 2 && string_is(values.first(), "identity") && string_is(values.get(1), "gzip"))
        {
            return Err("Invalid public generation artifact mapping".into());
        }
    }
    Ok(version == Some(1))
}

fn nonempty_string(value: Option<&Json>) -> bool {
    matches!(value, Some(Json::String(value)) if value.code_units().next().is_some())
}

fn same_string(value: Option<&Json>, expected: &Json) -> bool {
    matches!((value, expected), (Some(Json::String(left)), Json::String(right)) if left == right)
}

/// Node's safeObjectPath normalizes separators and dot segments, then removes
/// leading parent and root segments. It is used twice by the manifest key seam.
fn safe_path(value: &str) -> String {
    let text = value.replace('\\', "/");
    let absolute = text.starts_with('/');
    let mut parts = Vec::new();
    for part in text.split('/') {
        match part {
            "" | "." => {}
            ".." if parts.last().is_some_and(|previous| *previous != "..") => {
                parts.pop();
            }
            ".." if !absolute => parts.push(part),
            ".." => {}
            _ => parts.push(part),
        }
    }
    let mut result = parts.join("/");
    if !result.is_empty() && text.ends_with('/') {
        result.push('/');
    }
    while result.starts_with("../") {
        result = result[3..].to_owned();
    }
    result
}

/// Direct /data/ paths keep raw UTF-16 units. Other inputs use WHATWG URL
/// pathname resolution before the same traversal and decodeURIComponent rules.
pub(super) fn logical_path(value: &Utf16String) -> Result<Utf16String> {
    let mut units = value.code_units().collect::<Vec<_>>();
    if units.is_empty() || units.contains(&u16::from(b'\\')) {
        return Err("Invalid public logical path".into());
    }
    if units.starts_with(&"/data/".encode_utf16().collect::<Vec<_>>()) {
        if let Some(index) = units
            .iter()
            .position(|unit| *unit == u16::from(b'?') || *unit == u16::from(b'#'))
        {
            units.truncate(index);
        }
    } else {
        let base = Url::parse("https://public-artifacts.invalid").expect("constant public URL");
        let resolved = base
            .join(&String::from_utf16_lossy(&units))
            .map_err(|_| "Invalid public logical URL")?;
        units = resolved.path().encode_utf16().collect();
    }
    if !units.starts_with(&"/data/".encode_utf16().collect::<Vec<_>>()) || traversal(&units) {
        return Err("Invalid public logical path".into());
    }
    let mut decoded = Vec::new();
    let mut offset = 0;
    while offset < units.len() {
        if units[offset] != u16::from(b'%') {
            decoded.push(units[offset]);
            offset += 1;
            continue;
        }
        let mut bytes = Vec::new();
        while units.get(offset) == Some(&u16::from(b'%')) {
            let high = units
                .get(offset + 1)
                .and_then(|unit| char::from_u32(u32::from(*unit)))
                .and_then(|digit| digit.to_digit(16));
            let low = units
                .get(offset + 2)
                .and_then(|unit| char::from_u32(u32::from(*unit)))
                .and_then(|digit| digit.to_digit(16));
            let byte = high
                .zip(low)
                .map(|(high, low)| (high * 16 + low) as u8)
                .ok_or("Invalid public path percent encoding")?;
            if matches!(byte, b'/' | b'\\') {
                return Err("Encoded public path separator".into());
            }
            bytes.push(byte);
            offset += 3;
        }
        let text = std::str::from_utf8(&bytes).map_err(|_| "Invalid public path UTF-8 encoding")?;
        decoded.extend(text.encode_utf16());
    }
    if traversal(&decoded) || decoded.contains(&u16::from(b'\\')) {
        return Err("Invalid public logical path traversal".into());
    }
    let mut encoded = String::from("\"");
    for unit in decoded {
        encoded.push_str(&format!("\\u{unit:04x}"));
    }
    encoded.push('"');
    serde_json::from_str(&encoded).map_err(|error| error.to_string())
}

fn traversal(units: &[u16]) -> bool {
    units
        .split(|unit| *unit == u16::from(b'/'))
        .any(|part| part == [u16::from(b'.')] || part == [u16::from(b'.'), u16::from(b'.')])
}
