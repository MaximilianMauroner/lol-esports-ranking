use crate::{Result, number_text};
use serde::{Deserialize, Deserializer, de};
use serde_json::Number;
use std::{fmt, fmt::Write, vec};

/// JavaScript strings are UTF-16 code units, including unpaired surrogates.
/// Rust String cannot represent all valid stored JSON string values.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Utf16String(Vec<u16>);

impl Utf16String {
    pub fn code_units(&self) -> impl Iterator<Item = u16> + '_ {
        self.0.iter().copied()
    }

    fn json(&self) -> String {
        let mut output = String::new();
        self.write_json(&mut output);
        output
    }

    pub fn write_json(&self, output: &mut String) {
        output.push('"');
        for decoded in char::decode_utf16(self.code_units()) {
            match decoded {
                Ok('"') => output.push_str("\\\""),
                Ok('\\') => output.push_str("\\\\"),
                Ok('\u{0008}') => output.push_str("\\b"),
                Ok('\t') => output.push_str("\\t"),
                Ok('\n') => output.push_str("\\n"),
                Ok('\u{000c}') => output.push_str("\\f"),
                Ok('\r') => output.push_str("\\r"),
                Ok(character) if character <= '\u{001f}' => {
                    write!(output, "\\u{:04x}", u32::from(character)).unwrap();
                }
                Ok(character) => output.push(character),
                Err(error) => {
                    write!(output, "\\u{:04x}", error.unpaired_surrogate()).unwrap();
                }
            }
        }
        output.push('"');
    }

    fn from_wtf8(mut bytes: &[u8]) -> Result<Self> {
        // serde_json's byte-string parser emits WTF-8 for lone surrogates.
        // Decode only those three-byte sequences in otherwise valid UTF-8.
        let mut units = Vec::new();
        while !bytes.is_empty() {
            match std::str::from_utf8(bytes) {
                Ok(text) => {
                    units.extend(text.encode_utf16());
                    break;
                }
                Err(error) => {
                    let (valid, rest) = bytes.split_at(error.valid_up_to());
                    units.extend(std::str::from_utf8(valid).unwrap().encode_utf16());
                    if rest.len() < 3
                        || rest[0] != 0xed
                        || !(0xa0..=0xbf).contains(&rest[1])
                        || !(0x80..=0xbf).contains(&rest[2])
                    {
                        return Err("Invalid UTF-16 JSON string".into());
                    }
                    units.push(
                        (u16::from(rest[0] & 0x0f) << 12)
                            | (u16::from(rest[1] & 0x3f) << 6)
                            | u16::from(rest[2] & 0x3f),
                    );
                    bytes = &rest[3..];
                }
            }
        }
        Ok(Self(units))
    }

    fn wtf8(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        for decoded in char::decode_utf16(self.code_units()) {
            match decoded {
                Ok(character) => {
                    bytes.extend_from_slice(character.encode_utf8(&mut [0; 4]).as_bytes());
                }
                Err(error) => {
                    let unit = error.unpaired_surrogate();
                    bytes.extend_from_slice(&[
                        0xe0 | ((unit >> 12) as u8),
                        0x80 | (((unit >> 6) & 0x3f) as u8),
                        0x80 | ((unit & 0x3f) as u8),
                    ]);
                }
            }
        }
        bytes
    }
}

impl From<&str> for Utf16String {
    fn from(value: &str) -> Self {
        Self(value.encode_utf16().collect())
    }
}

impl<'de> Deserialize<'de> for Utf16String {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct StringVisitor;
        impl de::Visitor<'_> for StringVisitor {
            type Value = Utf16String;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a JSON string")
            }

            fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<Self::Value, E> {
                Ok(Utf16String::from(value))
            }

            fn visit_bytes<E: de::Error>(
                self,
                bytes: &[u8],
            ) -> std::result::Result<Self::Value, E> {
                Utf16String::from_wtf8(bytes).map_err(E::custom)
            }
        }
        deserializer.deserialize_bytes(StringVisitor)
    }
}

/// Local JSON representation. It does not alter serde_json's ordinary Value
/// parser or give any object key special meaning.
#[derive(Debug, PartialEq)]
pub enum Utf16Json {
    Null,
    Bool(bool),
    Number(Number),
    String(Utf16String),
    Array(Vec<Self>),
    Object(Vec<(Utf16String, Self)>),
}

