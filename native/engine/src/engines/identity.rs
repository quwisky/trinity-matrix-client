//! `IdentityEngine` (`libs/data-access/identity/src/lib/identity-engine.ts`), member by member as
//! its js-sdk adapter (`js-sdk-identity-engine.ts`) derives each value.

use std::{
    future::{Future, ready},
    pin::{Pin, pin},
    sync::Arc,
    time::Duration,
};

use futures_util::{
    StreamExt,
    future::{Either, select},
    stream,
};
use matrix_sdk::{
    Client, Error, SendOutsideWasm,
    ruma::{
        MilliSecondsSinceUnixEpoch, OwnedUserId, UserId,
        api::{
            client::{
                presence::{get_presence, set_presence},
                profile::{get_profile, set_profile_field},
            },
            error::ErrorKind,
        },
        events::{
            GlobalAccountDataEvent, ignored_user_list::IgnoredUserListEventContent,
            room::member::OriginalSyncRoomMemberEvent,
        },
        presence::PresenceState,
        profile::ProfileFieldValue,
    },
    sleep::sleep,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::{Mutex, OwnedMutexGuard, watch};
use ts_rs::TS;

use super::{
    account_data,
    member::{account_stream, on_account, sent_once},
};
use crate::{
    accounts::{AccountRuntime, Engine},
    dispatch::{Stream, detached, reply},
    failure::request_failed,
};

const IGNORED_USER_LIST: &str = "m.ignored_user_list";
/// A snapshot whose read failed is read again after this, unless a change comes first.
const RETRY_AFTER: Duration = Duration::from_secs(30);
/// How long one ignored user's profile may take; past it the user has no name.
const NAME_LOOKUP: Duration = Duration::from_secs(5);
const DTO: &str = "data-access/identity/src/lib/rust-dto/";

/// `UserProfile`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct UserProfileDto {
    display_name: Option<String>,
    avatar_mxc: Option<String>,
}

/// `PresenceInfo`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct PresenceInfoDto {
    user_id: String,
    presence: PresenceStateDto,
    status_message: Option<String>,
    last_active_at: Option<f64>,
    currently_active: bool,
}

/// `IgnoredUserInfo`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct IgnoredUserInfoDto {
    user_id: String,
    display_name: Option<String>,
    avatar_mxc: Option<String>,
}

/// What `ownPresence` answers: `presence` is null until the server sent one.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct OwnPresenceDto {
    presence: Option<PresenceStateDto>,
    status_message: Option<String>,
}

/// `PresenceState`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = DTO)]
pub enum PresenceStateDto {
    Online,
    Unavailable,
    Offline,
}

impl From<PresenceStateDto> for PresenceState {
    fn from(state: PresenceStateDto) -> Self {
        match state {
            PresenceStateDto::Online => Self::Online,
            PresenceStateDto::Unavailable => Self::Unavailable,
            PresenceStateDto::Offline => Self::Offline,
        }
    }
}

/// What wakes the account's identity streams. A stream reads on each change; the SDK's handlers
/// and the commands count them. The handlers close over clones of the senders and the client
/// owns the handlers, so dropping the runtime leaves no cycle, and a replaced client has
/// signals of its own.
#[derive(Debug)]
pub(crate) struct IdentitySignals {
    /// The account's own profile was written, or an own `m.room.member` event arrived.
    pub(crate) profile: watch::Sender<u64>,
    /// `setPresence` ran.
    pub(crate) presence: watch::Sender<u64>,
    /// `setIgnored` ran, or an `m.ignored_user_list` account-data event arrived.
    pub(crate) ignored: watch::Sender<u64>,
    /// Serialises `setIgnored` on this account; shared so a call can queue without the account.
    pub(crate) ignore_writes: Arc<Mutex<()>>,
    /// Keeps the account's presence reads and writes apart: Synapse drops a write that lands while
    /// its first read of the user's presence is still loading.
    pub(crate) presence_requests: Arc<Mutex<()>>,
}

impl IdentitySignals {
    pub(crate) fn new(client: &Client, account_id: &str) -> Self {
        let signals = Self {
            profile: watch::Sender::new(0),
            presence: watch::Sender::new(0),
            ignored: watch::Sender::new(0),
            ignore_writes: Arc::new(Mutex::new(())),
            presence_requests: Arc::new(Mutex::new(())),
        };
        let (own, profile) = (account_id.to_owned(), signals.profile.clone());
        client.add_event_handler(move |event: OriginalSyncRoomMemberEvent| {
            if event.state_key.as_str() == own {
                tick(&profile);
            }
            ready(())
        });
        let ignored = signals.ignored.clone();
        client.add_event_handler(
            move |_: GlobalAccountDataEvent<IgnoredUserListEventContent>| {
                tick(&ignored);
                ready(())
            },
        );
        signals
    }
}

pub(crate) fn tick(signal: &watch::Sender<u64>) {
    signal.send_modify(|n| *n += 1);
}

/// The account's turn on the lock `queue` names, taken before the call takes the account so a
/// queue never holds it; `None` for an account that is not live.
async fn turn(
    engine: &Engine,
    account_id: &str,
    queue: fn(&IdentitySignals) -> &Arc<Mutex<()>>,
) -> Option<OwnedMutexGuard<()>> {
    // shortcut: a call queued across a client replacement waits on the old client's lock and can
    // run beside the new runtime's first presence read, and if no account is live here but
    // `on_account` then finds one, the call runs unlocked; upgrade if either shows in practice.
    let queue = engine
        .account(account_id)
        .map(|rt| Arc::clone(queue(&rt.identity)));
    match queue {
        Some(queue) => Some(queue.lock_owned().await),
        None => None,
    }
}

/// Any user's profile, from the server; a user it does not know has an empty one. The endpoint
/// wants no token, but the server may hide a profile from an anonymous request.
pub fn profile(engine: Arc<Engine>, account_id: String, user_id: String) -> Stream {
    reply(on_account(
        engine,
        account_id,
        request_failed,
        move |engine, rt| async move {
            let request = get_profile::v3::Request::new(UserId::parse(user_id)?);
            let send = rt
                .client
                .send(request)
                .with_request_config(sent_once().force_auth());
            match engine.ruled(&rt, send).await {
                Ok(response) => Ok(profile_of(&response)),
                Err(err) if is_not_found(&err) => Ok(UserProfileDto {
                    display_name: None,
                    avatar_mxc: None,
                }),
                Err(err) => Err(err),
            }
        },
    ))
}

pub fn set_display_name(engine: Arc<Engine>, account_id: String, name: String) -> Stream {
    write_profile(engine, account_id, ProfileFieldValue::DisplayName(name))
}

/// `mxc` is the server's to judge.
pub fn set_avatar(engine: Arc<Engine>, account_id: String, mxc: String) -> Stream {
    write_profile(engine, account_id, ProfileFieldValue::AvatarUrl(mxc.into()))
}

fn write_profile(engine: Arc<Engine>, account_id: String, value: ProfileFieldValue) -> Stream {
    detached(on_account(
        engine,
        account_id,
        request_failed,
        move |engine, rt| async move {
            let request = set_profile_field::v3::Request::new(own_id(&rt.client)?, value);
            let send = rt.client.send(request).with_request_config(sent_once());
            engine.ruled(&rt, send).await?;
            tick(&rt.identity.profile);
            Ok(())
        },
    ))
}

