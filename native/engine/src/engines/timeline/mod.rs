//! `TimelineEngine` (`libs/data-access/timeline/src/lib/timeline-engine.ts`): the `timeline`
//! stream, over one [`hub::Hub`] per room and focus.

use std::{pin::pin, sync::Arc};

use futures_util::{
    FutureExt, StreamExt,
    future::{Either, select},
};
use matrix_sdk::{
    BoxFuture, Client, Error, Room,
    ruma::{EventId, OwnedEventId, RoomId, UserId},
    timeout::timeout,
};
use matrix_sdk_ui::{
    eyeball_im::{Vector, VectorDiff},
    timeline::{self, TimelineItem, VirtualTimelineItem},
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    accounts::{AccountRuntime, Engine},
    dispatch::Stream,
    engines::{
        member::{account_stream, on_account},
        settle::room_changes,
    },
    failure::{EngineResult, FailureCode, local_failure, request_failed},
    vector_diff::{VectorDiffDto, frames},
};

mod content;
mod dto;
mod fold;
pub(crate) mod hub;
pub mod paging;
mod rows;

use dto::{DTO, TimelineItemDto, TimelineRoomStateDto, TimelineUpdateDto};
use fold::{Fold, Marker};
use hub::Hub;
use paging::LANDING_LIMIT;
use rows::{RowContext, room_state, row};

/// `TimelineFocus`. The root stays a string: a malformed one is a thread that can't exist, which
/// the members answer, and never a `bad-args` fault on a stream.
#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TimelineFocusDto {
    Live,
    Thread { root_event_id: String },
}

impl TimelineFocusDto {
    fn parsed(self) -> Option<Focus> {
        match self {
            Self::Live => Some(Focus::Live),
            Self::Thread { root_event_id } => (EventId::parse(root_event_id).ok())
                .map(|root_event_id| Focus::Thread { root_event_id }),
        }
    }
}

/// What a hub is opened on.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Focus {
    Live,
    Thread { root_event_id: OwnedEventId },
}

/// `TimelineUpdate['backPagination']`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = DTO)]
pub(crate) enum BackPagination {
    Idle,
    Paginating,
    StartReached,
}

/// js `onRoom`: `run` on a room the account holds, `message-unavailable` when it does not.
async fn on_room<T, Fut>(
    engine: Arc<Engine>,
    account_id: String,
    room_id: String,
    run: impl FnOnce(Arc<Engine>, Arc<AccountRuntime>, Room) -> Fut,
) -> EngineResult<T>
where
    Fut: Future<Output = Result<EngineResult<T>, Error>>,
{
    let held = on_account(
        engine,
        account_id,
        request_failed,
        |engine, rt| async move {
            let room = RoomId::parse(&room_id)
                .ok()
                .and_then(|id| rt.client.get_room(&id));
            match room {
                Some(room) => run(engine, rt, room).await,
                None => Ok(EngineResult::Err(local_failure(
                    FailureCode::MessageUnavailable,
                ))),
            }
        },
    );
    match held.await {
        EngineResult::Ok(result) => result,
        EngineResult::Err(failure) => EngineResult::Err(failure),
    }
}

pub fn timeline(
    engine: Arc<Engine>,
    account_id: String,
    room_id: String,
    focus: TimelineFocusDto,
) -> Stream {
    account_stream(
        engine,
        account_id,
        TimelineUpdateDto::RoomUnavailable,
        move |rt, client| {
            let hubs = Arc::clone(&rt.hubs);
            let open = move |room: Room, focus: Focus| {
                let hubs = Arc::clone(&hubs);
                async move { hubs.open(&room, focus).await }
            };
            updates(client, open, room_id, focus)
        },
    )
}

