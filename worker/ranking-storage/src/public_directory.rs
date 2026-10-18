use super::{public_archive, s3};
use ranking_contracts::{Result, published};

pub(super) fn verify(bucket: &s3::Bucket, manifest_json: &str) -> Result<String> {
    let verified = published::verify_directory(manifest_json, &mut |identity| {
        public_archive::read(bucket, identity)
    })?;
    Ok(verified.result_json(&bucket.prefix))
}
