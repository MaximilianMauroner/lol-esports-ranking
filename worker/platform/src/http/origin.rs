use std::io::Cursor;

use async_compression::tokio::bufread::GzipEncoder;
use bytes::Bytes;
use futures_util::TryStreamExt;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::Frame;
use hyper::header::HeaderValue;
use hyper::{HeaderMap, Response, StatusCode};
use ranking_storage::serving::{PublishedOrigin, ServedObject};
use serde_json::json;
use tokio::io::BufReader;
use tokio_util::io::ReaderStream;

use super::{Body, delivery, json_response};

pub(super) async fn respond(
    origin: &PublishedOrigin,
    target: &delivery::RequestTarget,
    head: bool,
    headers: &HeaderMap,
    cache: &HeaderValue,
    gzip_enabled: bool,
) -> Option<Response<Body>> {
    let path = target.path.strip_prefix("/data/").unwrap();
    let redirect = !target.force_proxy && delivery::immutable_path(&target.path);
    match origin
        .read(path, target.generation.as_deref(), head, redirect)
        .await
    {
        Ok(Some(object)) => Some(deliver(object, head, headers, cache, gzip_enabled)),
        Ok(None) if target.generation.is_some() => Some(json_response(
            StatusCode::NOT_FOUND,
            json!({"ok":false,"error":"Versioned data artifact not found"}),
            head,
        )),
        Err(error) => {
            eprintln!("Published data read failed: {error}");
            target.generation.as_ref().map(|_| {
                json_response(
                    StatusCode::BAD_GATEWAY,
                    json!({"ok":false,"error":"Versioned data artifact unavailable"}),
                    head,
                )
            })
        }
        Ok(None) => None,
    }
}

fn deliver(
    mut object: ServedObject,
    head: bool,
    headers: &HeaderMap,
    cache: &HeaderValue,
    gzip_enabled: bool,
) -> Response<Body> {
    if let Some(location) = object.redirect {
        return Response::builder()
            .status(StatusCode::TEMPORARY_REDIRECT)
            .header("Location", location)
            .header("Cache-Control", "private, no-store")
            .header("Content-Length", 0)
            .body(delivery::empty_body())
            .unwrap();
    }
    let modified = object
        .last_modified
        .as_deref()
        .and_then(|value| httpdate::parse_http_date(value).ok());
    let fresh = delivery::is_fresh(headers, object.etag.as_deref().unwrap_or(""), modified);
    let compressible = delivery::compressible(&object.content_type);
    let stored_gzip = object.content_encoding.as_deref() == Some("gzip");
    let gzip = !fresh
        && gzip_enabled
        && delivery::accepts_gzip(headers)
        && (stored_gzip || (!head && compressible && object.content_length >= 1024));
    let mut response = Response::builder()
        .status(if fresh {
            StatusCode::NOT_MODIFIED
        } else {
            StatusCode::OK
        })
        .header("Content-Type", object.content_type)
        .header("Cache-Control", cache);
    if let Some(etag) = object.etag {
        response = response.header("ETag", etag);
    }
    if let Some(modified) = object.last_modified {
        response = response.header("Last-Modified", modified);
    }
    if compressible {
        response = response.header("Vary", "Accept-Encoding");
    }
    if gzip {
        response = response.header("Content-Encoding", "gzip");
    }
    if !fresh && !(gzip && !stored_gzip) {
        let length = if stored_gzip && !gzip {
            object.semantic_length
        } else {
            Some(object.content_length)
        };
        if let Some(length) = length {
            response = response.header("Content-Length", length);
        }
    }
    if head || fresh {
        return response.body(delivery::empty_body()).unwrap();
    }
    let bytes = if stored_gzip && !gzip {
        Bytes::from_owner(
            object
                .semantic_body
                .take()
                .expect("verified gzip semantic body"),
        )
    } else {
        Bytes::from_owner(object.body)
    };
    let body = if gzip && !stored_gzip {
        let reader = GzipEncoder::new(BufReader::new(Cursor::new(bytes)));
        StreamBody::new(ReaderStream::with_capacity(reader, 64 * 1024).map_ok(Frame::data))
            .boxed_unsync()
    } else {
        Full::new(bytes)
            .map_err(|never| match never {})
            .boxed_unsync()
    };
    response.body(body).unwrap()
}
