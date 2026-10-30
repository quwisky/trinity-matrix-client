//! Settings the host gives the engine when it starts.

#[derive(Clone, Debug, Default)]
pub struct EngineConfig {
    /// Skips TLS certificate checks. Only the test host sets it, for the harness's self-signed
    /// certificate.
    pub insecure_tls: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_keeps_tls_verification() {
        assert!(!EngineConfig::default().insecure_tls);
    }
}
