//! `EncryptionSettings` and `DecryptionSettings` as the WASM bindings take them, and the stored
//! `RoomSettings`.
//!
//! Ported from matrix-sdk-crypto-wasm v18.9.0 `src/encryption.rs`, `src/types.rs` and
//! `src/machine.rs` (Apache-2.0, see
//! `LICENSE-APACHE`). Enums are the WASM enum numbers; `sharingStrategy` names the WASM
//! `CollectStrategy` constructor. A missing field keeps matrix-sdk-crypto's default.

use std::time::Duration;

use matrix_sdk_common::ruma::OwnedRoomId;
use matrix_sdk_common::ruma::events::room::history_visibility::HistoryVisibility;
use matrix_sdk_crypto::store::types::RoomSettings;
use matrix_sdk_crypto::{
    CollectStrategy, DecryptionSettings, EncryptionSettings, OlmMachine, TrustRequirement,
    types::EventEncryptionAlgorithm,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::error::{CallError, CallResult};
use crate::events::algorithm;
use crate::machine::RoomIdParams;

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

/// WASM `RoomSettings`; its optional fields are left out when unset.
fn room_settings(settings: RoomSettings) -> Value {
    let mut value = Map::new();
    value.insert("algorithm".into(), json!(algorithm(settings.algorithm)));
    value.insert(
        "encryptStateEvents".into(),
        json!(settings.encrypt_state_events),
    );
    value.insert(
        "onlyAllowTrustedDevices".into(),
        json!(settings.only_allow_trusted_devices),
    );
    if let Some(period) = settings.session_rotation_period {
        value.insert(
            "sessionRotationPeriodMs".into(),
            json!(period.as_millis() as f64),
        );
    }
    if let Some(messages) = settings.session_rotation_period_messages {
        value.insert(
            "sessionRotationPeriodMessages".into(),
            json!(messages as f64),
        );
    }
    Value::Object(value)
}

pub async fn get_room_settings(machine: &OlmMachine, params: RoomIdParams) -> CallResult {
    Ok(machine
        .room_settings(&params.room_id)
        .await?
        .map_or(Value::Null, room_settings))
}

/// WASM `RoomSettings` as set from JavaScript; a missing field is its constructor's default.
#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomSettingsParams {
    algorithm: u8,
    encrypt_state_events: bool,
    only_allow_trusted_devices: bool,
    session_rotation_period_ms: Option<f64>,
    session_rotation_period_messages: Option<f64>,
}

impl Default for RoomSettingsParams {
    fn default() -> Self {
        Self {
            algorithm: 1,
            encrypt_state_events: false,
            only_allow_trusted_devices: false,
            session_rotation_period_ms: None,
            session_rotation_period_messages: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetRoomSettingsParams {
    room_id: OwnedRoomId,
    room_settings: RoomSettingsParams,
}

/// Refuses settings that differ from stored ones (`EncryptionDowngrade`) and an algorithm
/// other than Megolm, as matrix-sdk-crypto does.
pub async fn set_room_settings(machine: &OlmMachine, params: SetRoomSettingsParams) -> CallResult {
    let settings = params.room_settings;
    let algorithm = match settings.algorithm {
        0 => EventEncryptionAlgorithm::OlmV1Curve25519AesSha2,
        1 => EventEncryptionAlgorithm::MegolmV1AesSha2,
        // WASM reaches `unreachable!` here, a panic; refused instead.
        _ => return Err(CallError::invalid("unknown encryption algorithm")),
    };
    // As WASM's `as u64` / `as usize`: a fraction is cut, a negative number is 0.
    let settings = RoomSettings {
        algorithm,
        encrypt_state_events: settings.encrypt_state_events,
        only_allow_trusted_devices: settings.only_allow_trusted_devices,
        session_rotation_period: settings
            .session_rotation_period_ms
            .map(|millis| Duration::from_millis(millis as u64)),
        session_rotation_period_messages: settings
            .session_rotation_period_messages
            .map(|count| count as usize),
    };
    machine
        .set_room_settings(&params.room_id, &settings)
        .await
        .map_err(CallError::crypto)?;
    Ok(Value::Null)
}
