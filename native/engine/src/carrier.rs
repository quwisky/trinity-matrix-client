//! One carrier connection: runs each opened stream and writes its frames to one ordered output.

use std::{
    collections::HashMap,
    fmt,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::Arc,
};

use futures_util::{FutureExt, StreamExt};
use matrix_sdk::{
    executor::{AbortHandle, spawn},
    locks::Mutex,
};
use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;

use crate::{
    accounts::Engine,
    dispatch::{Stream, dispatch},
    wire::{Fault, FaultCode, Frame, Inbound},
};

/// Methods a host serves before the engine's own, such as the test host's `testhost.*`.
pub type LocalMethods = fn(&Arc<Engine>, &str, &[Value]) -> Option<Result<Stream, Fault>>;

/// The running streams by id. The serial tells a stream from a later one under the same id.
type Live = Arc<Mutex<HashMap<u32, (u64, AbortHandle)>>>;

pub struct CarrierSession {
    engine: Arc<Engine>,
    out: UnboundedSender<Frame>,
    local: Option<LocalMethods>,
    live: Live,
    serial: u64,
}

impl CarrierSession {
    pub fn new(engine: Arc<Engine>, out: UnboundedSender<Frame>) -> Self {
        Self {
            engine,
            out,
            local: None,
            live: Live::default(),
            serial: 0,
        }
    }

    pub fn with_local(mut self, f: LocalMethods) -> Self {
        self.local = Some(f);
        self
    }

    pub fn handle(&mut self, msg: Inbound) {
        match msg {
            Inbound::Attach => self.abort_all(),
            Inbound::Open { id, method, args } => self.open(id, &method, args),
            Inbound::Close { id } => {
                if let Some((_, task)) = self.live.lock().remove(&id) {
                    task.abort();
                }
            }
        }
    }

    fn open(&mut self, id: u32, method: &str, args: Vec<Value>) {
        let opened = catch_unwind(AssertUnwindSafe(|| {
            match self
                .local
                .and_then(|local| local(&self.engine, method, &args))
            {
                Some(opened) => opened,
                None => dispatch(&self.engine, method, args),
            }
        }))
        .unwrap_or_else(|_| Err(panicked(method)));
        let mut stream = match opened {
            Ok(stream) => stream,
            Err(fault) => {
                let _ = self.out.send(error_frame(id, fault));
                return;
            }
        };
        self.serial += 1;
        let serial = self.serial;
        let (live, out) = (Arc::clone(&self.live), self.out.clone());
        // Held until the handle is stored, so the task cannot finish and forget itself first.
        let mut table = self.live.lock();
        let method = method.to_owned();
        let task = spawn(async move {
            loop {
                let (frame, last) = match AssertUnwindSafe(stream.next()).catch_unwind().await {
                    Ok(Some(Ok(v))) => (Frame::Next { id, v }, false),
                    Ok(Some(Err(fault))) => (error_frame(id, fault), true),
                    Ok(None) => (Frame::Complete { id }, true),
                    // The payload stays out of the frame, and the test host's panic hook keeps it
                    // out of its log: a panic message can quote any value.
                    Err(_) => (error_frame(id, panicked(&method)), true),
                };
                if !emit(&live, &out, id, serial, frame, last) || last {
                    return;
                }
            }
        });
        if let Some((_, replaced)) = table.insert(id, (serial, task.abort_handle())) {
            replaced.abort();
        }
    }

    fn abort_all(&self) {
        for (_, (_, task)) in self.live.lock().drain() {
            task.abort();
        }
    }
}

impl fmt::Debug for CarrierSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CarrierSession")
            .field("serial", &self.serial)
            .finish_non_exhaustive()
    }
}

impl Drop for CarrierSession {
    fn drop(&mut self) {
        self.abort_all();
    }
}

/// Sends `frame` unless its stream was closed meanwhile, so a close or attach also stops a frame
/// already in flight. A `last` frame also forgets the stream. Returns whether to keep going.
fn emit(
    live: &Live,
    out: &UnboundedSender<Frame>,
    id: u32,
    serial: u64,
    frame: Frame,
    last: bool,
) -> bool {
    let mut table = live.lock();
    if table.get(&id).is_none_or(|(current, _)| *current != serial) {
        return false;
    }
    if last {
        table.remove(&id);
    }
    out.send(frame).is_ok()
}

fn panicked(method: &str) -> Fault {
    Fault::new(FaultCode::Panic, format!("{method} panicked"))
}

