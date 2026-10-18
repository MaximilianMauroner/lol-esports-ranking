use super::s3;
use ranking_contracts::{
    Result,
    published::{self, PublicIdentity, PublicObject},
};
use reqwest::Method;
use std::collections::BTreeMap;

pub(super) fn read(bucket: &s3::Bucket, identity: &PublicIdentity) -> Result<PublicObject> {
    let object = bucket.request(Method::GET, &identity.relative_key(), BTreeMap::new(), vec![])?;
    if object.status != 200 {
        return Err(format!(
            "Public object read failed with HTTP {}",
            object.status
        ));
    }
    PublicObject::check(identity, &object.headers, &object.body)
}

pub(super) fn verify(bucket: &s3::Bucket, digest: &str, bytes: u64) -> Result<String> {
    let verified = published::verify_artifact(digest, bytes, &mut |identity| read(bucket, identity))?;
    Ok(verified.result_json(&bucket.prefix))
}
