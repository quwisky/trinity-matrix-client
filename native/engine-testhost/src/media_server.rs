//! The test host's media server: `Engine::media_bytes` over HTTP on loopback, one request per
//! connection. A token is a capability, so a path is never logged, and a miss is one constant
//! answer whatever it held. Piece 3's `trinity-media://` must send the same `safe_headers!`, and if
//! it sets CORS must name the exact app origin, never `*`, because `readOnce` uses `fetch(url)`.

use std::{net::Ipv4Addr, sync::Arc, time::Duration};

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinSet,
    time::{sleep, timeout},
};
use trinity_engine::{accounts::Engine, engines::media::tokens::MediaBytes};

const MAX_HEAD: usize = 8 * 1024;
const HEAD_LIMIT: Duration = Duration::from_secs(5);
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);

/// A macro, as `concat!` takes only literals.
macro_rules! safe_headers {
    () => {
        "Connection: close\r\n\
         Cache-Control: no-store\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Content-Security-Policy: default-src 'none'; sandbox\r\n"
    };
}

macro_rules! empty_answer {
    ($status:literal) => {
        concat!(
            "HTTP/1.1 ",
            $status,
            "\r\n",
            safe_headers!(),
            "Content-Length: 0\r\n\r\n"
        )
    };
}

const METHOD_NOT_ALLOWED: &str = empty_answer!("405 Method Not Allowed");
const FORBIDDEN: &str = empty_answer!("403 Forbidden");
const NOT_FOUND: &str = empty_answer!("404 Not Found");

/// Binds 127.0.0.1 on a free port: the listener and the URL prefix, `http://127.0.0.1:<port>/`.
pub(crate) async fn bind() -> std::io::Result<(TcpListener, String)> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let prefix = format!("http://{}/", listener.local_addr()?);
    Ok((listener, prefix))
}

pub(crate) async fn serve(listener: TcpListener, engine: Arc<Engine>) {
    serve_with(listener, move |token| engine.media_bytes(token)).await;
}

/// Generic over the lookup, so a socket test needs no `Engine`: `Engine.media` and
/// `MediaTokens::mint` are `pub(crate)`.
async fn serve_with(
    listener: TcpListener,
    lookup: impl Fn(&str) -> Option<MediaBytes> + Send + Sync + 'static,
) {
    let authority = match listener.local_addr() {
        Ok(addr) => addr.to_string(),
        Err(err) => {
            tracing::warn!(kind = ?err.kind(), "the media server has no address");
            return;
        }
    };
    let lookup = Arc::new(lookup);
    // In a set, so ending this future ends every connection and its reference to the lookup.
    let mut connections = JoinSet::new();
    loop {
        let mut stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(err) => {
                tracing::warn!(kind = ?err.kind(), "the media server cannot accept");
                // A persistent failure, such as no descriptors left, would otherwise spin.
                sleep(ACCEPT_BACKOFF).await;
                continue;
            }
        };
        while connections.try_join_next().is_some() {}
        let authority = authority.clone();
        let lookup = Arc::clone(&lookup);
        // shortcut: no connection limit and no write timeout, so a local client that stops reading
        // holds its copy of the bytes until the process ends; upgrade if this serves beyond tests.
        connections.spawn(async move {
            let Some(head) = read_head(&mut stream, HEAD_LIMIT).await else {
                failed("head");
                return;
            };
            let Some(answer) = respond(&head, &authority, &*lookup) else {
                return;
            };
            if stream.write_all(&answer).await.is_err() {
                failed("write");
            }
        });
    }
}

/// The head through its blank line, or `None` if it is not text, is over `MAX_HEAD`, or isn't
/// complete within `limit`, which bounds the whole read and not each byte.
async fn read_head(stream: &mut TcpStream, limit: Duration) -> Option<String> {
    let mut head = vec![0; MAX_HEAD + 1];
    let read = async {
        let mut filled = 0;
        while filled <= MAX_HEAD {
            let more = stream.read(&mut head[filled..]).await.ok()?;
            if more == 0 {
                return None;
            }
            filled += more;
            let end = head[..filled].windows(4).position(|w| w == b"\r\n\r\n");
            if let Some(end) = end {
                return Some(end + 4);
            }
        }
        None
    };
    let end = timeout(limit, read).await.ok()??;
    if end > MAX_HEAD {
        return None;
    }
    head.truncate(end);
    String::from_utf8(head).ok()
}

