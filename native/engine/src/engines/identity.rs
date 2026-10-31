//! `IdentityEngine` (`libs/data-access/identity/src/lib/identity-engine.ts`), member by member as
//! its js-sdk adapter (`js-sdk-identity-engine.ts`) derives each value.
// The tests use every item, so the expectation holds only outside them.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the streams that use the rest of the mappers and the DTOs come in the next commit"
    )
)]

use std::{future::ready, sync::Arc};

use matrix_sdk::{
    Client, Error,
    ruma::{
        OwnedUserId, UserId,
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
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::{Mutex, watch};
use ts_rs::TS;

use super::{
    account_data,
    member::{on_account, sent_once},
};
use crate::{
    accounts::Engine,
    dispatch::{Stream, detached, reply},
    failure::request_failed,
};

const IGNORED_USER_LIST: &str = "m.ignored_user_list";
const DTO: &str = "data-access/identity/src/lib/rust-dto/";

/// `UserProfile`.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct UserProfileDto {
    display_name: Option<String>,
    avatar_mxc: Option<String>,
}

/// `PresenceInfo`.
#[derive(Debug, PartialEq, Serialize, TS)]
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
#[derive(Debug, PartialEq, Serialize, TS)]
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
}

impl IdentitySignals {
    pub(crate) fn new(client: &Client, account_id: &str) -> Self {
        let signals = Self {
            profile: watch::Sender::new(0),
            presence: watch::Sender::new(0),
            ignored: watch::Sender::new(0),
            ignore_writes: Arc::new(Mutex::new(())),
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
    reply(on_account(
        engine,
        account_id,
        request_failed,
        |engine, rt| async move {
            let request = get_presence::v3::Request::new(own_id(&rt.client)?);
            let send = rt.client.send(request).with_request_config(sent_once());
            let response = engine.ruled(&rt, send).await?;
            Ok(own_presence_of(&response))
        },
    ))
}

pub fn set_presence(
    engine: Arc<Engine>,
    account_id: String,
    presence: PresenceStateDto,
    status_message: Option<String>,
) -> Stream {
    detached(on_account(
        engine,
        account_id,
        request_failed,
        move |engine, rt| async move {
            let mut request = set_presence::v3::Request::new(own_id(&rt.client)?, presence.into());
            request.status_msg = status_message;
            let send = rt.client.send(request).with_request_config(sent_once());
            engine.ruled(&rt, send).await?;
            tick(&rt.identity.presence);
            Ok(())
        },
    ))
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
        // shortcut: a call queued across a client replacement waits on the old client's lock and
        // runs beside the new one's writes, upgrade if replacements overlap writes in practice.
        let queue = engine
            .account(&account_id)
            .map(|rt| Arc::clone(&rt.identity.ignore_writes));
        let turn = match queue {
            Some(queue) => Some(queue.lock_owned().await),
            None => None,
        };
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

fn own_id(client: &Client) -> Result<OwnedUserId, Error> {
    client
        .user_id()
        .map(ToOwned::to_owned)
        .ok_or(Error::AuthenticationRequired)
}

fn string_of(r: &get_profile::v3::Response, field: &str) -> Option<String> {
    r.get(field).and_then(Value::as_str).map(str::to_owned)
}

/// The account's own profile, as js reads its `User`: an empty string is no value, and the
/// display name the SDK makes of a nameless user, the user id, is none.
fn own_profile_of(account_id: &str, r: &get_profile::v3::Response) -> UserProfileDto {
    let set = |field| string_of(r, field).filter(|value| !value.is_empty());
    UserProfileDto {
        display_name: set("displayname").filter(|name| name != account_id),
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

/// The account's entry in `presence`, `None` while the server has no presence for it. The server
/// may echo the account's own presence through the stream, so the id is the caller's.
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
    use std::time::Duration;

    use futures_util::{FutureExt, StreamExt, future::join};
    use matrix_sdk::{config::SyncSettings, sleep::sleep, timeout::timeout};
    use tempfile::TempDir;

    use super::*;
    use crate::{
        config::EngineConfig,
        failure::http_error_from_response,
        testing::{Seen, default_client, engine_in, live, password, requests, scripted},
    };

    const SYNC: &str = "GET /_matrix/client/v3/sync?timeout=0&use_state_after=true";
    const PROFILE: &str = "GET /_matrix/client/v3/profile/@b:c";
    const NAME: &str = "PUT /_matrix/client/v3/profile/@a:b/displayname";
    const AVATAR: &str = "PUT /_matrix/client/v3/profile/@a:b/avatar_url";
    const PRESENCE_GET: &str = "GET /_matrix/client/v3/presence/@a:b/status";
    const PRESENCE_SET: &str = "PUT /_matrix/client/v3/presence/@a:b/status";
    const IGNORED_GET: &str = "GET /_matrix/client/v3/user/@a:b/account_data/m.ignored_user_list";
    const IGNORED_PUT: &str = "PUT /_matrix/client/v3/user/@a:b/account_data/m.ignored_user_list";

    type Command = fn(Arc<Engine>) -> Stream;
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
        let engine = engine_in(root);
        let account = password(&base);
        drop(live(&engine, &account, default_client(&engine, &account).await).await);
        (engine, seen)
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
    fn own_profile_reads_the_user_id_and_empty_strings_as_null() {
        let own = |fields| own_profile_of("@a:b", &profile_response(fields));
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
    async fn a_not_live_account_fails_before_its_arguments_are_parsed() {
        let engine = Engine::new(EngineConfig::default()).unwrap();
        let reply = first(profile(engine, "@x:y".into(), "not a user id".into())).await;
        assert_eq!(reply["failure"]["code"], json!("account-not-live"));
    }
}
