//! The session reads: tokens, server status, key backup, outgoing work and known names.

use std::{future::IntoFuture, sync::Arc, time::Duration};

use futures_util::{StreamExt, future::join_all};
use matrix_sdk::{
    Error, RoomMemberships, SessionTokens,
    room::RoomMember,
    ruma::{
        OwnedRoomId, RoomId, TransactionId,
        api::{client::account::whoami, error::ErrorKind},
        events::{
            AnyMessageLikeEventContent,
            room::message::{MessageType, Relation},
        },
    },
    send_queue::{LocalEcho, LocalEchoContent},
    store::SerializableEventContent,
    timeout::timeout,
};
use serde_json::Value;

use super::{
    AccountNameGroupDto, AccountServerStatusDto, PendingTextMessageDto, RefreshOptionsDto,
    SessionAccessTokenDto, SessionCredentialsDto, runtime::stop_sync,
};
use crate::{
    accounts::{AccountRuntime, Engine},
    dispatch::{Stream, detached, item, reply, stream},
    engines::member::sent_once,
    failure::{EngineResult, account_not_live, refused_refresh},
    wire::{Fault, FaultCode},
};

/// How long `roomKeysBackedUp` waits for waiting room keys to upload.
const STEADY_STATE_LIMIT: Duration = Duration::from_secs(10);

/// The account's token now, then each change; null while it has no live client.
pub fn access_token(engine: Arc<Engine>, account_id: String) -> Stream {
    let tokens = engine.subscribe_token(&account_id);
    stream(tokens.map(item))
}

pub fn live_credentials(engine: Arc<Engine>, account_id: String) -> Stream {
    reply(async move {
        let tokens = engine.account(&account_id)?.client.session_tokens()?;
        Some(SessionCredentialsDto {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
        })
    })
}

pub fn account_status(engine: Arc<Engine>, account_id: String) -> Stream {
    reply(async move {
        let Some(rt) = engine.account(&account_id) else {
            return AccountServerStatusDto::Unreachable;
        };
        let request = whoami::v3::Request::new();
        let whoami = rt.client.send(request).with_request_config(sent_once());
        match engine.ruled(&rt, whoami).await {
            Ok(_) => AccountServerStatusDto::Active,
            Err(err) => status_of(&err),
        }
    })
}

/// A direct refresh never signs out: a refused one only answers `false`.
pub fn refresh_access_token(
    engine: Arc<Engine>,
    account_id: String,
    options: RefreshOptionsDto,
) -> Stream {
    reply(async move {
        let Some(rt) = engine.account(&account_id).filter(|rt| rt.refreshable) else {
            return false;
        };
        let refresh = rt.client.refresh_access_token();
        let refreshed = match options.timeout_ms {
            Some(ms) => matches!(
                timeout(refresh, Duration::from_millis(ms.into())).await,
                Ok(Ok(()))
            ),
            None => refresh.await.is_ok(),
        };
        drop(rt);
        if refreshed {
            let published = engine.state.lock().publish_snapshot();
            published
                .join(engine.rotation_of(&account_id))
                .delivered()
                .await;
        }
        refreshed
    })
}

pub fn room_keys_backed_up(engine: Arc<Engine>, account_id: String) -> Stream {
    reply(async move {
        let rt = engine.account(&account_id)?;
        let backups = rt.client.encryption().backups();
        if !backups.are_enabled().await {
            return Some(false);
        }
        let steady = timeout(
            backups.wait_for_steady_state().into_future(),
            STEADY_STATE_LIMIT,
        );
        Some(matches!(steady.await, Ok(Ok(()))))
    })
}

/// Whether a live account still has a message, redaction or upload on its way.
pub fn has_outgoing_work(engine: Arc<Engine>) -> Stream {
    reply(async move {
        let (echoes, unreadable) = local_echoes(&engine).await;
        has_work(&echoes, unreadable)
    })
}

