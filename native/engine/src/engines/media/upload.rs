//! `MediaEngine.upload` and `uploadLimit`. An upload is one POST. The only resend is the SDK's, once,
//! after a refused token is refreshed: the server stored nothing for the refused one.

use std::{fmt, io::Cursor, pin::pin, sync::Arc, time::Duration};

use futures_util::{
    StreamExt,
    future::{Either, select},
};
use matrix_sdk::{
    Error, SendOutsideWasm, TransmissionProgress,
    ruma::api::client::{authenticated_media::get_media_config, media::create_content},
    sleep::sleep,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::DTO;
use crate::{
    accounts::{AccountRuntime, Engine},
    dispatch::{Args, Stream, item, reply, stream},
    engines::member::{on_account, sent_once, until_retired},
    failure::{
        EngineResult, FailureCode, account_not_live, classify, local_failure, request_failed,
        too_large_or_failed,
    },
    wire::{BlobRefDto, Fault},
};

/// The SDK's own `reasonable_upload_timeout`, which an encrypted upload gets from it: 1 Mbit/s.
const UPLOAD_BYTES_PER_SECOND: u64 = 125_000;
const MIN_UPLOAD_TIMEOUT: Duration = Duration::from_secs(300);
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

/// `UploadRequest`.
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct UploadRequestDto {
    pub(super) filename: Option<String>,
    pub(super) mime_type: String,
    pub(super) encrypt: bool,
}

/// `UploadedContent`.
#[derive(Serialize, TS)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[ts(export, export_to = DTO)]
pub enum UploadedContentDto {
    Plain {
        mxc: String,
        #[ts(type = "number")]
        size: u64,
    },
    Encrypted {
        #[ts(
            type = "{ url: string, key: JsonWebKey, iv: string, hashes: Record<string, string>, v: string }"
        )]
        file: Value,
        #[ts(type = "number")]
        size: u64,
    },
}

/// `phase` of a `TransferUpdate`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferPhaseDto {
    Encrypting,
    Uploading,
    Sending,
}

/// `TransferUpdate`: progress, then exactly one `done`.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TransferUpdateDto<T> {
    Progress {
        phase: TransferPhaseDto,
        fraction: f64,
    },
    Done {
        result: EngineResult<T>,
    },
}

// A file name is the user's, an mxc URI names their media, and a file holds its key.

impl fmt::Debug for UploadRequestDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("UploadRequestDto")
            .field("encrypt", &self.encrypt)
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for UploadedContentDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (name, size) = match self {
            Self::Plain { size, .. } => ("Plain", size),
            Self::Encrypted { size, .. } => ("Encrypted", size),
        };
        f.debug_struct(name)
            .field("size", size)
            .finish_non_exhaustive()
    }
}

/// js `p.loaded / p.total`, 0 while the total is unknown.
fn fraction_of(progress: TransmissionProgress) -> f64 {
    if progress.total == 0 {
        return 0.0;
    }
    // `as` is refused here and `f64::from` takes nothing wider than `u32`, so count in parts of it.
    let whole = u128::from(u32::MAX);
    let wide = |n: usize| u128::try_from(n).unwrap_or(u128::MAX);
    let parts = wide(progress.current).saturating_mul(whole) / wide(progress.total);
    // Past the whole is the whole.
    let parts = u32::try_from(parts).unwrap_or(u32::MAX);
    f64::from(parts) / f64::from(u32::MAX)
}

/// `first` at 0 at once, then `fraction` as `uploading` when it has changed, at most once per
/// 100 ms, then `send`'s `done`.
// shortcut: wasm's HTTP client ignores upload progress, so there a transfer shows only its first
// update; upgrade when the SDK reports it on wasm, or disclose it with the wasm host (piece 5).
fn throttled<T>(
    first: TransferPhaseDto,
    fraction: impl Fn() -> f64,
    send: impl Future<Output = EngineResult<T>>,
) -> impl futures_util::Stream<Item = TransferUpdateDto<T>> {
    async_stream::stream! {
        yield TransferUpdateDto::Progress { phase: first, fraction: 0.0 };
        let mut send = pin!(send);
        let mut shown = 0.0;
        let result = loop {
            match select(&mut send, pin!(sleep(PROGRESS_EVERY))).await {
                Either::Left((result, _)) => break result,
                Either::Right(_) => {
                    let now = fraction();
                    if now != shown {
                        shown = now;
                        yield TransferUpdateDto::Progress {
                            phase: TransferPhaseDto::Uploading,
                            fraction: now,
                        };
                    }
                }
            }
        };
        yield TransferUpdateDto::Done { result };
    }
}

