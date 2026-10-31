//! `RoomWidgetEngine` (`libs/data-access/widgets/src/lib/room-widget-engine.ts`) member by member
//! as its js-sdk adapter (`js-sdk-room-widget-engine.ts`) derives each value. Anyone with the
//! power can write a widget declaration, so each string in one is hostile: none reaches a log, a
//! `Debug` or a failure here, and it goes to the UI as the room wrote it, where the launch policy
//! judges the URL.

use std::{fmt, pin::pin, sync::Arc, time::Duration};

use async_stream::stream;
use futures_util::StreamExt;
use matrix_sdk::{
    Client, Error, Room, RoomState, SendOutsideWasm,
    ruma::{
        MxcUri, OwnedRoomId, RoomId, UserId, api::client::state::send_state_event,
        events::StateEventType, serde::Raw,
    },
    timeout::timeout,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use ts_rs::TS;

use super::{
    member::{account_stream, sent_once},
    room_state::{self, follow_state, read_state},
    settle::{room_changes, rooms_changes, settle},
};
use crate::{
    accounts::{AccountRuntime, Engine},
    dispatch::{Stream as Items, detached},
    failure::{
        EngineFailure, EngineResult, FailureCode, local_failure, not_signed_in, request_failed,
    },
};

const DTO: &str = "data-access/widgets/src/lib/rust-dto/";
/// The longest a command waits for the store to catch up with the room's membership and levels.
const LEVELS_WAIT: Duration = Duration::from_secs(3);
const UNNAMED: &str = "Unnamed widget";
const WIDGETS: &str = "im.vector.modular.widgets";

/// `RoomWidget`.
#[derive(Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct RoomWidgetDto {
    id: String,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    raw_url: String,
    #[ts(type = "Record<string, unknown>")]
    data: Map<String, Value>,
    creator_user_id: Option<String>,
    wait_for_iframe_load: bool,
    source_event_id: Option<String>,
}

impl fmt::Debug for RoomWidgetDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RoomWidgetDto").finish_non_exhaustive()
    }
}

impl fmt::Debug for RoomWidgetStateContentDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RoomWidgetStateContentDto")
            .finish_non_exhaustive()
    }
}

/// `WidgetIdentity`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct WidgetIdentityDto {
    user_id: String,
    display_name: String,
    avatar_url: String,
    device_id: String,
    homeserver_url: String,
}

/// `RoomWidgetSnapshot`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct RoomWidgetSnapshotDto {
    widgets: Vec<RoomWidgetDto>,
    can_manage: bool,
    identity: Option<WidgetIdentityDto>,
}

/// `RoomWidgetStateContent`: what `putRoomWidget` writes under its `id`.
#[derive(Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct RoomWidgetStateContentDto {
    id: String,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    url: String,
    creator_user_id: String,
    #[ts(type = "Record<string, unknown>")]
    data: Map<String, Value>,
    wait_for_iframe_load: bool,
}

/// What the store says: whether the account may manage the room's widgets, and who it is.
#[derive(Clone)]
struct Local {
    can_manage: bool,
    identity: WidgetIdentityDto,
}

/// The room's widgets with the account's permission and identity: the store's fields at once with
/// no widgets, then the server's widgets after each change. A failed widget read keeps the last
/// ones, and the store's fields still follow `follow_state`'s ticks, so a demotion shows while
/// the read fails. No `nudged()`: a request would hold every room list command's reply.
pub fn room_widgets(engine: Arc<Engine>, account_id: String, room_id: String) -> Items {
    let empty = RoomWidgetSnapshotDto {
        widgets: Vec::new(),
        can_manage: false,
        identity: None,
    };
    let id = account_id.clone();
    account_stream(engine, account_id, empty, move |rt, client| {
        let base_url = rt.base_url.clone();
        let room = RoomId::parse(&room_id).ok();
        let asked: Vec<OwnedRoomId> = room.iter().cloned().collect();
        let changes = rooms_changes(&client, asked.clone());
        let store = client.clone();
        let local = move || local_of(store.clone(), id.clone(), room.clone(), base_url.clone());
        let read = move || {
            let (client, asked) = (client.clone(), asked.clone());
            async move {
                let kinds = [StateEventType::from(WIDGETS)];
                let events = read_state(&client, &asked, &kinds).await?;
                let mine = asked.first().and_then(|room| events.get(room));
                Ok(mine.map_or_else(Vec::new, |all| all.iter().filter_map(widget_from).collect()))
            }
        };
        stream! {
            let first = snapshot(&local().await, &[]);
            let mut items = pin!(follow_state(first, local, read, |l, w| snapshot(l, w), changes));
            while let Some(now) = items.next().await {
                yield now;
            }
        }
    })
}

