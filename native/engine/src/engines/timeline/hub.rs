//! One `Timeline` per (room, focus), shared by the streams and commands that name it.

use std::{
    collections::HashMap,
    sync::{Arc, Weak},
};

use matrix_sdk::{
    BoxFuture, Room,
    event_cache::PaginationStatus,
    locks::Mutex,
    ruma::{OwnedEventId, OwnedRoomId, RoomId},
};
use matrix_sdk_ui::{
    Timeline,
    sync_service::SyncService,
    timeline::{self, RoomExt, TimelineFocus, TimelineReadReceiptTracking},
};
use tokio::sync::watch;

use super::{BackPagination, Focus};
use crate::barrier::{Barrier, Subscribers};

/// What a command asks an open stream to do before its barrier resolves.
#[derive(Clone, Debug)]
pub(crate) struct Flush {
    pub end_state: Option<BackPagination>,
    #[expect(dead_code, reason = "T7 calls it")]
    pub remap: Option<OwnedEventId>,
}

/// One timeline of a room. The stream bodies and running commands hold it; dropping the last
/// aborts the SDK's timeline tasks.
pub(crate) struct Hub {
    pub(super) timeline: Timeline,
    pub(super) flushes: Mutex<Subscribers<Flush>>,
    /// One page at a time per focus, as js `queues`.
    pub(super) paging: tokio::sync::Mutex<()>,
    /// Engine-driven, because the SDK's status has no page in it (H7).
    pub(super) state: watch::Sender<BackPagination>,
    _subscribed: RoomSubscription,
}

impl Hub {
    /// Moves to `state`, which every open stream emits with the batches ready by then.
    pub(super) fn move_to(&self, state: BackPagination) -> Barrier {
        self.state.send_replace(state);
        self.flushes.lock().publish(&Flush {
            end_state: Some(state),
            remap: None,
        })
    }
}

/// The hubs of one account. It keeps no `Arc<Hub>`, so a hub lives only while it is used.
pub(crate) struct Hubs {
    open: Mutex<HashMap<Key, Weak<Hub>>>,
    /// One open per key at a time, so two subscribers share one hub. Per key: a build can wait on
    /// the server, and other rooms must not wait on that.
    opening: Mutex<HashMap<Key, Arc<tokio::sync::Mutex<()>>>>,
    subscriptions: Arc<Subscriptions>,
}

type Key = (OwnedRoomId, Focus);

impl Hubs {
    pub(crate) fn new(sync_service: Arc<SyncService>) -> Self {
        Self {
            open: Mutex::default(),
            opening: Mutex::default(),
            subscriptions: Arc::new(Subscriptions {
                counts: Mutex::default(),
                in_order: tokio::sync::Mutex::new(()),
                sync_service,
            }),
        }
    }

    pub(crate) async fn open(
        &self,
        room: &Room,
        focus: Focus,
    ) -> Result<Arc<Hub>, timeline::Error> {
        let key = (room.room_id().to_owned(), focus);
        let slot = Arc::clone(self.opening.lock().entry(key.clone()).or_default());
        let opened = self.build(room, key, &slot).await;
        drop(slot);
        (self.opening.lock()).retain(|_, slot| Arc::strong_count(slot) > 1);
        opened
    }

    async fn build(
        &self,
        room: &Room,
        key: Key,
        slot: &tokio::sync::Mutex<()>,
    ) -> Result<Arc<Hub>, timeline::Error> {
        let _one_at_a_time = slot.lock().await;
        if let Some(hub) = self.open.lock().get(&key).and_then(Weak::upgrade) {
            return Ok(hub);
        }
        let subscribed = RoomSubscription::take(&self.subscriptions, room.room_id()).await;
        let builder = room
            .timeline_builder()
            .with_focus(key.1.sdk())
            .track_read_marker_and_receipts(TimelineReadReceiptTracking::AllEvents);
        // Boxed: moved by value through its callers, this future overflows a debug build's stack.
        let build: BoxFuture<'_, _> = Box::pin(builder.build());
        let timeline = build.await?;
        let state = match timeline.live_back_pagination_status().await {
            Some((
                PaginationStatus::Idle {
                    hit_timeline_start: true,
                },
                _,
            )) => BackPagination::StartReached,
            _ => BackPagination::Idle,
        };
        let hub = Arc::new(Hub {
            timeline,
            flushes: Mutex::default(),
            paging: tokio::sync::Mutex::new(()),
            state: watch::Sender::new(state),
            _subscribed: subscribed,
        });
        let mut open = self.open.lock();
        open.retain(|_, hub| hub.strong_count() > 0);
        open.insert(key, Arc::downgrade(&hub));
        Ok(hub)
    }

