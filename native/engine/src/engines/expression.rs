//! `ExpressionEngine` (`libs/data-access/media/src/lib/expression-engine.ts`), member by member
//! as its js-sdk adapter (`js-sdk-expression-engine.ts`) derives each value. Every command maps
//! its failure like js `tooLargeOrFailed`: `M_FORBIDDEN` stays a `request-failed` of kind
//! `permission`.

use std::{collections::BTreeMap, sync::Arc, sync::Mutex, time::Duration};

use async_stream::stream;
use futures_util::{Stream, StreamExt};
use matrix_sdk::{
    Client, Error, Room, RoomDisplayName, RoomState,
    ruma::{
        OwnedRoomId, RoomAliasId, RoomId, RoomOrAliasId,
        api::client::{
            alias::get_alias,
            state::{get_state_events, send_state_event},
        },
        events::{GlobalAccountDataEventType, StateEventType},
        serde::Raw,
    },
    sleep::sleep,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use ts_rs::TS;

use super::{
    account_data,
    member::{account_stream, bounded, on_account, sent_once},
    room_state::{self, follow_state, read_state},
    settle::{account_data_changes_of, rooms_changes},
};
use crate::{
    accounts::Engine,
    dispatch::{Stream as Items, detached, reply},
    failure::{classify, too_large_or_failed},
};

const DTO: &str = "data-access/media/src/lib/rust-dto/";
const IMAGE_PACK: &str = "m.room.image_pack";
const MAX_VIA: usize = 3;
const LEVELS_POLL: Duration = Duration::from_millis(100);
const LEVELS_POLLS: u32 = 30;
const ROOM_EMOTES: &str = "im.ponies.room_emotes";

/// `AccountDataSnapshot`: each watched type's content, or null.
type Snapshot = Map<String, Value>;

/// `JoinedPackRoom`. Each event is `{ type, state_key, content }`.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct JoinedPackRoomDto {
    room_id: String,
    room_name: Option<String>,
    #[ts(type = "Array<{ type: string, state_key: string, content: unknown }>")]
    events: Vec<Value>,
}

/// `PackRoomSnapshot`. Each pack event is `{ type, state_key, content }`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct PackRoomDto {
    room_id: String,
    joined: bool,
    name: Option<String>,
    can_write_pack: bool,
    #[ts(type = "Array<{ type: string, state_key: string, content: unknown }>")]
    pack_events: Vec<Value>,
}

/// What the account's store says of one room.
struct Local {
    joined: bool,
    name: Option<String>,
    can_write_pack: bool,
}

type Events = BTreeMap<OwnedRoomId, Vec<Value>>;

/// The local copies of `types`, which a failed read keeps from the last snapshot.
pub fn account_data(engine: Arc<Engine>, account_id: String, types: Vec<String>) -> Items {
    let empty = nulls(&types);
    account_stream(engine, account_id, empty.clone(), move |_, client| {
        let changes = account_data_changes_of(&client, types.clone());
        let read = move || read_snapshot(client.clone(), types.clone());
        snapshots(empty, read, changes)
    })
}

/// One entry per id, in order. The store's fields come at once and again on each change, and the
/// pack events from the server once the first read is in; a failed read keeps the last events.
pub fn pack_rooms(engine: Arc<Engine>, account_id: String, room_ids: Vec<String>) -> Items {
    let empty = pack_rows(&room_ids, &[], &Events::new());
    account_stream(engine, account_id, empty, move |_, client| {
        let parsed: Vec<OwnedRoomId> = room_ids
            .iter()
            .filter_map(|id| RoomId::parse(id).ok())
            .collect();
        let changes = rooms_changes(&client, parsed.clone());
        let (store, ids) = (client.clone(), room_ids.clone());
        let locals = move || local_rows(store.clone(), ids.clone());
        let events = move || {
            let (client, parsed) = (client.clone(), parsed.clone());
            async move { read_state(&client, &parsed, &[IMAGE_PACK.into(), ROOM_EMOTES.into()]).await }
        };
        pack_stream(room_ids, locals, events, changes)
    })
}

pub fn fetch_account_data(engine: Arc<Engine>, account_id: String, event_type: String) -> Items {
    reply(on_account(
        engine,
        account_id,
        too_large_or_failed,
        move |engine, rt| async move {
            let read = account_data::get(&rt.client, &event_type);
            engine.ruled(&rt, read).await
        },
    ))
}

