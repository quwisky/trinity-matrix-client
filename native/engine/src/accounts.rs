//! The engine and its signed-in accounts.

use std::{collections::HashMap, future::ready, sync::Arc, time::Duration};

use futures_util::{StreamExt, stream};
use matrix_sdk::{
    Client, ClientBuildError, ClientBuilder, SessionMeta, SessionTokens,
    authentication::matrix::MatrixSession,
    bytes::Bytes,
    locks::Mutex,
    reqwest::{self, StatusCode, Url},
    ruma::UserId,
    timeout::timeout,
};
use matrix_sdk_ui::{
    encryption_sync_service,
    room_list_service::{self, RoomListLoadingState},
    sync_service::{self, State, SyncService},
};
use serde::Deserialize;

use crate::{
    barrier::{Barrier, Subscribers, Tracked},
    config::EngineConfig,
    engines::session::{
        LiveAccountsDto, SessionAccountStatusDto, SessionSnapshotDto, SessionSyncStateDto,
    },
    failure::{
        Diagnostic, EngineFailure, FailureCode, FailureKind, account_not_live, classify_http,
        request_failed,
    },
};

const LOAD_LIMIT: Duration = Duration::from_secs(30);

pub struct Engine {
    pub(crate) config: EngineConfig,
    state: Mutex<SessionState>,
    /// For the requests the engines send themselves rather than through the SDK.
    raw: reqwest::Client,
}

/// Everything the session commands change, under one lock that is never held across an await.
pub(crate) struct SessionState {
    registry: Registry,
    /// Also holds the test host's `startAccount` runtimes, which are not in the registry.
    runtimes: HashMap<String, Arc<AccountRuntime>>,
    /// The last snapshot published, so an unchanged one is not sent again.
    snapshot: SessionSnapshotDto,
    snapshots: Subscribers<SessionSnapshotDto>,
}

/// Pure registry data: no `Client`, so its transitions are unit-tested.
#[derive(Default)]
pub(crate) struct Registry {
    /// Live accounts in registry order.
    entries: Vec<SessionAccountStatusDto>,
    active: Option<String>,
    soft_logged_out: Vec<String>,
    /// Engine-wide, one more for each registered client; `stop` keeps it.
    generation: u32,
}

pub struct AccountRuntime {
    pub client: Client,
    pub sync_service: Arc<SyncService>,
}

/// A session to restore, as the test host receives it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAccount {
    homeserver_url: String,
    user_id: String,
    device_id: String,
    access_token: String,
}

impl Engine {
    /// Fails only when the TLS backend cannot start, such as Android's platform verifier before
    /// its initialization.
    pub fn new(config: EngineConfig) -> Result<Arc<Self>, reqwest::Error> {
        let builder = reqwest::Client::builder();
        // The browser's fetch owns redirects and TLS on wasm.
        #[cfg(not(target_family = "wasm"))]
        let builder = builder
            .redirect(reqwest::redirect::Policy::none())
            .danger_accept_invalid_certs(config.insecure_tls)
            .min_tls_version(reqwest::tls::Version::TLS_1_2);
        let registry = Registry::default();
        Ok(Arc::new(Self {
            config,
            state: Mutex::new(SessionState {
                snapshot: registry.snapshot(),
                registry,
                runtimes: HashMap::new(),
                snapshots: Subscribers::default(),
            }),
            raw: builder.build()?,
        }))
    }

    pub fn account(&self, account_id: &str) -> Option<Arc<AccountRuntime>> {
        self.state.lock().runtimes.get(account_id).cloned()
    }

    /// A `session()` stream, which starts with the current snapshot.
    pub(crate) fn subscribe_session(&self) -> Tracked<SessionSnapshotDto> {
        let mut state = self.state.lock();
        let first = state.snapshot.clone();
        state.snapshots.subscribe(Some(first)).1
    }

    pub(crate) fn set_active(&self, account_id: &str) -> Barrier {
        let mut state = self.state.lock();
        state.registry.set_active(account_id);
        state.publish_snapshot()
    }

