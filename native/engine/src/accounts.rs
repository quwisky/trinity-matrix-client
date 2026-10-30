//! The engine and its signed-in accounts.

use std::{collections::HashMap, sync::Arc, time::Duration};

use futures_util::{FutureExt, future::Shared};
use matrix_sdk::{
    BoxFuture, Client, ClientBuilder,
    bytes::Bytes,
    executor::spawn,
    locks::Mutex,
    reqwest::{self, StatusCode, Url},
    timeout::timeout,
};
use tokio::sync::watch;

pub use crate::engines::session::runtime::AccountRuntime;
use crate::{
    barrier::{Barrier, Subscribers, Tracked},
    config::EngineConfig,
    engines::session::{
        LiveAccountsDto, SessionAccessTokenDto, SessionAccountStatusDto, SessionSnapshotDto,
        SessionStorageEffectDto, SessionSyncStateDto,
        logout::{Holds, RawToken},
        reads::live_token,
        restore::StartState,
        runtime::stop_sync,
    },
    failure::{EngineFailure, account_not_live},
};

/// How long a teardown waits for the engine commands and leased streams still holding a retired
/// runtime.
const HOLDER_LIMIT: Duration = Duration::from_secs(120);

pub struct Engine {
    pub(crate) config: EngineConfig,
    pub(crate) state: Mutex<SessionState>,
    /// Starts in flight by account id, which a second restore of the account joins.
    pub(crate) starting: Mutex<HashMap<String, Arc<Mutex<StartState>>>>,
    /// The last teardown queued for each account id; a start of that account awaits it.
    teardowns: Mutex<HashMap<String, Teardown>>,
    /// For the requests the engines send themselves rather than through the SDK.
    raw: reqwest::Client,
}

pub(crate) type Teardown = Shared<BoxFuture<'static, ()>>;

/// What a teardown does with the account's stores once its runtime is gone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stores {
    Keep,
    Delete,
}

/// Everything the session commands change, under one lock that is never held across an await.
pub(crate) struct SessionState {
    pub(crate) registry: Registry,
    pub(crate) runtimes: HashMap<String, Arc<AccountRuntime>>,
    /// The last snapshot published, so an unchanged one is not sent again.
    pub(crate) snapshot: SessionSnapshotDto,
    snapshots: Subscribers<SessionSnapshotDto>,
    /// By account id, for each account an `accessToken` stream has asked for; it outlives the
    /// account's runtimes.
    tokens: HashMap<String, Tokens>,
    /// Set by `pauseSync`, cleared by `stop`. The restart policy reads it, and 2.3's resend gate
    /// will (js `syncPaused`).
    pub(crate) paused: bool,
    pub(crate) holds: Holds,
    pub(crate) effects: Subscribers<SessionStorageEffectDto>,
    /// By account id, what the token-death rule has published since the account's last start,
    /// which a request that meets the dead token later still awaits (O8).
    pub(crate) deaths: HashMap<String, Barrier>,
    /// Sent each time the rule runs, for a request waiting on the SDK's broadcast.
    pub(crate) deaths_seen: watch::Sender<()>,
    /// By account id, what its last token refresh published, which a reply after the refresh
    /// awaits.
    pub(crate) rotations: HashMap<String, Barrier>,
}

/// One account's last token and its `accessToken` streams.
#[derive(Default)]
struct Tokens {
    last: Option<SessionAccessTokenDto>,
    streams: Subscribers<Option<SessionAccessTokenDto>>,
}

