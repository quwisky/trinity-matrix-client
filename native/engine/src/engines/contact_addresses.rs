//! `ContactAddressesEngine` (`libs/data-access/contact-addresses/src/lib/contact-addresses-engine.ts`):
//! its plain-data shapes, the pure steps between the SDK's answers and them, and its commands.
//!
//! Every command sends once (`sent_once`), through `Engine::ruled`, and fails with
//! `uia_or_request_failed`. A write is `detached`, so a close never leaves it half sent; each is
//! one request or one `account_data::put`, so it ends within the teardown's `HOLDER_LIMIT`
//! (120 s): a request is at most 30 s by the SDK's default request timeout, a put at most 60 s,
//! and the rule's delivery waits come to about 10 s more.

use std::{fmt, sync::Arc};

use matrix_sdk::Error;
use matrix_sdk::ruma::{
    OwnedClientSecret, OwnedSessionId, UInt,
    api::client::{
        account::{
            IdentityServerInfo, ThirdPartyIdRemovalStatus, add_3pid, bind_3pid, delete_3pid,
            get_3pids, request_3pid_management_token_via_email, request_openid_token, unbind_3pid,
        },
        discovery::get_capabilities::{self, v3::Capabilities},
    },
    thirdparty::Medium,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;

use crate::{
    accounts::Engine,
    dispatch::{Stream, detached, reply},
    engines::{
        account_data,
        member::{on_account, sent_once},
        session::{UiaAuthDto, logout::uia_auth_data},
    },
    failure::uia_or_request_failed,
};

const DTO: &str = "data-access/contact-addresses/src/lib/rust-dto/";

/// `ThreePid`.
#[derive(PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct ThreePidDto {
    pub medium: String,
    pub address: String,
}

/// `threePids`' result.
#[derive(PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct ThreePidListDto {
    pub addresses: Vec<ThreePidDto>,
    pub can_change: bool,
}

/// `requestAddEmailToken`'s result.
#[derive(PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct EmailTokenDto {
    pub sid: String,
}

/// `OpenIdToken`.
#[derive(PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct OpenIdTokenDto {
    pub access_token: String,
    pub token_type: String,
    pub matrix_server_name: String,
    pub expires_in: u32,
}

/// The stored `m.identity_server` content.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct IdentityServerAccountDto {
    pub base_url: Option<String>,
}

/// `identityServerSetting`'s result.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct IdentityServerSettingDto {
    pub account: Option<IdentityServerAccountDto>,
    pub well_known: Option<String>,
}

/// `'success' | 'no-support'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = DTO)]
pub enum UnbindStatusDto {
    Success,
    NoSupport,
}

/// `deleteThreePid`'s result.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct DeleteThreePidDto {
    pub unbind: UnbindStatusDto,
}

/// `requestAddEmailToken`'s request.
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct AddEmailTokenRequestDto {
    pub email: String,
    pub client_secret: String,
    pub send_attempt: u32,
}

/// `addThreePid`'s request.
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct AddThreePidRequestDto {
    pub sid: String,
    pub client_secret: String,
}

/// `bindThreePid`'s request.
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct BindThreePidRequestDto {
    pub sid: String,
    pub client_secret: String,
    pub id_server: String,
    pub id_access_token: String,
}

// The `Debug` of a DTO that carries a secret, a token or an address leaves it out.

impl fmt::Debug for ThreePidDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ThreePidDto")
            .field("medium", &self.medium)
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for ThreePidListDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ThreePidListDto")
            .field("addresses", &self.addresses.len())
            .field("can_change", &self.can_change)
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for EmailTokenDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EmailTokenDto").finish_non_exhaustive()
    }
}

