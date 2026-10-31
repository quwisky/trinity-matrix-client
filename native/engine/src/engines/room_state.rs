//! Custom room state (widgets, emoji packs) read from the server: the room list's sync does not
//! ask for these types and offers no way to, so a one-shot sliding-sync request reads them and
//! nothing reaches the store.

use std::{collections::BTreeMap, time::Duration};

use futures_util::{
    FutureExt, Stream, StreamExt,
    future::{Either, join, select},
};
use matrix_sdk::{
    BoxFuture, Client, Error,
    ruma::{
        OwnedRoomId, RoomId,
        api::{
            client::{
                state::get_state_event_for_key::{self, v3::StateEventFormat},
                sync::sync_events::v5::{self, request::RoomSubscription},
            },
            error::ErrorKind,
        },
        events::StateEventType,
        presence::PresenceState,
        uint,
    },
    sleep::sleep,
};
use serde_json::Value;

use super::member::sent_once;
use crate::failure::classify;

/// The least time between two reads of one stream.
pub(crate) const MIN_GAP: Duration = Duration::from_secs(1);
/// The wait before a failed read is tried again.
pub(crate) const RETRY_GAP: Duration = Duration::from_secs(30);

/// The current state events of `types` per room, read from the server. A room the account was
/// never in is absent.
pub(crate) async fn read_state(
    client: &Client,
    rooms: &[OwnedRoomId],
    types: &[StateEventType],
) -> Result<BTreeMap<OwnedRoomId, Vec<Value>>, Error> {
    if rooms.is_empty() {
        return Ok(BTreeMap::new());
    }
    let request = state_request(rooms, types);
    // shortcut: no byte cap on the response, only the 30 s limit; cap it if a pack room's state
    // grows large enough to matter.
    let response = client
        .send(request)
        .with_request_config(sent_once())
        .await?;
    let wanted: Vec<String> = types.iter().map(ToString::to_string).collect();
    let mut by_room = BTreeMap::new();
    for (room, data) in response.rooms {
        let mut events = Vec::new();
        for event in &data.required_state {
            let Ok(event) = event.deserialize_as::<Value>() else {
                tracing::warn!("a state event was unreadable");
                continue;
            };
            if event["type"]
                .as_str()
                .is_some_and(|t| wanted.iter().any(|w| w == t))
            {
                events.push(event);
            }
        }
        by_room.insert(room, events);
    }
    Ok(by_room)
}

/// No `pos` and no lists make it a one-shot read: the server forgets the connection's row at the
/// next request with this `conn_id`.
fn state_request(rooms: &[OwnedRoomId], types: &[StateEventType]) -> v5::Request {
    let mut request = v5::Request::new();
    request.conn_id = Some("trinity-state".to_owned());
    request.timeout = Some(Duration::ZERO);
    request.set_presence = PresenceState::Offline;
    for room in rooms {
        let mut subscription = RoomSubscription::default();
        subscription.required_state = types.iter().map(|t| (t.clone(), "*".to_owned())).collect();
        subscription.timeline_limit = uint!(0);
        request
            .room_subscriptions
            .insert(room.clone(), subscription);
    }
    request
}

/// What ended a wait between reads.
enum Wake {
    Ended,
    Tick,
    Retry,
}

