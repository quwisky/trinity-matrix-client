//! `MediaEngine` (`libs/data-access/media/src/lib/media-engine.ts`): media bytes behind random
//! tokens. A download is never kept by the SDK's media store: its cache key ignores the file's hash
//! and it can write decrypted bytes to disk.

pub mod tokens;

use std::{fmt, future::ready, io::Read, sync::Arc, time::Duration};

use matrix_sdk::{
    Error,
    bytes::Bytes,
    config::RequestConfig,
    ruma::{
        MxcUri, UInt,
        api::client::authenticated_media::{get_content, get_content_thumbnail},
        events::room::EncryptedFile,
        media::Method,
    },
};
use matrix_sdk_base::crypto::AttachmentDecryptor;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokens::MediaTokens;
use ts_rs::TS;

use crate::{
    accounts::{AccountRuntime, Engine},
    dispatch::{Stream, reply},
    engines::member::until_retired,
    failure::{
        EngineFailure, EngineResult, FailureCode, account_not_live, local_failure, request_failed,
    },
};

const DTO: &str = "data-access/media/src/lib/rust-dto/";

/// The media an engine holds in memory for its hosts.
#[derive(Default)]
pub(crate) struct MediaState {
    pub(crate) tokens: MediaTokens,
}

/// `MediaSource`. Both come from events, so they stay lenient here: a bad one is
/// `media-unavailable`, never `bad-args`.
#[derive(Deserialize, TS)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[ts(export, export_to = DTO)]
pub enum MediaSourceDto {
    Plain {
        mxc: String,
    },
    Encrypted {
        #[ts(
            type = "{ url: string, key: JsonWebKey, iv: string, hashes: Record<string, string>, v: string }"
        )]
        file: Value,
    },
}

/// `method` of a thumbnail `MediaFormat`.
#[derive(Clone, Copy, Debug, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = DTO)]
pub enum ThumbnailMethodDto {
    Scale,
    Crop,
}

/// `MediaFormat`.
#[derive(Clone, Copy, Debug, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[ts(export, export_to = DTO)]
pub enum MediaFormatDto {
    File,
    Thumbnail {
        width: u32,
        height: u32,
        method: ThumbnailMethodDto,
        animated: bool,
    },
}

/// `MediaRequest`.
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct MediaRequestDto {
    source: MediaSourceDto,
    format: MediaFormatDto,
    mime_type: String,
    #[allow(
        dead_code,
        reason = "Kept so the DTO matches; the hint is ignored (decision D6)"
    )]
    downscale_to: Option<f64>,
}

/// `MediaContent`.
#[derive(Serialize, TS)]
#[ts(export, export_to = DTO)]
pub struct MediaContentDto {
    url: String,
    #[ts(type = "number")]
    size: u64,
}

// An mxc URI names a user's media, a file holds its key, and a media URL holds its token.

impl fmt::Debug for MediaSourceDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::Plain { .. } => "Plain",
            Self::Encrypted { .. } => "Encrypted",
        };
        f.debug_struct(name).finish_non_exhaustive()
    }
}

impl fmt::Debug for MediaContentDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MediaContentDto")
            .field("size", &self.size)
            .finish_non_exhaustive()
    }
}

/// A file that fails its hash, or that this engine cannot read.
#[derive(Debug, PartialEq, Eq)]
struct Undecryptable;

/// The request `content` will send, decided before anything is sent.
enum Download {
    File(get_content::v1::Request),
    Thumbnail(get_content_thumbnail::v1::Request),
    Encrypted(get_content::v1::Request, EncryptedFile),
}

impl Download {
    /// `None` for a source that names no file.
    fn of(source: MediaSourceDto, format: MediaFormatDto) -> Option<Self> {
        match (source, format) {
            // The server holds only ciphertext, so it has no thumbnail: `format` doesn't apply.
            (MediaSourceDto::Encrypted { file }, _) => {
                let file: EncryptedFile = serde_json::from_value(file).ok()?;
                let request = get_content::v1::Request::from_uri(&file.url).ok()?;
                Some(Self::Encrypted(request, file))
            }
            (MediaSourceDto::Plain { mxc }, MediaFormatDto::File) => {
                let uri = <&MxcUri>::from(mxc.as_str());
                Some(Self::File(get_content::v1::Request::from_uri(uri).ok()?))
            }
            (
                MediaSourceDto::Plain { mxc },
                MediaFormatDto::Thumbnail {
                    width,
                    height,
                    method,
                    animated,
                },
            ) => {
                let uri = <&MxcUri>::from(mxc.as_str());
                let (width, height) = (UInt::from(width), UInt::from(height));
                let mut request =
                    get_content_thumbnail::v1::Request::from_uri(uri, width, height).ok()?;
                request.method = Some(match method {
                    ThumbnailMethodDto::Scale => Method::Scale,
                    ThumbnailMethodDto::Crop => Method::Crop,
                });
                request.animated = Some(animated);
                Some(Self::Thumbnail(request))
            }
        }
    }