/// The answer to one request head. `None`: drop the connection.
fn respond(
    head: &str,
    authority: &str,
    lookup: impl Fn(&str) -> Option<MediaBytes>,
) -> Option<Vec<u8>> {
    let mut lines = head.split("\r\n");
    let parts: Vec<_> = lines.next()?.split(' ').collect();
    let (method, target) = match parts[..] {
        [method, target, "HTTP/1.0" | "HTTP/1.1"] if !method.is_empty() && !target.is_empty() => {
            (method, target)
        }
        _ => {
            failed("request-line");
            return None;
        }
    };
    if method != "GET" {
        failed("method");
        return Some(METHOD_NOT_ALLOWED.into());
    }
    // Refused before the lookup, so a page reaching this port through DNS rebinding learns nothing.
    let mut hosts = lines
        .filter_map(|line| line.split_once(':'))
        .filter(|(name, _)| name.trim().eq_ignore_ascii_case("host"))
        .map(|(_, value)| value.trim_matches([' ', '\t']));
    if hosts.next() != Some(authority) || hosts.next().is_some() {
        failed("host");
        return Some(FORBIDDEN.into());
    }
    let Some(found) = target.strip_prefix('/').and_then(lookup) else {
        failed("not-found");
        return Some(NOT_FOUND.into());
    };
    let mut answer = format!(
        concat!(
            "HTTP/1.1 200 OK\r\n",
            safe_headers!(),
            "Content-Type: {}\r\nContent-Length: {}\r\n\r\n"
        ),
        found.mime,
        found.bytes.len()
    )
    .into_bytes();
    answer.extend_from_slice(&found.bytes);
    Some(answer)
}

