//! `TimelineEngine`'s reads, and its receipt and typing notices: each request goes once, under the
//! account's rule, because the SDK's wrappers for them retry for up to 15 minutes.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

use matrix_sdk::{
    Error, Room,
    deserialized_responses::TimelineEvent,
    event_cache::RoomEventCache,
    ruma::{
        EventId, MilliSecondsSinceUnixEpoch, OwnedEventId, RoomId, UInt,
        api::{
            Direction,
            client::{
                read_marker::set_read_marker,
                receipt::create_receipt,
                room::get_event_by_timestamp,
                typing::create_typing_event::{
                    self,
                    v3::{Typing, TypingInfo},
                },
            },
            error::ErrorKind,
        },
        events::{receipt::ReceiptThread, relation::RelationType},
    },
    serde_helpers::{extract_relation, extract_thread_root},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    Focus,
    dto::{ProfileDto, ReactionDetailGroupDto},
    hub::Hub,
    on_room,
    paging::{hub_of, page},
    rows::profile_of,
};
use crate::{
    accounts::{AccountRuntime, Engine},
    dispatch::{Stream, detached, reply},
    engines::{
        identity::is_not_found,
        member::{on_account, sent_once},
    },
    failure::{
        EngineFailure, EngineResult, FailureCode, account_not_live, local_failure, request_failed,
    },
};

/// js `SCROLLBACK`.
const PAGE_SIZE: u16 = 30;
/// js `TYPING_TIMEOUT_MS`.
const TYPING_TIMEOUT: Duration = Duration::from_secs(8);
/// How far a receipt follows relations to find its thread: a chain longer than a reaction on an
/// edit of a reply is no client's.
const RELATION_HOPS: usize = 4;

fn unavailable<T>() -> EngineResult<T> {
    EngineResult::Err(local_failure(FailureCode::MessageUnavailable))
}

/// `{ found }`.
#[derive(Debug, Serialize)]
struct FoundDto {
    found: bool,
}

pub fn paginate_until(
    engine: Arc<Engine>,
    account_id: String,
    room_id: String,
    event_id: String,
    max_pages: u32,
) -> Stream {
    reply(on_room(
        engine,
        account_id,
        room_id,
        move |engine, rt, room| async move {
            let Ok(event_id) = EventId::parse(&event_id) else {
                return Ok(EngineResult::Ok(FoundDto { found: false }));
            };
            let hub = hub_of(&engine, &rt, &room, &Focus::Live).await?;
            let mut pages_left = max_pages;
            let mut at_start = *hub.state.borrow() == super::BackPagination::StartReached;
            loop {
                let found = reached(&room, &hub, &event_id).await?;
                if found || at_start || pages_left == 0 {
                    return Ok(EngineResult::Ok(FoundDto { found }));
                }
                pages_left -= 1;
                at_start = match page(&engine, &rt, &room, &hub, &Focus::Live, PAGE_SIZE).await? {
                    Some(at_start) => at_start,
                    None => return Ok(EngineResult::Err(account_not_live())),
                };
            }
        },
    ))
}

/// Whether a stream shows the event, or it is one no row can show. The SDK's whole list and the
/// event cache hold events a stream's window does not reveal until a page: those aren't found yet.
async fn reached(room: &Room, hub: &Hub, event_id: &EventId) -> Result<bool, Error> {
    let holds =
        |items: &matrix_sdk_ui::eyeball_im::Vector<Arc<matrix_sdk_ui::timeline::TimelineItem>>| {
            (items.iter())
                .any(|item| item.as_event().and_then(|event| event.event_id()) == Some(event_id))
        };
    if holds(&hub.timeline.subscribe().await.0) {
        return Ok(true);
    }
    if holds(&hub.timeline.items().await) {
        return Ok(false);
    }
    let (cache, _handles) = room.event_cache().await?;
    let found = cache
        .rfind_map_event_in_memory_by(|event| (event.event_id() == Some(event_id)).then_some(()));
    Ok(found.await?.is_some())
}

/// `{ eventId }`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EventAtDto {
    event_id: String,
}

/// js `eventAt`: a server that never heard of MSC3030 answers `M_UNRECOGNIZED`.
fn event_at_failed(err: &Error) -> EngineFailure {
    let failure = request_failed(err);
    if err.client_api_error_kind() == Some(&ErrorKind::Unrecognized) {
        return EngineFailure {
            code: FailureCode::Unsupported,
            ..failure
        };
    }
    failure
}

/// A JS number as whole milliseconds. Out of range it asks for the room's first or last event.
#[expect(
    clippy::as_conversions,
    reason = "`as` saturates, and no `From` takes an `f64`"
)]
fn whole_ms(timestamp: f64) -> u64 {
    timestamp as u64
}