/// `first` at once, with no network, then an item whenever `show` of the store and the last read
/// differs from the last item. Each round reads the store, then the server (`R::default()` until it
/// answers) and waits for a tick and at least 1 s. A failed read keeps the last answer: until the
/// server is asked again, `RETRY_GAP` after the failure whatever the ticks do, ticks read only the
/// store, so what it says still shows. Ticks during a read or a wait count as one. The stream ends
/// when `changes` does.
pub(crate) fn follow_state<T, S, R, SF, SFut, RF, RFut>(
    first: T,
    mut store: SF,
    mut read: RF,
    show: impl Fn(&S, &R) -> T,
    mut changes: impl Stream<Item = ()> + Unpin,
) -> impl Stream<Item = T>
where
    T: Clone + PartialEq,
    R: Default,
    SF: FnMut() -> SFut,
    SFut: Future<Output = S>,
    RF: FnMut() -> RFut,
    RFut: Future<Output = Result<R, Error>>,
{
    async_stream::stream! {
        let mut last = first.clone();
        yield first;
        let mut kept = R::default();
        let mut retry: Option<BoxFuture<'static, ()>> = None;
        let mut skip = false;
        loop {
            let now_store = store().await;
            if !skip {
                match read().await {
                    Ok(fresh) => {
                        kept = fresh;
                        retry = None;
                    }
                    Err(err) => {
                        tracing::warn!(kind = ?classify(&err).0, "a room state read failed");
                        retry = Some(Box::pin(sleep(RETRY_GAP)));
                    }
                }
            }
            let now = show(&now_store, &kept);
            if now != last {
                last = now.clone();
                yield now;
            }
            let wake = async {
                match retry.as_mut() {
                    None => changes.next().await.map_or(Wake::Ended, |()| Wake::Tick),
                    // The timer goes first: a tick that is ready at once must not starve it.
                    Some(timer) => match select(timer, changes.next()).await {
                        Either::Left(_) => Wake::Retry,
                        Either::Right((None, _)) => Wake::Ended,
                        Either::Right((Some(()), _)) => Wake::Tick,
                    },
                }
            };
            match join(sleep(MIN_GAP), wake).await.1 {
                Wake::Ended => return,
                Wake::Tick => skip = retry.is_some(),
                Wake::Retry => {
                    retry = None;
                    skip = false;
                }
            }
            while let Some(tick) = changes.next().now_or_never() {
                if tick.is_none() {
                    return;
                }
            }
        }
    }
}

/// One raw `GET /rooms/{room}/state/{type}/{key}`, sent once: the content, or `None` for
/// `M_NOT_FOUND`. Each caller maps its own failure.
pub(crate) async fn fetch(
    client: &Client,
    room: &RoomId,
    event_type: &StateEventType,
    state_key: &str,
) -> Result<Option<Value>, Error> {
    get(
        client,
        room,
        event_type,
        state_key,
        StateEventFormat::Content,
    )
    .await
}

/// [`fetch`] of the whole event, with its `event_id` and `sender`.
pub(crate) async fn fetch_event(
    client: &Client,
    room: &RoomId,
    event_type: &StateEventType,
    state_key: &str,
) -> Result<Option<Value>, Error> {
    get(client, room, event_type, state_key, StateEventFormat::Event).await
}

