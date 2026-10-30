//! Server logouts: the token-death rule, logout holds, storage effects, the session callbacks and
//! account deactivation.

use std::{
    collections::HashMap,
    future::IntoFuture,
    mem,
    pin::Pin,
    sync::{Arc, Weak, atomic::Ordering},
    task::{Context, Poll},
    time::Duration,
};

use futures_util::{StreamExt, future::join_all, stream};
use matrix_sdk::{
    Client, ClientBuildError, Error, HttpError, RefreshTokenError, SessionTokens,
    bytes::Bytes,
    executor::spawn,
    reqwest::Url,
    ruma::api::{
        client::{
            account::deactivate,
            session::logout,
            uiaa::{
                AuthData, FallbackAcknowledgement, MatrixUserIdentifier, Password, UserIdentifier,
            },
        },
        error::ErrorKind,
    },
    timeout::timeout,
};
use serde_json::Value;

use super::{
    MatrixSessionDto, ServerLogoutHoldUpdateDto, SessionStorageEffectDto, UiaAuthDto, done,
    restore::{auth_session, session_meta},
    runtime::stop_sync,
};
use crate::{
    accounts::{AccountRuntime, Engine, SessionState, Stores},
    barrier::{Barrier, DELIVERY_LIMIT, Subscribers, Tracked},
    dispatch::{Stream, detached, item, reply, stream},
    engines::member::{on_account, sent_once},
    failure::{EngineResult, http_error_from_response, refresh_logs_out, request_failure},
    wire::{Fault, FaultCode},
};

// Without `native` no start sets the SDK's session callbacks or registers a client.
#[cfg_attr(not(feature = "native"), allow(dead_code))]
type CallbackError = Box<dyn std::error::Error + Send + Sync>;

/// A runtime the rule retired, and what happens to its stores.
type Retired = Option<(Arc<AccountRuntime>, Stores)>;

/// How long a sign-out's logout may take, cut off as an `ElapsedError`. Uncut it can take three
/// 30 s requests (an OAuth one asks for the versions and the metadata, then revokes; a refreshable
/// session refreshes and sends again), and a detached sign-out must end within `HOLDER_LIMIT`.
const LOGOUT_LIMIT: Duration = Duration::from_secs(60);

/// Every account's logout holds and their streams.
#[derive(Default)]
pub(crate) struct Holds {
    next_id: u64,
    by_account: HashMap<String, AccountHolds>,
    streams: Subscribers<ServerLogoutHoldUpdateDto>,
}

/// One account's holds; dropped with its last one, which forgets what it recorded.
#[derive(Default)]
struct AccountHolds {
    /// Each hold's id and its stream's key.
    ids: Vec<(u64, u64)>,
    died: bool,
    released_as_deleted: bool,
}

impl Holds {
    /// A new hold on the account, live or not, whose stream starts with `held`.
    fn hold(&mut self, account_id: &str) -> (String, Tracked<ServerLogoutHoldUpdateDto>) {
        self.next_id += 1;
        let hold_id = self.next_id.to_string();
        let holds = self.by_account.entry(account_id.to_owned()).or_default();
        let held = ServerLogoutHoldUpdateDto::Held {
            hold_id: hold_id.clone(),
            token_died: holds.died,
        };
        let (key, updates) = self.streams.subscribe(Some(held));
        holds.ids.push((self.next_id, key));
        (hold_id, updates)
    }

    fn is_held(&self, account_id: &str) -> bool {
        self.by_account.contains_key(account_id)
    }

    pub(crate) fn died(&self, account_id: &str) -> bool {
        self.by_account
            .get(account_id)
            .is_some_and(|holds| holds.died)
    }

    /// Records the account's death once, telling its holds.
    fn mark_died(&mut self, account_id: &str) -> Barrier {
        let first = (self.by_account.get_mut(account_id))
            .is_some_and(|holds| !mem::replace(&mut holds.died, true));
        if !first {
            return Barrier::default();
        }
        self.notify(account_id, &ServerLogoutHoldUpdateDto::TokenDied)
    }

    /// A new client registered for the account: it forgets a recorded death, and tells a sign-in
    /// again after a soft logout.
    #[cfg_attr(not(feature = "native"), allow(dead_code))]
    pub(crate) fn registered(&mut self, account_id: &str, signed_in_again: bool) -> Barrier {
        let Some(holds) = self.by_account.get_mut(account_id) else {
            return Barrier::default();
        };
        let mut barrier = Barrier::default();
        if mem::take(&mut holds.died) {
            barrier = self.notify(account_id, &ServerLogoutHoldUpdateDto::TokenRenewed);
        }
        if signed_in_again {
            barrier =
                barrier.join(self.notify(account_id, &ServerLogoutHoldUpdateDto::SignedInAgain));
        }
        barrier
    }

    /// Ends one hold. The account's last one, released never as deleted after its token died,
    /// hands back the account, whose recorded logout then replays.
    fn release(&mut self, hold_id: u64, deleted: bool) -> (Barrier, Option<String>) {
        let Self {
            by_account,
            streams,
            ..
        } = self;
        let found = by_account.iter_mut().find_map(|(account_id, holds)| {
            let at = holds.ids.iter().position(|(id, _)| *id == hold_id)?;
            Some((account_id, holds, at))
        });
        let Some((account_id, holds, at)) = found else {
            return (Barrier::default(), None);
        };
        let (_, key) = holds.ids.remove(at);
        holds.released_as_deleted |= deleted;
        let closed = streams.close(key);
        if !holds.ids.is_empty() {
            return (closed, None);
        }
        let replay = holds.died && !holds.released_as_deleted;
        let account_id = account_id.clone();
        by_account.remove(&account_id);
        (closed, replay.then_some(account_id))
    }

    /// Tells the account's holds that it left this device, and ends them.
    pub(crate) fn release_account(&mut self, account_id: &str) -> Barrier {
        let holds = self.by_account.remove(account_id);
        released(&mut self.streams, holds.into_iter().flat_map(|h| h.ids))
    }

    pub(crate) fn release_all(&mut self) -> Barrier {
        let Self {
            by_account,
            streams,
            ..
        } = self;
        released(streams, by_account.drain().flat_map(|(_, h)| h.ids))
    }

