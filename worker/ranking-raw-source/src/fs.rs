use crate::{Result, ensure};
use ranking_contracts::sha256;
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

pub fn absolute(path: impl AsRef<Path>) -> Result<PathBuf> {
    let path = path.as_ref();
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut result = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            _ => result.push(component),
        }
    }
    Ok(result)
}

pub fn manifest_path(value: &str, raw_dir: &Path) -> Result<PathBuf> {
    let source = Path::new(value);
    if !source.is_absolute() {
        return absolute(raw_dir.join(source));
    }
    let resolved = absolute(source)?;
    if resolved.starts_with(raw_dir) {
        return Ok(resolved);
    }
    let normalized = value.replace('\\', "/");
    let parts = normalized
        .split('/')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>();
    if let Some(index) = parts.windows(2).rposition(|p| p == ["data", "raw"]) {
        return absolute(
            parts[index + 2..]
                .iter()
                .fold(raw_dir.to_path_buf(), |path, part| path.join(part)),
        );
    }
    Ok(resolved)
}

pub fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?
        .write_all(bytes)?;
    Ok(())
}

pub fn remove_dir(path: &Path) -> Result<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub fn copy_verified(source: &Path, destination: &Path, digest: &str) -> Result<()> {
    // Read one provider file at a time. Recheck it after preparation before publishing.
    let bytes = fs::read(source)?;
    ensure(
        sha256(&bytes) == digest,
        "Prepared source changed before materialization",
    )?;
    write_new(destination, &bytes)
}

pub fn replace_directory(next: &Path, target: &Path) -> Result<()> {
    let previous = PathBuf::from(format!(
        "{}.previous-{}",
        target.display(),
        std::process::id()
    ));
    remove_dir(&previous)?;
    let has_previous = match fs::rename(target, &previous) {
        Ok(()) => true,
        Err(e) if e.raw_os_error() == Some(18) => {
            publish_across_filesystems(next, target)?;
            return Ok(());
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(e.into()),
    };
    if let Err(error) = fs::rename(next, target) {
        if has_previous {
            fs::rename(&previous, target)?;
        }
        return Err(error.into());
    }
    if has_previous {
        remove_dir(&previous)?;
    }
    Ok(())
}

fn publish_across_filesystems(next: &Path, target: &Path) -> Result<()> {
    let mut files = Vec::new();
    list_files(next, next, &mut files)?;
    files.sort_by_key(|p| p == Path::new("manifest.json"));
    for (index, relative) in files.iter().enumerate() {
        let destination = target.join(relative);
        fs::create_dir_all(destination.parent().ok_or("File has no parent")?)?;
        let temporary = PathBuf::from(format!(
            "{}.{}.{index}.tmp",
            destination.display(),
            std::process::id()
        ));
        let result = (|| -> Result<()> {
            fs::copy(next.join(relative), &temporary)?;
            fs::rename(&temporary, &destination)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;
    }
    remove_dir(next)
}

fn list_files(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            list_files(root, &entry.path(), files)?;
        } else if entry.file_type()?.is_file() {
            files.push(entry.path().strip_prefix(root)?.to_path_buf());
        }
    }
    Ok(())
}

pub fn peak_rss() -> Result<u64> {
    let mut status = String::new();
    fs::File::open("/proc/self/status")?.read_to_string(&mut status)?;
    let value = status
        .lines()
        .find_map(|line| line.strip_prefix("VmHWM:"))
        .ok_or("VmHWM unavailable")?;
    let kib: u64 = value
        .split_whitespace()
        .next()
        .ok_or("VmHWM is empty")?
        .parse()?;
    Ok(kib.checked_mul(1024).ok_or("VmHWM overflow")?)
}
