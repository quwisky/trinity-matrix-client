//! `RoomListEngine`'s room commands: create, join, leave, invite and resolve.

use std::{future::ready, sync::Arc};

use matrix_sdk::{
    Client, RoomState,
    ruma::{
        EventEncryptionAlgorithm, RoomAliasId, RoomId, RoomOrAliasId, ServerName, UserId,
        api::client::{
            alias::get_alias,
            membership::{
                invite_user::{self, v3::InviteUserId},
                leave_room,
            },
            room::{
                Visibility,
                create_room::{
                    self,
                    v3::{CreationContent, RoomPreset},
                },
            },
        },
        events::{
            AnyInitialStateEvent, InitialStateEvent, room::encryption::RoomEncryptionEventContent,
        },
        room::RoomType,
        serde::Raw,
    },
};
use serde_json::{Map, Value, json};

use super::{
    CreateRoomRequestDto, RoomIdDto, RoomKindDto,
    rows::membership_of,
    settle::{account_data_changes, room_changes, settle},
    typing::direct_map_in,
};
use crate::{
    accounts::{AccountRuntime, Engine},
    dispatch::{Stream, detached, reply},
    engines::{
        account_data,
        member::{bounded, on_account, sent_once},
    },
    failure::{invite_failed, request_failed},
};

/// `m.room.encryption` in the initial state, so a room is encrypted from its first event.
fn encrypted() -> Vec<Raw<AnyInitialStateEvent>> {
    let content = RoomEncryptionEventContent::new(EventEncryptionAlgorithm::MegolmV1AesSha2);
    vec![InitialStateEvent::with_empty_state_key(content).to_raw_any()]
}

/// The js adapter's `createRoomOrSpace`: an encrypted room, or a space, which is not encrypted.
pub(crate) fn create_request(req: &CreateRoomRequestDto) -> create_room::v3::Request {
    let mut request = create_room::v3::Request::new();
    request.name = Some(req.name.trim().to_owned());
    request.topic = req
        .topic
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned);
    (request.visibility, request.preset) = if req.is_public {
        (Visibility::Public, Some(RoomPreset::PublicChat))
    } else {
        (Visibility::Private, Some(RoomPreset::PrivateChat))
    };
    match req.kind {
        RoomKindDto::Space => {
            let mut content = CreationContent::new();
            content.room_type = Some(RoomType::Space);
            request.creation_content = Raw::new(&content).ok();
        }
        RoomKindDto::Room => request.initial_state = encrypted(),
    }
    request
}

/// The js adapter's `openDirectRoom` request: an encrypted `is_direct` room inviting `user`.
pub(crate) fn dm_request(user: &UserId) -> create_room::v3::Request {
    let mut request = create_room::v3::Request::new();
    request.is_direct = true;
    request.invite = vec![user.to_owned()];
    request.preset = Some(RoomPreset::TrustedPrivateChat);
    request.initial_state = encrypted();
    request
}

/// The joined DM among `candidates`, else the first invited one.
pub(crate) fn existing_dm(
    candidates: &[String],
    state_of: impl Fn(&str) -> Option<RoomState>,
) -> Option<String> {
    let first = |wanted| candidates.iter().find(|id| state_of(id) == Some(wanted));
    first(RoomState::Joined)
        .or_else(|| first(RoomState::Invited))
        .cloned()
}

