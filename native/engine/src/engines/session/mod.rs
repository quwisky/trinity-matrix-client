//! `SessionEngine` (`libs/data-access/matrix-client/src/lib/session-engine.ts`): the signed-in
//! accounts and their lifecycle.

pub(crate) mod restore;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

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
// No `Debug`: it carries the token.
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
// No `Debug`: it carries the tokens.
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

/// `PendingTextMessage`.
// No `Debug`: it carries what the person wrote.
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
// No `Debug`: it carries the tokens.
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
// No `Debug`: it carries the password.
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

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

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