    // shortcut: the whole body is held in memory, about twice its size at the peak, with no limit
    // but the homeserver's, so a room member can link a file that ends the process; upgrade when
    // the SDK can stream a media download or the engine learns a byte cap before the request.
    async fn run(
        self,
        engine: &Arc<Engine>,
        rt: &AccountRuntime,
    ) -> Result<Vec<u8>, EngineFailure> {
        // `retry_limit` counts attempts: js's three retries, and as in js no limit on the time.
        let config = RequestConfig::new().retry_limit(4).timeout(Duration::MAX);
        let failed = |err: Error| request_failed(&err);
        match self {
            Self::File(request) => {
                let send = rt.client.send(request).with_request_config(config);
                let response = engine.ruled(rt, send).await.map_err(failed)?;
                Ok(response.file)
            }
            Self::Thumbnail(request) => {
                let send = rt.client.send(request).with_request_config(config);
                let response = engine.ruled(rt, send).await.map_err(failed)?;
                Ok(response.file)
            }
            Self::Encrypted(request, file) => {
                let send = rt.client.send(request).with_request_config(config);
                let response = engine.ruled(rt, send).await.map_err(failed)?;
                decrypted(file, &response.file)
                    .map_err(|Undecryptable| local_failure(FailureCode::MediaUnavailable))
            }
        }
    }
}

/// The plaintext if `ciphertext` matches the file's hash and the file is one this engine reads,
/// else `Undecryptable`. Nothing partial escapes. The hash covers the ciphertext, so a well-formed
/// wrong key is not detected, as in js.
// shortcut: decrypts on the calling worker for the whole file, which delays that worker's other
// tasks and a retire, and stalls a single-threaded host outright; upgrade to a blocking task or
// chunked yields before a wasm host (piece 5) ships.
fn decrypted(file: EncryptedFile, mut ciphertext: &[u8]) -> Result<Vec<u8>, Undecryptable> {
    let mut plaintext = Vec::with_capacity(ciphertext.len());
    let mut reader =
        AttachmentDecryptor::new(&mut ciphertext, file.into()).map_err(|_| Undecryptable)?;
    // The hash is checked at the end of the input, so this is only whole once it has returned.
    reader
        .read_to_end(&mut plaintext)
        .map_err(|_| Undecryptable)?;
    Ok(plaintext)
}

/// What a refused mint answers: `None`, not live, once retired, which is sticky. Otherwise the OS
/// had no randomness to give.
fn unminted(rt: &AccountRuntime) -> Option<EngineFailure> {
    (!*rt.retired().borrow()).then(|| local_failure(FailureCode::MediaUnavailable))
}

/// `content`'s answer. `None`: the account is not live, or stopped being while this ran.
async fn served(
    engine: &Arc<Engine>,
    account_id: &str,
    request: MediaRequestDto,
) -> Option<Result<MediaContentDto, EngineFailure>> {
    let rt = engine.account(account_id)?;
    let Some(download) = Download::of(request.source, request.format) else {
        return Some(Err(local_failure(FailureCode::MediaUnavailable)));
    };
    let bytes = match until_retired(rt.retired(), download.run(engine, &rt)).await? {
        Ok(bytes) => Bytes::from(bytes),
        Err(failure) => return Some(Err(failure)),
    };
    let size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    let Some(token) = (engine.media.tokens).mint(&rt, &request.mime_type, bytes) else {
        return unminted(&rt).map(Err);
    };
    let url = format!("{}{token}", engine.config.media_url_prefix);
    Some(Ok(MediaContentDto { url, size }))
}

/// Downloads the file once, verifies an encrypted one, and answers a URL for its bytes in memory.
pub fn content(engine: Arc<Engine>, account_id: String, request: MediaRequestDto) -> Stream {
    reply(async move {
        match served(&engine, &account_id, request).await {
            Some(Ok(content)) => EngineResult::Ok(content),
            Some(Err(failure)) => EngineResult::Err(failure),
            None => {
                // The sync may have met a dead token first: its logout reaches the caller first.
                engine.deaths_of(&account_id).delivered().await;
                EngineResult::Err(account_not_live())
            }
        }
    })
}