impl Utf16Json {
    pub fn is_object(&self) -> bool {
        matches!(self, Self::Object(_))
    }

    #[cfg(test)]
    fn canonical_json(&self) -> String {
        let mut output = String::new();
        self.write_canonical(&mut output);
        output
    }

    pub fn write_canonical(&self, output: &mut String) {
        match self {
            Self::Null => output.push_str("null"),
            Self::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
            Self::Number(value) => output.push_str(&number_text(value.as_f64().unwrap())),
            Self::String(value) => value.write_json(output),
            Self::Array(values) => {
                output.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    value.write_canonical(output);
                }
                output.push(']');
            }
            Self::Object(entries) => {
                let mut sorted = entries.iter().collect::<Vec<_>>();
                sorted.sort_by(|(left, _), (right, _)| left.cmp(right));
                output.push('{');
                for (index, (key, value)) in sorted.into_iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    key.write_json(output);
                    output.push(':');
                    value.write_canonical(output);
                }
                output.push('}');
            }
        }
    }
}

/// Parse canonical Node JSON with the existing 128-level input bound. String and
/// number tokens use serde_json's established grammar; containers stay local.
pub fn parse_canonical_utf16_json(bytes: &[u8]) -> Result<Utf16Json> {
    parse_utf16(bytes, true)
}

/// Lossless public JSON decoding. Canonical raw/state readers retain their
/// stricter parser; public envelopes allow whitespace, escapes and duplicate keys.
pub fn parse_utf16_json(bytes: &[u8]) -> Result<Utf16Json> {
    parse_utf16(bytes, false)
}

fn parse_utf16(bytes: &[u8], canonical: bool) -> Result<Utf16Json> {
    std::str::from_utf8(bytes).map_err(|_| "Invalid canonical JSON UTF-8")?;
    let mut parser = Parser {
        bytes,
        offset: 0,
        canonical,
    };
    let value = parser.value(0)?;
    parser.whitespace();
    if parser.offset != bytes.len() {
        return Err("JSON is not canonical".into());
    }
    Ok(value)
}

struct Parser<'a> {
    bytes: &'a [u8],
    offset: usize,
    canonical: bool,
}

impl Parser<'_> {
    fn whitespace(&mut self) {
        if !self.canonical {
            while self
                .bytes
                .get(self.offset)
                .is_some_and(|byte| b" \t\r\n".contains(byte))
            {
                self.offset += 1;
            }
        }
    }

    fn value(&mut self, depth: usize) -> Result<Utf16Json> {
        self.whitespace();
        if depth >= 128 {
            return Err("JSON recursion limit exceeded".into());
        }
        match self.bytes.get(self.offset) {
            Some(b'"') => Ok(Utf16Json::String(self.string()?)),
            Some(b'[') => self.array(depth),
            Some(b'{') => self.object(depth),
            Some(b'n') => self.literal(b"null", Utf16Json::Null),
            Some(b't') => self.literal(b"true", Utf16Json::Bool(true)),
            Some(b'f') => self.literal(b"false", Utf16Json::Bool(false)),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err("JSON is not canonical".into()),
        }
    }

    fn literal(&mut self, token: &[u8], value: Utf16Json) -> Result<Utf16Json> {
        if !self.bytes[self.offset..].starts_with(token) {
            return Err("Invalid JSON literal".into());
        }
        self.offset += token.len();
        Ok(value)
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
            Err("JSON is not canonical".into())
        }
    }

    fn string(&mut self) -> Result<Utf16String> {
        self.whitespace();
        let start = self.offset;
        self.expect(b'"')?;
        while let Some(byte) = self.bytes.get(self.offset) {
            self.offset += 1;
            if *byte == b'\\' {
                if self.bytes.get(self.offset).is_none() {
                    break;
                }
                self.offset += 1;
            } else if *byte == b'"' {
                let token = &self.bytes[start..self.offset];
                let string: Utf16String =
                    serde_json::from_slice(token).map_err(|error| error.to_string())?;
                if self.canonical && string.json().as_bytes() != token {
                    return Err("JSON string is not canonical".into());
                }
                return Ok(string);
            }
        }
        Err("Unterminated JSON string".into())
    }

    fn number(&mut self) -> Result<Utf16Json> {
        let start = self.offset;
        while self
            .bytes
            .get(self.offset)
            .is_some_and(|byte| !b",]} \t\r\n".contains(byte))
        {
            self.offset += 1;
        }
        let token = &self.bytes[start..self.offset];
        let number: Number = serde_json::from_slice(token).map_err(|error| error.to_string())?;
        if self.canonical
            && number_text(number.as_f64().ok_or("Invalid JSON number")?).as_bytes() != token
        {
            return Err("JSON number is not canonical".into());
        }
        Ok(Utf16Json::Number(number))
    }

    fn array(&mut self, depth: usize) -> Result<Utf16Json> {
        self.expect(b'[')?;
        let mut values = Vec::new();
        if !self.take(b']') {
            loop {
                values.push(self.value(depth + 1)?);
                if self.take(b']') {
                    break;
                }
                self.expect(b',')?;
            }
        }
        Ok(Utf16Json::Array(values))
    }

    fn object(&mut self, depth: usize) -> Result<Utf16Json> {
        self.expect(b'{')?;
        let mut entries: Vec<(Utf16String, Utf16Json)> = Vec::new();
        if !self.take(b'}') {
            loop {
                let key = self.string()?;
                if self.canonical && entries.last().is_some_and(|(previous, _)| previous >= &key) {
                    return Err("JSON keys are not unique and canonical".into());
                }
                self.expect(b':')?;
                entries.push((key, self.value(depth + 1)?));
                if self.take(b'}') {
                    break;
                }
                self.expect(b',')?;
            }
        }
        Ok(Utf16Json::Object(entries))
    }
}

