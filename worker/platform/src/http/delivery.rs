use std::ffi::CString;
use std::fs::{File, Metadata};
use std::io;
use std::os::fd::OwnedFd;
use std::path::{Component, Path};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use futures_util::TryStreamExt;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::Frame;
use hyper::header::HeaderValue;
use hyper::{Response, StatusCode, Uri};
use rustix::fs::{Mode, OFlags, open, openat};
use serde_json::json;
use tokio::io::AsyncReadExt;
use tokio::sync::Semaphore;
use tokio_util::io::ReaderStream;

use super::{Body, LocalDataOptions, json_response};

pub(super) struct LocalData {
    root: Arc<LocalRoot>,
    metadata_slots: Arc<Semaphore>,
    data_cache: HeaderValue,
    manifest_cache: HeaderValue,
}

struct LocalRoot {
    directory: OwnedFd,
}

struct DataPath {
    segments: Vec<CString>,
    cache: CacheClass,
    media_type: &'static str,
}

enum CacheClass {
    Summary,
    ImmutableObject,
    Data,
}

struct OpenedFile {
    file: File,
    metadata: Metadata,
}

#[derive(PartialEq)]
pub(super) enum LocalReadiness {
    Ready,
    Missing,
    Unavailable,
}

pub(super) struct RequestTarget {
    raw_path: String,
    pub(super) path: String,
}

impl RequestTarget {
    pub(super) fn parse(uri: &Uri) -> Option<Self> {
        let raw = uri.to_string();
        if !raw.starts_with('/') && uri.scheme().is_none() {
            return None;
        }
        let base = url::Url::parse("http://local.invalid/").unwrap();
        let normalized = base.join(&raw).ok()?;
        Some(Self {
            raw_path: raw.split('?').next().unwrap().to_owned(),
            path: normalized.path().to_owned(),
        })
    }
}

impl LocalReadiness {
    pub(super) fn label(&self) -> &'static str {
        match self {
            Self::Ready => "local",
            Self::Missing => "missing",
            Self::Unavailable => "unavailable",
        }
    }
}

impl LocalData {
    pub(super) fn open(options: &LocalDataOptions) -> io::Result<Self> {
        let header = |value: &str| {
            HeaderValue::from_str(value)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))
        };
        Ok(Self {
            root: Arc::new(LocalRoot::open(&options.data_root)?),
            metadata_slots: Arc::new(Semaphore::new(64)),
            data_cache: header(&options.data_cache_control)?,
            manifest_cache: header(&options.manifest_cache_control)?,
        })
    }

    async fn open_file(&self, path: DataPath) -> io::Result<(DataPath, OpenedFile)> {
        let permit = self.metadata_slots.clone().acquire_owned().await.unwrap();
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let opened = root.open_file(&path)?;
            Ok((path, opened))
        })
        .await
        .map_err(io::Error::other)?
    }

    pub(super) async fn readiness(&self) -> LocalReadiness {
        match self.open_file(DataPath::summary()).await {
            Ok(_) => LocalReadiness::Ready,
            Err(error) if missing_entry(&error) => LocalReadiness::Missing,
            Err(_) => LocalReadiness::Unavailable,
        }
    }

    pub(super) async fn respond(&self, target: &RequestTarget, head: bool) -> Response<Body> {
        let Some(path) = DataPath::parse(target) else {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"ok": false, "error": "Invalid data path"}),
                head,
            );
        };
        let (path, opened) = match self.open_file(path).await {
            Ok(opened) => opened,
            Err(error) => {
                let (status, message) = if missing_entry(&error) {
                    (StatusCode::NOT_FOUND, "Not found")
                } else {
                    eprintln!("Data open failed: {error}");
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Data artifact unavailable",
                    )
                };
                return json_response(status, json!({"ok": false, "error": message}), head);
            }
        };
        let cache = match path.cache {
            CacheClass::Summary => self.manifest_cache.clone(),
            CacheClass::ImmutableObject => {
                HeaderValue::from_static("public, max-age=31536000, immutable")
            }
            CacheClass::Data => self.data_cache.clone(),
        };
        let length = opened.metadata.len();
        let mut response = Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", path.media_type)
            .header("Cache-Control", cache)
            .header("ETag", local_etag(&opened.metadata))
            .header(
                "Last-Modified",
                httpdate::fmt_http_date(opened.metadata.modified().unwrap_or(UNIX_EPOCH)),
            )
            .header("Content-Length", length);
        if compressible(path.media_type) {
            response = response.header("Vary", "Accept-Encoding");
        }
        let body = if head {
            empty_body()
        } else {
            let file = tokio::fs::File::from_std(opened.file).take(length);
            StreamBody::new(ReaderStream::with_capacity(file, 64 * 1024).map_ok(Frame::data))
                .boxed_unsync()
        };
        response.body(body).unwrap()
    }
}