    /// Only those already open; a command settles these and opens none.
    #[expect(dead_code, reason = "T5 calls it")]
    pub(crate) fn of(&self, room_id: &RoomId) -> Vec<Arc<Hub>> {
        let open = self.open.lock();
        (open.iter())
            .filter(|((room, _), _)| room == room_id)
            .filter_map(|(_, hub)| hub.upgrade())
            .collect()
    }
}

impl Focus {
    fn sdk(&self) -> TimelineFocus {
        match self {
            Focus::Live => TimelineFocus::Live {
                hide_threaded_events: true,
            },
            Focus::Thread { root_event_id } => TimelineFocus::Thread {
                root_event_id: root_event_id.clone(),
            },
        }
    }
}

struct Subscriptions {
    counts: Mutex<Refcounts>,
    /// The SDK's set awaits before it applies its list, and the last list must win.
    in_order: tokio::sync::Mutex<()>,
    sync_service: Arc<SyncService>,
}

/// How many holders each subscribed room has.
#[derive(Debug, Default)]
struct Refcounts(HashMap<OwnedRoomId, usize>);

impl Refcounts {
    /// All the rooms to subscribe to when `room` has its first holder: the SDK's set replaces the
    /// whole set.
    fn take(&mut self, room: &RoomId) -> Option<Vec<OwnedRoomId>> {
        let holders = self.0.entry(room.to_owned()).or_default();
        *holders += 1;
        (*holders == 1).then(|| self.0.keys().cloned().collect())
    }

    /// Whether `room` lost its last holder.
    fn give(&mut self, room: &RoomId) -> bool {
        let Some(holders) = self.0.get_mut(room) else {
            return false;
        };
        *holders -= 1;
        let last = *holders == 0;
        if last {
            self.0.remove(room);
        }
        last
    }
}

/// Holds a room's subscription: the list's `timeline_limit` is 1 and a subscription's is 20, and
/// only a subscription asks for the room's pins (H8).
pub(crate) struct RoomSubscription {
    subscriptions: Arc<Subscriptions>,
    room: OwnedRoomId,
}

impl RoomSubscription {
    async fn take(subscriptions: &Arc<Subscriptions>, room: &RoomId) -> Self {
        let _in_order = subscriptions.in_order.lock().await;
        let rooms = subscriptions.counts.lock().take(room);
        let held = Self {
            subscriptions: Arc::clone(subscriptions),
            room: room.to_owned(),
        };
        // shortcut: a last holder that drops during this set leaves its room subscribed until the
        // next set, one extra room in the sync; upgrade if piece 3 measures it.
        if let Some(rooms) = rooms {
            let rooms: Vec<&RoomId> = rooms.iter().map(AsRef::as_ref).collect();
            let list = subscriptions.sync_service.room_list_service();
            list.set_room_subscriptions(&rooms).await;
        }
        held
    }
}

