use super::{ObjectProof, PublicIdentity, PublicObject, wire::*};
use crate::Result;
use std::collections::BTreeSet;

pub(super) const PAGE_BYTES: u64 = 512_000;
const MAX_DEPTH: usize = 24;
pub(super) struct Reader<'a> {
    load: &'a mut dyn FnMut(&PublicIdentity) -> Result<PublicObject>,
    pub(super) proofs: Vec<ObjectProof>,
    budget: Option<ServingBudget<'a>>,
}

struct ServingBudget<'a> {
    bytes: u64,
    nodes: usize,
    checkpoint: &'a mut dyn FnMut() -> Result<()>,
}

struct Hydrated {
    value: Json,
    count: u64,
}

impl Reader<'_> {
    pub(super) fn new(load: &mut dyn FnMut(&PublicIdentity) -> Result<PublicObject>) -> Reader<'_> {
        Reader {
            load,
            proofs: vec![],
            budget: None,
        }
    }

    pub(super) fn bounded<'a>(
        load: &'a mut dyn FnMut(&PublicIdentity) -> Result<PublicObject>,
        checkpoint: &'a mut dyn FnMut() -> Result<()>,
    ) -> Reader<'a> {
        Reader {
            load,
            proofs: vec![],
            budget: Some(ServingBudget {
                bytes: 64 * 1024 * 1024,
                nodes: 1_000_000,
                checkpoint,
            }),
        }
    }

    fn checkpoint(&mut self) -> Result<()> {
        if let Some(budget) = &mut self.budget {
            (budget.checkpoint)()?;
        }
        Ok(())
    }

    fn require_nodes(&self, count: usize) -> Result<()> {
        if self
            .budget
            .as_ref()
            .is_some_and(|budget| count > budget.nodes)
        {
            return Err("Public archive exceeds serving traversal limit".into());
        }
        Ok(())
    }

    fn charge_value(&mut self, value: &Json) -> Result<()> {
        if self.budget.is_none() {
            return Ok(());
        }
        let mut pending = vec![value];
        while let Some(value) = pending.pop() {
            self.checkpoint()?;
            let budget = self.budget.as_mut().unwrap();
            budget.nodes = budget
                .nodes
                .checked_sub(1)
                .ok_or("Public archive exceeds serving traversal limit")?;
            match value {
                Json::Array(values) => {
                    self.require_nodes(pending.len().saturating_add(values.len()))?;
                    pending.extend(values);
                }
                Json::Object(values) => {
                    self.require_nodes(pending.len().saturating_add(values.len()))?;
                    pending.extend(values.iter().map(|(_, value)| value));
                }
                _ => {}
            }
        }
        Ok(())
    }

    pub(super) fn read_artifact(&mut self, digest: &str, bytes: u64) -> Result<Json> {
        let mut content = self.read(digest, bytes)?;
        if archive(&content) {
            validate_archive(&content)?;
            let tree = take(&mut content, "tree").ok_or("Missing public archive tree")?;
            let hydrated = self.visit(tree, &BTreeSet::new(), 0)?;
            if string_is(field(&content, "artifactKind"), "public-artifact-archive")
                && !strict_equal(
                    field(&hydrated.value, "artifactKind"),
                    field(&content, "originalKind"),
                )
            {
                return Err("Public archive original kind mismatch".into());
            }
            content = hydrated.value;
        }
        Ok(content)
    }

    pub(super) fn read(&mut self, digest: &str, bytes: u64) -> Result<Json> {
        self.checkpoint()?;
        if let Some(budget) = &mut self.budget {
            budget.bytes = budget
                .bytes
                .checked_sub(bytes)
                .ok_or("Public archive exceeds serving byte limit")?;
        }
        let identity = PublicIdentity::new(digest, bytes)?;
        let object = (self.load)(&identity)?;
        if object.identity != identity {
            return Err("Public object semantic identity mismatch".into());
        }
        self.charge_value(&object.content)?;
        self.proofs.push(object.proof);
        Ok(object.content)
    }

    fn visit(
        &mut self,
        mut tree: Json,
        ancestors: &BTreeSet<String>,
        depth: usize,
    ) -> Result<Hydrated> {
        self.checkpoint()?;
        if depth > MAX_DEPTH || !matches!(tree, Json::Object(_) | Json::Array(_)) {
            return Err("Invalid public archive tree".into());
        }
        if string_is(field(&tree, "kind"), "inline") {
            let value = take(&mut tree, "value").unwrap_or(Json::Undefined);
            self.charge_value(&value)?;
            return Ok(Hydrated {
                count: own_key_count(&value),
                value,
            });
        }
        if string_is(field(&tree, "kind"), "record") {
            let invalid = || "Invalid public archive record".to_string();
            let entries = take(&mut tree, "entries")
                .and_then(into_array)
                .ok_or_else(invalid)?;
            self.require_nodes(entries.len())?;
            let mut keys = BTreeSet::new();
            let mut children = Vec::with_capacity(entries.len());
            for entry in entries {
                self.checkpoint()?;
                let mut pair = into_array(entry).ok_or_else(invalid)?;
                if pair.len() != 2 {
                    return Err(invalid());
                }
                let child = pair.pop().expect("record pair child");
                let Json::String(key) = &pair[0] else {
                    return Err(invalid());
                };
                if !keys.insert(key.clone()) {
                    return Err(invalid());
                }
                children.push((key.clone(), child));
            }
            let count = children.len() as u64;
            let mut result = Vec::with_capacity(children.len());
            for (key, child) in children {
                result.push((key, self.visit(child, ancestors, depth + 1)?.value));
            }
            return Ok(Hydrated {
                count,
                value: Json::Object(result),
            });
        }
        let list = string_is(field(&tree, "kind"), "list");
        if !list && !string_is(field(&tree, "kind"), "map") {
            return Err("Invalid public archive parts".into());
        }
        let parts = take(&mut tree, "parts")
            .and_then(into_array)
            .filter(|parts| !parts.is_empty())
            .ok_or("Invalid public archive parts")?;
        let references = parts.iter().map(reference).collect::<Result<Vec<_>>>()?;
        if self.budget.is_some() {
            let expected_total = references.iter().try_fold(0usize, |total, (_, _, count)| {
                usize::try_from(*count)
                    .ok()
                    .and_then(|count| total.checked_add(count))
                    .ok_or("Public archive exceeds serving traversal limit")
            })?;
            self.require_nodes(expected_total)?;
        }
        let mut values = vec![];
        let mut entries = vec![];
        let mut keys = BTreeSet::new();
        let mut count = 0;
        for (digest, bytes, expected_count) in references {
            if ancestors.contains(&digest) {
                return Err("Public archive reference cycle".into());
            }
            let mut child = self.read(&digest, bytes)?;
            validate_archive(&child)?;
            if !string_is(field(&child, "artifactKind"), "public-archive-node") {
                return Err("Public archive child kind mismatch".into());
            }
            let mut next = ancestors.clone();
            next.insert(digest);
            let child_tree = take(&mut child, "tree").ok_or("Missing public archive tree")?;
            let mut hydrated = self.visit(child_tree, &next, depth + 1)?;
            if hydrated.count != expected_count {
                return Err("Public archive child count mismatch".into());
            }
            count += hydrated.count;
            if list {
                let Json::Array(child_values) = &mut hydrated.value else {
                    return Err("Public archive list child must be an array".into());
                };
                values.append(child_values);
            } else {
                let Json::Object(child_entries) = &mut hydrated.value else {
                    return Err("Public archive map child must be an object".into());
                };
                for (key, value) in child_entries.drain(..) {
                    self.checkpoint()?;
                    if !keys.insert(key.clone()) {
                        return Err("Public archive duplicate record key".into());
                    }
                    entries.push((key, value));
                }
            }
        }
        Ok(Hydrated {
            count,
            value: if list {
                Json::Array(values)
            } else {
                Json::Object(entries)
            },
        })
    }
}

fn reference(value: &Json) -> Result<(String, u64, u64)> {
    if !matches!(field(value, "sha256"), Some(Json::String(_))) {
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
    if field(value, "path").is_some_and(|path| !matches!(path, Json::String(_))) {
        return Err("Invalid public archive reference path".into());
    }
    if let Some(start) = field(value, "keyStart") {
        let end = required(value, "keyEnd")?;
        let (Json::String(start), Json::String(end)) = (start, end) else {
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

fn archive(value: &Json) -> bool {
    string_is(field(value, "artifactKind"), "public-artifact-archive")
        || string_is(field(value, "artifactKind"), "public-archive-node")
}
fn validate_archive(value: &Json) -> Result<()> {
    if integer(field(value, "formatVersion")) != Some(1)
        || !field(value, "tree").is_some_and(truthy)
    {
        return Err("Invalid public archive format".into());
    }
    Ok(())
}