/// `'static`, so a request's text cannot reach the log.
fn failed(category: &'static str) {
    tracing::debug!(category, "media request failed");
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashSet,
        env,
        net::{IpAddr, SocketAddr},
        process::Command,
        sync::{
            Mutex,
            atomic::{AtomicUsize, Ordering},
        },
    };

    use super::*;

    const AUTHORITY: &str = "127.0.0.1:4242";
    const LOG_PROBE: &str = "TRINITY_MEDIA_LOG_PROBE";

    fn live() -> String {
        "ab".repeat(32)
    }

    fn png() -> MediaBytes {
        MediaBytes {
            mime: "image/png".to_owned(),
            bytes: b"hello".as_slice().into(),
        }
    }

    fn get(target: &str, host: &str) -> String {
        format!("GET {target} HTTP/1.1\r\nHost: {host}\r\n\r\n")
    }

    /// Answers only `live()`.
    fn only_live(token: &str) -> Option<MediaBytes> {
        (token == live()).then(png)
    }

    fn answer_text(head: &str) -> Option<String> {
        respond(head, AUTHORITY, only_live).map(|answer| String::from_utf8(answer).unwrap())
    }

    /// A served lookup over a set of live tokens: removing one is the released token.
    async fn served(tokens: &[String]) -> (SocketAddr, Arc<Mutex<HashSet<String>>>) {
        let live = Arc::new(Mutex::new(tokens.iter().cloned().collect::<HashSet<_>>()));
        let (listener, _) = bind().await.unwrap();
        let addr = listener.local_addr().unwrap();
        let table = Arc::clone(&live);
        tokio::spawn(serve_with(listener, move |token| {
            table.lock().unwrap().contains(token).then(png)
        }));
        (addr, live)
    }

    /// What the server says to `request` before it closes; a reset counts as nothing more.
    async fn exchange(addr: SocketAddr, request: &[u8]) -> Vec<u8> {
        let mut client = TcpStream::connect(addr).await.unwrap();
        client.write_all(request).await.unwrap();
        let mut answer = Vec::new();
        let _ = client.read_to_end(&mut answer).await;
        answer
    }

    async fn socket_pair() -> (TcpStream, TcpStream) {
        let (listener, _) = bind().await.unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap());
        let (client, accepted) = tokio::join!(client, listener.accept());
        (client.unwrap(), accepted.unwrap().0)
    }

    #[tokio::test]
    async fn binds_only_the_loopback_address() {
        let (listener, prefix) = bind().await.unwrap();
        let addr = listener.local_addr().unwrap();
        assert_eq!(addr.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert_ne!(addr.port(), 0);
        assert_eq!(prefix, format!("http://127.0.0.1:{}/", addr.port()));
    }

    #[test]
    fn what_is_not_a_request_line_drops_the_connection() {
        let target = format!("/{}", live());
        for head in [
            "".to_owned(),
            "garbage\r\n\r\n".to_owned(),
            format!("GET {target}\r\n\r\n"),
            format!("GET {target} HTTP/1.1 extra\r\nHost: {AUTHORITY}\r\n\r\n"),
            format!("GET  {target} HTTP/1.1\r\nHost: {AUTHORITY}\r\n\r\n"),
            format!("GET {target} HTTP/2.0\r\nHost: {AUTHORITY}\r\n\r\n"),
            format!("GET {target} FTP/1.1\r\nHost: {AUTHORITY}\r\n\r\n"),
            format!(" {target} HTTP/1.1\r\nHost: {AUTHORITY}\r\n\r\n"),
            format!("GET  HTTP/1.1\r\nHost: {AUTHORITY}\r\n\r\n"),
            format!("GET {target} HTTP/1.1\nHost: {AUTHORITY}\r\n\r\n"),
        ] {
            assert_eq!(answer_text(&head), None, "{head:?}");
        }
    }

    #[test]
    fn another_method_is_405_empty() {
        let target = format!("/{}", live());
        for head in [
            format!("POST {target} HTTP/1.1\r\nHost: {AUTHORITY}\r\n\r\n"),
            format!("HEAD {target} HTTP/1.1\r\nHost: {AUTHORITY}\r\n\r\n"),
            format!("OPTIONS {target} HTTP/1.1\r\nHost: {AUTHORITY}\r\n\r\n"),
            format!("get {target} HTTP/1.1\r\nHost: {AUTHORITY}\r\n\r\n"),
            // The method comes first: no host at all is still a 405.
            format!("POST {target} HTTP/1.1\r\n\r\n"),
        ] {
            assert_eq!(
                answer_text(&head).as_deref(),
                Some(METHOD_NOT_ALLOWED),
                "{head:?}"
            );
        }
    }

    #[test]
    fn a_host_that_is_not_exact_is_403_empty() {
        let target = format!("/{}", live());
        let request = format!("GET {target} HTTP/1.1\r\n");
        for headers in [
            "".to_owned(),
            "Host:\r\n".to_owned(),
            "Host: localhost:4242\r\n".to_owned(),
            "Host: 127.0.0.1\r\n".to_owned(),
            "Host: 127.0.0.1:4243\r\n".to_owned(),
            "Host: 127.0.0.1:42420\r\n".to_owned(),
            "Host: 127.0.0.1:4242.evil.example\r\n".to_owned(),
            "Host: evil.example\r\n".to_owned(),
            "Host: [::1]:4242\r\n".to_owned(),
            format!("Host: {AUTHORITY}\r\nHost: {AUTHORITY}\r\n"),
            format!("Host: evil.example\r\nHost: {AUTHORITY}\r\n"),
            format!("Host: {AUTHORITY}\r\nhost: evil.example\r\n"),
            format!("Host: {AUTHORITY}\r\nHost : evil.example\r\n"),
            format!("Host : evil.example\r\nHost: {AUTHORITY}\r\n"),
            format!("Host: {AUTHORITY}, evil.example\r\n"),
        ] {
            let head = format!("{request}{headers}\r\n");
            assert_eq!(answer_text(&head).as_deref(), Some(FORBIDDEN), "{head:?}");
        }
    }

    #[test]
    fn a_host_header_matches_in_any_case_with_any_padding() {
        let target = format!("/{}", live());
        for line in [
            format!("Host: {AUTHORITY}"),
            format!("HOST: {AUTHORITY}"),
            format!("host:{AUTHORITY}"),
            format!("Host: \t{AUTHORITY} \t"),
        ] {
            let head = format!("GET {target} HTTP/1.0\r\nAccept: */*\r\n{line}\r\n\r\n");
            let answer = answer_text(&head).unwrap();
            assert!(answer.starts_with("HTTP/1.1 200 "), "{head:?}");
        }
    }

    #[test]
    fn a_miss_is_the_one_404() {
        for target in ["/", "/nope", "*", "http://127.0.0.1:4242/", "nope"] {
            let answer = answer_text(&get(target, AUTHORITY));
            assert_eq!(answer.as_deref(), Some(NOT_FOUND), "{target}");
        }
        // An absolute target holds the live token, and still misses.
        let absolute = format!("http://{AUTHORITY}/{}", live());
        assert_eq!(
            answer_text(&get(&absolute, AUTHORITY)).as_deref(),
            Some(NOT_FOUND)
        );
    }

    #[test]
    fn the_lookup_gets_only_what_follows_the_first_slash() {
        let seen = Mutex::new(Vec::new());
        for target in ["/a", "//a", "/a/b?c=d#e", "/%2e%2e/", "/"] {
            respond(&get(target, AUTHORITY), AUTHORITY, |token| {
                seen.lock().unwrap().push(token.to_owned());
                None
            });
        }
        assert_eq!(
            *seen.lock().unwrap(),
            ["a", "/a", "a/b?c=d#e", "%2e%2e/", ""]
        );
    }

    #[test]
    fn every_refusal_is_empty_with_the_safe_headers() {
        for (refusal, status) in [
            (METHOD_NOT_ALLOWED, "405 Method Not Allowed"),
            (FORBIDDEN, "403 Forbidden"),
            (NOT_FOUND, "404 Not Found"),
        ] {
            // Whole, as for a hit.
            assert_eq!(
                refusal,
                format!(
                    "HTTP/1.1 {status}\r\n\
                     Connection: close\r\n\
                     Cache-Control: no-store\r\n\
                     X-Content-Type-Options: nosniff\r\n\
                     Content-Security-Policy: default-src 'none'; sandbox\r\n\
                     Content-Length: 0\r\n\
                     \r\n"
                )
            );
        }
    }

    #[tokio::test]
    async fn a_hit_has_the_safe_headers() {
        let token = live();
        let (addr, _) = served(std::slice::from_ref(&token)).await;
        let request = get(&format!("/{token}"), &addr.to_string());
        let answer = exchange(addr, request.as_bytes()).await;
        // Whole, so a `Date`, a CORS header or a `Range` header cannot join unnoticed.
        assert_eq!(
            String::from_utf8(answer).unwrap(),
            "HTTP/1.1 200 OK\r\n\
             Connection: close\r\n\
             Cache-Control: no-store\r\n\
             X-Content-Type-Options: nosniff\r\n\
             Content-Security-Policy: default-src 'none'; sandbox\r\n\
             Content-Type: image/png\r\n\
             Content-Length: 5\r\n\
             \r\n\
             hello"
        );
    }

    #[tokio::test]
    async fn every_bad_token_gets_the_same_bytes() {
        let token = live();
        let released = "cd".repeat(32);
        let (addr, table) = served(&[token.clone(), released.clone()]).await;
        let host = addr.to_string();
        let ask = |target: String| {
            let request = get(&target, &host);
            async move { exchange(addr, request.as_bytes()).await }
        };

        assert!(
            ask(format!("/{released}"))
                .await
                .starts_with(b"HTTP/1.1 200 ")
        );
        table.lock().unwrap().remove(&released);

        let first = ask(format!("/{}", "ef".repeat(32))).await;
        assert_eq!(first, NOT_FOUND.as_bytes());
        for target in [
            format!("/{released}"),
            format!("/{}", &token[..63]),
            format!("/{token}a"),
            format!("/{}", token.to_ascii_uppercase()),
            "/".to_owned(),
            format!("/{token}/x"),
            format!("/{token}?x=1"),
            "/%2e%2e/".to_owned(),
        ] {
            assert_eq!(ask(target.clone()).await, first, "{target}");
        }
        // The misses above are not a dead server.
        assert!(ask(format!("/{token}")).await.starts_with(b"HTTP/1.1 200 "));
    }

    #[test]
    fn method_and_host_are_refused_before_any_lookup() {
        let calls = AtomicUsize::new(0);
        let lookup = |token: &str| {
            calls.fetch_add(1, Ordering::SeqCst);
            only_live(token)
        };
        let live_target = format!("/{}", live());
        let unknown_target = format!("/{}", "ef".repeat(32));
        let post = |target: &str| format!("POST {target} HTTP/1.1\r\nHost: {AUTHORITY}\r\n\r\n");

        assert_eq!(
            respond(&post(&live_target), AUTHORITY, lookup),
            respond(&post(&unknown_target), AUTHORITY, lookup),
        );
        assert_eq!(
            respond(&get(&live_target, "evil.example"), AUTHORITY, lookup),
            respond(&get(&unknown_target, "evil.example"), AUTHORITY, lookup),
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        assert!(respond(&get(&live_target, AUTHORITY), AUTHORITY, lookup).is_some());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// A complete request of exactly `len` bytes, padded in a header.
    fn request_of(len: usize, target: &str, host: &str) -> String {
        let bare = get(target, host);
        let pad = "X-Pad: \r\n";
        let filler = "a".repeat(len - bare.len() - pad.len());
        get(target, &format!("{host}\r\nX-Pad: {filler}"))
    }

    #[tokio::test]
    async fn an_oversized_head_is_dropped() {
        let token = live();
        let (addr, _) = served(std::slice::from_ref(&token)).await;
        let (target, host) = (format!("/{token}"), addr.to_string());

        let at_limit = request_of(MAX_HEAD, &target, &host);
        assert_eq!(at_limit.len(), 8 * 1024);
        assert!(
            exchange(addr, at_limit.as_bytes())
                .await
                .starts_with(b"HTTP/1.1 200 ")
        );

        let over = request_of(MAX_HEAD + 1, &target, &host);
        assert_eq!(over.len(), 8 * 1024 + 1);
        assert_eq!(exchange(addr, over.as_bytes()).await, b"");

        // Never a terminator at all, and the client stays to listen.
        let endless = "a".repeat(MAX_HEAD + 1);
        assert_eq!(exchange(addr, endless.as_bytes()).await, b"");
    }

    #[tokio::test]
    async fn a_silent_client_is_dropped() {
        // The outer limit fails a read that ends, but not by `limit`.
        let dropped = |server| async move {
            let mut server: TcpStream = server;
            let head = read_head(&mut server, Duration::from_millis(50));
            assert_eq!(timeout(Duration::from_secs(2), head).await, Ok(None));
        };
        let (_client, server) = socket_pair().await;
        dropped(server).await;

        let (mut client, server) = socket_pair().await;
        client.write_all(b"GET / HTTP/1.1\r\n").await.unwrap();
        dropped(server).await;
    }

    #[tokio::test]
    async fn a_trickling_client_gets_no_more_time() {
        let (mut client, mut server) = socket_pair().await;
        let trickle = tokio::spawn(async move {
            while client.write_all(b"a").await.is_ok() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        });
        let head = timeout(
            Duration::from_secs(4),
            read_head(&mut server, Duration::from_millis(100)),
        );
        assert_eq!(head.await, Ok(None));
        trickle.abort();
    }

    #[tokio::test]
    async fn read_head_keeps_the_head_and_nothing_after_it() {
        let (mut client, mut server) = socket_pair().await;
        client
            .write_all(b"GET / HTTP/1.1\r\nA: b\r\n\r\nbody")
            .await
            .unwrap();
        let head = read_head(&mut server, Duration::from_secs(4)).await;
        assert_eq!(head.as_deref(), Some("GET / HTTP/1.1\r\nA: b\r\n\r\n"));
    }

    #[tokio::test]
    async fn a_head_split_across_writes_is_read_whole() {
        let (mut client, mut server) = socket_pair().await;
        let write = async {
            client.write_all(b"GET / HTTP/1.1\r\n\r").await.unwrap();
            client.flush().await.unwrap();
            tokio::time::sleep(Duration::from_millis(20)).await;
            client.write_all(b"\n").await.unwrap();
        };
        let (head, ()) = tokio::join!(read_head(&mut server, Duration::from_secs(4)), write);
        assert_eq!(head.as_deref(), Some("GET / HTTP/1.1\r\n\r\n"));
    }

    #[tokio::test]
    async fn a_head_that_is_not_text_or_ends_early_is_dropped() {
        let (mut client, mut server) = socket_pair().await;
        client
            .write_all(b"GET /\xff HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        assert_eq!(read_head(&mut server, Duration::from_secs(4)).await, None);

        let (mut client, mut server) = socket_pair().await;
        client.write_all(b"GET / HTTP/1.1\r\n").await.unwrap();
        drop(client);
        assert_eq!(read_head(&mut server, Duration::from_secs(4)).await, None);
    }

    #[tokio::test]
    async fn a_silent_client_does_not_hold_up_another() {
        let token = live();
        let (addr, _) = served(std::slice::from_ref(&token)).await;
        let _silent = TcpStream::connect(addr).await.unwrap();
        tokio::task::yield_now().await;
        let request = get(&format!("/{token}"), &addr.to_string());
        let answer = timeout(Duration::from_secs(2), exchange(addr, request.as_bytes()));
        assert!(answer.await.unwrap().starts_with(b"HTTP/1.1 200 "));
    }

    #[tokio::test]
    async fn ending_the_server_closes_its_connections() {
        let (listener, _) = bind().await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(serve_with(listener, only_live));
        let mut silent = TcpStream::connect(addr).await.unwrap();
        let held = exchange(addr, get("/", &addr.to_string()).as_bytes()).await;
        assert_eq!(held, NOT_FOUND.as_bytes());

        server.abort();
        let _ = server.await;
        let mut rest = Vec::new();
        let closed = timeout(Duration::from_secs(2), silent.read_to_end(&mut rest));
        assert!(
            closed.await.is_ok(),
            "a silent connection outlived its server"
        );
    }

    /// In a child process, alone: tracing caches each callsite's interest per process, so a scoped
    /// subscriber can miss an event that parallel tests also reach (as `bad_args_log`).
    #[test]
    fn failures_log_the_category_and_never_the_path() {
        const SECRET_PATH: &str = "/mxc%3A%2F%2Fsecret.example%2Fsecret-media-id";
        const SECRET_HOST: &str = "secret-host.example";
        const SECRET_HEADER: &str = "X-Secret-Header: secret-value";
        let token = live();

        if env::var_os(LOG_PROBE).is_some() {
            let subscriber = tracing_subscriber::fmt()
                .with_ansi(false)
                .with_max_level(tracing::Level::TRACE)
                .with_writer(std::io::stdout)
                .finish();
            tracing::subscriber::set_global_default(subscriber).unwrap();
            tokio::runtime::Runtime::new().unwrap().block_on(async {
                let (addr, _) = served(std::slice::from_ref(&token)).await;
                let host = addr.to_string();
                let tail = format!("{SECRET_HEADER}\r\n\r\n");
                for request in [
                    format!("{SECRET_PATH} {token} nonsense\r\n{tail}"),
                    format!("POST /{token} HTTP/1.1\r\nHost: {host}\r\n{tail}"),
                    format!("GET /{token} HTTP/1.1\r\nHost: {SECRET_HOST}\r\n{tail}"),
                    format!("GET {SECRET_PATH} HTTP/1.1\r\nHost: {host}\r\n{tail}"),
                    format!("GET /{token} HTTP/1.1\r\nHost: {host}\r\n{tail}"),
                ] {
                    exchange(addr, request.as_bytes()).await;
                }
                // No terminator: the half-close ends the read, and the answer is the close.
                let mut client = TcpStream::connect(addr).await.unwrap();
                client
                    .write_all(format!("GET /{token}").as_bytes())
                    .await
                    .unwrap();
                client.shutdown().await.unwrap();
                let _ = client.read_to_end(&mut Vec::new()).await;
            });
            return;
        }

        let output = Command::new(env::current_exe().unwrap())
            .args([
                "--exact",
                "media_server::tests::failures_log_the_category_and_never_the_path",
            ])
            .env(LOG_PROBE, "1")
            .output()
            .unwrap();
        let log = String::from_utf8(output.stdout).unwrap();
        assert!(output.status.success(), "{log}");
        for category in ["request-line", "method", "host", "not-found", "head"] {
            assert!(
                log.contains(&format!("category=\"{category}\"")),
                "{category}: {log}"
            );
        }
        for secret in [
            token.as_str(),
            "secret",
            "mxc",
            SECRET_PATH,
            SECRET_HOST,
            SECRET_HEADER,
        ] {
            assert!(!log.contains(secret), "{secret}: {log}");
        }
    }
}