    /// Makes a live account active; `Replace` also retires every other live account, whose
    /// runtimes the caller stops.
    pub(crate) fn activate_account(
        &self,
        account_id: &str,
        live_accounts: LiveAccountsDto,
    ) -> Result<(Barrier, Vec<Arc<AccountRuntime>>), EngineFailure> {
        let mut state = self.state.lock();
        if !state.registry.is_live(account_id) {
            return Err(account_not_live());
        }
        let mut retired = Vec::new();
        if live_accounts == LiveAccountsDto::Replace {
            let others: Vec<String> = (state.registry.entries.iter())
                .map(|entry| entry.account_id.clone())
                .filter(|other| other != account_id)
                .collect();
            retired = others.iter().filter_map(|id| state.retire(id)).collect();
        }
        state.registry.set_active(account_id);
        Ok((state.publish_snapshot(), retired))
    }

    pub(crate) fn require_reauthentication(&self, account_id: &str) -> Barrier {
        let mut state = self.state.lock();
        state.registry.mark_soft_logged_out(account_id);
        state.publish_snapshot()
    }

    /// Retires a started account but keeps its store.
    pub(crate) async fn rollback_account_start(&self, account_id: &str) {
        let (runtime, barrier) = self.retire(account_id);
        stop_runtimes(runtime).await;
        barrier.delivered().await;
    }

    /// Retires the account, live or not, and deletes its stores.
    pub(crate) async fn remove(&self, account_id: &str) {
        let (runtime, barrier) = self.retire(account_id);
        stop_runtimes(runtime).await;
        #[cfg(feature = "native")]
        if let Err(err) = crate::store::delete_account(&self.config, account_id) {
            tracing::warn!(kind = ?err.kind(), "deleting an account's stores failed");
        }
        barrier.delivered().await;
    }

    /// Stops every runtime and empties the registry; the stores stay.
    pub(crate) async fn stop(&self) {
        let (runtimes, barrier) = {
            let mut state = self.state.lock();
            state.registry.clear();
            let runtimes: Vec<_> = state.runtimes.drain().map(|(_, rt)| rt).collect();
            (runtimes, state.publish_snapshot())
        };
        stop_runtimes(runtimes).await;
        barrier.delivered().await;
    }

    fn retire(&self, account_id: &str) -> (Option<Arc<AccountRuntime>>, Barrier) {
        let mut state = self.state.lock();
        let runtime = state.retire(account_id);
        (runtime, state.publish_snapshot())
    }

    pub fn client_builder(&self) -> ClientBuilder {
        let builder = Client::builder();
        if self.config.insecure_tls {
            builder.disable_ssl_verification()
        } else {
            builder
        }
    }

    /// A GET that follows no redirect, so `token` reaches only `url`: its status and body.
    pub async fn raw_get(
        &self,
        url: Url,
        token: Option<&str>,
        timeout: Duration,
    ) -> Result<(StatusCode, Bytes), reqwest::Error> {
        let mut request = self.raw.get(url.clone()).timeout(timeout);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let response = request.send().await?;
        // On wasm, fetch has already followed any redirect: answer with a 3xx, as native does.
        if response.url() != &url {
            return Ok((StatusCode::FOUND, Bytes::new()));
        }
        Ok((response.status(), response.bytes().await?))
    }

    /// Restores `start` with a memory store and syncs until its room list has loaded.
    pub async fn start_account(&self, start: StartAccount) -> Result<(), EngineFailure> {
        // Stopped first: two sync services for one device would reset each other's connection.
        let previous = self.state.lock().runtimes.remove(&start.user_id);
        if let Some(previous) = previous {
            previous.sync_service.stop().await;
        }
        let account_id = start.user_id.clone();
        let runtime = Arc::new(self.run(start).await?);
        let displaced = self.state.lock().runtimes.insert(account_id, runtime);
        if let Some(displaced) = displaced {
            displaced.sync_service.stop().await;
        }
        Ok(())
    }