pub fn pending_text_messages(engine: Arc<Engine>) -> Stream {
    reply(async move {
        let (echoes, _) = local_echoes(&engine).await;
        let texts = echoes.iter().filter_map(|(account_id, room_id, echo)| {
            let LocalEchoContent::Event {
                serialized_event, ..
            } = &echo.content
            else {
                return None;
            };
            pending_text(account_id, room_id, &echo.transaction_id, serialized_event)
        });
        texts.collect::<Vec<_>>()
    })
}

/// Stops every live account's sync, but not its crypto or its sends; `stop` ends the pause.
/// Detached, so a close never leaves a sync running while paused; the stops run side by side.
pub fn pause_sync(engine: Arc<Engine>) -> Stream {
    detached(async move {
        let services = {
            let mut state = engine.state.lock();
            state.paused = true;
            let runtimes = state.runtimes.values();
            runtimes
                .map(|rt| Arc::clone(&rt.sync_service))
                .collect::<Vec<_>>()
        };
        join_all(services.iter().map(|service| stop_sync(service))).await;
        Value::Null
    })
}

/// The account's own display name, then each room's name, topic and member display names.
pub fn known_names(engine: Arc<Engine>, account_id: String) -> Stream {
    stream(futures_util::stream::once(async move {
        let Some(rt) = engine.account(&account_id) else {
            return item(EngineResult::<()>::Err(account_not_live()));
        };
        let memberships = RoomMemberships::JOIN
            | RoomMemberships::INVITE
            | RoomMemberships::LEAVE
            | RoomMemberships::BAN;
        let mut own = Vec::new();
        let mut rooms = Vec::new();
        for room in rt.client.rooms() {
            // A fault, so the diagnostic export says some names were not replaced.
            let members = room
                .members_no_sync(memberships)
                .await
                .map_err(|_| store_failed())?;
            if own.is_empty() {
                // shortcut: 0.19.1 caches no own display name, so a room membership gives it;
                // read the profile once the SDK keeps one.
                let mine = members
                    .iter()
                    .filter(|m| m.user_id().as_str() == rt.account_id);
                own = member_names(mine.map(name_of));
            }
            let non_empty = |text: Option<String>| text.filter(|t| !t.is_empty()).into_iter();
            rooms.push(AccountNameGroupDto {
                room_names: non_empty(room.name()).collect(),
                room_topics: non_empty(room.topic()).collect(),
                display_names: member_names(members.iter().map(name_of)),
            });
        }
        let own = AccountNameGroupDto {
            room_names: vec![],
            room_topics: vec![],
            display_names: own,
        };
        let groups = std::iter::once(own).chain(rooms).collect::<Vec<_>>();
        item(EngineResult::Ok(groups))
    }))
}

/// The token of `rt` as `accessToken` emits it.
pub(crate) fn access_token_of(
    rt: &AccountRuntime,
    tokens: &SessionTokens,
) -> SessionAccessTokenDto {
    let expiry = rt.expiry.as_ref();
    SessionAccessTokenDto {
        homeserver_url: rt.base_url.clone(),
        access_token: tokens.access_token.clone(),
        expires_at: expiry
            .filter(|(token, _)| *token == tokens.access_token)
            .map(|(_, at)| *at),
        refreshable: rt.refreshable,
    }
}

/// The live token of `rt`, if its client has one.
pub(crate) fn live_token(rt: &AccountRuntime) -> Option<SessionAccessTokenDto> {
    Some(access_token_of(rt, &rt.client.session_tokens()?))
}

/// The display names of `(user id, display name)` pairs, without empty ones or ones that are
/// their user id, which the redactor replaces as an id anyway (`known-names.ts`).
pub(crate) fn member_names<'a>(
    members: impl IntoIterator<Item = (&'a str, Option<&'a str>)>,
) -> Vec<String> {
    let names = members
        .into_iter()
        .filter_map(|(user_id, name)| name.filter(|name| !name.is_empty() && *name != user_id));
    names.map(Into::into).collect()
}

