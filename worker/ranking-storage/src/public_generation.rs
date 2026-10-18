use super::{public_archive, s3};
use ranking_contracts::{
    Result,
    published::{IdentityMetadata, SuppliedGeneration},
};
use reqwest::Method;
use std::collections::BTreeMap;

pub(super) use ranking_contracts::published::{
    GenerationScope as Scope, ManifestAuthority as Authority,
};

pub(super) fn verify(
    bucket: &s3::Bucket,
    authority: Authority,
    context_json: &str,
    scope: Scope,
) -> Result<String> {
    let supplied = SuppliedGeneration::new(authority, context_json, &bucket.prefix)?;
    let remote = bucket.request(Method::GET, supplied.relative_key(), BTreeMap::new(), vec![])?;
    if remote.status != 200 {
        return Err(format!(
            "Public manifest read failed with HTTP {}",
            remote.status
        ));
    }
    let verified = supplied.check(
        IdentityMetadata {
            etag: &remote.etag,
            headers: &remote.headers,
        },
        &remote.body,
        scope,
        &mut |identity| public_archive::read(bucket, identity),
    )?;
    Ok(verified.result_json(&bucket.prefix))
}