/// Writes `content` under its `id` unless room state holds any event there, an emptied one
/// included.
pub fn put_room_widget(
    engine: Arc<Engine>,
    account_id: String,
    room_id: String,
    content: RoomWidgetStateContentDto,
) -> Items {
    command(
        engine,
        account_id,
        room_id,
        move |engine, rt, room| async move {
            let kind = StateEventType::from(WIDGETS);
            let read = room_state::fetch(&rt.client, room.room_id(), &kind, &content.id);
            if engine.ruled(&rt, read).await.map_err(failed)?.is_some() {
                return Err(local_failure(FailureCode::StateKeyTaken));
            }
            let body = Raw::new(&content).map_err(failed)?.cast_unchecked();
            let request = send_state_event::v3::Request::new_raw(
                room.room_id().to_owned(),
                kind,
                content.id,
                body,
            );
            let send = rt.client.send(request).with_request_config(sent_once());
            engine.ruled(&rt, send).await.map_err(failed)?;
            Ok(())
        },
    )
}

/// Empties `widget_id`'s declaration while its live revision is `expected_event_id`. The check
/// and the write are not atomic: a later write still wins.
pub fn remove_room_widget(
    engine: Arc<Engine>,
    account_id: String,
    room_id: String,
    widget_id: String,
    expected_event_id: String,
) -> Items {
    command(
        engine,
        account_id,
        room_id,
        move |engine, rt, room| async move {
            let kind = StateEventType::from(WIDGETS);
            let read = room_state::fetch_event(&rt.client, room.room_id(), &kind, &widget_id);
            let current = engine.ruled(&rt, read).await.map_err(failed)?;
            let live = current
                .as_ref()
                .filter(|_| !expected_event_id.is_empty())
                .filter(|event| event["event_id"].as_str() == Some(expected_event_id.as_str()))
                .and_then(live_type);
            let Some(live) = live else {
                return Err(local_failure(FailureCode::Conflict));
            };
            if is_call_widget_type(live) {
                return Err(local_failure(FailureCode::Unsupported));
            }
            let body = Raw::new(&json!({})).map_err(failed)?.cast_unchecked();
            let request = send_state_event::v3::Request::new_raw(
                room.room_id().to_owned(),
                kind,
                widget_id,
                body,
            );
            let send = rt.client.send(request).with_request_config(sent_once());
            engine.ruled(&rt, send).await.map_err(failed)?;
            Ok(())
        },
    )
}

/// A detached, power-gated write: `not-signed-in` without the account, the room or a user id,
/// `forbidden` without the power to manage widgets. `run` ends within a teardown's limit: two
/// requests of at most 30 s each.
fn command<Fut>(
    engine: Arc<Engine>,
    account_id: String,
    room_id: String,
    run: impl FnOnce(Arc<Engine>, Arc<AccountRuntime>, Room) -> Fut + SendOutsideWasm + 'static,
) -> Items
where
    Fut: Future<Output = Result<(), EngineFailure>> + SendOutsideWasm,
{
    detached(async move {
        let outcome = match gate(&engine, &account_id, &room_id).await {
            Ok((rt, room)) => run(engine, rt, room).await,
            Err(failure) => Err(failure),
        };
        match outcome {
            Ok(()) => EngineResult::Ok(()),
            Err(failure) => EngineResult::Err(failure),
        }
    })
}

