//! Room key export and import, and server-side key backup.
//!
//! Ported from matrix-sdk-crypto-wasm v18.9.0 `src/machine.rs`, `src/backup.rs` and
//! `src/types.rs` (Apache-2.0, see `LICENSE-APACHE`). A WASM progress listener cannot cross
//! the JSON surface: the calls return when done, and the shim reports progress from the result.

use std::collections::BTreeMap;

use futures_util::StreamExt;
use matrix_sdk_common::ruma::OwnedRoomId;
use matrix_sdk_crypto::backups::{MegolmV1BackupKey, SignatureState};
use matrix_sdk_crypto::olm::{BackedUpRoomKey, ExportedRoomKey};
use matrix_sdk_crypto::store::types::BackupDecryptionKey;
use matrix_sdk_crypto::types::RoomKeyBackupInfo;
use matrix_sdk_crypto::{OlmMachine, RoomKeyImportResult};
use serde::Deserialize;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::error::{CallError, CallResult};
use crate::requests::RequestType;

/// WASM `RoomKeyImportResult`; `keys()` (room → sender key → session IDs) as plain JSON.
fn import_result(result: RoomKeyImportResult) -> Value {
    json!({
        "importedCount": result.imported_count,
        "totalCount": result.total_count,
        "keys": result.keys,
    })
}

/// Every room key, as WASM's `exportRoomKeys(() => true)`: a JSON string. The WASM predicate
/// cannot cross the surface; matrix-js-sdk passes one that keeps every key.
pub async fn export_room_keys(machine: &OlmMachine) -> CallResult {
    let keys: Vec<ExportedRoomKey> = machine
        .store()
        .export_room_keys_stream(|_| true)
        .await?
        .collect()
        .await;
    Ok(Value::String(serde_json::to_string(&keys)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportExportedParams {
    exported_room_keys: String,
}

pub async fn import_exported_room_keys(
    machine: &OlmMachine,
    params: ImportExportedParams,
) -> CallResult {
    let keys: Vec<ExportedRoomKey> = serde_json::from_str(&params.exported_room_keys)?;
    let result = machine
        .store()
        .import_exported_room_keys(keys, |_, _| {})
        .await?;
    Ok(import_result(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportBackedUpParams {
    /// Room ID → session ID → decrypted session data, as WASM's `Map<RoomId, Map<string, any>>`.
    backed_up_room_keys: BTreeMap<OwnedRoomId, BTreeMap<String, Value>>,
    backup_version: String,
}

/// As in WASM, a session that does not parse is skipped and left out of the counts.
pub async fn import_backed_up_room_keys(
    machine: &OlmMachine,
    params: ImportBackedUpParams,
) -> CallResult {
    let mut keys = Vec::new();
    for (room_id, sessions) in params.backed_up_room_keys {
        for (session_id, data) in sessions {
            if let Ok(key) = serde_json::from_value::<BackedUpRoomKey>(data) {
                keys.push(ExportedRoomKey::from_backed_up_room_key(
                    room_id.clone(),
                    session_id,
                    key,
                ));
            }
        }
    }
    let result = machine
        .store()
        .import_room_keys(keys, Some(&params.backup_version), |_, _| {})
        .await?;
    Ok(import_result(result))
}

/// WASM `RoomKeyCounts`.
pub async fn room_key_counts(machine: &OlmMachine) -> CallResult {
    let counts = machine.backup_machine().room_key_counts().await?;
    Ok(json!({ "total": counts.total, "backedUp": counts.backed_up }))
}

/// WASM `KeysBackupRequest`, or `null` when nothing is left to back up.
pub async fn backup_room_keys(machine: &OlmMachine) -> CallResult {
    let Some((id, request)) = machine.backup_machine().backup().await? else {
        return Ok(Value::Null);
    };
    Ok(json!({
        "id": id.to_string(),
        "type": RequestType::KeysBackup as u8,
        "version": request.version,
        "body": serde_json::to_string(&json!({ "rooms": request.rooms }))?,
    }))
}

/// WASM `BackupKeys`: the private key only as its `decryptionKeyBase64` getter.
pub async fn get_backup_keys(machine: &OlmMachine) -> CallResult {
    let keys = machine.backup_machine().get_backup_keys().await?;
    let mut result = serde_json::Map::new();
    if let Some(key) = keys.decryption_key {
        result.insert("decryptionKeyBase64".into(), json!(key.to_base64()));
    }
    if let Some(version) = keys.backup_version {
        result.insert("backupVersion".into(), json!(version));
    }
    Ok(Value::Object(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveDecryptionKeyParams {
    /// WASM takes a `BackupDecryptionKey`; across the surface it is its `toBase64()`.
    decryption_key_base64: String,
    version: String,
}

pub async fn save_backup_decryption_key(
    machine: &OlmMachine,
    params: SaveDecryptionKeyParams,
) -> CallResult {
    let encoded = Zeroizing::new(params.decryption_key_base64);
    let key = BackupDecryptionKey::from_base64(&encoded).map_err(CallError::crypto)?;
    machine
        .backup_machine()
        .save_decryption_key(Some(key), Some(params.version))
        .await?;
    Ok(Value::Null)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnableBackupParams {
    public_key_base64: String,
    version: String,
}

pub async fn enable_backup_v1(machine: &OlmMachine, params: EnableBackupParams) -> CallResult {
    let key =
        MegolmV1BackupKey::from_base64(&params.public_key_base64).map_err(CallError::crypto)?;
    key.set_version(params.version);
    machine.backup_machine().enable_backup_v1(key).await?;
    Ok(Value::Null)
}

pub async fn is_backup_enabled(machine: &OlmMachine) -> CallResult {
    Ok(json!(machine.backup_machine().enabled().await))
}

pub async fn disable_backup(machine: &OlmMachine) -> CallResult {
    machine.backup_machine().disable_backup().await?;
    Ok(Value::Null)
}

/// WASM `SignatureState`.
fn signature_state(state: SignatureState) -> u8 {
    match state {
        SignatureState::Missing => 0,
        SignatureState::Invalid => 1,
        SignatureState::ValidButNotTrusted => 2,
        SignatureState::ValidAndTrusted => 3,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifyBackupParams {
    backup_info: Value,
}

/// WASM `SignatureVerification`, with its `trusted()` as a field.
pub async fn verify_backup(machine: &OlmMachine, params: VerifyBackupParams) -> CallResult {
    let info: RoomKeyBackupInfo = serde_json::from_value(params.backup_info)?;
    let verification = machine.backup_machine().verify_backup(info, false).await?;
    Ok(json!({
        "deviceState": signature_state(verification.device_signature),
        "userState": signature_state(verification.user_identity_signature),
        "trusted": verification.trusted(),
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignParams {
    message: String,
}

/// WASM `Signatures`, as the object its `asJSON()` serialises.
pub async fn sign(machine: &OlmMachine, params: SignParams) -> CallResult {
    Ok(serde_json::to_value(machine.sign(&params.message).await?)?)
}
