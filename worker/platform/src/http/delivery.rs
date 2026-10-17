use std::fs::{File, Metadata};
use std::io;
use std::os::fd::OwnedFd;
use std::path::{Component, Path};
use std::sync::Arc;

use hyper::header::HeaderValue;
use rustix::fs::{Mode, OFlags, open, openat};
use tokio::sync::Semaphore;

use super::LocalDataOptions;

pub(super) struct LocalData {
    root: Arc<LocalRoot>,
    metadata_slots: Arc<Semaphore>,
}

struct LocalRoot {
    directory: OwnedFd,
}

struct OpenedFile {
    _file: File,
    _metadata: Metadata,
}

#[derive(PartialEq)]
pub(super) enum LocalReadiness {
    Ready,
    Missing,
    Unavailable,
}

impl LocalReadiness {
    pub(super) fn label(&self) -> &'static str {
        match self {
            Self::Ready => "local",
            Self::Missing => "missing",
            Self::Unavailable => "unavailable",
        }
    }
}

impl LocalData {
    pub(super) fn open(options: &LocalDataOptions) -> io::Result<Self> {
        for value in [&options.data_cache_control, &options.manifest_cache_control] {
            HeaderValue::from_str(value)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
        }
        Ok(Self {
            root: Arc::new(LocalRoot::open(&options.data_root)?),
            metadata_slots: Arc::new(Semaphore::new(64)),
        })
    }

    pub(super) async fn readiness(&self) -> LocalReadiness {
        let permit = self.metadata_slots.clone().acquire_owned().await.unwrap();
        let root = self.root.clone();
        match tokio::task::spawn_blocking(move || {
            let _permit = permit;
            root.open_file("ranking-summary.json")
        })
        .await
        {
            Ok(Ok(_)) => LocalReadiness::Ready,
            Ok(Err(error))
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound
                        | io::ErrorKind::PermissionDenied
                        | io::ErrorKind::InvalidInput
                        | io::ErrorKind::NotADirectory
                ) || error.raw_os_error() == Some(rustix::io::Errno::LOOP.raw_os_error()) =>
            {
                LocalReadiness::Missing
            }
            _ => LocalReadiness::Unavailable,
        }
    }
}

impl LocalRoot {
    fn open(path: &Path) -> io::Result<Self> {
        let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let mut directory = open(
            if path.is_absolute() { "/" } else { "." },
            flags,
            Mode::empty(),
        )?;
        for component in path.components() {
            let name = match component {
                Component::RootDir | Component::CurDir => continue,
                Component::ParentDir => std::ffi::OsStr::new(".."),
                Component::Normal(name) => name,
                Component::Prefix(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "unsupported root",
                    ));
                }
            };
            directory = openat(&directory, name, flags, Mode::empty())?;
        }
        Ok(Self { directory })
    }

    fn open_file(&self, name: &str) -> io::Result<OpenedFile> {
        let descriptor = openat(
            &self.directory,
            name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::empty(),
        )?;
        let file = File::from(descriptor);
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "not a regular file",
            ));
        }
        Ok(OpenedFile {
            _file: file,
            _metadata: metadata,
        })
    }
}
