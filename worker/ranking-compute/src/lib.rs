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
    use serde_json::{Value, json};

    const PROTECTED: &str =
        include_str!("../../../tests/fixtures/rankingComputeSeriesPassProtected.json");

    fn fixture(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }
    fn run(request: &Value) -> super::Result<Value> {
        let response = super::calculate_batch(&serde_json::to_vec(request).unwrap())?;
        Ok(serde_json::from_slice(&response).unwrap())
    }

    #[test]
    fn matches_the_node_sparse_state_observation() {
        let fixture = fixture(include_str!(
            "../../../tests/fixtures/rankingComputeSeriesPass.json"
        ));
        assert_eq!(
            run(&fixture["request"]).unwrap()["dates"],
            fixture["expectedDates"]
        );
    }

    #[test]
    fn applies_the_builder_retention_to_swapped_final_sides() {
        let fixture = fixture(PROTECTED);
        let series = &fixture["request"]["dates"][0]["series"][0];
        assert_eq!(
            series["continuityRetention"],
            json!(["baseline-contraction", "proven-stronger-lineup"])
        );
        assert_ne!(series["teams"][0], series["members"][1]["sides"][0]["team"]);
        assert_eq!(
            run(&fixture["request"]).unwrap()["dates"],
            fixture["expectedDates"]
        );
    }

    #[test]
    fn a_dropped_retention_decodes_as_baseline_and_misses_the_node_state() {
        let fixture = fixture(PROTECTED);
        let mut request = fixture["request"].clone();
        let series = &mut request["dates"][0]["series"][0];
        series
            .as_object_mut()
            .unwrap()
            .remove("continuityRetention");
        let response = run(&request).unwrap();
        let expected = &fixture["expectedDates"][0]["series"][0]["continuity"][1];
        let actual = &response["dates"][0]["series"][0]["continuity"][1];
        assert_ne!(actual["rating"], expected["rating"]);
        assert_eq!(actual["executionRating"], expected["executionRating"]);
    }

    #[test]
    fn legacy_frames_decode_but_only_the_current_model_hash_runs() {
        let mut request = fixture(PROTECTED)["request"].clone();
        let series = &mut request["dates"][0]["series"][0];
        series
            .as_object_mut()
            .unwrap()
            .remove("continuityRetention");
        for hash in ["fnv1a-8932f05e", "fnv1a-653e9104"] {
            request["model"]["configHash"] = json!(hash);
            let bytes = serde_json::to_vec(&request).unwrap();
            serde_json::from_slice::<crate::wire::Request>(&bytes).unwrap();
            let error = super::calculate_batch(&bytes).unwrap_err();
            assert!(error.contains("model/config mismatch"), "{hash}: {error}");
        }
    }

    #[test]
    fn rejects_noncanonical_or_unknown_retention() {
        let fixture = fixture(PROTECTED);
        for value in [
            json!(null),
            json!(["baseline-contraction"]),
            json!([
                "baseline-contraction",
                "proven-stronger-lineup",
                "baseline-contraction"
            ]),
            json!(["baseline-contraction", "proven"]),
            json!(["baseline-contraction", "Proven-Stronger-Lineup"]),
            json!({ "teamA": "baseline-contraction", "teamB": "proven-stronger-lineup" }),
            json!(["baseline-contraction", "baseline-contraction"]),
        ] {
            let mut request = fixture["request"].clone();
            request["dates"][0]["series"][0]["continuityRetention"] = value.clone();
            assert!(run(&request).is_err(), "{value}");
        }
        let mut request = fixture["request"].clone();
        request["dates"][0]["series"][0]["continuity_retention"] =
            json!(["baseline-contraction", "proven-stronger-lineup"]);
        assert!(run(&request).is_err(), "unknown field");
    }
}
