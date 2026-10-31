//! Settings the host gives the engine when it starts.

use std::{fmt, path::PathBuf, sync::Arc};

use zeroize::Zeroizing;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyUnavailable;

/// The store key, read per start: an app host's closure reads the OS keychain.
pub type StoreKey = Arc<dyn Fn() -> Result<Zeroizing<[u8; 32]>, KeyUnavailable> + Send + Sync>;

#[derive(Clone)]
pub struct EngineConfig {
    /// Skips TLS certificate checks. Only the test host sets it, for the harness's self-signed
    /// certificate.
    pub insecure_tls: bool,
    /// Holds each account's state and crypto stores.
    pub data_dir: PathBuf,
    /// Holds each account's event cache and media stores, which the OS may clear.
    pub cache_dir: PathBuf,
    pub store_key: StoreKey,
}

impl Default for EngineConfig {
    /// No key, so a default engine refuses every start before it touches a path.
    fn default() -> Self {
        Self {
            insecure_tls: false,
            data_dir: PathBuf::new(),
            cache_dir: PathBuf::new(),
            store_key: Arc::new(|| Err(KeyUnavailable)),
        }
    }
}

impl fmt::Debug for EngineConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EngineConfig")
            .field("insecure_tls", &self.insecure_tls)
            .field("data_dir", &self.data_dir)
            .field("cache_dir", &self.cache_dir)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_keeps_tls_verification_and_has_no_key() {
        let config = EngineConfig::default();
        assert!(!config.insecure_tls);
        assert_eq!((config.store_key)().err(), Some(KeyUnavailable));
    }

    #[test]
    fn debug_leaves_out_the_key() {
        let key = [0xab; 32];
        let config = EngineConfig {
            store_key: Arc::new(move || Ok(Zeroizing::new(key))),
            ..EngineConfig::default()
        };
        let debug = format!("{config:?}");
        assert!(!debug.contains("store_key"));
        assert!(!debug.contains(&format!("{key:?}")));
        assert!(!debug.to_lowercase().contains(&"ab".repeat(32)));
    }
}