async fn gate(
    engine: &Engine,
    account_id: &str,
    room_id: &str,
) -> Result<(Arc<AccountRuntime>, Room), EngineFailure> {
    let rt = engine.account(account_id).ok_or_else(not_signed_in)?;
    let room = RoomId::parse(room_id).map_err(|_| not_signed_in())?;
    let room = rt.client.get_room(&room).ok_or_else(not_signed_in)?;
    let me = rt.client.user_id().ok_or_else(not_signed_in)?;
    // The widgets come from the server, so the store may still lag it: a join not yet synced
    // shows as an invite, and a room can be there before its power levels are. Either would
    // refuse a command the server would take.
    let settled = || async {
        match room.state() {
            RoomState::Invited => false,
            RoomState::Joined => room.power_levels().await.is_ok(),
            _ => true,
        }
    };
    let changes = room_changes(&rt.client, room.room_id());
    let _ = timeout(settle(rt.retired(), changes, settled), LEVELS_WAIT).await;
    if !can_manage(&room, me).await {
        return Err(local_failure(FailureCode::Forbidden));
    }
    Ok((rt, room))
}

/// Joined, and allowed to send widget state. js's guest check is dropped: nothing sets it.
async fn can_manage(room: &Room, me: &UserId) -> bool {
    room.state() == RoomState::Joined
        && room
            .power_levels_or_default()
            .await
            .user_can_send_state(me, StateEventType::from(WIDGETS))
}

fn failed(err: impl Into<Error>) -> EngineFailure {
    request_failed(&err.into())
}

async fn local_of(
    client: Client,
    account_id: String,
    room: Option<OwnedRoomId>,
    base_url: String,
) -> Local {
    let me = client.user_id();
    let user_id = me.map_or(account_id, ToString::to_string);
    let room = room.and_then(|id| client.get_room(&id));
    let (mut can, mut name, mut avatar) = (false, None, String::new());
    if let (Some(room), Some(me)) = (room, me) {
        can = can_manage(&room, me).await;
        if let Ok(Some(member)) = room.get_member_no_sync(me).await {
            name = member
                .display_name()
                .filter(|name| !name.is_empty())
                .map(str::to_owned);
            avatar = avatar_url(&base_url, member.avatar_url());
        }
    }
    Local {
        can_manage: can,
        identity: WidgetIdentityDto {
            display_name: name.unwrap_or_else(|| user_id.clone()),
            user_id,
            avatar_url: avatar,
            device_id: client
                .device_id()
                .map(ToString::to_string)
                .unwrap_or_default(),
            homeserver_url: base_url,
        },
    }
}

fn snapshot(local: &Local, widgets: &[RoomWidgetDto]) -> RoomWidgetSnapshotDto {
    RoomWidgetSnapshotDto {
        widgets: widgets.to_vec(),
        can_manage: local.can_manage,
        identity: Some(local.identity.clone()),
    }
}

/// js `widgetFrom`: a state event as a widget, or `None` when it has no id, type or URL (an
/// emptied declaration).
fn widget_from(event: &Value) -> Option<RoomWidgetDto> {
    let id = event["state_key"].as_str().filter(|key| !key.is_empty())?;
    let content = event["content"].as_object()?;
    let kind = text(content.get("type"))?;
    let raw_url = content
        .get("url")
        .and_then(Value::as_str)
        .filter(|url| !js_trim(url).is_empty())?;
    let data = content.get("data").and_then(Value::as_object);
    let name = text(content.get("name"))
        .or_else(|| text(data.and_then(|data| data.get("title"))))
        .unwrap_or_else(|| UNNAMED.to_owned());
    Some(RoomWidgetDto {
        id: id.to_owned(),
        name,
        kind,
        raw_url: raw_url.to_owned(),
        data: data.cloned().unwrap_or_default(),
        creator_user_id: text(content.get("creatorUserId")).or_else(|| text(event.get("sender"))),
        wait_for_iframe_load: content
            .get("waitForIframeLoad")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        source_event_id: event["event_id"].as_str().map(str::to_owned),
    })
}

/// js `activeWidgetType`: the type of a declaration that is not emptied.
fn live_type(event: &Value) -> Option<&str> {
    let content = event["content"].as_object()?;
    content.get("url")?.as_str()?;
    content
        .get("type")?
        .as_str()
        .filter(|kind| !kind.is_empty())
}