impl fmt::Debug for UnbindThreePidRequestDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("UnbindThreePidRequestDto")
            .field("medium", &self.medium)
            .field("id_server", &self.id_server)
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for OpenIdTokenDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenIdTokenDto")
            .field("token_type", &self.token_type)
            .field("matrix_server_name", &self.matrix_server_name)
            .field("expires_in", &self.expires_in)
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for AddEmailTokenRequestDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AddEmailTokenRequestDto")
            .field("send_attempt", &self.send_attempt)
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for AddThreePidRequestDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AddThreePidRequestDto")
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for BindThreePidRequestDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BindThreePidRequestDto")
            .field("id_server", &self.id_server)
            .finish_non_exhaustive()
    }
}

/// The one medium `unbindThreePid` takes.
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = DTO)]
pub enum UnbindMediumDto {
    Email,
}

/// `unbindThreePid`'s request.
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct UnbindThreePidRequestDto {
    pub medium: UnbindMediumDto,
    pub address: String,
    pub id_server: String,
}

/// The homeserver reads an absent `m.3pid_changes` as enabled.
fn can_change(capabilities: &Capabilities) -> bool {
    capabilities.thirdparty_id_changes.enabled
}

fn unbind_status(status: &ThirdPartyIdRemovalStatus) -> UnbindStatusDto {
    if matches!(status, ThirdPartyIdRemovalStatus::NoSupport) {
        UnbindStatusDto::NoSupport
    } else {
        UnbindStatusDto::Success
    }
}

/// `None` is account data never written; a content without a string `base_url` is "no identity
/// server". `wellKnown` is always `None`: Trinity configures no well-known polling.
fn identity_server_setting_of(stored: Option<Value>) -> IdentityServerSettingDto {
    IdentityServerSettingDto {
        account: stored.map(|content| IdentityServerAccountDto {
            base_url: content["base_url"].as_str().map(Into::into),
        }),
        well_known: None,
    }
}