/// `room-unavailable` until the account holds the room, then a `reset` and what changes it.
fn updates<F>(
    client: Client,
    open: impl Fn(Room, Focus) -> F,
    room_id: String,
    focus: TimelineFocusDto,
) -> impl futures_util::Stream<Item = TimelineUpdateDto>
where
    F: Future<Output = Result<Arc<Hub>, timeline::Error>>,
{
    async_stream::stream! {
        let Ok(room_id) = RoomId::parse(&room_id) else {
            yield TimelineUpdateDto::RoomUnavailable;
            return;
        };
        let focus = focus.parsed();
        let (hub, room) = {
            let mut changes = room_changes(&client, &room_id);
            let (mut announced, mut reset) = (false, false);
            loop {
                let held = client.get_room(&room_id);
                let opened = match (&held, &focus) {
                    // As js shows a root no thread has: nothing, and here nothing can ever form it.
                    (Some(room), None) => {
                        yield empty_reset(Some(room)).await;
                        return;
                    }
                    (Some(room), Some(focus)) => {
                        // The SDK's build then asks the server, and a stream's first item comes
                        // before the network.
                        if room.encryption_state().is_unknown() && !reset {
                            reset = true;
                            yield empty_reset(Some(room)).await;
                        }
                        Some(open(room.clone(), focus.clone()).await)
                    }
                    (None, _) => None,
                };
                match (opened, held) {
                    (Some(Ok(hub)), Some(room)) => break (hub, room),
                    (Some(Err(err)), room) => {
                        tracing::warn!(?err, "a timeline did not build");
                        if !reset {
                            reset = true;
                            yield empty_reset(room.as_ref()).await;
                        }
                    }
                    (None, _) if !announced => {
                        announced = true;
                        yield TimelineUpdateDto::RoomUnavailable;
                    }
                    _ => {}
                }
                if changes.next().await.is_none() {
                    return;
                }
            }
        };
        let Some(me) = client.user_id().map(ToOwned::to_owned) else {
            return;
        };
        let ctx = RowContext::new(room.clone(), me);
        let thread = matches!(focus, Some(Focus::Thread { .. }));
        let mut room_updates = room_changes(&client, &room_id);
        let mut flushes = hub.flushes.lock().subscribe(None).1;
        let (items, batches) = hub.timeline.subscribe().await;
        let mut batches = pin!(batches);
        let mut fold = Fold::default();
        let mut marker = Marker::default();
        let mut sdk_items = items.clone();
        let mut state = *hub.state.borrow();
        let mut snapshot = marker.apply(fold.apply(VectorDiff::Reset { values: items }, is_virtual));
        snapshot.extend(marker.place(marker_target(&sdk_items, &ctx.me)));
        let mut shown = room_of(&room, &sdk_items, thread).await;
        yield TimelineUpdateDto::Items {
            diffs: rows_of(snapshot, &ctx).await,
            back_pagination: state,
            room: shown.clone(),
        };
        let mut holding = state == BackPagination::Paginating;
        loop {
            // While a page runs its batch stays in the SDK's stream: sent now, it would go out
            // without the page's end state. Only briefly, because everything else in the room
            // waits with it: a slower page goes out marked `paginating`, then an empty end state.
            let woken = if std::mem::take(&mut holding) {
                match timeout(flushes.next(), LANDING_LIMIT).await {
                    Ok(flush) => Woken::Flush(flush),
                    Err(_) => continue,
                }
            } else {
                match select(flushes.next(), select(batches.next(), room_updates.next())).await {
                    Either::Left((flush, _)) => Woken::Flush(flush),
                    Either::Right((Either::Left((batch, _)), _)) => Woken::Batch(batch),
                    Either::Right((Either::Right((change, _)), _)) => Woken::Room(change),
                }
            };
            let mut diffs = Vec::new();
            let end_state = match woken {
                Woken::Flush(Some(flush)) => {
                    holding = flush.end_state == Some(BackPagination::Paginating);
                    if !holding {
                        while let Some(Some(batch)) = batches.next().now_or_never() {
                            diffs.extend(batch);
                        }
                    }
                    flush.end_state
                }
                Woken::Batch(Some(batch)) => {
                    diffs = batch;
                    None
                }
                Woken::Room(Some(())) => None,
                Woken::Flush(None) | Woken::Batch(None) | Woken::Room(None) => return,
            };
            sdk_items = apply_all(sdk_items, diffs.iter().cloned());
            let folded = diffs
                .into_iter()
                .flat_map(|diff| fold.apply(diff, is_virtual))
                .collect();
            let mut folded = marker.apply(folded);
            folded.extend(marker.place(marker_target(&sdk_items, &ctx.me)));
            let mut framed = frames(rows_of(folded, &ctx).await);
            let room_now = room_of(&room, &sdk_items, thread).await;
            if framed.is_empty() {
                if end_state.is_none() && room_now == shown {
                    continue;
                }
                framed.push(Vec::new());
            }
            shown = room_now;
            let last = framed.len() - 1;
            for (at, diffs) in framed.into_iter().enumerate() {
                let back_pagination = match end_state {
                    Some(end) if at == last => end,
                    _ => state,
                };
                yield TimelineUpdateDto::Items { diffs, back_pagination, room: shown.clone() };
            }
            state = end_state.unwrap_or(state);
        }
    }
}

/// The rows the interface has no item for: the fold drops them, and the marker is placed apart.
fn is_virtual(item: &Arc<TimelineItem>) -> bool {
    item.is_date_divider() || is_marker(item)
}

fn is_marker(item: &TimelineItem) -> bool {
    matches!(item.as_virtual(), Some(VirtualTimelineItem::ReadMarker))
}

