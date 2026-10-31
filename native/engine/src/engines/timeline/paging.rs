//! `paginateBackwards`: the page and its end state reach every open stream in one update, and the
//! reply follows them. The SDK can return before a timeline task has applied the page (H7).

use std::{sync::Arc, time::Duration};

use futures_util::StreamExt;
use matrix_sdk::{
    BoxFuture, Error, Room,
    event_cache::{
        EventsOrigin, RoomEventCacheUpdate, Subscriber, ThreadEventCacheUpdate, TimelineVectorDiffs,
    },
    ruma::OwnedEventId,
    timeout::timeout,
};
use matrix_sdk_ui::{eyeball_im::VectorDiff, timeline};
use serde::Serialize;
use tokio::sync::broadcast::error::TryRecvError;

use super::{BackPagination, Focus, hub::Hub, on_room};
use crate::{
    accounts::{AccountRuntime, Engine},
    barrier::Barrier,
    dispatch::{Stream, reply},
    engines::member::bounded,
};

/// How long a page may take to show after the SDK returns; a page of hidden events ends here.
const LANDING_LIMIT: Duration = Duration::from_secs(2);

/// `{ startReached }`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PageReplyDto {
    start_reached: bool,
}

pub fn paginate_backwards(
    engine: Arc<Engine>,
    account_id: String,
    room_id: String,
    focus: Focus,
    count: u16,
) -> Stream {
    reply(on_room(
        engine,
        account_id,
        room_id,
        move |engine, rt, room| async move {
            // An unknown encryption state makes the SDK's build ask the server.
            let opened = bounded(async {
                (rt.hubs.open(&room, focus.clone()).await).map_err(request_error)
            });
            let hub = engine.ruled(&rt, opened).await?;
            let start_reached = page(&engine, &rt, &room, &hub, &focus, count).await?;
            Ok(PageReplyDto { start_reached })
        },
    ))
}

/// The SDK's error, with the event cache's kept visible to the failure mapping and the token rule.
fn request_error(err: timeline::Error) -> Error {
    match err {
        timeline::Error::EventCacheError(err)
        | timeline::Error::PaginationError(timeline::PaginationError::EventCache(err)) => {
            err.into()
        }
        err => Error::UnknownError(Box::new(err)),
    }
}

async fn page(
    engine: &Arc<Engine>,
    rt: &AccountRuntime,
    room: &Room,
    hub: &Hub,
    focus: &Focus,
    count: u16,
) -> Result<bool, Error> {
    let _one_at_a_time = hub.paging.lock().await;
    let before = *hub.state.borrow();
    let ending = Ending {
        hub,
        otherwise: Some(before),
    };
    hub.move_to(BackPagination::Paginating).delivered().await;
    let mut pages = Pages::open(room, focus).await?;
    let paged = bounded(async {
        // Boxed as `Hubs::open` boxes its build.
        let paged: BoxFuture<'_, _> = Box::pin(hub.timeline.paginate_backwards(count));
        paged.await.map_err(request_error)
    });
    let start_reached = engine.ruled(rt, paged).await;
    if start_reached.is_ok() {
        landed(hub, pages.ids()).await;
    }
    let end = match start_reached {
        Ok(true) => BackPagination::StartReached,
        Ok(false) => BackPagination::Idle,
        Err(_) => before,
    };
    ending.at(end).delivered().await;
    start_reached
}

/// Ends the page's state however the command does: a close drops it mid-page, and a stream left
/// on `paginating` holds its batches.
struct Ending<'a> {
    hub: &'a Hub,
    otherwise: Option<BackPagination>,
}

impl Ending<'_> {
    fn at(mut self, state: BackPagination) -> Barrier {
        self.otherwise = None;
        self.hub.move_to(state)
    }
}

impl Drop for Ending<'_> {
    fn drop(&mut self) {
        if let Some(state) = self.otherwise {
            let _ = self.hub.move_to(state);
        }
    }
}

/// Until one of `ids` shows in the timeline: a page commits at once, so one is all of them. No
/// ids: the page came from the skip window, which moved already, or held nothing.
async fn landed(hub: &Hub, ids: Vec<OwnedEventId>) {
    if ids.is_empty() {
        return;
    }
    let shows = async {
        let (_, changes) = hub.timeline.subscribe().await;
        let mut changes = std::pin::pin!(changes);
        loop {
            let items = hub.timeline.items().await;
            let event_id = |item: &Arc<timeline::TimelineItem>| {
                item.as_event()
                    .and_then(|event| event.event_id().map(ToOwned::to_owned))
            };
            if items
                .iter()
                .filter_map(event_id)
                .any(|id| ids.contains(&id))
            {
                return;
            }
            if changes.next().await.is_none() {
                std::future::pending::<()>().await;
            }
        }
    };
    if timeout(shows, LANDING_LIMIT).await.is_err() {
        tracing::debug!("a page showed nothing in the timeline");
    }
}