pub fn set_account_data(
    engine: Arc<Engine>,
    account_id: String,
    event_type: String,
    content: Value,
) -> Items {
    detached(on_account(
        engine,
        account_id,
        too_large_or_failed,
        move |engine, rt| async move {
            let write = account_data::put(&rt.client, &event_type, &content);
            engine.ruled(&rt, write).await
        },
    ))
}

/// The server's copy, with no check that the account is in the room: a world-readable room
/// needs no join.
pub fn fetch_room_state(
    engine: Arc<Engine>,
    account_id: String,
    room_id: String,
    event_type: String,
    state_key: String,
) -> Items {
    reply(on_account(
        engine,
        account_id,
        too_large_or_failed,
        move |engine, rt| async move {
            let room = RoomId::parse(&room_id)?;
            let kind = StateEventType::from(event_type);
            let read = room_state::fetch(&rt.client, &room, &kind, &state_key);
            engine.ruled(&rt, read).await
        },
    ))
}

pub fn set_room_state(
    engine: Arc<Engine>,
    account_id: String,
    room_id: String,
    event_type: String,
    state_key: String,
    content: Value,
) -> Items {
    detached(on_account(
        engine,
        account_id,
        too_large_or_failed,
        move |engine, rt| async move {
            let room = RoomId::parse(&room_id)?;
            let body = Raw::new(&content)?.cast_unchecked();
            let kind = StateEventType::from(event_type);
            let request = send_state_event::v3::Request::new_raw(room, kind, state_key, body);
            let send = rt.client.send(request).with_request_config(sent_once());
            engine.ruled(&rt, send).await?;
            Ok(())
        },
    ))
}

/// Resolves an alias, joins unless joined, then reads the room's state from the server. Three
/// requests of at most 30 s each, with the rule's waits.
pub fn join_pack_room(engine: Arc<Engine>, account_id: String, room_id_or_alias: String) -> Items {
    detached(on_account(
        engine,
        account_id,
        too_large_or_failed,
        move |engine, rt| async move {
            let (room_id, mut via) = if room_id_or_alias.starts_with('#') {
                let alias = RoomAliasId::parse(&room_id_or_alias)?;
                let request = get_alias::v3::Request::new(alias);
                let send = rt.client.send(request).with_request_config(sent_once());
                let found = engine.ruled(&rt, send).await?;
                (found.room_id, found.servers)
            } else {
                (RoomId::parse(&room_id_or_alias)?, Vec::new())
            };
            // As js: a long list could exceed a proxy's URL limit.
            via.truncate(MAX_VIA);
            let joined =
                (rt.client.get_room(&room_id)).is_some_and(|r| r.state() == RoomState::Joined);
            if !joined {
                let target = <&RoomOrAliasId>::from(&*room_id);
                let join = rt.client.join_room_by_id_or_alias(target, &via);
                engine.ruled(&rt, bounded(join)).await?;
            }
            // shortcut: the room's whole state is read, as js does, with no byte cap; cap it if a
            // pack room's state grows large enough to matter.
            let request = get_state_events::v3::Request::new(room_id.clone());
            let send = rt.client.send(request).with_request_config(sent_once());
            let state = engine.ruled(&rt, send).await?.room_state;
            let (name, events) = pack_state(&state);
            let room_name = match name {
                Some(name) => Some(name),
                None => local_name(&rt.client, &room_id).await,
            };
            Ok(JoinedPackRoomDto {
                room_id: room_id.to_string(),
                room_name,
                events,
            })
        },
    ))
}

/// The room's own name, if it states a non-blank one, and its pack events as `{ type,
/// state_key, content }`. An event too deep to read is left out, with the rest.
fn pack_state<E>(state: &[Raw<E>]) -> (Option<String>, Vec<Value>) {
    let (mut name, mut packs) = (None, Vec::new());
    for raw in state {
        let Ok(mut event) = raw.deserialize_as::<Value>() else {
            tracing::warn!("a state event was unreadable");
            continue;
        };
        let kind = event["type"].as_str().unwrap_or_default().to_owned();
        let key = event["state_key"].as_str().map(str::to_owned);
        let content = event
            .get_mut("content")
            .map(Value::take)
            .unwrap_or(Value::Null);
        match (kind.as_str(), key) {
            ("m.room.name", Some(key)) if key.is_empty() => {
                name = content["name"]
                    .as_str()
                    .filter(|n| !n.trim().is_empty())
                    .map(str::to_owned);
            }
            (IMAGE_PACK | ROOM_EMOTES, Some(key)) => {
                packs.push(json!({"type": kind, "state_key": key, "content": content}));
            }
            _ => {}
        }
    }
    (name, packs)
}