async fn answered(
    sent: impl Future<Output = Result<UploadedContentDto, Error>>,
) -> EngineResult<UploadedContentDto> {
    match sent.await {
        Ok(content) => EngineResult::Ok(content),
        Err(err) => EngineResult::Err(too_large_or_failed(&err)),
    }
}

/// js `this.upload`: limit check, first progress, the send, one `done`. Used by `upload` and by
/// the attachment send.
pub(super) fn transfer(
    engine: Arc<Engine>,
    rt: Arc<AccountRuntime>,
    bytes: Vec<u8>,
    request: UploadRequestDto,
) -> impl futures_util::Stream<Item = TransferUpdateDto<UploadedContentDto>> + SendOutsideWasm {
    async_stream::stream! {
        let size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        // Checked before sending, as js does: Synapse drops an oversized body.
        if limit_of(&engine, &rt).await.is_some_and(|limit| size > limit) {
            yield TransferUpdateDto::Done {
                result: EngineResult::Err(local_failure(FailureCode::TooLarge)),
            };
            return;
        }
        if request.encrypt {
            // shortcut: the SDK encrypts inside this future, so a large file stalls one worker and
            // a retire waits for it; upgrade if the SDK takes ciphertext, or before a wasm host.
            // shortcut: the SDK reads the limit again on a client's first encrypted upload, on its
            // default config, which retries a 5xx for up to 15 minutes, and a failure fails the
            // upload where js sends it; upgrade to `AttachmentEncryptor` and our own send if a
            // homeserver's media config is seen failing.
            let mut reader = Cursor::new(bytes);
            let send = (rt.client.upload_encrypted_file(&mut reader))
                .with_request_config(sent_once());
            let progress = send.subscribe_to_send_progress();
            let fraction = move || fraction_of(progress.get());
            let sent = answered(async {
                let file = engine.ruled(&rt, send).await?;
                let file = serde_json::to_value(&file)?;
                Ok(UploadedContentDto::Encrypted { file, size })
            });
            for await update in throttled(TransferPhaseDto::Encrypting, fraction, sent) {
                yield update;
            }
        } else {
            let timeout = Duration::from_secs(size / UPLOAD_BYTES_PER_SECOND);
            let mut upload = create_content::v3::Request::new(bytes);
            upload.filename = request.filename;
            upload.content_type = Some(request.mime_type);
            let config = sent_once().timeout(timeout.max(MIN_UPLOAD_TIMEOUT));
            let send = rt.client.send(upload).with_request_config(config);
            let progress = send.subscribe_to_send_progress();
            let fraction = move || fraction_of(progress.get());
            let sent = answered(async {
                let response = engine.ruled(&rt, send).await?;
                let mxc = response.content_uri.to_string();
                Ok(UploadedContentDto::Plain { mxc, size })
            });
            for await update in throttled(TransferPhaseDto::Uploading, fraction, sent) {
                yield update;
            }
        }
    }
}

/// The upload limit, kept for the runtime; a failed lookup or a size of 0 is None and not kept.
pub(super) async fn limit_of(engine: &Arc<Engine>, rt: &AccountRuntime) -> Option<u64> {
    if let Some(limit) = rt.upload_limit.get() {
        return Some(*limit);
    }
    let request = get_media_config::v1::Request::new();
    let send = rt.client.send(request).with_request_config(sent_once());
    match engine.ruled(rt, send).await {
        Ok(response) => {
            let limit = u64::from(response.upload_size);
            (limit > 0).then(|| *rt.upload_limit.get_or_init(|| limit))
        }
        Err(err) => {
            let (kind, _) = classify(&err);
            tracing::warn!(?kind, "reading the upload limit failed");
            None
        }
    }
}