fn accepted_terms_of(stored: Option<Value>) -> Vec<String> {
    stored
        .as_ref()
        .and_then(|content| content["accepted"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|url| url.as_str().map(Into::into))
        .collect()
}

fn identity_server_content(base_url: Option<&str>) -> Value {
    json!({"base_url": base_url})
}

fn accepted_terms_content(urls: &[String]) -> Value {
    json!({"accepted": urls})
}

pub fn three_pids(engine: Arc<Engine>, account_id: String) -> Stream {
    reply(on_account(
        engine,
        account_id,
        uia_or_request_failed,
        |engine, rt| async move {
            let addresses = rt
                .client
                .send(get_3pids::v3::Request::new())
                .with_request_config(sent_once());
            let addresses = engine.ruled(&rt, addresses).await?;
            // Not `homeserver_capabilities()`, which caches and retries.
            let capabilities = rt
                .client
                .send(get_capabilities::v3::Request::new())
                .with_request_config(sent_once());
            let capabilities = engine.ruled(&rt, capabilities).await?;
            Ok(ThreePidListDto {
                addresses: addresses
                    .threepids
                    .into_iter()
                    .map(|pid| ThreePidDto {
                        medium: pid.medium.as_str().into(),
                        address: pid.address,
                    })
                    .collect(),
                can_change: can_change(&capabilities.capabilities),
            })
        },
    ))
}

pub fn request_add_email_token(
    engine: Arc<Engine>,
    account_id: String,
    request: AddEmailTokenRequestDto,
) -> Stream {
    detached(on_account(
        engine,
        account_id,
        uia_or_request_failed,
        move |engine, rt| async move {
            let secret = OwnedClientSecret::try_from(request.client_secret)?;
            let attempt = UInt::from(request.send_attempt);
            let request = request_3pid_management_token_via_email::v3::Request::new(
                secret,
                request.email,
                attempt,
            );
            let send = rt
                .client
                .send(request)
                .with_request_config(sent_once().force_auth());
            let response = engine.ruled(&rt, send).await?;
            Ok(EmailTokenDto {
                sid: response.sid.into(),
            })
        },
    ))
}

pub fn add_three_pid(
    engine: Arc<Engine>,
    account_id: String,
    request: AddThreePidRequestDto,
    auth: Option<UiaAuthDto>,
) -> Stream {
    detached(on_account(
        engine,
        account_id,
        uia_or_request_failed,
        move |engine, rt| async move {
            let secret = OwnedClientSecret::try_from(request.client_secret)?;
            let sid = OwnedSessionId::try_from(request.sid)?;
            let mut request = add_3pid::v3::Request::new(secret, sid);
            request.auth = auth.map(uia_auth_data);
            let send = rt.client.send(request).with_request_config(sent_once());
            engine.ruled(&rt, send).await.map(drop)
        },
    ))
}

pub fn delete_three_pid(
    engine: Arc<Engine>,
    account_id: String,
    medium: String,
    address: String,
) -> Stream {
    detached(on_account(
        engine,
        account_id,
        uia_or_request_failed,
        move |engine, rt| async move {
            let request = delete_3pid::v3::Request::new(Medium::from(medium), address);
            let send = rt.client.send(request).with_request_config(sent_once());
            let response = engine.ruled(&rt, send).await?;
            Ok(DeleteThreePidDto {
                unbind: unbind_status(&response.id_server_unbind_result),
            })
        },
    ))
}

pub fn identity_server_setting(engine: Arc<Engine>, account_id: String) -> Stream {
    reply(on_account(
        engine,
        account_id,
        uia_or_request_failed,
        |engine, rt| async move {
            let stored = account_data::get(&rt.client, "m.identity_server");
            Ok(identity_server_setting_of(engine.ruled(&rt, stored).await?))
        },
    ))
}

pub fn set_identity_server(
    engine: Arc<Engine>,
    account_id: String,
    base_url: Option<String>,
) -> Stream {
    detached(on_account(
        engine,
        account_id,
        uia_or_request_failed,
        move |engine, rt| async move {
            let content = identity_server_content(base_url.as_deref());
            let put = account_data::put(&rt.client, "m.identity_server", &content);
            engine.ruled(&rt, put).await
        },
    ))
}

pub fn accepted_terms(engine: Arc<Engine>, account_id: String) -> Stream {
    reply(on_account(
        engine,
        account_id,
        uia_or_request_failed,
        |engine, rt| async move {
            let stored = account_data::get(&rt.client, "m.accepted_terms");
            Ok(accepted_terms_of(engine.ruled(&rt, stored).await?))
        },
    ))
}

pub fn set_accepted_terms(engine: Arc<Engine>, account_id: String, urls: Vec<String>) -> Stream {
    detached(on_account(
        engine,
        account_id,
        uia_or_request_failed,
        move |engine, rt| async move {
            let content = accepted_terms_content(&urls);
            let put = account_data::put(&rt.client, "m.accepted_terms", &content);
            engine.ruled(&rt, put).await
        },
    ))
}

pub fn open_id_token(engine: Arc<Engine>, account_id: String) -> Stream {
    reply(on_account(
        engine,
        account_id,
        uia_or_request_failed,
        |engine, rt| async move {
            let me = rt.client.user_id().ok_or(Error::AuthenticationRequired)?;
            let request = request_openid_token::v3::Request::new(me.to_owned());
            let send = rt.client.send(request).with_request_config(sent_once());
            let token = engine.ruled(&rt, send).await?;
            Ok(OpenIdTokenDto {
                access_token: token.access_token,
                token_type: token.token_type.as_str().into(),
                matrix_server_name: token.matrix_server_name.into(),
                // Saturates: a lifetime past `u32::MAX` seconds (136 years) reads as that.
                expires_in: u32::try_from(token.expires_in.as_secs()).unwrap_or(u32::MAX),
            })
        },
    ))
}

pub fn bind_three_pid(
    engine: Arc<Engine>,
    account_id: String,
    request: BindThreePidRequestDto,
) -> Stream {
    detached(on_account(
        engine,
        account_id,
        uia_or_request_failed,
        move |engine, rt| async move {
            let secret = OwnedClientSecret::try_from(request.client_secret)?;
            let sid = OwnedSessionId::try_from(request.sid)?;
            let server = IdentityServerInfo::new(request.id_server, request.id_access_token);
            let request = bind_3pid::v3::Request::new(secret, server, sid);
            let send = rt.client.send(request).with_request_config(sent_once());
            engine.ruled(&rt, send).await.map(drop)
        },
    ))
}

pub fn unbind_three_pid(
    engine: Arc<Engine>,
    account_id: String,
    request: UnbindThreePidRequestDto,
) -> Stream {
    detached(on_account(
        engine,
        account_id,
        uia_or_request_failed,
        move |engine, rt| async move {
            let UnbindMediumDto::Email = request.medium;
            let mut unbind = unbind_3pid::v3::Request::new(Medium::Email, request.address);
            unbind.id_server = Some(request.id_server);
            let send = rt.client.send(unbind).with_request_config(sent_once());
            let response = engine.ruled(&rt, send).await?;
            Ok(unbind_status(&response.id_server_unbind_result))
        },
    ))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use futures_util::{FutureExt, StreamExt};
    use matrix_sdk::{sleep::sleep, timeout::timeout};
    use tempfile::TempDir;

    use super::*;
    use crate::{
        dispatch::dispatch,
        testing::{Seen, default_client, engine_in, live, password, requests, scripted},
    };

    const SECRET: &str = "secret-12345";
    const SID: &str = "session-1";
    const THREE_PIDS: &str = "GET /_matrix/client/v3/account/3pid";
    const CAPABILITIES: &str = "GET /_matrix/client/v3/capabilities";
    const ADD: &str = "POST /_matrix/client/v3/account/3pid/add";
    const PUT_IDENTITY: &str = "PUT /_matrix/client/v3/user/@a:b/account_data/m.identity_server";
    const PUT_TERMS: &str = "PUT /_matrix/client/v3/user/@a:b/account_data/m.accepted_terms";

    fn account_args(rest: &[Value]) -> Vec<Value> {
        [&[json!("@a:b")], rest].concat()
    }

    fn token_request(secret: &str) -> Value {
        json!({"email": "a@b.c", "clientSecret": secret, "sendAttempt": 1})
    }

    fn pair_request(secret: &str, sid: &str) -> Value {
        json!({"sid": sid, "clientSecret": secret})
    }

    fn bind_request(secret: &str, sid: &str) -> Value {
        json!({"sid": sid, "clientSecret": secret, "idServer": "id.example", "idAccessToken": "i"})
    }

    fn unbind_request() -> Value {
        json!({"medium": "email", "address": "a@b.c", "idServer": "id.example"})
    }

    /// Every member with its arguments after the account id, the client secret and sid as given.
    fn members(secret: &str, sid: &str) -> [(&'static str, Vec<Value>); 11] {
        [
            ("threePids", vec![]),
            ("requestAddEmailToken", vec![token_request(secret)]),
            ("addThreePid", vec![pair_request(secret, sid), json!(null)]),
            ("deleteThreePid", vec![json!("email"), json!("a@b.c")]),
            ("identityServerSetting", vec![]),
            ("setIdentityServer", vec![json!(null)]),
            ("acceptedTerms", vec![]),
            ("setAcceptedTerms", vec![json!(["https://t.example"])]),
            ("openIdToken", vec![]),
            ("bindThreePid", vec![bind_request(secret, sid)]),
            ("unbindThreePid", vec![unbind_request()]),
        ]
    }

    fn args_of(member: &str) -> Vec<Value> {
        let (_, args) = members(SECRET, SID)
            .into_iter()
            .find(|(m, _)| *m == member)
            .unwrap();
        account_args(&args)
    }

    /// A live `@a:b` on the SDK's default (retrying) config, answered with `answers`.
    async fn live_on(answers: Vec<(&'static str, u16, Value)>) -> (TempDir, Arc<Engine>, Seen) {
        let (base, seen) = scripted(answers);
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let account = password(&base);
        drop(live(&engine, &account, default_client(&engine, &account).await).await);
        (root, engine, seen)
    }

    fn call(engine: &Arc<Engine>, member: &str, args: Vec<Value>) -> Stream {
        dispatch(engine, &format!("contactAddresses.{member}"), args).unwrap()
    }

    async fn reply_of(engine: &Arc<Engine>, member: &str, args: Vec<Value>) -> Value {
        call(engine, member, args).next().await.unwrap().unwrap()
    }

    fn unavailable() -> Value {
        json!({"errcode": "M_UNKNOWN", "error": "x"})
    }

    fn to_json(value: impl Serialize) -> Value {
        serde_json::to_value(value).unwrap()
    }

    fn capabilities(value: Value) -> Capabilities {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn can_change_defaults_to_true_when_the_capability_is_absent() {
        assert!(can_change(&capabilities(json!({}))));
        assert!(can_change(&capabilities(
            json!({"m.3pid_changes": {"enabled": true}})
        )));
        assert!(!can_change(&capabilities(
            json!({"m.3pid_changes": {"enabled": false}})
        )));
    }

    #[test]
    fn unbind_status_maps_only_no_support_to_no_support() {
        assert_eq!(
            unbind_status(&ThirdPartyIdRemovalStatus::NoSupport),
            UnbindStatusDto::NoSupport
        );
        assert_eq!(
            unbind_status(&ThirdPartyIdRemovalStatus::Success),
            UnbindStatusDto::Success
        );
        assert_eq!(
            unbind_status(&ThirdPartyIdRemovalStatus::from("other")),
            UnbindStatusDto::Success
        );
    }

    #[test]
    fn the_identity_server_setting_distinguishes_absent_from_a_null_base_url() {
        assert_eq!(
            to_json(identity_server_setting_of(None)),
            json!({"account": null, "wellKnown": null})
        );
        for stored in [json!({"base_url": null}), json!({}), json!({"base_url": 3})] {
            assert_eq!(
                to_json(identity_server_setting_of(Some(stored))),
                json!({"account": {"baseUrl": null}, "wellKnown": null})
            );
        }
        assert_eq!(
            to_json(identity_server_setting_of(Some(
                json!({"base_url": "https://id.example"})
            ))),
            json!({"account": {"baseUrl": "https://id.example"}, "wellKnown": null})
        );
    }

    #[test]
    fn accepted_terms_drop_non_strings_and_non_arrays() {
        assert_eq!(accepted_terms_of(None), Vec::<String>::new());
        assert_eq!(
            accepted_terms_of(Some(json!({"accepted": ["a", 1, null, "b"]}))),
            ["a", "b"]
        );
        for stored in [json!({}), json!({"accepted": "a"}), json!("a"), json!(null)] {
            assert_eq!(accepted_terms_of(Some(stored)), Vec::<String>::new());
        }
    }

    #[test]
    fn the_content_builders_write_what_js_writes() {
        assert_eq!(identity_server_content(None), json!({"base_url": null}));
        assert_eq!(
            identity_server_content(Some("https://id.example")),
            json!({"base_url": "https://id.example"})
        );
        assert_eq!(
            accepted_terms_content(&["a".into(), "b".into()]),
            json!({"accepted": ["a", "b"]})
        );
        assert_eq!(accepted_terms_content(&[]), json!({"accepted": []}));
    }

    #[test]
    fn the_outputs_write_their_typescript_shapes() {
        assert_eq!(
            to_json(ThreePidListDto {
                addresses: vec![ThreePidDto {
                    medium: "email".into(),
                    address: "a@b.c".into()
                }],
                can_change: false,
            }),
            json!({"addresses": [{"medium": "email", "address": "a@b.c"}], "canChange": false})
        );
        assert_eq!(
            to_json(EmailTokenDto { sid: "s".into() }),
            json!({"sid": "s"})
        );
        assert_eq!(
            to_json(OpenIdTokenDto {
                access_token: "t".into(),
                token_type: "Bearer".into(),
                matrix_server_name: "hs".into(),
                expires_in: 3600,
            }),
            json!({
                "accessToken": "t", "tokenType": "Bearer", "matrixServerName": "hs",
                "expiresIn": 3600
            })
        );
        assert_eq!(
            to_json(DeleteThreePidDto {
                unbind: UnbindStatusDto::NoSupport
            }),
            json!({"unbind": "no-support"})
        );
        assert_eq!(to_json(UnbindStatusDto::Success), json!("success"));
    }

    #[test]
    fn debug_leaves_out_secrets_and_addresses() {
        let (add, token, bind): (AddThreePidRequestDto, AddEmailTokenRequestDto, _) = (
            serde_json::from_value(json!({"sid": "hunter2", "clientSecret": "hunter2"})).unwrap(),
            serde_json::from_value(
                json!({"email": "hunter2", "clientSecret": "hunter2", "sendAttempt": 1}),
            )
            .unwrap(),
            serde_json::from_value::<BindThreePidRequestDto>(json!({
                "sid": "hunter2",
                "clientSecret": "hunter2",
                "idServer": "id.example",
                "idAccessToken": "hunter2",
            }))
            .unwrap(),
        );
        let open_id = OpenIdTokenDto {
            access_token: "hunter2".into(),
            token_type: "Bearer".into(),
            matrix_server_name: "hs.example".into(),
            expires_in: 60,
        };
        let unbind: UnbindThreePidRequestDto = serde_json::from_value(
            json!({"medium": "email", "address": "hunter2", "idServer": "id.example"}),
        )
        .unwrap();
        let list = ThreePidListDto {
            addresses: vec![ThreePidDto {
                medium: "email".into(),
                address: "hunter2".into(),
            }],
            can_change: true,
        };
        let debug = [
            format!("{add:?}"),
            format!("{token:?}"),
            format!("{bind:?}"),
            format!("{open_id:?}"),
            format!("{unbind:?}"),
            format!("{list:?}"),
            format!("{:?}", list.addresses[0]),
            format!(
                "{:?}",
                EmailTokenDto {
                    sid: "hunter2".into()
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
    fn the_inputs_decode_what_typescript_sends() {
        let add: AddThreePidRequestDto =
            serde_json::from_value(json!({"sid": "s", "clientSecret": "c"})).unwrap();
        assert_eq!((add.sid.as_str(), add.client_secret.as_str()), ("s", "c"));
        let token: AddEmailTokenRequestDto = serde_json::from_value(
            json!({"email": "a@b.c", "clientSecret": "c", "sendAttempt": 2}),
        )
        .unwrap();
        assert_eq!(token.send_attempt, 2);
        let bind: BindThreePidRequestDto = serde_json::from_value(
            json!({"sid": "s", "clientSecret": "c", "idServer": "id", "idAccessToken": "t"}),
        )
        .unwrap();
        assert_eq!(bind.id_access_token, "t");
        let unbind = |medium| {
            serde_json::from_value::<UnbindThreePidRequestDto>(
                json!({"medium": medium, "address": "a", "idServer": "id"}),
            )
        };
        assert!(unbind("email").is_ok());
        assert!(unbind("msisdn").is_err());
    }

    #[tokio::test]
    async fn every_contact_command_sends_its_request_once() {
        let open_id = json!({
            "access_token": "x", "token_type": "Bearer", "matrix_server_name": "b",
            "expires_in": 3600
        });
        let removal = json!({"id_server_unbind_result": "success"});
        let table = [
            ("threePids", THREE_PIDS, json!({"threepids": []})),
            (
                "requestAddEmailToken",
                "POST /_matrix/client/v3/account/3pid/email/requestToken",
                json!({"sid": SID}),
            ),
            ("addThreePid", ADD, json!({})),
            (
                "deleteThreePid",
                "POST /_matrix/client/v3/account/3pid/delete",
                removal.clone(),
            ),
            (
                "identityServerSetting",
                "GET /_matrix/client/v3/user/@a:b/account_data/m.identity_server",
                json!({}),
            ),
            (
                "acceptedTerms",
                "GET /_matrix/client/v3/user/@a:b/account_data/m.accepted_terms",
                json!({}),
            ),
            (
                "openIdToken",
                "POST /_matrix/client/v3/user/@a:b/openid/request_token",
                open_id,
            ),
            (
                "bindThreePid",
                "POST /_matrix/client/v3/account/3pid/bind",
                json!({}),
            ),
            (
                "unbindThreePid",
                "POST /_matrix/client/v3/account/3pid/unbind",
                removal,
            ),
        ];
        for (member, route, ok) in table {
            let (_root, engine, seen) =
                live_on(vec![(route, 502, unavailable()), (route, 200, ok)]).await;
            let reply = reply_of(&engine, member, args_of(member)).await;
            assert_eq!(
                (requests(&seen).len(), reply.pointer("/failure/kind")),
                (1, Some(&json!("server"))),
                "{member}: {reply}"
            );
        }
    }

    #[tokio::test]
    async fn a_failed_capability_request_fails_three_pids_after_both_requests() {
        let answers = vec![
            (THREE_PIDS, 200, json!({"threepids": []})),
            (CAPABILITIES, 502, unavailable()),
        ];
        let (_root, engine, seen) = live_on(answers).await;
        let reply = reply_of(&engine, "threePids", args_of("threePids")).await;
        assert_eq!(requests(&seen).len(), 2);
        assert_eq!(
            reply.pointer("/failure/code"),
            Some(&json!("request-failed"))
        );
    }

    #[tokio::test]
    async fn three_pids_lists_addresses_and_reads_the_capability() {
        let listed = json!({"threepids": [
            {"medium": "email", "address": "a@b.c", "validated_at": 1, "added_at": 2}
        ]});
        let capabilities = json!({"capabilities": {"m.3pid_changes": {"enabled": false}}});
        let answers = vec![(THREE_PIDS, 200, listed), (CAPABILITIES, 200, capabilities)];
        let (_root, engine, _) = live_on(answers).await;
        let reply = reply_of(&engine, "threePids", args_of("threePids")).await;
        let expected =
            json!({"addresses": [{"medium": "email", "address": "a@b.c"}], "canChange": false});
        assert_eq!(reply, json!({"ok": true, "value": expected}));
    }

    #[tokio::test]
    async fn the_email_token_request_carries_the_token() {
        let route = "POST /_matrix/client/v3/account/3pid/email/requestToken";
        let (_root, engine, seen) = live_on(vec![(route, 200, json!({"sid": SID}))]).await;
        let member = "requestAddEmailToken";
        let reply = reply_of(&engine, member, args_of(member)).await;
        assert_eq!(reply, json!({"ok": true, "value": {"sid": SID}}));
        assert_eq!(requests(&seen), [(route.into(), Some("Bearer t1".into()))]);
    }

    #[tokio::test]
    async fn adding_without_auth_answers_the_challenge() {
        let challenge = json!({"flows": [{"stages": ["m.login.password"]}], "session": "s1"});
        let (_root, engine, _) = live_on(vec![(ADD, 401, challenge)]).await;
        let reply = reply_of(&engine, "addThreePid", args_of("addThreePid")).await;
        assert_eq!(reply.pointer("/failure/code"), Some(&json!("uia-required")));
        assert_eq!(
            reply.pointer("/failure/params/challenge/session"),
            Some(&json!("s1")),
            "{reply}"
        );
    }

    #[tokio::test]
    async fn add_three_pid_decodes_a_null_auth_and_a_session_only_auth() {
        let (_root, engine, seen) =
            live_on(vec![(ADD, 200, json!({})), (ADD, 200, json!({}))]).await;
        let pair = pair_request(SECRET, SID);
        for auth in [json!(null), json!({"session": "s1"})] {
            let reply = reply_of(&engine, "addThreePid", account_args(&[pair.clone(), auth])).await;
            assert_eq!(reply, json!({"ok": true, "value": null}));
        }
        assert_eq!(requests(&seen).len(), 2);
    }

    #[tokio::test]
    async fn the_account_data_writes_retry() {
        for (member, route, args) in [
            (
                "setIdentityServer",
                PUT_IDENTITY,
                args_of("setIdentityServer"),
            ),
            ("setAcceptedTerms", PUT_TERMS, args_of("setAcceptedTerms")),
        ] {
            let answers = vec![(route, 502, unavailable()), (route, 200, json!({}))];
            let (_root, engine, seen) = live_on(answers).await;
            let reply = reply_of(&engine, member, args).await;
            assert_eq!(
                (reply, requests(&seen).len()),
                (json!({"ok": true, "value": null}), 2),
                "{member}"
            );
        }
    }

    #[tokio::test]
    async fn a_closed_write_still_reaches_the_server() {
        let ok = json!({"id_server_unbind_result": "success"});
        let table = [
            (
                "requestAddEmailToken",
                "POST /_matrix/client/v3/account/3pid/email/requestToken",
                json!({"sid": SID}),
            ),
            ("addThreePid", ADD, json!({})),
            (
                "deleteThreePid",
                "POST /_matrix/client/v3/account/3pid/delete",
                ok.clone(),
            ),
            ("setIdentityServer", PUT_IDENTITY, json!({})),
            ("setAcceptedTerms", PUT_TERMS, json!({})),
            (
                "bindThreePid",
                "POST /_matrix/client/v3/account/3pid/bind",
                json!({}),
            ),
            (
                "unbindThreePid",
                "POST /_matrix/client/v3/account/3pid/unbind",
                ok,
            ),
        ];
        for (member, route, answer) in table {
            let (_root, engine, seen) = live_on(vec![(route, 200, answer)]).await;
            let mut closed = call(&engine, member, args_of(member));
            assert!(
                closed.next().now_or_never().is_none(),
                "{member}: in flight"
            );
            drop(closed);
            let arrived = async {
                while requests(&seen).is_empty() {
                    sleep(Duration::from_millis(10)).await;
                }
            };
            let arrived = timeout(arrived, Duration::from_secs(2)).await;
            assert!(arrived.is_ok(), "{member}: the close dropped the write");
        }
    }

    #[tokio::test]
    async fn a_not_live_account_fails_before_its_arguments_are_parsed() {
        let engine = Engine::new(crate::config::EngineConfig::default()).unwrap();
        for (member, args) in members("bad secret!", "bad sid!") {
            let args = [&[json!("@x:y")], args.as_slice()].concat();
            let reply = reply_of(&engine, member, args).await;
            assert_eq!(
                reply.pointer("/failure/code"),
                Some(&json!("account-not-live")),
                "{member}: {reply}"
            );
        }
    }

    #[tokio::test]
    async fn an_id_that_does_not_parse_is_an_unexpected_request_failure_before_any_request() {
        let (_root, engine, seen) = live_on(vec![]).await;
        for (member, args) in members("bad secret!", "bad sid!") {
            if !["requestAddEmailToken", "addThreePid", "bindThreePid"].contains(&member) {
                continue;
            }
            let reply = reply_of(&engine, member, account_args(&args)).await;
            let failure = reply.get("failure").unwrap();
            assert_eq!(
                (failure.get("kind"), failure.get("code")),
                (Some(&json!("unexpected")), Some(&json!("request-failed"))),
                "{member}"
            );
        }
        assert!(requests(&seen).is_empty());
    }
}