async fn local_name(client: &Client, room_id: &RoomId) -> Option<String> {
    let room = client.get_room(room_id)?;
    // An unnamed room reads `None`, also once synced, and the reader shows "Image pack": the
    // SDK's "Empty Room" is unlocalised English.
    match room.display_name().await.ok()? {
        RoomDisplayName::Empty | RoomDisplayName::EmptyWas(_) => None,
        name => Some(name.to_string()),
    }
}

async fn local_rows(client: Client, ids: Vec<String>) -> Vec<Option<Local>> {
    let mut rows = Vec::with_capacity(ids.len());
    for id in ids {
        rows.push(local_row(&client, &id).await);
    }
    rows
}

async fn local_row(client: &Client, id: &str) -> Option<Local> {
    let id = RoomId::parse(id).ok()?;
    let room = client.get_room(&id)?;
    let joined = room.state() == RoomState::Joined;
    let can_write_pack = match client.user_id() {
        Some(me) if joined => {
            settled(&room).await;
            let levels = room.power_levels_or_default().await;
            levels.user_can_send_state(me, StateEventType::from(IMAGE_PACK))
        }
        _ => false,
    };
    Some(Local {
        joined,
        name: local_name(client, &id).await,
        can_write_pack,
    })
}

/// A room the account has just joined can be in the store before its power levels are, and
/// reading the default then would say the owner cannot write. Waits until they are there.
// shortcut: a polled wait of at most `LEVELS_WAIT`, since a store write that carries no room
// update notifies nothing; replace it with a signal if the SDK gains one.
async fn settled(room: &Room) {
    for _ in 0..LEVELS_POLLS {
        if room.power_levels().await.is_ok() {
            return;
        }
        sleep(LEVELS_POLL).await;
    }
}

/// One row per id in order; a room with no `locals` entry is a null row.
fn pack_rows(ids: &[String], locals: &[Option<Local>], events: &Events) -> Vec<PackRoomDto> {
    ids.iter()
        .enumerate()
        .map(|(i, id)| {
            let local = locals.get(i).and_then(Option::as_ref);
            let pack_events = RoomId::parse(id)
                .ok()
                .and_then(|room| events.get(&room))
                .map(|all| all.iter().map(pack_event).collect())
                .unwrap_or_default();
            PackRoomDto {
                room_id: id.clone(),
                joined: local.is_some_and(|l| l.joined),
                name: local.and_then(|l| l.name.clone()),
                can_write_pack: local.is_some_and(|l| l.can_write_pack),
                pack_events,
            }
        })
        .collect()
}

fn pack_event(event: &Value) -> Value {
    json!({"type": event["type"], "state_key": event["state_key"], "content": event["content"]})
}

/// The store-only rows at once, then each read's rows through `follow_state`. A read that fails
/// still refreshes the store's fields and keeps the last events, so `joined` and `name` stay
/// current.
fn pack_stream<L, LF, E, EF>(
    ids: Vec<String>,
    mut locals: L,
    mut events: E,
    changes: impl Stream<Item = ()> + Unpin,
) -> impl Stream<Item = Vec<PackRoomDto>>
where
    L: FnMut() -> LF,
    LF: Future<Output = Vec<Option<Local>>>,
    E: FnMut() -> EF,
    EF: Future<Output = Result<Events, Error>>,
{
    stream! {
        let first = pack_rows(&ids, &locals().await, &Events::new());
        let kept = Arc::new(Mutex::new(Events::new()));
        let read = move || {
            let (store, server) = (locals(), events());
            let (kept, ids) = (Arc::clone(&kept), ids.clone());
            async move {
                let store = store.await;
                let server = server.await;
                let mut kept = kept.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                match server {
                    Ok(fresh) => *kept = fresh,
                    Err(err) => {
                        tracing::warn!(kind = ?classify(&err).0, "a pack room read failed");
                    }
                }
                Ok(pack_rows(&ids, &store, &kept))
            }
        };
        let mut rows = Box::pin(follow_state(first.clone(), read, changes).skip(1));
        yield first;
        while let Some(rows) = rows.next().await {
            yield rows;
        }
    }
}