/// Uploads a Blob, reporting progress then one `done`. Unsubscribing aborts it. Not through
/// `account_stream`: its silence once retired would leave the caller waiting for the `done`.
pub fn upload(engine: Arc<Engine>, args: &mut Args<'_>) -> Result<Stream, Fault> {
    let account_id: String = args.decode()?;
    let at: BlobRefDto = args.decode()?;
    let request: UploadRequestDto = args.decode()?;
    let bytes = args.blob(at)?;
    Ok(stream(async_stream::stream! {
        if let Some(rt) = engine.account(&account_id) {
            let retired = rt.retired();
            let mut updates = Box::pin(transfer(Arc::clone(&engine), rt, bytes, request));
            while let Some(update) = until_retired(retired.clone(), updates.next()).await {
                match update {
                    Some(progress @ TransferUpdateDto::Progress { .. }) => yield item(progress),
                    // The account is let go of with the `done`, not at the next poll.
                    Some(done) => {
                        drop(updates);
                        yield item(done);
                        return;
                    }
                    None => return,
                }
            }
        }
        // Every path here has let go of the account. The sync may have met a dead token first: its
        // logout reaches the caller first.
        engine.deaths_of(&account_id).delivered().await;
        yield item(TransferUpdateDto::<UploadedContentDto>::Done {
            result: EngineResult::Err(account_not_live()),
        });
    }))
}

/// The homeserver's `m.upload.size`, or null when it states none or cannot be asked.
pub fn upload_limit(engine: Arc<Engine>, account_id: String) -> Stream {
    reply(on_account(
        engine,
        account_id,
        request_failed,
        |engine, rt| async move { Ok::<_, Error>(limit_of(&engine, &rt).await) },
    ))
}

#[cfg(test)]
mod tests {
    use std::{
        env,
        process::Command,
        sync::atomic::{AtomicU32, Ordering},
        time::Duration,
    };

    use futures_util::{FutureExt, StreamExt};
    use matrix_sdk::{ruma::events::room::EncryptedFile, sleep::sleep, timeout::timeout};
    use serde_json::json;
    use tempfile::TempDir;

    use super::{
        super::tests::{code, file_of, live_on, media_requests, watched},
        *,
    };
    use crate::{
        barrier::Subscribers,
        config::EngineConfig,
        dispatch::{dispatch, dispatch_bytes},
        failure::{FailureCode, local_failure},
        testing::{Seen, requests, scripted},
        wire::FaultCode,
    };

    const CONFIG: &str = "GET /_matrix/client/v1/media/config";
    const UPLOAD: &str = "POST /_matrix/media/v3/upload";
    const NAMED: &str = "POST /_matrix/media/v3/upload?filename=photo.png";
    const MXC: &str = "mxc://secret.example/secretid";
    const LOG_PROBE: &str = "TRINITY_UPLOAD_LOG_PROBE";

