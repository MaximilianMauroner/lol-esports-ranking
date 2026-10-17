#![forbid(unsafe_code)]

// TODO(review): Have Opus review this native HTTP slice before production activation.

use std::io::{self, Write};

use league_platform::{LocalDataOptions, LocalDataServer};
use tokio::signal::unix::{SignalKind, signal};

#[tokio::main(worker_threads = 2)]
async fn main() -> io::Result<()> {
    let Some(options) = parse_options()? else {
        return Ok(());
    };
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    let server = LocalDataServer::bind(options).await?;
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

fn parse_options() -> io::Result<Option<LocalDataOptions>> {
    let mut options = LocalDataOptions::default();
    if let Some(root) = std::env::var_os("RANKING_PUBLIC_DATA_DIR") {
        options.data_root = root.into();
    }
    if let Ok(value) = std::env::var("RANKING_DATA_CACHE_CONTROL") {
        options.data_cache_control = value;
    }
    if let Ok(value) = std::env::var("RANKING_DATA_MANIFEST_CACHE_CONTROL") {
        options.manifest_cache_control = value;
    }
    options.gzip_enabled = std::env::var("RANKING_GZIP_ENABLED").as_deref() != Ok("false");
    options.commit = std::env::var("RAILWAY_GIT_COMMIT_SHA").ok();
    let mut arguments = std::env::args_os().skip(1);
    let mut root_seen = false;
    let mut listen_seen = false;
    while let Some(flag) = arguments.next() {
        if flag == "--help" {
            println!(
                "platform-api [--data-root PATH] [--listen LOOPBACK:PORT]\nDefaults: public/data, 127.0.0.1:4174\nUnix local read-only HTTP service. Readiness checks only local summary access."
            );
            return Ok(None);
        }
        let invalid = || {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "expected unique --data-root PATH or --listen LOOPBACK:PORT",
            )
        };
        if flag == "--data-root" && !root_seen {
            options.data_root = arguments.next().ok_or_else(invalid)?.into();
            root_seen = true;
        } else if flag == "--listen" && !listen_seen {
            let value = arguments.next().ok_or_else(invalid)?;
            options.listen = value
                .to_str()
                .ok_or_else(invalid)?
                .parse()
                .map_err(|_| invalid())?;
            listen_seen = true;
        } else {
            return Err(invalid());
        }
    }
    Ok(Some(options))
}
