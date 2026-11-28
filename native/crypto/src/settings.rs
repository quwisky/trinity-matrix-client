//! `EncryptionSettings` and `DecryptionSettings` as the WASM bindings take them.
//!
//! Ported from matrix-sdk-crypto-wasm v18.9.0 `src/encryption.rs` (Apache-2.0, see
//! `LICENSE-APACHE`). Enums are the WASM enum numbers; `sharingStrategy` names the WASM
//! `CollectStrategy` constructor. A missing field keeps matrix-sdk-crypto's default.

use std::time::Duration;

use matrix_sdk_common::ruma::events::room::history_visibility::HistoryVisibility;
use matrix_sdk_crypto::{
    CollectStrategy, DecryptionSettings, EncryptionSettings, TrustRequirement,
    types::EventEncryptionAlgorithm,
};
use serde::Deserialize;

use crate::error::{CallError, CallResult};

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct EncryptionSettingsParams {
    algorithm: Option<u8>,
    encrypt_state_events: Option<bool>,
    rotation_period: Option<u64>,
    rotation_period_messages: Option<u64>,
    history_visibility: Option<u8>,
    sharing_strategy: Option<String>,
}

impl TryFrom<EncryptionSettingsParams> for EncryptionSettings {
    type Error = CallError;

    fn try_from(params: EncryptionSettingsParams) -> CallResult<Self> {
        let mut settings = EncryptionSettings::default();
        if let Some(algorithm) = params.algorithm {
            settings.algorithm = match algorithm {
                0 => EventEncryptionAlgorithm::OlmV1Curve25519AesSha2,
                1 => EventEncryptionAlgorithm::MegolmV1AesSha2,
                _ => return Err(CallError::invalid("unknown encryption algorithm")),
            };
        }
        if let Some(encrypt_state_events) = params.encrypt_state_events {
            settings.encrypt_state_events = encrypt_state_events;
        }
        if let Some(micros) = params.rotation_period {
            settings.rotation_period = Duration::from_micros(micros);
        }
        if let Some(messages) = params.rotation_period_messages {
            settings.rotation_period_msgs = messages;
        }
        if let Some(visibility) = params.history_visibility {
            settings.history_visibility = match visibility {
                0 => HistoryVisibility::Invited,
                1 => HistoryVisibility::Joined,
                2 => HistoryVisibility::Shared,
                3 => HistoryVisibility::WorldReadable,
                _ => return Err(CallError::invalid("unknown history visibility")),
            };
        }
        if let Some(strategy) = params.sharing_strategy {
            settings.sharing_strategy = collect_strategy(&strategy)?;
        }
        Ok(settings)
    }
}

/// The WASM `CollectStrategy` constructor of this name.
pub fn collect_strategy(name: &str) -> CallResult<CollectStrategy> {
    Ok(match name {
        "allDevices" => CollectStrategy::AllDevices,
        "errorOnUnverifiedUserProblem" => CollectStrategy::ErrorOnVerifiedUserProblem,
        "identityBasedStrategy" => CollectStrategy::IdentityBasedStrategy,
        "onlyTrustedDevices" => CollectStrategy::OnlyTrustedDevices,
        _ => return Err(CallError::invalid("unknown sharing strategy")),
    })
}

/// The WASM class exposes its field in snake case.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DecryptionSettingsParams {
    sender_device_trust_requirement: u8,
}

impl TryFrom<DecryptionSettingsParams> for DecryptionSettings {
    type Error = CallError;

    fn try_from(params: DecryptionSettingsParams) -> CallResult<Self> {
        let sender_device_trust_requirement = match params.sender_device_trust_requirement {
            0 => TrustRequirement::Untrusted,
            1 => TrustRequirement::CrossSignedOrLegacy,
            2 => TrustRequirement::CrossSigned,
            _ => return Err(CallError::invalid("unknown trust requirement")),
        };
        Ok(DecryptionSettings {
            sender_device_trust_requirement,
        })
    }
}