// shortcut: an `m.text` body only, without js's emote, spoiler and rich-reply handling; upgrade
// when the engine owns the send queue.
pub(crate) fn pending_text(
    account_id: &str,
    room_id: &RoomId,
    transaction_id: &TransactionId,
    content: &SerializableEventContent,
) -> Option<PendingTextMessageDto> {
    let AnyMessageLikeEventContent::RoomMessage(message) = content.deserialize().ok()? else {
        return None;
    };
    let MessageType::Text(text) = message.msgtype else {
        return None;
    };
    let thread_root_id = match message.relates_to {
        Some(Relation::Thread(thread)) => Some(thread.event_id.to_string()),
        // An edit changes a message the homeserver has.
        Some(Relation::Replacement(_)) => return None,
        _ => None,
    };
    Some(PendingTextMessageDto {
        account_id: account_id.into(),
        room_id: room_id.into(),
        thread_root_id,
        text: text.body,
        txn_id: Some(transaction_id.into()),
    })
}

fn store_failed() -> Fault {
    Fault::new(FaultCode::StoreFailed, "reading a room's members failed")
}

fn name_of(member: &RoomMember) -> (&str, Option<&str>) {
    (member.user_id().as_str(), member.display_name())
}

/// As js: a refused refresh rethrows the dead token's answer, which is `gone`.
fn status_of(err: &Error) -> AccountServerStatusDto {
    match err.client_api_error_kind() {
        Some(ErrorKind::UnknownToken(_) | ErrorKind::UserDeactivated) => {
            AccountServerStatusDto::Gone
        }
        _ if refused_refresh(err) => AccountServerStatusDto::Gone,
        _ => AccountServerStatusDto::Unreachable,
    }
}

type Echo = (String, OwnedRoomId, LocalEcho);

/// Whether `echoes` hold work on its way; a queue that could not be read may hold some.
fn has_work(echoes: &[Echo], unreadable: bool) -> bool {
    unreadable
        || echoes.iter().any(|(_, _, echo)| {
            matches!(
                echo.content,
                LocalEchoContent::Event {
                    send_error: None,
                    ..
                } | LocalEchoContent::Redaction {
                    send_error: None,
                    ..
                }
            )
        })
}

/// Every live account's local echoes, with the account and room of each, and whether a send
/// queue could not be read.
async fn local_echoes(engine: &Engine) -> (Vec<Echo>, bool) {
    let accounts = engine.live_runtimes().into_iter().map(|rt| async move {
        let Ok(rooms) = rt.client.send_queue().local_echoes().await else {
            tracing::warn!("reading an account's send queue failed");
            return None;
        };
        let id = &rt.account_id;
        let echoes = rooms.into_iter().flat_map(|(room_id, echoes)| {
            echoes
                .into_iter()
                .map(move |echo| (id.clone(), room_id.clone(), echo))
        });
        Some(echoes.collect::<Vec<_>>())
    });
    let accounts = join_all(accounts).await;
    let unreadable = accounts.iter().any(Option::is_none);
    (
        accounts.into_iter().flatten().flatten().collect(),
        unreadable,
    )
}

#[cfg(test)]
mod tests {
    use futures_util::FutureExt;
    use matrix_sdk::sleep::sleep;
    use matrix_sdk::{
        HttpError, RefreshTokenError, RumaApiError,
        ruma::{
            api::{EndpointError, error::FromHttpResponseError},
            exports::http,
            room_id,
            serde::Raw,
        },
    };
    use matrix_sdk_ui::sync_service;
    use serde_json::{Value, json, value::to_raw_value};

    use super::*;
    use crate::{
        config::EngineConfig,
        engines::session::MatrixSessionDto,
        testing::{builder_on, live, password, runtime_on},
    };

    fn session(base_url: &str) -> MatrixSessionDto {
        serde_json::from_value(json!({
            "baseUrl": base_url,
            "userId": "@a:hs.example",
            "deviceId": "DEV",
            "accessToken": "at",
            "refreshToken": "rt",
            "accessTokenExpiresAt": 1_700_000_000_000_u64,
            "oidc": {"issuer": "https://id.example", "clientId": "client"},
        }))
        .unwrap()
    }