pub fn event_at(
    engine: Arc<Engine>,
    account_id: String,
    room_id: String,
    timestamp: f64,
) -> Stream {
    reply(on_account(
        engine,
        account_id,
        event_at_failed,
        move |engine, rt| async move {
            let room_id = RoomId::parse(&room_id)?;
            let at = MilliSecondsSinceUnixEpoch(UInt::new_saturating(whole_ms(timestamp)));
            let request = get_event_by_timestamp::v1::Request::new(room_id, at, Direction::Forward);
            let sent = rt.client.send(request).with_request_config(sent_once());
            match engine.ruled(&rt, sent).await {
                Ok(response) => Ok(Some(EventAtDto {
                    event_id: response.event_id.to_string(),
                })),
                // The endpoint saying the room has no such event.
                Err(err) if err.client_api_error_kind() == Some(&ErrorKind::NotFound) => Ok(None),
                Err(err) => Err(err),
            }
        },
    ))
}

pub fn event_source(
    engine: Arc<Engine>,
    account_id: String,
    room_id: String,
    event_id: String,
) -> Stream {
    reply(on_room(
        engine,
        account_id,
        room_id,
        move |engine, rt, room| async move {
            let Ok(event_id) = EventId::parse(&event_id) else {
                return Ok(unavailable());
            };
            let load = room.load_or_fetch_event(&event_id, Some(sent_once()));
            let event = match engine.ruled(&rt, load).await {
                Ok(event) => event,
                Err(err) if is_not_found(&err) => return Ok(unavailable()),
                Err(err) => return Err(err),
            };
            let Ok(mut source) = event
                .raw()
                .deserialize_as::<serde_json::Map<String, Value>>()
            else {
                return Ok(unavailable());
            };
            // A synced event has none (H15).
            (source.entry("room_id")).or_insert_with(|| room.room_id().as_str().into());
            Ok(EngineResult::Ok(source))
        },
    ))
}

/// A reaction's key, sender and time.
type Reaction = (String, String, u64);

fn reaction_of(event: &TimelineEvent) -> Option<Reaction> {
    let event: Value = event.raw().deserialize_as().ok()?;
    if event["type"] != "m.reaction" || !event["unsigned"]["redacted_because"].is_null() {
        return None;
    }
    Some((
        event["content"]["m.relates_to"]["key"].as_str()?.to_owned(),
        event["sender"].as_str()?.to_owned(),
        event["origin_server_ts"].as_u64().unwrap_or(0),
    ))
}

/// What an open timeline shows on the event, which holds a reaction still being sent; else what
/// the event cache holds. `None`: the event is not loaded.
async fn reactions_on(
    rt: &AccountRuntime,
    room: &Room,
    event_id: &EventId,
) -> Result<Option<Vec<Reaction>>, Error> {
    for hub in rt.hubs.of(room.room_id()) {
        if let Some(item) = hub.timeline.item_by_event_id(event_id).await {
            let Some(keys) = item.content().reactions() else {
                return Ok(Some(Vec::new()));
            };
            return Ok(Some(
                (keys.iter())
                    .flat_map(|(key, senders)| {
                        senders.iter().map(|(sender, info)| {
                            let at = u64::from(info.timestamp.0);
                            (key.clone(), sender.to_string(), at)
                        })
                    })
                    .collect(),
            ));
        }
    }
    let (cache, _handles) = room.event_cache().await?;
    let annotations = Some(vec![RelationType::Annotation]);
    let found = cache
        .find_event_with_relations(event_id, annotations)
        .await?;
    Ok(found.map(|(_, related)| related.iter().filter_map(reaction_of).collect()))
}

/// js `reactionEventsFor`: one per sender on a key, earliest first, the keys with the most senders
/// first and then the earliest.
fn grouped(reactions: Vec<Reaction>) -> Vec<(String, Vec<String>)> {
    let mut keys: BTreeMap<String, Vec<(u64, String)>> = BTreeMap::new();
    for (key, sender, at) in reactions {
        if !key.is_empty() {
            keys.entry(key).or_default().push((at, sender));
        }
    }
    let mut groups: Vec<_> = (keys.into_iter())
        .map(|(key, mut senders)| {
            senders.sort();
            let mut seen = HashSet::new();
            senders.retain(|(_, sender)| seen.insert(sender.clone()));
            let first = senders.iter().map(|(at, _)| *at).min();
            let senders: Vec<_> = senders.into_iter().map(|(_, sender)| sender).collect();
            (first, key, senders)
        })
        .collect();
    groups.sort_by(|(a_first, _, a), (b_first, _, b)| {
        b.len().cmp(&a.len()).then(a_first.cmp(b_first))
    });
    (groups.into_iter())
        .map(|(_, key, senders)| (key, senders))
        .collect()
}

