//! `paginateBackwards`: the page and its end state reach every open stream in one update, and the
//! reply follows them. The SDK can return before a timeline task has applied the page (H7).

use std::{collections::HashSet, future::pending, pin::pin, sync::Arc, time::Duration};

use futures_util::{
    StreamExt,
    future::{Either, select},
};
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

use super::{BackPagination, Focus, TimelineFocusDto, hub::Hub, on_room};
use crate::{
    accounts::{AccountRuntime, Engine},
    barrier::Barrier,
    dispatch::{Stream, reply},
    engines::member::bounded,
    failure::{EngineResult, account_not_live},
};

/// How long a page may take to show after the SDK returns, a page of hidden events ending here,
/// and how long a stream holds its batches for a running page.
pub(super) const LANDING_LIMIT: Duration = if cfg!(test) {
    Duration::from_millis(300)
} else {
    Duration::from_secs(2)
};

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
    focus: TimelineFocusDto,
    count: u16,
) -> Stream {
    reply(on_room(
        engine,
        account_id,
        room_id,
        move |engine, rt, room| async move {
            // As js answers for a root no thread has.
            let Some(focus) = focus.parsed() else {
                let start_reached = true;
                return Ok(EngineResult::Ok(PageReplyDto { start_reached }));
            };
            let hub = hub_of(&engine, &rt, &room, &focus).await?;
            Ok(
                match page(&engine, &rt, &room, &hub, &focus, count).await? {
                    Some(start_reached) => EngineResult::Ok(PageReplyDto { start_reached }),
                    None => EngineResult::Err(account_not_live()),
                },
            )
        },
    ))
}