    /// A runtime for `s` on a memory store, never started, so nothing reaches the network.
    async fn runtime(engine: &Arc<Engine>, s: &MatrixSessionDto) -> AccountRuntime {
        let client = (engine.client_builder().homeserver_url(&s.base_url))
            .build()
            .await
            .unwrap();
        runtime_on(engine, s, 1, client).await
    }

    fn tokens(access_token: &str) -> SessionTokens {
        SessionTokens {
            access_token: access_token.into(),
            refresh_token: Some("rt".into()),
        }
    }

    #[tokio::test]
    async fn the_token_carries_the_session_base_url_verbatim() {
        let engine = Engine::new(EngineConfig::default()).unwrap();
        let rt = runtime(&engine, &session("https://hs.example")).await;
        assert_eq!(rt.client.homeserver().as_str(), "https://hs.example/");
        let restored = access_token_of(&rt, &tokens("at"));
        assert!(
            restored
                == SessionAccessTokenDto {
                    homeserver_url: "https://hs.example".into(),
                    access_token: "at".into(),
                    expires_at: Some(1.7e12),
                    refreshable: true,
                }
        );
        let refreshed = access_token_of(&rt, &tokens("at2"));
        assert_eq!(refreshed.access_token, "at2");
        assert_eq!(
            refreshed.expires_at, None,
            "a refreshed token's expiry is unknown"
        );
    }

    #[test]
    fn member_names_skip_empty_names_and_user_ids() {
        let members = [
            ("@a:b", Some("Alice")),
            ("@c:b", None),
            ("@d:b", Some("")),
            ("@e:b", Some("@e:b")),
            ("@f:b", Some("@a:b")),
        ];
        assert_eq!(member_names(members), ["Alice", "@a:b"]);
    }

    fn content(json: Value) -> SerializableEventContent {
        let raw = Raw::from_json(to_raw_value(&json).unwrap());
        SerializableEventContent::from_raw(raw, "m.room.message".into())
    }

    #[test]
    fn a_text_echo_becomes_a_pending_text_message_with_its_thread() {
        let room = room_id!("!r:b");
        let txn = TransactionId::new();
        let text = |relates_to: Value| {
            let echo =
                content(json!({"msgtype": "m.text", "body": "hi", "m.relates_to": relates_to}));
            pending_text("@a:b", room, &txn, &echo)
        };
        let threaded = text(json!({"rel_type": "m.thread", "event_id": "$root"})).unwrap();
        assert_eq!(
            serde_json::to_value(threaded).unwrap(),
            json!({
                "accountId": "@a:b",
                "roomId": "!r:b",
                "threadRootId": "$root",
                "text": "hi",
                "txnId": txn.as_str(),
            })
        );
        let reply = text(json!({"m.in_reply_to": {"event_id": "$x"}})).unwrap();
        assert_eq!(reply.thread_root_id, None);
        let edit = content(json!({
            "msgtype": "m.text",
            "body": "* hi",
            "m.new_content": {"msgtype": "m.text", "body": "hi"},
            "m.relates_to": {"rel_type": "m.replace", "event_id": "$x"},
        }));
        assert!(edit.deserialize().is_ok());
        assert!(
            pending_text("@a:b", room, &txn, &edit).is_none(),
            "an edit is not new text"
        );
        let notice = content(json!({"msgtype": "m.notice", "body": "hi"}));
        assert!(pending_text("@a:b", room, &txn, &notice).is_none());
    }

    #[tokio::test]
    async fn a_token_stream_follows_the_account_and_never_repeats_a_token() {
        let engine = Engine::new(EngineConfig::default()).unwrap();
        let s = session("https://hs.example");
        let mut tokens = engine.subscribe_token(&s.user_id);
        let mut next = || {
            let polled = tokens.next().now_or_never();
            polled.map(|item| item.map(|token| token.map(|t| t.access_token)))
        };
        assert_eq!(next(), Some(Some(None)), "null while no client is live");
        let rt = Arc::new(runtime(&engine, &s).await);
        let publish = |runtime: Option<Arc<AccountRuntime>>| {
            let mut state = engine.state.lock();
            match runtime {
                Some(rt) => state.runtimes.insert(s.user_id.clone(), rt),
                None => state.runtimes.remove(&s.user_id),
            };
            let _ = state.publish_snapshot();
        };
        publish(Some(Arc::clone(&rt)));
        assert_eq!(next(), Some(Some(Some("at".into()))));
        publish(Some(rt));
        assert_eq!(next(), None, "an unchanged token is not sent again");
        publish(None);
        assert_eq!(next(), Some(Some(None)));
    }

