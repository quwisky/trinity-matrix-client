//! The engine and its signed-in accounts.

use std::{collections::HashMap, future::ready, sync::Arc, time::Duration};

use futures_util::{StreamExt, stream};
use matrix_sdk::{
    Client, ClientBuildError, ClientBuilder, SessionMeta, SessionTokens,
    authentication::matrix::MatrixSession,
    bytes::Bytes,
    locks::Mutex,
    reqwest::{self, StatusCode, Url},
    ruma::UserId,
    timeout::timeout,
};
use matrix_sdk_ui::{
    encryption_sync_service,
    room_list_service::{self, RoomListLoadingState},
    sync_service::{self, State, SyncService},
};
use serde::Deserialize;

use crate::{
    config::EngineConfig,
    failure::{Diagnostic, EngineFailure, FailureCode, FailureKind, classify_http, request_failed},
};

const LOAD_LIMIT: Duration = Duration::from_secs(30);

pub struct Engine {
    pub(crate) config: EngineConfig,
    accounts: Mutex<HashMap<String, Arc<AccountRuntime>>>,
    /// For the requests the engines send themselves rather than through the SDK.
    raw: reqwest::Client,
}

pub struct AccountRuntime {
    pub client: Client,
    pub sync_service: Arc<SyncService>,
}

/// A session to restore, as the test host receives it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAccount {
    homeserver_url: String,
    user_id: String,
    device_id: String,
    access_token: String,
}

impl Engine {
    /// Fails only when the TLS backend cannot start, such as Android's platform verifier before
    /// its initialization.
    pub fn new(config: EngineConfig) -> Result<Arc<Self>, reqwest::Error> {
        let builder = reqwest::Client::builder();
        // The browser's fetch owns redirects and TLS on wasm.
        #[cfg(not(target_family = "wasm"))]
        let builder = builder
            .redirect(reqwest::redirect::Policy::none())
            .danger_accept_invalid_certs(config.insecure_tls)
            .min_tls_version(reqwest::tls::Version::TLS_1_2);
        Ok(Arc::new(Self {
            config,
            accounts: Mutex::default(),
            raw: builder.build()?,
        }))
    }

    pub fn account(&self, account_id: &str) -> Option<Arc<AccountRuntime>> {
        self.accounts.lock().get(account_id).cloned()
    }

    pub fn client_builder(&self) -> ClientBuilder {
        let builder = Client::builder();
        if self.config.insecure_tls {
            builder.disable_ssl_verification()
        } else {
            builder
        }
    }

    /// A GET that follows no redirect, so `token` reaches only `url`: its status and body.
    pub async fn raw_get(
        &self,
        url: Url,
        token: Option<&str>,
        timeout: Duration,
    ) -> Result<(StatusCode, Bytes), reqwest::Error> {
        let mut request = self.raw.get(url.clone()).timeout(timeout);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let response = request.send().await?;
        // On wasm, fetch has already followed any redirect: answer with a 3xx, as native does.
        if response.url() != &url {
            return Ok((StatusCode::FOUND, Bytes::new()));
        }
        Ok((response.status(), response.bytes().await?))
    }

    /// Restores `start` with a memory store and syncs until its room list has loaded.
    pub async fn start_account(&self, start: StartAccount) -> Result<(), EngineFailure> {
        // Stopped first: two sync services for one device would reset each other's connection.
        let previous = self.accounts.lock().remove(&start.user_id);
        if let Some(previous) = previous {
            previous.sync_service.stop().await;
        }
        let account_id = start.user_id.clone();
        let runtime = Arc::new(self.run(start).await?);
        let displaced = self.accounts.lock().insert(account_id, runtime);
        if let Some(displaced) = displaced {
            displaced.sync_service.stop().await;
        }
        Ok(())
    }

