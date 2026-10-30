//! `SessionEngine` (`libs/data-access/matrix-client/src/lib/session-engine.ts`): the signed-in
//! accounts and their lifecycle.

pub mod logout;
pub mod reads;
pub(crate) mod restore;
pub mod runtime;

use std::{fmt, sync::Arc};

use futures_util::{StreamExt, stream};
use matrix_sdk::SendOutsideWasm;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::{
    accounts::{Engine, Stores},
    dispatch::{Stream, item, reply, stream},
    failure::EngineResult,
};

const DTO: &str = "data-access/matrix-client/src/lib/rust-dto/";

/// `SessionSnapshot`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct SessionSnapshotDto {
    pub active_account_id: Option<String>,
    pub accounts: Vec<SessionAccountStatusDto>,
    pub soft_logged_out: Vec<String>,
}

/// `SessionAccountStatus`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct SessionAccountStatusDto {
    pub account_id: String,
    pub device_id: Option<String>,
    pub generation: u32,
    pub sync_state: SessionSyncStateDto,
    pub server_synced: bool,
    pub rooms_prepared: bool,
    pub waiting_count: u32,
    pub crypto_store_encrypted: bool,
}

/// `SessionSyncState`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = DTO)]
pub enum SessionSyncStateDto {
    Starting,
    Prepared,
    Syncing,
    Catchup,
    Reconnecting,
    Error,
    Stopped,
}

/// `SessionAccessToken`.
#[derive(Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct SessionAccessTokenDto {
    pub homeserver_url: String,
    pub access_token: String,
    pub expires_at: Option<f64>,
    pub refreshable: bool,
}

/// `SessionCredentials`.
#[derive(Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct SessionCredentialsDto {
    pub access_token: String,
    pub refresh_token: Option<String>,
}

/// `ServerLogoutHoldUpdate`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = DTO)]
pub enum ServerLogoutHoldUpdateDto {
    Held { hold_id: String, token_died: bool },
    TokenDied,
    TokenRenewed,
    SignedInAgain,
    Released,
}

/// `SessionStorageEffect`.
#[derive(Clone, PartialEq, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = DTO)]
pub enum SessionStorageEffectDto {
    TokensRotated {
        account_id: String,
        lineage: Option<String>,
        access_token: String,
        refresh_token: Option<String>,
        expires_at: Option<f64>,
    },
    SoftLogout {
        account_id: String,
        active_account_id: Option<String>,
    },
    HardLogout {
        account_id: String,
        active_account_id: Option<String>,
    },
}

/// `PendingTextMessage`.
#[derive(Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct PendingTextMessageDto {
    pub account_id: String,
    pub room_id: String,
    pub thread_root_id: Option<String>,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub txn_id: Option<String>,
}

/// `AccountServerStatus`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = DTO)]
pub enum AccountServerStatusDto {
    Active,
    Gone,
    Unreachable,
}

/// `AccountNameGroup`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct AccountNameGroupDto {
    pub room_names: Vec<String>,
    pub room_topics: Vec<String>,
    pub display_names: Vec<String>,
}

/// `MatrixSession`, of which the engine reads only these fields.
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct MatrixSessionDto {
    pub base_url: String,
    pub user_id: String,
    pub device_id: String,
    pub access_token: String,
    #[ts(optional)]
    pub refresh_token: Option<String>,
    #[ts(optional)]
    pub access_token_expires_at: Option<f64>,
    #[ts(optional)]
    pub oidc: Option<OidcBindingDto>,
    #[ts(optional)]
    pub lineage: Option<String>,
}

/// `OidcSessionBinding`, of which the engine reads only the client id.
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct OidcBindingDto {
    pub client_id: String,
}

/// `PersistedAccountActivation`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = DTO)]
pub enum PersistedAccountActivationDto {
    Activate,
    Background,
}

/// `activateAccount`'s `liveAccounts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = DTO)]
pub enum LiveAccountsDto {
    Keep,
    Replace,
}

/// `refreshAccessToken`'s options.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct RefreshOptionsDto {
    #[ts(optional)]
    pub timeout_ms: Option<u32>,
}

/// `UiaAuth`: a password for the stage, or the session alone.
#[derive(Deserialize, TS)]
#[serde(untagged)]
#[ts(export, export_to = DTO)]
pub enum UiaAuthDto {
    Password {
        #[serde(rename = "type")]
        #[ts(inline)]
        kind: PasswordStage,
        #[ts(inline)]
        identifier: UiaUserIdentifierDto,
        password: String,
        session: String,
    },
    Session {
        session: String,
    },
}

#[derive(Debug, Deserialize, TS)]
pub enum PasswordStage {
    #[serde(rename = "m.login.password")]
    Password,
}