/// Where js puts the marker: before the first message after the SDK's marker that is not our
/// own, past any state items; with none, where the SDK has it. The index counts the rows
/// without the marker.
fn marker_target(
    items: &Vector<Arc<TimelineItem>>,
    me: &UserId,
) -> Option<(usize, Arc<TimelineItem>)> {
    let (mut shown, mut sdk) = (0, None);
    for item in items {
        if is_marker(item) {
            sdk = Some((shown, Arc::clone(item)));
            continue;
        }
        if item.is_date_divider() {
            continue;
        }
        let unread = item
            .as_event()
            .is_some_and(|event| event.content().as_msglike().is_some() && event.sender() != me);
        if let (true, Some((_, marker))) = (unread, &sdk) {
            return Some((shown, Arc::clone(marker)));
        }
        shown += 1;
    }
    sdk
}

/// What woke the stream.
enum Woken {
    Flush(Option<hub::Flush>),
    Batch(Option<Vec<VectorDiff<Arc<TimelineItem>>>>),
    Room(Option<()>),
}

fn apply_all(
    mut items: Vector<Arc<TimelineItem>>,
    diffs: impl IntoIterator<Item = VectorDiff<Arc<TimelineItem>>>,
) -> Vector<Arc<TimelineItem>> {
    for diff in diffs {
        diff.apply(&mut items);
    }
    items
}

/// The diffs with their items mapped, in order: the mapping reads the store, so it is async.
fn rows_of<'a>(
    diffs: Vec<VectorDiffDto<Arc<TimelineItem>>>,
    ctx: &'a RowContext,
) -> BoxFuture<'a, Vec<VectorDiffDto<TimelineItemDto>>> {
    // Boxed: inline, these futures nest too deep for the stream's layout.
    Box::pin(rows_in(diffs, ctx))
}

async fn rows_in(
    diffs: Vec<VectorDiffDto<Arc<TimelineItem>>>,
    ctx: &RowContext,
) -> Vec<VectorDiffDto<TimelineItemDto>> {
    let mut items = Vec::new();
    let slots: Vec<_> = diffs
        .into_iter()
        .map(|diff| {
            diff.map(|item| {
                items.push(item);
                items.len() - 1
            })
        })
        .collect();
    let mut rows = Vec::with_capacity(items.len());
    for item in &items {
        rows.push(Some(row(item, ctx).await));
    }
    slots
        .into_iter()
        .map(|diff| diff.map(|at| rows[at].take().expect("one row per item")))
        .collect()
}

/// The room's state beside the rows: the oldest event is the first the rows show.
fn room_of<'a>(
    room: &'a Room,
    items: &'a Vector<Arc<TimelineItem>>,
    thread: bool,
) -> BoxFuture<'a, TimelineRoomStateDto> {
    Box::pin(room_in(room, items, thread))
}

async fn room_in(
    room: &Room,
    items: &Vector<Arc<TimelineItem>>,
    thread: bool,
) -> TimelineRoomStateDto {
    let mut state = room_state(room).await;
    state.oldest_event_id = (items.iter())
        .find_map(|item| item.as_event()?.event_id())
        .map(ToString::to_string);
    if thread {
        // shortcut: the room cache's newest event is no thread's; the thread tasks read the
        // thread cache.
        state.latest_confirmed_event_id = None;
    }
    state
}

fn empty_reset(room: Option<&Room>) -> BoxFuture<'_, TimelineUpdateDto> {
    Box::pin(async move {
        let room = match room {
            Some(room) => room_state(room).await,
            None => TimelineRoomStateDto::unknown(),
        };
        TimelineUpdateDto::Items {
            diffs: vec![VectorDiffDto::Reset { values: vec![] }],
            back_pagination: BackPagination::Idle,
            room,
        }
    })
}

#[cfg(test)]
mod tests {
    use std::{cell::Cell, time::Duration};

    use matrix_sdk::ruma::room_id;
    use serde_json::{Value, json};
    use tempfile::TempDir;

    use super::*;
    use crate::{
        dispatch::dispatch,
        testing::{builder_on, engine_in, live, password, scripted, sync, sync_answer, syncing},
    };

    /// An update without its `room`, which the tests that read it look at themselves.
    fn bare(mut update: Value) -> Value {
        if let Some(update) = update.as_object_mut() {
            update.remove("room");
        }
        update
    }

