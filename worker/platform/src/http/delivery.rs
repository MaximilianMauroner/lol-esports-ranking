use std::ffi::CString;
use std::fs::{File, Metadata};
use std::io;
use std::os::fd::OwnedFd;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_compression::tokio::bufread::GzipEncoder;
use bytes::Bytes;
use futures_util::TryStreamExt;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::{Body as _, Frame, Incoming};
use hyper::{HeaderMap, Method, Request, Response, StatusCode, Uri};
use rustix::fs::{Mode, OFlags, open, openat};
use serde_json::json;
use tokio::io::{AsyncRead, AsyncReadExt, BufReader, ReadBuf};
use tokio::sync::Semaphore;
use tokio_util::io::ReaderStream;

use super::Body;

pub(super) struct LocalData {
    root: Arc<LocalRoot>,
    metadata_slots: Arc<Semaphore>,
}

struct LocalRoot {
    directory: OwnedFd,
}

struct RelativeFile {
    segments: Vec<CString>,
}

struct Sha256(RelativeFile);

enum Artifact {
    Logical(RelativeFile),
    Immutable(Sha256),
}

enum Route {
    Live,
    Ready,
    Artifact(Artifact),
    Missing,
}

struct OpenedFile {
    file: File,
    metadata: Metadata,
}

#[derive(Debug, PartialEq)]
enum LocalReadiness {
    Accessible,
    Missing,
    Unavailable,
}

#[derive(Debug, PartialEq)]
enum Coding {
    Identity,
    Gzip,
}

impl LocalReadiness {
    fn label(&self) -> &'static str {
        match self {
            Self::Accessible => "accessible",
            Self::Missing => "missing",
            Self::Unavailable => "unavailable",
        }
    }
}

impl LocalData {
    pub(super) fn open(root: &Path) -> io::Result<Self> {
        Ok(Self {
            root: Arc::new(LocalRoot::open(root)?),
            metadata_slots: Arc::new(Semaphore::new(64)),
        })
    }

    async fn open_file(&self, artifact: Artifact) -> io::Result<(Artifact, OpenedFile)> {
        let permit = self.metadata_slots.clone().acquire_owned().await.unwrap();
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let opened = root.open_file(&artifact)?;
            Ok((artifact, opened))
        })
        .await
        .map_err(io::Error::other)?
    }

    async fn readiness(&self) -> LocalReadiness {
        match self.open_file(Artifact::summary()).await {
            Ok(_) => LocalReadiness::Accessible,
            Err(error) if missing_entry(&error) => LocalReadiness::Missing,
            Err(error) => {
                eprintln!("Summary open failed: {error}");
                LocalReadiness::Unavailable
            }
        }
    }

    pub(super) async fn respond(&self, request: Request<Incoming>) -> Response<Body> {
        let head = request.method() == Method::HEAD;
        let unread = request.headers().contains_key("transfer-encoding")
            || request
                .headers()
                .get_all("content-length")
                .iter()
                .any(|value| {
                    value
                        .to_str()
                        .ok()
                        .and_then(|value| value.parse::<u64>().ok())
                        != Some(0)
                })
            || !request.body().is_end_stream();
        let mut response = if request.method() != Method::GET && !head {
            let mut response = json_response(
                StatusCode::METHOD_NOT_ALLOWED,
                json!({"ok": false, "error": "Method not allowed"}),
                head,
            );
            response
                .headers_mut()
                .insert("allow", "GET, HEAD".parse().unwrap());
            response
        } else if unread {
            json_response(
                StatusCode::BAD_REQUEST,
                json!({"ok": false, "error": "Request body not allowed"}),
                head,
            )
        } else {
            self.deliver(request.uri(), request.headers(), head).await
        };
        if unread {
            response
                .headers_mut()
                .insert("connection", "close".parse().unwrap());
        }
        response
    }

    async fn deliver(&self, uri: &Uri, headers: &HeaderMap, head: bool) -> Response<Body> {
        let artifact = match classify(uri) {
            Ok(Route::Artifact(artifact)) => artifact,
            Ok(Route::Live) => return json_response(StatusCode::OK, json!({"ok": true}), head),
            Ok(Route::Ready) => {
                let readiness = self.readiness().await;
                let ok = readiness == LocalReadiness::Accessible;
                return json_response(
                    if ok {
                        StatusCode::OK
                    } else {
                        StatusCode::SERVICE_UNAVAILABLE
                    },
                    json!({"ok": ok, "scope": "local-summary-access", "data": readiness.label()}),
                    head,
                );
            }
            Ok(Route::Missing) => {
                return json_response(
                    StatusCode::NOT_FOUND,
                    json!({"ok": false, "error": "Not found"}),
                    head,
                );
            }
            Err(()) => {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    json!({"ok": false, "error": "Invalid data path"}),
                    head,
                );
            }
        };
        let (artifact, opened) = match self.open_file(artifact).await {
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
        let media_type = artifact.media_type();
        let compressible = compressible(media_type);
        let coding = match select_coding(headers, compressible) {
            Ok(coding) => coding,
            Err(()) => {
                let mut response = json_response(
                    StatusCode::NOT_ACCEPTABLE,
                    json!({"ok": false, "error": "No acceptable representation"}),
                    head,
                );
                if compressible {
                    response
                        .headers_mut()
                        .insert("vary", "Accept-Encoding".parse().unwrap());
                }
                return response;
            }
        };
        let length = opened.metadata.len();
        let etag = local_etag(&opened.metadata);
        let modified = http_modified(&opened.metadata);
        let fresh = is_fresh(headers, &etag, modified);
        let mut response = Response::builder()
            .status(if fresh {
                StatusCode::NOT_MODIFIED
            } else {
                StatusCode::OK
            })
            .header("Content-Type", media_type)
            .header("Cache-Control", artifact.cache_control())
            .header("ETag", etag);
        if let Some(modified) = modified {
            response = response.header("Last-Modified", httpdate::fmt_http_date(modified));
        }
        if compressible {
            response = response.header("Vary", "Accept-Encoding");
        }
        if coding == Coding::Gzip {
            response = response.header("Content-Encoding", "gzip");
        } else if !fresh {
            response = response.header("Content-Length", length);
        }
        let body = if head || fresh {
            empty_body()
        } else {
            let file = ExactFile {
                file: tokio::fs::File::from_std(opened.file).take(length),
            };
            let reader: Box<dyn AsyncRead + Send + Unpin> = if coding == Coding::Gzip {
                Box::new(GzipEncoder::new(BufReader::with_capacity(64 * 1024, file)))
            } else {
                Box::new(file)
            };
            StreamBody::new(
                ReaderStream::with_capacity(reader, 64 * 1024)
                    .inspect_err(|error| eprintln!("Data stream failed: {error}"))
                    .map_ok(Frame::data),
            )
            .boxed_unsync()
        };
        response.body(body).unwrap()
    }
}

