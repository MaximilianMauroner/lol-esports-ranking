use super::{read_active, s3};
use ranking_contracts::{
    Result,
    published::{IdentityMetadata, PublicationRequest},
};
use reqwest::Method;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// This proves declared immutable membership, not a generation graph or promotion.
pub(super) fn verify(bucket: &s3::Bucket) -> Result<Value> {
    let (active, etag) = read_active(bucket)?;
    if etag.is_none() {
        return Ok(json!({"found":false,"reason":"active-generation-missing"}));
    }
    let active = serde_json::to_vec(&active).map_err(|error| error.to_string())?;
    let Some(request) = PublicationRequest::from_active(&active, &bucket.prefix)? else {
        return Ok(json!({"found":false,"reason":"legacy-publication-without-receipt-binding"}));
    };
    let object = bucket.request(Method::GET, request.relative_key(), BTreeMap::new(), vec![])?;
    if object.status != 200 {
        return Err("Active generation publication receipt authority mismatch".into());
    }
    let receipt = request.check(
        IdentityMetadata {
            etag: &object.etag,
            headers: &object.headers,
        },
        &object.body,
    )?;
    for member in receipt.members() {
        let object = bucket.request(Method::GET, member.relative_key(), BTreeMap::new(), vec![])?;
        if object.status != 200 {
            return Err("Generation publication object authority mismatch".into());
        }
        member.check(
            IdentityMetadata {
                etag: &object.etag,
                headers: &object.headers,
            },
            &object.body,
        )?;
    }
    serde_json::from_str(&receipt.result_json()).map_err(|error| error.to_string())
}