async fn get(
    client: &Client,
    room: &RoomId,
    event_type: &StateEventType,
    state_key: &str,
    format: StateEventFormat,
) -> Result<Option<Value>, Error> {
    let mut request = get_state_event_for_key::v3::Request::new(
        room.to_owned(),
        event_type.clone(),
        state_key.to_owned(),
    );
    request.format = format;
    match client.send(request).with_request_config(sent_once()).await {
        Ok(response) => Ok(Some(serde_json::from_str(response.event_or_content.get())?)),
        Err(err) if err.client_api_error_kind() == Some(&ErrorKind::NotFound) => Ok(None),
        Err(err) => Err(err.into()),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        cell::{Cell, RefCell},
        collections::VecDeque,
    };

    use futures_util::stream;
    use matrix_sdk::ruma::{owned_room_id, room_id};
    use serde_json::json;
    use tokio::{
        sync::mpsc,
        time::{Instant, sleep_until, timeout, timeout_at},
    };

    use super::*;
    use crate::{
        accounts::Engine,
        config::EngineConfig,
        testing::{default_client, password, requests, scripted},
    };

    const SYNC: &str = "POST /_matrix/client/unstable/org.matrix.simplified_msc3575/sync*";

    async fn client_on(base: &str) -> Client {
        let engine = Engine::new(EngineConfig::default()).unwrap();
        default_client(&engine, &password(base)).await
    }

    fn kinds() -> Vec<StateEventType> {
        vec![
            StateEventType::from("m.room.image_pack"),
            StateEventType::from("im.vector.modular.widgets"),
        ]
    }

    fn event(kind: &str, key: &str) -> Value {
        json!({"type": kind, "state_key": key, "sender": "@a:b", "event_id": "$e", "content": {}})
    }

    #[test]
    fn state_request_is_one_shot_and_quiet() {
        let rooms = [owned_room_id!("!r:b"), owned_room_id!("!s:b")];
        let request = state_request(&rooms, &kinds());
        let id = request.conn_id.as_deref().unwrap();
        assert!(id.len() <= 16, "{id}");
        assert_eq!(request.timeout, Some(Duration::ZERO));
        assert_eq!(request.set_presence, PresenceState::Offline);
        assert_eq!(request.pos, None);
        assert!(request.lists.is_empty());
        assert_eq!(request.extensions, Default::default());
        assert_eq!(request.room_subscriptions.len(), 2);
        let subscription = &request.room_subscriptions[&rooms[0]];
        assert_eq!(subscription.timeline_limit, uint!(0));
        let wanted = [
            ("m.room.image_pack", "*"),
            ("im.vector.modular.widgets", "*"),
        ];
        let got: Vec<_> = subscription
            .required_state
            .iter()
            .map(|(t, k)| (t.to_string(), k.as_str()))
            .collect();
        assert_eq!(got, wanted.map(|(t, k)| (t.to_owned(), k)));
    }

    #[tokio::test]
    async fn a_read_is_sent_once() {
        let answers = vec![(SYNC, 502, json!({})), (SYNC, 200, json!({"pos": "0"}))];
        let (base, seen) = scripted(answers);
        let client = client_on(&base).await;
        let read = read_state(&client, &[owned_room_id!("!r:b")], &kinds()).await;
        assert!(read.is_err());
        assert_eq!(requests(&seen).len(), 1);
    }

    #[tokio::test]
    async fn a_read_returns_each_rooms_events_by_type() {
        let body = json!({"pos": "0", "rooms": {
            "!r:b": {"required_state": [
                event("m.room.image_pack", ""),
                event("m.room.name", ""),
                event("im.vector.modular.widgets", "w"),
            ]},
            "!s:b": {"required_state": [event("m.room.image_pack", "x")]},
        }});
        let (base, _) = scripted(vec![(SYNC, 200, body)]);
        let client = client_on(&base).await;
        let asked = [
            owned_room_id!("!r:b"),
            owned_room_id!("!s:b"),
            owned_room_id!("!gone:b"),
        ];
        let read = read_state(&client, &asked, &kinds()).await.unwrap();
        assert_eq!(read.len(), 2, "the missing room is absent");
        assert_eq!(
            read[&owned_room_id!("!r:b")],
            [
                event("m.room.image_pack", ""),
                event("im.vector.modular.widgets", "w")
            ]
        );
        assert_eq!(
            read[&owned_room_id!("!s:b")],
            [event("m.room.image_pack", "x")]
        );
    }

    #[tokio::test]
    async fn a_bad_event_is_skipped_beside_a_good_one() {
        // Deeper than serde_json's recursion limit, which `Raw` does not apply.
        let nested = (0..127).fold(json!(1), |inner, _| json!({"a": inner}));
        let deep = json!({"type": "m.room.image_pack", "state_key": "d", "content": nested});
        let body = json!({"pos": "0", "rooms": {"!r:b": {"required_state": [
            deep,
            event("m.room.image_pack", ""),
        ]}}});
        let (base, _) = scripted(vec![(SYNC, 200, body)]);
        let client = client_on(&base).await;
        let asked = [owned_room_id!("!r:b")];
        let read = read_state(&client, &asked, &kinds()).await.unwrap();
        assert_eq!(read[&asked[0]], [event("m.room.image_pack", "")]);
    }

    #[tokio::test]
    async fn fetch_is_none_for_a_missing_event() {
        let kind = StateEventType::from("im.vector.modular.widgets");
        let (base, _) = scripted(vec![
            ("GET /_matrix/client/v3/rooms/*", 200, json!({"a": 1})),
            (
                "GET /_matrix/client/v3/rooms/*",
                404,
                json!({"errcode": "M_NOT_FOUND", "error": "x"}),
            ),
        ]);
        let client = client_on(&base).await;
        let room = room_id!("!r:b");
        assert_eq!(
            fetch(&client, room, &kind, "w").await.unwrap(),
            Some(json!({"a": 1}))
        );
        assert_eq!(fetch(&client, room, &kind, "w").await.unwrap(), None);
    }

    #[tokio::test]
    async fn fetch_is_sent_once() {
        let (base, seen) = scripted(vec![
            ("GET /_matrix/client/v3/rooms/*", 502, json!({})),
            ("GET /_matrix/client/v3/rooms/*", 200, json!({})),
        ]);
        let client = client_on(&base).await;
        let kind = StateEventType::from("im.vector.modular.widgets");
        assert!(fetch(&client, room_id!("!r:b"), &kind, "w").await.is_err());
        assert_eq!(requests(&seen).len(), 1);
    }

    /// Reads answered from a script, each noting when it ran.
    struct Reads {
        answers: RefCell<VecDeque<Result<u32, ()>>>,
        at: RefCell<Vec<Duration>>,
        start: Instant,
    }

    impl Reads {
        fn new(answers: &[Result<u32, ()>]) -> Self {
            Self {
                answers: RefCell::new(answers.iter().cloned().collect()),
                at: RefCell::default(),
                start: Instant::now(),
            }
        }

        async fn read(&self) -> Result<u32, Error> {
            self.at.borrow_mut().push(self.start.elapsed());
            let next = self.answers.borrow_mut().pop_front();
            next.expect("a read too many")
                .map_err(|()| Error::UnknownError("failed".into()))
        }

        fn secs(&self) -> Vec<u64> {
            self.at.borrow().iter().map(Duration::as_secs).collect()
        }
    }

    fn ticks() -> (mpsc::UnboundedSender<()>, impl Stream<Item = ()> + Unpin) {
        let (tx, mut rx) = mpsc::unbounded_channel();
        (tx, stream::poll_fn(move |cx| rx.poll_recv(cx)))
    }

    /// What a stream shows: the store's value and the last read's.
    type Shown = (u32, u32);

    /// A stream over a store `level` that a test sets and a scripted server read.
    fn follow<'a>(
        reads: &'a Reads,
        level: &'a Cell<u32>,
        changes: impl Stream<Item = ()> + Unpin + 'a,
    ) -> impl Stream<Item = Shown> + 'a {
        let store = || std::future::ready(level.get());
        follow_state((0, 0), store, || reads.read(), |s, r| (*s, *r), changes)
    }

    /// The items that arrive within `secs` of `start`, each with its time.
    async fn within(
        items: &mut (impl Stream<Item = Shown> + Unpin),
        start: Instant,
        secs: u64,
    ) -> Vec<(u64, Shown)> {
        let end = start + Duration::from_secs(secs);
        let mut got = Vec::new();
        while let Ok(Some(shown)) = timeout_at(end, items.next()).await {
            got.push((start.elapsed().as_secs(), shown));
        }
        got
    }

    /// Sends a tick at each of `secs` from `start`.
    async fn tick_at(tx: &mpsc::UnboundedSender<()>, start: Instant, secs: &[f64]) {
        for at in secs {
            sleep_until(start + Duration::from_secs_f64(*at)).await;
            tx.send(()).unwrap();
        }
    }

    #[tokio::test(start_paused = true)]
    async fn first_arrives_with_no_read() {
        let (reads, level) = (Reads::new(&[]), Cell::new(0));
        let mut items = Box::pin(follow(&reads, &level, stream::pending()));
        assert_eq!(items.next().await, Some((0, 0)));
        assert!(reads.at.borrow().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_burst_of_ticks_reads_at_most_once_a_second() {
        let (reads, level) = (Reads::new(&[Ok(1), Ok(2), Ok(3)]), Cell::new(0));
        let (tx, changes) = ticks();
        let mut items = Box::pin(follow(&reads, &level, changes));
        assert_eq!(items.next().await, Some((0, 0)));
        assert_eq!(items.next().await, Some((0, 1)));
        for _ in 0..10 {
            tx.send(()).unwrap();
        }
        let burst = Instant::now();
        assert_eq!(items.next().await, Some((0, 2)));
        assert!(burst.elapsed() >= MIN_GAP);
        // The ten ticks were one: the next read waits for a new tick.
        assert!(
            timeout(Duration::from_secs(10), items.next())
                .await
                .is_err()
        );
        let at = reads.at.borrow().clone();
        assert_eq!(at.len(), 2, "{at:?}");
        assert!(at[1] - at[0] >= MIN_GAP, "{at:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn an_unchanged_read_emits_nothing() {
        let (reads, level) = (Reads::new(&[Ok(0), Ok(0), Ok(6)]), Cell::new(0));
        let (tx, changes) = ticks();
        let mut items = Box::pin(follow(&reads, &level, changes));
        assert_eq!(items.next().await, Some((0, 0)));
        let mut next = Box::pin(items.next());
        assert!(
            next.as_mut().now_or_never().is_none(),
            "the same 0 is no item"
        );
        assert_eq!(reads.at.borrow().len(), 1);
        tx.send(()).unwrap();
        let quiet = timeout(Duration::from_secs(2), next.as_mut()).await;
        assert!(quiet.is_err(), "nor is the second");
        assert_eq!(reads.at.borrow().len(), 2);
        tx.send(()).unwrap();
        assert_eq!(next.await, Some((0, 6)));
        assert_eq!(reads.at.borrow().len(), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_read_keeps_the_last_and_retries_after_30_s() {
        let (reads, level) = (Reads::new(&[Err(()), Ok(1)]), Cell::new(0));
        let (tx, changes) = ticks();
        let mut items = Box::pin(follow(&reads, &level, changes));
        assert_eq!(items.next().await, Some((0, 0)));
        // A tick during the wait is no reason for another read.
        tx.send(()).unwrap();
        assert_eq!(items.next().await, Some((0, 1)));
        let at = reads.at.borrow().clone();
        assert_eq!(at, [Duration::ZERO, RETRY_GAP]);
        assert!(
            timeout(Duration::from_secs(10), items.next())
                .await
                .is_err()
        );
        assert_eq!(reads.at.borrow().len(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn the_stream_ends_with_changes_after_a_failed_read() {
        let (reads, level) = (Reads::new(&[Err(())]), Cell::new(0));
        let (tx, changes) = ticks();
        let mut items = Box::pin(follow(&reads, &level, changes));
        assert_eq!(items.next().await, Some((0, 0)));
        drop(tx);
        assert_eq!(items.next().await, None);
    }

    #[tokio::test(start_paused = true)]
    async fn a_tick_during_a_read_is_not_lost() {
        let (tx, changes) = ticks();
        let seen = RefCell::new(0);
        let read = || {
            let n = *seen.borrow() + 1;
            *seen.borrow_mut() = n;
            if n == 1 {
                tx.send(()).unwrap();
            }
            async move { Ok::<_, Error>(n) }
        };
        let store = || std::future::ready(());
        let mut items = Box::pin(follow_state(0, store, read, |(), n| *n, changes));
        assert_eq!(items.next().await, Some(0));
        assert_eq!(items.next().await, Some(1));
        let start = Instant::now();
        assert_eq!(items.next().await, Some(2));
        assert_eq!(start.elapsed(), MIN_GAP, "the tick was waiting");
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_read_is_retried_by_a_stream_that_started_healthy() {
        let answers = [Ok(1), Err(()), Ok(2)];
        let (reads, level) = (Reads::new(&answers), Cell::new(0));
        let (tx, changes) = ticks();
        let mut items = Box::pin(follow(&reads, &level, changes));
        let start = Instant::now();
        let ticking = tick_at(&tx, start, &[5.0]);
        let got = futures_util::future::join(ticking, within(&mut items, start, 100))
            .await
            .1;
        assert_eq!(got, [(0, (0, 0)), (0, (0, 1)), (35, (0, 2))]);
        assert_eq!(reads.secs(), [0, 5, 35], "no read after the retry");
    }

    #[tokio::test(start_paused = true)]
    async fn a_tick_after_a_recovery_reads_the_server() {
        let (reads, level) = (Reads::new(&[Err(()), Ok(1), Ok(2)]), Cell::new(0));
        let (tx, changes) = ticks();
        let mut items = Box::pin(follow(&reads, &level, changes));
        let start = Instant::now();
        let ticking = tick_at(&tx, start, &[35.0]);
        let got = futures_util::future::join(ticking, within(&mut items, start, 100))
            .await
            .1;
        assert_eq!(got, [(0, (0, 0)), (30, (0, 1)), (35, (0, 2))]);
        assert_eq!(reads.secs(), [0, 30, 35], "no read at 60 s either");
    }

    #[tokio::test(start_paused = true)]
    async fn steady_ticks_do_not_starve_the_retry() {
        let (reads, level) = (Reads::new(&[Err(()), Ok(1)]), Cell::new(0));
        let (tx, changes) = ticks();
        let mut items = Box::pin(follow(&reads, &level, changes));
        let start = Instant::now();
        let every_second: Vec<f64> = (1..=29).map(f64::from).collect();
        let ticking = tick_at(&tx, start, &every_second);
        let got = futures_util::future::join(ticking, within(&mut items, start, 40))
            .await
            .1;
        assert_eq!(got, [(0, (0, 0)), (30, (0, 1))]);
        assert_eq!(reads.secs(), [0, 30], "no read between, none after");
    }

    #[tokio::test(start_paused = true)]
    async fn a_tick_late_in_the_gap_delays_the_retry_by_less_than_a_second() {
        let (reads, level) = (Reads::new(&[Err(()), Ok(1)]), Cell::new(0));
        let (tx, changes) = ticks();
        let mut items = Box::pin(follow(&reads, &level, changes));
        let start = Instant::now();
        let ticking = tick_at(&tx, start, &[28.5, 29.5, 30.0]);
        futures_util::future::join(ticking, within(&mut items, start, 40)).await;
        let retry = reads.at.borrow()[1];
        assert!(
            retry >= RETRY_GAP && retry <= RETRY_GAP + MIN_GAP,
            "{retry:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_read_still_shows_what_the_store_says() {
        let (reads, level) = (Reads::new(&[Ok(1), Err(()), Ok(2)]), Cell::new(0));
        let (tx, changes) = ticks();
        let mut items = Box::pin(follow(&reads, &level, changes));
        let start = Instant::now();
        let change = async {
            tick_at(&tx, start, &[5.0]).await;
            sleep_until(start + Duration::from_secs(7)).await;
            level.set(7);
            tick_at(&tx, start, &[10.0]).await;
        };
        let got = futures_util::future::join(change, within(&mut items, start, 60))
            .await
            .1;
        let want = [(0, (0, 0)), (0, (0, 1)), (10, (7, 1)), (35, (7, 2))];
        assert_eq!(got, want);
        assert_eq!(
            reads.secs(),
            [0, 5, 35],
            "the tick at 10 s read only the store"
        );
    }
}
