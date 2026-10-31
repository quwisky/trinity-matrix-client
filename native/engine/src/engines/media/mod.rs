//! `MediaEngine` (`libs/data-access/media/src/lib/media-engine.ts`): media bytes behind random
//! tokens. A download is never kept by the SDK's media store: its cache key ignores the file's hash
//! and it can write decrypted bytes to disk.

pub mod tokens;
pub mod upload;

use std::{borrow::Cow, fmt, future::ready, io::Read, sync::Arc, time::Duration};

use matrix_sdk::{
    Client, Error, HttpError, RumaApiError,
    bytes::Bytes,
    reqwest,
    ruma::{
        MxcUri, UInt,
        api::{
            OutgoingRequestExt, SupportedVersions,
            auth_scheme::SendAccessToken,
            client::authenticated_media::{get_content, get_content_thumbnail},
            error::{ErrorKind, RetryAfter},
        },
        events::room::EncryptedFile,
        exports::http,
        media::Method,
    },
    sleep::sleep,
};
use matrix_sdk_base::crypto::AttachmentDecryptor;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokens::MediaTokens;
use ts_rs::TS;

use crate::{
    accounts::{AccountRuntime, Engine},
    dispatch::{Stream, reply},
    engines::{
        member::until_retired,
        session::logout::{RawToken, raw_request},
    },
    failure::{
        EngineFailure, EngineResult, FailureCode, account_not_live, http_error_from_response,
        local_failure, request_failed,
    },
};

const DTO: &str = "data-access/media/src/lib/rust-dto/";

/// What a download may receive for a file, a thumbnail or ciphertext. A judgement: it opens large
/// videos on desktop and keeps the encrypted peak, ciphertext plus plaintext, near 1 GiB.
// shortcut: per download, so concurrent downloads can hold many times this; upgrade to a total
// across an engine when piece 4's memory numbers ask for one.
const MAX_MEDIA_BYTES: usize = 512 * 1024 * 1024;
/// js's three retries.
const ATTEMPTS: u32 = 4;
/// The SDK's first wait, which doubles.
const FIRST_BACKOFF: Duration = Duration::from_millis(500);

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

    // shortcut: a body up to the cap is held in memory, about twice its size at the peak for an
    // encrypted file, and in the token table after that; upgrade when `decrypted` and the host's
    // read can stream.
    async fn run(
        self,
        engine: &Arc<Engine>,
        rt: &AccountRuntime,
        limit: usize,
    ) -> Result<Vec<u8>, EngineFailure> {
        let failed = |err: Error| request_failed(&err);
        let supported = rt.client.supported_versions();
        let versions = engine.ruled(rt, supported).await.map_err(failed)?;
        let base = rt.client.homeserver().to_string();
        let read = raw_request(engine, rt, |token| {
            self.read(&rt.client, &base, &versions, token, limit)
        });
        let Some(bytes) = read.await.map_err(failed)? else {
            return Err(local_failure(FailureCode::TooLarge));
        };
        match self {
            Self::Encrypted(_, file) => decrypted(file, &bytes)
                .map_err(|Undecryptable| local_failure(FailureCode::MediaUnavailable)),
            Self::File(_) | Self::Thumbnail(_) => Ok(bytes),
        }
    }

    /// The body, retried as js does while a failure is transient. `None`: it is over `limit`.
    /// Sent raw because `Client::send` buffers a whole answer and no request config limits it.
    async fn read(
        &self,
        client: &Client,
        base: &str,
        versions: &SupportedVersions,
        token: Option<RawToken>,
        limit: usize,
    ) -> Result<Option<Vec<u8>>, Error> {
        let (mut attempt, mut backoff) = (1, FIRST_BACKOFF);
        loop {
            let err = match self
                .read_once(client, base, versions, token.as_ref(), limit)
                .await
            {
                Ok(body) => return Ok(body),
                Err(err) => err,
            };
            let wait = (attempt < ATTEMPTS).then(|| retry_wait(&err, backoff));
            let Some(wait) = wait.flatten() else {
                return Err(err.into());
            };
            sleep(wait).await;
            (attempt, backoff) = (attempt + 1, backoff * 2);
        }
    }

    /// One attempt, on the SDK's client, so its TLS, proxy and redirect settings come with it.
    async fn read_once(
        &self,
        client: &Client,
        base: &str,
        versions: &SupportedVersions,
        token: Option<&RawToken>,
        limit: usize,
    ) -> Result<Option<Vec<u8>>, HttpError> {
        let request = self.http_request(base, versions, token)?;
        let mut response = client
            .http_client()
            .execute(request)
            .await
            .map_err(no_url)?;
        let status = response.status();
        let Some(body) = capped(&mut response, limit).await.map_err(no_url)? else {
            return Ok(None);
        };
        if !status.is_success() {
            return Err(http_error_from_response(status, &body));
        }
        Ok(Some(body))
    }

    /// The request as the SDK would send it: ruma builds the path, encoding each part of it. As in
    /// js, no limit on the time: a retire or a close is what cuts it.
    fn http_request(
        &self,
        base: &str,
        versions: &SupportedVersions,
        token: Option<&RawToken>,
    ) -> Result<reqwest::Request, HttpError> {
        let token = token.map_or(SendAccessToken::None, |token| {
            SendAccessToken::IfRequired(token.as_str())
        });
        let versions = Cow::Borrowed(versions);
        let request: Result<http::Request<Vec<u8>>, _> = match self {
            Self::File(request) | Self::Encrypted(request, _) => {
                request.clone().try_into_http_request(base, token, versions)
            }
            Self::Thumbnail(request) => {
                request.clone().try_into_http_request(base, token, versions)
            }
        };
        let request = request.map_err(HttpError::IntoHttp)?;
        let mut request = reqwest::Request::try_from(request).map_err(no_url)?;
        *request.timeout_mut() = Some(Duration::MAX);
        Ok(request)
    }
}

