//! Test helpers the engine's modules share: a scripted loopback homeserver, sessions, clients and
//! never-started live runtimes.

use std::{
    io::{self, BufRead, BufReader, Read, Write},
    iter::Peekable,
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex as StdMutex},
    thread,
};

use matrix_sdk::{
    Client, ClientBuilder, SessionMeta, SessionTokens,
    authentication::matrix::MatrixSession,
    config::RequestConfig,
    ruma::{UserId, api::MatrixVersion},
};
use matrix_sdk_ui::sync_service::SyncService;
use serde_json::{Value, json};
use tempfile::TempDir;

use crate::{
    accounts::{AccountRuntime, Engine},
    config::EngineConfig,
    engines::session::{
        MatrixSessionDto,
        restore::{auth_session, session_meta},
    },
};

pub(crate) const WHOAMI: &str = "GET /_matrix/client/v3/account/whoami";

pub(crate) type Seen = Arc<StdMutex<Vec<(String, Option<String>)>>>;

/// A homeserver on loopback that answers the scripted requests in order, and records each
/// one's method and path and its `Authorization`. It names its versions for a client that
/// asks, and any other request, such as the client's own background ones, gets a 404. A 3xx
/// answer's body is the `location` it redirects to. A connection that breaks off gets no answer
/// and costs none, so the script goes on for the requests after it.
pub(crate) fn scripted(answers: Vec<(&'static str, u16, Value)>) -> (String, Seen) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Seen::default();
    let log = Arc::clone(&seen);
    thread::spawn(move || {
        let mut answers = answers.into_iter().peekable();
        while answers.peek().is_some() {
            let Ok((stream, _)) = listener.accept() else {
                return;
            };
            let _ = answer(stream, &mut answers, &log);
        }
    });
    (base, seen)
}

/// Reads one request from `stream` and answers it, taking the next scripted answer if the
/// request is the one it expects.
fn answer(
    mut stream: TcpStream,
    answers: &mut Peekable<impl Iterator<Item = (&'static str, u16, Value)>>,
    log: &Seen,
) -> io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let target = line.split(' ').take(2).collect::<Vec<_>>().join(" ");
    let (mut authorization, mut length) = (None, 0);
    loop {
        line.clear();
        reader.read_line(&mut line)?;
        let Some((name, value)) = line.trim_end().split_once(": ") else {
            break;
        };
        match name.to_ascii_lowercase().as_str() {
            "authorization" => authorization = Some(value.to_owned()),
            "content-length" => length = value.parse().unwrap_or(0),
            _ => {}
        }
    }
    reader.read_exact(&mut vec![0; length])?;
    let (status, body) = match answers.next_if(|(expected, ..)| *expected == target) {
        Some((_, status, body)) => {
            log.lock().unwrap().push((target, authorization));
            (status, body)
        }
        None if target == "GET /_matrix/client/versions" => (200, json!({"versions": ["v1.15"]})),
        None => (404, json!({"errcode": "M_NOT_FOUND", "error": "x"})),
    };
    let (header, body) = match body {
        Value::String(location) if (300..400).contains(&status) => {
            (format!("location: {location}"), String::new())
        }
        body => (
            "content-type: application/json".to_owned(),
            body.to_string(),
        ),
    };
    let reply = format!(
        "HTTP/1.1 {status} X\r\n{header}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(reply.as_bytes())
}

pub(crate) fn requests(seen: &Seen) -> Vec<(String, Option<String>)> {
    seen.lock().unwrap().clone()
}

/// A memory-store client that never asks for the versions and never retries.
pub(crate) fn builder_on(base: &str) -> ClientBuilder {
    Client::builder()
        .homeserver_url(base)
        .server_versions([MatrixVersion::V1_13])
        .request_config(RequestConfig::new().disable_retry())
}

/// A client on the SDK's default request config, as an account's client has, restored with the
/// session as a start restores it: an OAuth account's client is an OAuth one.
pub(crate) async fn default_client(engine: &Arc<Engine>, s: &MatrixSessionDto) -> Client {
    let client = (engine.client_builder().homeserver_url(&s.base_url))
        .server_versions([MatrixVersion::V1_13])
        .build()
        .await
        .unwrap();
    let meta = session_meta("test", s).unwrap();
    client.restore_session(auth_session(s, meta)).await.unwrap();
    client
}

pub(crate) fn engine_in(root: &TempDir) -> Arc<Engine> {
    Engine::new(EngineConfig {
        data_dir: root.path().join("data"),
        cache_dir: root.path().join("cache"),
        ..EngineConfig::default()
    })
    .unwrap()
}

/// A session with `t1`/`r1` that may refresh: Matrix-native refresh needs no OAuth metadata.
pub(crate) fn session(user_id: &str, base_url: &str) -> MatrixSessionDto {
    serde_json::from_value(json!({
        "baseUrl": base_url,
        "userId": user_id,
        "deviceId": "DEV",
        "accessToken": "t1",
        "refreshToken": "r1",
        "oidc": {"issuer": "https://id.example", "clientId": "client"},
    }))
    .unwrap()
}

pub(crate) fn password(base_url: &str) -> MatrixSessionDto {
    let mut password = session("@a:b", base_url);
    (password.oidc, password.refresh_token) = (None, None);
    password
}

/// A runtime of `generation` for `s` on `client`, never started. A client without a session
/// is restored with the session's tokens as a Matrix one.
pub(crate) async fn runtime_on(
    engine: &Arc<Engine>,
    s: &MatrixSessionDto,
    generation: u32,
    client: Client,
) -> AccountRuntime {
    let meta = SessionMeta {
        user_id: UserId::parse(&s.user_id).unwrap(),
        device_id: s.device_id.as_str().into(),
    };
    let tokens = SessionTokens {
        access_token: s.access_token.clone(),
        refresh_token: s.refresh_token.clone(),
    };
    if client.session_meta().is_none() {
        let matrix = MatrixSession { meta, tokens };
        client.restore_session(matrix).await.unwrap();
    }
    let sync = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let all_rooms = sync.room_list_service().all_rooms().await.unwrap();
    let changes = client.subscribe_to_session_changes();
    AccountRuntime::new(engine, s, generation, client, sync, all_rooms, changes)
}

/// Registers a never-started runtime of `s` on `client` as the account's live one.
pub(crate) async fn live(
    engine: &Arc<Engine>,
    s: &MatrixSessionDto,
    client: Client,
) -> Arc<AccountRuntime> {
    let generation = engine
        .state
        .lock()
        .registry
        .register(&s.user_id, &s.device_id);
    let rt = Arc::new(runtime_on(engine, s, generation, client).await);
    let mut state = engine.state.lock();
    state.runtimes.insert(s.user_id.clone(), Arc::clone(&rt));
    let _ = state.publish_snapshot();
    rt
}