/// js `text`: a string that is not blank, trimmed.
fn text(value: Option<&Value>) -> Option<String> {
    let trimmed = js_trim(value?.as_str()?);
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// js `String.prototype.trim`, which keeps U+0085 and trims U+FEFF, unlike `str::trim`.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// js `isCallWidgetType`: trimmed and lowercased.
fn is_call_widget_type(kind: &str) -> bool {
    matches!(
        js_trim(kind).to_lowercase().as_str(),
        "jitsi" | "m.jitsi" | "m.call"
    )
}

/// js's `mxcUrlToHttp(mxc, 96, 96, 'crop', false, false, false)`, or `""` with no avatar.
fn avatar_url(base_url: &str, mxc: Option<&MxcUri>) -> String {
    let Some((server, media)) = mxc.and_then(|mxc| mxc.parts().ok()) else {
        return String::new();
    };
    format!(
        "{base_url}/_matrix/media/v3/thumbnail/{server}/{media}\
         ?width=96&height=96&method=crop&allow_redirect=false"
    )
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use futures_util::StreamExt;
    use matrix_sdk::{ruma::mxc_uri, timeout::timeout};
    use serde_json::json;
    use tempfile::TempDir;

    use super::*;
    use crate::{
        dispatch::dispatch,
        testing::{
            default_client, engine_in, live, password, requests, scripted, sync, sync_answer,
        },
    };

    const SYNC: &str = "POST /_matrix/client/unstable/org.matrix.simplified_msc3575/sync*";
    const KEY: &str = "/_matrix/client/v3/rooms/!r:b/state/im.vector.modular.widgets/w";

    fn get(suffix: &str) -> &'static str {
        format!("GET {KEY}{suffix}").leak()
    }

    fn put() -> &'static str {
        format!("PUT {KEY}").leak()
    }

    fn absent() -> Value {
        json!({"errcode": "M_NOT_FOUND", "error": "x"})
    }

    /// The first room `!r:b` joined, where `@a:b` holds `level` and widget state needs 50.
    fn joined_at(level: u32) -> Value {
        joined(Some(level))
    }

    /// The room `!r:b` joined, with its power levels when `level` is given.
    fn joined(level: Option<u32>) -> Value {
        let level_id = level.unwrap_or_default();
        let event = |kind: &str, key: &str, content: Value| {
            let id = format!("${kind}{level_id}");
            let sender = if kind == "m.room.member" {
                "@a:b"
            } else {
                "@o:b"
            };
            json!({"type": kind, "state_key": key, "sender": sender, "event_id": id,
                "origin_server_ts": 1, "content": content})
        };
        let mut state = vec![
            event("m.room.create", "", json!({"room_version": "10"})),
            event(
                "m.room.member",
                "@a:b",
                json!({"membership": "join", "displayname": "Alice", "avatar_url": "mxc://b/av"}),
            ),
        ];
        if let Some(level) = level {
            let content = json!({"users": {"@a:b": level}, "state_default": 50});
            state.push(event("m.room.power_levels", "", content));
        }
        json!({"rooms": {"join": {"!r:b": {"state": {"events": state}}}}})
    }

    async fn engine_on(base: &str, root: &TempDir) -> Arc<Engine> {
        let engine = engine_in(root);
        let client = default_client(&engine, &password(base)).await;
        live(&engine, &password(base), client).await;
        engine
    }

    async fn answer_of(engine: &Arc<Engine>, method: &str, args: Vec<Value>) -> Value {
        let mut items = dispatch(engine, method, args).unwrap();
        items.next().await.unwrap().unwrap()
    }

    fn content() -> Value {
        json!({"id": "w", "name": "W", "type": "m.custom", "url": "https://w.example/",
            "creatorUserId": "@a:b", "data": {}, "waitForIframeLoad": true})
    }

    async fn put_widget(engine: &Arc<Engine>, room: &str) -> Value {
        let args = vec![json!("@a:b"), json!(room), content()];
        answer_of(engine, "roomWidget.putRoomWidget", args).await
    }

    async fn remove_widget(engine: &Arc<Engine>, expected: &str) -> Value {
        let args = vec![json!("@a:b"), json!("!r:b"), json!("w"), json!(expected)];
        answer_of(engine, "roomWidget.removeRoomWidget", args).await
    }

    fn code(answer: &Value) -> &Value {
        &answer["failure"]["code"]
    }

    /// An account whose room `!r:b` it manages (`level` 100) or not (0), already synced.
    async fn managing(
        answers: Vec<(&'static str, u16, Value)>,
        level: u32,
        root: &TempDir,
    ) -> (Arc<Engine>, crate::testing::Seen) {
        let mut script = vec![sync_answer(0, joined_at(level))];
        script.extend(answers);
        let (base, seen) = scripted(script);
        let engine = engine_on(&base, root).await;
        sync(&engine.account("@a:b").unwrap().client).await;
        (engine, seen)
    }

    fn json_of(widget: Option<RoomWidgetDto>) -> Value {
        json!(widget)
    }

    #[test]
    fn widget_from_table() {
        let event = |key: &str, content: Value| {
            json!({"type": "im.vector.modular.widgets", "state_key": key, "sender": "@o:b",
                "event_id": "$e", "content": content})
        };
        let full = event(
            "w",
            json!({"type": " m.custom ", "url": "https://w.example/$matrix_room_id", "name": " Board ",
                "data": {"title": "T", "k": 1}, "creatorUserId": " @c:b ", "waitForIframeLoad": false}),
        );
        let want = json!({"id": "w", "name": "Board", "type": "m.custom",
            "rawUrl": "https://w.example/$matrix_room_id", "data": {"title": "T", "k": 1},
            "creatorUserId": "@c:b", "waitForIframeLoad": false, "sourceEventId": "$e"});
        assert_eq!(json_of(widget_from(&full)), want);

        let bare = |content: Value| json_of(widget_from(&event("w", content)));
        let minimal = json!({"type": "t", "url": "u"});
        let got = bare(minimal.clone());
        assert_eq!(got["name"], "Unnamed widget");
        assert_eq!(got["creatorUserId"], "@o:b", "the sender stands in");
        assert_eq!(got["waitForIframeLoad"], true);
        assert_eq!(got["data"], json!({}));
        let titled = json!({"type": "t", "url": "u", "data": {"title": " From data "}});
        assert_eq!(bare(titled)["name"], "From data");
        let blank = json!({"type": "t", "url": "u", "name": "  ", "data": {"title": 5}});
        assert_eq!(bare(blank)["name"], "Unnamed widget");
        let listed = json!({"type": "t", "url": "u", "data": ["x"], "waitForIframeLoad": "no"});
        let got = bare(listed);
        assert_eq!(
            (&got["data"], &got["waitForIframeLoad"]),
            (&json!({}), &json!(true))
        );
        let spaced = bare(json!({"type": "t", "url": " https://w.example "}));
        assert_eq!(
            spaced["rawUrl"], " https://w.example ",
            "the URL is not trimmed"
        );

        assert_eq!(bare(json!({})), json!(null), "an emptied declaration");
        assert_eq!(
            bare(json!({"type": "t", "url": "   "})),
            json!(null),
            "a blank URL"
        );
        assert_eq!(bare(json!({"type": " ", "url": "u"})), json!(null));
        assert_eq!(bare(json!({"type": "t", "url": 3})), json!(null));
        assert_eq!(bare(json!("text")), json!(null));
        let no_key = event("", json!({"type": "t", "url": "u"}));
        assert!(widget_from(&no_key).is_none());
        assert!(widget_from(&json!({"content": {"type": "t", "url": "u"}})).is_none());
        // JS trims U+FEFF and keeps U+0085: it must read as js does.
        let odd = bare(json!({"type": "t", "url": "u", "name": "\u{feff}N\u{85}\u{feff}"}));
        assert_eq!(odd["name"], "N\u{85}");
    }

    #[test]
    fn is_call_widget_type_table() {
        for call in [
            "jitsi",
            "m.jitsi",
            "m.call",
            " M.Jitsi ",
            "JITSI\n",
            "M.CALL",
        ] {
            assert!(is_call_widget_type(call), "{call}");
        }
        for other in ["m.custom", "", "jitsi2", "m.jitsi.x", "call"] {
            assert!(!is_call_widget_type(other), "{other}");
        }
    }

    #[test]
    fn avatar_url_matches_js() {
        let base = "https://hs.example";
        let mxc = mxc_uri!("mxc://hs.example/AbC_-1");
        let want = "https://hs.example/_matrix/media/v3/thumbnail/hs.example/AbC_-1\
            ?width=96&height=96&method=crop&allow_redirect=false";
        assert_eq!(avatar_url(base, Some(mxc)), want);
        assert_eq!(avatar_url(base, None), "");
        let bad: &MxcUri = "mxc://hs.example/a/../b".into();
        assert_eq!(
            avatar_url(base, Some(bad)),
            "",
            "an invalid URI has no avatar"
        );
    }

    #[tokio::test]
    async fn put_refuses_an_emptied_tombstone() {
        let root = TempDir::new().unwrap();
        let script = vec![(get(""), 200, json!({})), (put(), 200, json!({}))];
        let (engine, seen) = managing(script, 100, &root).await;
        let answer = put_widget(&engine, "!r:b").await;
        assert_eq!(code(&answer), "state-key-taken", "{answer}");
        assert_eq!(requests(&seen).len(), 2, "the sync and the read only");
    }

    #[tokio::test]
    async fn put_sends_once() {
        let root = TempDir::new().unwrap();
        let script = vec![
            (get(""), 404, absent()),
            (put(), 502, json!({})),
            (put(), 200, json!({"event_id": "$x"})),
        ];
        let (engine, seen) = managing(script, 100, &root).await;
        let answer = put_widget(&engine, "!r:b").await;
        assert_eq!(answer["failure"]["code"], json!("request-failed"));
        let sent = requests(&seen);
        assert_eq!(sent.iter().filter(|(t, _)| t.starts_with("PUT")).count(), 1);
    }

    #[tokio::test]
    async fn put_writes_a_free_key() {
        let root = TempDir::new().unwrap();
        let script = vec![
            (get(""), 404, absent()),
            (put(), 200, json!({"event_id": "$x"})),
        ];
        let (engine, seen) = managing(script, 100, &root).await;
        let answer = put_widget(&engine, "!r:b").await;
        assert_eq!(answer, json!({"ok": true, "value": null}));
        assert_eq!(requests(&seen).len(), 3);
    }

    fn event_of(id: &str, content: Value) -> Value {
        json!({"type": "im.vector.modular.widgets", "state_key": "w", "sender": "@o:b",
            "event_id": id, "content": content})
    }

    fn live_content(kind: &str) -> Value {
        json!({"type": kind, "url": "https://w.example/"})
    }

    #[tokio::test]
    async fn remove_conflicts_on_a_newer_revision() {
        let root = TempDir::new().unwrap();
        let current = event_of("$new", live_content("m.custom"));
        let script = vec![
            (get("?format=event"), 200, current),
            (put(), 200, json!({})),
        ];
        let (engine, seen) = managing(script, 100, &root).await;
        let answer = remove_widget(&engine, "$old").await;
        assert_eq!(code(&answer), "conflict", "{answer}");
        assert_eq!(requests(&seen).len(), 2, "no write");
    }

    #[tokio::test]
    async fn remove_conflicts_with_no_live_revision() {
        let tombstone = event_of("$e", json!({}));
        let cases = [
            (200, tombstone, "$e"),
            (404, absent(), "$e"),
            (200, event_of("$e", live_content("m.custom")), ""),
            (200, event_of("$e", json!({"type": "", "url": "u"})), "$e"),
            (200, event_of("$e", json!({"type": "t"})), "$e"),
        ];
        for (status, body, expected) in cases {
            let root = TempDir::new().unwrap();
            let script = vec![
                (get("?format=event"), status, body),
                (put(), 200, json!({})),
            ];
            let (engine, seen) = managing(script, 100, &root).await;
            let answer = remove_widget(&engine, expected).await;
            assert_eq!(code(&answer), "conflict", "{answer}");
            assert_eq!(requests(&seen).len(), 2, "no write");
        }
    }

    #[tokio::test]
    async fn remove_refuses_a_call_widget() {
        let root = TempDir::new().unwrap();
        let current = event_of("$e", live_content(" M.Jitsi "));
        let script = vec![
            (get("?format=event"), 200, current),
            (put(), 200, json!({})),
        ];
        let (engine, seen) = managing(script, 100, &root).await;
        let answer = remove_widget(&engine, "$e").await;
        assert_eq!(code(&answer), "unsupported", "{answer}");
        assert_eq!(requests(&seen).len(), 2, "no write");
    }

    #[tokio::test]
    async fn remove_empties_the_live_revision_once() {
        let root = TempDir::new().unwrap();
        let current = event_of("$e", live_content("m.custom"));
        let script = vec![
            (get("?format=event"), 200, current),
            (put(), 502, json!({})),
            (put(), 200, json!({"event_id": "$x"})),
        ];
        let (engine, seen) = managing(script, 100, &root).await;
        let answer = remove_widget(&engine, "$e").await;
        assert_eq!(code(&answer), "request-failed", "{answer}");
        assert_eq!(requests(&seen).len(), 3, "one write");
    }

    #[tokio::test]
    async fn a_local_refusal_sends_nothing() {
        let root = TempDir::new().unwrap();
        let (engine, seen) = managing(vec![(get(""), 404, absent())], 0, &root).await;
        let denied = put_widget(&engine, "!r:b").await;
        assert_eq!(code(&denied), "forbidden", "{denied}");
        let denied = remove_widget(&engine, "$e").await;
        assert_eq!(code(&denied), "forbidden", "{denied}");
        let unknown = put_widget(&engine, "!gone:b").await;
        assert_eq!(code(&unknown), "not-signed-in", "{unknown}");
        let malformed = put_widget(&engine, "not a room").await;
        assert_eq!(code(&malformed), "not-signed-in", "{malformed}");
        let nobody = vec![json!("@x:y"), json!("!r:b"), content()];
        let nobody = answer_of(&engine, "roomWidget.putRoomWidget", nobody).await;
        assert_eq!(code(&nobody), "not-signed-in", "{nobody}");
        assert_eq!(requests(&seen).len(), 1, "the sync only");
    }

    #[tokio::test]
    async fn levels_that_reach_the_store_after_the_room_are_waited_for() {
        let root = TempDir::new().unwrap();
        let script = vec![
            sync_answer(0, joined(None)),
            sync_answer(1, joined_at(100)),
            (get(""), 404, absent()),
            (put(), 200, json!({"event_id": "$x"})),
        ];
        let (base, _) = scripted(script);
        let engine = engine_on(&base, &root).await;
        let client = engine.account("@a:b").unwrap().client.clone();
        sync(&client).await;
        let arrive = async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            sync(&client).await;
        };
        let (answer, ()) = futures_util::future::join(put_widget(&engine, "!r:b"), arrive).await;
        assert_eq!(answer, json!({"ok": true, "value": null}));
    }

    #[tokio::test]
    async fn a_join_that_reaches_the_store_late_is_waited_for() {
        let root = TempDir::new().unwrap();
        let invite = json!({"type": "m.room.member", "state_key": "@a:b", "sender": "@o:b",
            "content": {"membership": "invite"}});
        let invited =
            json!({"rooms": {"invite": {"!r:b": {"invite_state": {"events": [invite]}}}}});
        let script = vec![
            sync_answer(0, invited),
            sync_answer(1, joined_at(100)),
            (get(""), 404, absent()),
            (put(), 200, json!({"event_id": "$x"})),
        ];
        let (base, _) = scripted(script);
        let engine = engine_on(&base, &root).await;
        let client = engine.account("@a:b").unwrap().client.clone();
        sync(&client).await;
        let room = client.get_room(matrix_sdk::ruma::room_id!("!r:b")).unwrap();
        assert_eq!(room.state(), RoomState::Invited);
        let arrive = async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            sync(&client).await;
        };
        let (answer, ()) = futures_util::future::join(put_widget(&engine, "!r:b"), arrive).await;
        assert_eq!(answer, json!({"ok": true, "value": null}));
    }

    #[tokio::test]
    async fn a_failure_never_carries_the_widget() {
        let root = TempDir::new().unwrap();
        let hostile = json!({"errcode": "M_UNKNOWN", "error": "https://evil.example/secret"});
        let script = vec![(get(""), 500, hostile)];
        let (engine, _) = managing(script, 100, &root).await;
        let answer = put_widget(&engine, "!r:b").await;
        assert_eq!(code(&answer)["code"], json!(null));
        assert!(!answer.to_string().contains("evil"), "{answer}");
    }

    #[tokio::test]
    async fn an_account_that_is_not_live_has_the_empty_snapshot() {
        let engine = engine_in(&TempDir::new().unwrap());
        let args = vec![json!("@x:y"), json!("!r:b")];
        let mut items = dispatch(&engine, "roomWidget.roomWidgets", args).unwrap();
        let first = items.next().await.unwrap().unwrap();
        let empty = json!({"widgets": [], "canManage": false, "identity": null});
        assert_eq!(first, empty);
    }

    #[tokio::test]
    async fn the_first_item_is_the_store_with_no_request() {
        let root = TempDir::new().unwrap();
        let (engine, seen) = managing(vec![], 100, &root).await;
        let args = vec![json!("@a:b"), json!("!r:b")];
        let mut items = dispatch(&engine, "roomWidget.roomWidgets", args).unwrap();
        let first = items.next().await.unwrap().unwrap();
        let base = engine.account("@a:b").unwrap().base_url.clone();
        let avatar = avatar_url(&base, Some(mxc_uri!("mxc://b/av")));
        let identity = json!({"userId": "@a:b", "displayName": "Alice", "avatarUrl": avatar,
            "deviceId": "DEV", "homeserverUrl": base});
        let want = json!({"widgets": [], "canManage": true, "identity": identity});
        assert_eq!(first, want);
        assert_eq!(requests(&seen).len(), 1, "the sync only");
    }

    #[tokio::test]
    async fn a_room_the_store_lacks_is_a_snapshot_that_cannot_manage() {
        let root = TempDir::new().unwrap();
        let (engine, _) = managing(vec![], 100, &root).await;
        let args = vec![json!("@a:b"), json!("!other:b")];
        let mut items = dispatch(&engine, "roomWidget.roomWidgets", args).unwrap();
        let first = items.next().await.unwrap().unwrap();
        assert_eq!(first["canManage"], false);
        assert_eq!(
            first["identity"]["displayName"], "@a:b",
            "the user id stands in"
        );
        assert_eq!(first["identity"]["avatarUrl"], "");
    }

    #[tokio::test]
    async fn an_open_widget_stream_does_not_hold_a_nudge() {
        let root = TempDir::new().unwrap();
        let (engine, _) = managing(vec![(SYNC, 0, json!({}))], 100, &root).await;
        let args = vec![json!("@a:b"), json!("!r:b")];
        let mut items = dispatch(&engine, "roomWidget.roomWidgets", args).unwrap();
        assert!(items.next().await.is_some());
        let waiting = timeout(items.next(), Duration::from_millis(500)).await;
        assert!(
            waiting.is_err(),
            "the read waits for an answer that never comes"
        );
        let rt = engine.account("@a:b").unwrap();
        let delivered = timeout(rt.nudge(None).delivered(), Duration::from_millis(500)).await;
        assert!(delivered.is_ok(), "the open stream holds a nudge");
    }

    #[tokio::test]
    async fn a_demotion_shows_while_the_widget_read_fails() {
        let root = TempDir::new().unwrap();
        let script = vec![(SYNC, 502, json!({})), sync_answer(1, joined_at(0))];
        let (engine, seen) = managing(script, 100, &root).await;
        let args = vec![json!("@a:b"), json!("!r:b")];
        let mut items = dispatch(&engine, "roomWidget.roomWidgets", args).unwrap();
        assert_eq!(items.next().await.unwrap().unwrap()["canManage"], true);
        let waiting = timeout(items.next(), Duration::from_millis(500)).await;
        assert!(waiting.is_err(), "the failed read is no item");
        sync(&engine.account("@a:b").unwrap().client).await;
        let shown = timeout(items.next(), Duration::from_secs(5)).await;
        assert_eq!(shown.unwrap().unwrap().unwrap()["canManage"], false);
        assert_eq!(requests(&seen).len(), 3, "one read, none for the tick");
    }
}