    async fn run(&self, start: StartAccount) -> Result<AccountRuntime, EngineFailure> {
        let user_id = UserId::parse(&start.user_id).map_err(|_| unexpected())?;
        let client = self
            .client_builder()
            .homeserver_url(&start.homeserver_url)
            .build()
            .await
            .map_err(|err| build_failure(&err))?;
        let session = MatrixSession {
            meta: SessionMeta {
                user_id,
                device_id: start.device_id.into(),
            },
            tokens: SessionTokens {
                access_token: start.access_token,
                refresh_token: None,
            },
        };
        client
            .restore_session(session)
            .await
            .map_err(|err| request_failed(&err))?;
        let sync_service = Arc::new(
            SyncService::builder(client.clone())
                .build()
                .await
                .map_err(|err| sync_failure(&err))?,
        );
        let rooms = sync_service
            .room_list_service()
            .all_rooms()
            .await
            .map_err(|err| sync_failure(&sync_service::Error::RoomList(err)))?;
        // Subscribed before the start, so an error the first sync runs into is not missed.
        let errors = sync_service.state().filter_map(|state| {
            ready(match state {
                State::Error(err) => Some(Err(sync_failure(&err))),
                _ => None,
            })
        });
        let loaded = rooms
            .loading_state()
            .filter(|state| ready(matches!(state, RoomListLoadingState::Loaded { .. })))
            .map(|_| Ok(()));
        sync_service.start().await;
        let outcome = match timeout(stream::select(loaded, errors).next(), LOAD_LIMIT).await {
            Ok(Some(outcome)) => outcome,
            Ok(None) => Err(unexpected()),
            Err(_) => Err(failure(
                FailureKind::Timeout,
                Diagnostic::new(FailureKind::Timeout),
            )),
        };
        if let Err(err) = outcome {
            sync_service.stop().await;
            return Err(err);
        }
        Ok(AccountRuntime {
            client,
            sync_service,
        })
    }
}

fn failure(kind: FailureKind, diagnostic: Diagnostic) -> EngineFailure {
    EngineFailure {
        kind,
        diagnostic,
        code: FailureCode::RequestFailed {
            cause: None,
            server_message: None,
        },
    }
}

fn unexpected() -> EngineFailure {
    failure(
        FailureKind::Unexpected,
        Diagnostic::new(FailureKind::Unexpected),
    )
}

fn build_failure(err: &ClientBuildError) -> EngineFailure {
    match err {
        ClientBuildError::Http(err) => {
            let (kind, diagnostic) = classify_http(err);
            failure(kind, diagnostic)
        }
        _ => unexpected(),
    }
}

fn sync_failure(err: &sync_service::Error) -> EngineFailure {
    use encryption_sync_service::Error as Encryption;
    match err {
        sync_service::Error::RoomList(room_list_service::Error::SlidingSync(err))
        | sync_service::Error::EncryptionSync(
            Encryption::SlidingSync(err)
            | Encryption::LockError(err)
            | Encryption::ClientError(err),
        ) => request_failed(err),
        _ => unexpected(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn start(homeserver_url: &str, user_id: &str) -> StartAccount {
        serde_json::from_value(json!({
            "homeserverUrl": homeserver_url,
            "userId": user_id,
            "deviceId": "DEVICE",
            "accessToken": "token",
        }))
        .unwrap()
    }

    fn assert_request_failed(failure: &EngineFailure, kind: FailureKind) {
        assert_eq!(failure.kind, kind);
        assert!(
            matches!(failure.code, FailureCode::RequestFailed { .. }),
            "{failure:?}"
        );
    }

    #[test]
    fn an_unknown_account_is_absent() {
        assert!(
            Engine::new(EngineConfig::default())
                .unwrap()
                .account("@a:b")
                .is_none()
        );
    }

    #[tokio::test]
    async fn a_malformed_user_id_fails_without_registering() {
        let engine = Engine::new(EngineConfig::default()).unwrap();
        let failure = engine
            .start_account(start("http://127.0.0.1:1", "not-a-user-id"))
            .await
            .unwrap_err();
        assert_request_failed(&failure, FailureKind::Unexpected);
        assert!(engine.account("not-a-user-id").is_none());
    }

    #[tokio::test]
    async fn an_unreachable_homeserver_fails_before_the_load_limit() {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let engine = Engine::new(EngineConfig::default()).unwrap();
        let failure = engine
            .start_account(start(&format!("http://127.0.0.1:{port}"), "@a:b"))
            .await
            .unwrap_err();
        assert_request_failed(&failure, FailureKind::Network);
        assert!(engine.account("@a:b").is_none());
    }
}