    async fn run(&self, start: StartAccount) -> Result<AccountRuntime, EngineFailure> {
        let user_id = UserId::parse(&start.user_id).map_err(|_| unexpected())?;
        let client = self
            .client_builder()
            .homeserver_url(&start.homeserver_url)
            .build()
            .await
            .map_err(|err| build_failure(&err))?;
        let session = MatrixSession {
            meta: SessionMeta {
                user_id,
                device_id: start.device_id.into(),
            },
            tokens: SessionTokens {
                access_token: start.access_token,
                refresh_token: None,
            },
        };
        client
            .restore_session(session)
            .await
            .map_err(|err| request_failed(&err))?;
        let sync_service = Arc::new(
            SyncService::builder(client.clone())
                .build()
                .await
                .map_err(|err| sync_failure(&err))?,
        );
        let rooms = sync_service
            .room_list_service()
            .all_rooms()
            .await
            .map_err(|err| sync_failure(&sync_service::Error::RoomList(err)))?;
        // Subscribed before the start, so an error the first sync runs into is not missed.
        let errors = sync_service.state().filter_map(|state| {
            ready(match state {
                State::Error(err) => Some(Err(sync_failure(&err))),
                _ => None,
            })
        });
        let loaded = rooms
            .loading_state()
            .filter(|state| ready(matches!(state, RoomListLoadingState::Loaded { .. })))
            .map(|_| Ok(()));
        sync_service.start().await;
        let outcome = match timeout(stream::select(loaded, errors).next(), LOAD_LIMIT).await {
            Ok(Some(outcome)) => outcome,
            Ok(None) => Err(unexpected()),
            Err(_) => Err(failure(
                FailureKind::Timeout,
                Diagnostic::new(FailureKind::Timeout),
            )),
        };
        if let Err(err) = outcome {
            sync_service.stop().await;
            return Err(err);
        }
        Ok(AccountRuntime {
            client,
            sync_service,
        })
    }
}

/// Stops each runtime's sync before it is dropped, so no two clients sync one device or store.
pub(crate) async fn stop_runtimes(runtimes: impl IntoIterator<Item = Arc<AccountRuntime>>) {
    for runtime in runtimes {
        runtime.sync_service.stop().await;
    }
}

impl SessionState {
    /// Sends the registry's snapshot to every `session()` stream when it changed.
    fn publish_snapshot(&mut self) -> Barrier {
        let snapshot = self.registry.snapshot();
        if snapshot == self.snapshot {
            return Barrier::default();
        }
        let barrier = self.snapshots.publish(&snapshot);
        self.snapshot = snapshot;
        barrier
    }

    /// Takes the account out of the registry and its soft logout, and hands back its runtime.
    fn retire(&mut self, account_id: &str) -> Option<Arc<AccountRuntime>> {
        self.registry.retire(account_id);
        self.registry.clear_soft_logged_out(account_id);
        self.runtimes.remove(account_id)
    }
}

impl Registry {
    pub fn snapshot(&self) -> SessionSnapshotDto {
        SessionSnapshotDto {
            active_account_id: self.active.clone(),
            accounts: self.entries.clone(),
            soft_logged_out: self.soft_logged_out.clone(),
        }
    }

    pub fn is_live(&self, account_id: &str) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.account_id == account_id)
    }

    /// Registers a new client for `account_id`: its entry moves to the end with the next
    /// generation, and the account is no longer soft-logged-out.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "restorePersisted registers from T3 on")
    )]
    pub fn register(&mut self, account_id: &str, device_id: &str) -> u32 {
        self.entries.retain(|entry| entry.account_id != account_id);
        self.generation += 1;
        self.entries.push(SessionAccountStatusDto {
            account_id: account_id.into(),
            device_id: Some(device_id.into()),
            generation: self.generation,
            sync_state: SessionSyncStateDto::Starting,
            server_synced: false,
            rooms_prepared: false,
            waiting_count: 0,
            // Every Rust store opens with the store key.
            crypto_store_encrypted: true,
        });
        self.clear_soft_logged_out(account_id);
        self.generation
    }

    /// Drops the account's entry, repointing the active account to the first remaining one.
    pub fn retire(&mut self, account_id: &str) -> bool {
        if !self.is_live(account_id) {
            return false;
        }
        self.entries.retain(|entry| entry.account_id != account_id);
        if self.active.as_deref() == Some(account_id) {
            self.active = self.entries.first().map(|entry| entry.account_id.clone());
        }
        true
    }

    /// Makes a live account active; any other is ignored.
    pub fn set_active(&mut self, account_id: &str) -> bool {
        let live = self.is_live(account_id);
        if live {
            self.active = Some(account_id.into());
        }
        live
    }

    pub fn mark_soft_logged_out(&mut self, account_id: &str) {
        if !self.soft_logged_out.iter().any(|id| id == account_id) {
            self.soft_logged_out.push(account_id.into());
        }
    }

    pub fn clear_soft_logged_out(&mut self, account_id: &str) {
        self.soft_logged_out.retain(|id| id != account_id);
    }

    /// Forgets every account but keeps counting generations.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.active = None;
        self.soft_logged_out.clear();
    }

    /// Changes the status of the account's entry while it is still that generation's.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the status task writes it from T3 on")
    )]
    pub fn update_status(
        &mut self,
        account_id: &str,
        generation: u32,
        f: impl FnOnce(&mut SessionAccountStatusDto),
    ) -> bool {
        let entry = (self.entries.iter_mut())
            .find(|entry| entry.account_id == account_id && entry.generation == generation);
        entry.map(f).is_some()
    }
}