pub fn reaction_details(
    engine: Arc<Engine>,
    account_id: String,
    room_id: String,
    event_id: String,
) -> Stream {
    reply(on_room(
        engine,
        account_id,
        room_id,
        move |_, rt, room| async move {
            let Ok(event_id) = EventId::parse(&event_id) else {
                return Ok(unavailable());
            };
            let Some(reactions) = reactions_on(&rt, &room, &event_id).await? else {
                return Ok(unavailable());
            };
            let mut known: HashMap<String, Option<ProfileDto>> = HashMap::new();
            let mut details = Vec::new();
            for (key, senders) in grouped(reactions) {
                let mut profiles = BTreeMap::new();
                for sender in &senders {
                    if !known.contains_key(sender) {
                        known.insert(sender.clone(), profile_of(&room, sender).await);
                    }
                    if let Some(profile) = known[sender].clone() {
                        profiles.insert(sender.clone(), profile);
                    }
                }
                details.push(ReactionDetailGroupDto {
                    key,
                    senders,
                    profiles,
                });
            }
            Ok(EngineResult::Ok(details))
        },
    ))
}

/// `visibility` of `sendReceipt`.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReceiptVisibilityDto {
    Public,
    Private,
}

/// `options` of `sendReceipt`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptOptionsDto {
    thread_root_id: Option<String>,
    visibility: ReceiptVisibilityDto,
    fully_read: bool,
}

/// js `threadIdForReceipt`: the event's thread, through a relation to one of its replies, or the
/// main timeline. The server refuses a main receipt on a reaction to a thread reply.
async fn receipt_thread(cache: &RoomEventCache, event: &TimelineEvent) -> ReceiptThread {
    let mut event = event.clone();
    for _ in 0..RELATION_HOPS {
        if let Some(root) = extract_thread_root(event.raw()) {
            return ReceiptThread::Thread(root);
        }
        let Some((_, target)) = extract_relation(event.raw()) else {
            break;
        };
        let Ok(Some(related)) = cache.find_event(&target).await else {
            break;
        };
        event = related;
    }
    ReceiptThread::Main
}

async fn receipt_request(
    room: &Room,
    event_id: &str,
    visibility: ReceiptVisibilityDto,
) -> Result<Option<(OwnedEventId, create_receipt::v3::Request)>, Error> {
    let Ok(event_id) = EventId::parse(event_id) else {
        return Ok(None);
    };
    let (cache, _handles) = room.event_cache().await?;
    let Some(event) = cache.find_event(&event_id).await? else {
        return Ok(None);
    };
    let kind = match visibility {
        ReceiptVisibilityDto::Public => create_receipt::v3::ReceiptType::Read,
        ReceiptVisibilityDto::Private => create_receipt::v3::ReceiptType::ReadPrivate,
    };
    let mut request =
        create_receipt::v3::Request::new(room.room_id().to_owned(), kind, event_id.clone());
    request.thread = receipt_thread(&cache, &event).await;
    Ok(Some((event_id, request)))
}

pub fn send_receipt(
    engine: Arc<Engine>,
    account_id: String,
    room_id: String,
    event_id: String,
    options: ReceiptOptionsDto,
) -> Stream {
    detached(on_room(
        engine,
        account_id,
        room_id,
        move |engine, rt, room| async move {
            let Some((event_id, receipt)) =
                receipt_request(&room, &event_id, options.visibility).await?
            else {
                return Ok(unavailable());
            };
            let sent = rt.client.send(receipt).with_request_config(sent_once());
            let receipt = engine.ruled(&rt, sent).await.map(drop);
            // Whatever the receipt's answer, as js sends them apart: a server without private
            // receipts must not keep the marker from moving. A thread has no marker of its own.
            if options.fully_read && options.thread_root_id.is_none() {
                let mut marker = set_read_marker::v3::Request::new(room.room_id().to_owned());
                marker.fully_read = Some(event_id);
                let sent = rt.client.send(marker).with_request_config(sent_once());
                engine.ruled(&rt, sent).await?;
            }
            receipt?;
            Ok(EngineResult::Ok(()))
        },
    ))
}

pub fn set_typing(
    engine: Arc<Engine>,
    account_id: String,
    room_id: String,
    typing: bool,
) -> Stream {
    detached(on_account(
        engine,
        account_id,
        request_failed,
        move |engine, rt| async move {
            let room_id = RoomId::parse(&room_id)?;
            let me = rt.client.user_id().ok_or(Error::AuthenticationRequired)?;
            let state = if typing {
                Typing::Yes(TypingInfo::new(TYPING_TIMEOUT))
            } else {
                Typing::No
            };
            let request = create_typing_event::v3::Request::new(me.to_owned(), room_id, state);
            let sent = rt.client.send(request).with_request_config(sent_once());
            engine.ruled(&rt, sent).await?;
            Ok(())
        },
    ))
}