/// The event cache's updates, read for the event ids of a page: `Timeline::paginate_backwards`
/// returns only a bool.
enum Pages {
    Room(Subscriber<RoomEventCacheUpdate>),
    Thread(Subscriber<ThreadEventCacheUpdate>),
}

impl Pages {
    async fn open(room: &Room, focus: &Focus) -> Result<Self, Error> {
        Ok(match focus {
            Focus::Live => {
                let (cache, _handles) = room.event_cache().await?;
                Pages::Room(cache.subscribe().await?.1)
            }
            Focus::Thread { root_event_id } => {
                let client = room.client();
                let threads = client.event_cache();
                let (cache, _handles) = threads.thread(room.room_id(), root_event_id).await?;
                Pages::Thread(cache.subscribe().await?.1)
            }
        })
    }

    /// The ids of the page the SDK has sent by now.
    fn ids(&mut self) -> Vec<OwnedEventId> {
        let mut ids = Vec::new();
        loop {
            let diffs = match self {
                Pages::Room(updates) => match updates.try_recv() {
                    Ok(RoomEventCacheUpdate::UpdateTimelineEvents(diffs)) => Some(diffs),
                    Ok(_) | Err(TryRecvError::Lagged(_)) => None,
                    Err(_) => return ids,
                },
                Pages::Thread(updates) => match updates.try_recv() {
                    Ok(ThreadEventCacheUpdate::UpdateTimelineEvents(diffs)) => Some(diffs),
                    Ok(_) | Err(TryRecvError::Lagged(_)) => None,
                    Err(_) => return ids,
                },
            };
            if let Some(TimelineVectorDiffs { diffs, origin }) = diffs
                && !matches!(origin, EventsOrigin::Sync)
            {
                for diff in diffs {
                    match diff {
                        VectorDiff::Append { values } | VectorDiff::Reset { values } => {
                            ids.extend(
                                values
                                    .iter()
                                    .filter_map(|event| event.event_id().map(ToOwned::to_owned)),
                            );
                        }
                        VectorDiff::PushFront { value }
                        | VectorDiff::PushBack { value }
                        | VectorDiff::Insert { value, .. }
                        | VectorDiff::Set { value, .. } => {
                            ids.extend(value.event_id().map(ToOwned::to_owned))
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use futures_util::StreamExt;
    use matrix_sdk::executor::spawn;
    use serde_json::{Value, json};
    use tempfile::TempDir;
    use tokio::sync::mpsc;

    use super::*;
    use crate::{
        engines::timeline::timeline,
        testing::{builder_on, engine_in, live, password, scripted, sync, sync_answer},
    };

    const ROOM: &str = "!r:b";

    #[tokio::test]
    async fn a_closed_page_ends_its_state_and_the_stream_goes_on() {
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let joined = json!({"rooms": {"join": {ROOM: {
            "timeline": {
                "events": [{
                    "type": "m.room.message", "event_id": "$one", "sender": "@b:b",
                    "origin_server_ts": 1, "content": {"msgtype": "m.text", "body": "hi"},
                }],
                "limited": true,
                "prev_batch": "p0",
            },
            "state_after": {"events": [{
                "type": "m.room.encryption", "state_key": "", "event_id": "$e", "sender": "@b:b",
                "origin_server_ts": 1, "content": {"algorithm": "m.megolm.v1.aes-sha2"},
            }]},
        }}}});
        let (base, _) = scripted(vec![
            sync_answer(0, joined),
            ("GET /_matrix/client/v3/rooms/*", 0, json!(null)),
        ]);
        let client = builder_on(&base).build().await.unwrap();
        let rt = live(&engine, &password(&base), client).await;
        sync(&rt.client).await;

        let mut items = timeline(Arc::clone(&engine), "@a:b".into(), ROOM.into(), Focus::Live);
        let (shown, mut frames) = mpsc::unbounded_channel::<Value>();
        spawn(async move {
            while let Some(Ok(item)) = items.next().await {
                let _ = shown.send(item);
            }
        });
        let state = |frame: Value| frame["backPagination"].clone();
        assert_eq!(state(frames.recv().await.unwrap()), json!("idle"));

        let mut reply = paginate_backwards(
            Arc::clone(&engine),
            "@a:b".into(),
            ROOM.into(),
            Focus::Live,
            10,
        );
        let held = timeout(reply.next(), Duration::from_millis(300)).await;
        assert!(held.is_err(), "the page waits on its request");
        assert_eq!(state(frames.recv().await.unwrap()), json!("paginating"));
        drop(reply);
        let ended = timeout(frames.recv(), Duration::from_secs(5)).await;
        assert_eq!(state(ended.unwrap().unwrap()), json!("idle"));
    }
}
