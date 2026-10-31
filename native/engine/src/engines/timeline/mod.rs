//! `TimelineEngine` (`libs/data-access/timeline/src/lib/timeline-engine.ts`): the `timeline`
//! stream, over one [`hub::Hub`] per room and focus.

use std::{pin::pin, sync::Arc};

use futures_util::{
    FutureExt, StreamExt,
    future::{Either, select},
};
use matrix_sdk::{
    Client, Error, Room,
    ruma::{EventId, OwnedEventId, RoomId},
    timeout::timeout,
};
use matrix_sdk_ui::{
    eyeball_im::VectorDiff,
    timeline::{self, TimelineItem},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

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

mod fold;
pub(crate) mod hub;
pub mod paging;

use fold::Fold;
use hub::Hub;
use paging::LANDING_LIMIT;

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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum BackPagination {
    Idle,
    Paginating,
    StartReached,
}

/// `TimelineUpdate`.
#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum TimelineUpdateDto {
    RoomUnavailable,
    Items {
        diffs: Vec<VectorDiffDto<Value>>,
        back_pagination: BackPagination,
    },
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
        // As js shows a root no thread has: nothing, and here nothing can ever form it.
        let Some(focus) = focus.parsed() else {
            yield empty_reset();
            return;
        };
        let hub = {
            let mut changes = room_changes(&client, &room_id);
            let (mut announced, mut reset) = (false, false);
            loop {
                let opened = match client.get_room(&room_id) {
                    Some(room) => {
                        // The SDK's build then asks the server, and a stream's first item comes
                        // before the network.
                        if room.encryption_state().is_unknown() && !reset {
                            reset = true;
                            yield empty_reset();
                        }
                        Some(open(room, focus.clone()).await)
                    }
                    None => None,
                };
                match opened {
                    Some(Ok(hub)) => break hub,
                    Some(Err(err)) => {
                        tracing::warn!(?err, "a timeline did not build");
                        if !reset {
                            reset = true;
                            yield empty_reset();
                        }
                    }
                    None if !announced => {
                        announced = true;
                        yield TimelineUpdateDto::RoomUnavailable;
                    }
                    None => {}
                }
                if changes.next().await.is_none() {
                    return;
                }
            }
        };
        let mut flushes = hub.flushes.lock().subscribe(None).1;
        let (items, batches) = hub.timeline.subscribe().await;
        let mut batches = pin!(batches);
        let mut fold = Fold::default();
        let mut state = *hub.state.borrow();
        let snapshot = fold.apply(VectorDiff::Reset { values: items }, |item| item.is_date_divider());
        yield TimelineUpdateDto::Items {
            diffs: snapshot.into_iter().map(|diff| diff.map(row)).collect(),
            back_pagination: state,
        };
        let mut holding = state == BackPagination::Paginating;
        loop {
            // While a page runs its batch stays in the SDK's stream: sent now, it would go out
            // without the page's end state. Only briefly, because everything else in the room
            // waits with it: a slower page goes out marked `paginating`, then an empty end state.
            let woken = if std::mem::take(&mut holding) {
                match timeout(flushes.next(), LANDING_LIMIT).await {
                    Ok(flush) => Either::Left(flush),
                    Err(_) => continue,
                }
            } else {
                match select(flushes.next(), batches.next()).await {
                    Either::Left((flush, _)) => Either::Left(flush),
                    Either::Right((batch, _)) => Either::Right(batch),
                }
            };
            let mut diffs = Vec::new();
            let end_state = match woken {
                Either::Left(Some(flush)) => {
                    holding = flush.end_state == Some(BackPagination::Paginating);
                    if !holding {
                        while let Some(Some(batch)) = batches.next().now_or_never() {
                            diffs.extend(batch);
                        }
                    }
                    flush.end_state
                }
                Either::Right(Some(batch)) => {
                    diffs = batch;
                    None
                }
                Either::Left(None) | Either::Right(None) => return,
            };
            let rows = diffs
                .into_iter()
                .flat_map(|diff| fold.apply(diff, |item| item.is_date_divider()))
                .map(|diff| diff.map(row))
                .collect();
            let mut framed = frames(rows);
            if framed.is_empty() {
                if end_state.is_none() {
                    continue;
                }
                framed.push(Vec::new());
            }
            let last = framed.len() - 1;
            for (at, diffs) in framed.into_iter().enumerate() {
                let back_pagination = match end_state {
                    Some(end) if at == last => end,
                    _ => state,
                };
                yield TimelineUpdateDto::Items { diffs, back_pagination };
            }
            state = end_state.unwrap_or(state);
        }
    }
}

fn empty_reset() -> TimelineUpdateDto {
    TimelineUpdateDto::Items {
        diffs: vec![VectorDiffDto::Reset { values: vec![] }],
        back_pagination: BackPagination::Idle,
    }
}

/// A placeholder row, until T2 maps the items.
fn row(item: Arc<TimelineItem>) -> Value {
    let unique_id = &item.unique_id().0;
    match item.as_event() {
        Some(event) => json!({"kind": "event", "eventId": event.event_id(), "uniqueId": unique_id}),
        None if item.is_timeline_start() => json!({"kind": "timelineStart", "uniqueId": unique_id}),
        None => json!({"kind": "readMarker", "uniqueId": unique_id}),
    }
}

#[cfg(test)]
mod tests {
    use std::{cell::Cell, time::Duration};

    use matrix_sdk::ruma::room_id;
    use serde_json::json;
    use tempfile::TempDir;

    use super::*;
    use crate::{
        dispatch::dispatch,
        testing::{builder_on, engine_in, live, password, scripted, sync, sync_answer, syncing},
    };

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
            serde_json::to_value(update.unwrap().unwrap()).unwrap()
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
