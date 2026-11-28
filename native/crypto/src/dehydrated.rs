//! Dehydrated devices: creating one to upload, rehydrating one to collect its room keys, and
//! the dehydration key cached in the store.
//!
//! Ported from matrix-sdk-crypto-wasm v18.9.0 `src/dehydrated_devices.rs` and
//! `src/requests.rs` (Apache-2.0, see `LICENSE-APACHE`). matrix-sdk-crypto keeps both devices
//! apart from the machine's store: a new dehydrated device lives in a memory store until its
//! upload request is built, and a rehydrated one is a temporary machine on a memory store whose
//! only write to the main store is the room keys it decrypts.
//!
//! WASM hands out `DehydratedDevice` and `RehydratedDevice` objects. Here a dehydrated device
//! is created and turned into its upload request in one call, so nothing is held. A
//! rehydrated device is held between calls under its device ID, one at a time, in the open
//! machine: it goes with the machine (`close`, a panic) and on every `init`.

use base64::Engine as _;
use matrix_sdk_common::ruma::OwnedDeviceId;
use matrix_sdk_crypto::dehydrated_devices::RehydratedDevice;
use matrix_sdk_crypto::store::types::DehydratedDeviceKey;
use matrix_sdk_crypto::{DecryptionSettings, OlmMachine, TrustRequirement};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use zeroize::Zeroizing;

use crate::error::{CallError, CallResult};
use crate::events;
use crate::settings::DecryptionSettingsParams;

/// The rehydrated device the host is feeding events to, if any.
pub type Rehydration = Option<(OwnedDeviceId, RehydratedDevice)>;

const KEY_ERROR: &str = "dehydratedDeviceKey must be base64";

/// The key as WASM's `DehydratedDeviceKey.toBase64()` gives it (unpadded; padding accepted).
fn key(encoded: String) -> CallResult<DehydratedDeviceKey> {
    let encoded = Zeroizing::new(encoded);
    let engine = base64::engine::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
    );
    let bytes = Zeroizing::new(
        engine
            .decode(encoded.as_bytes())
            .map_err(|_| CallError::invalid(KEY_ERROR))?,
    );
    // The length error names only the length, as WASM's `createKeyFromArray`.
    DehydratedDeviceKey::from_slice(&bytes).map_err(CallError::crypto)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateParams {
    initial_device_display_name: String,
    dehydrated_device_key: String,
}

/// `DehydratedDevices.create()` then `DehydratedDevice.keysForUpload(name, key)`: WASM's
/// `PutDehydratedDeviceRequest`, `{ body }`.
pub async fn create_dehydrated_device(machine: &OlmMachine, params: CreateParams) -> CallResult {
    let key = key(params.dehydrated_device_key)?;
    let device = machine
        .dehydrated_devices()
        .create()
        .await
        .map_err(CallError::crypto)?;
    let request = device
        .keys_for_upload(params.initial_device_display_name, &key)
        .await
        .map_err(CallError::crypto)?;
    let mut body = Map::new();
    body.insert("device_id".into(), json!(request.device_id));
    if let Some(name) = &request.initial_device_display_name {
        body.insert("initial_device_display_name".into(), json!(name));
    }
    body.insert(
        "device_data".into(),
        serde_json::to_value(&request.device_data)?,
    );
    body.insert(
        "device_keys".into(),
        serde_json::to_value(&request.device_keys)?,
    );
    if !request.one_time_keys.is_empty() {
        body.insert(
            "one_time_keys".into(),
            serde_json::to_value(&request.one_time_keys)?,
        );
    }
    if !request.fallback_keys.is_empty() {
        body.insert(
            "fallback_keys".into(),
            serde_json::to_value(&request.fallback_keys)?,
        );
    }
    Ok(json!({ "body": serde_json::to_string(&body)? }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RehydrateParams {
    dehydrated_device_key: String,
    device_id: OwnedDeviceId,
    /// The `device_data` of `GET /dehydrated_device`, as a JSON string.
    device_data: String,
}

/// `DehydratedDevices.rehydrate`: holds the device for `receiveRehydratedEvents`, replacing
/// one held before.
pub async fn rehydrate_device(
    machine: &OlmMachine,
    rehydration: &mut Rehydration,
    params: RehydrateParams,
) -> CallResult {
    let key = key(params.dehydrated_device_key)?;
    *rehydration = None;
    let device_data = serde_json::from_str(&params.device_data)?;
    let device = machine
        .dehydrated_devices()
        .rehydrate(&key, &params.device_id, device_data)
        .await
        .map_err(CallError::crypto)?;
    *rehydration = Some((params.device_id, device));
    Ok(Value::Null)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiveEventsParams {
    device_id: OwnedDeviceId,
    to_device_events: String,
    decryption_settings: Option<DecryptionSettingsParams>,
}

fn held<'a>(
    rehydration: &'a Rehydration,
    device_id: &OwnedDeviceId,
) -> CallResult<&'a RehydratedDevice> {
    match rehydration {
        Some((id, device)) if id == device_id => Ok(device),
        _ => Err(CallError::new(
            "UnknownRehydration",
            "no rehydrated device with this ID; call rehydrateDevice first",
        )),
    }
}

/// `RehydratedDevice.receiveEvents`: the WASM `RoomKeyInfo` of each room key imported.
pub async fn receive_rehydrated_events(
    rehydration: &Rehydration,
    params: ReceiveEventsParams,
) -> CallResult {
    let device = held(rehydration, &params.device_id)?;
    let events = serde_json::from_str(&params.to_device_events)?;
    let settings = match params.decryption_settings {
        Some(settings) => DecryptionSettings::try_from(settings)?,
        None => DecryptionSettings {
            sender_device_trust_requirement: TrustRequirement::Untrusted,
        },
    };
    let keys = device.receive_events(events, &settings).await?;
    Ok(Value::Array(
        keys.into_iter().map(events::room_key_info).collect(),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DropParams {
    device_id: OwnedDeviceId,
}

/// `RehydratedDevice.free()`: drops the held device if it is this one.
pub fn drop_rehydrated_device(rehydration: &mut Rehydration, params: DropParams) -> CallResult {
    if held(rehydration, &params.device_id).is_ok() {
        *rehydration = None;
    }
    Ok(Value::Null)
}

/// The cached key as WASM's `toBase64()`, or `null`.
pub async fn get_dehydrated_device_key(machine: &OlmMachine) -> CallResult {
    let key = machine
        .dehydrated_devices()
        .get_dehydrated_device_pickle_key()
        .await
        .map_err(CallError::crypto)?;
    Ok(key.map_or(Value::Null, |key| json!(key.to_base64())))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveKeyParams {
    dehydrated_device_key: String,
}

pub async fn save_dehydrated_device_key(machine: &OlmMachine, params: SaveKeyParams) -> CallResult {
    let key = key(params.dehydrated_device_key)?;
    machine
        .dehydrated_devices()
        .save_dehydrated_device_pickle_key(&key)
        .await
        .map_err(CallError::crypto)?;
    Ok(Value::Null)
}