#[derive(Debug, Deserialize, TS)]
pub struct UiaUserIdentifierDto {
    #[serde(rename = "type")]
    #[ts(inline)]
    pub kind: UserIdentifierType,
    pub user: String,
}

#[derive(Debug, Deserialize, TS)]
pub enum UserIdentifierType {
    #[serde(rename = "m.id.user")]
    User,
}

// The `Debug` of a DTO that carries a token, a password or what the person wrote leaves it out.

impl fmt::Debug for SessionAccessTokenDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionAccessTokenDto")
            .field("homeserver_url", &self.homeserver_url)
            .field("expires_at", &self.expires_at)
            .field("refreshable", &self.refreshable)
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for SessionCredentialsDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionCredentialsDto")
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for SessionStorageEffectDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (kind, account_id) = match self {
            Self::TokensRotated { account_id, .. } => ("TokensRotated", account_id),
            Self::SoftLogout { account_id, .. } => ("SoftLogout", account_id),
            Self::HardLogout { account_id, .. } => ("HardLogout", account_id),
        };
        f.debug_struct(kind)
            .field("account_id", account_id)
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for PendingTextMessageDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PendingTextMessageDto")
            .field("account_id", &self.account_id)
            .field("room_id", &self.room_id)
            .field("txn_id", &self.txn_id)
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for MatrixSessionDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MatrixSessionDto")
            .field("base_url", &self.base_url)
            .field("user_id", &self.user_id)
            .field("device_id", &self.device_id)
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for UiaAuthDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let kind = match self {
            Self::Password { .. } => "Password",
            Self::Session { .. } => "Session",
        };
        f.debug_struct(kind).finish_non_exhaustive()
    }
}

/// The current snapshot, then each change.
pub fn session(engine: Arc<Engine>) -> Stream {
    stream(engine.subscribe_session().map(item))
}

pub fn restore_persisted(
    engine: Arc<Engine>,
    session: MatrixSessionDto,
    activation: PersistedAccountActivationDto,
) -> Stream {
    stream(stream::once(async move {
        item(engine.restore(session, activation).await?)
    }))
}

pub fn set_active(engine: Arc<Engine>, account_id: String) -> Stream {
    done(async move { engine.set_active(&account_id).delivered().await })
}

pub fn activate_account(
    engine: Arc<Engine>,
    account_id: String,
    live_accounts: LiveAccountsDto,
) -> Stream {
    reply(async move {
        match engine.activate_account(&account_id, live_accounts) {
            Ok((barrier, retired)) => {
                let teardowns = retired.into_iter().map(|runtime| {
                    let id = runtime.account_id.clone();
                    engine.tear_down(&id, Some(runtime), Stores::Keep)
                });
                futures_util::future::join_all(teardowns).await;
                barrier.delivered().await;
                EngineResult::Ok(())
            }
            Err(failure) => EngineResult::Err(failure),
        }
    })
}

pub fn require_reauthentication(engine: Arc<Engine>, account_id: String) -> Stream {
    done(async move {
        engine
            .require_reauthentication(&account_id)
            .delivered()
            .await
    })
}

pub fn rollback_account_start(engine: Arc<Engine>, account_id: String) -> Stream {
    done(async move { engine.rollback_account_start(&account_id).await })
}

pub fn remove(engine: Arc<Engine>, account_id: String) -> Stream {
    done(async move { engine.remove(&account_id).await })
}

pub fn stop(engine: Arc<Engine>) -> Stream {
    done(async move { engine.stop().await })
}

