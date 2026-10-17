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
    let mut opened = root.open_file(&DataPath::summary()).unwrap();
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
    let mut opened = root.open_file(&DataPath::summary()).unwrap();
    std::fs::write(fixture.path().join("replacement"), b"replacement bytes").unwrap();
    std::fs::rename(fixture.path().join("replacement"), &path).unwrap();
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
    let fixture = tempfile::tempdir().unwrap();
    std::fs::create_dir(fixture.path().join("inside")).unwrap();
    std::fs::write(fixture.path().join("inside/file.json"), b"secret").unwrap();
    symlink("inside", fixture.path().join("link")).unwrap();
    let root = LocalRoot::open(fixture.path()).unwrap();
    for request in ["/data/link/file.json", "/data/inside"] {
        let target = RequestTarget::parse(&request.parse().unwrap()).unwrap();
        assert!(root.open_file(&DataPath::parse(&target).unwrap()).is_err());
    }
}
