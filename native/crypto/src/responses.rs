//! Incoming homeserver responses, and the results the machine hands back.
//!
//! Ported from matrix-sdk-crypto-wasm v18.9.0 `src/responses.rs`, `src/types.rs`,
//! `src/encryption.rs` and `src/error.rs` (Apache-2.0, see `LICENSE-APACHE`). Field names
//! are the WASM getters'; enums are the WASM enum numbers; a method that takes `strict`
//! (`shieldState`) is returned for both values; `undefined` becomes an absent field.

use std::sync::Arc;

use matrix_sdk_common::deserialized_responses::{
    AlgorithmInfo, DecryptedRoomEvent, EncryptionInfo, ProcessedToDeviceEvent, ShieldState,
    VerificationLevel, VerificationState,
};
use matrix_sdk_common::ruma::{
    DeviceKeyAlgorithm, TransactionId,
    api::{
        IncomingResponseExt,
        client::{
            backup::add_backup_keys::v3::Response as KeysBackupResponse,
            keys::{
                claim_keys::v3::Response as KeysClaimResponse,
                get_keys::v3::Response as KeysQueryResponse,
                upload_keys::v3::Response as KeysUploadResponse,
                upload_signatures::v3::Response as SignatureUploadResponse,
            },
            message::send_message_event::v3::Response as RoomMessageResponse,
            to_device::send_event_to_device::v3::Response as ToDeviceResponse,
        },
    },
    exports::http,
};
use matrix_sdk_crypto::{MegolmError, OlmMachine, vodozemac};
use serde_json::{Map, Value, json};

use crate::error::{CallError, CallResult};
use crate::requests::RequestType;

fn parse<R: IncomingResponseExt>(body: &str) -> CallResult<R> {
    let response = http::Response::builder()
        .status(200)
        .body(body.as_bytes())
        .map_err(CallError::invalid)?;
    R::try_from_http_response(response).map_err(CallError::invalid)
}

pub async fn mark_request_as_sent(
    machine: &OlmMachine,
    request_id: &TransactionId,
    request_type: RequestType,
    body: &str,
) -> CallResult<()> {
    match request_type {
        RequestType::KeysUpload => {
            machine
                .mark_request_as_sent(request_id, &parse::<KeysUploadResponse>(body)?)
                .await
        }
        RequestType::KeysQuery => {
            machine
                .mark_request_as_sent(request_id, &parse::<KeysQueryResponse>(body)?)
                .await
        }
        RequestType::KeysClaim => {
            machine
                .mark_request_as_sent(request_id, &parse::<KeysClaimResponse>(body)?)
                .await
        }
        RequestType::ToDevice => {
            machine
                .mark_request_as_sent(request_id, &parse::<ToDeviceResponse>(body)?)
                .await
        }
        RequestType::SignatureUpload => {
            machine
                .mark_request_as_sent(request_id, &parse::<SignatureUploadResponse>(body)?)
                .await
        }
        RequestType::RoomMessage => {
            machine
                .mark_request_as_sent(request_id, &parse::<RoomMessageResponse>(body)?)
                .await
        }
        RequestType::KeysBackup => {
            machine
                .mark_request_as_sent(request_id, &parse::<KeysBackupResponse>(body)?)
                .await
        }
    }
    .map_err(Into::into)
}

/// WASM `ShieldState`: `color` is `ShieldColor` (Red, Grey, None), `code` is `ShieldStateCode`.
fn shield_state(state: ShieldState) -> Value {
    match state {
        ShieldState::Red { code, message } => {
            json!({ "color": 0, "code": code as u8, "message": message })
        }
        ShieldState::Grey { code, message } => {
            json!({ "color": 1, "code": code as u8, "message": message })
        }
        ShieldState::None => json!({ "color": 2 }),
    }
}

fn shield_states(verification: &VerificationState) -> Value {
    json!({
        "lax": shield_state(verification.to_shield_state_lax()),
        "strict": shield_state(verification.to_shield_state_strict()),
    })
}

fn insert_some(map: &mut Map<String, Value>, name: &str, value: Option<impl ToString>) {
    if let Some(value) = value {
        map.insert(name.to_owned(), Value::String(value.to_string()));
    }
}

/// WASM `EncryptionInfo` for a room event; Olm-encrypted room events are not supported there either.
pub fn room_encryption_info(info: &EncryptionInfo) -> CallResult<Map<String, Value>> {
    let AlgorithmInfo::MegolmV1AesSha2 {
        curve25519_key,
        sender_claimed_keys,
        ..
    } = &info.algorithm_info
    else {
        return Err(CallError::crypto(
            "AlgorithmInfo::OlmV1Curve25519AesSha2 is not applicable for room event EncryptionInfo",
        ));
    };
    let mut map = Map::new();
    map.insert("sender".into(), json!(info.sender));
    insert_some(&mut map, "senderDevice", info.sender_device.as_ref());
    insert_some(
        &mut map,
        "forwarder",
        info.forwarder.as_ref().map(|f| &f.user_id),
    );
    insert_some(
        &mut map,
        "forwarderDevice",
        info.forwarder.as_ref().map(|f| &f.device_id),
    );
    map.insert("senderCurve25519Key".into(), json!(curve25519_key));
    insert_some(
        &mut map,
        "senderClaimedEd25519Key",
        sender_claimed_keys.get(&DeviceKeyAlgorithm::Ed25519),
    );
    map.insert(
        "shieldState".into(),
        shield_states(&info.verification_state),
    );
    Ok(map)
}