/// A body of at most `limit` bytes, counted as it unpacks. `None`, and what was held is dropped: a
/// declared length over it, before any of the body is read, or a body that grows past it.
// shortcut: `Response::chunk` does not exist on wasm, where this needs reqwest's `stream` feature;
// upgrade when a wasm host (piece 5) ships.
async fn capped(
    response: &mut reqwest::Response,
    limit: usize,
) -> reqwest::Result<Option<Vec<u8>>> {
    let over = |declared| u64::try_from(limit).is_ok_and(|limit| declared > limit);
    if response.content_length().is_some_and(over) {
        return Ok(None);
    }
    let mut held = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if chunk.len() > limit - held.len() {
            return Ok(None);
        }
        held.extend_from_slice(&chunk);
    }
    Ok(Some(held))
}

/// A reqwest error, which would otherwise name the media path in its `Debug`.
fn no_url(err: reqwest::Error) -> HttpError {
    HttpError::Reqwest(err.without_url())
}

/// How long to wait before trying again, or `None` when trying again won't help: the SDK's own
/// reading of a failure, which it keeps private (`RetryKind`).
fn retry_wait(err: &HttpError, backoff: Duration) -> Option<Duration> {
    if matches!(err, HttpError::Reqwest(_)) {
        return Some(backoff);
    }
    let Some(RumaApiError::MatrixError(error)) = err.as_ruma_api_error() else {
        return None;
    };
    match error.error_kind() {
        Some(ErrorKind::LimitExceeded(limit)) => match limit.retry_after {
            Some(RetryAfter::Delay(delay)) => Some(delay),
            _ => Some(backoff),
        },
        Some(ErrorKind::Unrecognized) => None,
        _ => (error.status_code == http::StatusCode::TOO_MANY_REQUESTS
            || error.status_code.is_server_error())
        .then_some(backoff),
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
    let bytes =
        match until_retired(rt.retired(), download.run(engine, &rt, MAX_MEDIA_BYTES)).await? {
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
    use std::{
        env,
        io::Write,
        process::Command,
        sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    };

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
        engines::session::logout::{reload_tokens, save_tokens_callback, storage_effects},
        failure::RefreshCause,
        testing::{
            Seen, binary_on_loopback, builder_on, live, media_on_loopback, password, record,
            requests, scripted, session,
        },
    };

    const PREFIX: &str = "http://127.0.0.1:9/";
    const OFFLINE: &str = "http://127.0.0.1:1";
    const DOWNLOAD_AB: &str = "GET /_matrix/client/v1/media/download/a/b";
    const REFRESH: &str = "POST /_matrix/client/v3/refresh";
    const LOG_PROBE: &str = "TRINITY_MEDIA_LOG_PROBE";
    const LIMIT: usize = 1024;
    /// 4096 zero bytes, gzipped.
    const GZIP_4096: [u8; 38] = [
        0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xed, 0xc1, 0x01, 0x0d, 0x00,
        0x00, 0x00, 0xc2, 0xa0, 0xf7, 0x4f, 0x6d, 0x0f, 0x07, 0x14, 0x00, 0x00, 0x00, 0xf0, 0x6e,
        0x11, 0x00, 0x1c, 0xc7, 0x00, 0x10, 0x00, 0x00,
    ];
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

    pub(super) fn file_of(value: Value) -> EncryptedFile {
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

    pub(super) async fn live_on(base: &str) -> (TempDir, Arc<Engine>, Arc<AccountRuntime>) {
        let root = TempDir::new().unwrap();
        let engine = engine_on_prefix(&root);
        let client = builder_on(base).build().await.unwrap();
        let rt = live(&engine, &password(base), client).await;
        (root, engine, rt)
    }

    /// A homeserver that takes any request into `Seen` once the scripted `answers` are spent, the
    /// client's own background ones too, so read it through `media_requests`.
    pub(super) fn watched(mut answers: Vec<(&'static str, u16, Value)>) -> (String, Seen) {
        answers.extend(std::iter::repeat_n(("*", 200, json!({})), 8));
        scripted(answers)
    }

    pub(super) fn media_requests(seen: &Seen) -> Vec<String> {
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

    pub(super) fn code(reply: &Value) -> &str {
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
        // Each would change the request if it reached the URL as it stands.
        let bad_mxcs = [
            "",
            "nonsense",
            "mxc://a/../b",
            "mxc://bad server/b",
            "mxc://a/b?x=1",
            "mxc://a/b#c",
            "mxc://a/b%2f..%2fc",
            "mxc://a/b/c",
            "mxc://a/b\r\nx: y",
            "mxc://a\r\nx: y/b",
            "mxc://a@b/c",
        ];
        let mut rows: Vec<Value> = bad_mxcs
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

    fn unknown_token(soft: bool) -> Value {
        json!({"errcode": "M_UNKNOWN_TOKEN", "error": "x", "soft_logout": soft})
    }

    fn refreshed() -> (&'static str, u16, Value) {
        (
            REFRESH,
            200,
            json!({"access_token": "t2", "refresh_token": "r2"}),
        )
    }

    fn bearer(token: &str) -> Option<String> {
        Some(format!("Bearer {token}"))
    }

    /// An account whose session can refresh: its token is `t1`.
    async fn refreshable_on(base: &str) -> (TempDir, Arc<Engine>, Arc<AccountRuntime>) {
        let root = TempDir::new().unwrap();
        let engine = engine_on_prefix(&root);
        let client = builder_on(base).build().await.unwrap();
        let rt = live(&engine, &session("@a:b", base), client).await;
        (root, engine, rt)
    }

    fn head_and(status: u16, headers: &str, body: &[u8]) -> Vec<u8> {
        let head = format!("HTTP/1.1 {status} X\r\n{headers}connection: close\r\n\r\n");
        [head.as_bytes(), body].concat()
    }

    fn declared(length: usize, body: &[u8]) -> Vec<u8> {
        head_and(200, &format!("content-length: {length}\r\n"), body)
    }

    fn chunks_of(body: &[u8]) -> Vec<u8> {
        let mut framed = Vec::new();
        for chunk in body.chunks(256) {
            framed.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
            framed.extend_from_slice(chunk);
            framed.extend_from_slice(b"\r\n");
        }
        framed.extend_from_slice(b"0\r\n\r\n");
        framed
    }

    fn chunked(body: &[u8]) -> Vec<u8> {
        head_and(200, "transfer-encoding: chunked\r\n", &chunks_of(body))
    }

    /// No length: the body ends when the connection does.
    fn to_the_close(body: &[u8]) -> Vec<u8> {
        head_and(200, "", body)
    }

    /// A homeserver whose `n`th media request gets the `n`th of `replies`, the last for any later
    /// one, and how many it has had.
    fn replying(replies: Vec<Vec<u8>>) -> (String, Arc<AtomicUsize>) {
        let count = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&count);
        let base = media_on_loopback(move |n, stream| {
            counted.fetch_add(1, Ordering::SeqCst);
            stream.write_all(&replies[n.min(replies.len() - 1)])
        });
        (base, count)
    }

    /// A homeserver that really streams: a chunked body with no end, and what it has sent, and
    /// whether the client has gone, which ends it.
    fn endless() -> (String, Arc<AtomicUsize>, Arc<AtomicBool>) {
        let (sent, gone) = (
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicBool::new(false)),
        );
        let (counted, flag) = (Arc::clone(&sent), Arc::clone(&gone));
        let base = media_on_loopback(move |_, stream| {
            let chunk = [b"400\r\n", &[7; 1024][..], b"\r\n"].concat();
            stream.write_all(b"HTTP/1.1 200 X\r\ntransfer-encoding: chunked\r\n\r\n")?;
            while stream.write_all(&chunk).is_ok() {
                counted.fetch_add(chunk.len(), Ordering::SeqCst);
            }
            flag.store(true, Ordering::SeqCst);
            Ok(())
        });
        (base, sent, gone)
    }

    async fn the_client_goes(gone: &AtomicBool) {
        for _ in 0..100 {
            if gone.load(Ordering::SeqCst) {
                return;
            }
            sleep(Duration::from_millis(50)).await;
        }
        panic!("the client kept the connection open");
    }

    /// `row`'s download under a `limit` small enough to reach.
    async fn limited(
        engine: &Arc<Engine>,
        rt: &AccountRuntime,
        limit: usize,
        row: Value,
    ) -> Result<Vec<u8>, EngineFailure> {
        download_of(row).run(engine, rt, limit).await
    }

    fn is_too_large<T: fmt::Debug>(answer: Result<T, EngineFailure>) {
        let failure = answer.unwrap_err();
        assert_eq!(failure.code, FailureCode::TooLarge);
    }

    #[tokio::test]
    async fn a_body_at_the_limit_is_served_and_one_byte_over_is_refused_once() {
        let at = vec![7; LIMIT];
        let over = vec![7; LIMIT + 1];
        let framings = [
            [declared(LIMIT, &at), declared(LIMIT + 1, &over)],
            [chunked(&at), chunked(&over)],
            [to_the_close(&at), to_the_close(&over)],
        ];
        for replies in framings {
            let (base, count) = replying(replies.to_vec());
            let (_root, engine, rt) = live_on(&base).await;
            let row = plain("mxc://a/b");
            let served = limited(&engine, &rt, LIMIT, row.clone()).await.unwrap();
            assert_eq!(served, at);
            is_too_large(limited(&engine, &rt, LIMIT, row).await);
            assert_eq!(
                count.load(Ordering::SeqCst),
                2,
                "the refusal is not retried"
            );
        }
    }

    /// The head says so and the connection ends: reading on would meet a truncated body and retry.
    #[tokio::test]
    async fn a_declared_length_over_the_limit_refuses_without_reading_the_body() {
        let (base, count) = replying(vec![declared(LIMIT + 1, b"")]);
        let (_root, engine, rt) = live_on(&base).await;
        is_too_large(limited(&engine, &rt, LIMIT, plain("mxc://a/b")).await);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    /// The real cap, reached by the head alone so that nothing is allocated.
    #[tokio::test]
    async fn content_refuses_a_length_over_the_cap_for_every_source() {
        assert_eq!(MAX_MEDIA_BYTES, 512 * 1024 * 1024);
        let (base, count) = replying(vec![declared(MAX_MEDIA_BYTES + 1, b"")]);
        let (_root, engine, _rt) = live_on(&base).await;
        let thumb = request(json!({"kind": "plain", "mxc": "mxc://a/b"}), thumbnail());
        let rows = [plain("mxc://a/b"), thumb, encrypted(js_file(), whole())];
        let total = rows.len();
        for row in rows {
            let reply = content_of(&engine, row.clone()).await;
            assert_eq!(code(&reply), "too-large", "{row}");
            assert_ne!(reply["failure"]["kind"], json!("network"), "{row}");
            assert_eq!(engine.media.tokens.len(), 0, "{row}");
        }
        assert_eq!(count.load(Ordering::SeqCst), total, "none is retried");
    }

    /// One byte under the refusal above, so the head passes and the missing body fails as a read.
    #[tokio::test]
    async fn content_reads_on_at_a_length_of_exactly_the_cap() {
        let (base, count) = replying(vec![declared(MAX_MEDIA_BYTES, b"")]);
        let (_root, engine, _rt) = live_on(&base).await;
        let reply = content_of(&engine, plain("mxc://a/b")).await;
        assert_eq!(code(&reply), "request-failed");
        assert_eq!(count.load(Ordering::SeqCst), 4);
    }

    /// HTTP/1.1 cannot deliver more than a length declares, so a short one can't carry a large body.
    #[tokio::test]
    async fn a_length_short_of_its_body_delivers_only_what_it_declares() {
        let (base, _) = replying(vec![declared(10, &[7; 2 * LIMIT])]);
        let (_root, engine, rt) = live_on(&base).await;
        let served = limited(&engine, &rt, LIMIT, plain("mxc://a/b")).await;
        assert_eq!(served.unwrap().len(), 10);
    }

    /// With both, the chunked framing is the one that counts: the small length hides nothing.
    #[tokio::test]
    async fn a_false_length_beside_a_chunked_body_is_refused_at_the_limit() {
        let headers = "content-length: 1\r\ntransfer-encoding: chunked\r\n";
        let (base, count) = replying(vec![head_and(200, headers, &chunks_of(&[7; LIMIT + 1]))]);
        let (_root, engine, rt) = live_on(&base).await;
        is_too_large(limited(&engine, &rt, LIMIT, plain("mxc://a/b")).await);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn an_endless_body_stops_at_the_limit_and_the_connection_ends() {
        let (base, sent, gone) = endless();
        let (_root, engine, rt) = live_on(&base).await;
        is_too_large(limited(&engine, &rt, LIMIT, plain("mxc://a/b")).await);
        the_client_goes(&gone).await;
        assert!(sent.load(Ordering::SeqCst) > LIMIT);
    }

    /// The limit is on what the client holds, so a small body that unpacks past it is refused.
    #[tokio::test]
    async fn a_gzip_body_is_counted_as_it_unpacks() {
        let headers = format!(
            "content-encoding: gzip\r\ncontent-length: {}\r\n",
            GZIP_4096.len()
        );
        let (base, _) = replying(vec![head_and(200, &headers, &GZIP_4096)]);
        let (_root, engine, rt) = live_on(&base).await;
        is_too_large(limited(&engine, &rt, LIMIT, plain("mxc://a/b")).await);
        let served = limited(&engine, &rt, 4096, plain("mxc://a/b")).await;
        assert_eq!(served.unwrap(), vec![0; 4096]);
    }

    #[tokio::test]
    async fn ciphertext_over_the_limit_is_refused_and_under_it_decrypts() {
        let (base, _) = replying(vec![declared(JS_CIPHERTEXT.len(), &JS_CIPHERTEXT)]);
        let (_root, engine, rt) = live_on(&base).await;
        let row = encrypted(js_file(), whole());
        is_too_large(limited(&engine, &rt, JS_CIPHERTEXT.len() - 1, row.clone()).await);
        let served = limited(&engine, &rt, JS_CIPHERTEXT.len(), row).await;
        assert_eq!(served.unwrap(), PLAIN);
    }

    #[tokio::test]
    async fn a_refreshed_token_serves_the_download() {
        let (base, seen) = scripted(vec![
            (DOWNLOAD_AB, 401, unknown_token(false)),
            refreshed(),
            (DOWNLOAD_AB, 200, json!({})),
        ]);
        let (_root, engine, rt) = refreshable_on(&base).await;
        let reply = content_of(&engine, plain("mxc://a/b")).await;
        assert_eq!(reply["ok"], json!(true), "{reply}");
        assert_eq!(
            requests(&seen),
            [
                (DOWNLOAD_AB.to_owned(), bearer("t1")),
                (REFRESH.to_owned(), None),
                (DOWNLOAD_AB.to_owned(), bearer("t2")),
            ]
        );
        assert_eq!(rt.client.access_token().as_deref(), Some("t2"));
        assert!(engine.account("@a:b").is_some());
    }

    #[tokio::test]
    async fn a_download_answers_once_the_rotation_of_its_refresh_is_delivered() {
        let (base, _) = scripted(vec![
            (DOWNLOAD_AB, 401, unknown_token(false)),
            refreshed(),
            (DOWNLOAD_AB, 200, json!({})),
        ]);
        let root = TempDir::new().unwrap();
        let engine = engine_on_prefix(&root);
        let mut effects = storage_effects(Arc::clone(&engine));
        let client = builder_on(&base)
            .handle_refresh_tokens()
            .build()
            .await
            .unwrap();
        let save = save_tokens_callback(Arc::downgrade(&engine), "@a:b".into(), None);
        (client.set_session_callbacks(Box::new(reload_tokens), Box::new(save))).unwrap();
        drop(live(&engine, &session("@a:b", &base), client).await);

        let mut reply = Box::pin(content_of(&engine, plain("mxc://a/b")));
        let early = timeout(reply.as_mut(), Duration::from_secs(1)).await;
        assert!(early.is_err(), "the reply waits for tokens-rotated");
        let rotated = effects.next().await.unwrap().unwrap();
        assert_eq!(rotated["kind"], json!("tokens-rotated"));
        assert!(effects.next().now_or_never().is_none());
        assert_eq!(reply.await["ok"], json!(true));
    }

    /// Both answers are in the interface, and which one comes depends on whether the logout has
    /// been delivered when the retire is seen. What matters is that the logout comes first.
    #[tokio::test]
    async fn an_unknown_token_during_a_download_logs_the_account_out_before_the_reply() {
        for (soft, kind) in [(false, "hard-logout"), (true, "soft-logout")] {
            let (base, seen) = scripted(vec![(DOWNLOAD_AB, 401, unknown_token(soft))]);
            let (_root, engine, rt) = live_on(&base).await;
            let effects = record(&engine);
            let reply = content_of(&engine, plain("mxc://a/b")).await;
            assert!(
                ["account-not-live", "request-failed"].contains(&code(&reply)),
                "{reply}"
            );
            assert_eq!(
                *effects.lock().unwrap(),
                [json!({"kind": kind, "accountId": "@a:b", "activeAccountId": null})]
            );
            assert!(engine.account("@a:b").is_none());
            assert!(*rt.retired().borrow());
            assert_eq!(media_requests(&seen).len(), 1);
            assert_eq!(engine.media.tokens.len(), 0);
        }
    }

    #[tokio::test]
    async fn a_refused_refresh_logs_the_account_out() {
        let (base, seen) = scripted(vec![
            (DOWNLOAD_AB, 401, unknown_token(true)),
            (REFRESH, 401, unknown_token(false)),
        ]);
        let (_root, engine, _rt) = refreshable_on(&base).await;
        let effects = record(&engine);
        let reply = content_of(&engine, plain("mxc://a/b")).await;
        assert!(
            ["account-not-live", "request-failed"].contains(&code(&reply)),
            "{reply}"
        );
        assert_eq!(
            *effects.lock().unwrap(),
            [json!({"kind": "soft-logout", "accountId": "@a:b", "activeAccountId": null})]
        );
        assert!(engine.account("@a:b").is_none());
        assert_eq!(media_requests(&seen).len(), 1);
    }

    #[tokio::test]
    async fn a_second_unknown_token_after_a_refresh_logs_the_account_out_without_a_third_try() {
        let dead = || (DOWNLOAD_AB, 401, unknown_token(false));
        let (base, seen) = scripted(vec![dead(), refreshed(), dead()]);
        let (_root, engine, _rt) = refreshable_on(&base).await;
        let effects = record(&engine);
        content_of(&engine, plain("mxc://a/b")).await;
        assert_eq!(
            *effects.lock().unwrap(),
            [json!({"kind": "hard-logout", "accountId": "@a:b", "activeAccountId": null})]
        );
        assert_eq!(media_requests(&seen).len(), 2);
    }

    #[tokio::test]
    async fn a_failed_refresh_keeps_the_account_and_says_so() {
        let (base, seen) = scripted(vec![
            (DOWNLOAD_AB, 401, unknown_token(false)),
            (REFRESH, 502, json!({"errcode": "M_UNKNOWN", "error": "x"})),
        ]);
        let (_root, engine, rt) = refreshable_on(&base).await;
        let effects = record(&engine);
        let answer = limited(&engine, &rt, LIMIT, plain("mxc://a/b")).await;
        let FailureCode::RequestFailed { cause, .. } = answer.unwrap_err().code else {
            panic!("not request-failed");
        };
        assert_eq!(cause, Some(RefreshCause::SessionRefresh));
        assert!(engine.account("@a:b").is_some());
        assert!(effects.lock().unwrap().is_empty());
        assert_eq!(media_requests(&seen).len(), 1);
    }

    /// Only `M_UNKNOWN_TOKEN` speaks of the session, as the SDK reads it.
    #[tokio::test]
    async fn another_401_is_a_plain_failure_with_no_refresh() {
        for body in [
            json!({"errcode": "M_MISSING_TOKEN", "error": "x"}),
            json!({"error": "not a matrix error"}),
        ] {
            let (base, seen) = scripted(vec![(DOWNLOAD_AB, 401, body)]);
            let (_root, engine, _rt) = refreshable_on(&base).await;
            let effects = record(&engine);
            let reply = content_of(&engine, plain("mxc://a/b")).await;
            assert_eq!(code(&reply), "request-failed", "{reply}");
            assert_eq!(requests(&seen).len(), 1);
            assert!(engine.account("@a:b").is_some());
            assert!(effects.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn a_retry_starts_from_an_empty_buffer() {
        let (base, count) = replying(vec![declared(8, b"aaaa"), declared(8, b"bbbbbbbb")]);
        let (_root, engine, rt) = live_on(&base).await;
        let served = limited(&engine, &rt, 8, plain("mxc://a/b")).await;
        assert_eq!(served.unwrap(), b"bbbbbbbb");
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_refusal_ends_the_retries() {
        let (base, count) = replying(vec![
            head_and(502, "content-length: 0\r\n", b""),
            declared(LIMIT + 1, b""),
            declared(1, b"x"),
        ]);
        let (_root, engine, rt) = live_on(&base).await;
        is_too_large(limited(&engine, &rt, LIMIT, plain("mxc://a/b")).await);
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_4xx_is_not_retried() {
        for status in [400, 403, 404, 410] {
            let (base, count) = replying(vec![head_and(status, "content-length: 0\r\n", b"")]);
            let (_root, engine, _rt) = live_on(&base).await;
            let reply = content_of(&engine, plain("mxc://a/b")).await;
            assert_eq!(code(&reply), "request-failed", "{status}");
            assert_eq!(count.load(Ordering::SeqCst), 1, "{status}");
        }
    }

    /// As the SDK's retry. How long it waits is in the table below.
    #[tokio::test]
    async fn a_rate_limit_is_retried() {
        let body =
            json!({"errcode": "M_LIMIT_EXCEEDED", "error": "x", "retry_after_ms": 1}).to_string();
        let headers = format!("content-length: {}\r\n", body.len());
        let (base, count) = replying(vec![
            head_and(429, &headers, body.as_bytes()),
            declared(1, b"x"),
        ]);
        let (_root, engine, rt) = live_on(&base).await;
        let served = limited(&engine, &rt, LIMIT, plain("mxc://a/b")).await;
        assert_eq!(served.unwrap(), b"x");
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn what_is_transient_is_as_the_sdk_has_it() {
        let backoff = Duration::from_secs(7);
        let matrix = |code: &str| json!({"errcode": code, "error": "x"}).to_string();
        let limit = json!({"errcode": "M_LIMIT_EXCEEDED", "error": "x", "retry_after_ms": 1500});
        let limit = limit.to_string();
        let flows = json!({"flows": [], "session": "s"}).to_string();
        let table = [
            (500, "", Some(backoff)),
            (502, "{}", Some(backoff)),
            (502, "<html>", Some(backoff)),
            (503, &matrix("M_UNKNOWN"), Some(backoff)),
            (429, "", Some(backoff)),
            (429, &limit, Some(Duration::from_millis(1500))),
            (500, &matrix("M_UNRECOGNIZED"), None),
            (400, "", None),
            (401, &matrix("M_UNKNOWN_TOKEN"), None),
            (401, &flows, None),
            (404, &matrix("M_NOT_FOUND"), None),
        ];
        for (status, body, expected) in table {
            let status = http::StatusCode::from_u16(status).unwrap();
            let error = http_error_from_response(status, body.as_bytes());
            assert_eq!(retry_wait(&error, backoff), expected, "{status} {body}");
        }
    }

    #[tokio::test]
    async fn retire_cuts_a_download_in_the_middle_of_its_body() {
        let (base, sent, gone) = endless();
        let (_root, engine, rt) = live_on(&base).await;
        let before = Arc::strong_count(&rt);
        let args = vec![json!("@a:b"), plain("mxc://a/b")];
        let mut replies = dispatch(&engine, "media.content", args).unwrap();
        for _ in 0..50 {
            if sent.load(Ordering::SeqCst) > 64 * 1024 {
                break;
            }
            let wait = Duration::from_millis(100);
            assert!(
                timeout(replies.next(), wait).await.is_err(),
                "answered early"
            );
        }
        assert!(sent.load(Ordering::SeqCst) > 64 * 1024, "still in its head");

        rt.set_retired();
        let reply = timeout(replies.next(), Duration::from_secs(2))
            .await
            .expect("the reply comes at once")
            .unwrap()
            .unwrap();
        assert_eq!(code(&reply), "account-not-live");
        assert_eq!(Arc::strong_count(&rt), before);
        assert_eq!(engine.media.tokens.len(), 0);
        the_client_goes(&gone).await;
    }

    /// The request the SDK would have sent, to the byte of its target, with its header.
    #[tokio::test]
    async fn a_download_goes_on_the_wire_as_the_sdk_sends_it() {
        const ANY_MEDIA: &str = "GET /_matrix/client/v1/media/*";
        let thumb = |method: &str, animated: bool| {
            let format = json!({
                "kind": "thumbnail", "width": 32, "height": 48, "method": method, "animated": animated,
            });
            request(json!({"kind": "plain", "mxc": "mxc://a/b"}), format)
        };
        for row in [
            plain("mxc://a/b"),
            thumb("scale", false),
            thumb("crop", true),
        ] {
            let (base, seen) = watched(vec![
                (ANY_MEDIA, 200, json!({})),
                (ANY_MEDIA, 200, json!({})),
            ]);
            let (_root, engine, rt) = live_on(&base).await;
            match download_of(row.clone()) {
                Download::File(request) => {
                    rt.client.send(request).await.unwrap();
                }
                Download::Thumbnail(request) => {
                    rt.client.send(request).await.unwrap();
                }
                Download::Encrypted(..) => unreachable!(),
            }
            assert_eq!(content_of(&engine, row).await["ok"], json!(true));
            let sent = requests(&seen);
            let sent: Vec<_> = sent.iter().filter(|(t, _)| t.contains("/media/")).collect();
            assert_eq!(sent.len(), 2);
            assert_eq!(sent[0], sent[1]);
            assert_eq!(sent[1].1, bearer("t1"));
        }
    }

    fn download_of(row: Value) -> Download {
        let request: MediaRequestDto = serde_json::from_value(row).unwrap();
        Download::of(request.source, request.format).unwrap()
    }

    /// The client's own limit is 30 s, and a large file takes longer.
    #[tokio::test]
    async fn a_download_has_no_time_limit_and_needs_a_token() {
        let (_root, _engine, rt) = live_on(OFFLINE).await;
        let versions = rt.client.supported_versions().await.unwrap();
        let download = download_of(plain("mxc://a/b"));
        let token = RawToken::for_tests("t");
        let request = download.http_request(OFFLINE, &versions, Some(&token));
        assert_eq!(request.unwrap().timeout(), Some(&Duration::MAX));
        let refused = download.http_request(OFFLINE, &versions, None);
        assert!(matches!(refused, Err(HttpError::IntoHttp(_))));
    }

    #[tokio::test]
    async fn a_failed_read_names_no_media_path() {
        let (_root, _engine, rt) = live_on(OFFLINE).await;
        let versions = rt.client.supported_versions().await.unwrap();
        let download = download_of(plain("mxc://secret.example/secretid"));
        let token = RawToken::for_tests("t");
        let err = download
            .read_once(&rt.client, OFFLINE, &versions, Some(&token), LIMIT)
            .await
            .unwrap_err();
        assert!(matches!(err, HttpError::Reqwest(_)), "{err:?}");
        assert!(!format!("{err:?}").contains("secret"), "{err:?}");
        assert!(!err.to_string().contains("secret"), "{err}");
    }

    /// A client that was never told the versions asks, as the SDK's send would.
    #[tokio::test]
    async fn a_download_asks_for_the_versions_it_was_not_told() {
        let (base, seen) = scripted(vec![(DOWNLOAD_AB, 200, json!({}))]);
        let root = TempDir::new().unwrap();
        let engine = engine_on_prefix(&root);
        let client = Client::builder()
            .homeserver_url(&base)
            .build()
            .await
            .unwrap();
        let _rt = live(&engine, &password(&base), client).await;
        let reply = content_of(&engine, plain("mxc://a/b")).await;
        assert_eq!(reply["ok"], json!(true), "{reply}");
        assert_eq!(media_requests(&seen), [DOWNLOAD_AB]);
    }

    /// As the SDK's client does: a media server elsewhere never sees the account's token.
    #[tokio::test]
    async fn a_redirect_to_another_host_does_not_carry_the_token() {
        let (elsewhere, seen_elsewhere) = scripted(vec![("GET /file", 200, json!({}))]);
        let location = json!(format!("{elsewhere}/file"));
        let (base, seen) = scripted(vec![(DOWNLOAD_AB, 307, location)]);
        let (_root, engine, _rt) = live_on(&base).await;
        let reply = content_of(&engine, plain("mxc://a/b")).await;
        assert_eq!(reply["ok"], json!(true), "{reply}");
        assert_eq!(requests(&seen)[0].1, bearer("t1"));
        assert_eq!(requests(&seen_elsewhere)[0].1, None);
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
    fn logs_hold_no_token_key_or_media_path() {
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

                let (over, _) = replying(vec![declared(MAX_MEDIA_BYTES + 1, b"")]);
                let (_root, engine, _rt) = live_on(&over).await;
                let refused = content_of(&engine, encrypted(js_file(), whole())).await;
                assert_eq!(code(&refused), "too-large");

                let target = "GET /_matrix/client/v1/media/download/example.org/abcdefgh";
                let (dead, _) = scripted(vec![
                    (target, 502, json!({})),
                    (target, 401, unknown_token(false)),
                ]);
                let (_root, engine, _rt) = live_on(&dead).await;
                content_of(&engine, encrypted(js_file(), whole())).await;
            });
            return;
        }

        let output = Command::new(env::current_exe().unwrap())
            .args([
                "--exact",
                "engines::media::tests::logs_hold_no_token_key_or_media_path",
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
        // The probe's answers above prove its requests went out. A download leaves the SDK's
        // `send` out, so its span and its request error can't name the path either.
        assert!(!log.contains(JS_MEDIA_ID), "{log}");
        assert!(!log.contains(JS_SERVER), "{log}");
        assert!(!log.contains("Bearer"), "{log}");
    }
}
