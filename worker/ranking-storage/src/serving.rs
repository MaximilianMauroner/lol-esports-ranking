mod transport;

use flate2::{Decompress, FlushDecompress, Status};
use ranking_contracts::published::serving::{
    ActivePointer, ServingReceipt, compatible_manifest, normalized_path, positive_number_text,
};
use ranking_contracts::{
    Result,
    published::{IdentityMetadata, PublicIdentity, PublicObject, verify_served_artifact},
    sha256,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ops::Deref,
    sync::{Arc, Mutex},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use transport::{
    DOCUMENT_LIMIT, Object, READ_TIMEOUT, ReadMethod, SEMANTIC_LIMIT, STORED_LIMIT, Transport,
};

const ROOT: &str = "ranking-summary.json";
const JSON_TYPE: &str = "application/json; charset=utf-8";
const ROOT_INPUT_LIMIT: u64 = 128 * 1024 * 1024;
const ROOT_SEMANTIC_LIMIT: u64 = 64 * 1024 * 1024;
const ROOT_REFERENCE_LIMIT: usize = 4096;

/// Bytes retain read admission until the HTTP body releases its last owner.
#[derive(Clone)]
pub struct ServedBytes {
    bytes: Arc<[u8]>,
    admission: Option<Arc<OwnedSemaphorePermit>>,
}
impl Deref for ServedBytes {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        &self.bytes
    }
}
impl AsRef<[u8]> for ServedBytes {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}
impl From<Vec<u8>> for ServedBytes {
    fn from(bytes: Vec<u8>) -> Self {
        Self {
            bytes: bytes.into(),
            admission: None,
        }
    }
}

#[derive(Clone)]
pub struct ServedObject {
    pub body: ServedBytes,
    pub semantic_body: Option<ServedBytes>,
    pub status: u16,
    pub redirect: Option<String>,
    pub content_type: String,
    pub content_encoding: Option<String>,
    pub content_length: u64,
    pub semantic_length: Option<u64>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

/// Read-only published data. Mutable publication and lease storage stay private.
pub struct PublishedOrigin {
    transport: Transport,
    admission: Arc<Semaphore>,
    root_cache: Mutex<Option<(String, ServedObject)>>,
}

impl PublishedOrigin {
    pub fn from_env() -> Result<Option<Self>> {
        Ok(Transport::from_env()?.map(|transport| Self {
            transport,
            admission: Arc::new(Semaphore::new(2)),
            root_cache: Mutex::new(None),
        }))
    }

    pub async fn read(
        &self,
        path: &str,
        generation: Option<&str>,
        head: bool,
        allow_redirect: bool,
    ) -> Result<Option<ServedObject>> {
        validate_path(path)?;
        let deadline = tokio::time::Instant::now() + READ_TIMEOUT;
        let result = tokio::time::timeout_at(deadline, async {
            let admission = Arc::new(
                self.admission
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|_| "Published origin read admission closed")?,
            );
            self.read_inner(path, generation, head, allow_redirect, deadline)
                .await
                .map(|value| (value, admission))
        })
        .await;
        let result = result
            .map_err(|_| "Published origin read deadline exceeded".to_owned())
            .and_then(|value| value);
        if result.is_err() && path == ROOT && generation.is_none_or(str::is_empty) {
            *self
                .root_cache
                .lock()
                .map_err(|_| "Published origin cache failed")? = None;
        }
        let (object, admission) = result?;
        Ok(object.map(|mut object| {
            object.body.admission = Some(admission.clone());
            if let Some(body) = &mut object.semantic_body {
                body.admission = Some(admission);
            }
            object
        }))
    }

