use crate::{Value, config_hash};
use serde_json::{Value as Json, json};

pub const MODEL_VERSION: &str = "transparent-power-index-v0.2.0";

/// This is the worker's live configuration, checked against TypeScript in CI.
pub fn parameters() -> Json {
    serde_json::from_str(include_str!("model-config.json"))
        .expect("worker model configuration is valid JSON")
}

pub fn metadata() -> Json {
    let parameters = parameters();
    json!({"modelVersion":MODEL_VERSION,
        "modelConfigHash": config_hash(&Value::from(&parameters)).expect("worker model configuration is hashable"),
        "parameters": parameters,
    })
}
