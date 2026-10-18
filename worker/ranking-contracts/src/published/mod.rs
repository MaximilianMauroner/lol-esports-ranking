//! Retained public checks shared by native storage consumers.
//!
//! ```compile_fail
//! use ranking_contracts::published::wire::Json;
//! ```
//! ```compile_fail
//! let forged = ranking_contracts::published::PublicObject {};
//! ```
mod archive;
mod date;
mod directory;
mod generation;
mod key;
mod publication;
mod references;
mod wire;

pub use generation::{GenerationScope, GenerationVerification, ManifestAuthority, SuppliedGeneration};
pub use key::validate_storage_key;
pub use publication::{PublicationMember, PublicationReceipt, PublicationRequest};
pub use references::ReferenceGraph;

use crate::{Result, canonical_json_value, decode_gzip, sha256};
use archive::Reader;
use serde_json::json;
use std::collections::BTreeMap;
use wire::{Json, field, integer, parse_json, string_is, take, valid_digest, write_json};

const JSON_TYPE: &str = "application/json; charset=utf-8";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublicIdentity {
    digest: String,
    bytes: u64,
}

impl PublicIdentity {
    pub fn new(digest: &str, bytes: u64) -> Result<Self> {
        if !valid_digest(digest) || !(1..=9_007_199_254_740_991).contains(&bytes) {
            return Err("Invalid public object identity".into());
        }
        Ok(Self {
            digest: digest.into(),
            bytes,
        })
    }

    pub fn digest(&self) -> &str {
        &self.digest
    }

    pub fn bytes(&self) -> u64 {
        self.bytes
    }

    pub fn relative_key(&self) -> String {
        format!("objects/sha256/{}", self.digest)
    }
}

pub struct IdentityMetadata<'a> {
    pub etag: &'a str,
    pub headers: &'a BTreeMap<String, String>,
}

pub struct PublicObject {
    identity: PublicIdentity,
    content: Json,
    proof: ObjectProof,
}

impl PublicObject {
    pub fn check(
        identity: &PublicIdentity,
        headers: &BTreeMap<String, String>,
        body: &[u8],
    ) -> Result<Self> {
        let header = |key: &str| headers.get(key).map(String::as_str);
        if header("content-encoding") != Some("gzip")
            || header("content-length") != Some(body.len().to_string().as_str())
            || header("x-amz-meta-sha256") != Some(identity.digest())
            || header("x-amz-meta-semantic-bytes") != Some(identity.bytes().to_string().as_str())
            || header("x-amz-meta-encoding") != Some("gzip")
        {
            return Err("Public object metadata mismatch".into());
        }
        let mut semantic = Vec::new();
        let decoded = decode_gzip(body, identity.bytes(), |chunk| {
            semantic.extend_from_slice(chunk)
        })
        .map_err(|_| "Public object gzip or semantic size is invalid")?;
        if decoded != identity.bytes() || sha256(&semantic) != identity.digest() {
            return Err("Public object semantic identity mismatch".into());
        }
        let mut envelope = parse_json(String::from_utf8_lossy(&semantic).as_bytes())
            .map_err(|_| "Invalid public object JSON")?;
        if !string_is(field(&envelope, "artifactKind"), "public-semantic-artifact")
            || integer(field(&envelope, "schemaVersion")) != Some(1)
            || !matches!(field(&envelope, "content"), Some(Json::Object(_)))
        {
            return Err("Public object semantic envelope is invalid".into());
        }
        Ok(Self {
            identity: identity.clone(),
            content: take(&mut envelope, "content").expect("validated public envelope content"),
            proof: ObjectProof {
                identity: identity.clone(),
                compressed_bytes: body.len() as u64,
                compressed_sha256: sha256(body),
            },
        })
    }
}

struct ObjectProof {
    identity: PublicIdentity,
    compressed_bytes: u64,
    compressed_sha256: String,
}

pub struct PublicDocument {
    value: Json,
}

impl PublicDocument {
    pub fn canonical_json(&self) -> String {
        let mut output = String::new();
        write_json(&self.value, &mut output);
        output
    }

    pub fn references(&self) -> Result<Vec<crate::Utf16String>> {
        references::artifact_references(&self.value)
    }
}

pub struct ArtifactVerification {
    document: PublicDocument,
    proofs: Vec<ObjectProof>,
}

impl ArtifactVerification {
    pub fn document(&self) -> &PublicDocument {
        &self.document
    }

    pub fn result_json(&self, prefix: &str) -> String {
        result_json("content", &self.document.value, &self.proofs, prefix)
    }
}

pub fn verify_artifact(
    digest: &str,
    bytes: u64,
    load: &mut dyn FnMut(&PublicIdentity) -> Result<PublicObject>,
) -> Result<ArtifactVerification> {
    let mut reader = Reader::new(load);
    let value = reader.read_artifact(digest, bytes)?;
    Ok(ArtifactVerification {
        document: PublicDocument { value },
        proofs: reader.proofs,
    })
}

pub struct DirectoryVerification {
    manifest: Json,
    proofs: Vec<ObjectProof>,
}

impl DirectoryVerification {
    pub fn result_json(&self, prefix: &str) -> String {
        result_json("manifest", &self.manifest, &self.proofs, prefix)
    }
}

pub fn verify_directory(
    manifest_json: &str,
    load: &mut dyn FnMut(&PublicIdentity) -> Result<PublicObject>,
) -> Result<DirectoryVerification> {
    let mut manifest = parse_json(manifest_json.as_bytes())?;
    let mut reader = Reader::new(load);
    directory::expand(&mut reader, &mut manifest)?;
    Ok(DirectoryVerification {
        manifest,
        proofs: reader.proofs,
    })
}

fn result_json(name: &str, content: &Json, proofs: &[ObjectProof], prefix: &str) -> String {
    let proofs = proofs.iter().map(|proof| {
        let key = full_key(prefix, &proof.identity.relative_key());
        json!({"key":key,"digest":proof.identity.digest,"compressedBytes":proof.compressed_bytes,"compressedSha256":proof.compressed_sha256})
    }).collect::<Vec<_>>();
    let proofs = canonical_json_value(&json!(proofs));
    let mut output = String::from("{");
    if !matches!(content, Json::Undefined) {
        crate::Utf16String::from(name).write_json(&mut output);
        output.push(':');
        write_json(content, &mut output);
        output.push(',');
    }
    output.push_str(&format!("\"verifiedObjects\":{proofs}}}"));
    output
}

fn full_key(prefix: &str, key: &str) -> String {
    if prefix.is_empty() {
        key.into()
    } else {
        format!("{prefix}/{key}")
    }
}

#[derive(Debug, Eq, PartialEq)]
pub struct CanonicalDate(String);

impl CanonicalDate {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Eq, PartialEq)]
pub struct UnsupportedDate;

#[cfg(test)]
mod tests;