    async fn read_inner(
        &self,
        path: &str,
        generation: Option<&str>,
        head: bool,
        allow_redirect: bool,
        deadline: tokio::time::Instant,
    ) -> Result<Option<ServedObject>> {
        if let Some(hash) = path.strip_prefix("objects/sha256/") {
            if !valid_digest(hash) {
                return Ok(None);
            }
            return self.immutable(path, hash, head, allow_redirect).await;
        }
        let generation = generation.filter(|value| !value.is_empty());
        let unpinned = generation.is_none();
        let mut active_generation = None;
        let mut active_schema = None;
        if generation.is_none()
            && let Some(pointer_object) = self
                .transport
                .read("active-generation.json", ReadMethod::Get, DOCUMENT_LIMIT)
                .await?
        {
            let mut pointer = ActivePointer::parse(&pointer_object.body, &self.transport.prefix)?;
            active_generation = pointer.generation().map(str::to_owned);
            if pointer.content_addressed() {
                let root = self
                    .active_root(&mut pointer, &pointer_object, deadline)
                    .await?;
                if path == ROOT {
                    let mut root = root;
                    if head {
                        root.body = Vec::new().into();
                    }
                    return Ok(Some(root));
                }
                active_schema = Some(serde_json::json!(2));
            }
        }
        let generation = generation.or(active_generation.as_deref());
        let mut keys = Vec::new();
        if let Some(generation) = generation {
            let generation = normalized_path(generation);
            if path == ROOT {
                keys.push(format!("generations/{generation}/manifest.json"));
            }
            keys.push(format!("generations/{generation}/data/{path}"));
        }
        self.legacy_read(
            keys,
            path,
            head,
            active_schema.as_ref(),
            generation,
            unpinned,
        )
        .await
    }

    async fn legacy_read(
        &self,
        mut keys: Vec<String>,
        path: &str,
        head: bool,
        schema: Option<&serde_json::Value>,
        selected: Option<&str>,
        unpinned: bool,
    ) -> Result<Option<ServedObject>> {
        if unpinned {
            keys.push(format!("data/{path}"));
        }
        for key in keys {
            let method = if head && !(unpinned && path == ROOT && key.ends_with("/manifest.json")) {
                ReadMethod::Head
            } else {
                ReadMethod::Get
            };
            let Some(object) = self.transport.read(&key, method, STORED_LIMIT).await? else {
                continue;
            };
            if unpinned && path == ROOT && key.ends_with("/manifest.json") {
                let manifest = compatible_manifest(
                    &object.body,
                    selected.ok_or("Missing active generation")?,
                    schema,
                )?;
                if manifest.cutover() {
                    let body = manifest.body().to_vec();
                    let mut served = served(object, path)?;
                    served.etag = Some(format!("\"cutover-v2-{}\"", sha256(&body)));
                    served.content_type = JSON_TYPE.into();
                    served.content_encoding = None;
                    served.content_length = body.len() as u64;
                    served.body = if head { Vec::new() } else { body }.into();
                    return Ok(Some(served));
                }
            }
            let mut served = served(object, path)?;
            if !head && served.content_encoding.as_deref() == Some("gzip") {
                let semantic = decode(&served.body, None, SEMANTIC_LIMIT).await?;
                served.semantic_length = Some(semantic.len() as u64);
                served.semantic_body = Some(semantic.into());
            }
            if head {
                served.body = Vec::new().into();
            }
            return Ok(Some(served));
        }
        Ok(None)
    }

    async fn immutable(
        &self,
        path: &str,
        hash: &str,
        head: bool,
        allow_redirect: bool,
    ) -> Result<Option<ServedObject>> {
        let mut metadata = None;
        if head || (allow_redirect && self.transport.redirect_threshold.is_some()) {
            match self.transport.read(path, ReadMethod::Head, 0).await {
                Ok(Some(object)) => {
                    if allow_redirect
                        && self
                            .transport
                            .redirect_threshold
                            .is_some_and(|threshold| redirect_metadata(&object, hash, threshold))
                        && let Ok(location) = self.transport.presign(
                            path,
                            if head {
                                ReadMethod::Head
                            } else {
                                ReadMethod::Get
                            },
                        )
                    {
                        let mut result = served(object, path)?;
                        result.status = 307;
                        result.redirect = Some(location);
                        return Ok(Some(result));
                    }
                    metadata = Some(object);
                }
                Ok(None) if head => return Ok(None),
                Ok(None) => {}
                Err(error) if head => return Err(error),
                Err(_) => {}
            }
        }
        if head {
            let object = metadata.ok_or("Missing immutable HEAD metadata")?;
            immutable_identity(&object, hash)?;
            return Ok(Some(served(object, path)?));
        }
        let Some(object) = self
            .transport
            .read(path, ReadMethod::Get, STORED_LIMIT)
            .await?
        else {
            return Ok(None);
        };
        let identity = immutable_identity(&object, hash)?;
        if object.headers.get("content-length") != Some(&object.body.len().to_string()) {
            return Err("Referenced content-addressed object metadata mismatch".into());
        }
        let semantic = decode(&object.body, Some(&identity), SEMANTIC_LIMIT).await?;
        let mut result = served(object, path)?;
        result.semantic_body = Some(semantic.into());
        Ok(Some(result))
    }

