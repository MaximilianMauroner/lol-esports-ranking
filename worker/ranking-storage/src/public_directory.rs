use super::{
    public_archive::{
        Json, PAGE_BYTES, Reader, field, integer, parse_json, string_is, take, truthy,
        valid_digest, write_json,
    },
    s3,
};
use ranking_contracts::{Result, Utf16String};

/// Expands an already supplied manifest, without establishing its authority.
/// The directory and its archive descendants use fresh verified GETs only.
pub(super) fn verify(bucket: &s3::Bucket, manifest_json: &str) -> Result<String> {
    let mut manifest = parse_json(manifest_json.as_bytes())?;
    let mut reader = Reader::new(bucket);
    if matches!(manifest, Json::Null) {
        return Err("Invalid public directory manifest".into());
    }
    let Some(reference) = field(&manifest, "artifactDirectory").filter(|value| truthy(value))
    else {
        return Ok(reader.result("manifest", &manifest));
    };
    let digest = match field(reference, "sha256") {
        Some(Json::String(value)) => {
            String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())
        }
        _ => return Err("Invalid public artifact directory authority".into()),
    };
    let bytes = integer(field(reference, "bytes"))
        .filter(|bytes| (1..=PAGE_BYTES).contains(bytes))
        .ok_or("Invalid public artifact directory authority")?;
    if !valid_digest(&digest) || !string_is(field(reference, "encoding"), "gzip") {
        return Err("Invalid public artifact directory authority".into());
    }
    let mut directory = reader.read_artifact(&digest, bytes)?;
    if !string_is(
        field(&directory, "artifactKind"),
        "public-artifact-directory",
    ) || integer(field(&directory, "formatVersion")) != Some(1)
        || !matches!(field(&directory, "artifacts"), Some(Json::Object(_)))
    {
        return Err("Invalid public artifact directory".into());
    }
    let generation = field(&manifest, "generationId")
        .cloned()
        .unwrap_or(Json::Undefined);
    let entries =
        own_entries(take(&mut directory, "artifacts").expect("validated directory artifacts"));
    let mut artifacts = Vec::with_capacity(entries.len());
    for (path, entry) in entries {
        let mut properties = own_entries(entry);
        properties.retain(|(key, _)| key != &Utf16String::from("generationId"));
        properties.push(("generationId".into(), generation.clone()));
        artifacts.push((path, Json::Object(properties)));
    }
    let root =
        field(&manifest, "artifacts").ok_or("Invalid public artifact directory root mapping")?;
    if matches!(root, Json::Undefined | Json::Null) {
        return Err("Invalid public artifact directory root mapping".into());
    }
    // Object.entries and object spread use own properties. Neither operation
    // rejects primitive entries; a string contributes one property per UTF-16 unit.
    for (path, identity) in own_entries(root.clone()) {
        let expected = artifacts
            .iter()
            .find(|(key, _)| key == &path)
            .map(|(_, value)| value);
        let mut actual_json = String::new();
        write_json(&identity, &mut actual_json);
        let expected_json = if let Some(value) = expected {
            let mut text = String::new();
            write_json(value, &mut text);
            text
        } else if path == Utf16String::from("__proto__") {
            // Object.fromEntries produces an ordinary object. Node's lookup of
            // an absent __proto__ sees Object.prototype, whose canonical JSON is {}.
            "{}".into()
        } else {
            // Other absent properties are undefined or Object.prototype functions.
            // canonicalJsonFor writes both as null.
            "null".into()
        };
        if actual_json != expected_json {
            return Err("Public artifact directory root mapping mismatch".into());
        }
    }
    let _ = take(&mut manifest, "artifacts");
    let Json::Object(properties) = &mut manifest else {
        return Err("Invalid public directory manifest".into());
    };
    properties.push(("artifacts".into(), Json::Object(artifacts)));
    Ok(reader.result("manifest", &manifest))
}

/// Own enumerable JSON properties, matching Object.entries and {...value}.
fn own_entries(mut value: Json) -> Vec<(Utf16String, Json)> {
    match &mut value {
        Json::Object(entries) => std::mem::take(entries),
        Json::Array(values) => std::mem::take(values)
            .into_iter()
            .enumerate()
            .map(|(index, value)| (index.to_string().as_str().into(), value))
            .collect(),
        Json::String(value) => value
            .code_units()
            .enumerate()
            .map(|(index, unit)| {
                let text = format!("\"\\u{unit:04x}\"");
                let value: Utf16String =
                    serde_json::from_str(&text).expect("valid escaped UTF-16 unit");
                (index.to_string().as_str().into(), Json::String(value))
            })
            .collect(),
        _ => Vec::new(),
    }
}
