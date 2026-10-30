//! Restoring a persisted session: its client's settings, and what a failed build means.
#![cfg_attr(
    not(test),
    expect(dead_code, reason = "restorePersisted uses it from T3 on")
)]

use matrix_sdk::{
    ClientBuildError,
    encryption::{BackupDownloadStrategy, EncryptionSettings},
};
#[cfg(feature = "native")]
use matrix_sdk::{ClientBuilder, SqliteStoreConfig};
use matrix_sdk_base::crypto::{CollectStrategy, DecryptionSettings, TrustRequirement};
#[cfg(feature = "native")]
use matrix_sdk_sqlite::OpenStoreError;

use super::MatrixSessionDto;
use crate::failure::{
    AccountStartFailureReason, EngineFailure, account_start_failed, classify_http,
};
#[cfg(feature = "native")]
use crate::{
    accounts::Engine,
    failure::{Diagnostic, FailureKind},
    store::StorePaths,
};

pub(crate) struct CryptoSettings {
    pub encryption: EncryptionSettings,
    pub recipients: CollectStrategy,
    pub decryption: DecryptionSettings,
}

pub(crate) fn crypto_settings() -> CryptoSettings {
    CryptoSettings {
        encryption: EncryptionSettings {
            auto_enable_cross_signing: false,
            backup_download_strategy: BackupDownloadStrategy::AfterDecryptionFailure,
            auto_enable_backups: false,
        },
        recipients: CollectStrategy::AllDevices,
        decryption: DecryptionSettings {
            sender_device_trust_requirement: TrustRequirement::Untrusted,
        },
    }
}

/// Whether the SDK may refresh the token: only an OAuth session with a refresh token can.
pub(crate) fn refreshable(s: &MatrixSessionDto) -> bool {
    s.oidc.is_some()
        && s.refresh_token
            .as_deref()
            .is_some_and(|token| !token.is_empty())
}

/// Every account and store setting, on top of the engine's transport-only builder.
#[cfg(feature = "native")]
pub(crate) fn account_builder(
    engine: &Engine,
    s: &MatrixSessionDto,
    paths: &StorePaths,
    key: &[u8; 32],
) -> ClientBuilder {
    let CryptoSettings {
        encryption,
        recipients,
        decryption,
    } = crypto_settings();
    let builder = engine
        .client_builder()
        .homeserver_url(&s.base_url)
        .sqlite_store_with_config_and_cache_path(
            SqliteStoreConfig::new(&paths.data).key(Some(key)),
            Some(&paths.cache),
        )
        .with_encryption_settings(encryption)
        .with_room_key_recipient_strategy(recipients)
        .with_decryption_settings(decryption)
        .with_enable_share_history_on_invite(true);
    if refreshable(s) {
        builder.handle_refresh_tokens()
    } else {
        builder
    }
}

/// The start failure a failed build is, or `None` for a fault.
pub(crate) fn start_failure(err: &ClientBuildError) -> Option<EngineFailure> {
    match err {
        #[cfg(feature = "native")]
        ClientBuildError::SqliteStore(err) => {
            let reason = match err {
                OpenStoreError::InitCipher(_) | OpenStoreError::LoadCipher(_) => {
                    AccountStartFailureReason::CryptoStoreKeyLost
                }
                _ => AccountStartFailureReason::CryptoFailure,
            };
            let kind = FailureKind::Unexpected;
            Some(account_start_failed(reason, kind, Diagnostic::new(kind)))
        }
        ClientBuildError::Http(err) => {
            let (kind, diagnostic) = classify_http(err);
            Some(account_start_failed(
                AccountStartFailureReason::TransientNetwork,
                kind,
                diagnostic,
            ))
        }
        _ => None,
    }
}

#[cfg(all(test, feature = "native"))]
mod tests {
    use std::fs;

    use matrix_sdk::{HttpError, RefreshTokenError};
    use serde_json::json;
    use tempfile::TempDir;

    use super::*;
    use crate::{config::EngineConfig, failure::FailureCode};

    fn session(oidc: bool, refresh_token: Option<&str>) -> MatrixSessionDto {
        let mut session = json!({
            "baseUrl": "http://127.0.0.1:1",
            "userId": "@a:b",
            "deviceId": "DEV",
            "accessToken": "at",
        });
        if oidc {
            session["oidc"] = json!({"issuer": "https://id.example", "clientId": "client"});
        }
        if let Some(token) = refresh_token {
            session["refreshToken"] = json!(token);
        }
        serde_json::from_value(session).unwrap()
    }

    fn engine(root: &TempDir) -> std::sync::Arc<Engine> {
        Engine::new(EngineConfig {
            data_dir: root.path().join("data"),
            cache_dir: root.path().join("cache"),
            ..EngineConfig::default()
        })
        .unwrap()
    }

    fn reason(failure: Option<EngineFailure>) -> Option<AccountStartFailureReason> {
        match failure?.code {
            FailureCode::AccountStartFailed { reason } => Some(reason),
            code => panic!("not account-start-failed: {code:?}"),
        }
    }

