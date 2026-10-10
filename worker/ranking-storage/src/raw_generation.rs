use super::s3;
use ranking_contracts::{Result, sha256};
use ranking_raw_source::{Reference, decode_object, receipt_graph, validate_reference};
use reqwest::Method;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Validates the raw graph that Node checks before publication readiness.
/// The receipt determines membership; a declared publication list is insufficient.
pub(super) fn verify(bucket: &s3::Bucket, mut reference: Reference) -> Result<Value> {
    let (value, receipt_proof) = read(bucket, &reference)?;
    let graph = receipt_graph(value).map_err(|_| "Raw source receipt is invalid")?;
    reference.compressed_bytes = receipt_proof["compressedBytes"].as_u64();
    let mut verified_objects = vec![receipt_proof];
    for child in graph.references {
        let (_, proof) = read(bucket, &child)?;
        verified_objects.push(proof);
    }
    Ok(json!({
        "key": full_key(bucket, &reference.key),
        "reference": reference,
        "receipt": graph.receipt,
        "verifiedObjects": verified_objects,
    }))
}

fn read(bucket: &s3::Bucket, reference: &Reference) -> Result<(Value, Value)> {
    // Validate the canonical namespace before issuing any bucket request.
    validate_reference(reference).map_err(|_| "Invalid raw object reference")?;
    let object = bucket.request(Method::GET, &reference.key, BTreeMap::new(), vec![])?;
    if object.status != 200 {
        return Err(format!(
            "Raw source graph read failed with HTTP {}",
            object.status
        ));
    }
    let header = |key: &str| object.headers.get(key).map(String::as_str);
    if object.body.is_empty()
        || header("content-length") != Some(object.body.len().to_string().as_str())
        || header("content-encoding") != Some("gzip")
        || header("x-amz-meta-sha256") != Some(reference.sha256.as_str())
        || header("x-amz-meta-semantic-bytes") != Some(reference.bytes.to_string().as_str())
        || header("x-amz-meta-encoding") != Some("gzip")
    {
        return Err("Raw source graph object metadata mismatch".into());
    }
    let value = decode_object(reference, &object.body)
        .map_err(|_| "Raw source graph object semantic integrity mismatch")?;
    let proof = json!({
        "key": full_key(bucket, &reference.key),
        "digest": reference.sha256,
        "bytes": object.body.len(),
        "compressedBytes": object.body.len(),
        "compressedSha256": sha256(&object.body),
    });
    Ok((value, proof))
}

fn full_key(bucket: &s3::Bucket, key: &str) -> String {
    if bucket.prefix.is_empty() {
        key.into()
    } else {
        format!("{}/{key}", bucket.prefix)
    }
}
