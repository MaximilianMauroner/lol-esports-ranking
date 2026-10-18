mod delivery;

use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::combinators::UnsyncBoxBody;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::task::JoinSet;

pub struct LocalDataServer {
    listener: TcpListener,
    delivery: Arc<delivery::LocalData>,
}

impl LocalDataServer {
    pub async fn bind(root: impl AsRef<Path>, listen: SocketAddr) -> io::Result<Self> {
        if !listen.ip().is_loopback() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "listen address must be loopback",
            ));
        }
        let root = root.as_ref().to_owned();
        let delivery = tokio::task::spawn_blocking(move || delivery::LocalData::open(&root))
            .await
            .map_err(io::Error::other)??;
        Ok(Self {
            listener: TcpListener::bind(listen).await?,
            delivery: Arc::new(delivery),
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
                    let delivery = self.delivery.clone();
                    let mut stopping = drain.subscribe();
                    tasks.spawn(async move {
                        let service = service_fn(move |request| {
                            let delivery = delivery.clone();
                            async move { Ok::<_, std::convert::Infallible>(delivery.respond(request).await) }
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
