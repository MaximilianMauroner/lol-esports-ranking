use league_platform::{LocalDataOptions, LocalDataServer};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn library_consumer_owns_a_real_listener_and_joins_shutdown() {
    let root = tempfile::tempdir().unwrap();
    let server = LocalDataServer::bind(LocalDataOptions {
        data_root: root.path().into(),
        listen: "127.0.0.1:0".parse().unwrap(),
        ..LocalDataOptions::default()
    })
    .await
    .unwrap();
    let address = server.local_addr();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(server.run_until(async {
        let _ = stopped.await;
    }));
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    socket
        .write_all(b"GET /api/live HTTP/1.1\r\nHost: local\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut bytes = Vec::new();
    socket.read_to_end(&mut bytes).await.unwrap();
    assert!(bytes.starts_with(b"HTTP/1.1 200"));
    assert!(String::from_utf8(bytes).unwrap().contains("\"ok\":true"));
    stop.send(()).unwrap();
    task.await.unwrap().unwrap();
    assert!(tokio::net::TcpStream::connect(address).await.is_err());
}

#[tokio::test]
async fn a_slow_body_cannot_keep_a_connection_beyond_its_delivery_deadline() {
    let root = tempfile::tempdir().unwrap();
    let size = 64 * 1024 * 1024;
    std::fs::File::create(root.path().join("slow.bin"))
        .unwrap()
        .set_len(size)
        .unwrap();
    let server = LocalDataServer::bind(LocalDataOptions {
        data_root: root.path().into(),
        listen: "127.0.0.1:0".parse().unwrap(),
        ..LocalDataOptions::default()
    })
    .await
    .unwrap();
    let address = server.local_addr();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(server.run_until(async {
        let _ = stopped.await;
    }));
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    socket
        .write_all(b"GET /data/slow.bin HTTP/1.1\r\nHost: local\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut first = [0; 4096];
    let count = socket.read(&mut first).await.unwrap();
    assert!(first[..count].starts_with(b"HTTP/1.1 200"));
    tokio::time::pause();
    tokio::time::advance(std::time::Duration::from_secs(61)).await;
    tokio::task::yield_now().await;
    tokio::time::resume();
    let mut tail = Vec::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        socket.read_to_end(&mut tail),
    )
    .await
    .unwrap()
    .unwrap();
    assert!((count + tail.len()) < size as usize);
    stop.send(()).unwrap();
    task.await.unwrap().unwrap();
}