/// A hint for js-sdk's trimming: this engine's event cache keeps its own.
pub fn set_retention(
    _engine: Arc<Engine>,
    _account_id: String,
    _room_id: String,
    _hint: Value,
) -> Stream {
    reply(async { Value::Null })
}

#[cfg(test)]
mod tests {
    use futures_util::StreamExt;
    use matrix_sdk::{ruma::room_id, sleep::sleep, timeout::timeout};
    use serde_json::json;
    use tempfile::TempDir;
    use tokio::sync::mpsc;

    use super::*;
    use crate::{
        dispatch::dispatch,
        engines::timeline::rows::tests::hostile,
        testing::{
            Seen, default_client, engine_in, live, password, requests, scripted, sync, sync_answer,
        },
    };

    const ME: &str = "@a:b";
    const ROOM: &str = "!r:b";
    const ROOMS_GET: &str = "GET /_matrix/client/v3/rooms/*";
    const TIMESTAMP: &str = "GET /_matrix/client/v1/rooms/*";
    const ROOMS_POST: &str = "POST /_matrix/client/v3/rooms/*";
    const ROOMS_PUT: &str = "PUT /_matrix/client/v3/rooms/*";

    fn unavailable_body() -> Value {
        json!({"errcode": "M_UNKNOWN", "error": "x"})
    }

    fn event(event_type: &str, id: &str, sender: &str, ts: u64, content: Value) -> Value {
        json!({"type": event_type, "event_id": id, "sender": sender, "origin_server_ts": ts,
            "content": content})
    }

    fn message(id: &str) -> Value {
        event(
            "m.room.message",
            id,
            "@b:b",
            1,
            json!({"msgtype": "m.text", "body": "hi"}),
        )
    }

    fn reaction(id: &str, sender: &str, ts: u64, target: &str, key: &str) -> Value {
        let on = json!({"rel_type": "m.annotation", "event_id": target, "key": key});
        event("m.reaction", id, sender, ts, json!({"m.relates_to": on}))
    }

    /// `ROOM`, with `events` and a known encryption state.
    fn joined(events: Vec<Value>, gap: bool) -> Value {
        let mut timeline = json!({"events": events});
        if gap {
            timeline["limited"] = json!(true);
            timeline["prev_batch"] = json!("p0");
        }
        json!({"rooms": {"join": {ROOM: {
            "timeline": timeline,
            "state_after": {"events": [{
                "type": "m.room.encryption", "state_key": "", "event_id": "$e", "sender": "@b:b",
                "origin_server_ts": 1, "content": {"algorithm": "m.megolm.v1.aes-sha2"},
            }]},
        }}}})
    }

    struct Account {
        _root: TempDir,
        engine: Arc<Engine>,
        rt: Arc<AccountRuntime>,
        seen: Seen,
    }

    impl Account {
        /// `@a:b` on the SDK's default (retrying) config, past one sync of `joined`, which is in
        /// the event cache up to its last event. `answers` come after that sync.
        async fn on(joined: Value, answers: Vec<(&'static str, u16, Value)>) -> Self {
            let root = TempDir::new().unwrap();
            let engine = engine_in(&root);
            let last = joined["rooms"]["join"][ROOM]["timeline"]["events"]
                .as_array()
                .and_then(|events| events.last())
                .map(|event| event["event_id"].as_str().unwrap().to_owned());
            let (base, seen) = scripted([vec![sync_answer(0, joined)], answers].concat());
            let account = password(&base);
            let client = default_client(&engine, &account).await;
            let rt = live(&engine, &account, client).await;
            sync(&rt.client).await;
            if let Some(last) = last {
                let room = rt.client.get_room(room_id!("!r:b")).unwrap();
                let (cache, _handles) = room.event_cache().await.unwrap();
                let id = EventId::parse(last).unwrap();
                let cached = async {
                    while cache.find_event(&id).await.unwrap().is_none() {
                        sleep(Duration::from_millis(5)).await;
                    }
                };
                timeout(cached, Duration::from_secs(5)).await.unwrap();
            }
            let seen_from = requests(&seen).len();
            seen.lock().unwrap().drain(..seen_from);
            Self {
                _root: root,
                engine,
                rt,
                seen,
            }
        }

        async fn plain(events: Vec<Value>) -> Self {
            Self::on(joined(events, false), vec![]).await
        }

        async fn reply(&self, member: &str, args: Vec<Value>) -> Value {
            let member = format!("timeline.{member}");
            let mut replies = dispatch(&self.engine, &member, args).unwrap();
            let reply = timeout(replies.next(), Duration::from_secs(10)).await;
            reply.expect("a reply in time").unwrap().expect("no fault")
        }

        /// The method and path of each request since the sync.
        fn sent(&self) -> Vec<String> {
            let requests = requests(&self.seen);
            requests.into_iter().map(|(target, _)| target).collect()
        }
    }

