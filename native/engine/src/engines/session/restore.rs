//! Restoring a persisted session: its client's settings, the start that concurrent restores of
//! one account join, and what a failed start means.
// Without `native` there is no store to open, so the start and its settings go unused.
#![cfg_attr(not(feature = "native"), allow(dead_code, unused_imports))]

use std::{
    mem,
    panic::AssertUnwindSafe,
    sync::{Arc, atomic::Ordering},
};

use futures_util::{FutureExt, future::Shared};
use matrix_sdk::{
    AuthSession, BoxFuture, ClientBuildError, SessionMeta, SessionTokens,
    authentication::{
        matrix::MatrixSession,
        oauth::{ClientId, OAuthSession, UserSession},
    },
    encryption::{BackupDownloadStrategy, EncryptionSettings},
    executor::spawn,
    locks::Mutex,
    reqwest::Url,
    ruma::UserId,
};
#[cfg(feature = "native")]
use matrix_sdk::{ClientBuilder, SqliteStoreConfig};
use matrix_sdk_base::crypto::{CollectStrategy, DecryptionSettings, TrustRequirement};
#[cfg(feature = "native")]
use matrix_sdk_sqlite::OpenStoreError;
use matrix_sdk_ui::sync_service::SyncService;

use super::{
    MatrixSessionDto, PersistedAccountActivationDto,
    logout::{reload_tokens, save_tokens_callback},
    runtime::{AccountRuntime, stop_sync},
};
#[cfg(feature = "native")]
use crate::store::{StorePaths, prune_devices};
use crate::{
    accounts::{Engine, Stores},
    barrier::Barrier,
    failure::{
        AccountStartFailureReason, Diagnostic, EngineFailure, EngineResult, FailureCode,
        FailureKind, account_start_failed, classify_http,
    },
    wire::{Fault, FaultCode},
};

/// A start of one account, which every restore of it joins while the start runs.
pub(crate) struct StartState {
    outcome: Shared<BoxFuture<'static, StartOutcome>>,
    /// Restores still waiting for the outcome.
    waiting: usize,
    /// Whether a restore has received the outcome.
    delivered: bool,
    finished: Option<StartOutcome>,
}

/// The new client's generation, or why the start failed.
type StartOutcome = Result<u32, StartError>;

#[derive(Clone)]
enum StartError {
    Failure(EngineFailure),
    Fault(Fault),
}

/// A start that ended well but that no restore received or still awaits is undone: its caller
/// is gone and would never activate or roll it back.
fn must_roll_back(s: &StartState) -> bool {
    matches!(s.finished, Some(Ok(_))) && s.waiting == 0 && !s.delivered
}

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

/// The session's user and device, once its user id and base URL parse. A fault names the field,
/// never its value: the session carries tokens.
pub(crate) fn session_meta(method: &str, s: &MatrixSessionDto) -> Result<SessionMeta, Fault> {
    let malformed = |field: &str| {
        Fault::new(
            FaultCode::BadArgs,
            format!("{method}: {field} is malformed"),
        )
    };
    let meta = SessionMeta {
        user_id: UserId::parse(&s.user_id).map_err(|_| malformed("userId"))?,
        device_id: s.device_id.as_str().into(),
    };
    Url::parse(&s.base_url).map_err(|_| malformed("baseUrl"))?;
    Ok(meta)
}

