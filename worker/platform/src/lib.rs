#![forbid(unsafe_code)]

#[cfg(not(unix))]
compile_error!("league-platform local HTTP requires Unix descriptor-relative file access");

mod http;

pub use http::LocalDataServer;