    fn args(rest: &[Value]) -> Vec<Value> {
        [vec![json!(ME), json!(ROOM)], rest.to_vec()].concat()
    }

    fn receipt_options(visibility: &str, fully_read: bool) -> Value {
        json!({"threadRootId": null, "visibility": visibility, "fullyRead": fully_read})
    }

    #[tokio::test]
    async fn event_at_sends_once() {
        let answers = vec![
            (TIMESTAMP, 502, unavailable_body()),
            (
                TIMESTAMP,
                200,
                json!({"event_id": "$x", "origin_server_ts": 1}),
            ),
        ];
        let account = Account::on(joined(vec![], false), answers).await;
        let reply = account.reply("eventAt", args(&[json!(5)])).await;
        assert_eq!(reply["failure"]["code"], "request-failed", "{reply}");
        assert_eq!(account.sent().len(), 1);
    }

    #[tokio::test]
    async fn event_at_maps_unrecognized_to_unsupported_and_not_found_to_null() {
        let table = [
            (
                404,
                json!({"errcode": "M_UNRECOGNIZED", "error": "x"}),
                json!({"ok": false}),
            ),
            (
                400,
                json!({"errcode": "M_UNRECOGNIZED", "error": "x"}),
                json!({"ok": false}),
            ),
            (
                404,
                json!({"errcode": "M_NOT_FOUND", "error": "x"}),
                json!({"ok": true, "value": null}),
            ),
            (
                200,
                json!({"event_id": "$x", "origin_server_ts": 1}),
                json!({"ok": true, "value": {"eventId": "$x"}}),
            ),
        ];
        for (status, body, expected) in table {
            let answers = vec![(TIMESTAMP, status, body.clone())];
            let account = Account::on(joined(vec![], false), answers).await;
            let reply = account.reply("eventAt", args(&[json!(1.5e12)])).await;
            if expected["ok"] == false {
                assert_eq!(reply["failure"]["code"], "unsupported", "{body}: {reply}");
            } else {
                assert_eq!(reply, expected, "{body}");
            }
        }
    }

    #[tokio::test]
    async fn send_receipt_sends_once_per_kind() {
        let ok = || (ROOMS_POST, 200, json!({}));
        let failed = || (ROOMS_POST, 502, unavailable_body());
        let events = vec![message("$m")];
        let path = |kind: &str| format!("/receipt/{kind}/");
        let table = [
            (receipt_options("public", false), vec![path("m.read")]),
            (
                receipt_options("private", false),
                vec![path("m.read.private")],
            ),
            (
                receipt_options("public", true),
                vec![path("m.read"), "/read_markers".to_owned()],
            ),
        ];
        for (options, parts) in table {
            let answers = vec![failed(), ok(), ok()];
            let account = Account::on(joined(events.clone(), false), answers).await;
            let reply = account
                .reply("sendReceipt", args(&[json!("$m"), options.clone()]))
                .await;
            assert_eq!(reply["failure"]["code"], "request-failed", "{options}");
            let sent = account.sent();
            assert_eq!(sent.len(), parts.len(), "{options}: {sent:?}");
            for (sent, part) in sent.iter().zip(&parts) {
                assert!(sent.contains(part), "{sent}, {part}");
            }
        }

        let answers = vec![ok(), failed(), ok()];
        let account = Account::on(joined(events.clone(), false), answers).await;
        let options = receipt_options("public", true);
        let reply = account
            .reply("sendReceipt", args(&[json!("$m"), options]))
            .await;
        assert_eq!(reply["failure"]["code"], "request-failed", "the marker's");
        assert_eq!(account.sent().len(), 2);

        let answers = vec![ok(), ok()];
        let account = Account::on(joined(events, false), answers).await;
        let options = json!({"threadRootId": "$root", "visibility": "public", "fullyRead": true});
        let reply = account
            .reply("sendReceipt", args(&[json!("$m"), options]))
            .await;
        assert_eq!(reply, json!({"ok": true, "value": null}));
        assert_eq!(account.sent().len(), 1, "a thread has no marker");
    }

    #[tokio::test]
    async fn a_receipt_on_an_event_not_held_sends_nothing() {
        let answers = vec![(ROOMS_POST, 200, json!({}))];
        let account = Account::on(joined(vec![message("$m")], false), answers).await;
        for (room, event) in [(ROOM, "$unknown"), (ROOM, "txn-1"), ("!other:b", "$m")] {
            let options = receipt_options("public", true);
            let args = vec![json!(ME), json!(room), json!(event), options];
            let reply = account.reply("sendReceipt", args).await;
            assert_eq!(reply["failure"]["code"], "message-unavailable", "{event}");
        }
        assert!(account.sent().is_empty());
    }