/// WASM `DecryptedRoomEvent`: the encryption info flattened next to the decrypted `event`.
pub fn decrypted_room_event(decrypted: &DecryptedRoomEvent) -> CallResult {
    let mut map = room_encryption_info(&decrypted.encryption_info)
        .map_err(|error| megolm_error(DecryptionErrorCode::UnableToDecrypt, error.message, None))?;
    map.insert("event".into(), json!(decrypted.event.json().get()));
    map.insert("forwardingCurve25519KeyChain".into(), json!([]));
    Ok(Value::Object(map))
}

pub fn room_encryption_info_value(info: Arc<EncryptionInfo>) -> CallResult {
    room_encryption_info(&info).map(Value::Object)
}

/// WASM `ProcessedToDeviceEvent`; `type` is `ProcessedToDeviceEventType`.
pub fn processed_to_device_event(event: ProcessedToDeviceEvent) -> Option<Value> {
    Some(match event {
        ProcessedToDeviceEvent::Decrypted {
            raw,
            encryption_info,
        } => {
            let AlgorithmInfo::OlmV1Curve25519AesSha2 {
                curve25519_public_key_base64,
            } = &encryption_info.algorithm_info
            else {
                // Same as WASM: a to-device event with Megolm encryption info is dropped.
                return None;
            };
            let mut info = Map::new();
            info.insert(
                "senderCurve25519Key".into(),
                json!(curve25519_public_key_base64),
            );
            info.insert("sender".into(), json!(encryption_info.sender));
            insert_some(
                &mut info,
                "senderDevice",
                encryption_info.sender_device.as_ref(),
            );
            let verified = matches!(
                encryption_info.verification_state,
                VerificationState::Verified
            );
            info.insert("isSenderVerified".into(), json!(verified));
            json!({ "type": 0, "rawEvent": without_secret(raw.json().get()), "encryptionInfo": info })
        }
        ProcessedToDeviceEvent::UnableToDecrypt {
            encrypted_event,
            utd_info,
        } => {
            json!({ "type": 1, "rawEvent": encrypted_event.json().get(), "utdInfo": { "reason": utd_info.reason as u8 } })
        }
        ProcessedToDeviceEvent::PlainText(raw) => {
            json!({ "type": 2, "rawEvent": raw.json().get() })
        }
        ProcessedToDeviceEvent::Invalid(raw) => json!({ "type": 3, "rawEvent": raw.json().get() }),
    })
}

/// The decrypted to-device events that carry a secret's value in `content.secret`.
const SECRET_EVENT_TYPES: [&str; 2] = ["m.secret.send", "io.element.msc4385.secret.push"];

/// A decrypted event as WASM returns it, except that a secret event loses `content.secret`
/// (unlike WASM): matrix-js-sdk reads secrets from the inbox and would hand the event, value
/// included, to the app as a `ReceivedToDeviceMessage`.
fn without_secret(raw: &str) -> String {
    let Ok(mut event) = serde_json::from_str::<Value>(raw) else {
        return raw.to_owned();
    };
    let is_secret = event["type"]
        .as_str()
        .is_some_and(|kind| SECRET_EVENT_TYPES.contains(&kind));
    match event.get_mut("content").and_then(Value::as_object_mut) {
        Some(content) if is_secret => {
            if let Some(Value::String(secret)) = content.remove("secret") {
                drop(zeroize::Zeroizing::new(secret));
            }
            event.to_string()
        }
        _ => raw.to_owned(),
    }
}

/// WASM `DecryptionErrorCode`, in the same order.
#[derive(Clone, Copy)]
pub enum DecryptionErrorCode {
    MissingRoomKey = 0,
    UnknownMessageIndex = 1,
    UnknownSenderDevice = 3,
    UnsignedSenderDevice = 4,
    SenderIdentityVerificationViolation = 5,
    UnableToDecrypt = 6,
    MismatchedSender = 7,
}

fn megolm_error(
    code: DecryptionErrorCode,
    description: String,
    withheld: Option<&matrix_sdk_common::deserialized_responses::WithheldCode>,
) -> CallError {
    let mut details = Map::new();
    details.insert("code".into(), json!(code as u8));
    details.insert("description".into(), json!(description));
    insert_some(
        &mut details,
        "withheldCode",
        withheld.map(|code| code.as_str()),
    );
    insert_some(&mut details, "maybe_withheld", withheld);
    CallError {
        code: "MegolmDecryptionError",
        message: description,
        details: Some(Value::Object(details)),
    }
}

/// WASM `MegolmDecryptionError::from(MegolmError)`, including its mapping of mismatched
/// identity keys to `UnknownMessageIndex`.
pub fn decryption_error(error: MegolmError) -> CallError {
    use DecryptionErrorCode::*;
    let description = error.to_string();
    let code = match &error {
        MegolmError::MissingRoomKey(withheld) => {
            return megolm_error(MissingRoomKey, description, withheld.as_ref());
        }
        MegolmError::Decryption(vodozemac::megolm::DecryptionError::UnknownMessageIndex(..)) => {
            UnknownMessageIndex
        }
        MegolmError::MismatchedIdentityKeys { .. } => UnknownMessageIndex,
        MegolmError::SenderIdentityNotTrusted(level) => match level {
            VerificationLevel::VerificationViolation => SenderIdentityVerificationViolation,
            VerificationLevel::UnsignedDevice => UnsignedSenderDevice,
            VerificationLevel::None(..) => UnknownSenderDevice,
            VerificationLevel::UnverifiedIdentity => UnableToDecrypt,
            VerificationLevel::MismatchedSender => MismatchedSender,
        },
        _ => UnableToDecrypt,
    };
    megolm_error(code, description, None)
}