/// The session `restore_session` takes for `s`: OAuth when it has a client id.
pub(crate) fn auth_session(s: &MatrixSessionDto, meta: SessionMeta) -> AuthSession {
    let tokens = SessionTokens {
        access_token: s.access_token.clone(),
        refresh_token: s.refresh_token.clone(),
    };
    match &s.oidc {
        Some(oidc) => {
            let client_id = ClientId::new(oidc.client_id.clone());
            let user = UserSession { meta, tokens };
            AuthSession::OAuth(Box::new(OAuthSession { client_id, user }))
        }
        None => AuthSession::Matrix(MatrixSession { meta, tokens }),
    }
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

impl Engine {
    /// Starts `s`, or joins the start of the same account already running, and replies once
    /// it has registered the client and, when asked, made it active, without waiting for a sync.
    pub(crate) async fn restore(
        self: &Arc<Self>,
        s: MatrixSessionDto,
        activation: PersistedAccountActivationDto,
    ) -> Result<EngineResult<()>, Fault> {
        let meta = session_meta("session.restorePersisted", &s)?;
        let account_id = s.user_id.clone();
        let (start, outcome) = self.join_start(s, meta);
        let mut waiter = Waiter {
            engine: Arc::clone(self),
            account_id,
            start,
            received: false,
        };
        let outcome = outcome.await;
        waiter.receive();
        match outcome {
            Ok(_) => {
                // Each caller's own, as js does: a joined start ran with the first caller's.
                if activation == PersistedAccountActivationDto::Activate {
                    self.set_active(&waiter.account_id).delivered().await;
                }
                Ok(EngineResult::Ok(()))
            }
            Err(StartError::Failure(failure)) => Ok(EngineResult::Err(failure)),
            Err(StartError::Fault(fault)) => Err(fault),
        }
    }

    /// The account's start in flight, joined, or a new one on its own task, which a closed
    /// restore cannot cut short.
    fn join_start(
        self: &Arc<Self>,
        s: MatrixSessionDto,
        meta: SessionMeta,
    ) -> (
        Arc<Mutex<StartState>>,
        Shared<BoxFuture<'static, StartOutcome>>,
    ) {
        let mut starting = self.starting.lock();
        if let Some(start) = starting.get(&s.user_id) {
            let mut state = start.lock();
            state.waiting += 1;
            return (Arc::clone(start), state.outcome.clone());
        }
        let account_id = s.user_id.clone();
        let engine = Arc::clone(self);
        let task = spawn(async move {
            let id = s.user_id.clone();
            let started = AssertUnwindSafe(engine.start(s, meta)).catch_unwind().await;
            let outcome = started.unwrap_or_else(|_| Err(panicked()));
            engine.finish_start(&id, &outcome);
            outcome
        });
        let outcome: BoxFuture<'static, StartOutcome> =
            Box::pin(task.map(|joined| joined.unwrap_or_else(|_| Err(panicked()))));
        let outcome = outcome.shared();
        let start = Arc::new(Mutex::new(StartState {
            outcome: outcome.clone(),
            waiting: 1,
            delivered: false,
            finished: None,
        }));
        starting.insert(account_id, Arc::clone(&start));
        (start, outcome)
    }

    /// Forgets the start, so a later restore starts again, and undoes it when nobody took it.
    fn finish_start(&self, account_id: &str, outcome: &StartOutcome) {
        let Some(start) = self.starting.lock().remove(account_id) else {
            return;
        };
        let mut state = start.lock();
        state.finished = Some(outcome.clone());
        if let (true, Ok(generation)) = (must_roll_back(&state), outcome) {
            drop(state);
            self.rollback_if_current(account_id, *generation);
        }
    }

    /// One start: the old client of the account goes first, then the new one is registered and
    /// syncing. Its effects are delivered before it ends.
    async fn start(self: &Arc<Self>, s: MatrixSessionDto, meta: SessionMeta) -> StartOutcome {
        let key = (self.config.store_key)()
            .map_err(|_| start_failed(AccountStartFailureReason::SecureStorageUnavailable))?;
        let mut barrier = {
            let mut state = self.state.lock();
            let previous = state.runtimes.remove(&s.user_id);
            state.registry.retire(&s.user_id);
            let barrier = state.publish_snapshot();
            drop(state);
            if previous.is_some() {
                drop(self.tear_down(&s.user_id, previous, Stores::Keep));
            }
            barrier
        };
        if let Some(teardown) = self.teardown_of(&s.user_id) {
            teardown.await;
        }
        let outcome = self.open(&s, meta, &key, &mut barrier).await;
        barrier.delivered().await;
        outcome
    }

    #[cfg(not(feature = "native"))]
    async fn open(
        self: &Arc<Self>,
        _: &MatrixSessionDto,
        _: SessionMeta,
        _: &[u8; 32],
        _: &mut Barrier,
    ) -> StartOutcome {
        // shortcut: no store backend without `native`; the wasm build adds one
        let diagnostic = "no store backend in this build";
        Err(StartError::Fault(Fault::new(
            FaultCode::Unsupported,
            diagnostic,
        )))
    }

    #[cfg(feature = "native")]
    async fn open(
        self: &Arc<Self>,
        s: &MatrixSessionDto,
        meta: SessionMeta,
        key: &[u8; 32],
        barrier: &mut Barrier,
    ) -> StartOutcome {
        let paths = StorePaths::new(&self.config, &s.user_id, &s.device_id);
        let client = match account_builder(self, s, &paths, key).build().await {
            Ok(client) => client,
            Err(err) => {
                let Some(failure) = start_failure(&err) else {
                    let diagnostic = "the client did not build";
                    return Err(StartError::Fault(start_fault(diagnostic)));
                };
                let lost = AccountStartFailureReason::CryptoStoreKeyLost;
                if failure.code == (FailureCode::AccountStartFailed { reason: lost }) {
                    let flagged = self.require_reauthentication(&s.user_id);
                    *barrier = mem::take(barrier).join(flagged);
                }
                return Err(StartError::Failure(failure));
            }
        };
        let save = save_tokens_callback(Arc::downgrade(self), s.user_id.clone(), s.lineage.clone());
        if client
            .set_session_callbacks(Box::new(reload_tokens), Box::new(save))
            .is_err()
        {
            let diagnostic = "the session callbacks were already set";
            return Err(StartError::Fault(start_fault(diagnostic)));
        }
        let changes = client.subscribe_to_session_changes();
        (client.restore_session(auth_session(s, meta)).await)
            .map_err(|_| failed_at("restore_session"))?;
        let sync_service = SyncService::builder(client.clone())
            .with_offline_mode()
            .build()
            .await
            .map_err(|_| failed_at("sync_service"))?;
        let sync_service = Arc::new(sync_service);
        let all_rooms = (sync_service.room_list_service().all_rooms().await)
            .map_err(|_| failed_at("room_list"))?;
        let (generation, registered) = {
            let mut state = self.state.lock();
            let signed_in_again = state.registry.is_soft_logged_out(&s.user_id);
            let generation = state.registry.register(&s.user_id, &s.device_id);
            let runtime = AccountRuntime::new(
                self,
                s,
                generation,
                client,
                Arc::clone(&sync_service),
                all_rooms,
                changes,
            );
            state.runtimes.insert(s.user_id.clone(), Arc::new(runtime));
            state.deaths.remove(&s.user_id);
            let notices = state.holds.registered(&s.user_id, signed_in_again);
            (generation, state.publish_snapshot().join(notices))
        };
        *barrier = mem::take(barrier).join(registered);
        // A logout since the registration revoked the token the sync would start with.
        if self.may_sync(&s.user_id, generation) {
            sync_service.start().await;
        }
        // Retired or signed out meanwhile, so a stop may have come before this start.
        if !self.may_sync(&s.user_id, generation) {
            stop_sync(&sync_service).await;
        }
        // shortcut: blocks the executor, as `delete_account_stores` does; upgrade with it.
        if let Err(err) = prune_devices(&self.config, &s.user_id, &s.device_id) {
            tracing::warn!(kind = ?err.kind(), "pruning an account's other devices failed");
        }
        Ok(generation)
    }

    /// Waits until no start of the account, or of any account for `None`, is in flight, then runs
    /// `act` while holding the start table. A start that begins after `act` awaits the teardown
    /// `act` queued, so a start never outlives a remove, stop or rollback that arrived during it.
    pub(crate) async fn after_starts<T>(
        &self,
        account_id: Option<&str>,
        act: impl FnOnce() -> T,
    ) -> T {
        loop {
            let outcomes = {
                let mut starting = self.starting.lock();
                // An outcome that is in has settled, even one whose task ended before
                // `finish_start` forgot it, so the loop never spins on it.
                starting.retain(|_, s| s.lock().outcome.peek().is_none());
                let matching = starting
                    .iter()
                    .filter(|(id, _)| account_id.is_none_or(|wanted| wanted == id.as_str()));
                let outcomes: Vec<_> = matching.map(|(_, s)| s.lock().outcome.clone()).collect();
                if outcomes.is_empty() {
                    return act();
                }
                outcomes
            };
            futures_util::future::join_all(outcomes).await;
        }
    }

    /// Whether the client of `generation` is the account's and not signed out.
    pub(super) fn may_sync(&self, account_id: &str, generation: u32) -> bool {
        let state = self.state.lock();
        let runtime = state.runtimes.get(account_id);
        runtime.is_some_and(|runtime| {
            runtime.generation == generation && !runtime.signed_out.load(Ordering::Relaxed)
        })
    }
}

/// One restore waiting for a start. Dropped before the outcome, as when its stream is closed,
/// it leaves the start, which then rolls back if nobody else takes it.
struct Waiter {
    engine: Arc<Engine>,
    account_id: String,
    start: Arc<Mutex<StartState>>,
    received: bool,
}

impl Waiter {
    fn receive(&mut self) {
        let mut state = self.start.lock();
        state.delivered = true;
        state.waiting -= 1;
        self.received = true;
    }
}

impl Drop for Waiter {
    fn drop(&mut self) {
        if self.received {
            return;
        }
        let mut state = self.start.lock();
        state.waiting -= 1;
        if let (true, Some(Ok(generation))) = (must_roll_back(&state), state.finished.clone()) {
            drop(state);
            self.engine
                .rollback_if_current(&self.account_id, generation);
        }
    }
}

fn start_failed(reason: AccountStartFailureReason) -> StartError {
    let kind = FailureKind::Unexpected;
    StartError::Failure(account_start_failed(reason, kind, Diagnostic::new(kind)))
}

/// A start that failed at `step`, logged without its error: a crypto store's errors can name
/// users and devices. Each step's failure is the client's local state, so `crypto-failure`.
fn failed_at(step: &'static str) -> StartError {
    tracing::warn!(step, "an account start failed");
    start_failed(AccountStartFailureReason::CryptoFailure)
}

fn panicked() -> StartError {
    StartError::Fault(start_fault("restorePersisted panicked"))
}

fn start_fault(diagnostic: &str) -> Fault {
    Fault::new(FaultCode::StartFailed, diagnostic)
}

#[cfg(all(test, feature = "native"))]
mod tests {
    use std::fs;

    use std::{path::Path, sync::Mutex as StdMutex, time::Duration};

    use futures_util::{StreamExt, future::join};
    use matrix_sdk::{HttpError, RefreshTokenError, timeout::timeout};
    use serde_json::json;
    use tempfile::TempDir;
    use zeroize::Zeroizing;

    use super::*;
    use crate::{
        config::EngineConfig,
        engines::session::{
            self as session, LiveAccountsDto, SessionSnapshotDto, SessionSyncStateDto,
        },
        failure::account_not_live,
    };

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

    fn state(finished: Option<StartOutcome>, waiting: usize, delivered: bool) -> StartState {
        let pending: BoxFuture<'static, StartOutcome> = Box::pin(std::future::pending());
        StartState {
            outcome: pending.shared(),
            waiting,
            delivered,
            finished,
        }
    }

    #[test]
    fn start_rolls_back_only_when_finished_unconsumed_and_unwatched() {
        let ok = || Some(Ok(1));
        let failed = || Some(Err(StartError::Failure(account_not_live())));
        for (finished, waiting, delivered, expected) in [
            (None, 0, false, false),
            (ok(), 0, false, true),
            (ok(), 1, false, false),
            (ok(), 0, true, false),
            (failed(), 0, false, false),
        ] {
            let label = format!(
                "{:?} {waiting} {delivered}",
                finished.as_ref().map(Result::is_ok)
            );
            assert_eq!(
                must_roll_back(&state(finished, waiting, delivered)),
                expected,
                "{label}"
            );
        }
        // A waiter joins after the others left but before the finish.
        let mut start = state(None, 1, false);
        start.waiting -= 1;
        assert!(!must_roll_back(&start));
        start.waiting += 1;
        start.finished = ok();
        assert!(!must_roll_back(&start));
    }

    fn engine_on(root: &Path, key: u8) -> Arc<Engine> {
        Engine::new(EngineConfig {
            data_dir: root.join("data"),
            cache_dir: root.join("cache"),
            store_key: Arc::new(move || Ok(Zeroizing::new([key; 32]))),
            ..EngineConfig::default()
        })
        .unwrap()
    }

    /// A session on a homeserver that refuses every connection.
    fn offline(user_id: &str) -> MatrixSessionDto {
        serde_json::from_value(json!({
            "baseUrl": "http://127.0.0.1:1",
            "userId": user_id,
            "deviceId": "DEV",
            "accessToken": "at",
        }))
        .unwrap()
    }

    async fn restored(
        engine: &Arc<Engine>,
        user_id: &str,
        activation: PersistedAccountActivationDto,
    ) {
        let result = engine.restore(offline(user_id), activation).await;
        assert!(matches!(result, Ok(EngineResult::Ok(()))), "{user_id}");
    }

    fn snapshot(engine: &Engine) -> SessionSnapshotDto {
        engine.state.lock().snapshot.clone()
    }

    fn ids(engine: &Engine) -> Vec<String> {
        snapshot(engine)
            .accounts
            .into_iter()
            .map(|a| a.account_id)
            .collect()
    }

    fn start_reason(result: Result<EngineResult<()>, Fault>) -> AccountStartFailureReason {
        match result {
            Ok(EngineResult::Err(EngineFailure {
                code: FailureCode::AccountStartFailed { reason },
                ..
            })) => reason,
            _ => panic!("not account-start-failed"),
        }
    }

    /// Records every `session()` snapshot, polling as the carrier does.
    fn record(engine: &Arc<Engine>) -> Arc<StdMutex<Vec<SessionSnapshotDto>>> {
        let recorded = Arc::new(StdMutex::new(Vec::new()));
        let (sink, mut stream) = (Arc::clone(&recorded), engine.subscribe_session());
        spawn(async move {
            while let Some(snapshot) = stream.next().await {
                sink.lock().unwrap().push(snapshot);
            }
        });
        recorded
    }

    const ACTIVATE: PersistedAccountActivationDto = PersistedAccountActivationDto::Activate;
    const BACKGROUND: PersistedAccountActivationDto = PersistedAccountActivationDto::Background;

    #[tokio::test]
    async fn an_unreadable_store_key_fails_secure_storage_unavailable() {
        let engine = Engine::new(EngineConfig::default()).unwrap();
        let result = engine.restore(offline("@a:b"), ACTIVATE).await;
        assert_eq!(
            start_reason(result),
            AccountStartFailureReason::SecureStorageUnavailable
        );
        let empty = snapshot(&engine);
        assert!(empty.accounts.is_empty() && empty.soft_logged_out.is_empty());
    }

    #[tokio::test]
    async fn a_malformed_user_id_or_base_url_is_a_fault() {
        let root = TempDir::new().unwrap();
        let engine = engine_on(root.path(), 1);
        assert!(
            engine
                .restore(offline("not-a-user-id"), ACTIVATE)
                .await
                .is_err()
        );
        let mut session = offline("@a:b");
        session.base_url = "not a url".into();
        assert!(engine.restore(session, ACTIVATE).await.is_err());
        assert!(ids(&engine).is_empty());
    }

    #[tokio::test]
    async fn restore_replies_while_the_homeserver_is_unreachable() {
        let root = TempDir::new().unwrap();
        let engine = engine_on(root.path(), 1);
        restored(&engine, "@a:b", ACTIVATE).await;
        assert_eq!(ids(&engine), ["@a:b"]);
        assert_eq!(snapshot(&engine).active_account_id.as_deref(), Some("@a:b"));
        let mut session = engine.subscribe_session();
        let offline = async {
            while let Some(snapshot) = session.next().await {
                let state = snapshot.accounts[0].sync_state;
                if matches!(
                    state,
                    SessionSyncStateDto::Reconnecting | SessionSyncStateDto::Syncing
                ) {
                    return;
                }
            }
        };
        timeout(offline, Duration::from_secs(20))
            .await
            .expect("reconnecting or syncing");
    }

    #[tokio::test]
    async fn a_wrong_store_key_fails_crypto_store_key_lost_and_flags_the_account() {
        let root = TempDir::new().unwrap();
        let first = engine_on(root.path(), 1);
        restored(&first, "@a:b", ACTIVATE).await;
        first.stop().await;
        let second = engine_on(root.path(), 2);
        let result = second.restore(offline("@a:b"), ACTIVATE).await;
        assert_eq!(
            start_reason(result),
            AccountStartFailureReason::CryptoStoreKeyLost
        );
        assert_eq!(snapshot(&second).soft_logged_out, ["@a:b"]);
        assert!(ids(&second).is_empty());
    }

    /// The log writer of [`a_failed_start_logs_its_step_but_not_its_error`].
    #[derive(Clone, Default)]
    struct Log(Arc<StdMutex<Vec<u8>>>);

    impl std::io::Write for Log {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// A crypto store's errors can name users and devices, so a failed start logs only its step.
    #[tokio::test]
    async fn a_failed_start_logs_its_step_but_not_its_error() {
        let root = TempDir::new().unwrap();
        let engine = engine_on(root.path(), 1);
        let s = offline("@a:b");
        // A crypto store that holds another device's account, which the restore refuses.
        let paths = StorePaths::new(&engine.config, &s.user_id, &s.device_id);
        let other = account_builder(&engine, &s, &paths, &[1; 32]).build().await;
        let other = other.unwrap();
        let meta = SessionMeta {
            user_id: UserId::parse(&s.user_id).unwrap(),
            device_id: "OTHERDEVICE".into(),
        };
        other.restore_session(auth_session(&s, meta)).await.unwrap();
        drop(other);
        let log = Log::default();
        let writer = log.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_max_level(tracing::Level::WARN)
            .with_writer(move || writer.clone())
            .finish();
        let guard = tracing::subscriber::set_default(subscriber);
        let result = engine.restore(s, ACTIVATE).await;
        drop(guard);
        assert_eq!(
            start_reason(result),
            AccountStartFailureReason::CryptoFailure
        );
        let log = String::from_utf8(log.0.lock().unwrap().clone()).unwrap();
        let ours: Vec<_> = log
            .lines()
            .filter(|l| l.contains("trinity_engine"))
            .collect();
        assert!(ours.iter().any(|l| l.contains("restore_session")), "{log}");
        assert!(!ours.iter().any(|l| l.contains("OTHERDEVICE")), "{log}");
    }

    #[tokio::test]
    async fn a_second_restore_of_a_live_account_replaces_it_with_a_larger_generation() {
        let root = TempDir::new().unwrap();
        let engine = engine_on(root.path(), 1);
        restored(&engine, "@a:b", ACTIVATE).await;
        restored(&engine, "@a:b", ACTIVATE).await;
        let accounts = snapshot(&engine).accounts;
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].generation, 2);
        assert_eq!(engine.account("@a:b").unwrap().generation, 2);
    }

    #[tokio::test]
    async fn concurrent_restores_of_one_account_join_one_start() {
        let root = TempDir::new().unwrap();
        let engine = engine_on(root.path(), 1);
        restored(&engine, "@c:d", BACKGROUND).await;
        join(
            restored(&engine, "@a:b", ACTIVATE),
            restored(&engine, "@a:b", ACTIVATE),
        )
        .await;
        let accounts = snapshot(&engine).accounts;
        let generations: Vec<_> = accounts
            .iter()
            .map(|a| (a.account_id.as_str(), a.generation))
            .collect();
        assert_eq!(generations, [("@c:d", 1), ("@a:b", 2)]);
    }

    #[tokio::test]
    async fn a_restart_waits_until_no_command_holds_the_old_client() {
        let root = TempDir::new().unwrap();
        let engine = engine_on(root.path(), 1);
        restored(&engine, "@a:b", ACTIVATE).await;
        let held = engine.account("@a:b").unwrap();
        let mut restart = Box::pin(engine.restore(offline("@a:b"), ACTIVATE));
        let early = timeout(restart.as_mut(), Duration::from_millis(300)).await;
        assert!(early.is_err(), "the restart waits for the held client");
        let stopped = held.sync_service.state().get();
        assert!(matches!(stopped, matrix_sdk_ui::sync_service::State::Idle));
        drop(held);
        assert!(matches!(restart.await, Ok(EngineResult::Ok(()))));
        assert_eq!(engine.account("@a:b").unwrap().generation, 2);
    }

    #[tokio::test]
    async fn a_restore_closed_before_its_reply_rolls_back_its_start() {
        let root = TempDir::new().unwrap();
        let engine = engine_on(root.path(), 1);
        let mut closed = Box::pin(engine.restore(offline("@a:b"), ACTIVATE));
        assert!(closed.as_mut().now_or_never().is_none());
        drop(closed);
        let finished = async {
            while !engine.starting.lock().is_empty() {
                matrix_sdk::sleep::sleep(Duration::from_millis(10)).await;
            }
        };
        timeout(finished, Duration::from_secs(20)).await.unwrap();
        assert!(ids(&engine).is_empty());
        assert!(engine.account("@a:b").is_none());
    }

    #[tokio::test]
    async fn a_joined_restore_applies_its_own_activation() {
        let root = TempDir::new().unwrap();
        let engine = engine_on(root.path(), 1);
        restored(&engine, "@c:d", ACTIVATE).await;
        join(
            restored(&engine, "@a:b", BACKGROUND),
            restored(&engine, "@a:b", ACTIVATE),
        )
        .await;
        let snapshot = snapshot(&engine);
        assert_eq!(snapshot.active_account_id.as_deref(), Some("@a:b"));
        assert_eq!(
            snapshot.accounts.iter().map(|a| a.generation).max(),
            Some(2)
        );
    }

    #[tokio::test]
    async fn activate_with_replace_retires_the_others_in_one_publish() {
        let root = TempDir::new().unwrap();
        let engine = engine_on(root.path(), 1);
        restored(&engine, "@a:b", ACTIVATE).await;
        restored(&engine, "@c:d", BACKGROUND).await;
        restored(&engine, "@e:f", BACKGROUND).await;
        let recorded = record(&engine);
        let replace = LiveAccountsDto::Replace;
        let mut reply = session::activate_account(Arc::clone(&engine), "@c:d".into(), replace);
        let reply = reply.next().await.unwrap().unwrap();
        assert_eq!(reply, json!({"ok": true, "value": null}));
        // Status changes come and go; the accounts and the active one change once.
        let recorded = recorded.lock().unwrap().clone();
        let seen: Vec<_> = (recorded.iter())
            .map(|s| (ids_of(s), s.active_account_id.clone().unwrap()))
            .collect();
        let before = (vec!["@a:b", "@c:d", "@e:f"], "@a:b".to_owned());
        let after = (vec!["@c:d"], "@c:d".to_owned());
        assert!(seen.iter().all(|s| *s == before || *s == after), "{seen:?}");
        assert_eq!(seen.last(), Some(&after));
        assert!(engine.account("@a:b").is_none() && engine.account("@e:f").is_none());
    }

    fn ids_of(snapshot: &SessionSnapshotDto) -> Vec<&str> {
        snapshot
            .accounts
            .iter()
            .map(|a| a.account_id.as_str())
            .collect()
    }

    #[tokio::test]
    async fn require_reauthentication_keeps_a_live_account_live() {
        let root = TempDir::new().unwrap();
        let engine = engine_on(root.path(), 1);
        restored(&engine, "@a:b", ACTIVATE).await;
        engine.require_reauthentication("@a:b").delivered().await;
        assert_eq!(ids(&engine), ["@a:b"]);
        assert_eq!(snapshot(&engine).soft_logged_out, ["@a:b"]);
        assert!(engine.account("@a:b").is_some());
    }

    /// Runs `lifecycle` while a restore of `@a:b` is in flight: the restore still succeeds, and
    /// the account does not come back live after `lifecycle`.
    async fn raced(engine: &Arc<Engine>, lifecycle: impl Future<Output = ()>) {
        let (restored, ()) = join(engine.restore(offline("@a:b"), ACTIVATE), lifecycle).await;
        assert!(matches!(restored, Ok(EngineResult::Ok(()))));
        assert!(engine.account("@a:b").is_none());
        let after = snapshot(engine);
        assert!(after.accounts.is_empty() && after.active_account_id.is_none());
    }

    #[tokio::test]
    async fn a_remove_during_a_restore_leaves_the_account_and_its_stores_gone() {
        let root = TempDir::new().unwrap();
        let engine = engine_on(root.path(), 1);
        raced(&engine, engine.remove("@a:b")).await;
        let stores = StorePaths::new(&engine.config, "@a:b", "DEV");
        assert!(!stores.data.exists() && !stores.cache.exists());
    }

    #[tokio::test]
    async fn a_stop_or_rollback_during_a_restore_leaves_the_account_stopped() {
        let root = TempDir::new().unwrap();
        let engine = engine_on(root.path(), 1);
        raced(&engine, engine.stop()).await;
        raced(&engine, engine.rollback_account_start("@a:b")).await;
        let stores = StorePaths::new(&engine.config, "@a:b", "DEV");
        assert!(stores.data.exists(), "a rollback keeps the stores");
    }

    #[tokio::test]
    async fn removing_or_rolling_back_the_active_account_repoints_it() {
        let root = TempDir::new().unwrap();
        let engine = engine_on(root.path(), 1);
        restored(&engine, "@a:b", ACTIVATE).await;
        restored(&engine, "@c:d", ACTIVATE).await;
        engine.remove("@c:d").await;
        assert_eq!(snapshot(&engine).active_account_id.as_deref(), Some("@a:b"));
        let stores = StorePaths::new(&engine.config, "@c:d", "DEV");
        assert!(!stores.data.exists() && !stores.cache.exists());
        restored(&engine, "@c:d", ACTIVATE).await;
        engine.rollback_account_start("@c:d").await;
        assert_eq!(snapshot(&engine).active_account_id.as_deref(), Some("@a:b"));
        assert_eq!(ids(&engine), ["@a:b"]);
    }

    #[tokio::test]
    async fn a_start_after_a_lifecycle_call_awaits_the_teardown_it_queued() {
        let root = TempDir::new().unwrap();
        let engine = engine_on(root.path(), 1);
        restored(&engine, "@a:b", ACTIVATE).await;
        let held = engine.account("@a:b").unwrap();
        let mut removing = Box::pin(engine.remove("@a:b"));
        assert!(
            removing.as_mut().now_or_never().is_none(),
            "acted, tearing down"
        );
        let mut restore = Box::pin(engine.restore(offline("@a:b"), ACTIVATE));
        let early = timeout(restore.as_mut(), Duration::from_millis(300)).await;
        assert!(early.is_err(), "the start waits for the remove's teardown");
        drop(held);
        let ((), restored) = join(removing, restore).await;
        assert!(matches!(restored, Ok(EngineResult::Ok(()))));
        assert_eq!(engine.account("@a:b").unwrap().generation, 2);
        assert!(StorePaths::new(&engine.config, "@a:b", "DEV").data.exists());
    }

    #[tokio::test]
    async fn a_start_whose_task_ended_without_forgetting_it_holds_up_no_lifecycle_call() {
        let root = TempDir::new().unwrap();
        let engine = engine_on(root.path(), 1);
        // As a start task that ended with a `JoinError`, before `finish_start`.
        let ended: BoxFuture<'static, StartOutcome> = Box::pin(async { Err(panicked()) });
        let mut start = state(None, 0, false);
        start.outcome = ended.shared();
        assert!(start.outcome.clone().now_or_never().is_some());
        let start = Arc::new(Mutex::new(start));
        engine.starting.lock().insert("@a:b".into(), start);
        let removed = timeout(engine.remove("@a:b"), Duration::from_secs(5)).await;
        assert!(removed.is_ok());
        assert!(engine.starting.lock().is_empty());
    }
}