    #[tokio::test]
    async fn a_receipt_follows_relations_to_the_thread() {
        let thread = |id: &str, root: &str| {
            let on = json!({"rel_type": "m.thread", "event_id": root});
            event(
                "m.room.message",
                id,
                "@b:b",
                1,
                json!({"msgtype": "m.text", "body": "r",
                "m.relates_to": on}),
            )
        };
        let loop_of = |id: &str, target: &str| {
            let on = json!({"rel_type": "m.reference", "event_id": target});
            event("m.room.message", id, "@b:b", 1, json!({"m.relates_to": on}))
        };
        let events = vec![
            message("$root"),
            thread("$reply", "$root"),
            reaction("$on-reply", "@b:b", 1, "$reply", "k"),
            reaction("$on-that", "@b:b", 1, "$on-reply", "k"),
            reaction("$on-root", "@b:b", 1, "$root", "k"),
            reaction("$on-unknown", "@b:b", 1, "$nothing", "k"),
            loop_of("$one", "$two"),
            loop_of("$two", "$one"),
        ];
        let account = Account::plain(events).await;
        let room = account.rt.client.get_room(room_id!("!r:b")).unwrap();
        let (cache, _handles) = room.event_cache().await.unwrap();
        let root = EventId::parse("$root").unwrap();
        let table = [
            ("$root", ReceiptThread::Main),
            ("$reply", ReceiptThread::Thread(root.clone())),
            ("$on-reply", ReceiptThread::Thread(root.clone())),
            ("$on-that", ReceiptThread::Thread(root)),
            ("$on-root", ReceiptThread::Main),
            ("$on-unknown", ReceiptThread::Main),
            ("$one", ReceiptThread::Main),
        ];
        for (id, expected) in table {
            let id = EventId::parse(id).unwrap();
            let event = cache.find_event(&id).await.unwrap().expect("in the cache");
            assert_eq!(receipt_thread(&cache, &event).await, expected, "{id}");
        }
    }

    #[tokio::test]
    async fn set_typing_always_sends() {
        let ok = || (ROOMS_PUT, 200, json!({}));
        let account = Account::on(joined(vec![], false), vec![ok(), ok(), ok()]).await;
        for typing in [true, true, false] {
            let reply = account.reply("setTyping", args(&[json!(typing)])).await;
            assert_eq!(reply, json!({"ok": true, "value": null}));
        }
        assert_eq!(account.sent().len(), 3);

        let answers = vec![(ROOMS_PUT, 502, unavailable_body()), ok()];
        let account = Account::on(joined(vec![], false), answers).await;
        let reply = account.reply("setTyping", args(&[json!(true)])).await;
        assert_eq!(reply["failure"]["code"], "request-failed");
        assert_eq!(account.sent().len(), 1);
    }

    #[tokio::test]
    async fn event_source_adds_room_id() {
        let fetched = message("$fetched");
        let mut with_room = message("$other-room");
        with_room["room_id"] = json!("!elsewhere:b");
        let answers = vec![(ROOMS_GET, 200, fetched)];
        let account = Account::on(joined(vec![message("$m"), with_room], false), answers).await;
        for id in ["$m", "$fetched"] {
            let reply = account.reply("eventSource", args(&[json!(id)])).await;
            assert_eq!(reply["value"]["event_id"], id, "{reply}");
            assert_eq!(reply["value"]["room_id"], ROOM, "{reply}");
        }
        let reply = account
            .reply("eventSource", args(&[json!("$other-room")]))
            .await;
        assert_eq!(reply["value"]["room_id"], "!elsewhere:b");
        assert_eq!(account.sent().len(), 1, "only the unloaded one is fetched");
    }

    #[tokio::test]
    async fn event_source_sends_once_and_a_404_is_message_unavailable() {
        let answers = vec![
            (ROOMS_GET, 502, unavailable_body()),
            (ROOMS_GET, 200, message("$x")),
        ];
        let account = Account::on(joined(vec![], false), answers).await;
        let reply = account.reply("eventSource", args(&[json!("$x")])).await;
        assert_eq!(reply["failure"]["code"], "request-failed", "{reply}");
        assert_eq!(account.sent().len(), 1);

        let answers = vec![(
            ROOMS_GET,
            404,
            json!({"errcode": "M_NOT_FOUND", "error": "x"}),
        )];
        let account = Account::on(joined(vec![], false), answers).await;
        for id in ["$x", "not an id"] {
            let reply = account.reply("eventSource", args(&[json!(id)])).await;
            assert_eq!(reply["failure"]["code"], "message-unavailable", "{id}");
        }
    }

