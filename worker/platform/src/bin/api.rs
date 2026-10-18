#![forbid(unsafe_code)]

// TODO(review): Have Opus review this native HTTP slice before production activation.

use std::io::{self, Write};
use std::net::SocketAddr;
use std::path::PathBuf;

use league_platform::LocalDataServer;
use tokio::signal::unix::{SignalKind, signal};

#[tokio::main(worker_threads = 2)]
async fn main() -> io::Result<()> {
    let Some((root, listen)) = parse_options()? else {
        return Ok(());
    };
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    let server = LocalDataServer::bind(root, listen).await?;
    {
        let mut output = io::stdout().lock();
        writeln!(
            output,
            "{}",
            serde_json::json!({"event": "listening", "address": server.local_addr().to_string()})
        )?;
        output.flush()?;
    }
    server
        .run_until(async move {
            tokio::select! { _ = interrupt.recv() => {}, _ = terminate.recv() => {} }
        })
        .await
}

fn parse_options() -> io::Result<Option<(PathBuf, SocketAddr)>> {
    let mut arguments = std::env::args_os().skip(1).peekable();
    if arguments.peek().is_some_and(|arg| arg == "--help") {
        arguments.next();
        if arguments.next().is_some() {
            return Err(invalid_options());
        }
        println!(
            "platform-api --data-root PATH [--listen LOOPBACK:PORT]\nDefault listen: 127.0.0.1:4174\nUnix local read-only HTTP service. Readiness checks only local summary access."
        );
        return Ok(None);
    }
    let mut root = None;
    let mut listen = None;
    while let Some(flag) = arguments.next() {
        let value = arguments.next().ok_or_else(invalid_options)?;
        if value.is_empty() || value.to_str().is_some_and(|value| value.starts_with("--")) {
            return Err(invalid_options());
        }
        if flag == "--data-root" && root.is_none() {
            root = Some(PathBuf::from(value));
        } else if flag == "--listen" && listen.is_none() {
            listen = Some(
                value
                    .to_str()
                    .ok_or_else(invalid_options)?
                    .parse::<SocketAddr>()
                    .map_err(|_| invalid_options())?,
            );
        } else {
            return Err(invalid_options());
        }
    }
    Ok(Some((
        root.ok_or_else(invalid_options)?,
        listen.unwrap_or_else(|| "127.0.0.1:4174".parse().unwrap()),
    )))
}

fn invalid_options() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "expected --data-root PATH and optional unique --listen LOOPBACK:PORT",
    )
}