    async fn active_root(
        &self,
        pointer: &mut ActivePointer,
        pointer_object: &Object,
        deadline: tokio::time::Instant,
    ) -> Result<ServedObject> {
        let cache_key = pointer
            .immutable_binding()
            .zip(pointer_object.headers.get("etag"))
            .filter(|(_, etag)| !etag.is_empty())
            .map(|(binding, etag)| format!("{etag}\0{binding}\0{}", sha256(&pointer_object.body)));
        if let Some(key) = &cache_key {
            let cache = self
                .root_cache
                .lock()
                .map_err(|_| "Published origin cache failed")?;
            if let Some((_, value)) = cache.as_ref().filter(|(cached_key, _)| cached_key == key) {
                return Ok(value.clone());
            }
        }
        let receipt = if let Some(key) = pointer.receipt_key() {
            let object = self
                .transport
                .read(&key, ReadMethod::Get, DOCUMENT_LIMIT)
                .await?
                .ok_or("Active generation publication receipt is unavailable")?;
            Some(pointer.check_receipt(metadata(&object), &object.body, &self.transport.prefix)?)
        } else {
            None
        };
        let key = pointer.manifest_key(&self.transport.prefix)?;
        let object = self
            .transport
            .read(&key, ReadMethod::Get, DOCUMENT_LIMIT)
            .await?
            .ok_or("Active public generation manifest is unavailable")?;
        let manifest = pointer.check_manifest(metadata(&object), &object.body, receipt.as_ref())?;
        let root = manifest.root()?;
        self.verify_root(&root, receipt.as_ref(), deadline).await?;
        let mut result = served(object, ROOT)?;
        result.body = manifest.body().to_vec().into();
        result.content_length = result.body.len() as u64;
        result.content_type = JSON_TYPE.into();
        result.content_encoding = None;
        result.semantic_length = None;
        result.last_modified = None;
        if manifest.cutover() {
            result.etag = Some(format!("\"cutover-v2-{}\"", sha256(&result.body)));
        }
        if let Some(key) = cache_key {
            *self
                .root_cache
                .lock()
                .map_err(|_| "Published origin cache failed")? = Some((key, result.clone()));
        }
        Ok(result)
    }

    async fn verify_root(
        &self,
        identity: &PublicIdentity,
        receipt: Option<&ServingReceipt>,
        deadline: tokio::time::Instant,
    ) -> Result<()> {
        let mut objects: BTreeMap<String, PublicObject> = BTreeMap::new();
        let mut stored_bytes = 0u64;
        let mut semantic_bytes = 0u64;
        loop {
            let mut needed = None;
            let result = verify_served_artifact(
                identity.digest(),
                identity.bytes(),
                &mut |reference| {
                    if let Some(object) = objects.get(reference.digest()) {
                        return Ok(object.clone());
                    }
                    needed = Some(reference.clone());
                    Err("Public root reference requires a read".into())
                },
                &mut || {
                    if tokio::time::Instant::now() >= deadline {
                        return Err("Public root verification deadline exceeded".into());
                    }
                    Ok(())
                },
            );
            if result.is_ok() {
                return Ok(());
            }
            let Some(reference) = needed else {
                return result.map(|_| ());
            };
            if objects.len() >= ROOT_REFERENCE_LIMIT {
                return Err("Public root exceeds reference limit".into());
            }
            if reference.bytes() > DOCUMENT_LIMIT {
                return Err("Public root member exceeds document limit".into());
            }
            let object = self
                .transport
                .read(
                    &reference.relative_key(),
                    ReadMethod::Get,
                    STORED_LIMIT.min(ROOT_INPUT_LIMIT - stored_bytes),
                )
                .await?
                .ok_or("Active public generation root object is unavailable")?;
            if let Some(receipt) = receipt {
                receipt.check_public_member(
                    &self.transport.prefix,
                    &reference,
                    object.body.len() as u64,
                )?;
            }
            stored_bytes += object.body.len() as u64;
            semantic_bytes += reference.bytes();
            if semantic_bytes > ROOT_SEMANTIC_LIMIT {
                return Err("Public root exceeds semantic input limit".into());
            }
            let actual = immutable_identity(&object, reference.digest())?;
            if actual != reference {
                return Err("Public root identity metadata mismatch".into());
            }
            let _ = decode(&object.body, Some(&reference), DOCUMENT_LIMIT).await?;
            let checked = PublicObject::check(&reference, &object.headers, &object.body)?;
            objects.insert(reference.digest().to_owned(), checked);
            tokio::task::yield_now().await;
        }
    }
}

