use super::*;
use std::io::Read;
use std::os::unix::fs::symlink;

#[test]
fn pinned_directory_survives_path_replacement() {
    let fixture = tempfile::tempdir().unwrap();
    let original = fixture.path().join("original");
    let moved = fixture.path().join("moved");
    let external = fixture.path().join("external");
    std::fs::create_dir(&original).unwrap();
    std::fs::create_dir(&external).unwrap();
    std::fs::write(original.join("ranking-summary.json"), b"original").unwrap();
    std::fs::write(external.join("ranking-summary.json"), b"external secret").unwrap();
    let root = LocalRoot::open(&original).unwrap();
    std::fs::rename(&original, &moved).unwrap();
    symlink(&external, &original).unwrap();
    let mut opened = root.open_file(&Artifact::summary()).unwrap();
    let mut bytes = String::new();
    opened.file.read_to_string(&mut bytes).unwrap();
    assert_eq!(bytes, "original");
    assert_eq!(opened.metadata.len(), 8);
    assert!(LocalRoot::open(&original).is_err());
}

#[test]
fn file_metadata_and_bytes_remain_coupled_after_replacement() {
    let fixture = tempfile::tempdir().unwrap();
    let path = fixture.path().join("ranking-summary.json");
    std::fs::write(&path, b"old").unwrap();
    let root = LocalRoot::open(fixture.path()).unwrap();
    let mut opened = root.open_file(&Artifact::summary()).unwrap();
    std::fs::write(fixture.path().join("replacement"), b"replacement bytes").unwrap();
    std::fs::rename(fixture.path().join("replacement"), &path).unwrap();
    let mut bytes = Vec::new();
    opened.file.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"old");
    assert_eq!(opened.metadata.len(), bytes.len() as u64);
    assert_eq!(
        root.open_file(&Artifact::summary()).unwrap().metadata.len(),
        17
    );
}

#[test]
fn intermediate_symlinks_and_nonregular_leaves_are_refused() {
    let fixture = tempfile::tempdir().unwrap();
    std::fs::create_dir(fixture.path().join("inside")).unwrap();
    std::fs::write(fixture.path().join("inside/file.json"), b"secret").unwrap();
    symlink("inside", fixture.path().join("link")).unwrap();
    let root = LocalRoot::open(fixture.path()).unwrap();
    for request in ["/data/link/file.json", "/data/inside"] {
        let Route::Artifact(artifact) = classify(&request.parse().unwrap()).unwrap() else {
            panic!("artifact route");
        };
        assert!(root.open_file(&artifact).is_err());
    }
}

#[test]
fn metadata_validator_detects_atomic_replacement_with_same_size_and_mtime() {
    let fixture = tempfile::tempdir().unwrap();
    let path = fixture.path().join("ranking-summary.json");
    std::fs::write(&path, b"old").unwrap();
    let original = File::open(&path).unwrap();
    let modified = original.metadata().unwrap().modified().unwrap();
    let before = local_etag(&original.metadata().unwrap());
    let replacement = fixture.path().join("next");
    std::fs::write(&replacement, b"new").unwrap();
    File::options()
        .write(true)
        .open(&replacement)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    std::fs::rename(replacement, &path).unwrap();
    assert_ne!(local_etag(&std::fs::metadata(path).unwrap()), before);
}

#[test]
fn unsupported_http_dates_do_not_panic_or_invent_a_fallback() {
    let file = tempfile::tempfile().unwrap();
    file.set_times(std::fs::FileTimes::new().set_modified(UNIX_EPOCH - Duration::from_secs(1)))
        .unwrap();
    assert!(http_modified(&file.metadata().unwrap()).is_none());
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
        let fixture = tempfile::tempdir().unwrap();
        std::fs::write(fixture.path().join("ranking-summary.json"), b"{}").unwrap();
        let data = Arc::new(LocalData::open(fixture.path()).unwrap());
        let (release, held) = std::sync::mpsc::channel();
        let blocker = tokio::task::spawn_blocking(move || held.recv().unwrap());
        let mut requests = tokio::task::JoinSet::new();
        for _ in 0..64 {
            let data = data.clone();
            requests.spawn(async move { data.open_file(Artifact::summary()).await });
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
        assert_eq!(data.readiness().await, LocalReadiness::Accessible);
    });
}