    #[tokio::test]
    async fn reaction_details_group_as_the_rows_do_with_a_timeline_or_without() {
        let mut bob = event(
            "m.room.member",
            "$bob",
            "@b:b",
            1,
            json!({"membership": "join", "displayname": "Bob"}),
        );
        bob["state_key"] = json!("@b:b");
        let mut gone = reaction("$gone", "@d:b", 3, "$t", "x");
        gone["content"] = json!({});
        gone["unsigned"] = json!({"redacted_because": {"type": "m.room.redaction"}});
        let events = vec![
            message("$t"),
            reaction("$r1", "@c:b", 9, "$t", "❤"),
            reaction("$r2", "@b:b", 20, "$t", "👍"),
            reaction("$r3", "@c:b", 10, "$t", "👍"),
            reaction("$r4", "@b:b", 30, "$t", "👍"),
            reaction("$r5", "@b:b", 4, "$t", "🎉"),
            reaction("$empty", "@b:b", 1, "$t", ""),
            gone,
            message("$end"),
        ];
        let mut room = joined(events, false);
        let state = room["rooms"]["join"][ROOM]["state_after"]["events"].as_array_mut();
        state.unwrap().push(bob);
        let account = Account::on(room, vec![]).await;
        let profile =
            json!({"displayName": "Bob", "displayNameAmbiguous": false, "avatarMxc": null});
        let expected = json!({"ok": true, "value": [
            {"key": "👍", "senders": ["@c:b", "@b:b"], "profiles": {"@b:b": profile}},
            {"key": "🎉", "senders": ["@b:b"], "profiles": {"@b:b": profile}},
            {"key": "❤", "senders": ["@c:b"], "profiles": {}},
        ]});
        let details = account.reply("reactionDetails", args(&[json!("$t")])).await;
        assert_eq!(details, expected, "from the event cache");

        let room = account.rt.client.get_room(room_id!("!r:b")).unwrap();
        let _hub = account.rt.hubs.open(&room, Focus::Live).await.unwrap();
        let details = account.reply("reactionDetails", args(&[json!("$t")])).await;
        assert_eq!(details, expected, "from the open timeline");
    }

    #[tokio::test]
    async fn reaction_details_on_an_event_not_held_is_message_unavailable() {
        let account = Account::plain(vec![message("$m")]).await;
        for id in ["$unknown", "not an id"] {
            let reply = account.reply("reactionDetails", args(&[json!(id)])).await;
            assert_eq!(reply["failure"]["code"], "message-unavailable", "{id}");
        }
    }

    /// A subscriber's frames, polled from a task of their own as the carrier polls.
    fn frames_of(engine: &Arc<Engine>) -> mpsc::UnboundedReceiver<Value> {
        let open = vec![json!(ME), json!(ROOM), json!({"kind": "live"})];
        let mut items = dispatch(engine, "timeline.timeline", open).unwrap();
        let (shown, frames) = mpsc::unbounded_channel();
        matrix_sdk::executor::spawn(async move {
            while let Some(Ok(item)) = items.next().await {
                let _ = shown.send(item);
            }
        });
        frames
    }

    async fn first_frame(frames: &mut mpsc::UnboundedReceiver<Value>) -> String {
        let frame = timeout(frames.recv(), Duration::from_secs(5)).await;
        frame.expect("a frame in time").unwrap().to_string()
    }

    fn all_frames(frames: &mut mpsc::UnboundedReceiver<Value>) -> String {
        let mut seen = String::new();
        while let Ok(frame) = frames.try_recv() {
            seen.push_str(&frame.to_string());
        }
        seen
    }

    fn until(id: &str, pages: u32) -> Vec<Value> {
        args(&[json!(id), json!(pages)])
    }

    #[tokio::test]
    async fn found_means_in_the_fold() {
        let events = (0..30).map(|n| message(&format!("$m{n}"))).collect();
        let account = Account::plain(events).await;
        let mut frames = frames_of(&account.engine);
        let first = first_frame(&mut frames).await;
        assert!(
            first.contains("$m29") && !first.contains("\"$m0\""),
            "{first}"
        );

        let held = account.reply("paginateUntil", until("$m0", 0)).await;
        assert_eq!(
            held,
            json!({"ok": true, "value": {"found": false}}),
            "in the SDK's list and no row of a stream",
        );

        let found = account.reply("paginateUntil", until("$m0", 20)).await;
        assert_eq!(found, json!({"ok": true, "value": {"found": true}}));
        assert!(
            all_frames(&mut frames).contains("\"$m0\""),
            "its row came first"
        );
    }

