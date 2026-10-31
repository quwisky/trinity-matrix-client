//! `RoomListEngine`'s room commands: create, join, leave, invite and resolve.

use std::{future::ready, sync::Arc};

use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::{
    Client, Error, Room, RoomState,
    ruma::{
        EventEncryptionAlgorithm, OwnedEventId, OwnedRoomId, OwnedUserId, RoomAliasId, RoomId,
        RoomOrAliasId, ServerName, UserId,
        api::client::{
            alias::get_alias,
            config::set_room_account_data,
            membership::{
                invite_user::{self, v3::InviteUserId},
                leave_room,
            },
            read_marker::set_read_marker,
            room::{
                Visibility,
                create_room::{
                    self,
                    v3::{CreationContent, RoomPreset},
                },
            },
            tag::{create_tag, delete_tag},
        },
        events::{
            AnyInitialStateEvent, InitialStateEvent, marked_unread::MarkedUnreadEventContent,
            room::encryption::RoomEncryptionEventContent, space::parent::SpaceParentEventContent,
            tag::TagInfo,
        },
        room::RoomType,
        serde::Raw,
    },
};
use serde_json::{Map, Value, json};

use super::{
    CreateRoomRequestDto, ReceiptsDto, RoomIdDto, RoomKindDto, RoomTagDto, SpaceChildLinkInputDto,
    rows::membership_of,
    spaces::{child_content, write_child},
    typing::direct_map_in,
};
use crate::{
    accounts::{AccountRuntime, Engine},
    dispatch::{Stream, detached, reply},
    engines::{
        account_data,
        member::{bounded, on_account, sent_once},
        settle::{account_data_changes, room_changes, settle},
    },
    failure::{invite_failed, request_failed},
};

/// `m.room.encryption` in the initial state, so a room is encrypted from its first event.
fn encrypted() -> Vec<Raw<AnyInitialStateEvent>> {
    let content = RoomEncryptionEventContent::new(EventEncryptionAlgorithm::MegolmV1AesSha2);
    vec![InitialStateEvent::with_empty_state_key(content).to_raw_any()]
}