impl Drop for RoomSubscription {
    fn drop(&mut self) {
        if self.subscriptions.counts.lock().give(&self.room) {
            let list = self.subscriptions.sync_service.room_list_service();
            list.remove_room_subscriptions(&[&self.room]);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use futures_util::{StreamExt, future::join};
    use matrix_sdk::{Client, executor::spawn, ruma::room_id, timeout::timeout};
    use serde_json::{Value, json};
    use tempfile::TempDir;
    use tokio::sync::oneshot;
    use zeroize::Zeroizing;

    use super::*;
    use crate::{
        accounts::Engine,
        config::EngineConfig,
        engines::{
            session::{
                PersistedAccountActivationDto,
                restore::{auth_session, session_meta},
            },
            timeline::timeline,
        },
        failure::EngineResult,
        testing::{builder_on, password, scripted, sync, sync_answer},
    };

    /// A sync that joins `!r:b`, encrypted so that a build asks the server nothing.
    fn joined() -> Value {
        let encrypted = json!({
            "type": "m.room.encryption", "state_key": "", "event_id": "$e", "sender": "@b:b",
            "origin_server_ts": 1, "content": {"algorithm": "m.megolm.v1.aes-sha2"},
        });
        json!({"rooms": {"join": {"!r:b": {
            "timeline": {"events": []},
            "state_after": {"events": [encrypted]},
        }}}})
    }

    /// A restored client that has synced `answers`' first, with hubs.
    async fn client_on(answers: Vec<(&'static str, u16, Value)>) -> (Client, Hubs) {
        let (base, _) = scripted(answers);
        let s = password(&base);
        let client = builder_on(&base).build().await.unwrap();
        let meta = session_meta("test", &s).unwrap();
        client
            .restore_session(auth_session(&s, meta))
            .await
            .unwrap();
        let service = SyncService::builder(client.clone()).build().await.unwrap();
        sync(&client).await;
        (client, Hubs::new(Arc::new(service)))
    }

    /// U14 by a store reopen. A marker in the client's handler context can't tell: a client that
    /// synced under a `SyncService` keeps it past 1 s with no hub at all.
    #[tokio::test]
    async fn a_dropped_hub_releases_its_client() {
        let root = TempDir::new().unwrap();
        let engine = Engine::new(EngineConfig {
            data_dir: root.path().join("data"),
            cache_dir: root.path().join("cache"),
            store_key: Arc::new(|| Ok(Zeroizing::new([1; 32]))),
            ..EngineConfig::default()
        })
        .unwrap();
        let (base, _) = scripted(vec![sync_answer(0, joined())]);
        let activate = PersistedAccountActivationDto::Activate;
        let started = engine.restore(password(&base), activate).await;
        assert!(matches!(started, Ok(EngineResult::Ok(()))));
        let rt = engine.account("@a:b").unwrap();
        sync(&rt.client).await;
        drop(rt);
        let mut items = timeline(engine.clone(), "@a:b".into(), "!r:b".into(), Focus::Live);
        let (opened, seen) = oneshot::channel();
        spawn(async move {
            let first = items.next().await;
            let _ = opened.send(first);
            while items.next().await.is_some() {}
        });
        let first = seen.await.unwrap().unwrap().unwrap();
        assert_eq!(first["kind"], "items", "the stream holds a hub");

        let restart = engine.restore(password(&base), activate);
        let restarted = timeout(restart, Duration::from_secs(10)).await;
        assert!(
            matches!(restarted, Ok(Ok(EngineResult::Ok(())))),
            "the hub delayed the teardown"
        );
        let rt = engine.account("@a:b").unwrap();
        assert_eq!(rt.generation, 2);
        let room = rt.client.get_room(room_id!("!r:b")).expect("in the store");
        assert!(rt.hubs.open(&room, Focus::Live).await.is_ok());
    }

    #[tokio::test]
    async fn a_build_waiting_on_the_server_holds_up_no_other_room() {
        let body = json!({"rooms": {"join": {
            "!a:b": {"timeline": {"events": []}},
            "!b:b": {"timeline": {"events": []}},
        }}});
        let (client, hubs) = client_on(vec![
            sync_answer(0, body),
            ("GET /_matrix/client/v3/rooms/!a:b/state/*", 0, json!(null)),
            ("GET /stays-open", 200, json!({})),
        ])
        .await;
        let room = |id| client.get_room(id).unwrap();
        let (a, b) = (room(room_id!("!a:b")), room(room_id!("!b:b")));
        let mut waiting = Box::pin(hubs.open(&a, Focus::Live));
        let early = timeout(waiting.as_mut(), Duration::from_millis(200)).await;
        assert!(early.is_err(), "its encryption state is held");
        let other = timeout(hubs.open(&b, Focus::Live), Duration::from_secs(5)).await;
        assert!(other.unwrap().is_ok());
    }

    #[tokio::test]
    async fn two_subscribers_share_one_hub() {
        let (client, hubs) = client_on(vec![sync_answer(0, joined())]).await;
        let room = client.get_room(room_id!("!r:b")).unwrap();
        let (one, two) = join(hubs.open(&room, Focus::Live), hubs.open(&room, Focus::Live)).await;
        let (one, two) = (one.unwrap(), two.unwrap());
        assert!(Arc::ptr_eq(&one, &two));
        let old = Arc::downgrade(&one);
        drop((one, two));
        assert!(old.upgrade().is_none(), "the hubs keep no hub alive");
        let again = hubs.open(&room, Focus::Live).await.unwrap();
        assert!(!Weak::ptr_eq(&old, &Arc::downgrade(&again)));
    }

    #[test]
    fn subscriptions_refcount_set_and_remove() {
        let (a, b) = (room_id!("!a:b"), room_id!("!b:b"));
        let mut counts = Refcounts::default();
        assert_eq!(
            counts.take(a),
            Some(vec![a.to_owned()]),
            "the first holder sets"
        );
        assert_eq!(counts.take(a), None);
        let mut both = counts.take(b).unwrap();
        both.sort();
        assert_eq!(both, [a.to_owned(), b.to_owned()], "a set names every room");
        assert!(!counts.give(a));
        assert!(counts.give(a), "the last holder removes");
        assert!(counts.give(b));
        assert_eq!(
            counts.take(a),
            Some(vec![a.to_owned()]),
            "and the next sets again"
        );
    }
}
