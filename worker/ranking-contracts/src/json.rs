use crate::{Result, compare_code_units, number_text};

/// Insertion order is kept until a contract explicitly sorts it.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Value>),
    Object(Vec<(String, Value)>),
    Map(Vec<(Value, Value)>),
    Set(Vec<Value>),
    Undefined,
}

impl From<&serde_json::Value> for Value {
    fn from(value: &serde_json::Value) -> Self {
        match value {
            serde_json::Value::Null => Self::Null,
            serde_json::Value::Bool(v) => Self::Bool(*v),
            serde_json::Value::Number(v) => {
                Self::Number(v.as_f64().expect("JSON number is binary64"))
            }
            serde_json::Value::String(v) => Self::String(v.clone()),
            serde_json::Value::Array(v) => Self::Array(v.iter().map(Self::from).collect()),
            serde_json::Value::Object(v) => {
                Self::Object(v.iter().map(|(k, v)| (k.clone(), Self::from(v))).collect())
            }
        }
    }
}

pub fn canonical_json(value: &Value) -> Result<String> {
    serialize(value, Mode::Canonical)
}
pub fn stable_json(value: &Value) -> Result<String> {
    serialize(value, Mode::Stable)
}
pub fn js_json(value: &Value) -> Result<String> {
    serialize(value, Mode::Insertion)
}

pub fn stable_digest(value: &Value) -> Result<String> {
    let text = stable_json(value)?;
    let hash = text
        .encode_utf16()
        .fold(0xcbf29ce484222325u64, |hash, unit| {
            (hash ^ u64::from(unit)).wrapping_mul(0x100000001b3)
        });
    Ok(format!("fnv1a64-{hash:016x}"))
}

pub fn config_hash(value: &Value) -> Result<String> {
    let text = canonical_json(value)?;
    let hash = text.encode_utf16().fold(0x811c9dc5u32, |hash, unit| {
        (hash ^ u32::from(unit)).wrapping_mul(0x01000193)
    });
    Ok(format!("fnv1a-{hash:08x}"))
}

#[derive(Clone, Copy)]
enum Mode {
    Canonical,
    Stable,
    Insertion,
}

fn serialize(value: &Value, mode: Mode) -> Result<String> {
    match value {
        Value::Null => Ok("null".into()),
        Value::Undefined => {
            if matches!(mode, Mode::Stable) {
                Err("undefined has no root JSON value".into())
            } else {
                Ok("null".into())
            }
        }
        Value::Bool(value) => Ok(value.to_string()),
        Value::Number(value) => {
            if matches!(mode, Mode::Stable) && !value.is_finite() {
                return Err("Canonical ranking input cannot contain non-finite numbers".into());
            }
            Ok(number_text(*value))
        }
        Value::String(value) => serde_json::to_string(value).map_err(|error| error.to_string()),
        Value::Array(values) => {
            let items = values
                .iter()
                .map(|value| {
                    if matches!(mode, Mode::Stable) && matches!(value, Value::Undefined) {
                        Ok(String::new())
                    } else {
                        serialize(value, mode)
                    }
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(format!("[{}]", items.join(",")))
        }
        Value::Object(values) => {
            let mut entries = values
                .iter()
                .filter(|(_, value)| !matches!(value, Value::Undefined))
                .collect::<Vec<_>>();
            if matches!(mode, Mode::Insertion) {
                entries.sort_by(|(left, _), (right, _)| {
                    match (array_index(left), array_index(right)) {
                        (Some(left), Some(right)) => left.cmp(&right),
                        (Some(_), None) => std::cmp::Ordering::Less,
                        (None, Some(_)) => std::cmp::Ordering::Greater,
                        (None, None) => std::cmp::Ordering::Equal,
                    }
                });
            } else {
                entries.sort_by(|(left, _), (right, _)| compare_code_units(left, right));
            }
            let items = entries
                .into_iter()
                .map(|(key, value)| {
                    Ok(format!(
                        "{}:{}",
                        serde_json::to_string(key).map_err(|error| error.to_string())?,
                        serialize(value, mode)?
                    ))
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(format!("{{{}}}", items.join(",")))
        }
        Value::Map(entries) => {
            if !matches!(mode, Mode::Stable) {
                return Ok("{}".into());
            }
            let mut entries = entries.clone();
            entries.sort_by(|(left, _), (right, _)| {
                compare_code_units(&js_string(left), &js_string(right))
            });
            serialize(
                &Value::Array(
                    entries
                        .into_iter()
                        .map(|(k, v)| Value::Array(vec![k, v]))
                        .collect(),
                ),
                mode,
            )
        }
        Value::Set(values) => {
            if !matches!(mode, Mode::Stable) {
                return Ok("{}".into());
            }
            let mut values = values.clone();
            values.sort_by(|left, right| match (left, right) {
                (Value::Undefined, Value::Undefined) => std::cmp::Ordering::Equal,
                (Value::Undefined, _) => std::cmp::Ordering::Greater,
                (_, Value::Undefined) => std::cmp::Ordering::Less,
                _ => compare_code_units(&js_string(left), &js_string(right)),
            });
            serialize(&Value::Array(values), mode)
        }
    }
}

fn array_index(key: &str) -> Option<u32> {
    let value = key.parse::<u32>().ok()?;
    (value != u32::MAX && value.to_string() == key).then_some(value)
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Undefined => "undefined".into(),
        Value::String(v) => v.clone(),
        Value::Number(v) => ryu_js::Buffer::new().format(*v).to_owned(),
        Value::Bool(v) => v.to_string(),
        Value::Object(_) => "[object Object]".into(),
        Value::Map(_) => "[object Map]".into(),
        Value::Set(_) => "[object Set]".into(),
        Value::Array(v) => v
            .iter()
            .map(|v| {
                if matches!(v, Value::Null | Value::Undefined) {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
    }
}
