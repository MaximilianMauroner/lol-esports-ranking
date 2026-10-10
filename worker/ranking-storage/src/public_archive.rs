use super::{s3, state_generation::decode_gzip};
use ranking_contracts::{Result, Utf16String, canonical_json_value, number_text, sha256};
use reqwest::Method;
use serde::de::IgnoredAny;
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
    let mut content = reader.read(digest, bytes)?;
    if archive(&content) {
        validate_archive(&content)?;
        let tree = take(&mut content, "tree").ok_or("Missing public archive tree")?;
        let hydrated = reader.visit(tree, &BTreeSet::new(), 0)?;
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
    let proofs = canonical_json_value(&json!(reader.proofs));
    let mut output = String::from("{");
    if !matches!(content, Json::Undefined) {
        output.push_str("\"content\":");
        write_json(&content, &mut output);
        output.push(',');
    }
    output.push_str(&format!("\"verifiedObjects\":{proofs}}}"));
    Ok(output)
}

/// A public value as JSON.parse produces it: binary64 numbers, including
/// overflow to infinity, and the last duplicate key wins. Only hydrated record
/// values can be Undefined. Parsing, output, coercion and drop use explicit
/// stacks, so nesting is limited by the stored object's size, not the call stack.
enum Json {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(Utf16String),
    Array(Vec<Json>),
    Object(Vec<(Utf16String, Json)>),
}

impl Drop for Json {
    fn drop(&mut self) {
        let mut pending = Vec::new();
        take_children(self, &mut pending);
        while let Some(mut value) = pending.pop() {
            take_children(&mut value, &mut pending);
        }
    }
}

fn take_children(value: &mut Json, pending: &mut Vec<Json>) {
    match value {
        Json::Array(values) => pending.append(values),
        Json::Object(entries) => pending.extend(entries.drain(..).map(|(_, value)| value)),
        _ => {}
    }
}

struct Hydrated {
    value: Json,
    count: u64,
}

impl Reader<'_> {
    fn read(&mut self, digest: &str, bytes: u64) -> Result<Json> {
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
        // Lossy UTF-8 decoding keeps that seam.
        let mut envelope = parse_json(String::from_utf8_lossy(&semantic).as_bytes())
            .map_err(|_| "Invalid public object JSON")?;
        if !string_is(field(&envelope, "artifactKind"), "public-semantic-artifact")
            || integer(field(&envelope, "schemaVersion")) != Some(1)
            || !matches!(field(&envelope, "content"), Some(Json::Object(_)))
        {
            return Err("Public object semantic envelope is invalid".into());
        }
        let full_key = if self.bucket.prefix.is_empty() {
            key
        } else {
            format!("{}/{key}", self.bucket.prefix)
        };
        self.proofs.push(json!({"key":full_key,"digest":digest,"compressedBytes":object.body.len(),"compressedSha256":sha256(&object.body)}));
        Ok(take(&mut envelope, "content").expect("validated public envelope content"))
    }

    fn visit(
        &mut self,
        mut tree: Json,
        ancestors: &BTreeSet<String>,
        depth: usize,
    ) -> Result<Hydrated> {
        if depth > MAX_DEPTH || !matches!(tree, Json::Object(_) | Json::Array(_)) {
            return Err("Invalid public archive tree".into());
        }
        if string_is(field(&tree, "kind"), "inline") {
            let value = take(&mut tree, "value").unwrap_or(Json::Undefined);
            return Ok(Hydrated {
                count: own_key_count(&value),
                value,
            });
        }
        if string_is(field(&tree, "kind"), "record") {
            // Node checks every record entry before it visits the first child.
            let invalid = || "Invalid public archive record".to_string();
            let entries = take(&mut tree, "entries")
                .and_then(into_array)
                .ok_or_else(invalid)?;
            let mut keys = BTreeSet::new();
            let mut children = Vec::with_capacity(entries.len());
            for entry in entries {
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
            // A missing inline value stays an own Undefined property, as in
            // Node, until the final JSON output omits it.
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
        // Node validates every reference before starting the first child request.
        let references = parts.iter().map(reference).collect::<Result<Vec<_>>>()?;
        let mut values = vec![];
        let mut entries = BTreeMap::new();
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
                // Undefined record properties are own keys in Node's hasOwn check.
                for (key, value) in child_entries.drain(..) {
                    if entries.insert(key, value).is_some() {
                        return Err("Public archive duplicate record key".into());
                    }
                }
            }
        }
        Ok(Hydrated {
            count,
            value: if list {
                Json::Array(values)
            } else {
                Json::Object(entries.into_iter().collect())
            },
        })
    }
}

