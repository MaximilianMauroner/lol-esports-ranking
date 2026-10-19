use std::collections::VecDeque;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;

const LIMIT: usize = 32 * 1024;

pub(super) struct RawTarget {
    pub text: String,
    pub has_body: bool,
}

#[derive(Default)]
pub(super) struct Targets {
    ready: VecDeque<RawTarget>,
    queued_bytes: usize,
    line: Vec<u8>,
    target: Option<String>,
    header_bytes: usize,
    has_body: bool,
    stopped: bool,
}

impl Targets {
    pub fn take(&mut self) -> Option<RawTarget> {
        let target = self.ready.pop_front()?;
        self.queued_bytes -= target.text.len();
        Some(target)
    }

    fn observe(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            if self.stopped {
                break;
            }
            self.header_bytes += 1;
            if self.header_bytes > LIMIT {
                self.stopped = true;
                self.line.clear();
                break;
            }
            if byte != b'\n' {
                self.line.push(byte);
                continue;
            }
            let line = std::mem::take(&mut self.line);
            let line = line.strip_suffix(b"\r").unwrap_or(&line);
            if self.target.is_none() {
                if line.is_empty() {
                    continue;
                }
                self.target = std::str::from_utf8(line)
                    .ok()
                    .and_then(|line| line.split_ascii_whitespace().nth(1))
                    .map(str::to_owned);
                self.stopped = self.target.is_none();
            } else if line.is_empty() {
                let text = self.target.take().unwrap();
                self.queued_bytes += text.len();
                if self.queued_bytes > LIMIT {
                    self.stopped = true;
                    break;
                }
                self.ready.push_back(RawTarget {
                    text,
                    has_body: self.has_body,
                });
                self.stopped = self.has_body;
                self.header_bytes = 0;
            } else if let Some(colon) = line.iter().position(|&byte| byte == b':') {
                let name = &line[..colon];
                if name.eq_ignore_ascii_case(b"transfer-encoding") {
                    self.has_body = true;
                } else if name.eq_ignore_ascii_case(b"content-length") {
                    self.has_body |= std::str::from_utf8(&line[colon + 1..])
                        .ok()
                        .and_then(|value| value.trim().parse::<u64>().ok())
                        != Some(0);
                }
            }
        }
    }
}

// http::Uri discards literal fragments. Keep the wire target before Hyper parses it.
pub(super) struct TargetIo {
    socket: TcpStream,
    targets: Arc<Mutex<Targets>>,
}

impl TargetIo {
    pub fn new(socket: TcpStream) -> (Self, Arc<Mutex<Targets>>) {
        let targets = Arc::new(Mutex::new(Targets::default()));
        (
            Self {
                socket,
                targets: targets.clone(),
            },
            targets,
        )
    }
}

impl AsyncRead for TargetIo {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let previous = buffer.filled().len();
        let result = Pin::new(&mut self.socket).poll_read(cx, buffer);
        if matches!(result, Poll::Ready(Ok(()))) {
            self.targets
                .lock()
                .unwrap()
                .observe(&buffer.filled()[previous..]);
        }
        result
    }
}

impl AsyncWrite for TargetIo {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.socket).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_shutdown(cx)
    }
}
