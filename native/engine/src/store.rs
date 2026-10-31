//! Where each account's SQLite stores live: `<dir>/<hashed user id>/<hashed device id>/` under
//! both the data and the cache dir, so no id reaches a file name.

use std::{
    fs, io,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

use sha2::{Digest, Sha256};

use crate::config::EngineConfig;

const REMOVE_ATTEMPTS: u32 = 10;
const REMOVE_RETRY_DELAY: Duration = Duration::from_millis(50);

pub(crate) struct StorePaths {
    pub data: PathBuf,
    pub cache: PathBuf,
}

impl StorePaths {
    pub(crate) fn new(config: &EngineConfig, user_id: &str, device_id: &str) -> Self {
        let device = |root: &Path| root.join(hashed(user_id)).join(hashed(device_id));
        Self {
            data: device(&config.data_dir),
            cache: device(&config.cache_dir),
        }
    }
}

/// Deletes every device's stores of `user_id`; an account without stores is no failure.
pub(crate) fn delete_account(config: &EngineConfig, user_id: &str) -> io::Result<()> {
    under_both_roots(config, user_id, remove_dir)
}

/// Deletes the stores of every device of `user_id` but `keep_device_id`.
pub(crate) fn prune_devices(
    config: &EngineConfig,
    user_id: &str,
    keep_device_id: &str,
) -> io::Result<()> {
    let keep = hashed(keep_device_id);
    under_both_roots(config, user_id, |account| {
        let devices = match fs::read_dir(account) {
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
            devices => devices?,
        };
        for device in devices {
            let device = device?;
            if device.file_name() != keep.as_str() {
                remove_dir(&device.path())?;
            }
        }
        Ok(())
    })
}

/// Removes `dir` and tries again while it is still there: a store opens and closes its SQLite
/// connections on tokio's blocking pool (deadpool-sync), so a store file can come back while
/// `remove_dir_all` runs. A missing `dir` is no failure.
fn remove_dir(dir: &Path) -> io::Result<()> {
    let mut removed = Ok(());
    for _ in 0..REMOVE_ATTEMPTS {
        removed = fs::remove_dir_all(dir);
        if let Ok(false) = dir.try_exists() {
            return Ok(());
        }
        thread::sleep(REMOVE_RETRY_DELAY);
    }
    removed.and(Err(io::ErrorKind::DirectoryNotEmpty.into()))
}

/// Runs `clean` on the account's dir under the data root and then the cache root, the second even
/// when the first fails, and returns the first failure. A root that is not absolute fails rather
/// than resolve against the working directory.
fn under_both_roots(
    config: &EngineConfig,
    user_id: &str,
    clean: impl Fn(&Path) -> io::Result<()>,
) -> io::Result<()> {
    let mut outcome = Ok(());
    for root in [&config.data_dir, &config.cache_dir] {
        let result = if root.is_absolute() {
            clean(&root.join(hashed(user_id)))
        } else {
            Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "the store root is not an absolute path",
            ))
        };
        outcome = outcome.and(result);
    }
    outcome
}

fn hashed(value: &str) -> String {
    hex::encode(Sha256::digest(value))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    fn config(root: &TempDir) -> EngineConfig {
        EngineConfig {
            data_dir: root.path().join("data"),
            cache_dir: root.path().join("cache"),
            ..EngineConfig::default()
        }
    }

    /// Creates both store dirs of a device, each with a file in it.
    fn create(config: &EngineConfig, user_id: &str, device_id: &str) -> StorePaths {
        let paths = StorePaths::new(config, user_id, device_id);
        for dir in [&paths.data, &paths.cache] {
            fs::create_dir_all(dir).unwrap();
            fs::write(dir.join("store.sqlite3"), b"x").unwrap();
        }
        paths
    }

    #[test]
    fn paths_hash_the_user_then_the_device_under_data_and_cache() {
        let root = TempDir::new().unwrap();
        let config = config(&root);
        let paths = StorePaths::new(&config, "@a:b", "DEV");
        assert_eq!(
            paths.data,
            config.data_dir.join(hashed("@a:b")).join(hashed("DEV"))
        );
        assert_eq!(
            paths.cache,
            config.cache_dir.join(hashed("@a:b")).join(hashed("DEV"))
        );
        let hash = hashed("@a:b");
        assert_eq!(hash.len(), 64);
        assert!(hash.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')));
        assert_ne!(hash, hashed("@a:c"));
    }

    #[test]
    fn delete_account_removes_every_device_and_ignores_a_missing_account() {
        let root = TempDir::new().unwrap();
        let config = config(&root);
        let one = create(&config, "@a:b", "ONE");
        let two = create(&config, "@a:b", "TWO");
        let other = create(&config, "@c:d", "ONE");
        delete_account(&config, "@a:b").unwrap();
        for dir in [&one.data, &one.cache, &two.data, &two.cache] {
            assert!(!dir.exists(), "{dir:?}");
        }
        assert!(!config.data_dir.join(hashed("@a:b")).exists());
        assert!(!config.cache_dir.join(hashed("@a:b")).exists());
        assert!(other.data.exists() && other.cache.exists());
        delete_account(&config, "@a:b").unwrap();
        delete_account(&config, "@never:seen").unwrap();
    }

    #[test]
    fn prune_devices_keeps_only_the_given_device() {
        let root = TempDir::new().unwrap();
        let config = config(&root);
        let old = create(&config, "@a:b", "OLD");
        let kept = create(&config, "@a:b", "NEW");
        let other = create(&config, "@c:d", "OLD");
        prune_devices(&config, "@a:b", "NEW").unwrap();
        assert!(!old.data.exists() && !old.cache.exists());
        assert!(kept.data.join("store.sqlite3").exists());
        assert!(kept.cache.join("store.sqlite3").exists());
        assert!(other.data.exists() && other.cache.exists());
        prune_devices(&config, "@never:seen", "NEW").unwrap();
    }

    #[test]
    fn an_empty_or_relative_root_is_refused() {
        let relative = EngineConfig {
            data_dir: "data".into(),
            cache_dir: "data/cache".into(),
            ..EngineConfig::default()
        };
        for config in [EngineConfig::default(), relative] {
            let deleted = delete_account(&config, "@a:b").unwrap_err();
            assert_eq!(deleted.kind(), io::ErrorKind::InvalidInput);
            let pruned = prune_devices(&config, "@a:b", "DEV").unwrap_err();
            assert_eq!(pruned.kind(), io::ErrorKind::InvalidInput);
        }
    }

    #[test]
    fn a_failure_under_data_still_cleans_the_cache() {
        let root = TempDir::new().unwrap();
        let old = create(&config(&root), "@a:b", "OLD");
        let kept = create(&config(&root), "@a:b", "NEW");
        let broken = EngineConfig {
            data_dir: "data".into(),
            ..config(&root)
        };
        assert!(prune_devices(&broken, "@a:b", "NEW").is_err());
        assert!(!old.cache.exists() && kept.cache.exists());
        assert!(old.data.exists());
        assert!(delete_account(&broken, "@a:b").is_err());
        assert!(!kept.cache.exists() && kept.data.exists());
    }
}
