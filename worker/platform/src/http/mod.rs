mod delivery;
mod target;

use std::convert::Infallible;
use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, combinators::UnsyncBoxBody};
use hyper::body::{Body as _, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::task::JoinSet;

pub struct LocalDataOptions {
    pub data_root: PathBuf,
    pub listen: SocketAddr,
    pub gzip_enabled: bool,
    pub data_cache_control: String,
    pub manifest_cache_control: String,
    pub commit: Option<String>,
}

impl Default for LocalDataOptions {
    fn default() -> Self {
        Self {
            data_root: "public/data".into(),
            listen: "127.0.0.1:4174".parse().unwrap(),
            gzip_enabled: true,
            data_cache_control: "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800, stale-if-error=604800".into(),
            manifest_cache_control: "public, max-age=0, s-maxage=300, stale-while-revalidate=3600, stale-if-error=86400".into(),
            commit: None,
        }
    }
}

pub struct LocalDataServer {
    listener: TcpListener,
    state: Arc<ServiceState>,
}

struct ServiceState {
    delivery: delivery::LocalData,
    commit: Option<String>,
}

impl LocalDataServer {
    pub async fn bind(options: LocalDataOptions) -> io::Result<Self> {
        if !options.listen.ip().is_loopback() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "listen address must be loopback",
            ));
        }
        let listen = options.listen;
        let state = tokio::task::spawn_blocking(move || {
            Ok::<_, io::Error>(ServiceState {
                delivery: delivery::LocalData::open(&options)?,
                commit: options.commit,
            })
        })
        .await
        .map_err(io::Error::other)??;
        Ok(Self {
            listener: TcpListener::bind(listen).await?,
            state: Arc::new(state),
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.listener.local_addr().expect("bound listener address")
    }

    pub async fn run_until(self, shutdown: impl Future<Output = ()> + Send) -> io::Result<()> {
        let mut tasks = JoinSet::new();
        let (drain, _) = watch::channel(false);
        tokio::pin!(shutdown);
        let result = loop {
            tokio::select! {
                biased;
                () = &mut shutdown => break Ok(()),
                Some(result) = tasks.join_next(), if !tasks.is_empty() => {
                    if let Err(error) = result { break Err(io::Error::other(error)); }
                }
                accepted = self.listener.accept(), if tasks.len() < 64 => {
                    let (socket, _) = match accepted {
                        Ok(accepted) => accepted,
                        Err(error) => break Err(error),
                    };
                    let state = self.state.clone();
                    let mut stopping = drain.subscribe();
                    tasks.spawn(async move {
                        let (socket, targets) = target::TargetIo::new(socket);
                        let service = service_fn(move |request| {
                            let raw = targets.lock().unwrap().take();
                            dispatch(state.clone(), request, raw)
                        });
                        let mut builder = http1::Builder::new();
                        builder.timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(10))
                            .max_headers(100).max_header_size(32 * 1024).max_buf_size(32 * 1024);
                        let connection = builder.serve_connection(TokioIo::new(socket), service);
                        tokio::pin!(connection);
                        let result = tokio::select! {
                            result = &mut connection => result,
                            _ = stopping.changed() => {
                                connection.as_mut().graceful_shutdown();
                                connection.await
                            }
                        };
                        if let Err(error) = result { eprintln!("HTTP connection failed: {error}"); }
                    });
                }
            }
        };
        drop(self.listener);
        let _ = drain.send(true);
        let drained = tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(result) = tasks.join_next().await {
                result.map_err(io::Error::other)?;
            }
            Ok::<_, io::Error>(())
        })
        .await;
        match drained {
            Ok(drained) => {
                drained?;
                result
            }
            Err(_) => {
                tasks.abort_all();
                while tasks.join_next().await.is_some() {}
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "HTTP drain timed out",
                ))
            }
        }
    }
}

type Body = UnsyncBoxBody<Bytes, io::Error>;

async fn dispatch(
    state: Arc<ServiceState>,
    request: Request<Incoming>,
    raw: Option<target::RawTarget>,
) -> Result<Response<Body>, Infallible> {
    let head = request.method() == hyper::Method::HEAD;
    let close = raw.as_ref().is_none_or(|raw| raw.has_body) || !request.body().is_end_stream();
    let target = raw
        .as_ref()
        .and_then(|raw| delivery::RequestTarget::parse_raw(&raw.text));
    let path = target
        .as_ref()
        .map(|target| target.path.as_str())
        .unwrap_or("");
    let mut response = if raw.is_none() {
        json_response(
            StatusCode::BAD_REQUEST,
            json!({"ok": false, "error": "Invalid request target"}),
            head,
        )
    } else if path == "/api/live" {
        json_response(
            StatusCode::OK,
            json!({"ok": true, "commit": state.commit}),
            head,
        )
    } else if path == "/api/ready" {
        let ready = state.delivery.readiness().await;
        let ok = ready == delivery::LocalReadiness::Ready;
        json_response(
            if ok {
                StatusCode::OK
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            },
            json!({"ok": ok, "scope": "local-data", "data": ready.label()}),
            head,
        )
    } else if request.method() != hyper::Method::GET && !head {
        json_response(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({"ok": false, "error": "Method not allowed"}),
            head,
        )
    } else if path.starts_with("/data/") {
        state
            .delivery
            .respond(target.as_ref().unwrap(), head, request.headers())
            .await
    } else {
        json_response(
            StatusCode::NOT_FOUND,
            json!({"ok": false, "error": "Not found"}),
            head,
        )
    };
    if close {
        response
            .headers_mut()
            .insert(hyper::header::CONNECTION, "close".parse().unwrap());
    }
    Ok(response)
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