/// The js adapter's `createRoomOrSpace`: an encrypted room, or a space, which is not encrypted. A
/// parent space adds a canonical `m.space.parent` to the initial state, so the new room is never
/// seen without it.
pub(crate) fn create_request(
    req: &CreateRoomRequestDto,
    server: &ServerName,
    parent: Option<&RoomId>,
) -> create_room::v3::Request {
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
    if let Some(parent) = parent {
        let mut content = SpaceParentEventContent::new(vec![server.to_owned()]);
        content.canonical = true;
        let event = InitialStateEvent::new(parent.to_owned(), content);
        request.initial_state.push(event.to_raw_any());
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

/// Worst case about 110 s: the request (30 s) with up to ~5 s of `ruled` waits, a settle (15 s) and
/// the delivery (5 s), and with a parent the same again for the child link.
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
            let server = me(&rt.client)?.server_name().to_owned();
            let parent = request.parent_space_id.as_deref().map(RoomId::parse);
            let parent = parent.transpose()?;
            let sent = rt
                .client
                .send(create_request(&request, &server, parent.as_deref()))
                .with_request_config(sent_once());
            let room_id = engine.ruled(&rt, sent).await?.room_id;
            show(&rt, &room_id, |state| state == Some(RoomState::Joined)).await;
            if let Some(parent) = parent {
                let link = SpaceChildLinkInputDto {
                    via: vec![server.to_string()],
                    suggested: true,
                    order: String::new(),
                };
                let content = child_content(Some(&link));
                write_child(&engine, &rt, &parent, room_id.as_str(), &content).await?;
                rt.nudge(Some(&parent)).delivered().await;
            }
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

/// Worst case about 100 s for an invite: the request (30 s), a settle (15 s), a second leave (30 s)
/// or the forget (30 s), each with up to ~5 s of `ruled` waits, and the delivery (5 s).
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
                // The SDK's leave forgets an invite at once, and the sync that carries our own
                // leave can then re-create the room as joined; forget it after that echo. With
                // no echo (a stalled sync) or on M_FORBIDDEN, the SDK's leave marks it left.
                Some(room) if room.state() == RoomState::Invited => {
                    let request = leave_room::v3::Request::new(room_id.clone());
                    let sent = rt.client.send(request).with_request_config(sent_once());
                    match engine.ruled(&rt, sent).await {
                        Ok(_) => show(&rt, &room_id, |state| !listed(state)).await,
                        Err(err) if err.client_api_error_kind() == Some(&ErrorKind::Forbidden) => {}
                        Err(err) => return Err(err),
                    }
                    if !listed(Some(room.state())) {
                        if let Err(err) = engine.ruled(&rt, bounded(room.forget())).await {
                            let kind = err.client_api_error_kind().map(ErrorKind::errcode);
                            tracing::warn!(?kind, "forgetting a declined invite failed");
                        }
                    } else if !*rt.retired().borrow() {
                        engine.ruled(&rt, bounded(room.leave())).await?
                    }
                }
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

fn me(client: &Client) -> Result<OwnedUserId, Error> {
    Ok(client
        .user_id()
        .ok_or(Error::AuthenticationRequired)?
        .to_owned())
}

fn tagged(room: &Room, tag: RoomTagDto) -> bool {
    match tag {
        RoomTagDto::Favourite => room.is_favourite(),
        RoomTagDto::LowPriority => room.is_low_priority(),
    }
}

/// `fully_read` and the chosen receipt at `event`; the other receipt stays unset.
pub(crate) fn read_markers(
    room: OwnedRoomId,
    event: OwnedEventId,
    receipts: ReceiptsDto,
) -> set_read_marker::v3::Request {
    let mut request = set_read_marker::v3::Request::new(room);
    request.fully_read = Some(event.clone());
    match receipts {
        ReceiptsDto::Public => request.read_receipt = Some(event),
        ReceiptsDto::Private => request.private_read_receipt = Some(event),
    }
    request
}

/// A raw write, because `Room::set_unread_flag` skips a write it thinks is redundant.
async fn write_marked_unread(
    engine: &Arc<Engine>,
    rt: &AccountRuntime,
    room_id: &RoomId,
    unread: bool,
) -> Result<(), Error> {
    let content = MarkedUnreadEventContent::new(unread);
    let request =
        set_room_account_data::v3::Request::new(me(&rt.client)?, room_id.to_owned(), &content)?;
    let sent = rt.client.send(request).with_request_config(sent_once());
    engine.ruled(rt, sent).await?;
    Ok(())
}

/// Raw `create_tag`/`delete_tag`, because `Room::set_is_favourite` clears the other tag.
pub fn set_tag(
    engine: Arc<Engine>,
    account_id: String,
    room_id: String,
    tag: RoomTagDto,
    on: bool,
) -> Stream {
    reply(on_account(
        engine,
        account_id,
        request_failed,
        move |engine, rt| async move {
            let room_id = RoomId::parse(&room_id)?;
            let name = match tag {
                RoomTagDto::Favourite => "m.favourite",
                RoomTagDto::LowPriority => "m.lowpriority",
            };
            let (user, room, tag_name) = (me(&rt.client)?, room_id.clone(), name.to_owned());
            if on {
                let request = create_tag::v3::Request::new(user, room, tag_name, TagInfo::new());
                let sent = rt.client.send(request).with_request_config(sent_once());
                engine.ruled(&rt, sent).await?;
            } else {
                let request = delete_tag::v3::Request::new(user, room, tag_name);
                let sent = rt.client.send(request).with_request_config(sent_once());
                engine.ruled(&rt, sent).await?;
            }
            if let Some(room) = rt.client.get_room(&room_id) {
                let changes = room_changes(&rt.client, &room_id);
                settle(rt.retired(), changes, || ready(tagged(&room, tag) == on)).await;
            }
            rt.nudge(Some(&room_id)).delivered().await;
            Ok(())
        },
    ))
}

pub fn set_marked_unread(
    engine: Arc<Engine>,
    account_id: String,
    room_id: String,
    unread: bool,
) -> Stream {
    reply(on_account(
        engine,
        account_id,
        request_failed,
        move |engine, rt| async move {
            let room_id = RoomId::parse(&room_id)?;
            write_marked_unread(&engine, &rt, &room_id, unread).await
        },
    ))
}

/// js `markRead`: clears a marked-unread flag, then sets `fully_read` and a read receipt at the
/// newest event held in memory. `fully_read` alone leaves the device-side count unchanged.
pub fn mark_read(
    engine: Arc<Engine>,
    account_id: String,
    room_id: String,
    receipts: ReceiptsDto,
) -> Stream {
    reply(on_account(
        engine,
        account_id,
        request_failed,
        move |engine, rt| async move {
            let room_id = RoomId::parse(&room_id)?;
            let Some(room) = rt.client.get_room(&room_id) else {
                return Ok(());
            };
            if room.is_marked_unread() {
                write_marked_unread(&engine, &rt, &room_id, false).await?;
            }
            let (cache, _drop_handles) = room.event_cache().await?;
            let newest = cache
                .rfind_map_event_in_memory_by(|event| event.event_id().map(ToOwned::to_owned))
                .await?;
            if let Some(event) = newest {
                let request = read_markers(room_id, event, receipts);
                let sent = rt.client.send(request).with_request_config(sent_once());
                engine.ruled(&rt, sent).await?;
            }
            Ok(())
        },
    ))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use futures_util::StreamExt;
    use matrix_sdk::{
        ruma::{event_id, room_id, server_name, user_id},
        timeout::timeout,
    };
    use serde_json::json;
    use tempfile::TempDir;
    use tokio::time::sleep;

    use super::*;
    use crate::{
        dispatch::dispatch,
        testing::{
            Seen, builder_on, engine_in, live, password, requests, scripted, sync, sync_answer,
        },
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
        let room = create_request(
            &room_request(" x ", Some("  "), RoomKindDto::Room),
            server(),
            None,
        );
        assert_eq!(room.name.as_deref(), Some("x"));
        assert_eq!(room.topic, None);
        assert_eq!(room.visibility, Visibility::Private);
        assert_eq!(room.preset, Some(RoomPreset::PrivateChat));
        assert_eq!(json_of(&room.initial_state), json!([encryption]));
        assert!(room.creation_content.is_none());

        let mut public = room_request("p", Some(" why "), RoomKindDto::Space);
        public.is_public = true;
        let space = create_request(&public, server(), None);
        assert_eq!(space.topic.as_deref(), Some("why"));
        assert_eq!(space.visibility, Visibility::Public);
        assert_eq!(space.preset, Some(RoomPreset::PublicChat));
        assert_eq!(json_of(&space.creation_content), json!({"type": "m.space"}));
        assert!(space.initial_state.is_empty());
    }

    fn server() -> &'static ServerName {
        server_name!("x")
    }

    #[test]
    fn create_request_puts_a_canonical_parent_in_initial_state() {
        let encryption: Value = serde_json::from_str(ENCRYPTION).unwrap();
        let child = room_request("c", None, RoomKindDto::Room);
        let parent = json!({
            "type": "m.space.parent",
            "state_key": "!s:x",
            "content": {"via": ["x"], "canonical": true},
        });
        let request = create_request(&child, server(), Some(room_id!("!s:x")));
        assert_eq!(json_of(&request.initial_state), json!([encryption, parent]));
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

    #[test]
    fn read_markers_sets_fully_read_and_the_chosen_receipt() {
        let (room, event) = (room_id!("!r:b").to_owned(), event_id!("$e").to_owned());
        let public = read_markers(room.clone(), event.clone(), ReceiptsDto::Public);
        assert_eq!(public.fully_read.as_ref(), Some(&event));
        assert_eq!(public.read_receipt.as_ref(), Some(&event));
        assert_eq!(public.private_read_receipt, None);
        let private = read_markers(room, event.clone(), ReceiptsDto::Private);
        assert_eq!(private.fully_read.as_ref(), Some(&event));
        assert_eq!(private.read_receipt, None);
        assert_eq!(private.private_read_receipt.as_ref(), Some(&event));
    }

    #[tokio::test]
    async fn mark_read_of_an_unknown_room_replies_ok_without_a_request() {
        let root = TempDir::new().unwrap();
        let engine = account_on("http://127.0.0.1:1", &root).await;
        let args = vec![json!("@a:b"), json!("!x:b"), json!("public")];
        let answer = answer_of(dispatch(&engine, "roomList.markRead", args).unwrap()).await;
        assert_eq!(answer, json!({"ok": true, "value": null}));
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

    fn invited() -> Value {
        let member = json!({
            "type": "m.room.member", "state_key": "@a:b", "sender": "@b:b",
            "content": {"membership": "invite"},
        });
        json!({"rooms": {"invite": {"!r:b": {"invite_state": {"events": [member]}}}}})
    }

    fn declined_by(engine: &Arc<Engine>) -> tokio::task::JoinHandle<Value> {
        let args = vec![json!("@a:b"), json!("!r:b")];
        tokio::spawn(answer_of(dispatch(engine, "roomList.leave", args).unwrap()))
    }

    #[tokio::test]
    async fn declining_an_invite_forgets_it_only_after_the_sync_echo_shows_it_left() {
        let leave = "POST /_matrix/client/v3/rooms/!r:b/leave";
        let forget = "POST /_matrix/client/v3/rooms/!r:b/forget";
        let left = json!({"rooms": {"leave": {"!r:b": {}}}});
        let (base, seen) = scripted(vec![
            sync_answer(0, invited()),
            (leave, 200, json!({})),
            sync_answer(1, left),
            (forget, 200, json!({})),
        ]);
        let root = TempDir::new().unwrap();
        let engine = account_on(&base, &root).await;
        let client = engine.account("@a:b").unwrap().client.clone();
        sync(&client).await;
        let declined = declined_by(&engine);
        timeout(until(&seen, 2), Duration::from_secs(5))
            .await
            .unwrap();
        sleep(Duration::from_millis(200)).await;
        assert_eq!(targets(&seen).len(), 2, "no forget before the echo");
        sync(&client).await;
        assert_eq!(declined.await.unwrap(), json!({"ok": true, "value": null}));
        assert!(client.get_room(room_id!("!r:b")).is_none());
        let seen = targets(&seen);
        assert!(seen[2].starts_with("GET /_matrix/client/v3/sync"));
        assert_eq!([&seen[1], &seen[3]], [leave, forget]);
    }

    #[tokio::test]
    async fn m_forbidden_on_an_invite_still_counts_as_left() {
        let leave = "POST /_matrix/client/v3/rooms/!r:b/leave";
        let forget = "POST /_matrix/client/v3/rooms/!r:b/forget";
        let refused = json!({"errcode": "M_FORBIDDEN", "error": "no"});
        let (base, seen) = scripted(vec![
            sync_answer(0, invited()),
            (leave, 403, refused.clone()),
            (leave, 403, refused),
            (forget, 200, json!({})),
        ]);
        let root = TempDir::new().unwrap();
        let engine = account_on(&base, &root).await;
        let client = engine.account("@a:b").unwrap().client.clone();
        sync(&client).await;
        let answer = declined_by(&engine).await.unwrap();
        assert_eq!(answer, json!({"ok": true, "value": null}));
        assert!(client.get_room(room_id!("!r:b")).is_none());
        assert_eq!(targets(&seen)[1..], [leave, leave, forget]);
    }

    // Real time: a paused clock would also cut the scripted server's replies short.
    #[tokio::test]
    async fn an_invite_with_no_sync_echo_is_left_locally_after_the_settle_limit() {
        let leave = "POST /_matrix/client/v3/rooms/!r:b/leave";
        let forget = "POST /_matrix/client/v3/rooms/!r:b/forget";
        let (base, seen) = scripted(vec![
            sync_answer(0, invited()),
            (leave, 200, json!({})),
            (leave, 200, json!({})),
            (forget, 200, json!({})),
        ]);
        let root = TempDir::new().unwrap();
        let engine = account_on(&base, &root).await;
        let client = engine.account("@a:b").unwrap().client.clone();
        sync(&client).await;
        let answer = declined_by(&engine).await.unwrap();
        assert_eq!(answer, json!({"ok": true, "value": null}));
        assert!(client.get_room(room_id!("!r:b")).is_none());
        assert_eq!(targets(&seen)[1..], [leave, leave, forget]);
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

    fn targets(seen: &Seen) -> Vec<String> {
        requests(seen)
            .into_iter()
            .map(|(target, _)| target)
            .collect()
    }

    /// A sync in which `!r:b` is joined with `account_data` and `timeline` events.
    fn joined(account_data: Value, timeline: Value) -> Value {
        let room =
            json!({"account_data": {"events": account_data}, "timeline": {"events": timeline}});
        json!({"rooms": {"join": {"!r:b": room}}})
    }

    #[tokio::test]
    async fn set_tag_writes_only_its_own_tag() {
        let tags = |tags: Value| {
            joined(
                json!([{"type": "m.tag", "content": {"tags": tags}}]),
                json!([]),
            )
        };
        let favourite = "PUT /_matrix/client/v3/user/@a:b/rooms/!r:b/tags/m.favourite";
        let (base, seen) = scripted(vec![
            sync_answer(0, tags(json!({"m.lowpriority": {}}))),
            (favourite, 200, json!({})),
            sync_answer(1, tags(json!({"m.lowpriority": {}, "m.favourite": {}}))),
        ]);
        let root = TempDir::new().unwrap();
        let engine = account_on(&base, &root).await;
        let client = engine.account("@a:b").unwrap().client.clone();
        sync(&client).await;
        let args = vec![
            json!("@a:b"),
            json!("!r:b"),
            json!("favourite"),
            json!(true),
        ];
        let tagged = tokio::spawn(answer_of(
            dispatch(&engine, "roomList.setTag", args).unwrap(),
        ));
        timeout(until(&seen, 2), Duration::from_secs(5))
            .await
            .unwrap();
        sync(&client).await;
        assert_eq!(tagged.await.unwrap(), json!({"ok": true, "value": null}));
        assert_eq!(
            targets(&seen)[1],
            favourite,
            "no request touched m.lowpriority"
        );
        let room = client.get_room(room_id!("!r:b")).unwrap();
        assert!(room.is_favourite() && room.is_low_priority());
    }

    #[tokio::test]
    async fn set_marked_unread_false_is_always_written() {
        let put = "PUT /_matrix/client/v3/user/@a:b/rooms/!r:b/account_data/m.marked_unread";
        let (base, seen) = scripted(vec![
            sync_answer(0, joined(json!([]), json!([]))),
            (put, 200, json!({})),
        ]);
        let root = TempDir::new().unwrap();
        let engine = account_on(&base, &root).await;
        sync(&engine.account("@a:b").unwrap().client).await;
        let args = vec![json!("@a:b"), json!("!r:b"), json!(false)];
        let answer = answer_of(dispatch(&engine, "roomList.setMarkedUnread", args).unwrap()).await;
        assert_eq!(answer, json!({"ok": true, "value": null}));
        assert_eq!(
            targets(&seen)[1..],
            [put],
            "a room not marked unread is written too"
        );
    }

    #[tokio::test]
    async fn mark_read_clears_marked_unread_before_the_read_markers() {
        let unread = json!([{"type": "m.marked_unread", "content": {"unread": true}}]);
        let message = json!([{
            "type": "m.room.message", "event_id": "$e", "sender": "@b:b", "origin_server_ts": 1,
            "content": {"msgtype": "m.text", "body": "hi"},
        }]);
        let cleared = "PUT /_matrix/client/v3/user/@a:b/rooms/!r:b/account_data/m.marked_unread";
        let markers = "POST /_matrix/client/v3/rooms/!r:b/read_markers";
        let (base, seen) = scripted(vec![
            sync_answer(0, joined(unread, message)),
            (cleared, 200, json!({})),
            (markers, 200, json!({})),
        ]);
        let root = TempDir::new().unwrap();
        let engine = account_on(&base, &root).await;
        let client = engine.account("@a:b").unwrap().client.clone();
        sync(&client).await;
        let room = client.get_room(room_id!("!r:b")).unwrap();
        assert!(room.is_marked_unread());
        let (cache, _handles) = room.event_cache().await.unwrap();
        let cached = async {
            while (cache
                .rfind_map_event_in_memory_by(|event| event.event_id().map(ToOwned::to_owned))
                .await)
                .unwrap()
                .is_none()
            {
                sleep(Duration::from_millis(10)).await;
            }
        };
        timeout(cached, Duration::from_secs(5)).await.unwrap();
        let args = vec![json!("@a:b"), json!("!r:b"), json!("public")];
        let answer = answer_of(dispatch(&engine, "roomList.markRead", args).unwrap()).await;
        assert_eq!(answer, json!({"ok": true, "value": null}));
        assert_eq!(targets(&seen)[1..], [cleared, markers]);
    }
}