fn failure(kind: FailureKind, diagnostic: Diagnostic) -> EngineFailure {
    EngineFailure {
        kind,
        diagnostic,
        code: FailureCode::RequestFailed {
            cause: None,
            server_message: None,
        },
    }
}

fn unexpected() -> EngineFailure {
    failure(
        FailureKind::Unexpected,
        Diagnostic::new(FailureKind::Unexpected),
    )
}

fn build_failure(err: &ClientBuildError) -> EngineFailure {
    match err {
        ClientBuildError::Http(err) => {
            let (kind, diagnostic) = classify_http(err);
            failure(kind, diagnostic)
        }
        _ => unexpected(),
    }
}

fn sync_failure(err: &sync_service::Error) -> EngineFailure {
    use encryption_sync_service::Error as Encryption;
    match err {
        sync_service::Error::RoomList(room_list_service::Error::SlidingSync(err))
        | sync_service::Error::EncryptionSync(
            Encryption::SlidingSync(err)
            | Encryption::LockError(err)
            | Encryption::ClientError(err),
        ) => request_failed(err),
        _ => unexpected(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn start(homeserver_url: &str, user_id: &str) -> StartAccount {
        serde_json::from_value(json!({
            "homeserverUrl": homeserver_url,
            "userId": user_id,
            "deviceId": "DEVICE",
            "accessToken": "token",
        }))
        .unwrap()
    }

    fn assert_request_failed(failure: &EngineFailure, kind: FailureKind) {
        assert_eq!(failure.kind, kind);
        assert!(
            matches!(failure.code, FailureCode::RequestFailed { .. }),
            "{failure:?}"
        );
    }

    fn ids(registry: &Registry) -> Vec<(String, u32)> {
        let entries = registry.snapshot().accounts.into_iter();
        entries.map(|a| (a.account_id, a.generation)).collect()
    }

    #[test]
    fn register_appends_bumps_the_generation_and_moves_a_restart_to_the_end() {
        let mut registry = Registry::default();
        assert_eq!(registry.register("@a:b", "A1"), 1);
        assert_eq!(registry.register("@c:d", "C1"), 2);
        assert_eq!(registry.register("@a:b", "A2"), 3);
        assert_eq!(ids(&registry), [("@c:d".into(), 2), ("@a:b".into(), 3)]);
        let restarted = &registry.snapshot().accounts[1];
        assert_eq!(restarted.device_id.as_deref(), Some("A2"));
        assert_eq!(restarted.sync_state, SessionSyncStateDto::Starting);
    }

    #[test]
    fn retire_repoints_active_to_the_first_remaining() {
        let mut registry = Registry::default();
        for id in ["@a:b", "@c:d", "@e:f"] {
            registry.register(id, "D");
        }
        assert!(registry.set_active("@e:f"));
        assert!(registry.retire("@e:f"));
        assert_eq!(
            registry.snapshot().active_account_id.as_deref(),
            Some("@a:b")
        );
        assert!(registry.retire("@c:d"));
        assert_eq!(
            registry.snapshot().active_account_id.as_deref(),
            Some("@a:b")
        );
        assert!(!registry.retire("@never:seen"));
        assert!(registry.retire("@a:b"));
        assert_eq!(registry.snapshot().active_account_id, None);
    }

    #[test]
    fn set_active_ignores_an_account_that_is_not_live() {
        let mut registry = Registry::default();
        registry.register("@a:b", "D");
        assert!(!registry.set_active("@x:y"));
        assert_eq!(registry.snapshot().active_account_id, None);
        assert!(registry.set_active("@a:b"));
        assert_eq!(
            registry.snapshot().active_account_id.as_deref(),
            Some("@a:b")
        );
    }

    #[test]
    fn soft_logged_out_is_deduplicated_and_cleared_on_register() {
        let mut registry = Registry::default();
        registry.mark_soft_logged_out("@a:b");
        registry.mark_soft_logged_out("@c:d");
        registry.mark_soft_logged_out("@a:b");
        assert_eq!(registry.snapshot().soft_logged_out, ["@a:b", "@c:d"]);
        registry.register("@a:b", "D");
        assert_eq!(registry.snapshot().soft_logged_out, ["@c:d"]);
        registry.clear_soft_logged_out("@c:d");
        assert!(registry.snapshot().soft_logged_out.is_empty());
    }

    #[test]
    fn clear_keeps_the_generation_counter() {
        let mut registry = Registry::default();
        registry.register("@a:b", "D");
        registry.set_active("@a:b");
        registry.mark_soft_logged_out("@c:d");
        registry.clear();
        let snapshot = registry.snapshot();
        assert!(snapshot.accounts.is_empty() && snapshot.soft_logged_out.is_empty());
        assert_eq!(snapshot.active_account_id, None);
        assert_eq!(registry.register("@a:b", "D"), 2);
    }

    #[test]
    fn update_status_writes_only_the_current_generation() {
        let mut registry = Registry::default();
        let old = registry.register("@a:b", "D");
        let current = registry.register("@a:b", "D");
        assert!(!registry.update_status("@a:b", old, |s| s.server_synced = true));
        assert!(registry.update_status("@a:b", current, |s| s.waiting_count = 2));
        let status = &registry.snapshot().accounts[0];
        assert!(!status.server_synced);
        assert_eq!(status.waiting_count, 2);
    }

    #[tokio::test]
    async fn session_commands_without_a_live_account_change_only_the_soft_logouts() {
        use futures_util::FutureExt;

        let engine = Engine::new(EngineConfig::default()).unwrap();
        let soft = || engine.state.lock().snapshot.soft_logged_out.clone();
        let mut session = engine.subscribe_session();
        assert!(session.next().now_or_never().is_some());
        let refused = engine.activate_account("@x:y", LiveAccountsDto::Keep);
        assert_eq!(
            refused.err().map(|f| f.code),
            Some(FailureCode::AccountNotLive)
        );
        // Unchanged, so nothing is published and nothing is waited for.
        engine.set_active("@x:y").delivered().await;
        assert!(session.next().now_or_never().is_none());
        drop(session);
        for id in ["@x:y", "@z:y", "@w:y"] {
            engine.require_reauthentication(id).delivered().await;
        }
        engine.rollback_account_start("@x:y").await;
        engine.remove("@z:y").await;
        assert_eq!(soft(), ["@w:y"]);
        engine.stop().await;
        assert!(soft().is_empty());
    }

    #[test]
    fn an_unknown_account_is_absent() {
        assert!(
            Engine::new(EngineConfig::default())
                .unwrap()
                .account("@a:b")
                .is_none()
        );
    }

    #[tokio::test]
    async fn a_malformed_user_id_fails_without_registering() {
        let engine = Engine::new(EngineConfig::default()).unwrap();
        let failure = engine
            .start_account(start("http://127.0.0.1:1", "not-a-user-id"))
            .await
            .unwrap_err();
        assert_request_failed(&failure, FailureKind::Unexpected);
        assert!(engine.account("not-a-user-id").is_none());
    }

    #[tokio::test]
    async fn an_unreachable_homeserver_fails_before_the_load_limit() {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let engine = Engine::new(EngineConfig::default()).unwrap();
        let failure = engine
            .start_account(start(&format!("http://127.0.0.1:{port}"), "@a:b"))
            .await
            .unwrap_err();
        assert_request_failed(&failure, FailureKind::Network);
        assert!(engine.account("@a:b").is_none());
    }
}