pub fn own_presence(engine: Arc<Engine>, account_id: String) -> Stream {
    reply(async move {
        let turn = turn(&engine, &account_id, |s| &s.presence_requests).await;
        on_account(
            engine,
            account_id,
            request_failed,
            |engine, rt| async move {
                let _turn = turn;
                let request = get_presence::v3::Request::new(own_id(&rt.client)?);
                let send = rt.client.send(request).with_request_config(sent_once());
                let response = engine.ruled(&rt, send).await?;
                Ok(own_presence_of(&response))
            },
        )
        .await
    })
}

pub fn set_presence(
    engine: Arc<Engine>,
    account_id: String,
    presence: PresenceStateDto,
    status_message: Option<String>,
) -> Stream {
    detached(async move {
        let turn = turn(&engine, &account_id, |s| &s.presence_requests).await;
        on_account(
            engine,
            account_id,
            request_failed,
            move |engine, rt| async move {
                let _turn = turn;
                let mut request =
                    set_presence::v3::Request::new(own_id(&rt.client)?, presence.into());
                request.status_msg = status_message;
                let send = rt.client.send(request).with_request_config(sent_once());
                engine.ruled(&rt, send).await?;
                tick(&rt.identity.presence);
                Ok(())
            },
        )
        .await
    })
}

/// A call waits for the writes ahead of it before it takes the account, so a queue never holds
/// it: a read of at most 30 s, a write cut off at 60 s and the rule's delivery waits end within
/// `HOLDER_LIMIT`. A call whose turn comes after a teardown answers `account-not-live`.
pub fn set_ignored(
    engine: Arc<Engine>,
    account_id: String,
    user_id: String,
    ignored: bool,
) -> Stream {
    detached(async move {
        let turn = turn(&engine, &account_id, |s| &s.ignore_writes).await;
        on_account(
            engine,
            account_id,
            request_failed,
            move |engine, rt| async move {
                // Held across the read and the write, so quick changes never undo each other.
                let _turn = turn;
                let read = account_data::get(&rt.client, IGNORED_USER_LIST);
                let current = engine.ruled(&rt, read).await?;
                if let Some(edited) = edit_ignored(current, &user_id, ignored) {
                    let write = account_data::put(&rt.client, IGNORED_USER_LIST, &edited);
                    engine.ruled(&rt, write).await?;
                }
                tick(&rt.identity.ignored);
                Ok(())
            },
        )
        .await
    })
}

/// The account's own profile, as the server has it.
pub fn own_profile(engine: Arc<Engine>, account_id: String) -> Stream {
    let profile = |rt: &AccountRuntime| rt.identity.profile.subscribe();
    snapshots(
        engine,
        account_id,
        UserProfileDto::default(),
        profile,
        read_own_profile,
    )
}

/// The presence entries the account has received: its own, once the server has one. Each read
/// waits its turn among the account's presence requests.
pub fn presence(engine: Arc<Engine>, account_id: String) -> Stream {
    account_stream(engine, account_id, Vec::new(), |rt, client| {
        let requests = Arc::clone(&rt.identity.presence_requests);
        let read = move || read_presence(client.clone(), Arc::clone(&requests));
        follow(
            Vec::new(),
            ticks(rt.identity.presence.subscribe()),
            RETRY_AFTER,
            read,
        )
    })
}

/// The account's `m.ignored_user_list`, each user with the name their profile carries.
pub fn ignored_users(engine: Arc<Engine>, account_id: String) -> Stream {
    let ignored = |rt: &AccountRuntime| rt.identity.ignored.subscribe();
    snapshots(engine, account_id, Vec::new(), ignored, read_ignored)
}

/// An `account_stream` of `read`: `empty`, then what `read` answers at once and after each tick
/// of the signal `subscribe` takes from the runtime. The body keeps neither the runtime nor its
/// client; it reads through the lease's.
fn snapshots<T, Fut>(
    engine: Arc<Engine>,
    account_id: String,
    empty: T,
    subscribe: fn(&AccountRuntime) -> watch::Receiver<u64>,
    read: fn(Client) -> Fut,
) -> Stream
where
    T: Clone + PartialEq + Serialize + SendOutsideWasm + 'static,
    Fut: Future<Output = Option<T>> + SendOutsideWasm + 'static,
{
    account_stream(engine, account_id, empty.clone(), move |rt, client| {
        let triggers = ticks(subscribe(rt));
        follow(empty, triggers, RETRY_AFTER, move || read(client.clone()))
    })
}

/// A tick for each change to the signal, until its sender is dropped. A change that arrives
/// while nobody waits for a tick is kept for the next wait.
fn ticks(changes: watch::Receiver<u64>) -> impl futures_util::Stream<Item = ()> {
    stream::unfold(changes, |mut changes| async {
        changes.changed().await.ok()?;
        Some(((), changes))
    })
}

/// How `follow` waits before its next read.
enum Wait {
    Nothing,
    Trigger,
    TriggerOrRetry,
}

struct Following<Tr, R, T> {
    triggers: Pin<Box<Tr>>,
    read: R,
    last: T,
    wait: Wait,
}

/// `empty` at once, then `read()` at once and after each trigger, each time it differs from the
/// last value emitted. A failed read (`None`) is read again after `retry_after` or on the next
/// trigger, whichever comes first. A trigger that comes during a read brings one more read. Once
/// `triggers` ends the loop ends and the stream emits no more.
fn follow<T, Fut>(
    empty: T,
    triggers: impl futures_util::Stream<Item = ()>,
    retry_after: Duration,
    read: impl FnMut() -> Fut,
) -> impl futures_util::Stream<Item = T>
where
    T: Clone + PartialEq,
    Fut: Future<Output = Option<T>>,
{
    let following = Following {
        triggers: Box::pin(triggers),
        read,
        last: empty.clone(),
        wait: Wait::Nothing,
    };
    let reads = stream::unfold(following, move |mut f| async move {
        loop {
            match f.wait {
                Wait::Nothing => {}
                Wait::Trigger => f.triggers.next().await?,
                Wait::TriggerOrRetry => {
                    let retry = pin!(sleep(retry_after));
                    if let Either::Left((None, _)) = select(f.triggers.next(), retry).await {
                        return None;
                    }
                }
            }
            let read = (f.read)().await;
            f.wait = if read.is_some() {
                Wait::Trigger
            } else {
                Wait::TriggerOrRetry
            };
            if let Some(value) = read
                && value != f.last
            {
                f.last = value.clone();
                return Some((value, f));
            }
        }
    });
    stream::once(ready(empty)).chain(reads)
}

async fn read_own_profile(client: Client) -> Option<UserProfileDto> {
    let me = own_id(&client).ok()?;
    match fetch_profile(&client, me.clone(), None).await {
        Ok(response) => Some(user_profile_of(me.as_str(), &response)),
        Err(err) if is_not_found(&err) => Some(UserProfileDto::default()),
        Err(_) => None,
    }
}

/// `user`'s profile from the server, sent once. The endpoint wants no token, but the server may
/// hide a profile from an anonymous request, so the token goes along.
async fn fetch_profile(
    client: &Client,
    user: OwnedUserId,
    limit: Option<Duration>,
) -> Result<get_profile::v3::Response, Error> {
    let config = sent_once().force_auth();
    let config = limit.map_or(config, |limit| config.timeout(limit));
    let request = get_profile::v3::Request::new(user);
    Ok(client.send(request).with_request_config(config).await?)
}