    type Answer = (&'static str, u16, Value);

    fn limit(size: u64) -> Answer {
        (CONFIG, 200, json!({"m.upload.size": size}))
    }

    fn stored(target: &'static str) -> Answer {
        (target, 200, json!({"content_uri": MXC}))
    }

    fn plain(filename: Value) -> Value {
        json!({"filename": filename, "mimeType": "image/png", "encrypt": false})
    }

    fn encrypted() -> Value {
        json!({"filename": "x", "mimeType": "image/png", "encrypt": true})
    }

    /// Both kinds of upload, each with the answers it asks for ahead of `rest`: an encrypted one
    /// reads the limit twice, ours and the SDK's own.
    fn both_kinds(rest: Vec<Answer>) -> [(Value, Vec<Answer>); 2] {
        let script = |limits: usize| {
            let mut answers = vec![limit(100); limits];
            answers.extend(rest.iter().cloned());
            answers
        };
        [(plain(json!(null)), script(1)), (encrypted(), script(2))]
    }

    fn uploads(seen: &Seen) -> usize {
        let targets = media_requests(seen);
        targets.iter().filter(|target| *target == UPLOAD).count()
    }

    fn opened(engine: &Arc<Engine>, bytes: &[u8], request: Value) -> Stream {
        let args = vec![json!("@a:b"), json!({"$blob": 0}), request];
        dispatch_bytes(engine, "media.upload", args, vec![bytes.to_vec()]).unwrap()
    }

    /// Every update of one upload, decoded as the carrier decodes them.
    async fn updates(engine: &Arc<Engine>, bytes: &[u8], request: Value) -> Vec<Value> {
        let replies = opened(engine, bytes, request);
        replies.map(Result::unwrap).collect().await
    }

    /// The `result` of the one `done`, which comes last, and only it.
    fn result_of(updates: &[Value]) -> &Value {
        let (done, progress) = updates.split_last().expect("an update");
        assert_eq!(done["kind"], json!("done"), "{updates:?}");
        assert!(
            progress.iter().all(|update| update["kind"] == "progress"),
            "{updates:?}"
        );
        &done["result"]
    }

    fn engine_alone(root: &TempDir) -> Arc<Engine> {
        Engine::new(EngineConfig {
            data_dir: root.path().join("data"),
            cache_dir: root.path().join("cache"),
            ..EngineConfig::default()
        })
        .unwrap()
    }

    async fn limit_reply(engine: &Arc<Engine>) -> Value {
        let mut replies = dispatch(engine, "media.uploadLimit", vec![json!("@a:b")]).unwrap();
        replies.next().await.unwrap().unwrap()
    }

    #[tokio::test]
    async fn a_plain_upload_sends_its_name() {
        let (base, seen) = watched(vec![limit(100), stored(NAMED)]);
        let (_root, engine, _rt) = live_on(&base).await;
        let updates = updates(&engine, b"hello", plain(json!("photo.png"))).await;
        assert_eq!(
            result_of(&updates),
            &json!({"ok": true, "value": {"kind": "plain", "mxc": MXC, "size": 5}})
        );
        assert_eq!(
            updates[0],
            json!({"kind": "progress", "phase": "uploading", "fraction": 0.0})
        );
        assert_eq!(media_requests(&seen), [CONFIG, NAMED]);
    }

    #[tokio::test]
    async fn a_name_stays_one_query_value() {
        let target = "POST /_matrix/media/v3/upload?filename=a%26b%3Dc.png";
        let (base, seen) = watched(vec![limit(100), stored(target)]);
        let (_root, engine, _rt) = live_on(&base).await;
        let updates = updates(&engine, b"hello", plain(json!("a&b=c.png"))).await;
        assert_eq!(result_of(&updates)["ok"], json!(true), "{updates:?}");
        assert_eq!(media_requests(&seen), [CONFIG, target]);
    }

    #[tokio::test]
    async fn a_null_filename_sends_no_name() {
        let (base, seen) = watched(vec![limit(100), stored(UPLOAD)]);
        let (_root, engine, _rt) = live_on(&base).await;
        let updates = updates(&engine, b"hello", plain(json!(null))).await;
        assert_eq!(result_of(&updates)["ok"], json!(true), "{updates:?}");
        assert_eq!(media_requests(&seen), [CONFIG, UPLOAD]);
    }

    #[tokio::test]
    async fn an_encrypted_upload_sends_no_name() {
        let (base, seen) = watched(vec![limit(100), limit(100), stored(UPLOAD)]);
        let (_root, engine, _rt) = live_on(&base).await;
        let updates = updates(&engine, b"hello", encrypted()).await;
        assert_eq!(
            updates[0],
            json!({"kind": "progress", "phase": "encrypting", "fraction": 0.0})
        );
        let result = result_of(&updates);
        assert_eq!(result["value"]["kind"], json!("encrypted"), "{updates:?}");
        assert_eq!(result["value"]["size"], json!(5));
        let file = &result["value"]["file"];
        assert_eq!(file["v"], json!("v2"));
        assert_eq!(file["url"], json!(MXC));
        for part in [&file["key"]["k"], &file["iv"], &file["hashes"]["sha256"]] {
            assert!(part.is_string(), "{updates:?}");
        }
        // What `content` reads back.
        let _: EncryptedFile = file_of(file.clone());
        assert_eq!(media_requests(&seen), [CONFIG, CONFIG, UPLOAD]);
    }

    #[tokio::test]
    async fn an_upload_sends_once() {
        let rest = vec![(UPLOAD, 502, json!({})), stored(UPLOAD)];
        for (request, answers) in both_kinds(rest) {
            let (base, seen) = watched(answers);
            let (_root, engine, _rt) = live_on(&base).await;
            let updates = updates(&engine, b"hello", request).await;
            assert_eq!(code(result_of(&updates)), "request-failed", "{updates:?}");
            assert_eq!(uploads(&seen), 1);
        }
    }

    /// Unlike js, which sends it: see the `shortcut` on the encrypted send.
    #[tokio::test]
    async fn a_failed_sdk_limit_lookup_fails_an_encrypted_upload() {
        let (base, seen) = watched(vec![limit(100), (CONFIG, 500, json!({})), stored(UPLOAD)]);
        let (_root, engine, _rt) = live_on(&base).await;
        let updates = updates(&engine, b"hello", encrypted()).await;
        assert_eq!(code(result_of(&updates)), "request-failed", "{updates:?}");
        assert_eq!(uploads(&seen), 0);
    }

    #[tokio::test]
    async fn over_the_limit_is_too_large_before_any_upload() {
        for request in [plain(json!(null)), encrypted()] {
            let (base, seen) = watched(vec![limit(4), stored(UPLOAD)]);
            let (_root, engine, _rt) = live_on(&base).await;
            let updates = updates(&engine, b"hello", request).await;
            assert_eq!(updates.len(), 1, "{updates:?}");
            assert_eq!(code(result_of(&updates)), "too-large");
            assert_eq!(media_requests(&seen), [CONFIG]);
        }
    }

    #[tokio::test]
    async fn exactly_the_limit_uploads() {
        let (base, _seen) = watched(vec![limit(5), stored(UPLOAD)]);
        let (_root, engine, _rt) = live_on(&base).await;
        let updates = updates(&engine, b"hello", plain(json!(null))).await;
        assert_eq!(result_of(&updates)["ok"], json!(true), "{updates:?}");
    }

    #[tokio::test]
    async fn a_413_is_too_large() {
        let refused = json!({"errcode": "M_TOO_LARGE", "error": "x"});
        for (request, answers) in both_kinds(vec![(UPLOAD, 413, refused)]) {
            let (base, _seen) = watched(answers);
            let (_root, engine, _rt) = live_on(&base).await;
            let updates = updates(&engine, b"hello", request).await;
            assert_eq!(code(result_of(&updates)), "too-large", "{updates:?}");
        }
    }

    /// The header refuses it before anything is sent.
    #[tokio::test]
    async fn a_mime_type_with_a_line_break_sends_nothing() {
        let (base, seen) = watched(vec![limit(100), stored(UPLOAD)]);
        let (_root, engine, _rt) = live_on(&base).await;
        let request = json!({"filename": null, "mimeType": "a\r\nb: c", "encrypt": false});
        let updates = updates(&engine, b"hello", request).await;
        assert_eq!(code(result_of(&updates)), "request-failed", "{updates:?}");
        assert_eq!(media_requests(&seen), [CONFIG]);
    }

    #[tokio::test]
    async fn a_failed_limit_lookup_is_null_and_not_kept() {
        let (base, seen) = watched(vec![(CONFIG, 500, json!({})), limit(5)]);
        let (_root, engine, _rt) = live_on(&base).await;
        assert_eq!(
            limit_reply(&engine).await,
            json!({"ok": true, "value": null})
        );
        assert_eq!(media_requests(&seen), [CONFIG], "sent once");
        assert_eq!(limit_reply(&engine).await, json!({"ok": true, "value": 5}));
        assert_eq!(media_requests(&seen), [CONFIG, CONFIG]);
    }

    #[tokio::test]
    async fn a_failed_limit_lookup_lets_the_upload_go() {
        let (base, seen) = watched(vec![(CONFIG, 500, json!({})), stored(UPLOAD)]);
        let (_root, engine, _rt) = live_on(&base).await;
        let updates = updates(&engine, b"hello", plain(json!(null))).await;
        assert_eq!(result_of(&updates)["ok"], json!(true), "{updates:?}");
        assert_eq!(media_requests(&seen), [CONFIG, UPLOAD]);
    }

    #[tokio::test]
    async fn a_zero_limit_is_null() {
        let (base, seen) = watched(vec![limit(0), limit(5)]);
        let (_root, engine, _rt) = live_on(&base).await;
        assert_eq!(
            limit_reply(&engine).await,
            json!({"ok": true, "value": null})
        );
        assert_eq!(limit_reply(&engine).await, json!({"ok": true, "value": 5}));
        assert_eq!(media_requests(&seen), [CONFIG, CONFIG]);
    }

    #[tokio::test]
    async fn a_good_limit_is_asked_once() {
        let (base, seen) = watched(vec![limit(100), limit(1), stored(UPLOAD)]);
        let (_root, engine, _rt) = live_on(&base).await;
        for _ in 0..2 {
            assert_eq!(
                limit_reply(&engine).await,
                json!({"ok": true, "value": 100})
            );
        }
        assert_eq!(media_requests(&seen), [CONFIG]);
    }

    #[tokio::test]
    async fn an_account_not_live_is_one_done() {
        let root = TempDir::new().unwrap();
        let engine = engine_alone(&root);
        let updates = updates(&engine, b"hello", plain(json!(null))).await;
        assert_eq!(updates.len(), 1, "{updates:?}");
        assert_eq!(code(result_of(&updates)), "account-not-live");
        assert_eq!(code(&limit_reply(&engine).await), "account-not-live");
    }

    /// Polls `replies` until the upload reaches the server, with no `done` before it does.
    async fn held_at_the_server(replies: &mut Stream, seen: &Seen) {
        for _ in 0..50 {
            if requests(seen).iter().any(|(target, _)| target == UPLOAD) {
                return;
            }
            let wait = Duration::from_millis(100);
            if let Ok(update) = timeout(replies.next(), wait).await {
                let update = update.unwrap().unwrap();
                assert_eq!(update["kind"], json!("progress"), "{update}");
            }
        }
        panic!("no upload reached the server");
    }

    #[tokio::test]
    async fn retire_ends_an_upload_with_a_final_done() {
        for (request, answers) in both_kinds(vec![(UPLOAD, 0, json!(null))]) {
            let (base, seen) = scripted(answers);
            let (_root, engine, rt) = live_on(&base).await;
            let before = Arc::strong_count(&rt);
            let mut replies = opened(&engine, b"hello", request);
            held_at_the_server(&mut replies, &seen).await;
            assert!(
                Arc::strong_count(&rt) > before,
                "the upload holds the runtime"
            );

            rt.set_retired();
            let rest = replies.map(Result::unwrap).collect::<Vec<Value>>();
            let rest = timeout(rest, Duration::from_secs(2))
                .await
                .expect("the done comes at once");
            assert_eq!(code(result_of(&rest)), "account-not-live", "{rest:?}");
            assert_eq!(Arc::strong_count(&rt), before);
        }
    }

    /// A logout the rule published reaches the caller before `account-not-live` does, and a
    /// teardown is not held meanwhile.
    #[tokio::test]
    async fn a_not_live_done_follows_the_logout_and_lets_go_of_the_account() {
        let (base, seen) = scripted(vec![limit(100), (UPLOAD, 0, json!(null))]);
        let (_root, engine, rt) = live_on(&base).await;
        let before = Arc::strong_count(&rt);
        let mut logouts = Subscribers::<u8>::default();
        let (_, mut logout) = logouts.subscribe(None);
        let mut replies = opened(&engine, b"hello", plain(json!(null)));
        held_at_the_server(&mut replies, &seen).await;

        (engine.state.lock().deaths).insert("@a:b".to_owned(), logouts.publish(&1));
        rt.set_retired();
        let wait = Duration::from_millis(100);
        assert!(
            timeout(replies.next(), wait).await.is_err(),
            "ahead of the logout"
        );
        assert_eq!(Arc::strong_count(&rt), before);

        // Once to take the item, once more to count it as emitted.
        assert_eq!(logout.next().await, Some(1));
        assert_eq!(logout.next().now_or_never(), None);
        let done = timeout(replies.next(), Duration::from_secs(2))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(code(&done["result"]), "account-not-live");
    }

    /// One `done`, even when the account retires right after it.
    #[tokio::test]
    async fn a_retire_after_the_done_adds_nothing() {
        let (base, _seen) = watched(vec![limit(100), stored(UPLOAD)]);
        let (_root, engine, rt) = live_on(&base).await;
        let before = Arc::strong_count(&rt);
        let mut replies = opened(&engine, b"hello", plain(json!(null)));
        loop {
            let update = replies.next().await.unwrap().unwrap();
            if update["kind"] == "done" {
                assert_eq!(update["result"]["ok"], json!(true), "{update}");
                break;
            }
        }
        // Let go of the account with the `done`, not at the next poll.
        assert_eq!(Arc::strong_count(&rt), before);
        rt.set_retired();
        assert_eq!(replies.next().await, None);
    }

    #[tokio::test]
    async fn a_blob_left_untaken_is_bad_args() {
        let (base, seen) = watched(vec![limit(100), stored(UPLOAD)]);
        let (_root, engine, _rt) = live_on(&base).await;
        let args = |at: u32| {
            vec![
                json!("@a:b"),
                json!({"$blob": at}),
                plain(json!("secret.png")),
            ]
        };
        let blobs = || vec![b"one".to_vec(), b"two".to_vec()];
        let untaken = dispatch_bytes(&engine, "media.upload", args(0), blobs());
        let missing = dispatch_bytes(&engine, "media.upload", args(9), blobs());
        for result in [untaken, missing] {
            let Err(fault) = result else {
                panic!("a bad call opened");
            };
            assert_eq!(fault.code, FaultCode::BadArgs);
            assert!(!fault.diagnostic.contains("secret"), "{fault:?}");
        }
        assert_eq!(media_requests(&seen), Vec::<String>::new());
    }

    #[test]
    fn a_fraction_is_a_share_of_the_total() {
        let gib = 1 << 30_u32;
        let rows = [
            (0, 0, 0.0),
            (5, 0, 0.0),
            (0, 10, 0.0),
            (5, 10, 0.5),
            (10, 10, 1.0),
            (11, 10, 1.0),
            (usize::MAX, usize::MAX, 1.0),
            (3 * gib, 4 * gib, 0.75),
        ];
        for (current, total, fraction) in rows {
            let got = fraction_of(TransmissionProgress { current, total });
            assert!((got - fraction).abs() < 1e-6, "{current}/{total}: {got}");
        }
    }

    fn fractions(updates: &[TransferUpdateDto<u8>]) -> Vec<f64> {
        let fraction = |update: &_| match update {
            TransferUpdateDto::Progress { fraction, .. } => Some(*fraction),
            TransferUpdateDto::Done { .. } => None,
        };
        updates.iter().filter_map(fraction).collect()
    }

    #[tokio::test(start_paused = true)]
    async fn progress_is_at_most_one_per_100_ms() {
        let moved = Arc::new(AtomicU32::new(0));
        let mover = Arc::clone(&moved);
        let send = async move {
            for step in 1..=100 {
                sleep(Duration::from_millis(10)).await;
                mover.store(step, Ordering::SeqCst);
            }
            EngineResult::Ok(7)
        };
        let read = move || f64::from(moved.load(Ordering::SeqCst)) / 100.0;
        let phase = TransferPhaseDto::Uploading;
        let updates: Vec<_> = throttled(phase, read, send).collect().await;

        assert_eq!(
            updates.first(),
            Some(&TransferUpdateDto::Progress {
                phase,
                fraction: 0.0
            })
        );
        assert!(updates.len() - 1 <= 11, "{updates:?}");
        assert!(updates.len() > 5, "{updates:?}");
        assert_eq!(
            updates.last(),
            Some(&TransferUpdateDto::Done {
                result: EngineResult::Ok(7)
            })
        );
        let fractions = fractions(&updates);
        assert!(fractions.is_sorted(), "{fractions:?}");
        assert!(
            fractions.iter().all(|f| (0.0..=1.0).contains(f)),
            "{fractions:?}"
        );
    }

    /// The first update names the phase the caller gave, and what the observable shows afterwards
    /// is bytes going out.
    #[tokio::test(start_paused = true)]
    async fn only_the_first_update_is_encrypting() {
        let send = async {
            sleep(Duration::from_millis(250)).await;
            EngineResult::Ok(7)
        };
        let phase = TransferPhaseDto::Encrypting;
        let updates: Vec<_> = throttled(phase, || 0.5, send).collect().await;
        assert_eq!(
            updates,
            [
                TransferUpdateDto::Progress {
                    phase,
                    fraction: 0.0
                },
                TransferUpdateDto::Progress {
                    phase: TransferPhaseDto::Uploading,
                    fraction: 0.5
                },
                TransferUpdateDto::Done {
                    result: EngineResult::Ok(7)
                },
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_fraction_that_stays_is_not_sent_again() {
        let send = async {
            sleep(Duration::from_secs(1)).await;
            EngineResult::Err(local_failure(FailureCode::TooLarge))
        };
        let phase = TransferPhaseDto::Uploading;
        let updates: Vec<TransferUpdateDto<u8>> = throttled(phase, || 0.0, send).collect().await;
        assert_eq!(fractions(&updates), [0.0], "{updates:?}");
        assert_eq!(updates.len(), 2);
    }

    #[test]
    fn debug_holds_no_mxc_key_or_name() {
        let file = json!({"url": MXC, "key": {"k": "secretkey"}});
        let contents = [
            UploadedContentDto::Plain {
                mxc: MXC.to_owned(),
                size: 1,
            },
            UploadedContentDto::Encrypted { file, size: 1 },
        ];
        for content in contents {
            let debug = format!("{content:?}");
            assert!(
                !debug.contains("secret") && !debug.contains("mxc"),
                "{debug}"
            );
            let update = TransferUpdateDto::Done {
                result: EngineResult::Ok(content),
            };
            let debug = format!("{update:?}");
            assert!(
                !debug.contains("secret") && !debug.contains("mxc"),
                "{debug}"
            );
        }
        let request: UploadRequestDto = serde_json::from_value(plain(json!("secret.png"))).unwrap();
        let debug = format!("{request:?}");
        assert!(!debug.contains("secret"), "{debug}");
    }

    /// Re-runs itself in a child with a global TRACE subscriber: tracing caches each callsite's
    /// interest per process, so a scoped one can miss an event a parallel test also reaches.
    #[test]
    fn logs_hold_no_key_mxc_or_name() {
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
                let answers = vec![limit(100), stored(NAMED), limit(100), stored(UPLOAD)];
                let (base, _seen) = watched(answers);
                let (_root, engine, _rt) = live_on(&base).await;
                let plain = updates(&engine, b"hello", plain(json!("photo.png"))).await;
                assert_eq!(result_of(&plain)["ok"], json!(true), "{plain:?}");
                let sealed = updates(&engine, b"hello", encrypted()).await;
                let file = &result_of(&sealed)["value"]["file"];
                for part in [&file["key"]["k"], &file["iv"], &file["hashes"]["sha256"]] {
                    println!("SECRET {}", part.as_str().unwrap());
                }

                let answers = vec![limit(100), limit(100), (UPLOAD, 502, json!({}))];
                let (base, _seen) = watched(answers);
                let (_root, engine, _rt) = live_on(&base).await;
                let failed = updates(&engine, b"hello", encrypted()).await;
                assert_eq!(code(result_of(&failed)), "request-failed");
            });
            return;
        }

        let output = Command::new(env::current_exe().unwrap())
            .args([
                "--exact",
                "engines::media::upload::tests::logs_hold_no_key_mxc_or_name",
                "--nocapture",
            ])
            .env(LOG_PROBE, "1")
            .output()
            .unwrap();
        let log = String::from_utf8(output.stdout).unwrap();
        assert!(output.status.success(), "{log}");

        let secrets: Vec<_> = log
            .lines()
            .filter_map(|line| line.strip_prefix("SECRET "))
            .collect();
        assert_eq!(secrets.len(), 3, "{log}");
        for secret in secrets {
            assert_eq!(log.matches(secret).count(), 1, "{secret}: {log}");
        }
        assert!(log.contains("/media/v3/upload"), "no request: {log}");
        for secret in ["mxc://", "secretid", "secret.example", "hello", "photo.png"] {
            assert!(!log.contains(secret), "{secret}: {log}");
        }
    }
}
