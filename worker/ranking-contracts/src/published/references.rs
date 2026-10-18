use super::{
    generation::logical_path,
    wire::{Json, field, string_is},
};
use crate::{Result, Utf16String};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::OnceLock,
};
use url::Url;

const VOCABULARY: &str =
    include_str!("../../../../src/domains/rankings/internal/published/referenceFields.json");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fields {
    #[serde(default)]
    urls: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    records: Vec<String>,
    #[serde(default)]
    arrays: Vec<String>,
}

fn vocabulary() -> &'static BTreeMap<String, Fields> {
    static FIELDS: OnceLock<BTreeMap<String, Fields>> = OnceLock::new();
    FIELDS.get_or_init(|| serde_json::from_str(VOCABULARY).expect("valid shared reference vocabulary"))
}

pub(super) fn artifact_references(content: &Json) -> Result<Vec<Utf16String>> {
    let Some(fields) = vocabulary().iter().find_map(|(kind, fields)| {
        string_is(field(content, "artifactKind"), kind).then_some(fields)
    }) else {
        return Ok(Vec::new());
    };
    let mut paths = Vec::new();
    let mut seen = BTreeSet::new();
    let mut add = |value: &Json, audit: bool| -> Result<()> {
        let Json::String(value) = value else {
            return Ok(());
        };
        if audit {
            let base = Url::parse("https://public-artifacts.invalid").expect("constant public URL");
            let resolved = base
                .join(&String::from_utf16_lossy(
                    &value.code_units().collect::<Vec<_>>(),
                ))
                .map_err(|_| "Invalid public logical URL")?;
            if !resolved.path().starts_with("/data/") {
                return Ok(());
            }
        }
        let path = logical_path(value)?;
        if seen.insert(path.clone()) {
            paths.push(path);
        }
        Ok(())
    };
    for (key, role) in &fields.urls {
        if let Some(value) = field(content, key) {
            add(value, role == "audit")?;
        }
    }
    let mut entries = Vec::new();
    for key in &fields.records {
        if let Some(Json::Object(values)) = field(content, key) {
            let mut values = values.iter().collect::<Vec<_>>();
            values.sort_by_key(|(key, _)| array_index(key).unwrap_or(u32::MAX));
            entries.extend(values.into_iter().map(|(_, value)| value));
        }
    }
    for key in &fields.arrays {
        if let Some(Json::Array(values)) = field(content, key) {
            entries.extend(values);
        }
    }
    entries.reverse();
    while let Some(entry) = entries.pop() {
        if !matches!(entry, Json::Object(_)) {
            continue;
        }
        if let Some(value) = field(entry, "url") {
            add(value, false)?;
        }
        if let Some(Json::Array(pages)) = field(entry, "pages") {
            entries.extend(pages.iter().rev());
        }
    }
    Ok(paths)
}

fn array_index(value: &Utf16String) -> Option<u32> {
    let text = String::from_utf16(&value.code_units().collect::<Vec<_>>()).ok()?;
    let index: u32 = text.parse().ok()?;
    (index < u32::MAX && index.to_string() == text).then_some(index)
}

pub struct ReferenceGraph {
    edges: Vec<(Utf16String, Vec<Utf16String>)>,
    available: BTreeSet<Utf16String>,
}

impl ReferenceGraph {
    pub(super) fn from_artifacts(entries: &[(Utf16String, Json)]) -> Result<Self> {
        let mut edges = Vec::new();
        let mut available = BTreeSet::new();
        for (path, value) in entries {
            available.insert(path.clone());
            edges.push((path.clone(), artifact_references(value)?));
        }
        Ok(Self { edges, available })
    }

    pub fn assert_closed(&self) -> Result<()> {
        for (referrer, targets) in &self.edges {
            for target in targets {
                if !self.available.contains(target) {
                    return Err(format!(
                        "Incomplete public artifact references: {referrer:?} references missing {target:?}"
                    ));
                }
            }
        }
        Ok(())
    }
}