async fn read_presence(client: Client, requests: Arc<Mutex<()>>) -> Option<Vec<PresenceInfoDto>> {
    let me = own_id(&client).ok()?;
    let _turn = requests.lock().await;
    let request = get_presence::v3::Request::new(me.clone());
    let response = client
        .send(request)
        .with_request_config(sent_once())
        .await
        .ok()?;
    let now = f64::from(MilliSecondsSinceUnixEpoch::now().get());
    Some(own_entry(me.as_str(), &response, now).into_iter().collect())
}

async fn read_ignored(client: Client) -> Option<Vec<IgnoredUserInfoDto>> {
    let list = account_data::get(&client, IGNORED_USER_LIST).await.ok()?;
    let users = (list.as_ref())
        .and_then(|content| content.get("ignored_users"))
        .and_then(Value::as_object);
    let ids: Vec<_> = users.map_or_else(Vec::new, |users| users.keys().cloned().collect());
    let lookups = ids.into_iter().map(|id| ignored_info(&client, id));
    Some(stream::iter(lookups).buffered(8).collect().await)
}

/// `user_id` with the name and avatar of its profile; one the server does not answer in time has
/// none.
async fn ignored_info(client: &Client, user_id: String) -> IgnoredUserInfoDto {
    // shortcut: a failed or timed-out lookup leaves the name null until the list changes, and each
    // tick fetches all N profiles with no cap; upgrade by caching names and retrying transient
    // failures.
    let looked_up = async {
        let user = UserId::parse(&user_id).ok()?;
        let response = fetch_profile(client, user, Some(NAME_LOOKUP)).await.ok()?;
        Some(user_profile_of(&user_id, &response))
    };
    let profile = looked_up.await.unwrap_or_default();
    IgnoredUserInfoDto {
        user_id,
        display_name: profile.display_name,
        avatar_mxc: profile.avatar_mxc,
    }
}

fn own_id(client: &Client) -> Result<OwnedUserId, Error> {
    client
        .user_id()
        .map(ToOwned::to_owned)
        .ok_or(Error::AuthenticationRequired)
}

fn string_of(r: &get_profile::v3::Response, field: &str) -> Option<String> {
    r.get(field).and_then(Value::as_str).map(str::to_owned)
}

/// The profile of `user_id` (the account or an ignored user), as js reads its `User`: an empty
/// string is no value, and the display name the SDK makes of a nameless user, the user id, is none.
fn user_profile_of(user_id: &str, r: &get_profile::v3::Response) -> UserProfileDto {
    let set = |field| string_of(r, field).filter(|value| !value.is_empty());
    UserProfileDto {
        display_name: set("displayname").filter(|name| name != user_id),
        avatar_mxc: set("avatar_url"),
    }
}

/// Another user's profile, strings as the server sent them.
fn profile_of(r: &get_profile::v3::Response) -> UserProfileDto {
    UserProfileDto {
        display_name: string_of(r, "displayname"),
        avatar_mxc: string_of(r, "avatar_url"),
    }
}

/// js `isNotFound`: a 404 whatever its body, or `M_NOT_FOUND`.
fn is_not_found(err: &Error) -> bool {
    err.as_client_api_error().is_some_and(|e| {
        e.status_code.as_u16() == 404 || e.error_kind() == Some(&ErrorKind::NotFound)
    })
}

fn presence_state_of(state: &PresenceState) -> PresenceStateDto {
    match state {
        PresenceState::Online => PresenceStateDto::Online,
        PresenceState::Unavailable => PresenceStateDto::Unavailable,
        _ => PresenceStateDto::Offline,
    }
}

/// Synapse's answer for a user that never set a presence, and for `presence.enabled: false`.
fn never_set(r: &get_presence::v3::Response) -> bool {
    matches!(r.presence, PresenceState::Offline)
        && r.status_msg.is_none()
        && r.last_active_ago.is_none()
}

/// js `statusOf`: an empty message is none.
fn status_of(r: &get_presence::v3::Response) -> Option<String> {
    r.status_msg.clone().filter(|status| !status.is_empty())
}

fn own_presence_of(r: &get_presence::v3::Response) -> OwnPresenceDto {
    if never_set(r) {
        return OwnPresenceDto {
            presence: None,
            status_message: None,
        };
    }
    OwnPresenceDto {
        presence: Some(presence_state_of(&r.presence)),
        status_message: status_of(r),
    }
}

/// The account's entry in `presence`, `None` while the server has no presence for it. The id is
/// the caller's because `get_presence::Response` carries no user id.
fn own_entry(
    account_id: &str,
    r: &get_presence::v3::Response,
    now_ms: f64,
) -> Option<PresenceInfoDto> {
    if never_set(r) {
        return None;
    }
    // The ago is whole milliseconds, which the seconds round-trip only approximates.
    let last_active_at = r
        .last_active_ago
        .map(|ago| now_ms - (ago.as_secs_f64() * 1000.0).round())
        .filter(|at| *at > 0.0);
    Some(PresenceInfoDto {
        user_id: account_id.to_owned(),
        presence: presence_state_of(&r.presence),
        status_message: status_of(r),
        last_active_at,
        currently_active: r.currently_active == Some(true),
    })
}