/// Ends the tokens of the URLs this engine minted, at dispatch, so a close cannot skip it.
pub fn release(engine: Arc<Engine>, urls: Vec<String>) -> Stream {
    let prefix = &engine.config.media_url_prefix;
    for token in urls
        .iter()
        .filter_map(|url| url.strip_prefix(prefix.as_str()))
    {
        engine.media.tokens.release(token);
    }
    reply(ready(()))
}

/// Replies null: no probe exists on Rust, which has no legacy media to probe for.
pub fn forget_probes(_engine: Arc<Engine>) -> Stream {
    reply(ready(()))
}

#[cfg(test)]
mod tests {
    use std::{env, process::Command};

    use futures_util::{FutureExt, StreamExt};
    use matrix_sdk::{
        media::{MediaFormat, MediaRequestParameters},
        ruma::{OwnedMxcUri, events::room::MediaSource},
        timeout::timeout,
    };
    use matrix_sdk_base::media::store::IgnoreMediaRetentionPolicy;
    use serde_json::json;
    use tempfile::TempDir;

    use super::*;
    use crate::{
        barrier::Subscribers,
        config::EngineConfig,
        dispatch::dispatch,
        testing::{Seen, binary_on_loopback, builder_on, live, password, requests, scripted},
    };

    const PREFIX: &str = "http://127.0.0.1:9/";
    const OFFLINE: &str = "http://127.0.0.1:1";
    const DOWNLOAD_AB: &str = "GET /_matrix/client/v1/media/download/a/b";
    const LOG_PROBE: &str = "TRINITY_MEDIA_LOG_PROBE";
    /// What `encryptAttachment` in `libs/util/matrix/src/lib/attachment-crypto.ts` made of `PLAIN`.
    const PLAIN: &[u8] = b"hello from js";
    const JS_CIPHERTEXT: [u8; 13] = [
        0xd0, 0x63, 0x52, 0x9c, 0x4e, 0x85, 0xbb, 0x53, 0xaa, 0x28, 0x00, 0xe6, 0xd0,
    ];
    const JS_K: &str = "mqgZQO0Z8ed7K-d3avL4zb3MesaenX3xK4GTMVWSqqE";
    const JS_IV: &str = "L6OUqBAIbGIAAAAAAAAAAA";
    const JS_SHA256: &str = "d/z9bofkmw740oYACh8v30710ZQqEBBeWGyu4aByLMk";
    const JS_MEDIA_ID: &str = "abcdefgh";
    const JS_SERVER: &str = "example.org";

    fn js_file() -> Value {
        json!({
            "url": format!("mxc://{JS_SERVER}/{JS_MEDIA_ID}"),
            "v": "v2",
            "key": {
                "key_ops": ["encrypt", "decrypt"],
                "ext": true,
                "alg": "A256CTR",
                "kty": "oct",
                "k": JS_K,
            },
            "iv": JS_IV,
            "hashes": {"sha256": JS_SHA256},
        })
    }

    fn file_of(value: Value) -> EncryptedFile {
        serde_json::from_value(value).unwrap()
    }

    fn whole() -> Value {
        json!({"kind": "file"})
    }

    fn thumbnail() -> Value {
        json!({"kind": "thumbnail", "width": 32, "height": 32, "method": "scale", "animated": false})
    }

    fn request(source: Value, format: Value) -> Value {
        json!({"source": source, "format": format, "mimeType": "image/png", "downscaleTo": null})
    }

    fn plain(mxc: &str) -> Value {
        request(json!({"kind": "plain", "mxc": mxc}), whole())
    }

    fn encrypted(file: Value, format: Value) -> Value {
        request(json!({"kind": "encrypted", "file": file}), format)
    }

    fn engine_on_prefix(root: &TempDir) -> Arc<Engine> {
        Engine::new(EngineConfig {
            data_dir: root.path().join("data"),
            cache_dir: root.path().join("cache"),
            media_url_prefix: PREFIX.to_owned(),
            ..EngineConfig::default()
        })
        .unwrap()
    }

