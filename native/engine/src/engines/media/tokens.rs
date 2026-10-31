//! The token table: media bytes in memory behind random tokens. A token is a capability, so it is
//! derived from nothing and neither it nor the bytes reach a log, a `Debug` or a fault.

use std::{collections::HashMap, fmt};

use matrix_sdk::{bytes::Bytes, locks::Mutex};

use crate::accounts::{AccountRuntime, Engine};

/// What a host serves for a token.
pub struct MediaBytes {
    pub mime: String,
    pub bytes: Bytes,
}

// The bytes are decrypted media.
impl fmt::Debug for MediaBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MediaBytes")
            .field("mime", &self.mime)
            .field("len", &self.bytes.len())
            .finish()
    }
}

struct Minted {
    account_id: String,
    mime: String,
    bytes: Bytes,
}

// No `Debug`, here or on `Minted`: the table's keys are the tokens.
#[derive(Default)]
pub(crate) struct MediaTokens {
    /// Never held across an await.
    table: Mutex<HashMap<String, Minted>>,
}

impl MediaTokens {
    /// A fresh 256-bit token for `bytes`, or `None` once the account has retired, or if the OS
    /// has no randomness to give: a weaker token is never minted.
    #[cfg_attr(not(test), expect(dead_code, reason = "M3 calls it"))]
    pub(crate) fn mint(&self, rt: &AccountRuntime, mime: &str, bytes: Bytes) -> Option<String> {
        let Some(token) = token_from(getrandom::getrandom) else {
            tracing::error!("the OS random source failed");
            return None;
        };
        let minted = Minted {
            account_id: rt.account_id.clone(),
            mime: safe_mime(mime),
            bytes,
        };
        let mut table = self.table.lock();
        // Under the lock: `tear_down` retires before it purges, so a mint it races is either
        // refused here or purged there.
        if *rt.retired().borrow() {
            return None;
        }
        table.insert(token.clone(), minted);
        Some(token)
    }

    #[cfg_attr(not(test), expect(dead_code, reason = "M3 calls it"))]
    pub(crate) fn release(&self, token: &str) {
        self.table.lock().remove(token);
    }

    pub(crate) fn purge_account(&self, account_id: &str) {
        (self.table.lock()).retain(|_, minted| minted.account_id != account_id);
    }

    // shortcut: a task aborted mid-poll can mint after this clear, so its decrypted bytes stay in
    // memory, unreachable, until the account's teardown rather than until this attach (D5); upgrade
    // when a mint can tell it belongs to an earlier attach.
    pub(crate) fn clear(&self) {
        self.table.lock().clear();
    }

    /// Holds the table, so a test can see what a caller does before it reaches the lock.
    #[cfg(test)]
    pub(crate) fn hold(&self) -> impl Sized + '_ {
        self.table.lock()
    }
}

impl Engine {
    /// The bytes behind `token`, for a host to serve. None for anything else.
    pub fn media_bytes(&self, token: &str) -> Option<MediaBytes> {
        let table = self.media.tokens.table.lock();
        let minted = table.get(token)?;
        Some(MediaBytes {
            mime: minted.mime.clone(),
            bytes: minted.bytes.clone(),
        })
    }

    /// Called on `attach`: a reloaded page has lost its URLs, as it loses blob URLs.
    pub(crate) fn on_attach(&self) {
        self.media.tokens.clear();
    }
}

/// 32 bytes from `fill` as 64 lowercase hex characters, or `None` if `fill` fails.
fn token_from<E>(fill: impl FnOnce(&mut [u8]) -> Result<(), E>) -> Option<String> {
    let mut random = [0u8; 32];
    fill(&mut random).ok()?;
    Some(random.iter().map(|b| format!("{b:02x}")).collect())
}

