use crate::{Result, Utf16String, number_text};
use serde::de::IgnoredAny;
use std::collections::BTreeMap;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(super) enum Json {
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

impl Clone for Json {
    fn clone(&self) -> Self {
        enum Step<'a> {
            Value(&'a Json),
            Array(usize),
            Object(Vec<Utf16String>),
        }
        let mut pending = vec![Step::Value(self)];
        let mut values = Vec::new();
        while let Some(step) = pending.pop() {
            match step {
                Step::Value(Json::Undefined) => values.push(Json::Undefined),
                Step::Value(Json::Null) => values.push(Json::Null),
                Step::Value(Json::Bool(value)) => values.push(Json::Bool(*value)),
                Step::Value(Json::Number(value)) => values.push(Json::Number(*value)),
                Step::Value(Json::String(value)) => values.push(Json::String(value.clone())),
                Step::Value(Json::Array(items)) => {
                    pending.push(Step::Array(items.len()));
                    pending.extend(items.iter().rev().map(Step::Value));
                }
                Step::Value(Json::Object(entries)) => {
                    pending.push(Step::Object(
                        entries.iter().map(|(key, _)| key.clone()).collect(),
                    ));
                    pending.extend(entries.iter().rev().map(|(_, value)| Step::Value(value)));
                }
                Step::Array(count) => {
                    let children = values.split_off(values.len() - count);
                    values.push(Json::Array(children));
                }
                Step::Object(keys) => {
                    let children = values.split_off(values.len() - keys.len());
                    values.push(Json::Object(keys.into_iter().zip(children).collect()));
                }
            }
        }
        values.pop().expect("one cloned public JSON root")
    }
}

fn take_children(value: &mut Json, pending: &mut Vec<Json>) {
    match value {
        Json::Array(values) => pending.append(values),
        Json::Object(entries) => pending.extend(entries.drain(..).map(|(_, value)| value)),
        _ => {}
    }
}

pub(super) fn field<'a>(value: &'a Json, key: &str) -> Option<&'a Json> {
    let Json::Object(entries) = value else {
        return None;
    };
    let key = Utf16String::from(key);
    entries
        .iter()
        .find(|(entry, _)| entry == &key)
        .map(|(_, value)| value)
}
pub(super) fn take(value: &mut Json, key: &str) -> Option<Json> {
    let Json::Object(entries) = value else {
        return None;
    };
    let key = Utf16String::from(key);
    let index = entries.iter().position(|(entry, _)| entry == &key)?;
    Some(entries.swap_remove(index).1)
}
pub(super) fn into_array(mut value: Json) -> Option<Vec<Json>> {
    match &mut value {
        Json::Array(values) => Some(std::mem::take(values)),
        _ => None,
    }
}
pub(super) fn strict_equal(left: Option<&Json>, right: Option<&Json>) -> bool {
    let defined = |value: &&Json| !matches!(value, Json::Undefined);
    match (left.filter(defined), right.filter(defined)) {
        (None, None) | (Some(Json::Null), Some(Json::Null)) => true,
        (Some(Json::Bool(left)), Some(Json::Bool(right))) => left == right,
        (Some(Json::String(left)), Some(Json::String(right))) => left == right,
        (Some(Json::Number(left)), Some(Json::Number(right))) => left == right,
        _ => false,
    }
}
pub(super) fn required<'a>(value: &'a Json, key: &str) -> Result<&'a Json> {
    field(value, key).ok_or_else(|| format!("Missing public archive {key}"))
}
pub(super) fn string_is(value: Option<&Json>, text: &str) -> bool {
    matches!(value, Some(Json::String(value)) if value == &Utf16String::from(text))
}
pub(super) fn integer(value: Option<&Json>) -> Option<u64> {
    let Some(Json::Number(number)) = value else {
        return None;
    };
    (number.is_finite()
        && number.fract() == 0.0
        && (0.0..=MAX_SAFE_INTEGER as f64).contains(number))
    .then_some(*number as u64)
}
pub(super) fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
pub(super) fn truthy(value: &Json) -> bool {
    match value {
        Json::Undefined | Json::Null => false,
        Json::Bool(value) => *value,
        Json::Number(value) => *value != 0.0,
        Json::String(value) => value.code_units().next().is_some(),
        _ => true,
    }
}
pub(super) fn own_key_count(value: &Json) -> u64 {
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
pub(super) fn js_text(value: Option<&Json>) -> String {
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
pub(super) fn less_than(left: &Json, right: &Json) -> bool {
    let left = js_text(Some(left));
    let right = js_text(Some(right));
    // Dates are nonnumeric strings. ToPrimitive yields strings for JSON arrays
    // too, so the relational comparison uses UTF-16 ordering.
    Utf16String::from(left.as_str()) < Utf16String::from(right.as_str())
}

/// Canonical JSON.stringify output: sorted UTF-16 keys, Undefined properties
/// omitted, Undefined array elements and nonfinite numbers written as null.
pub(super) fn write_json(value: &Json, output: &mut String) {
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

pub(super) fn parse_json(bytes: &[u8]) -> Result<Json> {
    enum Open {
        Array(Vec<Json>),
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
                    // JSON.parse replaces duplicate values without moving the
                    // first property. Alias selection depends on this order;
                    // canonical output sorts keys separately in write_json.
                    let mut positions = BTreeMap::<Utf16String, usize>::new();
                    let mut unique: Vec<(Utf16String, Json)> = Vec::with_capacity(entries.len());
                    for (key, entry) in std::mem::take(entries) {
                        if let Some(index) = positions.get(&key) {
                            unique[*index].1 = entry;
                        } else {
                            positions.insert(key.clone(), unique.len());
                            unique.push((key, entry));
                        }
                    }
                    value = Json::Object(unique);
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
            if *byte < 0x20 {
                return Err("Invalid public JSON string".into());
            } else if *byte == b'\\' {
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
    fn public_json_rejects_raw_controls_in_string_keys_and_values() {
        for byte in 0u8..0x20 {
            let control = char::from(byte);
            for text in [
                format!(r#"{{"key":"before{control}after"}}"#),
                format!(r#"{{"before{control}after":1}}"#),
            ] {
                assert!(parse_json(text.as_bytes()).is_err(), "{text:?}");
            }
        }
    }

    #[test]
    fn public_json_preserves_escaped_controls_and_valid_noncontrols() {
        for byte in 0u8..0x20 {
            let text = format!(r#"{{"\u{byte:04x}":"\u{byte:04x}"}}"#);
            let parsed = parse_json(text.as_bytes()).unwrap();
            let Json::Object(entries) = &parsed else {
                panic!("expected object")
            };
            let expected = Utf16String::from(char::from(byte).to_string().as_str());
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].0, expected);
            assert!(matches!(&entries[0].1, Json::String(value) if value == &expected));
        }
        for text in [
            r#"{"\b\t\n\f\r":"\b\t\n\f\r"}"#,
            "{\"\u{7f}\u{2028}\":\"\u{7f}\u{2028}\"}",
        ] {
            assert_eq!(output(text), text);
        }
    }

    #[test]
    fn deep_public_json_parses_writes_coerces_and_drops_without_recursion() {
        let depth = 200_000;
        let text = format!("{}0{}", "[".repeat(depth), "]".repeat(depth));
        let value = parse_json(text.as_bytes()).unwrap();
        let cloned = value.clone();
        let mut written = String::new();
        write_json(&cloned, &mut written);
        assert_eq!(written, text);
        assert_eq!(js_text(Some(&value)), "0");
        drop(cloned);
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
