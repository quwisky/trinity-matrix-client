//! Room key bundles for sharing encrypted history ([MSC4268]) and the rooms waiting for one.
//!
//! Ported from matrix-sdk-crypto-wasm v18.9.0 `src/machine.rs`, `src/attachment.rs` and
//! `src/types.rs` (Apache-2.0, see `LICENSE-APACHE`). Whether a bundle is accepted (its sender's
//! trust, keys for another room) is decided by matrix-sdk-crypto, as in WASM. The bundle data
//! WASM hands back to `receiveRoomKeyBundle` is an object JavaScript cannot forge; here it is
//! read again from the store by room and inviter, and its `url` must still be the one the host
//! downloaded.
//!
//! [MSC4268]: https://github.com/matrix-org/matrix-spec-proposals/pull/4268

use std::collections::HashSet;
use std::io::{Cursor, Read};

use base64::Engine as _;
use matrix_sdk_common::ruma::events::room::EncryptedFile;
use matrix_sdk_common::ruma::{OwnedRoomId, OwnedUserId};
use matrix_sdk_crypto::store::types::{Changes, RoomPendingKeyBundleDetails};
use matrix_sdk_crypto::types::events::room_key_bundle::RoomKeyBundleContent;
use matrix_sdk_crypto::{
    AttachmentDecryptor, AttachmentEncryptor, MediaEncryptionInfo, OlmMachine,
};
use serde::Deserialize;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::error::{CallError, CallResult};
use crate::requests;
use crate::settings::collect_strategy;