/// A lowercased `image`, `video` or `audio` type of RFC 7230 token characters, parameters dropped.
/// Anything else is `application/octet-stream`: a registered scheme counts as local to Tauri, so a
/// document served from it would run script with the app's IPC, and this is the core's only guard
/// if a caller skips `displaySafeMime`.
fn safe_mime(declared: &str) -> String {
    let essence = declared
        .split_once(';')
        .map_or(declared, |(essence, _)| essence);
    let essence = essence.trim_matches([' ', '\t']).to_ascii_lowercase();
    let token_char = |b: u8| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b);
    let safe = essence.split_once('/').is_some_and(|(kind, subtype)| {
        matches!(kind, "image" | "video" | "audio")
            && !subtype.is_empty()
            && subtype.bytes().all(token_char)
            // Any `+xml` subtype opens as an XML document, which can hold script; SVG is one.
            && !subtype.ends_with("+xml")
    });
    if safe {
        essence
    } else {
        "application/octet-stream".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashSet,
        sync::Arc,
        thread,
        time::{Duration, Instant},
    };

    use tokio::runtime::Handle;

    use super::*;
    use crate::{
        accounts::Stores,
        testing::{builder_on, engine_in, live, password},
    };

    const OFFLINE: &str = "http://127.0.0.1:1";

    /// The engine and the runtime of its live account, which mints.
    async fn minter() -> (tempfile::TempDir, Arc<Engine>, Arc<AccountRuntime>) {
        let root = tempfile::TempDir::new().unwrap();
        let engine = engine_in(&root);
        let client = builder_on(OFFLINE).build().await.unwrap();
        let rt = live(&engine, &password(OFFLINE), client).await;
        (root, engine, rt)
    }

    fn png() -> Bytes {
        Bytes::from_static(b"secret-bytes")
    }

    #[tokio::test]
    async fn a_token_is_64_lowercase_hex_and_fresh_each_time() {
        let (_root, engine, rt) = minter().await;
        let tokens = &engine.media.tokens;
        let minted: HashSet<String> = (0..1000)
            .map(|_| tokens.mint(&rt, "image/png", png()).unwrap())
            .collect();
        assert_eq!(minted.len(), 1000);
        for token in &minted {
            let hex = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
            assert!(token.len() == 64 && token.bytes().all(hex), "{token}");
        }
        // Every position varies, which a short fill leaves constant.
        for at in 0..64 {
            let column: HashSet<u8> = minted.iter().map(|token| token.as_bytes()[at]).collect();
            assert!(column.len() > 1, "position {at}");
        }
    }

    #[tokio::test]
    async fn media_bytes_serves_a_minted_token_with_no_server() {
        let (_root, engine, rt) = minter().await;
        let token = engine.media.tokens.mint(&rt, "IMAGE/PNG", png()).unwrap();
        let served = engine.media_bytes(&token).unwrap();
        assert_eq!((served.mime.as_str(), served.bytes), ("image/png", png()));
        for other in ["", "/", "x", &token[1..], &token.to_uppercase()] {
            assert!(engine.media_bytes(other).is_none(), "{other}");
        }
    }

    #[tokio::test]
    async fn release_ends_a_token_and_leaves_the_others() {
        let (_root, engine, rt) = minter().await;
        let tokens = &engine.media.tokens;
        let released = tokens.mint(&rt, "image/png", png()).unwrap();
        let kept = tokens.mint(&rt, "image/png", png()).unwrap();
        tokens.release(&released);
        assert!(engine.media_bytes(&released).is_none());
        assert!(engine.media_bytes(&kept).is_some());
        tokens.release(&released);
        tokens.release("never-minted");
        assert!(engine.media_bytes(&kept).is_some());
    }

    #[tokio::test]
    async fn a_second_token_for_the_same_bytes_is_independent() {
        let (_root, engine, rt) = minter().await;
        let tokens = &engine.media.tokens;
        let first = tokens.mint(&rt, "image/png", png()).unwrap();
        let second = tokens.mint(&rt, "image/png", png()).unwrap();
        assert_ne!(first, second);
        tokens.release(&first);
        assert_eq!(engine.media_bytes(&second).unwrap().bytes, png());
    }

    #[tokio::test]
    async fn minting_after_retire_is_refused() {
        let (_root, engine, rt) = minter().await;
        let tokens = &engine.media.tokens;
        let before = tokens.mint(&rt, "image/png", png()).unwrap();
        drop(engine.tear_down("@a:b", Some(Arc::clone(&rt)), Stores::Keep));
        assert!(tokens.mint(&rt, "image/png", png()).is_none());
        assert!(engine.media_bytes(&before).is_none());
        assert!(tokens.table.lock().is_empty());
    }

    #[tokio::test]
    async fn a_mint_waiting_on_the_table_sees_a_retire() {
        let (_root, engine, rt) = minter().await;
        let table = engine.media.tokens.table.lock();
        let minting = thread::spawn({
            let (engine, rt) = (Arc::clone(&engine), Arc::clone(&rt));
            move || engine.media.tokens.mint(&rt, "image/png", png())
        });
        // Long enough for a check made before the lock to have passed already.
        thread::sleep(Duration::from_millis(100));
        rt.set_retired();
        drop(table);
        assert!(minting.join().unwrap().is_none());
    }

    #[tokio::test]
    async fn tear_down_retires_before_it_purges() {
        let (_root, engine, rt) = minter().await;
        let table = engine.media.tokens.table.lock();
        let runtime = Handle::current();
        let tearing_down = thread::spawn({
            let (engine, rt) = (Arc::clone(&engine), Arc::clone(&rt));
            move || {
                let _entered = runtime.enter();
                drop(engine.tear_down("@a:b", Some(rt), Stores::Keep));
            }
        });
        // The purge waits on the table, which this test holds, so a retire can only come first.
        let waited = Instant::now();
        while !*rt.retired().borrow() && waited.elapsed() < Duration::from_secs(5) {
            thread::sleep(Duration::from_millis(1));
        }
        assert!(*rt.retired().borrow());
        drop(table);
        tearing_down.join().unwrap();
    }

    #[test]
    fn safe_mime_table() {
        const OCTETS: &str = "application/octet-stream";
        for (declared, expected) in [
            ("image/png", "image/png"),
            ("IMAGE/PNG", "image/png"),
            ("audio/ogg; codecs=opus", "audio/ogg"),
            ("audio/ogg ;codecs=opus", "audio/ogg"),
            (" audio/ogg", "audio/ogg"),
            ("video/mp4", "video/mp4"),
            ("application/octet-stream", OCTETS),
            ("image/svg+xml", OCTETS),
            ("Image/SVG+XML; charset=utf-8", OCTETS),
            ("image/svg+xml;x=1", OCTETS),
            ("video/x+xml", OCTETS),
            ("text/html", OCTETS),
            ("TEXT/HTML; charset=utf-8", OCTETS),
            ("application/xhtml+xml", OCTETS),
            ("application/pdf", OCTETS),
            ("text/html\r\nX-Evil: 1", OCTETS),
            ("\r\nimage/png", OCTETS),
            ("image/png\n", OCTETS),
            ("", OCTETS),
            ("a/b/c", OCTETS),
            ("é/x", OCTETS),
            ("a/", OCTETS),
            ("/b", OCTETS),
            ("png", OCTETS),
            ("a b/c", OCTETS),
            ("image/a/b", OCTETS),
            ("image/", OCTETS),
            ("/png", OCTETS),
            ("image/a b", OCTETS),
            ("image/é", OCTETS),
        ] {
            assert_eq!(safe_mime(declared), expected, "{declared:?}");
        }
        // Each character alone, so nothing else in the type refuses it.
        for separator in "(),:<>@[\\]\"?={}\u{7f}".chars() {
            let declared = format!("image/a{separator}b");
            assert_eq!(safe_mime(&declared), OCTETS, "{declared:?}");
        }
        for token_char in "!#$%&'*+-.^_`|~".chars() {
            let declared = format!("image/a{token_char}b");
            assert_eq!(safe_mime(&declared), declared);
        }
    }

    /// Every type `displaySafeMime` can hand a caller must survive here.
    #[test]
    fn safe_mime_keeps_every_type_the_display_allowlist_keeps() {
        let source = include_str!("../../../../../libs/util/matrix/src/lib/display-mime.ts");
        let allowed: Vec<&str> = source
            .lines()
            .filter_map(|line| line.trim().strip_prefix('\'')?.strip_suffix("',"))
            .collect();
        assert!(allowed.len() >= 26, "{allowed:?}");
        assert!(allowed.contains(&"image/png"));
        for mime in allowed {
            assert_eq!(safe_mime(mime), mime);
        }
    }

    #[test]
    fn token_from_encodes_every_byte_it_is_given() {
        let token = token_from(|random| {
            assert_eq!(random.len(), 32);
            random.fill(0xab);
            random[31] = 0x0c;
            Ok::<_, ()>(())
        });
        assert_eq!(token, Some(format!("{}0c", "ab".repeat(31))));
    }

    #[test]
    fn token_from_gives_no_token_when_the_fill_fails() {
        let token = token_from(|random| {
            random.fill(0xab);
            Err(())
        });
        assert_eq!(token, None);
    }

    #[tokio::test]
    async fn debug_holds_neither_token_nor_bytes() {
        let (_root, engine, rt) = minter().await;
        let token = engine.media.tokens.mint(&rt, "image/png", png()).unwrap();
        let served = format!("{:?}", engine.media_bytes(&token).unwrap());
        assert!(
            served.contains("image/png") && served.contains("12"),
            "{served}"
        );
        let printed = [served, format!("{engine:?}"), format!("{rt:?}")];
        for text in printed {
            assert!(!text.contains(&token), "{text}");
            assert!(
                !text.contains("secret") && !text.contains("115, 101"),
                "{text}"
            );
        }
    }
}
