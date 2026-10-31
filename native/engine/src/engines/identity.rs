//! `IdentityEngine` (`libs/data-access/identity/src/lib/identity-engine.ts`), member by member as
//! its js-sdk adapter (`js-sdk-identity-engine.ts`) derives each value.
#![expect(
    dead_code,
    reason = "the commands and streams that use the mappers and signals come in the next commits"
)]

use std::future::ready;

use matrix_sdk::{
    Client, Error,
    ruma::{
        api::{
            client::{presence::get_presence, profile::get_profile},
            error::ErrorKind,
        },
        events::{
            GlobalAccountDataEvent, ignored_user_list::IgnoredUserListEventContent,
            room::member::OriginalSyncRoomMemberEvent,
        },
        presence::PresenceState,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::{Mutex, watch};
use ts_rs::TS;

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
    /// Serialises `setIgnored` on this account.
    pub(crate) ignore_writes: Mutex<()>,
}

impl IdentitySignals {
    pub(crate) fn new(client: &Client, account_id: &str) -> Self {
        let signals = Self {
            profile: watch::Sender::new(0),
            presence: watch::Sender::new(0),
            ignored: watch::Sender::new(0),
            ignore_writes: Mutex::new(()),
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

    use matrix_sdk::config::SyncSettings;

    use super::*;
    use crate::{
        accounts::Engine,
        config::EngineConfig,
        failure::http_error_from_response,
        testing::{default_client, password, scripted},
    };

    const SYNC: &str = "GET /_matrix/client/v3/sync?timeout=0&use_state_after=true";

    /// A profile response of `fields`, an object.
    fn profile(fields: Value) -> get_profile::v3::Response {
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
        let own = |fields| own_profile_of("@a:b", &profile(fields));
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
        let of = |fields| profile_of(&profile(fields));
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
}