fn error_frame(id: u32, fault: Fault) -> Frame {
    let code = fault.code.as_str();
    tracing::warn!(id, code, diagnostic = %fault.diagnostic, "engine stream fault");
    Frame::Error { id, e: fault }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::atomic::{AtomicU32, Ordering},
        task::Poll,
        time::Duration,
    };

    use futures_util::{StreamExt, future::ready, stream};
    use matrix_sdk::{sleep::sleep, timeout::timeout};
    use serde_json::json;
    use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

    use super::*;
    use crate::{
        config::EngineConfig,
        dispatch::{Args, stream},
        wire::FaultKind,
    };

    static SEQUENCE: AtomicU32 = AtomicU32::new(0);

    fn ticks(next: fn(u32) -> u32) -> Stream {
        stream(stream::unfold(0, move |n| async move {
            sleep(Duration::from_millis(10)).await;
            Some((Ok(json!(next(n))), n + 1))
        }))
    }

    fn local(_: &Arc<Engine>, method: &str, args: &[Value]) -> Option<Result<Stream, Fault>> {
        Some(match method {
            "test.once" => Ok(stream(stream::once(ready(Ok(json!(42)))))),
            "test.ticks" => Ok(ticks(|n| n)),
            // Emits a value shared by every open stream, in the order the streams take it.
            "test.sequence" => Ok(stream(
                ticks(|_| SEQUENCE.fetch_add(1, Ordering::SeqCst)).take(5),
            )),
            "test.echo" => {
                let args = &mut Args::new(method, args.to_vec());
                args.decode::<u32>().and_then(|value| {
                    args.finish()?;
                    Ok(stream(stream::once(ready(Ok(json!(value))))))
                })
            }
            "test.open-panics" => panic!("payload-secret"),
            "test.panics" => Ok(stream(stream::poll_fn(
                |_| -> Poll<Option<Result<Value, Fault>>> { panic!("payload-secret") },
            ))),
            _ => return None,
        })
    }

    fn session() -> (CarrierSession, UnboundedReceiver<Frame>) {
        let (out, frames) = unbounded_channel();
        let session = CarrierSession::new(Engine::new(EngineConfig::default()).unwrap(), out);
        (session.with_local(local), frames)
    }

    fn open(id: u32, method: &str, args: Vec<Value>) -> Inbound {
        Inbound::Open {
            id,
            method: method.into(),
            args,
        }
    }

    /// The next frame, or `None` once every sender is gone.
    async fn recv(frames: &mut UnboundedReceiver<Frame>) -> Option<Frame> {
        timeout(frames.recv(), Duration::from_secs(5))
            .await
            .expect("a frame or the end of the output within 5 s")
    }

    async fn next_frame(frames: &mut UnboundedReceiver<Frame>) -> Frame {
        recv(frames).await.expect("a frame")
    }

    /// The frames that arrive within 50 ms, enough for several 10 ms ticks.
    async fn later_frames(frames: &mut UnboundedReceiver<Frame>) -> Vec<Frame> {
        sleep(Duration::from_millis(50)).await;
        let mut received = Vec::new();
        while let Ok(frame) = frames.try_recv() {
            received.push(frame);
        }
        received
    }

    fn drain(frames: &mut UnboundedReceiver<Frame>) {
        while frames.try_recv().is_ok() {}
    }

    fn fault_code(frame: Frame, expected_id: u32) -> FaultCode {
        match frame {
            Frame::Error { id, e } => {
                assert_eq!(id, expected_id);
                assert_eq!(e.kind, FaultKind::Protocol);
                e.code
            }
            frame => panic!("not an error frame: {frame:?}"),
        }
    }

    #[tokio::test]
    async fn open_once_emits_next_then_complete() {
        let (mut session, mut frames) = session();
        session.handle(open(1, "test.once", vec![]));
        assert_eq!(
            next_frame(&mut frames).await,
            Frame::Next {
                id: 1,
                v: json!(42)
            }
        );
        assert_eq!(next_frame(&mut frames).await, Frame::Complete { id: 1 });
    }

    #[tokio::test]
    async fn close_aborts_a_running_stream() {
        let (mut session, mut frames) = session();
        session.handle(open(2, "test.ticks", vec![]));
        assert_eq!(
            next_frame(&mut frames).await,
            Frame::Next { id: 2, v: json!(0) }
        );
        session.handle(Inbound::Close { id: 2 });
        drain(&mut frames);
        assert_eq!(later_frames(&mut frames).await, vec![]);
    }

    #[tokio::test]
    async fn close_of_a_finished_id_is_ignored() {
        let (mut session, mut frames) = session();
        session.handle(open(3, "test.once", vec![]));
        next_frame(&mut frames).await;
        assert_eq!(next_frame(&mut frames).await, Frame::Complete { id: 3 });
        session.handle(Inbound::Close { id: 3 });
        session.handle(Inbound::Close { id: 99 });
        assert_eq!(later_frames(&mut frames).await, vec![]);
    }

    #[tokio::test]
    async fn unknown_method_yields_protocol_error() {
        let (mut session, mut frames) = session();
        session.handle(open(4, "nope.nothing", vec![]));
        assert_eq!(
            fault_code(next_frame(&mut frames).await, 4),
            FaultCode::UnknownMethod
        );
    }

    #[tokio::test]
    async fn bad_args_yield_protocol_error() {
        let (mut session, mut frames) = session();
        session.handle(open(5, "test.echo", vec![json!("x")]));
        let bad = FaultCode::BadArgs;
        assert_eq!(fault_code(next_frame(&mut frames).await, 5), bad);
        session.handle(open(6, "test.echo", vec![]));
        assert_eq!(fault_code(next_frame(&mut frames).await, 6), bad);
        session.handle(open(7, "test.echo", vec![json!(7)]));
        assert_eq!(
            next_frame(&mut frames).await,
            Frame::Next { id: 7, v: json!(7) }
        );
    }

    #[tokio::test]
    async fn attach_aborts_previous_streams() {
        let (mut session, mut frames) = session();
        session.handle(open(8, "test.ticks", vec![]));
        session.handle(open(9, "test.ticks", vec![]));
        next_frame(&mut frames).await;
        session.handle(Inbound::Attach);
        drain(&mut frames);
        assert_eq!(later_frames(&mut frames).await, vec![]);
        // The session still serves streams opened after the attach, even under a reused id.
        session.handle(open(8, "test.once", vec![]));
        assert_eq!(
            next_frame(&mut frames).await,
            Frame::Next {
                id: 8,
                v: json!(42)
            }
        );
    }

    #[tokio::test]
    async fn frames_keep_emission_order_across_streams() {
        let (mut session, mut frames) = session();
        session.handle(open(10, "test.sequence", vec![]));
        session.handle(open(11, "test.sequence", vec![]));
        let mut values = Vec::new();
        let mut ids = Vec::new();
        let mut completed = 0;
        while completed < 2 {
            match next_frame(&mut frames).await {
                Frame::Next { id, v } => {
                    ids.push(id);
                    values.push(v);
                }
                Frame::Complete { .. } => completed += 1,
                frame => panic!("unexpected {frame:?}"),
            }
        }
        assert_eq!(values, (0..10).map(|n| json!(n)).collect::<Vec<_>>());
        let switches = ids.windows(2).filter(|pair| pair[0] != pair[1]).count();
        assert!(switches > 1, "the streams did not interleave: {ids:?}");
    }

    #[tokio::test]
    async fn a_panicking_stream_errors_with_an_internal_fault() {
        let (mut session, mut frames) = session();
        session.handle(open(13, "test.panics", vec![]));
        let Frame::Error { id, e } = next_frame(&mut frames).await else {
            panic!("no error frame");
        };
        assert_eq!(
            (id, e.kind, e.code),
            (13, FaultKind::Internal, FaultCode::Panic)
        );
        assert!(!e.diagnostic.contains("payload-secret"), "{}", e.diagnostic);
        assert_eq!(later_frames(&mut frames).await, vec![]);
    }

    #[tokio::test]
    async fn a_method_that_panics_while_opening_errors_with_an_internal_fault() {
        let (mut session, mut frames) = session();
        session.handle(open(15, "test.open-panics", vec![]));
        let Frame::Error { id, e } = next_frame(&mut frames).await else {
            panic!("no error frame");
        };
        assert_eq!(
            (id, e.kind, e.code),
            (15, FaultKind::Internal, FaultCode::Panic)
        );
        assert!(!e.diagnostic.contains("payload-secret"), "{}", e.diagnostic);
        session.handle(open(16, "test.once", vec![]));
        assert_eq!(
            next_frame(&mut frames).await,
            Frame::Next {
                id: 16,
                v: json!(42)
            }
        );
    }

    #[tokio::test]
    async fn a_command_reply_follows_its_snapshot_on_an_open_session_stream() {
        let (mut session, mut frames) = session();
        session.handle(open(1, "session.session", vec![]));
        session.handle(open(
            2,
            "session.requireReauthentication",
            vec![json!("@x:y")],
        ));
        let snapshot = |soft: Vec<&str>| json!({"activeAccountId": null, "accounts": [], "softLoggedOut": soft});
        let mut received = Vec::new();
        for _ in 0..4 {
            received.push(next_frame(&mut frames).await);
        }
        assert_eq!(
            received,
            [
                Frame::Next {
                    id: 1,
                    v: snapshot(vec![])
                },
                Frame::Next {
                    id: 1,
                    v: snapshot(vec!["@x:y"])
                },
                Frame::Next {
                    id: 2,
                    v: json!(null)
                },
                Frame::Complete { id: 2 },
            ]
        );
    }

    #[tokio::test]
    async fn release_completes_the_hold_stream_before_its_reply() {
        let (mut session, mut frames) = session();
        // Holds work for an account that is not live.
        session.handle(open(1, "session.holdServerLogout", vec![json!("@x:y")]));
        session.handle(open(
            2,
            "session.releaseServerLogoutHold",
            vec![json!("1"), json!(true)],
        ));
        let mut received = Vec::new();
        for _ in 0..4 {
            received.push(next_frame(&mut frames).await);
        }
        assert_eq!(
            received,
            [
                Frame::Next {
                    id: 1,
                    v: json!({"kind": "held", "holdId": "1", "tokenDied": false})
                },
                Frame::Complete { id: 1 },
                Frame::Next {
                    id: 2,
                    v: json!(null)
                },
                Frame::Complete { id: 2 },
            ]
        );
    }

    #[tokio::test]
    async fn dropping_the_session_aborts_its_streams() {
        let (mut session, mut frames) = session();
        session.handle(open(14, "test.ticks", vec![]));
        next_frame(&mut frames).await;
        drop(session);
        drain(&mut frames);
        // The output closes once the aborted tasks have let go of their senders.
        assert_eq!(recv(&mut frames).await, None);
    }
}