fn classify(uri: &Uri) -> Result<Route, ()> {
    if uri.scheme_str().is_some_and(|scheme| scheme != "http")
        || (uri.scheme().is_none() && uri.authority().is_some())
        || !uri.path().starts_with('/')
    {
        return Err(());
    }
    match uri.path() {
        "/api/live" => Ok(Route::Live),
        "/api/ready" => Ok(Route::Ready),
        path if path.starts_with("/data/") => {
            let relative = RelativeFile::parse(&path[6..])?;
            if relative.segments[0].as_bytes() == b"objects" {
                let digest = path.strip_prefix("/data/objects/sha256/").ok_or(())?;
                if digest.len() != 64
                    || !digest
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                {
                    return Err(());
                }
                Ok(Route::Artifact(Artifact::Immutable(Sha256(relative))))
            } else {
                Ok(Route::Artifact(Artifact::Logical(relative)))
            }
        }
        _ => Ok(Route::Missing),
    }
}

impl RelativeFile {
    fn parse(path: &str) -> Result<Self, ()> {
        let segments = path
            .split('/')
            .map(|segment| {
                let mut decoded = Vec::with_capacity(segment.len());
                let mut bytes = segment.bytes();
                while let Some(byte) = bytes.next() {
                    decoded.push(if byte == b'%' {
                        (hex(bytes.next().ok_or(())?)? << 4) | hex(bytes.next().ok_or(())?)?
                    } else {
                        byte
                    });
                }
                let value = String::from_utf8(decoded).map_err(|_| ())?;
                if value.is_empty()
                    || value == "."
                    || value == ".."
                    || value
                        .chars()
                        .any(|ch| ch.is_control() || ch == '/' || ch == '\\')
                {
                    return Err(());
                }
                CString::new(value).map_err(|_| ())
            })
            .collect::<Result<Vec<_>, ()>>()?;
        Ok(Self { segments })
    }
}

fn hex(byte: u8) -> Result<u8, ()> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(()),
    }
}

impl Artifact {
    fn summary() -> Self {
        Self::Logical(RelativeFile::parse("ranking-summary.json").unwrap())
    }

    fn relative_file(&self) -> &RelativeFile {
        match self {
            Self::Logical(relative) | Self::Immutable(Sha256(relative)) => relative,
        }
    }

