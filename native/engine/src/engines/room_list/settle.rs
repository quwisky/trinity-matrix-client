//! Waiting for a command's effect to show in the SDK's state before the command replies.

use std::{
    future::{pending, ready},
    pin::pin,
    time::Duration,
};

use futures_util::{Stream, StreamExt, future::select, stream};
use matrix_sdk::{
    Client,
    event_handler::EventHandlerDropGuard,
    ruma::{RoomId, events::AnyGlobalAccountDataEvent, serde::Raw},
    timeout::timeout,
};
use tokio::sync::{broadcast::error::RecvError, mpsc, watch};

pub(crate) const SETTLE_LIMIT: Duration = Duration::from_secs(15);

/// Until `done` holds, `retired` turns true, or `SETTLE_LIMIT` passes; a timeout is logged and is
/// no error, so the command still replies. `done` runs first, then after each item of `changes`,
/// which the caller subscribed before calling, so no change falls between the two. Once `changes`
/// ends, nothing can make `done` hold, so retire or the limit decides.
pub(crate) async fn settle<F: Future<Output = bool>>(
    mut retired: watch::Receiver<bool>,
    mut changes: impl Stream<Item = ()> + Unpin,
    mut done: impl FnMut() -> F,
) {
    let holds = async {
        while !done().await {
            if changes.next().await.is_none() {
                pending::<()>().await;
            }
        }
    };
    // A dropped sender is a runtime that is gone, which retires too.
    let retired = async {
        let _ = retired.wait_for(|retired| *retired).await;
    };
    if timeout(select(pin!(holds), pin!(retired)), SETTLE_LIMIT)
        .await
        .is_err()
    {
        tracing::warn!("a settle gave up after {SETTLE_LIMIT:?}");
    }
}

/// Notable updates of `room_id`; a lag counts as a change. Every room in a sync response gets
/// one, so this covers a room's membership, tags, state and arrival.
pub(crate) fn room_changes(
    client: &Client,
    room_id: &RoomId,
) -> impl Stream<Item = ()> + Unpin + use<> {
    let (room_id, mut updates) = (
        room_id.to_owned(),
        client.room_info_notable_update_receiver(),
    );
    Box::pin(async_stream::stream! {
        loop {
            match updates.recv().await {
                Ok(update) if update.room_id != room_id => {}
                Ok(_) | Err(RecvError::Lagged(_)) => yield (),
                Err(RecvError::Closed) => return,
            }
        }
    })
}

/// Global account-data events of `event_type`. This is no `observe_events`, which keeps only the
/// newest event: one sync response can carry several, and a change would be lost.
pub(crate) fn account_data_changes(
    client: &Client,
    event_type: &'static str,
) -> impl Stream<Item = ()> + Unpin + use<> {
    let (changed, mut changes) = mpsc::unbounded_channel();
    let guard = on_account_data(client, event_type, changed);
    stream::poll_fn(move |cx| {
        let _ = &guard;
        changes.poll_recv(cx)
    })
}

/// A client handler that sends on `changed` for each global account-data event of `event_type`,
/// until the guard drops.
fn on_account_data(
    client: &Client,
    event_type: &'static str,
    changed: mpsc::UnboundedSender<()>,
) -> EventHandlerDropGuard {
    let handle = client.add_event_handler(move |event: Raw<AnyGlobalAccountDataEvent>| {
        if matches!(event.get_field::<String>("type"), Ok(Some(t)) if t == event_type) {
            let _ = changed.send(());
        }
        ready(())
    });
    client.event_handler_drop_guard(handle)
}

#[cfg(test)]
mod tests {
    use std::{cell::Cell, future::ready, pin::pin};

    use futures_util::FutureExt;
    use matrix_sdk::ruma::room_id;
    use serde_json::{Value, json};
    use tempfile::TempDir;
    use tokio::{sync::mpsc, time::Instant};

    use super::*;
    use crate::testing::{engine_in, sync, syncing};

    /// Changes fed by hand.
    fn feed() -> (mpsc::UnboundedSender<()>, impl Stream<Item = ()> + Unpin) {
        let (tx, mut rx) = mpsc::unbounded_channel();
        (tx, stream::poll_fn(move |cx| rx.poll_recv(cx)))
    }