fn nulls(types: &[String]) -> Snapshot {
    types.iter().map(|t| (t.clone(), Value::Null)).collect()
}

/// The content of each of `types` in the account's local store.
async fn read_snapshot(client: Client, types: Vec<String>) -> Result<Snapshot, Error> {
    let mut snapshot = Snapshot::new();
    for kind in types {
        // The SDK's raw read is the event's content, not the event.
        let content = (client.account())
            .account_data_raw(GlobalAccountDataEventType::from(kind.as_str()))
            .await?;
        let value = match content {
            Some(content) => content.deserialize_as::<Value>()?,
            None => Value::Null,
        };
        snapshot.insert(kind, value);
    }
    Ok(snapshot)
}

/// A read at once, then after each tick of `changes`, and an item whenever it differs from the
/// last, the first one included. A failed read keeps the last (`empty` if there is none) until
/// the next tick. The stream ends with `changes`.
fn snapshots<F, Fut>(
    empty: Snapshot,
    mut read: F,
    mut changes: impl Stream<Item = ()> + Unpin,
) -> impl Stream<Item = Snapshot>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<Snapshot, Error>>,
{
    stream! {
        let mut last: Option<Snapshot> = None;
        loop {
            let now = match read().await {
                Ok(now) => Some(now),
                Err(err) => {
                    tracing::warn!(kind = ?classify(&err).0, "an account data read failed");
                    last.is_none().then(|| empty.clone())
                }
            };
            if let Some(now) = now.filter(|now| last.as_ref() != Some(now)) {
                last = Some(now.clone());
                yield now;
            }
            if changes.next().await.is_none() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::VecDeque, sync::Mutex};

    use futures_util::stream;
    use matrix_sdk::StoreError;
    use serde_json::json;
    use tempfile::TempDir;
    use tokio::sync::mpsc;

    use super::*;
    use crate::{
        dispatch::dispatch,
        testing::{
            Seen, default_client, engine_in, live, password, requests, scripted, sync, sync_answer,
        },
    };

    const STATE: &str = "/_matrix/client/v3/rooms/!r:b/state";

    /// An account on the SDK's default request config, which retries unless a request says not to.
    async fn account_on(base: &str, root: &TempDir) -> Arc<Engine> {
        let engine = engine_in(root);
        let client = default_client(&engine, &password(base)).await;
        live(&engine, &password(base), client).await;
        engine
    }

    async fn answer_of(engine: &Arc<Engine>, method: &str, args: Vec<Value>) -> Value {
        let mut items = dispatch(engine, method, args).unwrap();
        items.next().await.unwrap().unwrap()
    }

    fn targets(seen: &Seen) -> Vec<String> {
        requests(seen)
            .into_iter()
            .map(|(target, _)| target)
            .collect()
    }

    fn put_state(engine: &Arc<Engine>) -> impl Future<Output = Value> {
        let args = vec![
            json!("@a:b"),
            json!("!r:b"),
            json!("x.y"),
            json!("k"),
            json!({"a": 1}),
        ];
        let engine = Arc::clone(engine);
        async move { answer_of(&engine, "expression.setRoomState", args).await }
    }

    const WRITE: &str = "PUT /_matrix/client/v3/rooms/!r:b/state/*";

    #[tokio::test]
    async fn set_room_state_sends_once() {
        let unavailable = json!({"errcode": "M_UNKNOWN", "error": "x"});
        let answers = vec![
            (WRITE, 502, unavailable),
            (WRITE, 200, json!({"event_id": "$e"})),
        ];
        let (base, seen) = scripted(answers);
        let root = TempDir::new().unwrap();
        let answer = put_state(&account_on(&base, &root).await).await;
        assert_eq!(answer["ok"], json!(false));
        assert_eq!(answer["failure"]["code"], json!("request-failed"));
        assert_eq!(requests(&seen).len(), 1, "the 200 must stay unconsumed");
    }

    #[tokio::test]
    async fn a_set_room_state_that_the_server_takes_is_null() {
        let (base, seen) = scripted(vec![(WRITE, 200, json!({"event_id": "$e"}))]);
        let root = TempDir::new().unwrap();
        let answer = put_state(&account_on(&base, &root).await).await;
        assert_eq!(answer, json!({"ok": true, "value": null}));
        assert_eq!(targets(&seen), [format!("PUT {STATE}/x.y/k")]);
    }

    #[tokio::test]
    async fn a_413_or_too_large_state_is_too_large() {
        for status in [413, 400] {
            let too_large = json!({"errcode": "M_TOO_LARGE", "error": "x"});
            let (base, _) = scripted(vec![(WRITE, status, too_large)]);
            let root = TempDir::new().unwrap();
            let answer = put_state(&account_on(&base, &root).await).await;
            assert_eq!(answer["failure"]["code"], json!("too-large"), "{status}");
        }
    }

    #[tokio::test]
    async fn a_forbidden_write_is_request_failed_with_permission() {
        let refused = json!({"errcode": "M_FORBIDDEN", "error": "x"});
        let (base, _) = scripted(vec![(WRITE, 403, refused)]);
        let root = TempDir::new().unwrap();
        let answer = put_state(&account_on(&base, &root).await).await;
        assert_eq!(answer["failure"]["code"], json!("request-failed"));
        assert_eq!(answer["failure"]["kind"], json!("permission"));
    }

    #[tokio::test]
    async fn an_absent_key_reads_null() {
        let absent = json!({"errcode": "M_NOT_FOUND", "error": "x"});
        let read = "GET /_matrix/client/v3/rooms/!r:b/state/x.y/k";
        let (base, _) = scripted(vec![(read, 404, absent), (read, 200, json!({"a": 1}))]);
        let root = TempDir::new().unwrap();
        let engine = account_on(&base, &root).await;
        let args = || vec![json!("@a:b"), json!("!r:b"), json!("x.y"), json!("k")];
        let none = answer_of(&engine, "expression.fetchRoomState", args()).await;
        assert_eq!(none, json!({"ok": true, "value": null}));
        let some = answer_of(&engine, "expression.fetchRoomState", args()).await;
        assert_eq!(some, json!({"ok": true, "value": {"a": 1}}));
    }

    #[tokio::test]
    async fn account_data_commands_read_and_write_the_server_copy() {
        let url = "/_matrix/client/v3/user/@a:b/account_data/x.y";
        let get: &'static str = format!("GET {url}").leak();
        let put: &'static str = format!("PUT {url}").leak();
        let absent = json!({"errcode": "M_NOT_FOUND", "error": "x"});
        let (base, seen) = scripted(vec![(get, 404, absent), (put, 200, json!({}))]);
        let root = TempDir::new().unwrap();
        let engine = account_on(&base, &root).await;
        let read = vec![json!("@a:b"), json!("x.y")];
        let none = answer_of(&engine, "expression.fetchAccountData", read).await;
        assert_eq!(none, json!({"ok": true, "value": null}));
        let write = vec![json!("@a:b"), json!("x.y"), json!({"__proto__": {"a": 1}})];
        let done = answer_of(&engine, "expression.setAccountData", write).await;
        assert_eq!(done, json!({"ok": true, "value": null}));
        assert_eq!(targets(&seen), [get, put]);
    }

    fn snapshot(a: Value) -> Snapshot {
        Snapshot::from_iter([("t".to_owned(), a)])
    }

    #[tokio::test(start_paused = true)]
    async fn account_data_snapshots_only_on_a_change() {
        let reads = Mutex::new(VecDeque::from([
            Ok(snapshot(json!({"a": 1}))),
            Ok(snapshot(json!({"a": 1}))),
            Ok(snapshot(json!({"a": 2}))),
            Err(Error::from(StoreError::Backend("x".into()))),
            Ok(snapshot(json!({"a": 2}))),
        ]));
        let read = || {
            let next = reads.lock().unwrap().pop_front().unwrap();
            async move { next }
        };
        let (tick, mut ticks) = mpsc::unbounded_channel();
        let changes = stream::poll_fn(move |cx| ticks.poll_recv(cx));
        let mut items = Box::pin(snapshots(snapshot(Value::Null), read, changes));
        assert_eq!(items.next().await, Some(snapshot(json!({"a": 1}))));
        for _ in 0..4 {
            tick.send(()).unwrap();
        }
        assert_eq!(items.next().await, Some(snapshot(json!({"a": 2}))));
        drop(tick);
        assert_eq!(items.next().await, None, "the stream ends with its changes");
        assert!(reads.lock().unwrap().is_empty(), "every tick was read");
    }

    #[tokio::test]
    async fn a_stored_event_reads_as_its_content_and_an_absent_one_as_null() {
        let body = json!({"account_data": {"events": [{"type": "x.y", "content": {"n": 1}}]}});
        let (base, _) = scripted(vec![sync_answer(0, body)]);
        let root = TempDir::new().unwrap();
        let engine = account_on(&base, &root).await;
        let client = engine.account("@a:b").unwrap().client.clone();
        sync(&client).await;
        let types = vec!["x.y".to_owned(), "x.z".to_owned()];
        let read = read_snapshot(client, types).await.unwrap();
        assert_eq!(Value::Object(read), json!({"x.y": {"n": 1}, "x.z": null}));
    }

    #[tokio::test(start_paused = true)]
    async fn a_first_read_that_fails_emits_the_empty_snapshot() {
        let read = || async { Err(Error::from(StoreError::Backend("x".into()))) };
        let (tick, mut ticks) = mpsc::unbounded_channel();
        let changes = stream::poll_fn(move |cx| ticks.poll_recv(cx));
        let mut items = Box::pin(snapshots(snapshot(Value::Null), read, changes));
        assert_eq!(items.next().await, Some(snapshot(Value::Null)));
        tick.send(()).unwrap();
        drop(tick);
        assert_eq!(items.next().await, None, "no second item");
    }

    fn state_of(name: Option<&str>) -> Value {
        let event = |kind: &str, key: &str, content: Value| json!({"type": kind, "state_key": key, "sender": "@o:b", "event_id": "$e", "content": content});
        let mut events = vec![
            event(
                "m.room.image_pack",
                "",
                json!({"pack": {"display_name": "P"}}),
            ),
            event("m.room.topic", "", json!({"topic": "t"})),
            event("im.ponies.room_emotes", "old", json!({"images": {}})),
        ];
        if let Some(name) = name {
            events.push(event("m.room.name", "", json!({"name": name})));
        }
        json!(events)
    }

    fn joined_room() -> Value {
        json!({"rooms": {"join": {"!r:b": {}}}})
    }

    fn packs() -> Value {
        json!([
            {"type": "m.room.image_pack", "state_key": "", "content": {"pack": {"display_name": "P"}}},
            {"type": "im.ponies.room_emotes", "state_key": "old", "content": {"images": {}}},
        ])
    }

    #[tokio::test]
    async fn join_pack_room_skips_a_join_when_joined() {
        let state = format!("GET {STATE}").leak();
        let (base, seen) = scripted(vec![
            sync_answer(0, joined_room()),
            (state, 200, state_of(Some("Pack room"))),
        ]);
        let root = TempDir::new().unwrap();
        let engine = account_on(&base, &root).await;
        sync(&engine.account("@a:b").unwrap().client).await;
        let args = vec![json!("@a:b"), json!("!r:b")];
        let answer = answer_of(&engine, "expression.joinPackRoom", args).await;
        let value = json!({"roomId": "!r:b", "roomName": "Pack room", "events": packs()});
        assert_eq!(answer, json!({"ok": true, "value": value}));
        let seen = targets(&seen);
        assert_eq!(seen.len(), 2, "{seen:?}");
        assert_eq!(seen[1], format!("GET {STATE}"));
    }

    #[tokio::test]
    async fn resolves_an_alias_first() {
        let alias = "GET /_matrix/client/v3/directory/room/*";
        let join = "POST /_matrix/client/v3/join/*";
        let state = format!("GET {STATE}").leak();
        let found = json!({"room_id": "!r:b", "servers": ["a", "b", "c", "d", "e"]});
        let (base, seen) = scripted(vec![
            (alias, 200, found),
            (join, 200, json!({"room_id": "!r:b"})),
            (state, 200, state_of(Some("  "))),
        ]);
        let root = TempDir::new().unwrap();
        let engine = account_on(&base, &root).await;
        let args = vec![json!("@a:b"), json!("#pack:b")];
        let answer = answer_of(&engine, "expression.joinPackRoom", args).await;
        assert_eq!(answer["ok"], json!(true), "{answer}");
        assert_eq!(answer["value"]["roomId"], json!("!r:b"));
        assert_eq!(answer["value"]["events"], packs());
        let seen = targets(&seen);
        assert!(
            seen[0].starts_with("GET /_matrix/client/v3/directory/room/"),
            "{seen:?}"
        );
        let join_target = "POST /_matrix/client/v3/join/!r:b?via=a&via=b&via=c";
        assert_eq!(seen[1], join_target, "the first three servers only");
        assert_eq!(seen[2], format!("GET {STATE}"));
    }

    #[tokio::test]
    async fn a_deep_event_leaves_the_rest_of_the_join_intact() {
        let mut deep = json!(1);
        for _ in 0..200 {
            deep = json!([deep]);
        }
        let mut state = state_of(Some("Pack room"));
        state.as_array_mut().unwrap().push(json!({
            "type": "m.room.image_pack", "state_key": "bad", "sender": "@o:b", "content": deep,
        }));
        let state_url = format!("GET {STATE}").leak();
        let (base, _) = scripted(vec![sync_answer(0, joined_room()), (state_url, 200, state)]);
        let root = TempDir::new().unwrap();
        let engine = account_on(&base, &root).await;
        sync(&engine.account("@a:b").unwrap().client).await;
        let args = vec![json!("@a:b"), json!("!r:b")];
        let answer = answer_of(&engine, "expression.joinPackRoom", args).await;
        assert_eq!(answer["ok"], json!(true), "{answer}");
        assert_eq!(answer["value"]["events"], packs());
    }

    #[test]
    fn a_state_entry_that_is_no_object_is_skipped_without_a_panic() {
        let raw = |text: &str| Raw::<Value>::from_json_string(text.to_owned()).unwrap();
        let events = [
            raw("[5]"),
            raw("5"),
            raw(r#"{"type":"m.room.image_pack","state_key":"y"}"#),
        ];
        let (_, packs) = pack_state(&events);
        let pack = json!({"type": "m.room.image_pack", "state_key": "y", "content": null});
        assert_eq!(packs, [pack]);
    }

    #[tokio::test]
    async fn a_413_on_the_join_is_too_large_as_in_js() {
        let alias = "GET /_matrix/client/v3/directory/room/*";
        let too_large = json!({"errcode": "M_TOO_LARGE", "error": "x"});
        let (base, _) = scripted(vec![(alias, 413, too_large)]);
        let root = TempDir::new().unwrap();
        let engine = account_on(&base, &root).await;
        let args = vec![json!("@a:b"), json!("#pack:b")];
        let answer = answer_of(&engine, "expression.joinPackRoom", args).await;
        assert_eq!(answer["failure"]["code"], json!("too-large"));
    }

    #[tokio::test]
    async fn an_unnamed_room_has_no_name_rather_than_empty_room() {
        let state = format!("GET {STATE}").leak();
        let (base, _) = scripted(vec![
            sync_answer(0, joined_room()),
            (state, 200, state_of(None)),
        ]);
        let root = TempDir::new().unwrap();
        let engine = account_on(&base, &root).await;
        sync(&engine.account("@a:b").unwrap().client).await;
        let args = vec![json!("@a:b"), json!("!r:b")];
        let answer = answer_of(&engine, "expression.joinPackRoom", args).await;
        assert_eq!(answer["value"]["roomName"], json!(null), "{answer}");
    }

    #[test]
    fn a_blank_name_is_none_and_an_unreadable_event_is_skipped() {
        let deep = format!("{}1{}", "[".repeat(200), "]".repeat(200));
        let raw = |text: &str| Raw::<Value>::from_json_string(text.to_owned()).unwrap();
        let events = [
            raw(&format!(
                r#"{{"type":"m.room.image_pack","state_key":"x","content":{deep}}}"#
            )),
            raw(r#"{"type":"m.room.name","state_key":"","content":{"name":"  "}}"#),
            raw(r#"{"type":"m.room.image_pack","state_key":"y","content":{}}"#),
        ];
        let (name, packs) = pack_state(&events);
        assert_eq!(name, None);
        assert_eq!(
            packs,
            [json!({"type": "m.room.image_pack", "state_key": "y", "content": {}})]
        );
    }
}

#[cfg(test)]
mod pack_tests {
    use std::{
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };

    use futures_util::stream;
    use matrix_sdk::{ruma::owned_room_id, timeout::timeout};
    use tokio::sync::mpsc;

    use super::*;

    fn ids(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| (*id).to_owned()).collect()
    }

    fn local(joined: bool, name: Option<&str>, can_write_pack: bool) -> Option<Local> {
        let name = name.map(str::to_owned);
        Some(Local {
            joined,
            name,
            can_write_pack,
        })
    }

    fn pack(state_key: &str) -> Value {
        json!({"type": IMAGE_PACK, "state_key": state_key, "content": {"images": {}},
            "event_id": "$e", "sender": "@a:b"})
    }

    #[test]
    fn rows_keep_the_order_asked() {
        let asked = ids(&["!b:x", "!a:x"]);
        let locals = [local(true, Some("B"), true), local(true, Some("A"), false)];
        let events = Events::from([(owned_room_id!("!a:x"), vec![pack("k")])]);
        let rows = pack_rows(&asked, &locals, &events);
        let order: Vec<_> = rows.iter().map(|r| r.room_id.as_str()).collect();
        assert_eq!(order, ["!b:x", "!a:x"]);
        assert_eq!(rows[0].name.as_deref(), Some("B"));
        assert!(rows[0].pack_events.is_empty());
        assert_eq!(
            rows[1].pack_events,
            [json!({"type": IMAGE_PACK, "state_key": "k", "content": {"images": {}}})],
            "the entry keeps its three fields only"
        );
    }

    #[test]
    fn an_unknown_room_is_a_null_row() {
        let asked = ids(&["!gone:x", "not an id"]);
        let rows = pack_rows(&asked, &[None, None], &Events::new());
        for (row, id) in rows.iter().zip(&asked) {
            let null = PackRoomDto {
                room_id: id.clone(),
                joined: false,
                name: None,
                can_write_pack: false,
                pack_events: vec![],
            };
            assert_eq!(row, &null);
        }
    }

    #[test]
    fn a_left_room_keeps_its_name_and_cannot_write() {
        let asked = ids(&["!r:x"]);
        let rows = pack_rows(&asked, &[local(false, Some("Gone"), false)], &Events::new());
        assert_eq!(rows[0].name.as_deref(), Some("Gone"));
        assert!(!rows[0].joined && !rows[0].can_write_pack);
    }

    #[tokio::test(start_paused = true)]
    async fn an_open_stream_sends_one_request_in_a_burst() {
        let reads = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&reads);
        let events = move || {
            counted.fetch_add(1, Ordering::SeqCst);
            async { Ok(Events::new()) }
        };
        let locals = || async { vec![local(true, None, true)] };
        let (tx, mut rx) = mpsc::unbounded_channel();
        let changes = stream::poll_fn(move |cx| rx.poll_recv(cx));
        let mut rows = Box::pin(pack_stream(ids(&["!r:x"]), locals, events, changes));
        assert!(rows.next().await.is_some(), "the store-only row");
        assert_eq!(
            reads.load(Ordering::SeqCst),
            0,
            "no request before the first item"
        );
        for _ in 0..10 {
            tx.send(()).unwrap();
        }
        assert!(timeout(rows.next(), Duration::from_secs(10)).await.is_err());
        assert!(reads.load(Ordering::SeqCst) <= 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_read_still_refreshes_the_store_fields_and_keeps_the_events() {
        let reads = Arc::new(AtomicUsize::new(0));
        let n = Arc::clone(&reads);
        let room = owned_room_id!("!r:x");
        let events = move || {
            let first = n.fetch_add(1, Ordering::SeqCst) == 0;
            let seen = Events::from([(owned_room_id!("!r:x"), vec![pack("")])]);
            async move {
                if first {
                    Ok(seen)
                } else {
                    Err(Error::UnknownError("x".into()))
                }
            }
        };
        let step = Arc::new(AtomicUsize::new(0));
        let locals = move || {
            let name = if step.fetch_add(1, Ordering::SeqCst) < 2 {
                "Old"
            } else {
                "New"
            };
            let rows = vec![local(true, Some(name), true)];
            async move { rows }
        };
        let (tx, mut rx) = mpsc::unbounded_channel();
        let changes = stream::poll_fn(move |cx| rx.poll_recv(cx));
        let mut rows = Box::pin(pack_stream(ids(&[room.as_str()]), locals, events, changes));
        let first = rows.next().await.unwrap();
        assert!(first[0].pack_events.is_empty());
        let read = rows.next().await.unwrap();
        assert_eq!(read[0].pack_events.len(), 1);
        tx.send(()).unwrap();
        let after = rows.next().await.unwrap();
        assert_eq!(after[0].name.as_deref(), Some("New"));
        assert_eq!(after[0].pack_events.len(), 1, "the last events stand");
    }
}