    fn error(status: u16, errcode: &str) -> HttpError {
        let body = json!({"errcode": errcode, "error": "x"}).to_string();
        let response = http::Response::builder()
            .status(status)
            .body(body.as_bytes());
        let error = RumaApiError::from_http_response(response.unwrap());
        FromHttpResponseError::Server(error).into()
    }

    #[test]
    fn status_of_reads_gone_from_the_errcode() {
        use AccountServerStatusDto::*;
        assert_eq!(status_of(&error(401, "M_UNKNOWN_TOKEN").into()), Gone);
        assert_eq!(status_of(&error(403, "M_USER_DEACTIVATED").into()), Gone);
        assert_eq!(status_of(&error(403, "M_FORBIDDEN").into()), Unreachable);
        assert_eq!(status_of(&error(502, "M_UNKNOWN").into()), Unreachable);
        // As js: a refused refresh rethrows the dead token's error, a transient one does not.
        let refresh = |answer| {
            let failed = RefreshTokenError::MatrixAuth(Arc::new(answer));
            Error::from(HttpError::RefreshToken(failed))
        };
        assert_eq!(status_of(&refresh(error(401, "M_UNKNOWN_TOKEN"))), Gone);
        assert_eq!(status_of(&refresh(error(502, "M_UNKNOWN"))), Unreachable);
    }

    async fn refreshed(engine: &Arc<Engine>, account_id: &str) -> Vec<Value> {
        let options = RefreshOptionsDto {
            timeout_ms: Some(500),
        };
        let reply = refresh_access_token(Arc::clone(engine), account_id.into(), options);
        reply.map(Result::unwrap).collect().await
    }

    #[tokio::test]
    async fn refresh_is_false_for_an_account_that_cannot_refresh() {
        let engine = Engine::new(EngineConfig::default()).unwrap();
        assert_eq!(refreshed(&engine, "@a:b").await, [json!(false)]);
        // A homeserver that never answers, which shows whether a refresh was sent.
        let homeserver = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        homeserver.set_nonblocking(true).unwrap();
        let mut password = session(&format!("http://{}", homeserver.local_addr().unwrap()));
        password.oidc = None;
        let live = Arc::new(runtime(&engine, &password).await);
        {
            let mut state = engine.state.lock();
            state.runtimes.insert(password.user_id.clone(), live);
        }
        assert_eq!(refreshed(&engine, &password.user_id).await, [json!(false)]);
        assert!(homeserver.accept().is_err(), "no refresh was sent");
    }

    #[tokio::test]
    async fn a_pause_closed_mid_flight_still_stops_the_sync() {
        let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", silent.local_addr().unwrap());
        let engine = Engine::new(EngineConfig::default()).unwrap();
        let rt = live(
            &engine,
            &password(&base),
            builder_on(&base).build().await.unwrap(),
        )
        .await;
        rt.sync_service.start().await;
        let mut closed = pause_sync(Arc::clone(&engine));
        assert!(
            closed.next().now_or_never().is_none(),
            "the stop is in flight"
        );
        drop(closed);
        let idle = async {
            while !matches!(rt.sync_service.state().get(), sync_service::State::Idle) {
                sleep(Duration::from_millis(10)).await;
            }
        };
        let idle = timeout(idle, Duration::from_secs(5)).await;
        assert!(idle.is_ok(), "the close cut the pause short");
    }

    #[test]
    fn an_unreadable_send_queue_counts_as_outgoing_work() {
        assert!(!has_work(&[], false));
        assert!(has_work(&[], true));
    }
}