impl LocalRoot {
    fn open(path: &Path) -> io::Result<Self> {
        let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let mut directory = open(
            if path.is_absolute() { "/" } else { "." },
            flags,
            Mode::empty(),
        )?;
        for component in path.components() {
            let name = match component {
                Component::RootDir | Component::CurDir => continue,
                Component::ParentDir => std::ffi::OsStr::new(".."),
                Component::Normal(name) => name,
                Component::Prefix(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "unsupported root",
                    ));
                }
            };
            directory = openat(&directory, name, flags, Mode::empty())?;
        }
        Ok(Self { directory })
    }

    fn open_file(&self, path: &DataPath) -> io::Result<OpenedFile> {
        let (leaf, ancestors) = path.segments.split_last().unwrap();
        let mut current = None;
        for segment in ancestors {
            current = Some(openat(
                current.as_ref().unwrap_or(&self.directory),
                segment.as_c_str(),
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )?);
        }
        let descriptor = openat(
            current.as_ref().unwrap_or(&self.directory),
            leaf.as_c_str(),
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::empty(),
        )?;
        let file = File::from(descriptor);
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "not a regular file",
            ));
        }
        Ok(OpenedFile { file, metadata })
    }
}

impl DataPath {
    fn summary() -> Self {
        Self::parse(&RequestTarget {
            raw_path: "/data/ranking-summary.json".into(),
            path: "/data/ranking-summary.json".into(),
        })
        .unwrap()
    }

    fn parse(target: &RequestTarget) -> Option<Self> {
        let relative = target.path.strip_prefix("/data/")?;
        if immutable_path(&target.path) && !immutable_path(&target.raw_path) {
            return None;
        }
        if target.raw_path.contains('%') {
            let mut decoded = target.raw_path.clone();
            for _ in 0..2 {
                decoded = decode_segment(&decoded)?;
                if decoded.contains("/objects/sha256/") {
                    return None;
                }
            }
        }
        let mut segments = Vec::new();
        for segment in relative.split('/') {
            let decoded = decode_segment(segment)?;
            if segment.is_empty()
                || decoded == "."
                || decoded == ".."
                || decoded.contains(['/', '\\'])
            {
                return None;
            }
            segments.push(CString::new(segment).ok()?);
        }
        let cache = if relative == "ranking-summary.json" {
            CacheClass::Summary
        } else if immutable_path(&target.path) {
            CacheClass::ImmutableObject
        } else {
            CacheClass::Data
        };
        Some(Self {
            segments,
            cache,
            media_type: media_type(relative),
        })
    }
}

fn decode_segment(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut position = 0;
    while position < bytes.len() {
        if bytes[position] == b'%' {
            if position + 2 >= bytes.len()
                || !bytes[position + 1].is_ascii_hexdigit()
                || !bytes[position + 2].is_ascii_hexdigit()
            {
                return None;
            }
            position += 3;
        } else {
            position += 1;
        }
    }
    percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .ok()
        .map(|value| value.into_owned())
}

fn immutable_path(path: &str) -> bool {
    path.strip_prefix("/data/objects/sha256/")
        .is_some_and(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}

fn missing_entry(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound
            | io::ErrorKind::PermissionDenied
            | io::ErrorKind::InvalidInput
            | io::ErrorKind::NotADirectory
    ) || error.raw_os_error() == Some(rustix::io::Errno::LOOP.raw_os_error())
}

fn local_etag(metadata: &Metadata) -> String {
    let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
    let milliseconds = match modified.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as i128,
        Err(error) => {
            let nanos = error.duration().as_nanos();
            -((nanos.div_ceil(1_000_000)) as i128)
        }
    };
    let timestamp = if milliseconds < 0 {
        format!("-{:x}", -milliseconds)
    } else {
        format!("{milliseconds:x}")
    };
    format!("W/\"{:x}-{timestamp}\"", metadata.len())
}

fn empty_body() -> Body {
    Full::new(Bytes::new())
        .map_err(|never| match never {})
        .boxed_unsync()
}

fn compressible(media_type: &str) -> bool {
    media_type.starts_with("application/json")
        || media_type.starts_with("text/")
        || media_type.starts_with("image/svg+xml")
        || media_type.starts_with("application/javascript")
}

fn media_type(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "css" => "text/css; charset=utf-8",
        "html" => "text/html; charset=utf-8",
        "ico" => "image/x-icon",
        "js" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "webmanifest" => "application/manifest+json; charset=utf-8",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "txt" => "text/plain; charset=utf-8",
        "webp" => "image/webp",
        "xml" => "application/xml; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests;
