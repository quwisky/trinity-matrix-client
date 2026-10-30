//! How an engine member runs on one account: commands, long-lived streams, and how they send.

use std::sync::Arc;

use futures_util::{StreamExt, stream};
use matrix_sdk::{Client, SendOutsideWasm};
use serde::Serialize;
use serde_json::json;

use crate::{
    accounts::{AccountRuntime, Engine},
    dispatch::{Stream, stream},
};

/// A long-lived account stream. Not live: `empty`, then nothing more. Live: `body` gets the
/// runtime only to set up (keep neither it nor `rt.client`) and the lease's own client; its items
/// flow until the account retires, and then the stream stays open with nothing more (js `NEVER`).
/// `body` and the lease are dropped on retire, or when `body` ends, and the stream stays open
/// after `body` ends too. The account is looked up at the call, as `session.session` subscribes.
pub fn account_stream<T, S>(
    engine: Arc<Engine>,
    account_id: String,
    empty: T,
    body: impl FnOnce(&AccountRuntime, Client) -> S,
) -> Stream
where
    T: Serialize + SendOutsideWasm + 'static,
    S: futures_util::Stream<Item = T> + SendOutsideWasm + 'static,
{
    let Some(rt) = engine.account(&account_id) else {
        return stream(stream::once(async move { Ok(json!(empty)) }).chain(stream::pending()));
    };
    let lease = rt.lease();
    let items = body(&rt, lease.client.clone());
    drop(rt);
    let mut retired = lease.retired.clone();
    let retired = async move {
        let _ = retired.wait_for(|retired| *retired).await;
    };
    let items = items.map(move |v| {
        let _ = &lease;
        Ok(json!(v))
    });
    stream(items.take_until(retired).chain(stream::pending()))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use futures_util::FutureExt;
    use matrix_sdk::{executor::spawn, timeout::timeout};
    use serde_json::Value;
    use tempfile::TempDir;
    use tokio::sync::{mpsc, oneshot};

    use super::*;
    use crate::{
        config::EngineConfig,
        testing::{builder_on, engine_in, live, password},
    };

    const OFFLINE: &str = "http://127.0.0.1:1";

    async fn offline(engine: &Arc<Engine>) -> Arc<AccountRuntime> {
        let client = builder_on(OFFLINE).build().await.unwrap();
        live(engine, &password(OFFLINE), client).await
    }

    /// Forwards the stream's items from a task of its own, as the carrier polls it.
    fn forward(mut items: Stream) -> mpsc::UnboundedReceiver<Value> {
        let (tx, rx) = mpsc::unbounded_channel();
        spawn(async move {
            while let Some(item) = items.next().await {
                let _ = tx.send(item.unwrap());
            }
        });
        rx
    }

    /// A body with one item that then stays open.
    fn one_then_open() -> impl futures_util::Stream<Item = Value> {
        stream::iter([json!(1)]).chain(stream::pending())
    }

    #[tokio::test]
    async fn a_stream_on_an_account_that_is_not_live_emits_empty_then_nothing() {
        let engine = Engine::new(EngineConfig::default()).unwrap();
        let mut items = account_stream(
            engine,
            "@x:y".into(),
            json!("empty"),
            |_, _| -> stream::Empty<Value> { unreachable!() },
        );
        assert_eq!(items.next().await, Some(Ok(json!("empty"))));
        assert!(
            items.next().now_or_never().is_none(),
            "the stream stays open"
        );
    }

    #[tokio::test]
    async fn a_teardown_ends_a_leased_stream_without_waiting_for_it() {
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        drop(offline(&engine).await);
        let items = account_stream(Arc::clone(&engine), "@a:b".into(), json!(null), |_, _| {
            one_then_open()
        });
        let mut rx = forward(items);
        assert_eq!(rx.recv().await, Some(json!(1)));
        let rt = engine.account("@a:b").unwrap();
        assert_eq!(Arc::strong_count(&rt), 2, "only the registry and this read");
        drop(rt);
        let removed = timeout(engine.remove("@a:b"), Duration::from_secs(5)).await;
        assert!(removed.is_ok(), "the teardown waited for the stream");
        let quiet = timeout(rx.recv(), Duration::from_millis(200)).await;
        assert!(quiet.is_err(), "no item and no completion");
    }

    #[tokio::test]
    async fn a_teardown_waits_for_the_lease_of_a_stream_nobody_polls() {
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        drop(offline(&engine).await);
        let items = account_stream(Arc::clone(&engine), "@a:b".into(), json!(null), |_, _| {
            one_then_open()
        });
        let mut removing = Box::pin(engine.remove("@a:b"));
        let early = timeout(removing.as_mut(), Duration::from_millis(200)).await;
        assert!(early.is_err(), "its client is still in use");
        drop(items);
        assert!(timeout(removing, Duration::from_secs(5)).await.is_ok());
    }

    #[tokio::test]
    async fn retire_reaches_a_stream_before_a_queued_teardown_runs() {
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let first = offline(&engine).await;
        // Waits for `first`, which this test holds.
        drop(engine.tear_down("@a:b", Some(Arc::clone(&first)), false));
        drop(offline(&engine).await);
        let (guard, mut guarded) = oneshot::channel::<()>();
        let items = account_stream(Arc::clone(&engine), "@a:b".into(), json!(null), |_, _| {
            one_then_open().map(move |v| {
                let _ = &guard;
                v
            })
        });
        let _rx = forward(items);
        assert_eq!(guarded.try_recv(), Err(oneshot::error::TryRecvError::Empty));
        let removing = spawn({
            let engine = Arc::clone(&engine);
            async move { engine.remove("@a:b").await }
        });
        let ended = timeout(guarded, Duration::from_secs(1)).await;
        assert!(ended.is_ok(), "the body was dropped on retire");
        assert!(!removing.is_finished(), "queued behind the first teardown");
        drop(first);
        assert!(timeout(removing, Duration::from_secs(5)).await.is_ok());
    }
}
