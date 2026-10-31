//! `ContactAddressesEngine` (`libs/data-access/contact-addresses/src/lib/contact-addresses-engine.ts`):
//! its plain-data shapes and the pure steps between the SDK's answers and them.

use matrix_sdk::ruma::api::client::{
    account::ThirdPartyIdRemovalStatus, discovery::get_capabilities::v3::Capabilities,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;

const DTO: &str = "data-access/contact-addresses/src/lib/rust-dto/";

/// `ThreePid`.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct ThreePidDto {
    pub medium: String,
    pub address: String,
}

/// `threePids`' result.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct ThreePidListDto {
    pub addresses: Vec<ThreePidDto>,
    pub can_change: bool,
}

/// `requestAddEmailToken`'s result.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct EmailTokenDto {
    pub sid: String,
}

/// `OpenIdToken`.
#[derive(Debug, PartialEq, Serialize, TS)]
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
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct AddEmailTokenRequestDto {
    pub email: String,
    pub client_secret: String,
    pub send_attempt: u32,
}

/// `addThreePid`'s request.
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct AddThreePidRequestDto {
    pub sid: String,
    pub client_secret: String,
}

/// `bindThreePid`'s request.
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct BindThreePidRequestDto {
    pub sid: String,
    pub client_secret: String,
    pub id_server: String,
    pub id_access_token: String,
}

/// The one medium `unbindThreePid` takes.
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = DTO)]
pub enum UnbindMediumDto {
    Email,
}

/// `unbindThreePid`'s request.
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct UnbindThreePidRequestDto {
    pub medium: UnbindMediumDto,
    pub address: String,
    pub id_server: String,
}

#[cfg_attr(not(test), expect(dead_code, reason = "used by T7's commands"))]
/// The homeserver reads an absent `m.3pid_changes` as enabled.
fn can_change(capabilities: &Capabilities) -> bool {
    capabilities.thirdparty_id_changes.enabled
}

#[cfg_attr(not(test), expect(dead_code, reason = "used by T7's commands"))]
fn unbind_status(status: &ThirdPartyIdRemovalStatus) -> UnbindStatusDto {
    if matches!(status, ThirdPartyIdRemovalStatus::NoSupport) {
        UnbindStatusDto::NoSupport
    } else {
        UnbindStatusDto::Success
    }
}

#[cfg_attr(not(test), expect(dead_code, reason = "used by T7's commands"))]
/// `None` is account data never written; a content without a string `base_url` is "no identity
/// server". `wellKnown` is always `None`: Trinity configures no well-known polling.
fn identity_server_setting(stored: Option<Value>) -> IdentityServerSettingDto {
    IdentityServerSettingDto {
        account: stored.map(|content| IdentityServerAccountDto {
            base_url: content["base_url"].as_str().map(Into::into),
        }),
        well_known: None,
    }
}

#[cfg_attr(not(test), expect(dead_code, reason = "used by T7's commands"))]
fn accepted_terms_of(stored: Option<Value>) -> Vec<String> {
    stored
        .as_ref()
        .and_then(|content| content["accepted"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|url| url.as_str().map(Into::into))
        .collect()
}

#[cfg_attr(not(test), expect(dead_code, reason = "used by T7's commands"))]
fn identity_server_content(base_url: Option<&str>) -> Value {
    json!({"base_url": base_url})
}

#[cfg_attr(not(test), expect(dead_code, reason = "used by T7's commands"))]
fn accepted_terms_content(urls: &[String]) -> Value {
    json!({"accepted": urls})
}

#[cfg(test)]
mod tests {
    use super::*;

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
            to_json(identity_server_setting(None)),
            json!({"account": null, "wellKnown": null})
        );
        for stored in [json!({"base_url": null}), json!({}), json!({"base_url": 3})] {
            assert_eq!(
                to_json(identity_server_setting(Some(stored))),
                json!({"account": {"baseUrl": null}, "wellKnown": null})
            );
        }
        assert_eq!(
            to_json(identity_server_setting(Some(
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
}