fn metadata(object: &Object) -> IdentityMetadata<'_> {
    IdentityMetadata {
        etag: object
            .headers
            .get("etag")
            .map(String::as_str)
            .unwrap_or_default(),
        headers: &object.headers,
    }
}
fn served(object: Object, path: &str) -> Result<ServedObject> {
    let length = object
        .headers
        .get("content-length")
        .map(|value| value.parse::<u64>().map_err(|_| "Invalid S3 object length"))
        .transpose()?
        .unwrap_or(object.body.len() as u64);
    let semantic_length = object
        .headers
        .get("x-amz-meta-semantic-bytes")
        .and_then(|value| positive_number_text(value));
    Ok(ServedObject {
        body: object.body.into(),
        semantic_body: None,
        status: 200,
        redirect: None,
        content_type: object
            .headers
            .get("content-type")
            .cloned()
            .unwrap_or_else(|| content_type(path).into()),
        content_encoding: object.headers.get("content-encoding").cloned(),
        content_length: length,
        semantic_length,
        etag: object.headers.get("etag").cloned(),
        last_modified: object.headers.get("last-modified").cloned(),
    })
}
fn immutable_identity(object: &Object, hash: &str) -> Result<PublicIdentity> {
    let header = |key: &str| object.headers.get(key).map(String::as_str);
    let bytes = header("x-amz-meta-semantic-bytes")
        .and_then(positive_number_text)
        .ok_or("Invalid public semantic length")?;
    if header("content-encoding") != Some("gzip")
        || header("x-amz-meta-sha256") != Some(hash)
        || header("x-amz-meta-encoding") != Some("gzip")
    {
        return Err("Referenced content-addressed object metadata mismatch".into());
    }
    PublicIdentity::new(hash, bytes)
}
fn redirect_metadata(object: &Object, hash: &str, threshold: u64) -> bool {
    let header = |name: &str| object.headers.get(name).map(String::as_str);
    header("content-length")
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|value| value >= threshold && value <= 9_007_199_254_740_991)
        && header("content-type").is_some_and(|value| value.eq_ignore_ascii_case(JSON_TYPE))
        && header("content-encoding").is_some_and(|value| value.eq_ignore_ascii_case("gzip"))
        && header("cache-control")
            .is_some_and(|value| value.eq_ignore_ascii_case("public, max-age=31536000, immutable"))
        && header("x-amz-meta-sha256") == Some(hash)
        && header("x-amz-meta-encoding") == Some("gzip")
        && header("x-amz-meta-semantic-bytes").is_some_and(|value| {
            value
                .as_bytes()
                .first()
                .is_some_and(|byte| (b'1'..=b'9').contains(byte))
                && value.bytes().all(|byte| byte.is_ascii_digit())
        })
}
async fn decode(
    compressed: &[u8],
    identity: Option<&PublicIdentity>,
    limit: u64,
) -> Result<Vec<u8>> {
    if identity.is_some_and(|identity| identity.bytes() > limit) {
        return Err("Public semantic object exceeds serving limit".into());
    }
    let mut remaining = compressed;
    let mut semantic = Vec::new();
    let mut hash = Sha256::new();
    let mut buffer = [0; 65_536];
    loop {
        remaining = gzip_payload(remaining)?;
        let mut decoder = Decompress::new(false);
        let mut crc = crc32fast::Hasher::new();
        loop {
            let input_before = decoder.total_in();
            let output_before = decoder.total_out();
            let status = decoder
                .decompress(
                    &remaining[..remaining.len().min(65_536)],
                    &mut buffer,
                    FlushDecompress::None,
                )
                .map_err(|_| "Public object gzip is corrupt")?;
            let consumed = (decoder.total_in() - input_before) as usize;
            let count = (decoder.total_out() - output_before) as usize;
            remaining = &remaining[consumed..];
            if semantic.len() as u64 + count as u64 > limit
                || identity
                    .is_some_and(|identity| semantic.len() as u64 + count as u64 > identity.bytes())
            {
                return Err(
                    "Public object semantic size exceeds serving limit or authority".into(),
                );
            }
            hash.update(&buffer[..count]);
            crc.update(&buffer[..count]);
            semantic.extend_from_slice(&buffer[..count]);
            tokio::task::yield_now().await;
            if status == Status::StreamEnd {
                break;
            }
            if consumed == 0 && count == 0 {
                return Err("Public object gzip is truncated".into());
            }
        }
        let (trailer, rest) = remaining
            .split_at_checked(8)
            .ok_or("Public object gzip is truncated")?;
        let expected_crc = u32::from_le_bytes(trailer[..4].try_into().unwrap());
        let expected_size = u32::from_le_bytes(trailer[4..].try_into().unwrap());
        if crc.finalize() != expected_crc || decoder.total_out() as u32 != expected_size {
            return Err("Public object gzip checksum is corrupt".into());
        }
        remaining = rest;
        if remaining.is_empty() || remaining[0] == 0 {
            break;
        }
    }
    if let Some(identity) = identity
        && (semantic.len() as u64 != identity.bytes()
            || format!("{:x}", hash.finalize()) != identity.digest())
    {
        return Err("Referenced content-addressed object digest mismatch".into());
    }
    Ok(semantic)
}
fn gzip_payload(compressed: &[u8]) -> Result<&[u8]> {
    let error = "Public object gzip header is corrupt";
    let fixed = compressed.get(..10).ok_or(error)?;
    let flags = fixed[3];
    if fixed[..3] != [0x1f, 0x8b, 8] || flags & 0xe0 != 0 {
        return Err(error.into());
    }
    let mut remaining = &compressed[10..];
    if flags & 4 != 0 {
        let (length, rest) = remaining.split_at_checked(2).ok_or(error)?;
        let extra_bytes = usize::from(u16::from_le_bytes([length[0], length[1]]));
        (_, remaining) = rest.split_at_checked(extra_bytes).ok_or(error)?;
    }
    for flag in [8, 16] {
        if flags & flag != 0 {
            let end = remaining.iter().position(|byte| *byte == 0).ok_or(error)?;
            remaining = &remaining[end + 1..];
        }
    }
    if flags & 2 != 0 {
        let header_bytes = compressed.len() - remaining.len();
        let (checksum, rest) = remaining.split_at_checked(2).ok_or(error)?;
        if u16::from_le_bytes([checksum[0], checksum[1]])
            != crc32fast::hash(&compressed[..header_bytes]) as u16
        {
            return Err(error.into());
        }
        remaining = rest;
    }
    Ok(remaining)
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn validate_path(path: &str) -> Result<()> {
    super::s3::validate_key(path)?;
    for segment in path.split('/') {
        let mut decoded = Vec::new();
        let bytes = segment.as_bytes();
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index] == b'%' {
                let hex = bytes
                    .get(index + 1..index + 3)
                    .ok_or("Invalid data path encoding")?;
                let text = std::str::from_utf8(hex).map_err(|_| "Invalid data path encoding")?;
                decoded
                    .push(u8::from_str_radix(text, 16).map_err(|_| "Invalid data path encoding")?);
                index += 3;
            } else {
                decoded.push(bytes[index]);
                index += 1;
            }
        }
        let decoded = std::str::from_utf8(&decoded).map_err(|_| "Invalid data path encoding")?;
        if decoded == "." || decoded == ".." || decoded.contains(['/', '\\']) {
            return Err("Invalid data path".into());
        }
    }
    Ok(())
}
fn content_type(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "json" => JSON_TYPE,
        "css" => "text/css; charset=utf-8",
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "svg" => "image/svg+xml",
        "xml" => "application/xml; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "png" => "image/png",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "webmanifest" => "application/manifest+json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests;