    fn cache_control(&self) -> &'static str {
        match self {
            Self::Logical(_) => "no-cache",
            Self::Immutable(_) => "public, max-age=31536000, immutable",
        }
    }

    fn media_type(&self) -> &'static str {
        match self {
            Self::Logical(relative) => {
                media_type(relative.segments.last().unwrap().to_str().unwrap())
            }
            Self::Immutable(_) => "application/octet-stream",
        }
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

    fn open_file(&self, path: &Artifact) -> io::Result<OpenedFile> {
        let relative = path.relative_file();
        let (leaf, ancestors) = relative.segments.split_last().unwrap();
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

fn missing_entry(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::InvalidInput | io::ErrorKind::NotADirectory
    ) || error.raw_os_error() == Some(rustix::io::Errno::LOOP.raw_os_error())
}

fn local_etag(metadata: &Metadata) -> String {
    format!(
        "W/\"{:x}-{:x}-{:x}-{:x}-{:x}-{:x}-{:x}\"",
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec()
    )
}

fn http_modified(metadata: &Metadata) -> Option<SystemTime> {
    let seconds = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs();
    (seconds < 253_402_300_800).then(|| UNIX_EPOCH + Duration::from_secs(seconds))
}

fn is_fresh(headers: &HeaderMap, etag: &str, modified: Option<SystemTime>) -> bool {
    if headers.contains_key("if-none-match") {
        return headers
            .get_all("if-none-match")
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(','))
            .map(str::trim)
            .any(|tag| {
                tag == "*"
                    || tag.strip_prefix("W/").unwrap_or(tag)
                        == etag.strip_prefix("W/").unwrap_or(etag)
            });
    }
    modified.is_some_and(|modified| {
        headers
            .get("if-modified-since")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| httpdate::parse_http_date(value).ok())
            .is_some_and(|since| modified <= since)
    })
}

fn select_coding(headers: &HeaderMap, compressible: bool) -> Result<Coding, ()> {
    let mut gzip = None;
    let mut identity = None;
    let mut wildcard = None;
    for value in headers.get_all("accept-encoding").iter() {
        let Ok(value) = value.to_str() else {
            return Err(());
        };
        for entry in value.split(',') {
            let mut parts = entry.trim().split(';');
            let name = parts.next().unwrap().trim();
            if name.is_empty() {
                continue;
            }
            let quality = match parts.next() {
                None => 1000,
                Some(parameter) => parameter
                    .trim()
                    .split_once('=')
                    .filter(|(name, _)| name.trim().eq_ignore_ascii_case("q"))
                    .and_then(|(_, value)| quality(value.trim()))
                    .unwrap_or(0),
            };
            let quality = if parts.next().is_some() { 0 } else { quality };
            let slot = if name.eq_ignore_ascii_case("gzip") {
                &mut gzip
            } else if name.eq_ignore_ascii_case("identity") {
                &mut identity
            } else if name == "*" {
                &mut wildcard
            } else {
                continue;
            };
            *slot = Some(slot.unwrap_or(1000).min(quality));
        }
    }
    let identity = identity.unwrap_or(if wildcard == Some(0) { 0 } else { 1000 });
    let gzip = if compressible {
        gzip.or(wildcard).unwrap_or(0)
    } else {
        0
    };
    if gzip > 0 && gzip >= identity {
        Ok(Coding::Gzip)
    } else if identity > 0 {
        Ok(Coding::Identity)
    } else {
        Err(())
    }
}

fn quality(value: &str) -> Option<u16> {
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if !matches!(whole, "0" | "1")
        || fraction.len() > 3
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let fraction = fraction.parse::<u16>().unwrap_or(0) * 10u16.pow((3 - fraction.len()) as u32);
    match whole {
        "0" => Some(fraction),
        "1" if fraction == 0 => Some(1000),
        _ => None,
    }
}

fn json_response(status: StatusCode, value: serde_json::Value, head: bool) -> Response<Body> {
    let bytes = format!("{value}\n");
    let mut response = Response::builder()
        .status(status)
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header("Content-Length", bytes.len());
    if status == StatusCode::NOT_FOUND {
        response = response.header("X-Robots-Tag", "noindex");
    }
    response
        .body(
            Full::new(if head {
                Bytes::new()
            } else {
                Bytes::from(bytes)
            })
            .map_err(|never| match never {})
            .boxed_unsync(),
        )
        .unwrap()
}

struct ExactFile {
    file: tokio::io::Take<tokio::fs::File>,
}

impl AsyncRead for ExactFile {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buffer.filled().len();
        let expects_bytes = self.file.limit() > 0 && buffer.remaining() > 0;
        match Pin::new(&mut self.file).poll_read(context, buffer) {
            Poll::Ready(Ok(())) if expects_bytes && buffer.filled().len() == before => {
                Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "artifact shortened during read",
                )))
            }
            result => result,
        }
    }
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