    #[tokio::test(start_paused = true)]
    async fn settle_returns_once_done_holds_after_a_change() {
        let (_retire, retired) = watch::channel(false);
        let (change, changes) = feed();
        let held = Cell::new(false);
        let start = Instant::now();
        let mut settling = pin!(settle(retired, changes, || ready(held.get())));
        assert!(settling.as_mut().now_or_never().is_none(), "done fails");
        change.send(()).unwrap();
        assert!(settling.as_mut().now_or_never().is_none(), "still fails");
        held.set(true);
        change.send(()).unwrap();
        settling.await;
        assert_eq!(start.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn settle_returns_at_once_when_done_already_holds() {
        let (_retire, retired) = watch::channel(false);
        settle(retired, stream::pending::<()>(), || ready(true)).await;
    }

    #[test]
    fn a_settle_can_run_in_a_command() {
        fn sendable(_: impl Future<Output = ()> + Send) {}
        let (_retire, retired) = watch::channel(false);
        sendable(settle(retired, stream::pending::<()>(), || ready(true)));
    }

    #[tokio::test(start_paused = true)]
    async fn settle_returns_when_the_runtime_retires() {
        let (retire, retired) = watch::channel(false);
        let start = Instant::now();
        let mut settling = pin!(settle(retired, stream::pending::<()>(), || ready(false)));
        assert!(settling.as_mut().now_or_never().is_none());
        retire.send_replace(true);
        settling.await;
        assert_eq!(start.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn settle_returns_when_the_runtime_is_gone() {
        let (retire, retired) = watch::channel(false);
        let start = Instant::now();
        let mut settling = pin!(settle(retired, stream::pending::<()>(), || ready(false)));
        assert!(settling.as_mut().now_or_never().is_none());
        drop(retire);
        settling.await;
        assert_eq!(start.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn settle_waits_for_retire_or_the_limit_once_its_changes_end() {
        let (_retire, retired) = watch::channel(false);
        let start = Instant::now();
        settle(retired, stream::empty::<()>(), || ready(false)).await;
        assert_eq!(start.elapsed(), SETTLE_LIMIT);
    }

    #[tokio::test(start_paused = true)]
    async fn settle_gives_up_after_fifteen_seconds() {
        let (_retire, retired) = watch::channel(false);
        let start = Instant::now();
        settle(retired, stream::pending::<()>(), || ready(false)).await;
        assert_eq!(start.elapsed(), Duration::from_secs(15));
    }

    #[tokio::test]
    async fn room_changes_report_only_their_room() {
        let touched = |room: &str| json!({"rooms": {"join": {room: {}}}});
        let root = TempDir::new().unwrap();
        let rt = syncing(&engine_in(&root), vec![touched("!s:b"), touched("!r:b")]).await;
        let mut changes = room_changes(&rt.client, room_id!("!r:b"));
        sync(&rt.client).await;
        assert!(changes.next().now_or_never().is_none(), "another room");
        sync(&rt.client).await;
        assert_eq!(changes.next().now_or_never(), Some(Some(())));
    }

    #[tokio::test]
    async fn account_data_changes_report_each_event_of_their_type() {
        let events = |types: &[&str]| -> Value {
            let events: Vec<_> = types
                .iter()
                .map(|t| json!({"type": t, "content": {}}))
                .collect();
            json!({"account_data": {"events": events}})
        };
        let root = TempDir::new().unwrap();
        let syncs = vec![
            events(&["org.example.other"]),
            events(&["m.direct", "org.example.other"]),
        ];
        let rt = syncing(&engine_in(&root), syncs).await;
        let mut changes = account_data_changes(&rt.client, "m.direct");
        sync(&rt.client).await;
        assert!(changes.next().now_or_never().is_none(), "another type");
        sync(&rt.client).await;
        assert_eq!(changes.next().now_or_never(), Some(Some(())));
        assert!(changes.next().now_or_never().is_none(), "one event");
    }

    #[tokio::test]
    async fn dropping_the_guard_removes_the_handler_while_the_client_lives() {
        let root = TempDir::new().unwrap();
        let rt = syncing(&engine_in(&root), vec![]).await;
        let (changed, mut changes) = mpsc::unbounded_channel();
        drop(on_account_data(&rt.client, "m.direct", changed));
        let closed = timeout(changes.recv(), Duration::from_secs(5)).await;
        assert!(matches!(closed, Ok(None)), "the handler kept its sender");
    }
}
