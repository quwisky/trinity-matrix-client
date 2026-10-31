//! `typing` and `directMap`: who is typing in each joined room, and the raw `m.direct` map.

use std::sync::Arc;

use futures_util::StreamExt;
use matrix_sdk::{
    Client, Room, RoomState,
    event_handler::EventHandlerDropGuard,
    executor::{AbortOnDrop, spawn},
    ruma::{RoomId, events::typing::SyncTypingEvent},
};
use matrix_sdk_base::RoomInfoNotableUpdate;
use serde_json::Value;
use tokio::sync::{
    broadcast::{self, error::RecvError},
    watch,
};

use super::{DirectMapDto, TypingMapDto, TypingMemberDto, settle::account_data_changes};
use crate::{accounts::Engine, dispatch::Stream, engines::member::account_stream};

/// Who is typing in each joined room, from the account's start: a typing EDU is not stored or
/// repeated, so a stream that opens later could not rebuild it. It lives and dies with the runtime.
#[derive(Debug)]
pub(crate) struct Typing {
    map: watch::Sender<TypingMapDto>,
    _handler: EventHandlerDropGuard,
    _prune: AbortOnDrop<()>,
}

impl Typing {
    /// Adds a client handler for `SyncTypingEvent` with a `Room` context, and a prune task on
    /// notable updates.
    pub(crate) fn start(client: &Client) -> Typing {
        let map = watch::Sender::default();
        let handler = client.add_event_handler({
            let map = map.clone();
            move |event: SyncTypingEvent, room: Room| {
                let map = map.clone();
                async move {
                    let mut members = Vec::new();
                    for user_id in &event.content.user_ids {
                        let known = room.get_member_no_sync(user_id).await.ok().flatten();
                        let named = known.as_ref().and_then(|member| {
                            Some((member.display_name()?, member.name_ambiguous()))
                        });
                        members.push(TypingMemberDto {
                            user_id: user_id.to_string(),
                            display_name: member_name(user_id.as_str(), named),
                        });
                    }
                    map.send_if_modified(|map| set_typing(map, room.room_id().as_str(), members));
                }
            }
        });
        let updates = client.room_info_notable_update_receiver();
        let prune = spawn(prune_left_rooms(client.clone(), updates, map.clone()));
        Typing {
            map,
            _handler: client.event_handler_drop_guard(handler),
            _prune: AbortOnDrop::new(prune),
        }
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<TypingMapDto> {
        self.map.subscribe()
    }
}

/// js `RoomMember.name`: the display name, followed by the user id when another member shares it;
/// the user id when there is no display name, or it is empty or the user id.
// shortcut: hidden and direction-override characters stay, which js strips; upgrade when a typing
// name shows them.
fn member_name(user_id: &str, named: Option<(&str, bool)>) -> String {
    match named {
        Some((name, ambiguous)) if !name.is_empty() && name != user_id => {
            if ambiguous {
                format!("{name} ({user_id})")
            } else {
                name.to_owned()
            }
        }
        _ => user_id.to_owned(),
    }
}

/// The room's whole set replaces its entry; an empty set removes it. False when nothing changed.
pub(crate) fn set_typing(
    map: &mut TypingMapDto,
    room_id: &str,
    members: Vec<TypingMemberDto>,
) -> bool {
    if members.is_empty() {
        return map.0.remove(room_id).is_some();
    }
    if map.0.get(room_id) == Some(&members) {
        return false;
    }
    map.0.insert(room_id.to_owned(), members);
    true
}

/// A room we have left stops syncing, so it never reports that its typists stopped: drop its
/// entry once a notable update finds it not joined. A lag checks every room.
async fn prune_left_rooms(
    client: Client,
    mut updates: broadcast::Receiver<RoomInfoNotableUpdate>,
    map: watch::Sender<TypingMapDto>,
) {
    loop {
        let changed = match updates.recv().await {
            Ok(update) => Some(update.room_id),
            Err(RecvError::Lagged(_)) => None,
            Err(RecvError::Closed) => return,
        };
        map.send_if_modified(|map| {
            let before = map.0.len();
            map.0.retain(|id, _| {
                let checked = changed.as_deref().is_none_or(|room| room.as_str() == id);
                !checked || is_joined(&client, id)
            });
            map.0.len() != before
        });
    }
}

fn is_joined(client: &Client, room_id: &str) -> bool {
    let room = <&RoomId>::try_from(room_id)
        .ok()
        .and_then(|id| client.get_room(id));
    room.is_some_and(|room| room.state() == RoomState::Joined)
}

/// The raw `m.direct` content, keeping string entries of array values only: a left room stays and
/// a malformed entry does not fail the map.
pub(crate) fn direct_map_of(content: Option<&Value>) -> DirectMapDto {
    let entries = content.and_then(Value::as_object).into_iter().flatten();
    DirectMapDto(
        entries
            .filter_map(|(user_id, rooms)| {
                let rooms = rooms.as_array()?.iter().filter_map(Value::as_str);
                Some((user_id.clone(), rooms.map(str::to_owned).collect()))
            })
            .collect(),
    )
}

/// `RoomListEngine.typing`: the current map, then each change. Not live: `{}`.
pub fn typing(engine: Arc<Engine>, account_id: String) -> Stream {
    account_stream(engine, account_id, TypingMapDto::default(), |rt, _| {
        let mut map = rt.typing.subscribe();
        async_stream::stream! {
            loop {
                let current = map.borrow_and_update().clone();
                yield current;
                if map.changed().await.is_err() {
                    return;
                }
            }
        }
    })
}

/// `RoomListEngine.directMap`: the raw `m.direct` map, then each change that differs. Not live:
/// `{}`.
pub fn direct_map(engine: Arc<Engine>, account_id: String) -> Stream {
    account_stream(engine, account_id, DirectMapDto::default(), |_, client| {
        let mut changes = account_data_changes(&client, "m.direct");
        async_stream::stream! {
            let mut last = None;
            loop {
                let read = direct_map_in(&client).await;
                if let Err(err) = &read {
                    tracing::warn!("reading m.direct failed: {err}");
                }
                // A failed first read still gives the consumer a first map.
                let map = read.ok().or_else(|| last.is_none().then(DirectMapDto::default));
                if let Some(map) = map.filter(|map| last.as_ref() != Some(map)) {
                    last = Some(map.clone());
                    yield map;
                }
                if changes.next().await.is_none() {
                    return;
                }
            }
        }
    })
}

async fn direct_map_in(client: &Client) -> Result<DirectMapDto, matrix_sdk::Error> {
    let content = client.account().account_data_raw("m.direct".into()).await?;
    let content = content
        .map(|raw| raw.deserialize_as::<Value>())
        .transpose()?;
    Ok(direct_map_of(content.as_ref()))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use futures_util::FutureExt;
    use matrix_sdk::timeout::timeout;
    use serde_json::json;
    use tempfile::TempDir;

    use super::*;
    use crate::{
        config::EngineConfig,
        testing::{builder_on, engine_in, live, password, sync, syncing},
    };

    /// The next item within 5 s.
    async fn next(items: &mut Stream) -> Value {
        let item = timeout(items.next(), Duration::from_secs(5)).await;
        item.expect("an item within 5 s").expect("an item").unwrap()
    }

    /// A sync in which `typists` type in `room`, `@bo:b` has the name Bo and `@cy:b` an empty one.
    fn typing_in(room: &str, typists: &[&str]) -> Value {
        let member = |user: &str, name: &str| {
            json!({
                "type": "m.room.member", "state_key": user, "sender": user,
                "event_id": format!("$m{}", &user[1..3]), "origin_server_ts": 1,
                "content": {"membership": "join", "displayname": name},
            })
        };
        let typing = json!({"type": "m.typing", "content": {"user_ids": typists}});
        let events = [member("@bo:b", "Bo"), member("@cy:b", "")];
        let joined = json!({"timeline": {"events": events}, "ephemeral": {"events": [typing]}});
        json!({"rooms": {"join": {room: joined}}})
    }

    /// A sync with the account data `m.direct` to `@bo:b` in `rooms`, then an event of no interest.
    fn direct_to_bo(rooms: &[&str]) -> Value {
        let direct = json!({"type": "m.direct", "content": {"@bo:b": rooms}});
        let other = json!({"type": "org.example.other", "content": {}});
        json!({"account_data": {"events": [direct, other]}})
    }

    fn member(user_id: &str, display_name: &str) -> TypingMemberDto {
        TypingMemberDto {
            user_id: user_id.into(),
            display_name: display_name.into(),
        }
    }

    #[test]
    fn set_typing_replaces_a_rooms_set_and_drops_it_when_empty() {
        let mut map = TypingMapDto::default();
        let ann = vec![member("@ann:b", "Ann")];
        assert!(set_typing(&mut map, "!r:b", ann.clone()));
        assert!(!set_typing(&mut map, "!r:b", ann), "the same set");
        let both = vec![member("@ann:b", "Ann"), member("@bo:b", "@bo:b")];
        assert!(set_typing(&mut map, "!r:b", both.clone()), "the whole set");
        assert!(set_typing(&mut map, "!s:b", vec![member("@cy:b", "Cy")]));
        assert_eq!(map.0["!r:b"], both);
        assert!(set_typing(&mut map, "!r:b", vec![]));
        assert!(!set_typing(&mut map, "!r:b", vec![]), "already gone");
        assert_eq!(map.0.keys().collect::<Vec<_>>(), ["!s:b"]);
    }

    #[test]
    fn member_name_matches_js() {
        assert_eq!(member_name("@bo:b", Some(("Bo", false))), "Bo");
        assert_eq!(member_name("@bo:b", Some(("Bo", true))), "Bo (@bo:b)");
        assert_eq!(member_name("@bo:b", Some(("", false))), "@bo:b");
        assert_eq!(member_name("@bo:b", Some(("", true))), "@bo:b");
        assert_eq!(member_name("@bo:b", Some(("@bo:b", true))), "@bo:b");
        assert_eq!(member_name("@bo:b", None), "@bo:b");
    }

    #[test]
    fn direct_map_keeps_only_string_entries() {
        let content = json!({"@a:b": ["!1", 3, "!2"], "@c:d": "bad", "@e:f": []});
        let kept = direct_map_of(Some(&content));
        let expected = json!({"@a:b": ["!1", "!2"], "@e:f": []});
        assert_eq!(serde_json::to_value(kept).unwrap(), expected);
        let empty = serde_json::to_value(direct_map_of(None)).unwrap();
        assert_eq!(empty, json!({}));
        let not_an_object = json!(["!1"]);
        assert_eq!(direct_map_of(Some(&not_an_object)), DirectMapDto::default());
    }

    #[tokio::test]
    async fn typing_and_direct_map_on_an_account_that_is_not_live_emit_empty_then_nothing() {
        let engine = Engine::new(EngineConfig::default()).unwrap();
        for mut items in [
            typing(Arc::clone(&engine), "@x:y".into()),
            direct_map(Arc::clone(&engine), "@x:y".into()),
        ] {
            assert_eq!(items.next().await, Some(Ok(json!({}))));
            assert!(
                items.next().now_or_never().is_none(),
                "the stream stays open"
            );
        }
    }

    #[tokio::test]
    async fn the_typing_handler_and_prune_task_die_with_the_runtime() {
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let client = builder_on("http://127.0.0.1:1").build().await.unwrap();
        let rt = live(&engine, &password("http://127.0.0.1:1"), client).await;
        let mut map = rt.typing.subscribe();
        drop(rt);
        let removed = timeout(engine.remove("@a:b"), Duration::from_secs(5)).await;
        assert!(removed.is_ok(), "the teardown waited for the typing map");
        let closed = timeout(map.changed(), Duration::from_secs(5)).await;
        assert!(
            matches!(closed, Ok(Err(_))),
            "a sender outlived the runtime"
        );
    }

    #[tokio::test]
    async fn typing_follows_the_sync_names_its_typists_and_drops_a_left_room() {
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let left = json!({"rooms": {"leave": {"!r:b": {}}}});
        let syncs = vec![
            typing_in("!r:b", &["@a:b", "@bo:b", "@cy:b"]),
            typing_in("!r:b", &[]),
            typing_in("!r:b", &["@bo:b"]),
            left,
        ];
        let rt = syncing(&engine, syncs).await;
        let mut items = typing(Arc::clone(&engine), "@a:b".into());
        assert_eq!(next(&mut items).await, json!({}));
        sync(&rt.client).await;
        let typists = json!([
            {"userId": "@a:b", "displayName": "@a:b"},
            {"userId": "@bo:b", "displayName": "Bo"},
            {"userId": "@cy:b", "displayName": "@cy:b"},
        ]);
        assert_eq!(next(&mut items).await, json!({"!r:b": typists}));
        sync(&rt.client).await;
        assert_eq!(next(&mut items).await, json!({}), "an empty set");
        sync(&rt.client).await;
        let bo = json!([{"userId": "@bo:b", "displayName": "Bo"}]);
        assert_eq!(next(&mut items).await, json!({"!r:b": bo}));
        sync(&rt.client).await;
        assert_eq!(next(&mut items).await, json!({}), "a left room");
    }

    #[tokio::test]
    async fn direct_map_follows_account_data_and_skips_repeats() {
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let syncs = vec![
            direct_to_bo(&["!r:b"]),
            direct_to_bo(&["!r:b"]),
            direct_to_bo(&["!r:b", "!s:b"]),
        ];
        let rt = syncing(&engine, syncs).await;
        let mut items = direct_map(Arc::clone(&engine), "@a:b".into());
        assert_eq!(next(&mut items).await, json!({}));
        sync(&rt.client).await;
        assert_eq!(next(&mut items).await, json!({"@bo:b": ["!r:b"]}));
        sync(&rt.client).await;
        let repeat = timeout(items.next(), Duration::from_millis(50)).await;
        assert!(repeat.is_err(), "the same map again");
        sync(&rt.client).await;
        assert_eq!(next(&mut items).await, json!({"@bo:b": ["!r:b", "!s:b"]}));
    }
}