const BASE64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomParams {
    room_id: OwnedRoomId,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomInviterParams {
    room_id: OwnedRoomId,
    inviter: OwnedUserId,
}

/// WASM `EncryptedAttachment` (`encryptedData` as base64), or `null` when there is nothing to
/// share.
pub async fn build_room_key_bundle(machine: &OlmMachine, params: RoomParams) -> CallResult {
    let bundle = machine
        .store()
        .build_room_key_bundle(&params.room_id)
        .await?;
    if bundle.is_empty() {
        return Ok(Value::Null);
    }
    let json = Zeroizing::new(serde_json::to_vec(&bundle)?);
    let mut cursor = Cursor::new(json.as_slice());
    let mut encryptor = AttachmentEncryptor::new(&mut cursor);
    let mut encrypted = Vec::new();
    encryptor
        .read_to_end(&mut encrypted)
        .map_err(CallError::crypto)?;
    let info = encryptor.finish();
    Ok(json!({
        "encryptedData": BASE64.encode(encrypted),
        "mediaEncryptionInfo": serde_json::to_string(&info)?,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShareBundleParams {
    user_id: OwnedUserId,
    room_id: OwnedRoomId,
    url: String,
    /// WASM takes it as optional only to spare an assertion; it fails without one.
    media_encryption_info: Option<String>,
    /// The WASM `CollectStrategy` constructor name.
    sharing_strategy: String,
}

/// The to-device requests that tell `userId`'s devices where the bundle is.
pub async fn share_room_key_bundle_data(
    machine: &OlmMachine,
    params: ShareBundleParams,
) -> CallResult {
    let info = params
        .media_encryption_info
        .ok_or_else(|| CallError::crypto("shareRoomKeyBundleData: nullish encryption info"))?;
    let info: MediaEncryptionInfo = serde_json::from_str(&info).map_err(|error| {
        CallError::crypto(format!(
            "Unable to validate room key media encryption info: {error}"
        ))
    })?;
    let strategy = collect_strategy(&params.sharing_strategy)?;
    let bundle_data = RoomKeyBundleContent {
        room_id: params.room_id,
        file: EncryptedFile::new(params.url.into(), info.encryption_info, info.hashes),
    };
    let requests = machine
        .share_room_key_bundle_data(&params.user_id, &strategy, bundle_data)
        .await?;
    Ok(Value::Array(
        requests
            .iter()
            .map(|request| requests::to_device(request.txn_id.to_string(), request))
            .collect::<CallResult<_>>()?,
    ))
}

/// WASM `StoredRoomKeyBundleData`'s getters, or `null`.
pub async fn get_received_room_key_bundle_data(
    machine: &OlmMachine,
    params: RoomInviterParams,
) -> CallResult {
    let Some(data) = machine
        .store()
        .get_received_room_key_bundle_data(&params.room_id, &params.inviter)
        .await?
    else {
        return Ok(Value::Null);
    };
    let info = MediaEncryptionInfo::from(data.bundle_data.file.clone());
    Ok(json!({
        "senderUser": data.sender_user,
        "roomId": data.bundle_data.room_id,
        "url": data.bundle_data.file.url,
        "encryptionInfo": serde_json::to_string(&info)?,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiveBundleParams {
    room_id: OwnedRoomId,
    inviter: OwnedUserId,
    /// The `url` of the bundle data the host downloaded.
    url: String,
    /// The downloaded file, base64.
    encrypted_bundle: String,
}

/// Decrypts the downloaded file and imports its keys, as WASM does.
pub async fn receive_room_key_bundle(
    machine: &OlmMachine,
    params: ReceiveBundleParams,
) -> CallResult {
    let Some(data) = machine
        .store()
        .get_received_room_key_bundle_data(&params.room_id, &params.inviter)
        .await?
    else {
        return Err(CallError::new(
            "UnknownBundle",
            "no room key bundle from this inviter for this room",
        ));
    };
    if data.bundle_data.file.url.as_str() != params.url {
        return Err(CallError::new(
            "StaleObject",
            "a newer room key bundle replaced the one downloaded",
        ));
    }
    let encrypted = BASE64
        .decode(&params.encrypted_bundle)
        .map_err(|_| CallError::invalid("encryptedBundle is not base64"))?;
    let bundle = {
        let mut cursor = Cursor::new(encrypted.as_slice());
        let mut decryptor = AttachmentDecryptor::new(
            &mut cursor,
            MediaEncryptionInfo::from(data.bundle_data.file.clone()),
        )
        .map_err(CallError::crypto)?;
        let mut decrypted = Zeroizing::new(Vec::new());
        decryptor
            .read_to_end(&mut decrypted)
            .map_err(CallError::crypto)?;
        serde_json::from_slice(&decrypted).map_err(CallError::crypto)?
    };
    machine
        .store()
        .receive_room_key_bundle(&data, bundle, |_, _| {})
        .await?;
    Ok(Value::Null)
}

/// WASM `RoomPendingKeyBundleDetails`.
fn pending(details: RoomPendingKeyBundleDetails) -> Value {
    json!({
        "roomId": details.room_id,
        "inviterId": details.inviter,
        "inviteAcceptedAtMillis": details.invite_accepted_at.0,
    })
}

pub async fn get_pending_key_bundle_details_for_room(
    machine: &OlmMachine,
    params: RoomParams,
) -> CallResult {
    Ok(machine
        .store()
        .get_pending_key_bundle_details_for_room(&params.room_id)
        .await?
        .map_or(Value::Null, pending))
}

/// Sorted by room ID; WASM gives the store's order.
pub async fn get_all_rooms_pending_key_bundles(machine: &OlmMachine) -> CallResult {
    let mut rooms = machine.store().get_all_rooms_pending_key_bundles().await?;
    rooms.sort_by(|a, b| a.room_id.cmp(&b.room_id));
    Ok(Value::Array(rooms.into_iter().map(pending).collect()))
}

pub async fn store_room_pending_key_bundle(
    machine: &OlmMachine,
    params: RoomInviterParams,
) -> CallResult {
    machine
        .store()
        .store_room_pending_key_bundle(&params.room_id, &params.inviter)
        .await?;
    Ok(Value::Null)
}

pub async fn clear_room_pending_key_bundle(machine: &OlmMachine, params: RoomParams) -> CallResult {
    machine
        .store()
        .clear_room_pending_key_bundle(&params.room_id)
        .await?;
    Ok(Value::Null)
}

pub async fn has_downloaded_all_room_keys(machine: &OlmMachine, params: RoomParams) -> CallResult {
    Ok(json!(
        machine
            .store()
            .has_downloaded_all_room_keys(&params.room_id)
            .await?
    ))
}

pub async fn set_has_downloaded_all_room_keys(
    machine: &OlmMachine,
    params: RoomParams,
) -> CallResult {
    machine
        .store()
        .save_changes(Changes {
            room_key_backups_fully_downloaded: HashSet::from([params.room_id]),
            ..Default::default()
        })
        .await?;
    Ok(Value::Null)
}