    #[test]
    fn crypto_settings_match_the_spec() {
        let CryptoSettings {
            encryption,
            recipients,
            decryption,
        } = crypto_settings();
        assert!(!encryption.auto_enable_cross_signing);
        assert_eq!(
            encryption.backup_download_strategy,
            BackupDownloadStrategy::AfterDecryptionFailure
        );
        assert!(!encryption.auto_enable_backups);
        assert_eq!(recipients, CollectStrategy::AllDevices);
        assert!(matches!(
            decryption.sender_device_trust_requirement,
            TrustRequirement::Untrusted
        ));
    }

    #[test]
    fn refreshable_needs_oidc_and_a_refresh_token() {
        assert!(!refreshable(&session(false, Some("r"))));
        assert!(!refreshable(&session(true, None)));
        assert!(!refreshable(&session(true, Some(""))));
        assert!(refreshable(&session(true, Some("r"))));
    }

    #[tokio::test]
    async fn the_built_client_decrypts_untrusted() {
        let root = TempDir::new().unwrap();
        let engine = engine(&root);
        let s = session(false, None);
        let paths = StorePaths::new(&engine.config, &s.user_id, &s.device_id);
        let client = account_builder(&engine, &s, &paths, &[1; 32])
            .build()
            .await
            .unwrap();
        assert!(matches!(
            client.decryption_settings().sender_device_trust_requirement,
            TrustRequirement::Untrusted
        ));
        assert!(fs::read_dir(&paths.data).unwrap().next().is_some());
        assert!(fs::read_dir(&paths.cache).unwrap().next().is_some());
    }

    /// The builder's `Debug` is the only read-back of the settings that `build` does not expose.
    #[test]
    fn the_builder_carries_every_account_setting_but_not_the_key() {
        let root = TempDir::new().unwrap();
        let engine = engine(&root);
        let key = [0xab; 32];
        let debug = |s: &MatrixSessionDto| {
            let paths = StorePaths::new(&engine.config, &s.user_id, &s.device_id);
            format!("{:?}", account_builder(&engine, s, &paths, &key))
        };
        let password = debug(&session(false, None));
        for setting in [
            "auto_enable_cross_signing: false",
            "backup_download_strategy: AfterDecryptionFailure",
            "auto_enable_backups: false",
            "room_key_recipient_strategy: AllDevices",
            "enable_share_history_on_invite: true",
            "sender_device_trust_requirement: Untrusted",
            "handle_refresh_tokens: false",
        ] {
            assert!(password.contains(setting), "{setting}");
        }
        assert!(debug(&session(true, Some("r"))).contains("handle_refresh_tokens: true"));
        assert!(!password.contains(&format!("{key:?}")));
        assert!(!password.to_lowercase().contains(&"ab".repeat(32)));
    }

    #[tokio::test]
    async fn a_store_opened_with_another_key_is_crypto_store_key_lost() {
        let root = TempDir::new().unwrap();
        let engine = engine(&root);
        let s = session(false, None);
        let paths = StorePaths::new(&engine.config, &s.user_id, &s.device_id);
        let first = account_builder(&engine, &s, &paths, &[1; 32]).build().await;
        drop(first.unwrap());
        let err = account_builder(&engine, &s, &paths, &[2; 32])
            .build()
            .await
            .unwrap_err();
        assert_eq!(
            reason(start_failure(&err)),
            Some(AccountStartFailureReason::CryptoStoreKeyLost),
            "{err:?}"
        );
    }

    #[test]
    fn start_failure_sorts_the_other_build_errors() {
        let store = ClientBuildError::SqliteStore(OpenStoreError::MissingVersion);
        assert_eq!(
            reason(start_failure(&store)),
            Some(AccountStartFailureReason::CryptoFailure)
        );
        let http = HttpError::RefreshToken(RefreshTokenError::RefreshTokenRequired);
        let kind = classify_http(&http).0;
        let failure = start_failure(&ClientBuildError::Http(http)).unwrap();
        assert_eq!(failure.kind, kind);
        assert_eq!(
            reason(Some(failure)),
            Some(AccountStartFailureReason::TransientNetwork)
        );
        assert!(start_failure(&ClientBuildError::MissingHomeserver).is_none());
        let unexpected = start_failure(&ClientBuildError::SqliteStore(
            OpenStoreError::InvalidVersion,
        ))
        .unwrap();
        assert_eq!(unexpected.kind, FailureKind::Unexpected);
    }

    #[tokio::test]
    async fn client_builder_creates_no_store_under_the_data_dir() {
        let root = TempDir::new().unwrap();
        let engine = engine(&root);
        fs::create_dir_all(&engine.config.data_dir).unwrap();
        engine
            .client_builder()
            .homeserver_url("http://127.0.0.1:1")
            .build()
            .await
            .unwrap();
        assert!(
            fs::read_dir(&engine.config.data_dir)
                .unwrap()
                .next()
                .is_none()
        );
    }
}