/// A void command: `null` once `effect` has run and its changes have been delivered.
fn done(effect: impl Future<Output = ()> + SendOutsideWasm + 'static) -> Stream {
    reply(async move {
        effect.await;
        Value::Null
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn to_json(value: impl Serialize) -> Value {
        serde_json::to_value(value).unwrap()
    }

    #[test]
    fn an_empty_snapshot_writes_every_field() {
        let empty = SessionSnapshotDto {
            active_account_id: None,
            accounts: vec![],
            soft_logged_out: vec![],
        };
        assert_eq!(
            to_json(empty),
            json!({"activeAccountId": null, "accounts": [], "softLoggedOut": []})
        );
    }

    #[test]
    fn a_hold_update_tags_itself_with_its_kebab_case_kind() {
        let held = ServerLogoutHoldUpdateDto::Held {
            hold_id: "1".into(),
            token_died: false,
        };
        assert_eq!(
            to_json(held),
            json!({"kind": "held", "holdId": "1", "tokenDied": false})
        );
        assert_eq!(
            to_json(ServerLogoutHoldUpdateDto::TokenDied),
            json!({"kind": "token-died"})
        );
    }

    #[test]
    fn a_storage_effect_tags_itself_and_writes_every_field() {
        let soft = SessionStorageEffectDto::SoftLogout {
            account_id: "@a:b".into(),
            active_account_id: None,
        };
        assert_eq!(
            to_json(soft),
            json!({"kind": "soft-logout", "accountId": "@a:b", "activeAccountId": null})
        );
        let rotated = SessionStorageEffectDto::TokensRotated {
            account_id: "@a:b".into(),
            lineage: Some("L".into()),
            access_token: "t".into(),
            refresh_token: Some("r".into()),
            expires_at: None,
        };
        assert_eq!(
            to_json(rotated),
            json!({
                "kind": "tokens-rotated",
                "accountId": "@a:b",
                "lineage": "L",
                "accessToken": "t",
                "refreshToken": "r",
                "expiresAt": null,
            })
        );
    }

    #[test]
    fn a_pending_message_without_a_txn_has_no_txn_id() {
        let message = PendingTextMessageDto {
            account_id: "@a:b".into(),
            room_id: "!r:b".into(),
            thread_root_id: None,
            text: "hi".into(),
            txn_id: None,
        };
        assert_eq!(
            to_json(message),
            json!({"accountId": "@a:b", "roomId": "!r:b", "threadRootId": null, "text": "hi"})
        );
    }

    #[test]
    fn a_typescript_session_decodes_without_the_fields_the_engine_ignores() {
        let session: MatrixSessionDto = serde_json::from_value(json!({
            "baseUrl": "https://hs.example",
            "userId": "@a:hs.example",
            "deviceId": "DEV",
            "accessToken": "at",
            "refreshToken": "rt",
            "accessTokenExpiresAt": 1_700_000_000_000_u64,
            "oidc": {"issuer": "https://id.example", "clientId": "client"},
            "cryptoPrefix": "trinity-crypto:@a:hs.example:DEV",
            "cryptoStoreKeyed": true,
            "lineage": "l1",
        }))
        .unwrap();
        assert_eq!(session.refresh_token.as_deref(), Some("rt"));
        assert_eq!(session.access_token_expires_at, Some(1.7e12));
        assert_eq!(session.oidc.unwrap().client_id, "client");
        assert_eq!(session.lineage.as_deref(), Some("l1"));
        let password: MatrixSessionDto = serde_json::from_value(json!({
            "baseUrl": "https://hs.example",
            "userId": "@a:hs.example",
            "deviceId": "DEV",
            "accessToken": "at",
        }))
        .unwrap();
        assert!(password.refresh_token.is_none() && password.oidc.is_none());
    }

    #[test]
    fn debug_leaves_out_tokens_passwords_and_text() {
        let secret = || "hunter2".to_owned();
        let session: MatrixSessionDto = serde_json::from_value(json!({
            "baseUrl": "https://hs.example",
            "userId": "@a:b",
            "deviceId": "DEV",
            "accessToken": "hunter2",
            "refreshToken": "hunter2",
        }))
        .unwrap();
        let password: UiaAuthDto = serde_json::from_value(json!({
            "type": "m.login.password",
            "identifier": {"type": "m.id.user", "user": "@a:b"},
            "password": "hunter2",
            "session": "hunter2",
        }))
        .unwrap();
        let debug = [
            format!("{session:?}"),
            format!("{password:?}"),
            format!(
                "{:?}",
                SessionAccessTokenDto {
                    homeserver_url: "https://hs.example".into(),
                    access_token: secret(),
                    expires_at: None,
                    refreshable: false,
                }
            ),
            format!(
                "{:?}",
                SessionCredentialsDto {
                    access_token: secret(),
                    refresh_token: Some(secret()),
                }
            ),
            format!(
                "{:?}",
                SessionStorageEffectDto::TokensRotated {
                    account_id: "@a:b".into(),
                    lineage: None,
                    access_token: secret(),
                    refresh_token: Some(secret()),
                    expires_at: None,
                }
            ),
            format!(
                "{:?}",
                PendingTextMessageDto {
                    account_id: "@a:b".into(),
                    room_id: "!r:b".into(),
                    thread_root_id: None,
                    text: secret(),
                    txn_id: None,
                }
            ),
        ];
        for (index, debug) in debug.iter().enumerate() {
            assert!(
                !debug.contains("hunter2"),
                "Debug output {index} shows a secret"
            );
        }
    }

    #[test]
    fn uia_auth_decodes_both_typescript_shapes() {
        let password: UiaAuthDto = serde_json::from_value(json!({
            "type": "m.login.password",
            "identifier": {"type": "m.id.user", "user": "@a:b"},
            "password": "pw",
            "session": "s",
        }))
        .unwrap();
        assert!(matches!(
            password,
            UiaAuthDto::Password { identifier: UiaUserIdentifierDto { user, .. }, password, session, .. }
                if user == "@a:b" && password == "pw" && session == "s"
        ));
        let session: UiaAuthDto = serde_json::from_value(json!({"session": "s"})).unwrap();
        assert!(matches!(session, UiaAuthDto::Session { session } if session == "s"));
    }
}
