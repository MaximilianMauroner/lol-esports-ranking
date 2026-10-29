mod engine;
mod pass;
mod validation;
mod wire;

use engine::Model;
use ranking_contracts::{Result, sha256};
use std::{fs::File, io::Read};
use wire::{RESPONSE_SCHEMA, Request, Response};

pub const MAX_BATCH_BYTES: u64 = 64 << 20;

/// Runs the native series state pass over complete UTC-date frames and returns the response bytes.
pub fn calculate_batch(bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.len() as u64 > MAX_BATCH_BYTES {
        return Err("request exceeds 64 MiB".into());
    }
    let request: Request = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    validation::validate(&request)?;
    let model = Model::live()?;
    let dates = request
        .dates
        .iter()
        .map(|frame| pass::date(&model, frame))
        .collect::<Result<Vec<_>>>()?;
    let output = serde_json::to_vec(&Response {
        schema: RESPONSE_SCHEMA,
        request_sha256: sha256(bytes),
        model: request.model,
        dates,
    })
    .map_err(|e| e.to_string())?;
    if output.len() as u64 > MAX_BATCH_BYTES {
        return Err("response exceeds 64 MiB".into());
    }
    Ok(output)
}

pub fn run(input: &str, output: &str) -> Result<()> {
    let mut bytes = Vec::new();
    File::open(input)
        .map_err(|e| e.to_string())?
        .take(MAX_BATCH_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let response = calculate_batch(&bytes)?;
    std::fs::write(output, response).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn matches_the_node_sparse_state_observation() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/rankingComputeSeriesPass.json"
        ))
        .unwrap();
        let input = serde_json::to_vec(&fixture["request"]).unwrap();
        let response = super::calculate_batch(&input).unwrap();
        let response: serde_json::Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(response["dates"], fixture["expectedDates"]);
    }
}