// Deserialize the local tree into the existing receipt schema. This keeps
// serde's required fields, unknown-field rejection and integral range checks.
impl<'de> de::Deserializer<'de> for Utf16Json {
    type Error = de::value::Error;

    fn deserialize_any<V: de::Visitor<'de>>(
        self,
        visitor: V,
    ) -> std::result::Result<V::Value, Self::Error> {
        match self {
            Self::Null => visitor.visit_unit(),
            Self::Bool(value) => visitor.visit_bool(value),
            Self::Number(value) => {
                if let Some(number) = value.as_u64() {
                    visitor.visit_u64(number)
                } else if let Some(number) = value.as_i64() {
                    visitor.visit_i64(number)
                } else {
                    visitor.visit_f64(value.as_f64().unwrap())
                }
            }
            Self::String(value) => match String::from_utf16(&value.0) {
                Ok(text) => visitor.visit_string(text),
                Err(_) => visitor.visit_byte_buf(value.wtf8()),
            },
            Self::Array(values) => visitor.visit_seq(ArrayAccess(values.into_iter())),
            Self::Object(entries) => visitor.visit_map(ObjectAccess {
                entries: entries.into_iter(),
                value: None,
            }),
        }
    }

    fn deserialize_bytes<V: de::Visitor<'de>>(
        self,
        visitor: V,
    ) -> std::result::Result<V::Value, Self::Error> {
        match self {
            Self::String(value) => visitor.visit_byte_buf(value.wtf8()),
            _ => Err(de::Error::custom("Expected a JSON string")),
        }
    }

    fn deserialize_option<V: de::Visitor<'de>>(
        self,
        visitor: V,
    ) -> std::result::Result<V::Value, Self::Error> {
        match self {
            Self::Null => visitor.visit_none(),
            value => visitor.visit_some(value),
        }
    }

    fn deserialize_newtype_struct<V: de::Visitor<'de>>(
        self,
        _name: &'static str,
        visitor: V,
    ) -> std::result::Result<V::Value, Self::Error> {
        visitor.visit_newtype_struct(self)
    }

    fn deserialize_struct<V: de::Visitor<'de>>(
        self,
        _name: &'static str,
        _fields: &'static [&'static str],
        visitor: V,
    ) -> std::result::Result<V::Value, Self::Error> {
        match self {
            Self::Object(entries) => visitor.visit_map(ObjectAccess {
                entries: entries.into_iter(),
                value: None,
            }),
            _ => Err(de::Error::custom("Expected a JSON schema record")),
        }
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
        byte_buf unit unit_struct seq tuple tuple_struct map enum identifier ignored_any
    }
}