/// `m.direct` with `room` appended under `user`; `None` when it is already listed (no write).
pub(crate) fn merged_direct(current: Option<Value>, user: &str, room: &str) -> Option<Value> {
    let mut map = match current {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let rooms = map.entry(user).or_insert_with(|| json!([]));
    match rooms {
        Value::Array(rooms) if rooms.iter().any(|listed| listed == room) => return None,
        Value::Array(rooms) => rooms.push(room.into()),
        other => *other = json!([room]),
    }
    Some(Value::Object(map))
}

/// Joined, invited or knocked: a room the room list shows.
fn listed(state: Option<RoomState>) -> bool {
    state.and_then(membership_of).is_some()
}

fn state_in(client: &Client, room_id: &RoomId) -> Option<RoomState> {
    client.get_room(room_id).map(|room| room.state())
}

/// Waits until the room's state satisfies `done`, then has every open room list stream emit the
/// room's row.
async fn show(rt: &AccountRuntime, room_id: &RoomId, done: impl Fn(Option<RoomState>) -> bool) {
    let changes = room_changes(&rt.client, room_id);
    settle(rt.retired(), changes, || {
        ready(done(state_in(&rt.client, room_id)))
    })
    .await;
    rt.nudge(Some(room_id)).delivered().await;
}

fn answer(room_id: &RoomId) -> RoomIdDto {
    RoomIdDto {
        room_id: room_id.to_string(),
    }
}

/// Worst case about 55 s: the request (30 s) with up to ~5 s of `ruled` waits, a settle (15 s) and
/// the delivery (5 s).
pub fn create_room(
    engine: Arc<Engine>,
    account_id: String,
    request: CreateRoomRequestDto,
) -> Stream {
    detached(on_account(
        engine,
        account_id,
        request_failed,
        move |engine, rt| async move {
            let sent = rt
                .client
                .send(create_request(&request))
                .with_request_config(sent_once());
            let room_id = engine.ruled(&rt, sent).await?.room_id;
            show(&rt, &room_id, |state| state == Some(RoomState::Joined)).await;
            Ok(answer(&room_id))
        },
    ))
}

// shortcut: retire ends both settles and the delivery waits but not the three requests: create
// (30 s), the m.direct read (30 s) and write (60 s), each with up to ~5 s of `ruled` waits, take
// up to about 135 s and outlast the teardown's 120 s `HOLDER_LIMIT` only when every request hits
// its timeout, which then logs a retired account still in use; upgrade when matrix-sdk gains a
// client shutdown or the write is bounded tighter.
pub fn create_direct_message(engine: Arc<Engine>, account_id: String, user_id: String) -> Stream {
    detached(on_account(
        engine,
        account_id,
        request_failed,
        move |engine, rt| async move {
            let user = UserId::parse(&user_id)?;
            let client = &rt.client;
            let stored = direct_map_in(client).await?;
            let candidates = stored.0.get(user.as_str()).map_or(&[][..], Vec::as_slice);
            let existing = existing_dm(candidates, |id| {
                let id = RoomId::parse(id).ok()?;
                state_in(client, &id)
            });
            if let Some(id) = existing {
                let room_id = RoomId::parse(id)?;
                show(&rt, &room_id, listed).await;
                return Ok(answer(&room_id));
            }
            let sent = client
                .send(dm_request(&user))
                .with_request_config(sent_once());
            let room_id = engine.ruled(&rt, sent).await?.room_id;
            let current = engine
                .ruled(&rt, account_data::get(client, "m.direct"))
                .await?;
            if let Some(merged) = merged_direct(current, user.as_str(), room_id.as_str()) {
                engine
                    .ruled(&rt, account_data::put(client, "m.direct", &merged))
                    .await?;
            }
            let changes = account_data_changes(client, "m.direct");
            settle(rt.retired(), changes, || async {
                let map = direct_map_in(client).await;
                let rooms = map.ok().and_then(|map| map.0.get(user.as_str()).cloned());
                rooms.is_some_and(|rooms| rooms.iter().any(|id| id == room_id.as_str()))
            })
            .await;
            show(&rt, &room_id, listed).await;
            Ok(answer(&room_id))
        },
    ))
}

pub fn join(
    engine: Arc<Engine>,
    account_id: String,
    room_id_or_alias: String,
    via: Vec<String>,
) -> Stream {
    reply(on_account(
        engine,
        account_id,
        request_failed,
        move |engine, rt| async move {
            let target = <&RoomOrAliasId>::try_from(room_id_or_alias.as_str())?;
            let via = via
                .iter()
                .map(ServerName::parse)
                .collect::<Result<Vec<_>, _>>()?;
            let join = rt.client.join_room_by_id_or_alias(target, &via);
            let room = engine.ruled(&rt, bounded(join)).await?;
            rt.nudge(Some(room.room_id())).delivered().await;
            Ok(answer(room.room_id()))
        },
    ))
}

pub fn leave(engine: Arc<Engine>, account_id: String, room_id: String) -> Stream {
    reply(on_account(
        engine,
        account_id,
        request_failed,
        move |engine, rt| async move {
            let room_id = RoomId::parse(&room_id)?;
            match rt
                .client
                .get_room(&room_id)
                .filter(|room| listed(Some(room.state())))
            {
                Some(room) => engine.ruled(&rt, bounded(room.leave())).await?,
                None => {
                    let request = leave_room::v3::Request::new(room_id.clone());
                    let sent = rt.client.send(request).with_request_config(sent_once());
                    engine.ruled(&rt, sent).await?;
                }
            }
            show(&rt, &room_id, |state| !listed(state)).await;
            Ok(())
        },
    ))
}

pub fn invite(engine: Arc<Engine>, account_id: String, room_id: String, user_id: String) -> Stream {
    reply(on_account(
        engine,
        account_id,
        invite_failed,
        move |engine, rt| async move {
            let room_id = RoomId::parse(&room_id)?;
            let user = UserId::parse(&user_id)?;
            match rt.client.get_room(&room_id) {
                Some(room) => {
                    engine
                        .ruled(&rt, bounded(room.invite_user_by_id(&user)))
                        .await?
                }
                None => {
                    let recipient =
                        invite_user::v3::InvitationRecipient::UserId(InviteUserId::new(user));
                    let request = invite_user::v3::Request::new(room_id, recipient);
                    let sent = rt.client.send(request).with_request_config(sent_once());
                    engine.ruled(&rt, sent).await?;
                }
            }
            Ok(())
        },
    ))
}

pub fn resolve_alias(engine: Arc<Engine>, account_id: String, alias: String) -> Stream {
    reply(on_account(
        engine,
        account_id,
        request_failed,
        move |engine, rt| async move {
            let alias = RoomAliasId::parse(&alias)?;
            let sent = rt
                .client
                .send(get_alias::v3::Request::new(alias))
                .with_request_config(sent_once());
            let response = engine.ruled(&rt, sent).await?;
            Ok(answer(&response.room_id))
        },
    ))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use futures_util::StreamExt;
    use matrix_sdk::{ruma::user_id, timeout::timeout};
    use serde_json::json;
    use tempfile::TempDir;
    use tokio::time::sleep;

    use super::*;
    use crate::{
        dispatch::dispatch,
        testing::{Seen, builder_on, engine_in, live, password, requests, scripted},
    };

    const ENCRYPTION: &str = r#"{"type":"m.room.encryption","state_key":"","content":{"algorithm":"m.megolm.v1.aes-sha2"}}"#;

    fn json_of(value: &impl serde::Serialize) -> Value {
        serde_json::to_value(value).unwrap()
    }

    fn room_request(name: &str, topic: Option<&str>, kind: RoomKindDto) -> CreateRoomRequestDto {
        CreateRoomRequestDto {
            name: name.into(),
            topic: topic.map(Into::into),
            is_public: false,
            kind,
            parent_space_id: None,
        }
    }

    #[test]
    fn create_request_builds_a_room_and_a_space() {
        let encryption: Value = serde_json::from_str(ENCRYPTION).unwrap();
        let room = create_request(&room_request(" x ", Some("  "), RoomKindDto::Room));
        assert_eq!(room.name.as_deref(), Some("x"));
        assert_eq!(room.topic, None);
        assert_eq!(room.visibility, Visibility::Private);
        assert_eq!(room.preset, Some(RoomPreset::PrivateChat));
        assert_eq!(json_of(&room.initial_state), json!([encryption]));
        assert!(room.creation_content.is_none());

        let mut public = room_request("p", Some(" why "), RoomKindDto::Space);
        public.is_public = true;
        let space = create_request(&public);
        assert_eq!(space.topic.as_deref(), Some("why"));
        assert_eq!(space.visibility, Visibility::Public);
        assert_eq!(space.preset, Some(RoomPreset::PublicChat));
        assert_eq!(json_of(&space.creation_content), json!({"type": "m.space"}));
        assert!(space.initial_state.is_empty());
    }

    #[test]
    fn dm_request_invites_and_encrypts() {
        let request = dm_request(user_id!("@b:x"));
        let encryption: Value = serde_json::from_str(ENCRYPTION).unwrap();
        assert!(request.is_direct);
        assert_eq!(request.invite, [user_id!("@b:x").to_owned()]);
        assert_eq!(request.preset, Some(RoomPreset::TrustedPrivateChat));
        assert_eq!(json_of(&request.initial_state), json!([encryption]));
    }

    #[test]
    fn existing_dm_prefers_joined_then_invited() {
        let state = |id: &str| match id {
            "!left" => Some(RoomState::Left),
            "!inv" => Some(RoomState::Invited),
            "!join" => Some(RoomState::Joined),
            _ => None,
        };
        let ids = |ids: &[&str]| ids.iter().map(|id| (*id).to_owned()).collect::<Vec<_>>();
        let all = ids(&["!left", "!inv", "!join", "!unknown"]);
        assert_eq!(existing_dm(&all, state).as_deref(), Some("!join"));
        let without = ids(&["!left", "!inv", "!unknown"]);
        assert_eq!(existing_dm(&without, state).as_deref(), Some("!inv"));
        assert_eq!(existing_dm(&ids(&["!left", "!unknown"]), state), None);
    }

    #[test]
    fn merged_direct_appends_once_and_keeps_other_users() {
        let current = json!({"@b:x": ["!1"], "@c:x": ["!2"]});
        assert_eq!(
            merged_direct(Some(current.clone()), "@b:x", "!3"),
            Some(json!({"@b:x": ["!1", "!3"], "@c:x": ["!2"]}))
        );
        assert_eq!(merged_direct(Some(current), "@b:x", "!1"), None);
        assert_eq!(
            merged_direct(None, "@b:x", "!3"),
            Some(json!({"@b:x": ["!3"]}))
        );
    }

    async fn account_on(base: &str, root: &TempDir) -> Arc<Engine> {
        let engine = engine_in(root);
        let client = builder_on(base).build().await.unwrap();
        live(&engine, &password(base), client).await;
        engine
    }

    async fn answer_of(mut stream: Stream) -> Value {
        stream.next().await.unwrap().unwrap()
    }

    #[tokio::test]
    async fn an_invalid_user_id_fails_create_direct_message_without_a_request() {
        let (base, seen) = scripted(vec![]);
        let root = TempDir::new().unwrap();
        let engine = account_on(&base, &root).await;
        let stream = create_direct_message(engine, "@a:b".into(), "not a user".into());
        let answer = answer_of(stream).await;
        assert_eq!(answer["ok"], json!(false));
        assert_eq!(answer["failure"]["code"], json!("request-failed"));
        assert_eq!(answer["failure"]["kind"], json!("unexpected"));
        assert!(requests(&seen).is_empty());
    }

    #[tokio::test]
    async fn leave_and_invite_of_a_room_the_client_does_not_hold_send_raw_requests() {
        let blocked = json!({"errcode": "M_INVITE_BLOCKED", "error": "no"});
        let leave = "POST /_matrix/client/v3/rooms/!x:b/leave";
        let invite = "POST /_matrix/client/v3/rooms/!x:b/invite";
        let (base, seen) = scripted(vec![(leave, 200, json!({})), (invite, 403, blocked)]);
        let root = TempDir::new().unwrap();
        let engine = account_on(&base, &root).await;
        let left = leave_of(&engine).await;
        assert_eq!(left, json!({"ok": true, "value": null}));
        let invited = answer_of(invite_of(&engine)).await;
        assert_eq!(invited["ok"], json!(false));
        assert_eq!(invited["failure"]["code"], json!("invite-blocked"));
        let seen: Vec<_> = requests(&seen)
            .into_iter()
            .map(|(target, _)| target)
            .collect();
        assert_eq!(seen, [leave, invite]);
    }

    async fn leave_of(engine: &Arc<Engine>) -> Value {
        let args = vec![json!("@a:b"), json!("!x:b")];
        answer_of(dispatch(engine, "roomList.leave", args).unwrap()).await
    }

    fn invite_of(engine: &Arc<Engine>) -> Stream {
        let args = vec![json!("@a:b"), json!("!x:b"), json!("@b:b")];
        dispatch(engine, "roomList.invite", args).unwrap()
    }

    async fn until(seen: &Seen, count: usize) {
        while requests(seen).len() < count {
            sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn a_closed_direct_message_still_writes_m_direct() {
        let m_direct = "/_matrix/client/v3/user/@a:b/account_data/m.direct";
        let absent = json!({"errcode": "M_NOT_FOUND", "error": "x"});
        let (base, seen) = scripted(vec![
            (
                "POST /_matrix/client/v3/createRoom",
                200,
                json!({"room_id": "!d:b"}),
            ),
            (
                Box::leak(format!("GET {m_direct}").into_boxed_str()),
                404,
                absent,
            ),
            (
                Box::leak(format!("PUT {m_direct}").into_boxed_str()),
                200,
                json!({}),
            ),
        ]);
        let root = TempDir::new().unwrap();
        let engine = account_on(&base, &root).await;
        let args = vec![json!("@a:b"), json!("@b:b")];
        let open = dispatch(&engine, "roomList.createDirectMessage", args).unwrap();
        timeout(until(&seen, 1), Duration::from_secs(5))
            .await
            .unwrap();
        drop(open);
        let written = timeout(until(&seen, 3), Duration::from_secs(2)).await;
        assert!(
            written.is_ok(),
            "the close cut the write: {:?}",
            requests(&seen)
        );
        assert_eq!(requests(&seen)[2].0, format!("PUT {m_direct}"));
    }
}