/// Pure registry data: no `Client`, so its transitions are unit-tested.
#[derive(Default)]
pub(crate) struct Registry {
    /// Live accounts in registry order.
    entries: Vec<SessionAccountStatusDto>,
    active: Option<String>,
    soft_logged_out: Vec<String>,
    /// Engine-wide, one more for each registered client; `stop` keeps it.
    // Without `native` no start registers a client.
    #[cfg_attr(not(feature = "native"), allow(dead_code))]
    generation: u32,
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
                tokens: HashMap::new(),
                paused: false,
                holds: Holds::default(),
                effects: Subscribers::default(),
                deaths: HashMap::new(),
                deaths_seen: watch::Sender::new(()),
                rotations: HashMap::new(),
            }),
            starting: Mutex::default(),
            teardowns: Mutex::default(),
            raw: builder.build()?,
        }))
    }

    /// The account's live runtime. Hold it for one request only: never across a lifecycle call
    /// (remove, restart, rollback) and never in a long-lived stream, which runs on
    /// [`account_stream`](crate::engines::member::account_stream), since its teardown waits until
    /// every holder has let go.
    pub fn account(&self, account_id: &str) -> Option<Arc<AccountRuntime>> {
        self.state.lock().runtimes.get(account_id).cloned()
    }

    /// A `session()` stream, which starts with the current snapshot.
    pub(crate) fn subscribe_session(&self) -> Tracked<SessionSnapshotDto> {
        let mut state = self.state.lock();
        let first = state.snapshot.clone();
        state.snapshots.subscribe(Some(first)).1
    }

    /// An `accessToken` stream, which starts with the account's current token.
    pub(crate) fn subscribe_token(
        &self,
        account_id: &str,
    ) -> Tracked<Option<SessionAccessTokenDto>> {
        let state = &mut *self.state.lock();
        let token = state.runtimes.get(account_id).and_then(|rt| live_token(rt));
        let tokens = state.tokens.entry(account_id.to_owned()).or_default();
        // Nobody waits: a refresh the SDK made since the last publish reaches the other streams.
        let _ = tokens.publish(token);
        tokens.streams.subscribe(Some(tokens.last.clone())).1
    }

    /// The live accounts' runtimes, in registry order.
    pub(crate) fn live_runtimes(&self) -> Vec<Arc<AccountRuntime>> {
        let state = self.state.lock();
        let ids = state.snapshot.accounts.iter().map(|a| &a.account_id);
        ids.filter_map(|id| state.runtimes.get(id).cloned())
            .collect()
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
        let (teardown, barrier) = self
            .after_starts(Some(account_id), || {
                let (runtime, barrier) = self.retire(account_id);
                (self.tear_down(account_id, runtime, Stores::Keep), barrier)
            })
            .await;
        teardown.await;
        barrier.delivered().await;
    }

    /// Retires the account, live or not, ends its holds, and deletes its stores once its
    /// runtime is gone.
    pub(crate) async fn remove(&self, account_id: &str) {
        let (teardown, barrier) = self
            .after_starts(Some(account_id), || {
                let (runtime, barrier) = {
                    let mut state = self.state.lock();
                    let runtime = state.retire(account_id);
                    state.deaths.remove(account_id);
                    state.rotations.remove(account_id);
                    let released = state.holds.release_account(account_id);
                    (runtime, state.publish_snapshot().join(released))
                };
                (self.tear_down(account_id, runtime, Stores::Delete), barrier)
            })
            .await;
        teardown.await;
        barrier.delivered().await;
    }

    /// Stops every runtime, ends every hold and empties the registry; the stores stay.
    pub(crate) async fn stop(&self) {
        let (teardowns, barrier) = self
            .after_starts(None, || {
                let (runtimes, barrier) = {
                    let mut state = self.state.lock();
                    state.registry.clear();
                    state.paused = false;
                    state.deaths.clear();
                    state.rotations.clear();
                    let released = state.holds.release_all();
                    let runtimes: Vec<_> = state.runtimes.drain().collect();
                    (runtimes, state.publish_snapshot().join(released))
                };
                let teardowns = runtimes
                    .into_iter()
                    .map(|(id, runtime)| self.tear_down(&id, Some(runtime), Stores::Keep));
                (teardowns.collect::<Vec<_>>(), barrier)
            })
            .await;
        futures_util::future::join_all(teardowns).await;
        barrier.delivered().await;
    }

    /// Undoes a start nobody took, unless the account has a newer client by now.
    pub(crate) fn rollback_if_current(&self, account_id: &str, generation: u32) {
        let mut state = self.state.lock();
        let current = state.runtimes.get(account_id);
        if !current.is_some_and(|runtime| runtime.generation == generation) {
            return;
        }
        let runtime = state.retire(account_id);
        let _ = state.publish_snapshot();
        // Queued under the lock, so a start of the account that follows awaits it.
        drop(self.tear_down(account_id, runtime, Stores::Keep));
    }

    /// Writes a runtime's status while `generation` is still the account's; `false` once not.
    #[cfg_attr(not(feature = "native"), allow(dead_code))]
    pub(crate) fn update_status(
        &self,
        account_id: &str,
        generation: u32,
        f: impl FnOnce(&mut SessionAccountStatusDto),
    ) -> bool {
        let mut state = self.state.lock();
        let current = state.registry.update_status(account_id, generation, f);
        let _ = state.publish_snapshot();
        current
    }

    /// Stops a retired runtime's sync, for up to `STOP_LIMIT` (30 s), then waits up to
    /// `HOLDER_LIMIT` (120 s) until no engine command or leased stream holds it, then deletes the
    /// account's stores when asked. It runs on its own task, after the account's previous
    /// teardown, so a closed command cannot cut it short. A start of the account awaits it, so two
    /// clients open one store only when a holder outlasts the limit. A command that triggers a
    /// teardown never awaits it while holding the runtime.
    pub(crate) fn tear_down(
        &self,
        account_id: &str,
        runtime: Option<Arc<AccountRuntime>>,
        stores: Stores,
    ) -> Teardown {
        // Before the queue, so its streams end without waiting out the previous teardown.
        if let Some(runtime) = &runtime {
            runtime.set_retired();
        }
        let mut teardowns = self.teardowns.lock();
        let previous = teardowns.remove(account_id);
        let (config, id) = (self.config.clone(), account_id.to_owned());
        let task = spawn(async move {
            if let Some(previous) = previous {
                previous.await;
            }
            if let Some(runtime) = runtime {
                stop_sync(&runtime.sync_service).await;
                let mut dropped = runtime.dropped();
                drop(runtime);
                if timeout(dropped.changed(), HOLDER_LIMIT).await.is_err() {
                    // shortcut: a client still held after 120 s, as by a detached multi-step
                    // body, outlives its teardown, so a restart opens a second client on the
                    // store and a remove deletes the stores under it (an unlink on Unix, a logged
                    // failure on Windows); upgrade when matrix-sdk gains a client shutdown.
                    tracing::warn!("a retired account is still in use");
                }
            }
            if stores == Stores::Delete {
                delete_account_stores(&config, &id);
            }
        });
        let task: BoxFuture<'static, ()> = Box::pin(task.map(|_| ()));
        let teardown = task.shared();
        teardowns.insert(account_id.to_owned(), teardown.clone());
        teardown
    }

    /// The account's last teardown, which a start of the account must await.
    pub(crate) fn teardown_of(&self, account_id: &str) -> Option<Teardown> {
        self.teardowns.lock().get(account_id).cloned()
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
    pub(crate) async fn raw_get(
        &self,
        url: Url,
        token: Option<&RawToken>,
        timeout: Duration,
    ) -> Result<(StatusCode, Bytes), reqwest::Error> {
        let mut request = self.raw.get(url.clone()).timeout(timeout);
        if let Some(token) = token {
            request = request.bearer_auth(token.as_str());
        }
        let response = request.send().await?;
        // On wasm, fetch has already followed any redirect: answer with a 3xx, as native does.
        if response.url() != &url {
            return Ok((StatusCode::FOUND, Bytes::new()));
        }
        Ok((response.status(), response.bytes().await?))
    }
}