struct ArrayAccess(vec::IntoIter<Utf16Json>);

impl<'de> de::SeqAccess<'de> for ArrayAccess {
    type Error = de::value::Error;
    fn next_element_seed<T: de::DeserializeSeed<'de>>(
        &mut self,
        seed: T,
    ) -> std::result::Result<Option<T::Value>, Self::Error> {
        self.0
            .next()
            .map(|value| seed.deserialize(value))
            .transpose()
    }
}

struct ObjectAccess {
    entries: vec::IntoIter<(Utf16String, Utf16Json)>,
    value: Option<Utf16Json>,
}

impl<'de> de::MapAccess<'de> for ObjectAccess {
    type Error = de::value::Error;

    fn next_key_seed<K: de::DeserializeSeed<'de>>(
        &mut self,
        seed: K,
    ) -> std::result::Result<Option<K::Value>, Self::Error> {
        let Some((key, value)) = self.entries.next() else {
            return Ok(None);
        };
        self.value = Some(value);
        seed.deserialize(Utf16Json::String(key)).map(Some)
    }

    fn next_value_seed<V: de::DeserializeSeed<'de>>(
        &mut self,
        seed: V,
    ) -> std::result::Result<V::Value, Self::Error> {
        seed.deserialize(
            self.value
                .take()
                .ok_or_else(|| <Self::Error as de::Error>::custom("Missing JSON map value"))?,
        )
    }
}