    async fn live_on(base: &str) -> (TempDir, Arc<Engine>, Arc<AccountRuntime>) {
        let root = TempDir::new().unwrap();
        let engine = engine_on_prefix(&root);
        let client = builder_on(base).build().await.unwrap();
        let rt = live(&engine, &password(base), client).await;
        (root, engine, rt)
    }

    /// A homeserver that takes any request into `Seen` once the scripted `answers` are spent, the
    /// client's own background ones too, so read it through `media_requests`.
    fn watched(mut answers: Vec<(&'static str, u16, Value)>) -> (String, Seen) {
        answers.extend(std::iter::repeat_n(("*", 200, json!({})), 8));
        scripted(answers)
    }

    fn media_requests(seen: &Seen) -> Vec<String> {
        let targets = requests(seen).into_iter().map(|(target, _)| target);
        targets
            .filter(|target| target.contains("/media/"))
            .collect()
    }

    /// `media.<member>`'s one reply, decoded as the carrier decodes it.
    async fn call(engine: &Arc<Engine>, member: &str, args: Vec<Value>) -> Value {
        let method = format!("media.{member}");
        let mut replies = dispatch(engine, &method, args).unwrap();
        replies.next().await.unwrap().unwrap()
    }

    async fn content_of(engine: &Arc<Engine>, request: Value) -> Value {
        call(engine, "content", vec![json!("@a:b"), request]).await
    }

    fn code(reply: &Value) -> &str {
        reply["failure"]["code"].as_str().unwrap_or("none")
    }

    fn token_of(reply: &Value) -> &str {
        let url = reply["value"]["url"].as_str().unwrap();
        url.strip_prefix(PREFIX).unwrap()
    }

    #[test]
    fn decrypts_a_file_the_js_adapter_encrypted() {
        assert_eq!(
            decrypted(file_of(js_file()), &JS_CIPHERTEXT).as_deref(),
            Ok(PLAIN)
        );
    }

    #[test]
    fn a_failed_hash_or_no_hash_is_undecryptable() {
        let mut flipped = JS_CIPHERTEXT;
        flipped[0] ^= 1;
        assert_eq!(decrypted(file_of(js_file()), &flipped), Err(Undecryptable));
        assert_eq!(
            decrypted(file_of(js_file()), &JS_CIPHERTEXT[..12]),
            Err(Undecryptable)
        );

        let mut wrong_hash = js_file();
        wrong_hash["hashes"]["sha256"] = json!("A".repeat(43));
        assert_eq!(
            decrypted(file_of(wrong_hash), &JS_CIPHERTEXT),
            Err(Undecryptable)
        );

        for hashes in [json!({}), json!({"sha512": "AAAA"})] {
            let mut no_sha256 = js_file();
            no_sha256["hashes"] = hashes;
            assert_eq!(
                decrypted(file_of(no_sha256), &JS_CIPHERTEXT),
                Err(Undecryptable)
            );
        }
    }

    #[test]
    fn a_v1_file_is_media_unavailable() {
        let mut v1 = js_file();
        v1["v"] = json!("v1");
        assert_eq!(decrypted(file_of(v1), &JS_CIPHERTEXT), Err(Undecryptable));
    }

    /// The hash covers the ciphertext, so a well-formed wrong key is not detected, in js either. A
    /// malformed key never gets here: see `a_bad_source_sends_nothing`.
    #[test]
    fn a_well_formed_wrong_key_decrypts_to_noise() {
        let mut wrong_key = js_file();
        wrong_key["key"]["k"] = json!("A".repeat(43));
        let noise = decrypted(file_of(wrong_key), &JS_CIPHERTEXT).unwrap();
        assert_eq!(noise.len(), PLAIN.len());
        assert_ne!(noise, PLAIN);
    }

    #[tokio::test]
    async fn a_bad_source_sends_nothing() {
        let unversioned = {
            let mut file = js_file();
            file.as_object_mut().unwrap().remove("v");
            file
        };
        let bad_key = |key: &str, value: Value| {
            let mut file = js_file();
            file["key"][key] = value;
            file
        };
        let bad_url = |url: &str| {
            let mut file = js_file();
            file["url"] = json!(url);
            file
        };
        let bad_files = [
            json!({}),
            json!({"url": "mxc://a/b", "v": "v2"}),
            json!(7),
            unversioned,
            bad_key("k", json!("AAAA")),
            bad_key("kty", json!("RSA")),
            bad_key("alg", json!("A128CTR")),
            bad_key("key_ops", json!(["decrypt"])),
            bad_url(""),
            bad_url("nonsense"),
            bad_url("mxc://a/../b"),
        ];
        let mut rows: Vec<Value> = ["", "nonsense", "mxc://a/../b", "mxc://bad server/b"]
            .into_iter()
            .flat_map(|mxc| {
                let source = json!({"kind": "plain", "mxc": mxc});
                [plain(mxc), request(source, thumbnail())]
            })
            .collect();
        rows.extend(bad_files.into_iter().map(|file| encrypted(file, whole())));

        let (base, seen) = watched(Vec::new());
        let (_root, engine, _rt) = live_on(&base).await;
        for row in rows {
            let reply = content_of(&engine, row.clone()).await;
            assert_eq!(code(&reply), "media-unavailable", "{row}");
        }
        assert_eq!(media_requests(&seen), Vec::<String>::new());
    }

    #[tokio::test]
    async fn the_account_is_looked_up_before_the_source() {
        let root = TempDir::new().unwrap();
        let engine = engine_on_prefix(&root);
        let bad_source = encrypted(json!(7), whole());
        assert_eq!(
            code(&content_of(&engine, bad_source).await),
            "account-not-live"
        );
        assert_eq!(
            code(&content_of(&engine, plain("mxc://a/b")).await),
            "account-not-live"
        );
    }

    /// Serves the bytes with `text/html`, so a mime taken from the server would show here.
    #[tokio::test]
    async fn a_url_serves_the_plaintext_with_the_requested_mime() {
        let base = binary_on_loopback(JS_CIPHERTEXT.to_vec());
        let (_root, engine, _rt) = live_on(&base).await;

        let reply = content_of(&engine, encrypted(js_file(), whole())).await;
        assert_eq!(reply["value"]["size"], json!(PLAIN.len()));
        let served = engine.media_bytes(token_of(&reply)).unwrap();
        assert_eq!(
            (served.mime.as_str(), &served.bytes[..]),
            ("image/png", PLAIN)
        );

        // Plain media stays as the server gave it.
        let reply = content_of(&engine, plain("mxc://a/b")).await;
        assert_eq!(reply["value"]["size"], json!(JS_CIPHERTEXT.len()));
        let served = engine.media_bytes(token_of(&reply)).unwrap();
        assert_eq!(
            (served.mime.as_str(), &served.bytes[..]),
            ("image/png", &JS_CIPHERTEXT[..])
        );
    }

    #[tokio::test]
    async fn a_url_holds_no_part_of_its_source() {
        let base = binary_on_loopback(JS_CIPHERTEXT.to_vec());
        let (_root, engine, _rt) = live_on(&base).await;
        let reply = content_of(&engine, encrypted(js_file(), whole())).await;
        let url = reply["value"]["url"].as_str().unwrap();
        let token = token_of(&reply);
        assert_eq!(token.len(), 64, "{url}");
        assert!(
            token
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
            "{url}"
        );
        for part in [JS_SERVER, JS_MEDIA_ID, JS_K, JS_IV, JS_SHA256] {
            assert!(!url.contains(part), "{part}: {url}");
        }
        // The token is drawn afresh, not derived from the file.
        let again = content_of(&engine, encrypted(js_file(), whole())).await;
        assert_ne!(token_of(&again), token);
    }

    #[tokio::test]
    async fn a_tampered_file_is_media_unavailable_and_mints_nothing() {
        let mut tampered = JS_CIPHERTEXT.to_vec();
        tampered[0] ^= 1;
        let base = binary_on_loopback(tampered);
        let (_root, engine, _rt) = live_on(&base).await;
        for format in [whole(), thumbnail()] {
            let reply = content_of(&engine, encrypted(js_file(), format.clone())).await;
            assert_eq!(code(&reply), "media-unavailable", "{format}");
            assert_eq!(engine.media.tokens.len(), 0, "{format}");
        }
    }

    #[tokio::test]
    async fn a_v1_download_is_media_unavailable_and_mints_nothing() {
        let base = binary_on_loopback(JS_CIPHERTEXT.to_vec());
        let (_root, engine, _rt) = live_on(&base).await;
        let mut v1 = js_file();
        v1["v"] = json!("v1");
        let reply = content_of(&engine, encrypted(v1, whole())).await;
        assert_eq!(code(&reply), "media-unavailable");
        assert_eq!(engine.media.tokens.len(), 0);
    }

    /// An encrypted file has no server thumbnail: the whole file comes down, whatever the format.
    #[tokio::test]
    async fn an_encrypted_thumbnail_downloads_the_file() {
        let (base, seen) = watched(vec![(
            "GET /_matrix/client/v1/media/download/example.org/abcdefgh",
            0,
            json!(null),
        )]);
        let (_root, engine, _rt) = live_on(&base).await;
        let pending = content_of(&engine, encrypted(js_file(), thumbnail()));
        assert!(timeout(pending, Duration::from_millis(500)).await.is_err());
        let target = requests(&seen).remove(0).0;
        assert!(target.contains("/media/download/"), "{target}");
    }

    #[tokio::test]
    async fn decrypted_bytes_stay_out_of_the_media_store() {
        let base = binary_on_loopback(JS_CIPHERTEXT.to_vec());
        let (_root, engine, rt) = live_on(&base).await;
        for row in [encrypted(js_file(), whole()), plain("mxc://a/b")] {
            assert_eq!(content_of(&engine, row).await["ok"], json!(true));
        }

        let params = |source| MediaRequestParameters {
            source,
            format: MediaFormat::File,
        };
        let store = rt.client.media_store().lock().await.unwrap();
        let held = [
            MediaSource::Encrypted(Box::new(file_of(js_file()))),
            MediaSource::Plain(OwnedMxcUri::from("mxc://a/b")),
        ];
        for source in held {
            assert_eq!(
                store.get_media_content(&params(source)).await.unwrap(),
                None
            );
        }

        // The store does hold what is put in it, so `None` above is not just an empty read.
        let control = params(MediaSource::Plain(OwnedMxcUri::from("mxc://a/control")));
        let policy = IgnoreMediaRetentionPolicy::No;
        store
            .add_media_content(&control, vec![1], policy)
            .await
            .unwrap();
        assert_eq!(
            store.get_media_content(&control).await.unwrap(),
            Some(vec![1])
        );
    }

    #[tokio::test]
    async fn content_uses_authenticated_media_with_no_fallback() {
        let not_found = json!({"errcode": "M_NOT_FOUND", "error": "x"});
        let (base, seen) = watched(vec![(DOWNLOAD_AB, 404, not_found)]);
        let (_root, engine, _rt) = live_on(&base).await;
        let reply = content_of(&engine, plain("mxc://a/b")).await;
        assert_eq!(code(&reply), "request-failed");
        assert!(!reply.to_string().contains("mxc://"), "{reply}");
        assert_eq!(media_requests(&seen), [DOWNLOAD_AB]);
    }

    #[tokio::test]
    async fn content_tries_four_times_as_js() {
        let down = json!({});
        let gets = |last: u16| {
            vec![
                (DOWNLOAD_AB, 502, down.clone()),
                (DOWNLOAD_AB, 502, down.clone()),
                (DOWNLOAD_AB, 502, down.clone()),
                (DOWNLOAD_AB, last, down.clone()),
            ]
        };
        let (base, seen) = watched(gets(200));
        let (_root, engine, _rt) = live_on(&base).await;
        let reply = content_of(&engine, plain("mxc://a/b")).await;
        assert_eq!(reply["ok"], json!(true), "{reply}");
        assert_eq!(media_requests(&seen).len(), 4);

        let (base, seen) = watched(gets(502));
        let (_root, engine, _rt) = live_on(&base).await;
        let reply = content_of(&engine, plain("mxc://a/b")).await;
        assert_eq!(code(&reply), "request-failed");
        assert_eq!(media_requests(&seen).len(), 4);
    }

    #[tokio::test]
    async fn a_thumbnail_asks_for_its_size() {
        let (base, seen) = watched(vec![(
            "GET /_matrix/client/v1/media/thumbnail/a/b?*",
            200,
            json!({}),
        )]);
        let (_root, engine, _rt) = live_on(&base).await;
        let source = json!({"kind": "plain", "mxc": "mxc://a/b"});
        let reply = content_of(&engine, request(source, thumbnail())).await;
        assert_eq!(reply["ok"], json!(true), "{reply}");
        let target = requests(&seen).remove(0).0;
        for part in ["width=32", "height=32", "method=scale", "animated=false"] {
            assert!(target.contains(part), "{part}: {target}");
        }
    }

    /// Polls `replies` until the request reaches the server, and no answer comes before it does.
    async fn held_at_the_server(replies: &mut Stream, seen: &Seen) {
        for _ in 0..50 {
            if !requests(seen).is_empty() {
                return;
            }
            let wait = Duration::from_millis(100);
            assert!(
                timeout(replies.next(), wait).await.is_err(),
                "answered early"
            );
        }
        panic!("no request reached the server");
    }

    #[tokio::test]
    async fn retire_cuts_a_download() {
        let (base, seen) = scripted(vec![(DOWNLOAD_AB, 0, json!(null))]);
        let (_root, engine, rt) = live_on(&base).await;
        let before = Arc::strong_count(&rt);
        let args = vec![json!("@a:b"), plain("mxc://a/b")];
        let mut replies = dispatch(&engine, "media.content", args).unwrap();
        held_at_the_server(&mut replies, &seen).await;
        assert!(
            Arc::strong_count(&rt) > before,
            "the download holds the runtime"
        );

        rt.set_retired();
        let reply = timeout(replies.next(), Duration::from_secs(2))
            .await
            .expect("the reply comes at once")
            .unwrap()
            .unwrap();
        assert_eq!(code(&reply), "account-not-live");
        assert_eq!(Arc::strong_count(&rt), before);
        assert_eq!(engine.media.tokens.len(), 0);
    }

    /// A logout the rule published reaches the caller before `account-not-live` does, and a
    /// teardown is not held meanwhile.
    #[tokio::test]
    async fn a_not_live_answer_follows_the_logout_and_lets_go_of_the_account() {
        let (base, seen) = scripted(vec![(DOWNLOAD_AB, 0, json!(null))]);
        let (_root, engine, rt) = live_on(&base).await;
        let before = Arc::strong_count(&rt);
        let mut logouts = Subscribers::<u8>::default();
        let (_, mut logout) = logouts.subscribe(None);
        let wait = Duration::from_millis(100);
        let args = vec![json!("@a:b"), plain("mxc://a/b")];
        let mut replies = dispatch(&engine, "media.content", args).unwrap();
        held_at_the_server(&mut replies, &seen).await;

        (engine.state.lock().deaths).insert("@a:b".to_owned(), logouts.publish(&1));
        rt.set_retired();
        assert!(
            timeout(replies.next(), wait).await.is_err(),
            "ahead of the logout"
        );
        assert_eq!(Arc::strong_count(&rt), before);

        // Once to take the item, once more to count it as emitted.
        assert_eq!(logout.next().await, Some(1));
        assert_eq!(logout.next().now_or_never(), None);
        let reply = timeout(replies.next(), Duration::from_secs(2))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(code(&reply), "account-not-live");
    }

    /// `mint` draws its randomness itself, so this is the seam for its failure.
    #[tokio::test]
    async fn a_refused_mint_answers_by_whether_the_account_retired() {
        let (_root, _engine, rt) = live_on(OFFLINE).await;
        let random_failed = unminted(&rt).unwrap();
        assert_eq!(random_failed.code, FailureCode::MediaUnavailable);
        rt.set_retired();
        assert_eq!(unminted(&rt), None);
    }

    #[tokio::test]
    async fn release_and_forget_probes_reply_null() {
        let root = TempDir::new().unwrap();
        let engine = engine_on_prefix(&root);
        assert_eq!(call(&engine, "release", vec![json!([])]).await, Value::Null);
        assert_eq!(call(&engine, "forgetProbes", vec![]).await, Value::Null);
    }

    #[tokio::test]
    async fn release_ends_its_token_at_dispatch_and_leaves_the_others() {
        let base = binary_on_loopback(PLAIN.to_vec());
        let (_root, engine, _rt) = live_on(&base).await;
        let released = content_of(&engine, plain("mxc://a/b")).await;
        let kept = content_of(&engine, plain("mxc://a/b")).await;

        // Never polled: a close can't skip it.
        let urls = vec![released["value"]["url"].clone()];
        drop(dispatch(&engine, "media.release", vec![json!(urls)]).unwrap());

        assert!(engine.media_bytes(token_of(&released)).is_none());
        assert!(engine.media_bytes(token_of(&kept)).is_some());
    }

    #[tokio::test]
    async fn release_ignores_what_it_does_not_know() {
        let base = binary_on_loopback(PLAIN.to_vec());
        let (_root, engine, _rt) = live_on(&base).await;
        let reply = content_of(&engine, plain("mxc://a/b")).await;
        let token = token_of(&reply);
        let urls = json!([
            "blob:x",
            token,
            PREFIX,
            format!("{PREFIX}{}", "0".repeat(64))
        ]);
        assert_eq!(call(&engine, "release", vec![urls]).await, Value::Null);
        assert!(engine.media_bytes(token).is_some());
    }

    #[test]
    fn debug_of_a_media_request_holds_no_key() {
        for row in [
            encrypted(js_file(), whole()),
            plain("mxc://secret.example/secretid"),
        ] {
            let request: MediaRequestDto = serde_json::from_value(row).unwrap();
            let debug = format!("{request:?}");
            for secret in [
                JS_K,
                JS_IV,
                JS_SHA256,
                JS_MEDIA_ID,
                JS_SERVER,
                "secret",
                "mxc",
            ] {
                assert!(!debug.contains(secret), "{secret}: {debug}");
            }
        }
    }

    #[test]
    fn debug_of_media_content_holds_no_token() {
        let url = format!("{PREFIX}{}", "ab".repeat(32));
        let debug = format!("{:?}", MediaContentDto { url, size: 1 });
        assert!(
            !debug.contains("abab") && !debug.contains("127.0.0.1"),
            "{debug}"
        );
    }

    #[tokio::test]
    async fn an_undecodable_request_is_a_fault_that_quotes_nothing() {
        let (_root, engine, _rt) = live_on(OFFLINE).await;
        let secret = request(json!({"kind": "bogus", "mxc": "mxc://secret/x"}), whole());
        let Err(fault) = dispatch(&engine, "media.content", vec![json!("@a:b"), secret]) else {
            panic!("a source of no kind decoded");
        };
        let fault = format!("{fault:?}");
        assert!(
            !fault.contains("secret") && !fault.contains("bogus"),
            "{fault}"
        );
    }

    /// Re-runs itself in a child with a global TRACE subscriber: tracing caches each callsite's
    /// interest per process, so a scoped one can miss an event a parallel test also reaches.
    #[test]
    fn logs_hold_no_token_or_key_and_the_engine_logs_no_mxc() {
        if env::var_os(LOG_PROBE).is_some() {
            let subscriber = tracing_subscriber::fmt()
                .with_ansi(false)
                .with_max_level(tracing::Level::TRACE)
                .with_writer(std::io::stdout)
                .finish();
            tracing::subscriber::set_global_default(subscriber).unwrap();
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                let base = binary_on_loopback(JS_CIPHERTEXT.to_vec());
                let (_root, engine, _rt) = live_on(&base).await;
                let good = content_of(&engine, encrypted(js_file(), whole())).await;
                println!("TOKEN {}", token_of(&good));

                let tampered = binary_on_loopback(vec![0; 13]);
                let (_root, engine, _rt) = live_on(&tampered).await;
                let bad = content_of(&engine, encrypted(js_file(), whole())).await;
                assert_eq!(code(&bad), "media-unavailable");
                content_of(&engine, encrypted(json!({"k": JS_K}), whole())).await;

                let (_root, engine, _rt) = live_on(OFFLINE).await;
                let down = content_of(&engine, encrypted(js_file(), whole())).await;
                assert_eq!(code(&down), "request-failed");
                let down = down.to_string();
                assert!(
                    !down.contains(JS_MEDIA_ID) && !down.contains(JS_SERVER),
                    "{down}"
                );
            });
            return;
        }

        let output = Command::new(env::current_exe().unwrap())
            .args([
                "--exact",
                "engines::media::tests::logs_hold_no_token_or_key_and_the_engine_logs_no_mxc",
                "--nocapture",
            ])
            .env(LOG_PROBE, "1")
            .output()
            .unwrap();
        let log = String::from_utf8(output.stdout).unwrap();
        assert!(output.status.success(), "{log}");

        let token = log
            .lines()
            .find_map(|line| line.strip_prefix("TOKEN "))
            .unwrap_or_else(|| panic!("no token: {log}"));
        assert_eq!(log.matches(token).count(), 1, "{log}");
        for secret in [JS_K, JS_IV, JS_SHA256, "mxc://", "hello from js"] {
            assert!(!log.contains(secret), "{secret}: {log}");
        }
        // The SDK's `send` span and its request error name the path; nothing of ours does.
        assert!(
            log.contains(JS_MEDIA_ID),
            "the probe never reached a request: {log}"
        );
        for line in log.lines().filter(|line| line.contains("trinity_engine")) {
            assert!(!line.contains(JS_MEDIA_ID), "{line}");
            assert!(!line.contains(JS_SERVER), "{line}");
        }
    }
}