fn reference(value: &Json) -> Result<(String, u64, u64)> {
    if !matches!(field(value, "sha256"), Some(Json::String(_))) {
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
/// Parsed and hydrated objects have unique keys.
fn field<'a>(value: &'a Json, key: &str) -> Option<&'a Json> {
    let Json::Object(entries) = value else {
        return None;
    };
    let key = Utf16String::from(key);
    entries
        .iter()
        .find(|(entry, _)| entry == &key)
        .map(|(_, value)| value)
}
fn take(value: &mut Json, key: &str) -> Option<Json> {
    let Json::Object(entries) = value else {
        return None;
    };
    let key = Utf16String::from(key);
    let index = entries.iter().position(|(entry, _)| entry == &key)?;
    Some(entries.swap_remove(index).1)
}
fn into_array(mut value: Json) -> Option<Vec<Json>> {
    match &mut value {
        Json::Array(values) => Some(std::mem::take(values)),
        _ => None,
    }
}
fn strict_equal(left: Option<&Json>, right: Option<&Json>) -> bool {
    let defined = |value: &&Json| !matches!(value, Json::Undefined);
    match (left.filter(defined), right.filter(defined)) {
        (None, None) | (Some(Json::Null), Some(Json::Null)) => true,
        (Some(Json::Bool(left)), Some(Json::Bool(right))) => left == right,
        (Some(Json::String(left)), Some(Json::String(right))) => left == right,
        (Some(Json::Number(left)), Some(Json::Number(right))) => left == right,
        _ => false,
    }
}
fn required<'a>(value: &'a Json, key: &str) -> Result<&'a Json> {
    field(value, key).ok_or_else(|| format!("Missing public archive {key}"))
}
fn string_is(value: Option<&Json>, text: &str) -> bool {
    matches!(value, Some(Json::String(value)) if value == &Utf16String::from(text))
}
fn integer(value: Option<&Json>) -> Option<u64> {
    let Some(Json::Number(number)) = value else {
        return None;
    };
    (number.is_finite()
        && number.fract() == 0.0
        && (0.0..=MAX_SAFE_INTEGER as f64).contains(number))
    .then_some(*number as u64)
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn truthy(value: &Json) -> bool {
    match value {
        Json::Undefined | Json::Null => false,
        Json::Bool(value) => *value,
        Json::Number(value) => *value != 0.0,
        Json::String(value) => value.code_units().next().is_some(),
        _ => true,
    }
}
fn own_key_count(value: &Json) -> u64 {
    match value {
        Json::Array(values) => values.len() as u64,
        Json::Object(entries) => entries.len() as u64,
        Json::String(value) => value.code_units().count() as u64,
        _ => 0,
    }
}
fn js_number(value: f64) -> String {
    if value.is_infinite() {
        String::from(if value > 0.0 { "Infinity" } else { "-Infinity" })
    } else {
        number_text(value)
    }
}
/// JavaScript String(value). Array.prototype.join flattens nested arrays and
/// prints nested null as empty text.
fn js_text(value: Option<&Json>) -> String {
    match value {
        None | Some(Json::Undefined) => return "undefined".into(),
        Some(Json::Null) => return "null".into(),
        _ => {}
    }
    let mut output = String::new();
    let mut pending = vec![value];
    while let Some(step) = pending.pop() {
        match step {
            None => output.push(','),
            Some(Json::Undefined | Json::Null) => {}
            Some(Json::Bool(value)) => output.push_str(if *value { "true" } else { "false" }),
            Some(Json::Number(value)) => output.push_str(&js_number(*value)),
            Some(Json::String(value)) => {
                output.push_str(&String::from_utf16_lossy(
                    &value.code_units().collect::<Vec<_>>(),
                ));
            }
            Some(Json::Object(_)) => output.push_str("[object Object]"),
            Some(Json::Array(values)) => {
                for (index, value) in values.iter().enumerate().rev() {
                    pending.push(Some(value));
                    if index > 0 {
                        pending.push(None);
                    }
                }
            }
        }
    }
    output
}
fn less_than(left: &Json, right: &Json) -> bool {
    let left = js_text(Some(left));
    let right = js_text(Some(right));
    // Dates are nonnumeric strings. ToPrimitive yields strings for JSON arrays
    // too, so the relational comparison uses UTF-16 ordering.
    Utf16String::from(left.as_str()) < Utf16String::from(right.as_str())
}

/// Canonical JSON.stringify output: sorted UTF-16 keys, Undefined properties
/// omitted, Undefined array elements and nonfinite numbers written as null.
fn write_json(value: &Json, output: &mut String) {
    enum Step<'a> {
        Value(&'a Json),
        Key(&'a Utf16String),
        Text(&'static str),
    }
    let mut pending = vec![Step::Value(value)];
    while let Some(step) = pending.pop() {
        match step {
            Step::Text(text) => output.push_str(text),
            Step::Key(key) => {
                key.write_json(output);
                output.push(':');
            }
            Step::Value(Json::Undefined | Json::Null) => output.push_str("null"),
            Step::Value(Json::Bool(value)) => {
                output.push_str(if *value { "true" } else { "false" })
            }
            Step::Value(Json::Number(value)) => output.push_str(&number_text(*value)),
            Step::Value(Json::String(value)) => value.write_json(output),
            Step::Value(Json::Array(values)) => {
                output.push('[');
                pending.push(Step::Text("]"));
                for (index, value) in values.iter().enumerate().rev() {
                    pending.push(Step::Value(value));
                    if index > 0 {
                        pending.push(Step::Text(","));
                    }
                }
            }
            Step::Value(Json::Object(entries)) => {
                let mut present = entries
                    .iter()
                    .filter(|(_, value)| !matches!(value, Json::Undefined))
                    .collect::<Vec<_>>();
                present.sort_by(|(left, _), (right, _)| left.cmp(right));
                output.push('{');
                pending.push(Step::Text("}"));
                for (index, (key, value)) in present.into_iter().enumerate().rev() {
                    pending.push(Step::Value(value));
                    pending.push(Step::Key(key));
                    if index > 0 {
                        pending.push(Step::Text(","));
                    }
                }
            }
        }
    }
}

/// JSON.parse grammar with an explicit container stack. The canonical raw and
/// state parser keeps its own 128-level input bound.
fn parse_json(bytes: &[u8]) -> Result<Json> {
    enum Open {
        Array(Vec<Json>),
        // The last entry holds the key whose value is being parsed.
        Object(Vec<(Utf16String, Json)>),
    }
    let mut parser = Parser { bytes, offset: 0 };
    let mut open = Vec::new();
    loop {
        parser.whitespace();
        let mut value = match bytes.get(parser.offset) {
            Some(b'[') => {
                parser.offset += 1;
                if !parser.take(b']') {
                    open.push(Open::Array(Vec::new()));
                    continue;
                }
                Json::Array(Vec::new())
            }
            Some(b'{') => {
                parser.offset += 1;
                if !parser.take(b'}') {
                    open.push(Open::Object(vec![(parser.key()?, Json::Undefined)]));
                    continue;
                }
                Json::Object(Vec::new())
            }
            _ => parser.scalar()?,
        };
        loop {
            let Some(container) = open.last_mut() else {
                parser.whitespace();
                if parser.offset != bytes.len() {
                    return Err("Invalid public JSON".into());
                }
                return Ok(value);
            };
            match container {
                Open::Array(values) => {
                    values.push(value);
                    if parser.take(b',') {
                        break;
                    }
                    parser.expect(b']')?;
                    value = Json::Array(std::mem::take(values));
                }
                Open::Object(entries) => {
                    entries.last_mut().expect("pending object key").1 = value;
                    if parser.take(b',') {
                        entries.push((parser.key()?, Json::Undefined));
                        break;
                    }
                    parser.expect(b'}')?;
                    // JSON.parse keeps the last value for a repeated key.
                    let mut unique = BTreeMap::new();
                    for (key, entry) in std::mem::take(entries) {
                        unique.insert(key, entry);
                    }
                    value = Json::Object(unique.into_iter().collect());
                }
            }
            open.pop();
        }
    }
}

struct Parser<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl Parser<'_> {
    fn whitespace(&mut self) {
        while self
            .bytes
            .get(self.offset)
            .is_some_and(|byte| b" \t\r\n".contains(byte))
        {
            self.offset += 1;
        }
    }

    fn take(&mut self, byte: u8) -> bool {
        self.whitespace();
        if self.bytes.get(self.offset) == Some(&byte) {
            self.offset += 1;
            true
        } else {
            false
        }
    }

    fn expect(&mut self, byte: u8) -> Result<()> {
        if self.take(byte) {
            Ok(())
        } else {
            Err("Invalid public JSON".into())
        }
    }

    fn key(&mut self) -> Result<Utf16String> {
        self.whitespace();
        let key = self.string()?;
        self.expect(b':')?;
        Ok(key)
    }

    fn scalar(&mut self) -> Result<Json> {
        match self.bytes.get(self.offset) {
            Some(b'"') => Ok(Json::String(self.string()?)),
            Some(b'n') => self.literal(b"null", Json::Null),
            Some(b't') => self.literal(b"true", Json::Bool(true)),
            Some(b'f') => self.literal(b"false", Json::Bool(false)),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err("Invalid public JSON".into()),
        }
    }

    fn literal(&mut self, token: &[u8], value: Json) -> Result<Json> {
        if !self.bytes[self.offset..].starts_with(token) {
            return Err("Invalid public JSON literal".into());
        }
        self.offset += token.len();
        Ok(value)
    }

    fn string(&mut self) -> Result<Utf16String> {
        let start = self.offset;
        if self.bytes.get(start) != Some(&b'"') {
            return Err("Invalid public JSON string".into());
        }
        self.offset += 1;
        while let Some(byte) = self.bytes.get(self.offset) {
            self.offset += 1;
            if *byte == b'\\' {
                if self.bytes.get(self.offset).is_none() {
                    break;
                }
                self.offset += 1;
            } else if *byte == b'"' {
                // serde_json's string grammar keeps unpaired UTF-16 escapes.
                return serde_json::from_slice(&self.bytes[start..self.offset])
                    .map_err(|error| error.to_string());
            }
        }
        Err("Unterminated public JSON string".into())
    }

    fn number(&mut self) -> Result<Json> {
        let start = self.offset;
        while self
            .bytes
            .get(self.offset)
            .is_some_and(|byte| !b",]} \t\r\n".contains(byte))
        {
            self.offset += 1;
        }
        let token = &self.bytes[start..self.offset];
        // serde_json checks the number grammar without a range limit. Rust then
        // rounds to binary64 like JSON.parse and overflows to infinity.
        serde_json::from_slice::<IgnoredAny>(token).map_err(|_| "Invalid public JSON number")?;
        std::str::from_utf8(token)
            .ok()
            .and_then(|text| text.parse::<f64>().ok())
            .map(Json::Number)
            .ok_or_else(|| "Invalid public JSON number".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(text: &str) -> String {
        let mut output = String::new();
        write_json(&parse_json(text.as_bytes()).unwrap(), &mut output);
        output
    }

    #[test]
    fn public_json_follows_json_parse_numbers_keys_and_grammar() {
        assert_eq!(
            output(" { \"z\" : 1.0, \"\\ud800\" : \"\\uDFFF\", \"z\" : 2e0 } \n"),
            "{\"z\":2,\"\\ud800\":\"\\udfff\"}"
        );
        assert_eq!(
            output("[1e400,-1e400,-0,0.1,9007199254740993,1e-400]"),
            "[null,null,0,0.1,9007199254740992,0]"
        );
        let parsed = parse_json(b"[1e400,-1e400]").unwrap();
        let Json::Array(values) = &parsed else {
            panic!("expected array")
        };
        assert!(matches!(values[0], Json::Number(value) if value == f64::INFINITY));
        assert!(matches!(values[1], Json::Number(value) if value == f64::NEG_INFINITY));
        assert_eq!(js_text(Some(&values[1])), "-Infinity");
        assert!(truthy(&values[0]) && integer(Some(&values[0])).is_none());
        assert!(strict_equal(Some(&values[0]), Some(&values[0])));
        for invalid in [
            "{\"a\":1,}",
            "[1,]",
            "01",
            "1.",
            ".5",
            "+1",
            "-",
            "1e",
            "1e+",
            "NaN",
            "Infinity",
            "true false",
            "\"unclosed",
            "[1 2]",
            "{\"a\" 1}",
            "{1:2}",
            "[",
            "\u{feff}1",
            "",
        ] {
            assert!(parse_json(invalid.as_bytes()).is_err(), "{invalid}");
        }
    }

    #[test]
    fn deep_public_json_parses_writes_coerces_and_drops_without_recursion() {
        let depth = 200_000;
        let text = format!("{}0{}", "[".repeat(depth), "]".repeat(depth));
        let value = parse_json(text.as_bytes()).unwrap();
        let mut written = String::new();
        write_json(&value, &mut written);
        assert_eq!(written, text);
        assert_eq!(js_text(Some(&value)), "0");
        drop(value);
        let objects = format!("{}1{}", "{\"a\":".repeat(depth), "}".repeat(depth));
        assert!(parse_json(objects.as_bytes()).is_ok());
        let unclosed = format!("{}1", "[".repeat(depth));
        assert!(parse_json(unclosed.as_bytes()).is_err());
    }

    #[test]
    fn undefined_properties_are_omitted_and_array_elements_become_null() {
        let value = Json::Object(vec![
            ("b".into(), Json::Undefined),
            (
                "a".into(),
                Json::Array(vec![Json::Undefined, Json::Number(1.0)]),
            ),
        ]);
        let mut written = String::new();
        write_json(&value, &mut written);
        assert_eq!(written, "{\"a\":[null,1]}");
        assert_eq!(own_key_count(&value), 2);
    }
}