fn delete_account_stores(config: &EngineConfig, account_id: &str) {
    #[cfg(feature = "native")]
    if let Err(err) = crate::store::delete_account(config, account_id) {
        tracing::warn!(kind = ?err.kind(), "deleting an account's stores failed");
    }
    #[cfg(not(feature = "native"))]
    let _ = (config, account_id);
}

impl SessionState {
    /// Sends the registry's snapshot to every `session()` stream, and each account's token to
    /// its `accessToken` streams, when changed.
    pub(crate) fn publish_snapshot(&mut self) -> Barrier {
        let mut barrier = Barrier::default();
        for (id, tokens) in &mut self.tokens {
            let token = self.runtimes.get(id).and_then(|rt| live_token(rt));
            barrier = barrier.join(tokens.publish(token));
        }
        let snapshot = self.registry.snapshot();
        if snapshot == self.snapshot {
            return barrier;
        }
        let published = self.snapshots.publish(&snapshot);
        self.snapshot = snapshot;
        barrier.join(published)
    }

    /// Takes the account out of the registry and its soft logout, and hands back its runtime.
    pub(crate) fn retire(&mut self, account_id: &str) -> Option<Arc<AccountRuntime>> {
        self.registry.retire(account_id);
        self.registry.clear_soft_logged_out(account_id);
        self.runtimes.remove(account_id)
    }
}

impl Tokens {
    /// Sends `token` when it differs from the last one, so no stream sees a token twice in a row.
    fn publish(&mut self, token: Option<SessionAccessTokenDto>) -> Barrier {
        if token == self.last {
            return Barrier::default();
        }
        let barrier = self.streams.publish(&token);
        self.last = token;
        barrier
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
    #[cfg_attr(not(feature = "native"), allow(dead_code))]
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
            waiting_count: 0, // shortcut: 2.3 owns send semantics (G14, R6), upgrade in 2.3
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
        if !self.is_soft_logged_out(account_id) {
            self.soft_logged_out.push(account_id.into());
        }
    }

    pub fn is_soft_logged_out(&self, account_id: &str) -> bool {
        self.soft_logged_out.iter().any(|id| id == account_id)
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
    #[cfg_attr(not(feature = "native"), allow(dead_code))]
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::failure::FailureCode;

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
        use futures_util::{FutureExt, StreamExt};

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
}