/// The hub a command pages on. An unknown encryption state makes the SDK's build ask the server.
pub(super) async fn hub_of(
    engine: &Arc<Engine>,
    rt: &AccountRuntime,
    room: &Room,
    focus: &Focus,
) -> Result<Arc<Hub>, Error> {
    let opened =
        bounded(async { (rt.hubs.open(room, focus.clone()).await).map_err(request_error) });
    engine.ruled(rt, opened).await
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

/// Whether the page reached the start, or `None` for an account that retired while it queued: a
/// teardown waits for each holder, and pages queued on a stalled server would outlast its limit.
pub(super) async fn page(
    engine: &Arc<Engine>,
    rt: &AccountRuntime,
    room: &Room,
    hub: &Hub,
    focus: &Focus,
    count: u16,
) -> Result<Option<bool>, Error> {
    let mut retired = rt.retired();
    let retire = async {
        let _ = retired.wait_for(|retired| *retired).await;
    };
    let queue = hub.paging.lock();
    let _one_at_a_time = match select(pin!(retire), pin!(queue)).await {
        Either::Left(_) => return Ok(None),
        Either::Right((turn, _)) => turn,
    };
    let before = *hub.state.borrow();
    let ending = Ending {
        hub,
        otherwise: Some(before),
    };
    hub.move_to(BackPagination::Paginating).delivered().await;
    let mut pages = Pages::open(room, focus).await?;
    let before_page = shown(hub).await;
    let paged = bounded(async {
        // Boxed as `Hubs::open` boxes its build.
        let paged: BoxFuture<'_, _> = Box::pin(hub.timeline.paginate_backwards(count));
        paged.await.map_err(request_error)
    });
    let start_reached = engine.ruled(rt, paged).await;
    if start_reached.is_ok() {
        landed(hub, pages.ids(), &before_page).await;
    }
    let end = match start_reached {
        Ok(true) => BackPagination::StartReached,
        Ok(false) => BackPagination::Idle,
        Err(_) => before,
    };
    ending.at(end).delivered().await;
    start_reached.map(Some)
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

/// The event ids in the timeline, those the skip window hides included.
async fn shown(hub: &Hub) -> HashSet<OwnedEventId> {
    let items = hub.timeline.items().await;
    let id_of = |item: &Arc<timeline::TimelineItem>| Some(item.as_event()?.event_id()?.to_owned());
    items.iter().filter_map(id_of).collect()
}

/// Until one of `ids` that was not `before_page` shows in the timeline: a page commits at once, so
/// one is all of them. The others are a cache's update during the page, such as a late key's
/// `Set`, and say nothing about it. None left: the page came from the skip window, which moved
/// already, or held nothing.
async fn landed(hub: &Hub, ids: Vec<OwnedEventId>, before_page: &HashSet<OwnedEventId>) {
    let ids: Vec<_> = (ids.into_iter())
        .filter(|id| !before_page.contains(id))
        .collect();
    if ids.is_empty() {
        return;
    }
    let shows = async {
        let (_, changes) = hub.timeline.subscribe().await;
        let mut changes = pin!(changes);
        loop {
            let now = shown(hub).await;
            if ids.iter().any(|id| now.contains(id)) {
                return;
            }
            if changes.next().await.is_none() {
                pending::<()>().await;
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
    use std::time::Instant;

    use matrix_sdk::{Client, executor::spawn, ruma::event_id};
    use serde_json::{Value, json};
    use tempfile::TempDir;
    use tokio::sync::mpsc;

    use super::*;
    use crate::{
        engines::timeline::timeline,
        testing::{builder_on, engine_in, live, password, requests, scripted, sync, sync_answer},
    };

    const ROOM: &str = "!r:b";
    const MESSAGES: &str = "GET /_matrix/client/v3/rooms/*";

    fn message(id: &str) -> Value {
        json!({
            "type": "m.room.message", "event_id": id, "sender": "@b:b",
            "origin_server_ts": 1, "content": {"msgtype": "m.text", "body": "hi"},
        })
    }

    /// A sync that joins `ROOM` with `$one`, a gap before it, and a known encryption state.
    fn joined() -> Value {
        json!({"rooms": {"join": {ROOM: {
            "timeline": {"events": [message("$one")], "limited": true, "prev_batch": "p0"},
            "state_after": {"events": [{
                "type": "m.room.encryption", "state_key": "", "event_id": "$e", "sender": "@b:b",
                "origin_server_ts": 1, "content": {"algorithm": "m.megolm.v1.aes-sha2"},
            }]},
        }}}})
    }

    /// `@a:b` on a homeserver that answers `answers` after the first sync, which has run.
    async fn account(
        root: &TempDir,
        answers: Vec<(&'static str, u16, Value)>,
    ) -> (Arc<Engine>, Client, crate::testing::Seen) {
        let engine = engine_in(root);
        let (base, seen) = scripted([vec![sync_answer(0, joined())], answers].concat());
        let client = builder_on(&base).build().await.unwrap();
        let rt = live(&engine, &password(&base), client).await;
        sync(&rt.client).await;
        (engine, rt.client.clone(), seen)
    }

    /// The `timeline` frames of `ROOM`, polled from a task of their own as the carrier polls.
    fn frames_of(engine: &Arc<Engine>) -> mpsc::UnboundedReceiver<Value> {
        let live = TimelineFocusDto::Live;
        let mut items = timeline(Arc::clone(engine), "@a:b".into(), ROOM.into(), live);
        let (shown, frames) = mpsc::unbounded_channel();
        spawn(async move {
            while let Some(Ok(item)) = items.next().await {
                let _ = shown.send(item);
            }
        });
        frames
    }

    fn page_of(engine: &Arc<Engine>) -> crate::dispatch::Stream {
        let live = TimelineFocusDto::Live;
        paginate_backwards(Arc::clone(engine), "@a:b".into(), ROOM.into(), live, 10)
    }

    async fn next_frame(frames: &mut mpsc::UnboundedReceiver<Value>) -> Value {
        let frame = timeout(frames.recv(), Duration::from_secs(5)).await;
        frame.expect("a frame in time").unwrap()
    }

    #[tokio::test]
    async fn a_closed_page_ends_its_state_and_the_stream_goes_on() {
        let root = TempDir::new().unwrap();
        let (engine, _client, _) = account(&root, vec![(MESSAGES, 0, json!(null))]).await;
        let mut frames = frames_of(&engine);
        assert_eq!(next_frame(&mut frames).await["backPagination"], "idle");

        let mut reply = page_of(&engine);
        let held = timeout(reply.next(), Duration::from_millis(100)).await;
        assert!(held.is_err(), "the page waits on its request");
        assert_eq!(
            next_frame(&mut frames).await["backPagination"],
            "paginating"
        );
        drop(reply);
        assert_eq!(next_frame(&mut frames).await["backPagination"], "idle");
    }

    #[tokio::test]
    async fn a_page_slower_than_the_limit_lets_the_room_go_on_marked_paginating() {
        let root = TempDir::new().unwrap();
        let later = json!({"rooms": {"join": {ROOM: {"timeline": {"events": [message("$two")]}}}}});
        let answers = vec![(MESSAGES, 0, json!(null)), sync_answer(1, later)];
        let (engine, client, _) = account(&root, answers).await;
        let mut frames = frames_of(&engine);
        next_frame(&mut frames).await;

        let since = Instant::now();
        let mut reply = page_of(&engine);
        let held = timeout(reply.next(), Duration::from_millis(50)).await;
        assert!(held.is_err(), "the page waits on its request");
        let started = next_frame(&mut frames).await;
        assert_eq!(started["diffs"], json!([]));
        sync(&client).await;

        let frame = next_frame(&mut frames).await;
        assert!(since.elapsed() >= LANDING_LIMIT, "it is held that long");
        assert_eq!(frame["backPagination"], "paginating");
        assert_ne!(frame["diffs"], json!([]), "bob's message goes out");
        drop(reply);
        let ended = next_frame(&mut frames).await;
        assert_eq!(ended["backPagination"], "idle");
        assert_eq!(ended["diffs"], json!([]));
    }

    #[tokio::test]
    async fn a_page_queued_when_the_account_retires_fails_and_never_runs() {
        let root = TempDir::new().unwrap();
        let (engine, client, seen) = account(&root, vec![(MESSAGES, 0, json!(null))]).await;
        let rt = engine.account("@a:b").unwrap();
        let room = client.get_room(<&matrix_sdk::ruma::RoomId>::try_from(ROOM).unwrap());
        let hub = rt.hubs.open(&room.unwrap(), Focus::Live).await.unwrap();
        let _running = hub.paging.lock().await;

        let mut reply = page_of(&engine);
        let queued = timeout(reply.next(), Duration::from_millis(100)).await;
        assert!(queued.is_err(), "it waits for its turn");
        rt.set_retired();
        let refused = timeout(reply.next(), Duration::from_secs(5)).await;
        let refused = refused.expect("it stops waiting").unwrap().unwrap();
        assert_eq!(refused["failure"]["code"], "account-not-live");
        let paged = requests(&seen)
            .iter()
            .any(|(target, _)| target.contains("/messages"));
        assert!(!paged, "no page ran after the retire");
    }

    #[tokio::test]
    async fn an_id_shown_before_the_page_does_not_end_the_wait_for_it() {
        let root = TempDir::new().unwrap();
        let (engine, client, _) = account(&root, vec![]).await;
        let rt = engine.account("@a:b").unwrap();
        let room = client.get_room(<&matrix_sdk::ruma::RoomId>::try_from(ROOM).unwrap());
        let hub = rt.hubs.open(&room.unwrap(), Focus::Live).await.unwrap();
        let one = event_id!("$one").to_owned();
        let before_page = shown(&hub).await;
        assert!(before_page.contains(&one));

        let waited = Instant::now();
        landed(&hub, vec![one.clone()], &before_page).await;
        assert!(
            waited.elapsed() < LANDING_LIMIT,
            "nothing of a page to wait for"
        );

        let waited = Instant::now();
        let page = vec![one.clone(), event_id!("$older").to_owned()];
        landed(&hub, page, &before_page).await;
        assert!(waited.elapsed() >= LANDING_LIMIT, "$older has not shown");

        let waited = Instant::now();
        landed(&hub, vec![one], &HashSet::new()).await;
        assert!(
            waited.elapsed() < LANDING_LIMIT,
            "a page's id that shows ends it"
        );
    }
}
