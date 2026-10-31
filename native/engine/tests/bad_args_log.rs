//! Alone in its own test binary: tracing caches each callsite's interest per process, so a
//! scoped subscriber can miss an event that parallel tests also reach.

use std::{
    io,
    sync::{Arc, Mutex},
};

use futures_util::{future::ready, stream};
use serde_json::{Value, json};
use tokio::sync::mpsc::unbounded_channel;
use trinity_engine::{
    accounts::Engine,
    carrier::CarrierSession,
    config::EngineConfig,
    dispatch::{Args, Stream, stream},
    wire::{Fault, FaultCode, Frame, Inbound},
};

fn echo(
    _: &Arc<Engine>,
    method: &str,
    args: &[Value],
    _: &mut Vec<Vec<u8>>,
) -> Option<Result<Stream, Fault>> {
    let args = &mut Args::new(method, args.to_vec());
    Some(args.decode::<u32>().and_then(|value| {
        args.finish()?;
        Ok(stream(stream::once(ready(Ok(json!(value))))))
    }))
}

#[derive(Clone, Default)]
struct Log(Arc<Mutex<Vec<u8>>>);

impl io::Write for Log {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut log = (self.0.lock()).map_err(|_| io::Error::other("the log lock is poisoned"))?;
        log.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn bad_args_never_echo_a_value() {
    let (out, mut frames) = unbounded_channel();
    let mut session =
        CarrierSession::new(Engine::new(EngineConfig::default()).unwrap(), out).with_local(echo);
    let log = Log::default();
    let writer = log.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    tracing::subscriber::with_default(subscriber, || {
        session.handle(Inbound::Open {
            id: 1,
            method: "test.echo".into(),
            args: vec![json!("secret-token-123"), json!(5)],
        });
    });
    let Ok(Frame::Error { e, .. }) = frames.try_recv() else {
        panic!("no error frame");
    };
    assert_eq!(e.code, FaultCode::BadArgs);
    assert_eq!(e.diagnostic, "test.echo: arg 0: expected u32, found string");
    let log = String::from_utf8(log.0.lock().unwrap().clone()).unwrap();
    assert!(log.contains("bad-args"), "{log}");
    assert!(!log.contains("secret-token-123"), "{log}");
}