    fn notify(&mut self, account_id: &str, update: &ServerLogoutHoldUpdateDto) -> Barrier {
        let Self {
            by_account,
            streams,
            ..
        } = self;
        let ids = by_account.get(account_id).map_or(&[][..], |h| &h.ids);
        ids.iter().fold(Barrier::default(), |barrier, (_, key)| {
            barrier.join(streams.send_to(*key, update))
        })
    }
}

/// Sends `released` to each hold, then completes its stream.
fn released(
    streams: &mut Subscribers<ServerLogoutHoldUpdateDto>,
    ids: impl IntoIterator<Item = (u64, u64)>,
) -> Barrier {
    ids.into_iter()
        .fold(Barrier::default(), |barrier, (_, key)| {
            let told = streams.send_to(key, &ServerLogoutHoldUpdateDto::Released);
            barrier.join(told).join(streams.close(key))
        })
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TokenDeath {
    Ignore,
    MarkDied,
    Soft,
    Hard,
}

/// What a dead token of the account's client of `generation` means: nothing for a replaced or
/// signed-out client; a soft logout wins over a hold, which keeps a hard one from wiping.
pub(crate) fn token_death(
    current_generation: Option<u32>,
    generation: u32,
    signed_out: bool,
    held: bool,
    soft: bool,
) -> TokenDeath {
    if current_generation != Some(generation) || signed_out {
        TokenDeath::Ignore
    } else if soft {
        TokenDeath::Soft
    } else if held {
        TokenDeath::MarkDied
    } else {
        TokenDeath::Hard
    }
}

/// `Some(soft_logout)` for an `M_UNKNOWN_TOKEN` answer.
pub(crate) fn unknown_token(err: &Error) -> Option<bool> {
    match err.client_api_error_kind()? {
        ErrorKind::UnknownToken(data) => Some(data.soft_logout),
        _ => None,
    }
}

/// Whether the SDK broadcast `UnknownToken`, with the answer's `soft_logout`, before a typed call
/// returned this refresh failure (`client/futures.rs`): a refused OAuth refresh, or any failed
/// Matrix refresh.
fn broadcast_first(err: &Error) -> bool {
    let Error::Http(http) = err else {
        return false;
    };
    match http.as_ref() {
        HttpError::RefreshToken(RefreshTokenError::MatrixAuth(_)) => true,
        HttpError::RefreshToken(oauth @ RefreshTokenError::OAuth(_)) => refresh_logs_out(oauth),
        _ => false,
    }
}

/// An account's token for a raw request, which only this module can make, so every raw request
/// that carries a token meets the token-death rule (O8).
// No `Debug`: it is the token.
pub(crate) struct RawToken(String);

impl RawToken {
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl SessionState {
    /// One locked step of the token-death rule. Returns everything the rule has published for
    /// the account since its start, and the runtime it retired.
    fn token_died(&mut self, account_id: &str, generation: u32, soft: bool) -> (Barrier, Retired) {
        self.deaths_seen.send_replace(());
        let runtime = self.runtimes.get(account_id);
        let current = runtime.map(|rt| rt.generation);
        let signed_out = runtime.is_some_and(|rt| rt.signed_out.load(Ordering::Relaxed));
        let held = self.holds.is_held(account_id);
        let (published, retired) = match token_death(current, generation, signed_out, held, soft) {
            TokenDeath::Ignore => {
                let recorded = self.deaths.get(account_id).cloned();
                return (recorded.unwrap_or_default(), None);
            }
            TokenDeath::MarkDied => {
                if let Some(rt) = runtime {
                    let service = Arc::clone(&rt.sync_service);
                    drop(spawn(async move { stop_sync(&service).await }));
                }
                (self.holds.mark_died(account_id), None)
            }
            TokenDeath::Soft => self.logged_out(account_id, true),
            TokenDeath::Hard => self.logged_out(account_id, false),
        };
        let pending = self.deaths.entry(account_id.to_owned()).or_default();
        *pending = mem::take(pending).join(published);
        (pending.clone(), retired)
    }

    /// Whether the rule has nothing left to do for the account's client of `generation`.
    fn death_settled(&self, account_id: &str, generation: u32) -> bool {
        let runtime = self.runtimes.get(account_id);
        let current = runtime.filter(|rt| rt.generation == generation);
        current.is_none_or(|rt| rt.signed_out.load(Ordering::Relaxed))
            || self.holds.died(account_id)
    }

    /// Retires the account after a server logout: a soft one keeps its stores and flags it.
    fn logged_out(&mut self, account_id: &str, soft: bool) -> (Barrier, Retired) {
        let runtime = self.retire(account_id);
        if soft {
            self.registry.mark_soft_logged_out(account_id);
        }
        let published = self.publish_snapshot();
        let account_id = account_id.to_owned();
        let active_account_id = self.snapshot.active_account_id.clone();
        let effect = if soft {
            SessionStorageEffectDto::SoftLogout {
                account_id,
                active_account_id,
            }
        } else {
            SessionStorageEffectDto::HardLogout {
                account_id,
                active_account_id,
            }
        };
        let effected = self.effects.publish(&effect);
        let stores = if soft { Stores::Keep } else { Stores::Delete };
        (published.join(effected), runtime.map(|rt| (rt, stores)))
    }
}

impl Engine {
    /// The token-death rule for the account's client of `generation`. Its barrier also covers
    /// what the rule published for the account before, such as for the sync meeting the token.
    pub(crate) fn server_logout(
        self: &Arc<Self>,
        account_id: &str,
        generation: u32,
        soft: bool,
    ) -> Barrier {
        let mut state = self.state.lock();
        let (barrier, retired) = state.token_died(account_id, generation, soft);
        // Queued under the lock, so a start of the account that follows awaits it.
        self.tear_down_retired(account_id, retired);
        barrier
    }

    /// For hosts that stand in for the SDK's broadcast, such as the test host.
    pub async fn simulate_server_logout(self: &Arc<Self>, account_id: &str, soft: bool) {
        let Some(generation) = self.account(account_id).map(|rt| rt.generation) else {
            return;
        };
        self.server_logout(account_id, generation, soft)
            .delivered()
            .await;
    }

    /// The cross-slice rule: marks a dead token before the command replies.
    pub(crate) fn on_request_error(
        self: &Arc<Self>,
        rt: &AccountRuntime,
        err: &Error,
    ) -> Option<Barrier> {
        let soft = unknown_token(err)?;
        Some(self.server_logout(&rt.account_id, rt.generation, soft))
    }

    /// The rule for a typed call's error. The SDK may have reported the death through its
    /// broadcast instead, before it returned a refused refresh: that one is awaited too.
    pub(crate) async fn after_request_error(self: &Arc<Self>, rt: &AccountRuntime, err: &Error) {
        let barrier = match self.on_request_error(rt, err) {
            Some(barrier) => barrier,
            None if broadcast_first(err) => self.broadcast_death(rt).await,
            None => return,
        };
        barrier.delivered().await;
    }

    /// A command's typed call through the account's client (O8): a refresh it made, and the rule
    /// for its error, reach the subscribers before it returns.
    pub(crate) async fn ruled<T, E: Into<Error>>(
        self: &Arc<Self>,
        rt: &AccountRuntime,
        call: impl IntoFuture<Output = Result<T, E>>,
    ) -> Result<T, Error> {
        let outcome = call.await.map_err(Into::into);
        self.rotation_of(&rt.account_id).delivered().await;
        if let Err(err) = &outcome {
            self.after_request_error(rt, err).await;
        }
        outcome
    }

    /// What the rule recorded for the death the SDK broadcast before a typed call failed, once
    /// the session task has taken it, waiting at most [`DELIVERY_LIMIT`].
    async fn broadcast_death(&self, rt: &AccountRuntime) -> Barrier {
        let settled = async {
            loop {
                let mut seen = {
                    let state = self.state.lock();
                    if state.death_settled(&rt.account_id, rt.generation) {
                        return;
                    }
                    state.deaths_seen.subscribe()
                };
                if seen.changed().await.is_err() {
                    return;
                }
            }
        };
        if timeout(settled, DELIVERY_LIMIT).await.is_err() {
            tracing::warn!("the SDK's logout broadcast did not arrive");
        }
        self.deaths_of(&rt.account_id)
    }

    /// Ends a hold; an unknown id is ignored. The account's last hold, released never as
    /// deleted, replays the logout it recorded through the hard path.
    pub(crate) fn release_hold(self: &Arc<Self>, hold_id: &str, deleted: bool) -> Barrier {
        let Ok(hold_id) = hold_id.parse() else {
            return Barrier::default();
        };
        let mut state = self.state.lock();
        let (closed, replay) = state.holds.release(hold_id, deleted);
        let current = replay.and_then(|account_id| {
            let generation = state.runtimes.get(&account_id)?.generation;
            Some((account_id, generation))
        });
        let Some((account_id, generation)) = current else {
            return closed;
        };
        let (published, retired) = state.token_died(&account_id, generation, false);
        self.tear_down_retired(&account_id, retired);
        closed.join(published)
    }

    /// What the rule has published for the account since its start.
    pub(crate) fn deaths_of(&self, account_id: &str) -> Barrier {
        let state = self.state.lock();
        state.deaths.get(account_id).cloned().unwrap_or_default()
    }

    /// What the last refresh of the account's tokens published.
    pub(crate) fn rotation_of(&self, account_id: &str) -> Barrier {
        let state = self.state.lock();
        state.rotations.get(account_id).cloned().unwrap_or_default()
    }

    /// Logs the account out at its homeserver, its sync stopped first, so its own logout is no
    /// token death. A failed logout meets the rule: a dead token still logs the account out.
    pub(crate) async fn sign_out(self: &Arc<Self>, rt: &Arc<AccountRuntime>) -> Result<(), Error> {
        self.sign_out_within(rt, LOGOUT_LIMIT).await
    }

    async fn sign_out_within(
        self: &Arc<Self>,
        rt: &Arc<AccountRuntime>,
        limit: Duration,
    ) -> Result<(), Error> {
        rt.signed_out.store(true, Ordering::Relaxed);
        stop_sync(&rt.sync_service).await;
        let logout = timeout(self.logout_request(rt), limit).await;
        let logout = logout.unwrap_or_else(|elapsed| Err(Error::UnknownError(elapsed.into())));
        let Err(err) = logout else {
            return Ok(());
        };
        rt.signed_out.store(false, Ordering::Relaxed);
        self.after_request_error(rt, &err).await;
        Err(err)
    }

    /// The account's logout, sent once (S17). The SDK fetches an OAuth server's metadata with the
    /// client's own retrying config, so a client that never retries revokes an OAuth token.
    async fn logout_request(&self, rt: &AccountRuntime) -> Result<(), Error> {
        let Some(oauth) = rt.client.oauth().full_session() else {
            let request = rt.client.send(logout::v3::Request::new());
            request.with_request_config(sent_once()).await?;
            return Ok(());
        };
        let client = (self.logout_client(&rt.base_url).await)
            .map_err(|err| Error::UnknownError(err.into()))?;
        client.restore_session(oauth).await?;
        client.logout().await
    }

    /// A client for one logout: it keeps no store, never refreshes and never retries.
    async fn logout_client(&self, base_url: &str) -> Result<Client, ClientBuildError> {
        (self.client_builder().homeserver_url(base_url))
            .request_config(sent_once())
            .build()
            .await
    }

    fn tear_down_retired(&self, account_id: &str, retired: Retired) {
        if let Some((runtime, stores)) = retired {
            drop(self.tear_down(account_id, Some(runtime), stores));
        }
    }
}

/// A GET with the client's token, outside the SDK's token handling: on an `M_UNKNOWN_TOKEN`
/// from a refreshable session it refreshes once through the SDK, whose lock joins a refresh
/// already in flight, and retries once the rotation is delivered. A refused refresh keeps the
/// dead token's answer; any other refresh failure is returned, and is no token death.
pub(crate) async fn get_with_refresh(
    engine: &Engine,
    client: &Client,
    refreshable: bool,
    url: Url,
    timeout: Duration,
) -> Result<Bytes, Error> {
    match get(engine, client, url.clone(), timeout).await {
        Err(err) if refreshable && unknown_token(&err).is_some() => {
            match client.refresh_access_token().await {
                Ok(()) => {}
                Err(refresh) if refresh_logs_out(&refresh) => return Err(err),
                Err(refresh) => return Err(HttpError::RefreshToken(refresh).into()),
            }
            if let Some(account_id) = client.user_id() {
                engine.rotation_of(account_id.as_str()).delivered().await;
            }
            get(engine, client, url, timeout).await
        }
        answer => answer,
    }
}

/// The body of a 2xx answer, or the error the SDK would have made of the answer.
async fn get(
    engine: &Engine,
    client: &Client,
    url: Url,
    timeout: Duration,
) -> Result<Bytes, Error> {
    let token = client.access_token().map(RawToken);
    let (status, body) = engine.raw_get(url, token.as_ref(), timeout).await?;
    if !status.is_success() {
        return Err(http_error_from_response(status, &body).into());
    }
    Ok(body)
}

/// [`get_with_refresh`] with a live account's client; a failure meets the token-death rule
/// before it is returned (O8). Its own refresh never broadcasts, so no broadcast is awaited.
pub(crate) async fn raw_get(
    engine: &Arc<Engine>,
    rt: &AccountRuntime,
    url: Url,
    timeout: Duration,
) -> Result<Bytes, Error> {
    let answer = get_with_refresh(engine, &rt.client, rt.refreshable, url, timeout).await;
    let died = answer
        .as_ref()
        .err()
        .and_then(|err| engine.on_request_error(rt, err));
    if let Some(barrier) = died {
        barrier.delivered().await;
    }
    answer
}

/// The SDK's reload callback, which runs only under the cross-process lock, which is off.
#[cfg_attr(not(feature = "native"), allow(dead_code))]
pub(crate) fn reload_tokens(client: Client) -> Result<SessionTokens, CallbackError> {
    client.session_tokens().ok_or_else(|| "no session".into())
}

/// The SDK's save callback, which runs once the client has adopted refreshed tokens, retired or
/// not. It republishes the live tokens, and always reports the rotation for storage to save, as
/// js persists for a retired client.
#[cfg_attr(not(feature = "native"), allow(dead_code))]
pub(crate) fn save_tokens_callback(
    engine: Weak<Engine>,
    account_id: String,
    lineage: Option<String>,
) -> impl Fn(Client) -> Result<(), CallbackError> {
    move |client| {
        let Some(engine) = engine.upgrade() else {
            return Ok(());
        };
        let tokens = client.session_tokens().ok_or("no session")?;
        let mut state = engine.state.lock();
        // Only a current client's token is published, and a refreshed one has no expiry (H8).
        let published = state.publish_snapshot();
        let rotated = state
            .effects
            .publish(&SessionStorageEffectDto::TokensRotated {
                account_id: account_id.clone(),
                lineage: lineage.clone(),
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
                expires_at: None,
            });
        // The latest rotation's delivery covers the earlier ones: each stream emits in order.
        let rotation = published.join(rotated);
        state.rotations.insert(account_id.clone(), rotation);
        Ok(())
    }
}

pub(crate) fn uia_auth_data(auth: UiaAuthDto) -> AuthData {
    match auth {
        UiaAuthDto::Password {
            identifier,
            password,
            session,
            ..
        } => {
            let user = UserIdentifier::Matrix(MatrixUserIdentifier::new(identifier.user));
            let mut stage = Password::new(user, password);
            stage.session = Some(session);
            AuthData::Password(stage)
        }
        UiaAuthDto::Session { session } => {
            AuthData::FallbackAcknowledgement(FallbackAcknowledgement::new(session))
        }
    }
}

/// A hold on the account, live or not: `held`, then what happens to the account. Closing the
/// stream releases the hold as not deleted.
pub fn hold_server_logout(engine: Arc<Engine>, account_id: String) -> Stream {
    let (hold_id, updates) = engine.state.lock().holds.hold(&account_id);
    let hold = Hold {
        updates,
        hold_id,
        engine: Arc::downgrade(&engine),
    };
    stream(hold.map(item))
}

pub fn release_server_logout_hold(engine: Arc<Engine>, hold_id: String, deleted: bool) -> Stream {
    done(async move { engine.release_hold(&hold_id, deleted).delivered().await })
}

pub fn deactivate_account(
    engine: Arc<Engine>,
    account_id: String,
    erase: bool,
    auth: Option<UiaAuthDto>,
) -> Stream {
    reply(on_account(
        engine,
        account_id,
        request_failure,
        move |engine, rt| async move {
            let mut request = deactivate::v3::Request::new();
            (request.auth, request.erase) = (auth.map(uia_auth_data), erase);
            let deactivate = rt.client.send(request).with_request_config(sent_once());
            engine.ruled(&rt, deactivate).await.map(drop)
        },
    ))
}

/// Logs a live account out at its homeserver; it stays live with its sync stopped. Detached, so a
/// close never leaves it signed out without its logout. It ends within `HOLDER_LIMIT` (120 s): a
/// stop of at most 30 s, a logout cut off after `LOGOUT_LIMIT` (60 s), then the rule's delivery
/// waits of at most 10 s, 100 s in all.
pub fn logout_remote(engine: Arc<Engine>, account_id: String) -> Stream {
    detached(on_account(
        engine,
        account_id,
        request_failure,
        |engine, rt| async move { engine.sign_out(&rt).await },
    ))
}

/// Logs every live account out at its homeserver, ignoring failures; detached, and as long as
/// `logoutRemote`, since the sign-outs run side by side.
pub fn sign_out_all(engine: Arc<Engine>) -> Stream {
    detached(async move {
        let engine = &engine;
        // Each runtime moves into its own sign-out, so it is let go of as that one ends.
        let sign_outs = (engine.live_runtimes().into_iter())
            .map(|rt| async move { drop(engine.sign_out(&rt).await) });
        join_all(sign_outs).await;
        Value::Null
    })
}

/// Logs out a session that is not live, through a client that keeps no store and never
/// refreshes, so no live account and no stored token changes.
pub fn logout_session(engine: Arc<Engine>, session: MatrixSessionDto) -> Stream {
    stream(stream::once(async move {
        let meta = session_meta("session.logoutSession", &session)?;
        let built = engine.logout_client(&session.base_url).await;
        let client = built.map_err(|_| {
            Fault::new(
                FaultCode::ClientBuildFailed,
                "the logout client did not build",
            )
        })?;
        let logged_out = async {
            client.restore_session(auth_session(&session, meta)).await?;
            client.logout().await
        };
        item(match logged_out.await {
            Ok(()) => EngineResult::Ok(()),
            Err(err) => EngineResult::Err(request_failure(&err)),
        })
    }))
}

/// The storage writes the caller owes the engine, from subscribe on, with no replay.
pub fn storage_effects(engine: Arc<Engine>) -> Stream {
    let (_, effects) = engine.state.lock().effects.subscribe(None);
    stream(effects.map(item))
}

/// A hold's stream. Dropped, as when the carrier closes it, it releases the hold as not
/// deleted, which a hold already released ignores.
struct Hold {
    updates: Tracked<ServerLogoutHoldUpdateDto>,
    hold_id: String,
    engine: Weak<Engine>,
}

impl futures_util::Stream for Hold {
    type Item = ServerLogoutHoldUpdateDto;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.updates.poll_next_unpin(cx)
    }
}

impl Drop for Hold {
    fn drop(&mut self) {
        if let Some(engine) = self.engine.upgrade() {
            let _ = engine.release_hold(&self.hold_id, false);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;

    use futures_util::{FutureExt, StreamExt};
    use matrix_sdk::{
        SessionMeta,
        authentication::{
            matrix::MatrixSession,
            oauth::{
                OAuthError,
                error::{BasicErrorResponseType, RequestTokenError, StandardErrorResponse},
            },
        },
        ruma::{exports::http::StatusCode, owned_user_id},
        sleep::sleep,
    };
    use serde_json::{Value, json};
    use tempfile::TempDir;

    use super::*;
    use crate::{
        config::EngineConfig,
        engines::session::reads::account_status,
        failure::{FailureCode, FailureKind, RefreshCause, http_error_from_response},
        testing::{
            WHOAMI, builder_on, default_client, engine_in, live, password, requests, scripted,
            session,
        },
    };

    #[test]
    fn ignores_token_death_from_a_signed_out_or_replaced_runtime() {
        use TokenDeath::*;
        let table = [
            // (current, generation, signed_out, held, soft)
            ((Some(2), 1, false, false, false), Ignore),
            ((None, 1, false, true, true), Ignore),
            ((Some(1), 1, true, false, false), Ignore),
            ((Some(1), 1, true, true, true), Ignore),
            ((Some(1), 1, false, true, true), Soft),
            ((Some(1), 1, false, false, true), Soft),
            ((Some(1), 1, false, true, false), MarkDied),
            ((Some(1), 1, false, false, false), Hard),
        ];
        for ((current, generation, signed_out, held, soft), expected) in table {
            let label = format!("{current:?} {generation} {signed_out} {held} {soft}");
            assert_eq!(
                token_death(current, generation, signed_out, held, soft),
                expected,
                "{label}"
            );
        }
    }

    #[test]
    fn a_held_death_replays_only_when_the_last_hold_is_released_as_not_deleted() {
        let mut holds = Holds::default();
        let kinds = |updates: &mut Tracked<_>| {
            let polled = std::iter::from_fn(|| updates.next().now_or_never().flatten());
            let kinds = polled.map(|u| serde_json::to_value(u).unwrap()["kind"].clone());
            kinds.collect::<Vec<_>>()
        };
        let (first, mut one) = holds.hold("@a:b");
        let (second, mut two) = holds.hold("@a:b");
        assert_eq!((first.as_str(), second.as_str()), ("1", "2"));
        let _ = holds.mark_died("@a:b");
        let _ = holds.mark_died("@a:b");
        assert_eq!(kinds(&mut one), ["held", "token-died"], "told once");
        let (_, replay) = holds.release(1, false);
        assert_eq!(replay, None, "a hold is left");
        let (_, replay) = holds.release(2, false);
        assert_eq!(replay.as_deref(), Some("@a:b"));
        assert_eq!(kinds(&mut two), ["held", "token-died"]);
        assert!(!holds.is_held("@a:b") && !holds.died("@a:b"), "forgotten");

        let (_, _one) = holds.hold("@a:b");
        let (_, _two) = holds.hold("@a:b");
        let _ = holds.mark_died("@a:b");
        assert_eq!(holds.release(3, true).1, None);
        assert_eq!(
            holds.release(4, false).1,
            None,
            "one was released as deleted"
        );

        let (_, mut renewed) = holds.hold("@a:b");
        let _ = holds.mark_died("@a:b");
        let _ = holds.registered("@a:b", true);
        let told = ["held", "token-died", "token-renewed", "signed-in-again"];
        assert_eq!(kinds(&mut renewed), told);
        assert_eq!(
            holds.release(5, false).1,
            None,
            "the renewal forgot the death"
        );
        assert_eq!(holds.release(5, false).1, None, "an unknown id is ignored");
    }

    fn answer(status: u16, body: Value) -> Error {
        let status = StatusCode::from_u16(status).unwrap();
        http_error_from_response(status, body.to_string().as_bytes()).into()
    }

    fn unknown(soft_logout: Option<bool>) -> Value {
        let mut body = json!({"errcode": "M_UNKNOWN_TOKEN", "error": "x"});
        if let Some(soft) = soft_logout {
            body["soft_logout"] = json!(soft);
        }
        body
    }

    #[tokio::test]
    async fn unknown_token_reads_soft_logout_from_the_error() {
        assert_eq!(unknown_token(&answer(401, unknown(Some(true)))), Some(true));
        assert_eq!(
            unknown_token(&answer(401, unknown(Some(false)))),
            Some(false)
        );
        assert_eq!(unknown_token(&answer(401, unknown(None))), Some(false));
        let forbidden = json!({"errcode": "M_FORBIDDEN", "error": "x"});
        assert_eq!(unknown_token(&answer(403, forbidden)), None);
        let engine = Engine::new(EngineConfig::default()).unwrap();
        let refused = Url::parse("http://127.0.0.1:1/x").unwrap();
        let network = engine
            .raw_get(refused, None, Duration::from_secs(5))
            .await
            .unwrap_err();
        assert_eq!(unknown_token(&network.into()), None);
    }

    #[test]
    fn waits_for_a_broadcast_only_where_the_sdk_sends_one() {
        let refresh = |e| Error::from(HttpError::RefreshToken(e));
        let oauth = |e| refresh(RefreshTokenError::OAuth(Arc::new(e)));
        let grant = StandardErrorResponse::new(BasicErrorResponseType::InvalidGrant, None, None);
        let refused = oauth(OAuthError::RefreshToken(RequestTokenError::ServerResponse(
            grant,
        )));
        let unavailable = answer(502, json!({"errcode": "M_UNKNOWN", "error": "x"}));
        let Error::Http(unavailable) = unavailable else {
            unreachable!()
        };
        assert!(broadcast_first(&refused));
        assert!(broadcast_first(&refresh(RefreshTokenError::MatrixAuth(
            unavailable.into()
        ))));
        assert!(!broadcast_first(&oauth(OAuthError::NotAuthenticated)));
        assert!(!broadcast_first(&refresh(
            RefreshTokenError::RefreshTokenRequired
        )));
        assert!(!broadcast_first(&answer(401, unknown(None))));
    }

    #[test]
    fn uia_auth_maps_to_auth_data() {
        let to_json = |auth: Value| {
            let auth: UiaAuthDto = serde_json::from_value(auth).unwrap();
            serde_json::to_value(uia_auth_data(auth)).unwrap()
        };
        let password = json!({
            "type": "m.login.password",
            "identifier": {"type": "m.id.user", "user": "@a:b"},
            "password": "pw",
            "session": "s",
        });
        assert_eq!(to_json(password.clone()), password);
        assert_eq!(to_json(json!({"session": "s"})), json!({"session": "s"}));
    }

    const GET_X: &str = "GET /x";
    const REFRESH: &str = "POST /_matrix/client/v3/refresh";

    /// A client restored with `t1`/`r1`.
    async fn client_on(base: &str) -> Client {
        let client = builder_on(base).build().await.unwrap();
        let meta = SessionMeta {
            user_id: owned_user_id!("@a:b"),
            device_id: "DEV".into(),
        };
        let tokens = SessionTokens {
            access_token: "t1".into(),
            refresh_token: Some("r1".into()),
        };
        client
            .restore_session(MatrixSession { meta, tokens })
            .await
            .unwrap();
        client
    }

    fn get(token: &str) -> (String, Option<String>) {
        (GET_X.into(), Some(format!("Bearer {token}")))
    }

    fn refresh() -> (String, Option<String>) {
        (REFRESH.into(), None)
    }

    async fn fetched(base: &str, client: &Client, refreshable: bool) -> Result<Bytes, Error> {
        let engine = Engine::new(EngineConfig::default()).unwrap();
        let url = Url::parse(&format!("{base}/x")).unwrap();
        get_with_refresh(&engine, client, refreshable, url, Duration::from_secs(5)).await
    }

    fn refreshed() -> (&'static str, u16, Value) {
        (
            REFRESH,
            200,
            json!({"access_token": "t2", "refresh_token": "r2"}),
        )
    }

    #[tokio::test]
    async fn raw_get_refreshes_once_and_retries_for_a_refreshable_session() {
        let (base, seen) = scripted(vec![
            (GET_X, 401, unknown(Some(true))),
            refreshed(),
            (GET_X, 200, json!({})),
        ]);
        let client = client_on(&base).await;
        let body = fetched(&base, &client, true).await.unwrap();
        assert_eq!(body.as_ref(), b"{}");
        assert_eq!(requests(&seen), [get("t1"), refresh(), get("t2")]);
        let tokens = client.session_tokens().unwrap();
        assert_eq!(
            (
                tokens.access_token.as_str(),
                tokens.refresh_token.as_deref()
            ),
            ("t2", Some("r2"))
        );
    }

    #[tokio::test]
    async fn raw_get_reports_a_second_401_after_a_refresh() {
        let dead = || (GET_X, 401, unknown(Some(true)));
        let (base, seen) = scripted(vec![dead(), refreshed(), dead()]);
        let client = client_on(&base).await;
        let err = fetched(&base, &client, true).await.unwrap_err();
        assert_eq!(unknown_token(&err), Some(true));
        assert_eq!(requests(&seen), [get("t1"), refresh(), get("t2")]);
    }

    #[tokio::test]
    async fn raw_get_reports_a_401_at_once_without_a_refresh_token() {
        let (base, seen) = scripted(vec![(GET_X, 401, unknown(None))]);
        let client = client_on(&base).await;
        let err = fetched(&base, &client, false).await.unwrap_err();
        assert_eq!(unknown_token(&err), Some(false));
        assert_eq!(requests(&seen), [get("t1")]);
    }

    /// Records every storage effect, polling as the carrier does.
    fn record(engine: &Arc<Engine>) -> Arc<StdMutex<Vec<Value>>> {
        let recorded = Arc::new(StdMutex::new(Vec::new()));
        let (sink, mut effects) = (Arc::clone(&recorded), storage_effects(Arc::clone(engine)));
        spawn(async move {
            while let Some(effect) = effects.next().await {
                sink.lock().unwrap().push(effect.unwrap());
            }
        });
        recorded
    }

    #[tokio::test]
    async fn raw_get_keeps_the_account_after_a_transient_refresh_failure() {
        let unavailable = json!({"errcode": "M_UNKNOWN", "error": "x"});
        let (base, _) = scripted(vec![
            (GET_X, 401, unknown(None)),
            (REFRESH, 502, unavailable),
        ]);
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let effects = record(&engine);
        let s = session("@a:b", &base);
        let rt = live(&engine, &s, builder_on(&base).build().await.unwrap()).await;
        let url = Url::parse(&format!("{base}/x")).unwrap();
        let err = raw_get(&engine, &rt, url, Duration::from_secs(5))
            .await
            .unwrap_err();
        assert_eq!(unknown_token(&err), None, "no token death");
        let FailureCode::RequestFailed { cause, .. } = request_failure(&err).code else {
            panic!("not request-failed");
        };
        assert_eq!(cause, Some(RefreshCause::SessionRefresh));
        assert!(engine.account("@a:b").is_some());
        assert!(effects.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_refused_refresh_reports_the_logout_the_sdk_broadcast_before_the_reply() {
        let (base, _) = scripted(vec![
            (WHOAMI, 401, unknown(Some(true))),
            (REFRESH, 401, unknown(None)),
        ]);
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let effects = record(&engine);
        let s = session("@a:b", &base);
        let client = builder_on(&base)
            .handle_refresh_tokens()
            .build()
            .await
            .unwrap();
        let rt = live(&engine, &s, client).await;
        let err = Error::from(rt.client.whoami().await.unwrap_err());
        assert_eq!(unknown_token(&err), None, "a refresh error, not the 401");
        engine.after_request_error(&rt, &err).await;
        assert_eq!(
            *effects.lock().unwrap(),
            [json!({"kind": "soft-logout", "accountId": "@a:b", "activeAccountId": null})]
        );
    }

    #[tokio::test]
    async fn a_server_logout_reports_its_effect_and_a_later_request_awaits_it() {
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let mut effects = storage_effects(Arc::clone(&engine));
        let offline = |id| session(id, "http://127.0.0.1:1");
        let client = || builder_on("http://127.0.0.1:1").build();
        let a = live(&engine, &offline("@a:b"), client().await.unwrap()).await;
        let c = live(&engine, &offline("@c:d"), client().await.unwrap()).await;
        let _ = engine.set_active("@a:b");
        let mut next = || effects.next().now_or_never().flatten().map(Result::unwrap);

        let _ = engine.server_logout("@a:b", a.generation, true);
        assert_eq!(
            next(),
            Some(json!({"kind": "soft-logout", "accountId": "@a:b", "activeAccountId": "@c:d"}))
        );
        // The retired client is ignored, yet its request waits until the logout is emitted.
        let mut later = Box::pin(
            engine
                .server_logout("@a:b", a.generation, false)
                .delivered(),
        );
        assert!(later.as_mut().now_or_never().is_none());
        assert_eq!(next(), None);
        assert!(later.now_or_never().is_some());
        let snapshot = engine.state.lock().snapshot.clone();
        assert_eq!(snapshot.soft_logged_out, ["@a:b"]);
        assert_eq!(snapshot.accounts.len(), 1);

        let _ = engine.server_logout("@c:d", c.generation, false);
        assert_eq!(
            next(),
            Some(json!({"kind": "hard-logout", "accountId": "@c:d", "activeAccountId": null}))
        );
        assert!(engine.account("@c:d").is_none());

        let _ = engine.server_logout("@x:y", 1, false);
        drop(c);
        engine.remove("@c:d").await;
        let deaths = engine
            .state
            .lock()
            .deaths
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(
            deaths,
            ["@a:b"],
            "nothing for an ignored death or a removed account"
        );
    }

    #[tokio::test]
    async fn logout_session_fails_network_for_an_unreachable_homeserver() {
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let mut password = session("@a:b", "http://127.0.0.1:1");
        (password.oidc, password.refresh_token) = (None, None);
        let mut reply = logout_session(Arc::clone(&engine), password);
        let reply = reply.next().await.unwrap().unwrap();
        assert_eq!(reply["ok"], json!(false));
        assert_eq!(reply["failure"]["kind"], json!("network"));
        assert!(engine.state.lock().snapshot.accounts.is_empty());
        assert!(!root.path().join("data").exists(), "no store");
    }

    #[tokio::test]
    async fn its_own_logout_keeps_the_account_but_a_dead_token_logs_it_out() {
        const LOGOUT: &str = "POST /_matrix/client/v3/logout";
        let (base, _) = scripted(vec![(LOGOUT, 200, json!({})), (LOGOUT, 401, unknown(None))]);
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let effects = record(&engine);
        let mut password = session("@a:b", &base);
        (password.oidc, password.refresh_token) = (None, None);
        let rt = live(&engine, &password, builder_on(&base).build().await.unwrap()).await;
        let logout = || logout_remote(Arc::clone(&engine), "@a:b".into());

        let first = logout().next().await.unwrap().unwrap();
        assert_eq!(first, json!({"ok": true, "value": null}));
        assert!(engine.account("@a:b").is_some() && rt.signed_out.load(Ordering::Relaxed));
        drop(rt);
        assert!(effects.lock().unwrap().is_empty());

        let second = logout().next().await.unwrap().unwrap();
        assert_eq!(second["failure"]["code"], json!("request-failed"));
        assert_eq!(
            *effects.lock().unwrap(),
            [json!({"kind": "hard-logout", "accountId": "@a:b", "activeAccountId": null})]
        );
        assert!(engine.account("@a:b").is_none());
    }

    #[tokio::test]
    async fn a_malformed_session_to_log_out_is_a_fault_that_quotes_no_value() {
        let engine = Engine::new(EngineConfig::default()).unwrap();
        let mut s = session("not-a-user-id", "http://127.0.0.1:1");
        s.access_token = "secret-token".into();
        let fault = logout_session(engine, s).next().await.unwrap().unwrap_err();
        assert_eq!(fault.code, FaultCode::BadArgs);
        assert!(!fault.diagnostic.contains("secret-token") && !fault.diagnostic.contains("not-a"));
    }

    #[tokio::test]
    async fn the_save_callback_emits_tokens_rotated_with_the_lineage() {
        let engine = Engine::new(EngineConfig::default()).unwrap();
        let mut effects = storage_effects(Arc::clone(&engine));
        let client = client_on("http://127.0.0.1:1").await;
        let save = save_tokens_callback(Arc::downgrade(&engine), "@a:b".into(), Some("L".into()));
        save(client).unwrap();
        let mut rotated = Box::pin(engine.rotation_of("@a:b").delivered());
        let effect = effects.next().now_or_never().flatten().unwrap().unwrap();
        assert!(
            rotated.as_mut().now_or_never().is_none(),
            "taken, not yet emitted"
        );
        assert!(effects.next().now_or_never().is_none());
        assert!(rotated.now_or_never().is_some());
        assert_eq!(
            effect,
            json!({
                "kind": "tokens-rotated",
                "accountId": "@a:b",
                "lineage": "L",
                "accessToken": "t1",
                "refreshToken": "r1",
                "expiresAt": null,
            })
        );
    }

    #[tokio::test]
    async fn a_typed_call_replies_once_the_rotation_of_its_refresh_is_delivered() {
        let (base, _) = scripted(vec![
            (WHOAMI, 401, unknown(None)),
            refreshed(),
            (WHOAMI, 200, json!({"user_id": "@a:b"})),
        ]);
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let mut effects = storage_effects(Arc::clone(&engine));
        let client = builder_on(&base)
            .handle_refresh_tokens()
            .build()
            .await
            .unwrap();
        let save = save_tokens_callback(Arc::downgrade(&engine), "@a:b".into(), None);
        (client.set_session_callbacks(Box::new(reload_tokens), Box::new(save))).unwrap();
        drop(live(&engine, &session("@a:b", &base), client).await);
        let mut status = account_status(Arc::clone(&engine), "@a:b".into());
        let mut reply = Box::pin(status.next());
        let early = timeout(reply.as_mut(), Duration::from_secs(1)).await;
        assert!(early.is_err(), "the reply waits for tokens-rotated");
        let rotated = effects.next().await.unwrap().unwrap();
        assert_eq!(rotated["kind"], json!("tokens-rotated"));
        assert!(effects.next().now_or_never().is_none());
        assert_eq!(reply.await.unwrap().unwrap(), json!("active"));
    }

    /// As in js, one 5xx fails an account command: the SDK's default would send it again, and a
    /// deactivation the server completed would then meet the dead token. An OAuth logout fetches
    /// the server's metadata first.
    #[tokio::test]
    async fn an_account_command_fails_on_a_5xx_without_a_retry() {
        const DEACTIVATE: &str = "POST /_matrix/client/v3/account/deactivate";
        const LOGOUT: &str = "POST /_matrix/client/v3/logout";
        const METADATA: &str = "GET /_matrix/client/v1/auth_metadata";
        type Account = fn(&str) -> MatrixSessionDto;
        type Command = fn(Arc<Engine>, &str) -> Stream;
        let oauth: Account = |base| session("@a:b", base);
        let commands: [(_, _, Account, Command, _); 6] = [
            (
                WHOAMI,
                json!({"user_id": "@a:b"}),
                password,
                |engine, _| account_status(engine, "@a:b".into()),
                "unreachable",
            ),
            (
                DEACTIVATE,
                json!({"id_server_unbind_result": "success"}),
                password,
                |engine, _| deactivate_account(engine, "@a:b".into(), false, None),
                "server",
            ),
            (
                LOGOUT,
                json!({}),
                password,
                |engine, _| logout_remote(engine, "@a:b".into()),
                "server",
            ),
            (
                METADATA,
                json!({}),
                oauth,
                |engine, _| logout_remote(engine, "@a:b".into()),
                "server",
            ),
            (
                LOGOUT,
                json!({}),
                password,
                |engine, base| logout_session(engine, password(base)),
                "server",
            ),
            (
                METADATA,
                json!({}),
                password,
                |engine, base| logout_session(engine, session("@a:b", base)),
                "server",
            ),
        ];
        for (request, ok, account, command, failure) in commands {
            let unavailable = json!({"errcode": "M_UNKNOWN", "error": "x"});
            let (base, seen) = scripted(vec![(request, 502, unavailable), (request, 200, ok)]);
            let root = TempDir::new().unwrap();
            let engine = engine_in(&root);
            let account = account(&base);
            drop(live(&engine, &account, default_client(&engine, &account).await).await);
            let reply = command(Arc::clone(&engine), &base).next().await;
            let reply = reply.unwrap().unwrap();
            let kind = reply.pointer("/failure/kind").unwrap_or(&reply);
            assert_eq!(
                (requests(&seen).len(), kind),
                (1, &json!(failure)),
                "{request}"
            );
        }
    }

    /// Closed after its first poll, a sign-out still ends: its failed logout clears the sign-out,
    /// so the account may sync again.
    #[tokio::test]
    async fn a_sign_out_closed_mid_flight_still_settles() {
        const LOGOUT: &str = "POST /_matrix/client/v3/logout";
        let commands: [fn(Arc<Engine>) -> Stream; 2] =
            [|engine| logout_remote(engine, "@a:b".into()), sign_out_all];
        for command in commands {
            let unavailable = json!({"errcode": "M_UNKNOWN", "error": "x"});
            let (base, seen) = scripted(vec![(LOGOUT, 502, unavailable)]);
            let root = TempDir::new().unwrap();
            let engine = engine_in(&root);
            let client = builder_on(&base).build().await.unwrap();
            let rt = live(&engine, &password(&base), client).await;
            let mut closed = command(Arc::clone(&engine));
            assert!(
                closed.next().now_or_never().is_none(),
                "the logout is in flight"
            );
            drop(closed);
            let settled = async {
                while requests(&seen).is_empty() || !engine.may_sync("@a:b", rt.generation) {
                    sleep(Duration::from_millis(10)).await;
                }
            };
            let settled = timeout(settled, Duration::from_secs(5)).await;
            assert!(settled.is_ok(), "the close cut the sign-out short");
        }
    }

    /// A logout that never answers is cut off at its limit as a `timeout` failure, and the
    /// account may sync again.
    #[tokio::test]
    async fn a_logout_that_never_answers_is_cut_off_as_a_timeout() {
        let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", silent.local_addr().unwrap());
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let client = builder_on(&base).build().await.unwrap();
        let rt = live(&engine, &password(&base), client).await;
        let signed_out = engine.sign_out_within(&rt, Duration::from_millis(300));
        let outcome = timeout(signed_out, Duration::from_secs(5)).await;
        let err = outcome.expect("the logout outlived its limit").unwrap_err();
        assert_eq!(request_failure(&err).kind, FailureKind::Timeout);
        assert!(
            engine.may_sync("@a:b", rt.generation),
            "the sign-out is cleared"
        );
    }

    #[tokio::test]
    async fn a_dead_token_after_its_own_logout_is_ignored() {
        const LOGOUT: &str = "POST /_matrix/client/v3/logout";
        let (base, _) = scripted(vec![(LOGOUT, 200, json!({})), (WHOAMI, 401, unknown(None))]);
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let effects = record(&engine);
        let client = builder_on(&base).build().await.unwrap();
        drop(live(&engine, &password(&base), client).await);
        let logout = logout_remote(Arc::clone(&engine), "@a:b".into())
            .next()
            .await;
        assert_eq!(logout.unwrap().unwrap(), json!({"ok": true, "value": null}));
        let status = account_status(Arc::clone(&engine), "@a:b".into())
            .next()
            .await;
        assert_eq!(status.unwrap().unwrap(), json!("gone"));
        assert!(engine.account("@a:b").is_some());
        assert!(effects.lock().unwrap().is_empty());
    }
}