    #[tokio::test]
    async fn room_unavailable_then_a_failed_build_is_an_empty_reset_until_the_next_change() {
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let encrypted = json!({
            "type": "m.room.encryption", "state_key": "", "event_id": "$e", "sender": "@b:b",
            "origin_server_ts": 1, "content": {"algorithm": "m.megolm.v1.aes-sha2"},
        });
        let joined = json!({"rooms": {"join": {"!r:b": {
            "timeline": {"events": []},
            "state_after": {"events": [encrypted]},
        }}}});
        let rt = syncing(&engine, vec![joined.clone(), joined]).await;
        let tries = Cell::new(0);
        let hubs = Arc::clone(&rt.hubs);
        let open = |room: Room, focus: Focus| {
            tries.set(tries.get() + 1);
            let refused = tries.get() == 1;
            let hubs = Arc::clone(&hubs);
            async move {
                if refused {
                    return Err(timeline::Error::UnsupportedEvent);
                }
                hubs.open(&room, focus).await
            }
        };
        let room_id = room_id!("!r:b").to_string();
        let updates = updates(rt.client.clone(), open, room_id, TimelineFocusDto::Live);
        let mut updates = pin!(updates);
        let mut next = async || {
            let update = timeout(updates.next(), Duration::from_secs(5)).await;
            bare(serde_json::to_value(update.unwrap().unwrap()).unwrap())
        };

        assert_eq!(next().await, json!({"kind": "room-unavailable"}));
        sync(&rt.client).await;
        let items = |reset: Value| json!({"kind": "items", "diffs": [{"op": "reset", "values": reset}], "backPagination": "idle"});
        assert_eq!(next().await, items(json!([])));
        sync(&rt.client).await;
        assert_eq!(next().await, items(json!([])), "the hub's own snapshot");
        assert_eq!(tries.get(), 2);
    }

    #[tokio::test]
    async fn a_bad_thread_root_on_a_room_not_held_is_unavailable_first() {
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let joined = json!({"rooms": {"join": {"!r:b": {"timeline": {"events": []}}}}});
        let rt = syncing(&engine, vec![joined]).await;
        let open = |_: Room, _: Focus| async { Err(timeline::Error::UnsupportedEvent) };
        let focus = TimelineFocusDto::Thread {
            root_event_id: "x".into(),
        };
        let room_id = room_id!("!r:b").to_string();
        let updates = updates(rt.client.clone(), open, room_id, focus);
        let mut updates = pin!(updates);
        let mut next = async || {
            let update = timeout(updates.next(), Duration::from_secs(5)).await;
            bare(serde_json::to_value(update.unwrap().unwrap()).unwrap())
        };

        assert_eq!(next().await, json!({"kind": "room-unavailable"}));
        sync(&rt.client).await;
        let reset = json!({"kind": "items", "diffs": [{"op": "reset", "values": []}], "backPagination": "idle"});
        assert_eq!(next().await, reset);
    }

    #[tokio::test]
    async fn an_unknown_encryption_state_emits_before_the_request() {
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let joined = json!({"rooms": {"join": {"!r:b": {"timeline": {"events": []}}}}});
        let (base, _) = scripted(vec![
            sync_answer(0, joined),
            ("GET /_matrix/client/v3/rooms/*", 0, json!(null)),
        ]);
        let client = builder_on(&base).build().await.unwrap();
        let rt = live(&engine, &password(&base), client).await;
        sync(&rt.client).await;
        let mut items = timeline(
            Arc::clone(&engine),
            "@a:b".into(),
            "!r:b".into(),
            TimelineFocusDto::Live,
        );
        let first = timeout(items.next(), Duration::from_secs(1)).await;
        let first = first.expect("before the held request").unwrap().unwrap();
        assert_eq!(first["diffs"], json!([{"op": "reset", "values": []}]));
    }

    #[tokio::test]
    async fn a_malformed_root_is_no_fault_and_the_account_is_looked_up_first() {
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let args = || {
            vec![
                json!("@a:b"),
                json!("!r:b"),
                json!({"kind": "thread", "rootEventId": "x"}),
            ]
        };
        let first = async |engine: &Arc<Engine>, method, args| {
            let mut stream = dispatch(engine, method, args).unwrap();
            let item = timeout(stream.next(), Duration::from_secs(5)).await;
            item.unwrap().unwrap().unwrap()
        };
        let not_live = first(&engine, "timeline.timeline", args()).await;
        assert_eq!(not_live, json!({"kind": "room-unavailable"}));

        let joined = json!({"rooms": {"join": {"!r:b": {"timeline": {"events": []}}}}});
        let rt = syncing(&engine, vec![joined]).await;
        sync(&rt.client).await;
        let shown = first(&engine, "timeline.timeline", args()).await;
        assert_eq!(shown["diffs"], json!([{"op": "reset", "values": []}]));
        let mut paged = args();
        paged.push(json!(10));
        let paged = first(&engine, "timeline.paginateBackwards", paged).await;
        assert_eq!(paged, json!({"ok": true, "value": {"startReached": true}}));
    }
}
