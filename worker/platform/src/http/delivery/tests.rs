use super::*;
use std::io::Read;
use std::os::unix::fs::symlink;

fn real_tempdir() -> (tempfile::TempDir, std::path::PathBuf) {
    let fixture = tempfile::tempdir().unwrap();
    let base = fixture.path().canonicalize().unwrap();
    (fixture, base)
}

#[test]
fn pinned_directory_survives_path_replacement() {
    let (_fixture, base) = real_tempdir();
    let original = base.join("original");
    let moved = base.join("moved");
    let external = base.join("external");
    std::fs::create_dir(&original).unwrap();
    std::fs::create_dir(&external).unwrap();
    std::fs::write(original.join("ranking-summary.json"), b"original").unwrap();
    std::fs::write(external.join("ranking-summary.json"), b"external secret").unwrap();
    let root = LocalRoot::open(&original).unwrap();
    std::fs::rename(&original, &moved).unwrap();
    symlink(&external, &original).unwrap();
    let mut opened = root.open_file(&DataPath::summary()).unwrap();
    let mut bytes = String::new();
    opened.file.read_to_string(&mut bytes).unwrap();
    assert_eq!(bytes, "original");
    assert_eq!(opened.metadata.len(), 8);
    assert!(LocalRoot::open(&original).is_err());
    std::fs::create_dir(external.join("nested")).unwrap();
    assert!(LocalRoot::open(&original.join("nested")).is_err());
}

#[test]
fn file_metadata_and_bytes_remain_coupled_after_replacement() {
    let (_fixture, base) = real_tempdir();
    let path = base.join("ranking-summary.json");
    std::fs::write(&path, b"old").unwrap();
    let root = LocalRoot::open(&base).unwrap();
    let mut opened = root.open_file(&DataPath::summary()).unwrap();
    std::fs::write(base.join("replacement"), b"replacement bytes").unwrap();
    std::fs::rename(base.join("replacement"), &path).unwrap();
    let mut bytes = Vec::new();
    opened.file.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"old");
    assert_eq!(opened.metadata.len(), bytes.len() as u64);
    assert_eq!(
        root.open_file(&DataPath::summary()).unwrap().metadata.len(),
        17
    );
}

#[test]
fn intermediate_symlinks_and_nonregular_leaves_are_refused() {
    let (_fixture, base) = real_tempdir();
    std::fs::create_dir(base.join("inside")).unwrap();
    std::fs::write(base.join("inside/file.json"), b"secret").unwrap();
    symlink("inside", base.join("link")).unwrap();
    let root = LocalRoot::open(&base).unwrap();
    for request in ["/data/link/file.json", "/data/inside"] {
        let target = RequestTarget::parse_raw(request).unwrap();
        assert!(root.open_file(&DataPath::parse(&target).unwrap()).is_err());
    }
}

#[test]
fn metadata_etag_floors_signed_submillisecond_times() {
    let fixture = tempfile::tempfile().unwrap();
    for (timestamp, expected) in [
        (
            UNIX_EPOCH + std::time::Duration::from_nanos(1_999_999),
            "W/\"0-1\"",
        ),
        (
            UNIX_EPOCH - std::time::Duration::from_nanos(1),
            "W/\"0--1\"",
        ),
    ] {
        fixture
            .set_times(std::fs::FileTimes::new().set_modified(timestamp))
            .unwrap();
        assert_eq!(local_etag(&fixture.metadata().unwrap()), expected);
    }
}

#[test]
fn cancelled_open_jobs_keep_admission_until_the_blocking_work_finishes() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (_fixture, base) = real_tempdir();
        std::fs::write(base.join("ranking-summary.json"), b"{}").unwrap();
        let data = Arc::new(
            LocalData::open(&LocalDataOptions {
                data_root: base,
                ..LocalDataOptions::default()
            })
            .unwrap(),
        );
        let (release, held) = std::sync::mpsc::channel();
        let blocker = tokio::task::spawn_blocking(move || held.recv().unwrap());
        let mut requests = tokio::task::JoinSet::new();
        for _ in 0..64 {
            let data = data.clone();
            requests.spawn(async move { data.open_file(DataPath::summary()).await });
        }
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while data.metadata_slots.available_permits() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        requests.abort_all();
        while requests.join_next().await.is_some() {}
        assert_eq!(data.metadata_slots.available_permits(), 0);
        release.send(()).unwrap();
        blocker.await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while data.metadata_slots.available_permits() != 64 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(data.readiness().await, LocalReadiness::Ready);
    });
}