    #[tokio::test]
    async fn paging_until_goes_to_the_server_and_stops_at_the_start_or_the_limit() {
        let page = |chunk: Vec<Value>, end: Option<&str>| {
            let mut page = json!({"start": "p0", "chunk": chunk});
            if let Some(end) = end {
                page["end"] = json!(end);
            }
            page
        };
        let answers = vec![
            (ROOMS_GET, 200, page(vec![message("$older")], Some("p1"))),
            (ROOMS_GET, 200, page(vec![message("$oldest")], None)),
        ];
        let account = Account::on(joined(vec![message("$m")], true), answers).await;
        let mut frames = frames_of(&account.engine);
        first_frame(&mut frames).await;

        let found = account.reply("paginateUntil", until("$older", 5)).await;
        assert_eq!(found["value"]["found"], true, "{found}");
        assert!(all_frames(&mut frames).contains("$older"));
        assert_eq!(account.sent().len(), 1);

        let missing = account.reply("paginateUntil", until("$missing", 5)).await;
        assert_eq!(missing["value"]["found"], false, "{missing}");
        assert_eq!(account.sent().len(), 2, "it stops at the start");

        let bad = account.reply("paginateUntil", until("not an id", 5)).await;
        assert_eq!(bad["value"]["found"], false, "{bad}");
    }

    #[tokio::test]
    async fn an_event_no_row_shows_is_found_with_no_page() {
        let events = vec![message("$m"), reaction("$r", "@b:b", 1, "$m", "k")];
        let answers = vec![(ROOMS_GET, 200, json!({"start": "p0", "chunk": []}))];
        let account = Account::on(joined(events, true), answers).await;
        let mut frames = frames_of(&account.engine);
        first_frame(&mut frames).await;
        let found = account.reply("paginateUntil", until("$r", 5)).await;
        assert_eq!(found["value"]["found"], true, "{found}");
        assert!(account.sent().is_empty());
    }

    #[tokio::test]
    async fn paging_until_checks_the_retire_before_each_page() {
        let answers = vec![(ROOMS_GET, 200, json!({"start": "p0", "chunk": []}))];
        let account = Account::on(joined(vec![message("$m")], true), answers).await;
        account.rt.set_retired();
        let reply = account.reply("paginateUntil", until("$missing", 5)).await;
        assert_eq!(reply["failure"]["code"], "account-not-live");
        assert!(account.sent().is_empty());
    }

    #[tokio::test]
    async fn an_unknown_account_is_refused_and_set_retention_answers_anyway() {
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let nobody = |rest: &[Value]| [vec![json!("@n:b"), json!(ROOM)], rest.to_vec()].concat();
        let table = [
            ("paginateUntil", nobody(&[json!("$e"), json!(1)])),
            ("eventAt", nobody(&[json!(0)])),
            ("eventSource", nobody(&[json!("$e")])),
            ("reactionDetails", nobody(&[json!("$e")])),
            (
                "sendReceipt",
                nobody(&[json!("$e"), receipt_options("private", false)]),
            ),
            ("setTyping", nobody(&[json!(true)])),
        ];
        for (member, args) in table {
            let mut replies = dispatch(&engine, &format!("timeline.{member}"), args).unwrap();
            let reply = replies.next().await.unwrap().unwrap();
            assert_eq!(reply["failure"]["code"], "account-not-live", "{member}");
        }
        for hint in [json!(null), json!({"shown": true})] {
            let mut replies = dispatch(&engine, "timeline.setRetention", nobody(&[hint])).unwrap();
            assert_eq!(replies.next().await.unwrap().unwrap(), Value::Null);
        }
    }

    #[tokio::test]
    async fn the_reads_take_hostile_events_and_no_fault() {
        let mut events: Vec<Value> = hostile().into_iter().map(|(raw, _)| raw).collect();
        events.push(message("$end"));
        let ids: Vec<String> = (events.iter())
            .filter_map(|raw| raw["event_id"].as_str().map(str::to_owned))
            .collect();
        let answers = vec![(ROOMS_POST, 200, json!({})); 2 * ids.len() + 1];
        let account = Account::on(joined(events, false), answers).await;
        let mut frames = frames_of(&account.engine);
        first_frame(&mut frames).await;
        for id in &ids {
            let id = json!(id);
            for (member, rest) in [
                ("eventSource", vec![id.clone()]),
                ("reactionDetails", vec![id.clone()]),
                ("paginateUntil", vec![id.clone(), json!(0)]),
                (
                    "sendReceipt",
                    vec![id.clone(), receipt_options("public", true)],
                ),
            ] {
                let reply = account.reply(member, args(&rest)).await;
                assert!(reply["ok"].is_boolean(), "{member} {id}: {reply}");
            }
        }
    }
}
