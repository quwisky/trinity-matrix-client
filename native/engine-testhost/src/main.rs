//! The engine over stdio for the contract suites: one `Inbound` JSON per stdin line in, one `Frame`
//! JSON per stdout line out. Logs go to stderr, so stdout carries nothing but frames.

use std::{sync::Arc, time::Duration};

use futures_util::{StreamExt, future::ready, stream};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, stdin, stdout},
    sync::mpsc::unbounded_channel,
};
use tracing_subscriber::{EnvFilter, filter::LevelFilter};
use trinity_engine::{
    accounts::{Engine, StartAccount},
    carrier::CarrierSession,
    config::EngineConfig,
    dispatch::{Args, Stream, stream},
    failure::EngineResult,
    wire::Fault,
};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            EnvFilter::builder()
                .with_default_directive(LevelFilter::WARN.into())
                .from_env_lossy(),
        )
        .init();
    // Only the location: a panic message can quote any value, access tokens included.
    std::panic::set_hook(Box::new(|info| {
        let at = info.location().map(ToString::to_string);
        tracing::error!(at = at.as_deref().unwrap_or("unknown"), "panicked");
    }));
    let config = EngineConfig {
        insecure_tls: std::env::var("TRINITY_ENGINE_INSECURE_TLS").as_deref() == Ok("1"),
    };
    let (out, mut frames) = unbounded_channel();
    let mut session = CarrierSession::new(Engine::new(config), out).with_local(local);
    let writer = tokio::spawn(async move {
        let mut stdout = stdout();
        while let Some(frame) = frames.recv().await {
            let mut line = serde_json::to_vec(&frame).expect("a frame serializes");
            line.push(b'\n');
            if stdout.write_all(&line).await.is_err() || stdout.flush().await.is_err() {
                break;
            }
        }
    });
    let mut lines = BufReader::new(stdin()).lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(err) => {
                tracing::warn!(kind = ?err.kind(), "stdin read failed");
                break;
            }
        };
        match serde_json::from_str(&line) {
            Ok(inbound) => session.handle(inbound),
            // Only the category: the error's text can quote the line, which carries access tokens.
            Err(err) => tracing::warn!(category = ?err.classify(), "unreadable inbound line"),
        }
    }
    // The writer ends once the aborted streams have let go of the output.
    drop(session);
    let _ = writer.await;
}

/// The test host's own methods, served before the engine's.
fn local(engine: &Arc<Engine>, method: &str, args: &[Value]) -> Option<Result<Stream, Fault>> {
    let serve: fn(Arc<Engine>, &mut Args<'_>) -> Result<Stream, Fault> = match method {
        "testhost.startAccount" => start_account,
        "testhost.echo" => echo,
        "testhost.ticks" => ticks,
        _ => return None,
    };
    let args = &mut Args::new(method, args.to_vec());
    Some(serve(Arc::clone(engine), args).and_then(|stream| args.finish().map(|()| stream)))
}

/// Emits `{ ok: true, value: null }` once the account's room list has loaded, or the failure.
fn start_account(engine: Arc<Engine>, args: &mut Args<'_>) -> Result<Stream, Fault> {
    let start: StartAccount = args.decode()?;
    Ok(stream(stream::once(async move {
        let result = match engine.start_account(start).await {
            Ok(()) => EngineResult::Ok(()),
            Err(failure) => EngineResult::Err(failure),
        };
        Ok(json!(result))
    })))
}

fn echo(_: Arc<Engine>, args: &mut Args<'_>) -> Result<Stream, Fault> {
    let value: Value = args.decode()?;
    Ok(stream(stream::once(ready(Ok(value)))))
}

/// Emits 0, 1, 2… one per `intervalMs` until closed.
fn ticks(_: Arc<Engine>, args: &mut Args<'_>) -> Result<Stream, Fault> {
    let period = Duration::from_millis(args.decode()?);
    Ok(stream(stream::iter(0u64..).then(move |n| async move {
        tokio::time::sleep(period).await;
        Ok(json!(n))
    })))
}
