//! `TimelineEngine` (`libs/data-access/timeline/src/lib/timeline-engine.ts`): the `timeline`
//! stream, over one [`hub::Hub`] per room and focus.

use std::{pin::pin, sync::Arc};

use futures_util::{
    FutureExt, StreamExt,
    future::{Either, select},
};
use matrix_sdk::{
    Client, Error, Room,
    ruma::{OwnedEventId, RoomId},
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

/// `TimelineFocus`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Focus {
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
    Fut: Future<Output = Result<T, Error>>,
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
                Some(room) => run(engine, rt, room).await.map(EngineResult::Ok),
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

pub fn timeline(engine: Arc<Engine>, account_id: String, room_id: String, focus: Focus) -> Stream {
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
    focus: Focus,
) -> impl futures_util::Stream<Item = TimelineUpdateDto>
where
    F: Future<Output = Result<Arc<Hub>, timeline::Error>>,
{
    async_stream::stream! {
        let Ok(room_id) = RoomId::parse(&room_id) else {
            yield TimelineUpdateDto::RoomUnavailable;
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
        loop {
            // While a page runs its batch stays in the SDK's stream: sent now, it would go out
            // without the page's end state.
            let woken = if state == BackPagination::Paginating {
                Either::Left(flushes.next().await)
            } else {
                match select(flushes.next(), batches.next()).await {
                    Either::Left((flush, _)) => Either::Left(flush),
                    Either::Right((batch, _)) => Either::Right(batch),
                }
            };
            let mut diffs = Vec::new();
            let end_state = match woken {
                Either::Left(Some(flush)) => {
                    if flush.end_state != Some(BackPagination::Paginating) {
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

    use matrix_sdk::{ruma::room_id, timeout::timeout};
    use serde_json::json;
    use tempfile::TempDir;

    use super::*;
    use crate::testing::{
        builder_on, engine_in, live, password, scripted, sync, sync_answer, syncing,
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
        let updates = updates(rt.client.clone(), open, room_id, Focus::Live);
        let mut updates = pin!(updates);
        let mut next = async || serde_json::to_value(updates.next().await.unwrap()).unwrap();

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
            Focus::Live,
        );
        let first = timeout(items.next(), Duration::from_secs(1)).await;
        let first = first.expect("before the held request").unwrap().unwrap();
        assert_eq!(first["diffs"], json!([{"op": "reset", "values": []}]));
    }
}