impl<'de> Deserialize<'de> for Utf16Json {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct JsonVisitor;
        impl<'de> de::Visitor<'de> for JsonVisitor {
            type Value = Utf16Json;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a JSON value")
            }
            fn visit_unit<E: de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(Utf16Json::Null)
            }
            fn visit_bool<E: de::Error>(self, value: bool) -> std::result::Result<Self::Value, E> {
                Ok(Utf16Json::Bool(value))
            }
            fn visit_u64<E: de::Error>(self, value: u64) -> std::result::Result<Self::Value, E> {
                Ok(Utf16Json::Number(value.into()))
            }
            fn visit_i64<E: de::Error>(self, value: i64) -> std::result::Result<Self::Value, E> {
                Ok(Utf16Json::Number(value.into()))
            }
            fn visit_f64<E: de::Error>(self, value: f64) -> std::result::Result<Self::Value, E> {
                Number::from_f64(value)
                    .map(Utf16Json::Number)
                    .ok_or_else(|| E::custom("Non-finite JSON number"))
            }
            fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<Self::Value, E> {
                Ok(Utf16Json::String(value.into()))
            }
            fn visit_bytes<E: de::Error>(
                self,
                value: &[u8],
            ) -> std::result::Result<Self::Value, E> {
                Utf16String::from_wtf8(value)
                    .map(Utf16Json::String)
                    .map_err(E::custom)
            }
            fn visit_seq<A: de::SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element()? {
                    values.push(value);
                }
                Ok(Utf16Json::Array(values))
            }
            fn visit_map<M: de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> std::result::Result<Self::Value, M::Error> {
                let mut entries = Vec::new();
                while let Some(entry) = map.next_entry()? {
                    entries.push(entry);
                }
                Ok(Utf16Json::Object(entries))
            }
        }
        deserializer.deserialize_any(JsonVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_json_keeps_noncanonical_utf16_and_duplicate_keys() {
        let text = " { \"z\" : 1.0, \"\\ud800\" : \"\\uDFFF\", \"z\" : 2e0 } \n";
        let parsed = parse_utf16_json(text.as_bytes()).unwrap();
        let Utf16Json::Object(entries) = parsed else {
            panic!("expected object")
        };
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[1].0.code_units().collect::<Vec<_>>(), vec![0xd800]);
        assert!(parse_canonical_utf16_json(text.as_bytes()).is_err());
        for invalid in [
            "{\"a\":1,}",
            "[1,]",
            "01",
            "true false",
            "\"unclosed",
            "[1 2]",
        ] {
            assert!(parse_utf16_json(invalid.as_bytes()).is_err(), "{invalid}");
        }
    }

    #[test]
    fn unpaired_code_units_and_keys_are_lossless() {
        let text = r#"{"inputs":{"astral":"😀","high":"\ud800","literal":"\\ud800","low":"\udc00","sequence":"\ud800x\udc00\ud800","\ud800":{"\udc00":"\udfff"},"\udc00":"last"}}"#;
        let parsed = parse_canonical_utf16_json(text.as_bytes()).unwrap();
        assert_eq!(parsed.canonical_json(), text);
        assert_eq!(
            Utf16Json::deserialize(parsed).unwrap().canonical_json(),
            text
        );
        let high: Utf16String = serde_json::from_str(r#""\ud800""#).unwrap();
        let low: Utf16String = serde_json::from_str(r#""\udc00""#).unwrap();
        assert_eq!(high.0, vec![0xd800]);
        assert_eq!(low.0, vec![0xdc00]);
        assert_ne!(high, Utf16String::from("�"));
        assert_ne!(high, Utf16String::from("\\ud800"));
    }

    #[test]
    fn canonical_keys_use_utf16_order_and_keep_pairs_distinct() {
        let value = Utf16Json::Object(vec![
            ("\u{e000}".into(), Utf16Json::Number(0.into())),
            (Utf16String(vec![0xdc00]), Utf16Json::Number(1.into())),
            ("😀".into(), Utf16Json::Number(2.into())),
            (Utf16String(vec![0xd800]), Utf16Json::Number(3.into())),
        ]);
        let canonical = value.canonical_json();
        assert_eq!(
            canonical,
            "{\"\\ud800\":3,\"😀\":2,\"\\udc00\":1,\"\u{e000}\":0}"
        );
        assert!(parse_canonical_utf16_json(canonical.as_bytes()).is_ok());
    }

    #[test]
    fn ordinary_reserved_looking_keys_keep_their_object_meaning() {
        let text = r#"{"$serde_json::private::RawValue":"null"}"#;
        let value = parse_canonical_utf16_json(text.as_bytes()).unwrap();
        assert!(value.is_object());
        assert_eq!(value.canonical_json(), text);
        let ordinary: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(ordinary["$serde_json::private::RawValue"], "null");
        assert!(ordinary.is_object());
    }

    #[test]
    fn lossless_parsing_does_not_weaken_canonical_integrity() {
        for text in [
            r#"{"a":"\uD800"}"#,
            r#"{"a":"\ud83d\ude00"}"#,
            r#"{"a":"\u0061"}"#,
            r#"{"a":-0}"#,
            r#"{"a":1.0}"#,
            r#"{"a":1,"a":2}"#,
            r#"{"\ud800":1,"\ud800":2}"#,
            r#"{"b":1,"a":2}"#,
            "{\"a\": 1}",
            r#"{"a":"\ud80g"}"#,
            r#"{"a":[1,]}"#,
        ] {
            assert!(
                parse_canonical_utf16_json(text.as_bytes()).is_err(),
                "{text}"
            );
        }
        assert!(parse_canonical_utf16_json(b"{\"a\":\"\xed\xa0\x80\"}").is_err());
    }

    #[test]
    fn typed_local_decode_retains_integral_range_and_unknown_field_checks() {
        #[derive(Debug, Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Schema {
            schema: u32,
            bytes: u64,
        }
        let valid =
            parse_canonical_utf16_json(br#"{"bytes":9007199254740991,"schema":1}"#).unwrap();
        let parsed = Schema::deserialize(valid).unwrap();
        assert_eq!(parsed.bytes, 9_007_199_254_740_991);
        assert_eq!(parsed.schema, 1);
        for text in [
            r#"{"bytes":1.5,"schema":1}"#,
            r#"{"bytes":-1,"schema":1}"#,
            r#"{"bytes":1,"schema":4294967296}"#,
            r#"{"bytes":1,"extra":true,"schema":1}"#,
            r#"{"bytes":1}"#,
            "[1,1]",
            "[1,1,true]",
        ] {
            let parsed = parse_canonical_utf16_json(text.as_bytes()).unwrap();
            assert!(Schema::deserialize(parsed).is_err(), "{text}");
        }
    }
}