/// `m.ignored_user_list` with `user_id` added or removed and every other field kept, or `None`
/// when the list already says so and there is nothing to write.
fn edit_ignored(content: Option<Value>, user_id: &str, ignored: bool) -> Option<Value> {
    let mut content = match content {
        Some(Value::Object(content)) => content,
        _ => Map::new(),
    };
    let mut users = match content.remove("ignored_users") {
        Some(Value::Object(users)) => users,
        _ => Map::new(),
    };
    if users.contains_key(user_id) == ignored {
        return None;
    }
    if ignored {
        users.insert(user_id.to_owned(), json!({}));
    } else {
        users.remove(user_id);
    }
    content.insert("ignored_users".to_owned(), Value::Object(users));
    Some(Value::Object(content))
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        future::Ready,
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };

    use futures_util::{FutureExt, StreamExt, future::join};
    use matrix_sdk::{
        config::SyncSettings, executor::spawn, ruma::MilliSecondsSinceUnixEpoch, sleep::sleep,
        timeout::timeout,
    };
    use tempfile::TempDir;
    use tokio::{sync::mpsc, time::Instant};

    use super::*;
    use crate::{
        config::EngineConfig,
        failure::http_error_from_response,
        testing::{
            Seen, builder_on, default_client, engine_in, live, password, requests, scripted,
        },
    };

    const SYNC: &str = "GET /_matrix/client/v3/sync?timeout=0&use_state_after=true";
    const PROFILE: &str = "GET /_matrix/client/v3/profile/@b:c";
    const NAME: &str = "PUT /_matrix/client/v3/profile/@a:b/displayname";
    const AVATAR: &str = "PUT /_matrix/client/v3/profile/@a:b/avatar_url";
    const PRESENCE_GET: &str = "GET /_matrix/client/v3/presence/@a:b/status";
    const PRESENCE_SET: &str = "PUT /_matrix/client/v3/presence/@a:b/status";
    const IGNORED_GET: &str = "GET /_matrix/client/v3/user/@a:b/account_data/m.ignored_user_list";
    const IGNORED_PUT: &str = "PUT /_matrix/client/v3/user/@a:b/account_data/m.ignored_user_list";
    const OWN_PROFILE: &str = "GET /_matrix/client/v3/profile/@a:b";
    const IGNORED_PROFILE: &str = "GET /_matrix/client/v3/profile/@x:y";
    const OFFLINE: &str = "http://127.0.0.1:1";

    type Command = fn(Arc<Engine>) -> Stream;
    type Opener = fn(Arc<Engine>, String) -> Stream;
    type Answers = Vec<(&'static str, u16, Value)>;

    /// A profile response of `fields`, an object.
    fn profile_response(fields: Value) -> get_profile::v3::Response {
        let Value::Object(fields) = fields else {
            panic!("fields are an object");
        };
        fields.into_iter().collect()
    }

    fn presence(
        state: PresenceState,
        status: Option<&str>,
        ago_ms: Option<u64>,
    ) -> get_presence::v3::Response {
        let mut r = get_presence::v3::Response::new(state);
        r.status_msg = status.map(str::to_owned);
        r.last_active_ago = ago_ms.map(Duration::from_millis);
        r
    }

    /// `@a:b` live on a client with the SDK's default config, which retries, answered by `answers`.
    async fn live_on(root: &TempDir, answers: Answers) -> (Arc<Engine>, Seen) {
        let (base, seen) = scripted(answers);
        (live_at(root, &base).await, seen)
    }

    async fn live_at(root: &TempDir, base: &str) -> Arc<Engine> {
        let engine = engine_in(root);
        let account = password(base);
        drop(live(&engine, &account, default_client(&engine, &account).await).await);
        engine
    }

    /// A server that takes every presence request and answers the n-th only once `released`
    /// passes n; `taken` counts the requests it has read. Anything else gets the versions.
    fn holding_presence() -> (String, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (taken, released) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let (counted, release) = (Arc::clone(&taken), Arc::clone(&released));
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (counted, release) = (Arc::clone(&counted), Arc::clone(&release));
                std::thread::spawn(move || hold_presence(stream, &counted, &release));
            }
        });
        (base, taken, released)
    }

    fn hold_presence(mut stream: std::net::TcpStream, taken: &AtomicUsize, released: &AtomicUsize) {
        use std::io::{BufRead, BufReader, Read, Write};
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let presence = line.contains("/presence/");
        let mut length = 0;
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).unwrap();
            let header = header.trim_end().to_ascii_lowercase();
            if header.is_empty() {
                break;
            }
            if let Some(value) = header.strip_prefix("content-length: ") {
                length = value.parse().unwrap();
            }
        }
        reader.read_exact(&mut vec![0; length]).unwrap();
        let body = if presence {
            let n = taken.fetch_add(1, Ordering::SeqCst);
            while released.load(Ordering::SeqCst) <= n {
                std::thread::sleep(Duration::from_millis(5));
            }
            r#"{"presence":"online"}"#
        } else {
            r#"{"versions":["v1.15"]}"#
        };
        let head = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\n";
        let _ = write!(stream, "{head}content-length: {}\r\n\r\n{body}", body.len());
    }

    async fn first(mut reply: Stream) -> Value {
        reply.next().await.unwrap().unwrap()
    }

    fn unavailable() -> Value {
        json!({"errcode": "M_UNKNOWN", "error": "x"})
    }

    fn failed(status: u16, body: &str) -> Error {
        let status = status.try_into().unwrap();
        http_error_from_response(status, body.as_bytes()).into()
    }

    fn profile_dto(name: Option<&str>, avatar: Option<&str>) -> UserProfileDto {
        UserProfileDto {
            display_name: name.map(str::to_owned),
            avatar_mxc: avatar.map(str::to_owned),
        }
    }

    #[test]
    fn a_profile_reads_the_user_id_and_empty_strings_as_null() {
        let own = |fields| user_profile_of("@a:b", &profile_response(fields));
        let named = json!({"displayname": "Ann", "avatar_url": "mxc://b/c"});
        assert_eq!(own(named), profile_dto(Some("Ann"), Some("mxc://b/c")));
        let nameless = json!({"displayname": "@a:b", "avatar_url": ""});
        assert_eq!(own(nameless), profile_dto(None, None));
        let empty = json!({"displayname": ""});
        assert_eq!(own(empty), profile_dto(None, None));
        // Only the account's own id is no name.
        let other = json!({"displayname": "@z:b"});
        assert_eq!(own(other), profile_dto(Some("@z:b"), None));
        assert_eq!(own(json!({})), profile_dto(None, None));
    }

    #[test]
    fn a_profile_keeps_strings_as_sent_and_non_strings_as_null() {
        let of = |fields| profile_of(&profile_response(fields));
        let sent = json!({"displayname": "", "avatar_url": "mxc://b/c"});
        assert_eq!(of(sent), profile_dto(Some(""), Some("mxc://b/c")));
        let own_id = json!({"displayname": "@a:b"});
        assert_eq!(of(own_id), profile_dto(Some("@a:b"), None));
        let odd = json!({"displayname": 5, "avatar_url": null});
        assert_eq!(of(odd), profile_dto(None, None));
        assert_eq!(of(json!({"displayname": ["x"]})), profile_dto(None, None));
    }

    #[test]
    fn a_404_or_a_not_found_errcode_is_not_found_and_a_403_is_not() {
        let forbidden = r#"{"errcode":"M_FORBIDDEN","error":"x"}"#;
        let not_found = r#"{"errcode":"M_NOT_FOUND","error":"x"}"#;
        assert!(is_not_found(&failed(404, not_found)));
        assert!(is_not_found(&failed(404, "<html>gateway</html>")));
        assert!(is_not_found(&failed(404, forbidden)));
        assert!(is_not_found(&failed(400, not_found)));
        assert!(!is_not_found(&failed(403, forbidden)));
        assert!(!is_not_found(&failed(502, "<html>gateway</html>")));
        assert!(!is_not_found(&Error::AuthenticationRequired));
    }

    #[test]
    fn own_entry_maps_each_state_a_custom_state_to_offline_and_the_times() {
        let entry = |state: &str, ago_ms, active| {
            let mut r = presence(PresenceState::from(state), Some("here"), ago_ms);
            r.currently_active = active;
            own_entry("@a:b", &r, 10_000.0).unwrap()
        };
        let online = entry("online", Some(1_500), Some(true));
        assert_eq!(online.presence, PresenceStateDto::Online);
        assert_eq!(online.status_message.as_deref(), Some("here"));
        assert_eq!(online.last_active_at, Some(8_500.0));
        assert!(online.currently_active);
        let away = entry("unavailable", Some(1_234), Some(false));
        assert_eq!(away.presence, PresenceStateDto::Unavailable);
        assert_eq!(away.last_active_at, Some(8_766.0));
        assert!(!away.currently_active);
        let offline = entry("offline", None, None);
        assert_eq!(offline.presence, PresenceStateDto::Offline);
        assert_eq!(offline.last_active_at, None);
        assert!(!offline.currently_active);
        assert_eq!(
            entry("busy", None, None).presence,
            PresenceStateDto::Offline
        );
        // At or before the epoch is no time.
        assert_eq!(entry("online", Some(10_000), None).last_active_at, None);
        assert_eq!(entry("online", Some(20_000), None).last_active_at, None);
        let empty = presence(PresenceState::Online, Some(""), None);
        assert_eq!(own_entry("@a:b", &empty, 1.0).unwrap().status_message, None);
    }

    #[test]
    fn an_offline_answer_with_nothing_set_is_no_presence() {
        let unset = presence(PresenceState::Offline, None, None);
        let nothing = OwnPresenceDto {
            presence: None,
            status_message: None,
        };
        assert_eq!(own_presence_of(&unset), nothing);
        assert_eq!(own_entry("@a:b", &unset, 10_000.0), None);
        let said = presence(PresenceState::Offline, Some("gone"), None);
        let own = own_presence_of(&said);
        assert_eq!(own.presence, Some(PresenceStateDto::Offline));
        assert_eq!(own.status_message.as_deref(), Some("gone"));
        assert!(own_entry("@a:b", &said, 10_000.0).is_some());
        let active = presence(PresenceState::Offline, None, Some(5));
        assert_eq!(
            own_presence_of(&active).presence,
            Some(PresenceStateDto::Offline)
        );
        assert!(own_entry("@a:b", &active, 10_000.0).is_some());
        let online = presence(PresenceState::Online, Some(""), None);
        let own = own_presence_of(&online);
        assert_eq!(own.presence, Some(PresenceStateDto::Online));
        assert_eq!(own.status_message, None);
    }

    #[test]
    fn own_entry_names_only_the_account() {
        let r = presence(PresenceState::Online, None, None);
        assert_eq!(own_entry("@a:b", &r, 1.0).unwrap().user_id, "@a:b");
        assert_eq!(own_entry("@z:y", &r, 1.0).unwrap().user_id, "@z:y");
    }

    #[test]
    fn edit_ignored_adds_removes_and_keeps_other_fields() {
        let list = || Some(json!({"ignored_users": {"@x:y": {}}, "x.extra": 1}));
        assert_eq!(
            edit_ignored(None, "@x:y", true),
            Some(json!({"ignored_users": {"@x:y": {}}}))
        );
        assert_eq!(
            edit_ignored(list(), "@z:y", true),
            Some(json!({"ignored_users": {"@x:y": {}, "@z:y": {}}, "x.extra": 1}))
        );
        assert_eq!(
            edit_ignored(list(), "@x:y", false),
            Some(json!({"ignored_users": {}, "x.extra": 1}))
        );
        assert_eq!(edit_ignored(list(), "@x:y", true), None);
        assert_eq!(edit_ignored(list(), "@z:y", false), None);
        assert_eq!(edit_ignored(None, "@x:y", false), None);
        let odd = Some(json!({"ignored_users": 3}));
        assert_eq!(
            edit_ignored(odd.clone(), "@x:y", true),
            Some(json!({"ignored_users": {"@x:y": {}}}))
        );
        assert_eq!(edit_ignored(odd, "@x:y", false), None);
    }

    #[test]
    fn the_dtos_serialize_as_the_typescript_types_name_them() {
        let info = PresenceInfoDto {
            user_id: "@a:b".to_owned(),
            presence: PresenceStateDto::Online,
            status_message: None,
            last_active_at: None,
            currently_active: false,
        };
        assert_eq!(
            serde_json::to_value(info).unwrap(),
            json!({
                "userId": "@a:b",
                "presence": "online",
                "statusMessage": null,
                "lastActiveAt": null,
                "currentlyActive": false,
            })
        );
        let own = OwnPresenceDto {
            presence: None,
            status_message: None,
        };
        assert_eq!(
            serde_json::to_value(own).unwrap(),
            json!({"presence": null, "statusMessage": null})
        );
        assert_eq!(
            serde_json::to_value(profile_dto(None, None)).unwrap(),
            json!({"displayName": null, "avatarMxc": null})
        );
        let ignored = IgnoredUserInfoDto {
            user_id: "@x:y".to_owned(),
            display_name: None,
            avatar_mxc: None,
        };
        assert_eq!(
            serde_json::to_value(ignored).unwrap(),
            json!({"userId": "@x:y", "displayName": null, "avatarMxc": null})
        );
        let online = serde_json::from_value::<PresenceStateDto>(json!("online"));
        assert_eq!(online.unwrap(), PresenceStateDto::Online);
        assert!(serde_json::from_value::<PresenceStateDto>(json!("busy")).is_err());
    }

    #[tokio::test]
    async fn an_own_member_event_and_an_ignored_list_event_tick_their_signals() {
        let member = |user: &str| {
            json!({
                "type": "m.room.member",
                "state_key": user,
                "sender": user,
                "event_id": format!("${}", user.len()),
                "origin_server_ts": 1,
                "content": {"membership": "join"},
            })
        };
        let sync = json!({
            "next_batch": "s1",
            "account_data": {"events": [{
                "type": "m.ignored_user_list",
                "content": {"ignored_users": {"@x:y": {}}},
            }]},
            "rooms": {"join": {"!r:b": {"state": {"events": [member("@a:b"), member("@zz:b")]}}}},
        });
        let (base, _) = scripted(vec![(SYNC, 200, sync)]);
        let engine = Engine::new(EngineConfig::default()).unwrap();
        let client = default_client(&engine, &password(&base)).await;
        let signals = IdentitySignals::new(&client, "@a:b");
        client
            .sync_once(SyncSettings::new().timeout(Duration::ZERO))
            .await
            .unwrap();
        assert_eq!(
            *signals.profile.borrow(),
            1,
            "the other user's event ticked"
        );
        assert_eq!(*signals.ignored.borrow(), 1);
        assert_eq!(*signals.presence.borrow(), 0);
    }

    #[tokio::test]
    async fn every_identity_command_sends_its_request_once() {
        let commands: [(&'static str, Value, Command); 6] = [
            (PROFILE, json!({"displayname": "B"}), |engine| {
                profile(engine, "@a:b".into(), "@b:c".into())
            }),
            (NAME, json!({}), |engine| {
                set_display_name(engine, "@a:b".into(), "Ann".into())
            }),
            (AVATAR, json!({}), |engine| {
                set_avatar(engine, "@a:b".into(), "mxc://b/c".into())
            }),
            (PRESENCE_GET, json!({"presence": "online"}), |engine| {
                own_presence(engine, "@a:b".into())
            }),
            (PRESENCE_SET, json!({}), |engine| {
                set_presence(engine, "@a:b".into(), PresenceStateDto::Online, None)
            }),
            (IGNORED_GET, json!({"ignored_users": {}}), |engine| {
                set_ignored(engine, "@a:b".into(), "@b:c".into(), true)
            }),
        ];
        for (route, ok, command) in commands {
            let root = TempDir::new().unwrap();
            let answers = vec![(route, 502, unavailable()), (route, 200, ok)];
            let (engine, seen) = live_on(&root, answers).await;
            let reply = first(command(engine)).await;
            let kind = &reply["failure"]["kind"];
            assert_eq!(
                (requests(&seen).len(), kind),
                (1, &json!("server")),
                "{route}"
            );
        }
    }

    #[tokio::test]
    async fn a_put_of_the_ignored_list_retries() {
        let answers = vec![
            (IGNORED_GET, 200, json!({"ignored_users": {}})),
            (IGNORED_PUT, 502, unavailable()),
            (IGNORED_PUT, 200, json!({})),
        ];
        let root = TempDir::new().unwrap();
        let (engine, seen) = live_on(&root, answers).await;
        let reply = first(set_ignored(engine, "@a:b".into(), "@b:c".into(), true)).await;
        assert_eq!(reply, json!({"ok": true, "value": null}));
        assert_eq!(requests(&seen).len(), 3);
    }

    #[tokio::test]
    async fn profile_sends_the_token_though_the_endpoint_wants_none() {
        let root = TempDir::new().unwrap();
        let ok = json!({"displayname": "B", "avatar_url": "mxc://c/d"});
        let (engine, seen) = live_on(&root, vec![(PROFILE, 200, ok)]).await;
        let reply = first(profile(engine, "@a:b".into(), "@b:c".into())).await;
        let expected = json!({"displayName": "B", "avatarMxc": "mxc://c/d"});
        assert_eq!(reply, json!({"ok": true, "value": expected}));
        let sent = vec![(PROFILE.to_owned(), Some("Bearer t1".to_owned()))];
        assert_eq!(requests(&seen), sent);
    }

    #[tokio::test]
    async fn a_missing_profile_is_an_empty_one_and_a_forbidden_one_fails() {
        let root = TempDir::new().unwrap();
        let answers = vec![
            (
                PROFILE,
                404,
                json!({"errcode": "M_NOT_FOUND", "error": "x"}),
            ),
            (
                PROFILE,
                403,
                json!({"errcode": "M_FORBIDDEN", "error": "x"}),
            ),
        ];
        let (engine, _) = live_on(&root, answers).await;
        let ask = || profile(Arc::clone(&engine), "@a:b".into(), "@b:c".into());
        let empty = json!({"displayName": null, "avatarMxc": null});
        assert_eq!(first(ask()).await, json!({"ok": true, "value": empty}));
        let forbidden = first(ask()).await;
        assert_eq!(forbidden["ok"], json!(false));
        assert_eq!(forbidden["failure"]["kind"], json!("permission"));
        assert_eq!(forbidden["failure"]["code"], json!("request-failed"));
    }

    #[tokio::test]
    async fn a_rate_limited_set_presence_reports_when_to_retry() {
        let limited = json!({"errcode": "M_LIMIT_EXCEEDED", "error": "x", "retry_after_ms": 4000});
        let root = TempDir::new().unwrap();
        let answers = vec![(PRESENCE_SET, 429, limited), (PRESENCE_SET, 200, json!({}))];
        let (engine, seen) = live_on(&root, answers).await;
        let reply = first(set_presence(
            engine,
            "@a:b".into(),
            PresenceStateDto::Online,
            None,
        ))
        .await;
        let failure = &reply["failure"];
        assert_eq!(failure["kind"], json!("rate-limit"));
        assert_eq!(failure["code"], json!("request-failed"));
        assert_eq!(failure["diagnostic"]["retryAfterMs"], json!(4000));
        assert_eq!(requests(&seen).len(), 1);
    }

    #[tokio::test]
    async fn two_quick_set_ignored_calls_run_one_after_another() {
        let answers = vec![
            (IGNORED_GET, 200, json!({"ignored_users": {}})),
            (IGNORED_PUT, 200, json!({})),
            (IGNORED_GET, 200, json!({"ignored_users": {"@b:c": {}}})),
            (IGNORED_PUT, 200, json!({})),
        ];
        let root = TempDir::new().unwrap();
        let (engine, seen) = live_on(&root, answers).await;
        let ignore =
            |user: &str| set_ignored(Arc::clone(&engine), "@a:b".into(), user.into(), true);
        let (one, two) = join(first(ignore("@b:c")), first(ignore("@d:e"))).await;
        let ok = json!({"ok": true, "value": null});
        assert_eq!((one, two), (ok.clone(), ok));
        let order: Vec<_> = requests(&seen)
            .into_iter()
            .map(|(route, _)| route)
            .collect();
        assert_eq!(order, [IGNORED_GET, IGNORED_PUT, IGNORED_GET, IGNORED_PUT]);
    }

    #[tokio::test]
    async fn set_ignored_writes_nothing_when_nothing_changes() {
        let root = TempDir::new().unwrap();
        let ignored = json!({"ignored_users": {"@b:c": {}}});
        let (engine, seen) = live_on(&root, vec![(IGNORED_GET, 200, ignored)]).await;
        let reply = first(set_ignored(engine, "@a:b".into(), "@b:c".into(), true)).await;
        assert_eq!(reply, json!({"ok": true, "value": null}));
        assert_eq!(requests(&seen).len(), 1);
    }

    /// The four writes with their scripts and the ticks each leaves on the profile, presence and
    /// ignored signals.
    fn writes() -> [(Answers, Command, [u64; 3]); 4] {
        let ok = || json!({});
        [
            (
                vec![(NAME, 200, ok())],
                |engine| set_display_name(engine, "@a:b".into(), "Ann".into()),
                [1, 0, 0],
            ),
            (
                vec![(AVATAR, 200, ok())],
                |engine| set_avatar(engine, "@a:b".into(), "mxc://b/c".into()),
                [1, 0, 0],
            ),
            (
                vec![(PRESENCE_SET, 200, ok())],
                |engine| set_presence(engine, "@a:b".into(), PresenceStateDto::Offline, None),
                [0, 1, 0],
            ),
            (
                vec![
                    (IGNORED_GET, 200, json!({"ignored_users": {}})),
                    (IGNORED_PUT, 200, ok()),
                ],
                |engine| set_ignored(engine, "@a:b".into(), "@b:c".into(), true),
                [0, 0, 1],
            ),
        ]
    }

    #[tokio::test]
    async fn a_closed_write_still_reaches_the_server() {
        for (answers, command, _) in writes() {
            let wanted = answers.len();
            let root = TempDir::new().unwrap();
            let (engine, seen) = live_on(&root, answers).await;
            let mut closed = command(engine);
            assert!(
                closed.next().now_or_never().is_none(),
                "the write is in flight"
            );
            drop(closed);
            let arrived = async {
                while requests(&seen).len() < wanted {
                    sleep(Duration::from_millis(10)).await;
                }
            };
            let arrived = timeout(arrived, Duration::from_secs(2)).await;
            assert!(arrived.is_ok(), "the close cut the write short");
        }
    }

    #[tokio::test]
    async fn a_write_ticks_the_signal_of_what_it_changed() {
        for (answers, command, ticks) in writes() {
            let root = TempDir::new().unwrap();
            let (engine, _) = live_on(&root, answers).await;
            let done = first(command(Arc::clone(&engine))).await;
            assert_eq!(done, json!({"ok": true, "value": null}));
            let rt = engine.account("@a:b").unwrap();
            let signals = &rt.identity;
            let seen = [&signals.profile, &signals.presence, &signals.ignored].map(|s| *s.borrow());
            assert_eq!(seen, ticks);
        }
    }

    #[tokio::test]
    async fn a_queued_ignore_write_waits_without_holding_the_account() {
        let root = TempDir::new().unwrap();
        let (engine, seen) = live_on(
            &root,
            vec![(IGNORED_GET, 200, json!({"ignored_users": {}}))],
        )
        .await;
        let rt = engine.account("@a:b").unwrap();
        let queue = Arc::clone(&rt.identity.ignore_writes);
        drop(rt);
        let turn = Arc::clone(&queue).lock_owned().await;
        let queued = set_ignored(Arc::clone(&engine), "@a:b".into(), "@b:c".into(), true);
        // The registry's runtime, the guard, this test, and the call waiting for its turn.
        let waiting = async {
            while Arc::strong_count(&queue) < 4 {
                sleep(Duration::from_millis(10)).await;
            }
        };
        let waiting = timeout(waiting, Duration::from_secs(2)).await;
        assert!(
            waiting.is_ok(),
            "the call did not take its place in the queue"
        );
        let removed = timeout(engine.remove("@a:b"), Duration::from_secs(5)).await;
        assert!(removed.is_ok(), "the queued call held the account");
        drop(turn);
        let reply = first(queued).await;
        assert_eq!(reply["failure"]["code"], json!("account-not-live"));
        assert!(requests(&seen).is_empty());
    }

    #[tokio::test]
    async fn a_presence_request_waits_for_the_one_in_flight() {
        let online = || json!({"presence": "online"});
        let calls: [(Answers, Command); 3] = [
            (vec![(PRESENCE_SET, 200, json!({}))], |engine| {
                set_presence(engine, "@a:b".into(), PresenceStateDto::Online, None)
            }),
            (vec![(PRESENCE_GET, 200, online())], |engine| {
                own_presence(engine, "@a:b".into())
            }),
            (vec![(PRESENCE_GET, 200, online())], |engine| {
                super::presence(engine, "@a:b".into())
            }),
        ];
        for (answers, call) in calls {
            let root = TempDir::new().unwrap();
            let (engine, seen) = live_on(&root, answers).await;
            let rt = engine.account("@a:b").unwrap();
            let in_flight = Arc::clone(&rt.identity.presence_requests)
                .lock_owned()
                .await;
            drop(rt);
            let _items = forward(call(Arc::clone(&engine)));
            sleep(Duration::from_millis(200)).await;
            assert!(requests(&seen).is_empty(), "it went out beside the other");
            drop(in_flight);
            let sent = async {
                while requests(&seen).is_empty() {
                    sleep(Duration::from_millis(10)).await;
                }
            };
            let sent = timeout(sent, Duration::from_secs(2)).await;
            assert!(sent.is_ok(), "it never went out");
        }
    }

    async fn reached(taken: &AtomicUsize, n: usize) {
        while taken.load(Ordering::SeqCst) < n {
            sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn a_presence_request_keeps_its_turn_until_the_server_has_answered() {
        let set: Command =
            |engine| set_presence(engine, "@a:b".into(), PresenceStateDto::Unavailable, None);
        let own: Command = |engine| own_presence(engine, "@a:b".into());
        let stream: Command = |engine| super::presence(engine, "@a:b".into());
        for (first, second) in [(set, own), (own, stream), (stream, set)] {
            let root = TempDir::new().unwrap();
            let (base, taken, released) = holding_presence();
            let engine = live_at(&root, &base).await;
            let _first = forward(first(Arc::clone(&engine)));
            let sent = timeout(reached(&taken, 1), Duration::from_secs(2)).await;
            assert!(sent.is_ok(), "the first request never went out");
            let _second = forward(second(Arc::clone(&engine)));
            sleep(Duration::from_millis(200)).await;
            assert_eq!(
                taken.load(Ordering::SeqCst),
                1,
                "it went out beside the first"
            );
            released.store(1, Ordering::SeqCst);
            let sent = timeout(reached(&taken, 2), Duration::from_secs(2)).await;
            assert!(sent.is_ok(), "it never went out after the first answer");
            released.store(usize::MAX, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn a_not_live_account_fails_before_its_arguments_are_parsed() {
        let engine = Engine::new(EngineConfig::default()).unwrap();
        let reply = first(profile(engine, "@x:y".into(), "not a user id".into())).await;
        assert_eq!(reply["failure"]["code"], json!("account-not-live"));
    }

    /// `read` answers `reads` in order.
    fn answering<T>(
        reads: impl IntoIterator<Item = Option<T>>,
    ) -> impl FnMut() -> Ready<Option<T>> {
        let mut reads = VecDeque::from_iter(reads);
        move || ready(reads.pop_front().expect("read more often than scripted"))
    }

    #[tokio::test(start_paused = true)]
    async fn follow_emits_empty_then_each_distinct_read() {
        let read = answering([Some(1), Some(2), Some(3)]);
        let items = follow(0, stream::iter([(), ()]), RETRY_AFTER, read);
        assert_eq!(items.collect::<Vec<_>>().await, [0, 1, 2, 3]);
    }

    #[tokio::test(start_paused = true)]
    async fn follow_skips_a_read_equal_to_the_last_value() {
        let read = answering([Some(0), Some(1), Some(1), Some(2)]);
        let items = follow(0, stream::iter([(), (), ()]), RETRY_AFTER, read);
        assert_eq!(items.collect::<Vec<_>>().await, [0, 1, 2]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_tick_during_a_read_triggers_one_more_read() {
        let signal = watch::Sender::new(0);
        let reads = Arc::new(AtomicUsize::new(0));
        let read = {
            let (signal, reads) = (signal.clone(), Arc::clone(&reads));
            move || {
                let n = reads.fetch_add(1, Ordering::SeqCst) + 1;
                if n == 1 {
                    tick(&signal);
                }
                ready(Some(n))
            }
        };
        let mut items = pin!(follow(0, ticks(signal.subscribe()), RETRY_AFTER, read));
        let seen: Vec<_> = items.by_ref().take(3).collect().await;
        assert_eq!(seen, [0, 1, 2]);
        let more = timeout(items.next(), Duration::from_secs(60)).await;
        assert!(more.is_err(), "the tick brought one read, not a loop");
        assert_eq!(reads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn follow_ends_when_the_triggers_end_during_a_retry_wait() {
        let read = answering([None]);
        let items = follow(0, stream::empty::<()>(), RETRY_AFTER, read);
        assert_eq!(items.collect::<Vec<_>>().await, [0]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_read_is_read_again_after_the_retry_delay_or_on_a_tick() {
        let signal = watch::Sender::new(0);
        let read = answering([None, Some(1), None, Some(2)]);
        let mut items = pin!(follow(0, ticks(signal.subscribe()), RETRY_AFTER, read));
        let secs = Duration::from_secs;
        assert_eq!(items.next().await, Some(0));
        // The first read fails; the stream is quiet until the delay has passed.
        assert!(timeout(items.next(), RETRY_AFTER - secs(1)).await.is_err());
        let start = Instant::now();
        assert_eq!(timeout(items.next(), secs(2)).await, Ok(Some(1)));
        assert_eq!(start.elapsed(), secs(1));
        // A tick reads at once, and the next one cuts the new delay short.
        let start = Instant::now();
        tick(&signal);
        assert!(timeout(items.next(), secs(1)).await.is_err());
        tick(&signal);
        assert_eq!(timeout(items.next(), secs(1)).await, Ok(Some(2)));
        assert_eq!(start.elapsed(), secs(1));
    }

    async fn next_item(items: &mut Stream) -> Value {
        let item = timeout(items.next(), Duration::from_secs(5)).await;
        item.expect("no item in 5 s").unwrap().unwrap()
    }

    /// Nothing arrives in a while: no item, no error frame and no end.
    async fn is_quiet(items: &mut Stream) -> bool {
        timeout(items.next(), Duration::from_millis(200))
            .await
            .is_err()
    }

    /// Forwards the stream's items from a task of its own, as the carrier polls it.
    fn forward(mut items: Stream) -> mpsc::UnboundedReceiver<Value> {
        let (tx, rx) = mpsc::unbounded_channel();
        spawn(async move {
            while let Some(item) = items.next().await {
                let _ = tx.send(item.unwrap());
            }
        });
        rx
    }

    fn no_profile() -> Value {
        json!({"displayName": null, "avatarMxc": null})
    }

    /// The three streams with their empty snapshots.
    fn streams() -> [(Opener, Value); 3] {
        [
            (own_profile, no_profile()),
            (super::presence, json!([])),
            (ignored_users, json!([])),
        ]
    }

    #[tokio::test]
    async fn a_stream_emits_empty_first_and_reads_again_on_the_next_tick() {
        let ann = json!({"displayname": "Ann"});
        let answers = vec![
            (OWN_PROFILE, 502, unavailable()),
            (OWN_PROFILE, 502, unavailable()),
            (OWN_PROFILE, 200, ann),
        ];
        let root = TempDir::new().unwrap();
        let (engine, seen) = live_on(&root, answers).await;
        let mut items = own_profile(Arc::clone(&engine), "@a:b".into());
        assert_eq!(next_item(&mut items).await, no_profile());
        for _ in 0..2 {
            assert!(is_quiet(&mut items).await, "a failed read is not an item");
            tick(&engine.account("@a:b").unwrap().identity.profile);
        }
        let named = json!({"displayName": "Ann", "avatarMxc": null});
        assert_eq!(next_item(&mut items).await, named);
        assert_eq!(requests(&seen).len(), 3);
    }

    #[tokio::test]
    async fn an_own_profile_the_server_does_not_have_is_empty_and_no_failed_read() {
        let answers = vec![(
            OWN_PROFILE,
            404,
            json!({"errcode": "M_NOT_FOUND", "error": "x"}),
        )];
        let root = TempDir::new().unwrap();
        let (engine, _) = live_on(&root, answers).await;
        let client = engine.account("@a:b").unwrap().client.clone();
        assert_eq!(
            read_own_profile(client).await,
            Some(UserProfileDto::default())
        );
    }

    #[tokio::test]
    async fn own_profile_emits_empty_then_the_server_profile() {
        let answers = vec![
            (OWN_PROFILE, 200, json!({"displayname": "@a:b"})),
            (
                OWN_PROFILE,
                200,
                json!({"displayname": "Ann", "avatar_url": "mxc://b/c"}),
            ),
        ];
        let root = TempDir::new().unwrap();
        let (engine, seen) = live_on(&root, answers).await;
        let mut items = own_profile(Arc::clone(&engine), "@a:b".into());
        assert_eq!(next_item(&mut items).await, no_profile());
        assert!(is_quiet(&mut items).await, "the user id is no name");
        tick(&engine.account("@a:b").unwrap().identity.profile);
        let named = json!({"displayName": "Ann", "avatarMxc": "mxc://b/c"});
        assert_eq!(next_item(&mut items).await, named);
        let sent = vec![(OWN_PROFILE.to_owned(), Some("Bearer t1".to_owned())); 2];
        assert_eq!(requests(&seen), sent);
    }

    #[tokio::test]
    async fn presence_asks_only_about_the_account() {
        let there = json!({
            "presence": "online",
            "status_msg": "here",
            "last_active_ago": 1500,
            "currently_active": true,
        });
        let answers = vec![
            (PRESENCE_GET, 200, json!({"presence": "offline"})),
            (PRESENCE_GET, 200, there),
        ];
        let root = TempDir::new().unwrap();
        let (engine, seen) = live_on(&root, answers).await;
        let mut items = super::presence(Arc::clone(&engine), "@a:b".into());
        assert_eq!(next_item(&mut items).await, json!([]));
        assert!(is_quiet(&mut items).await, "no presence set is no entry");
        tick(&engine.account("@a:b").unwrap().identity.presence);
        let entry = next_item(&mut items).await;
        let now = f64::from(MilliSecondsSinceUnixEpoch::now().get());
        let at = entry[0]["lastActiveAt"].as_f64().unwrap();
        assert!(
            (now - 1500.0 - at).abs() < 10_000.0,
            "{at} is not 1.5 s ago"
        );
        let expected = json!([{
            "userId": "@a:b",
            "presence": "online",
            "statusMessage": "here",
            "lastActiveAt": at,
            "currentlyActive": true,
        }]);
        assert_eq!(entry, expected);
        let routes: Vec<_> = requests(&seen)
            .into_iter()
            .map(|(route, _)| route)
            .collect();
        assert_eq!(routes, [PRESENCE_GET; 2]);
    }

    #[tokio::test]
    async fn ignored_users_take_names_from_profiles() {
        let list = json!({"ignored_users": {"@x:y": {}}});
        let profile = json!({"displayname": "Xavier", "avatar_url": "mxc://x/y"});
        let answers = vec![(IGNORED_GET, 200, list), (IGNORED_PROFILE, 200, profile)];
        let root = TempDir::new().unwrap();
        let (engine, seen) = live_on(&root, answers).await;
        let mut items = ignored_users(Arc::clone(&engine), "@a:b".into());
        assert_eq!(next_item(&mut items).await, json!([]));
        let named = json!([{"userId": "@x:y", "displayName": "Xavier", "avatarMxc": "mxc://x/y"}]);
        assert_eq!(next_item(&mut items).await, named);
        let bearer = Some("Bearer t1".to_owned());
        let sent = [
            (IGNORED_GET.to_owned(), bearer.clone()),
            (IGNORED_PROFILE.to_owned(), bearer),
        ];
        assert_eq!(requests(&seen), sent);
    }

    #[tokio::test]
    async fn an_ignored_user_without_a_profile_has_no_name() {
        let list = json!({"ignored_users": {"@x:y": {}}});
        let answers = vec![
            (IGNORED_GET, 200, list),
            (IGNORED_PROFILE, 404, unavailable()),
        ];
        let root = TempDir::new().unwrap();
        let (engine, _) = live_on(&root, answers).await;
        let mut items = ignored_users(Arc::clone(&engine), "@a:b".into());
        assert_eq!(next_item(&mut items).await, json!([]));
        let unnamed = json!([{"userId": "@x:y", "displayName": null, "avatarMxc": null}]);
        assert_eq!(next_item(&mut items).await, unnamed);
    }

    #[tokio::test]
    async fn identity_streams_on_an_account_that_is_not_live_emit_the_empty_snapshot() {
        let engine = Engine::new(EngineConfig::default()).unwrap();
        for (open, empty) in streams() {
            let mut items = open(Arc::clone(&engine), "@x:y".into());
            assert_eq!(items.next().await, Some(Ok(empty)));
            assert!(
                items.next().now_or_never().is_none(),
                "the stream stays open"
            );
        }
    }

    #[tokio::test]
    async fn identity_streams_do_not_delay_a_remove() {
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let client = builder_on(OFFLINE).build().await.unwrap();
        drop(live(&engine, &password(OFFLINE), client).await);
        let mut feeds = Vec::new();
        for (open, empty) in streams() {
            let mut feed = forward(open(Arc::clone(&engine), "@a:b".into()));
            assert_eq!(feed.recv().await, Some(empty));
            feeds.push(feed);
        }
        let rt = engine.account("@a:b").unwrap();
        assert_eq!(Arc::strong_count(&rt), 2, "only the registry and this read");
        drop(rt);
        let removed = timeout(engine.remove("@a:b"), Duration::from_secs(5)).await;
        assert!(removed.is_ok(), "the teardown waited for a stream");
        for feed in &mut feeds {
            let quiet = timeout(feed.recv(), Duration::from_millis(200)).await;
            assert!(quiet.is_err(), "no item and no completion");
        }
    }
}
