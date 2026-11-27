//! Devices, user identities, trust and cross-signing.
//!
//! Ported from matrix-sdk-crypto-wasm v18.9.0 `src/device.rs`, `src/identities.rs`,
//! `src/machine.rs` and `src/requests.rs` (Apache-2.0, see `LICENSE-APACHE`). A `Device` or
//! identity is returned as a snapshot of every getter matrix-js-sdk reads; a method on the
//! WASM object is a call that takes the object's keys (user ID, device ID) and resolves it
//! from the machine again. Enums are the WASM enum numbers.

use std::time::Duration;

use matrix_sdk_common::ruma::{OwnedDeviceId, OwnedUserId};
use matrix_sdk_crypto::store::types::CrossSigningKeyExport;
use matrix_sdk_crypto::{
    CrossSigningStatus, Device, LocalTrust, OlmMachine, SecretImportError, UserIdentity,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::error::{CallError, CallResult};
use crate::events::algorithm;
use crate::machine::UsersParams;
use crate::requests;
use crate::settings::collect_strategy;

/// How long `getIdentity` waits for a key query in flight, as WASM does.
const IDENTITY_TIMEOUT: Duration = Duration::from_secs(1);

/// WASM `LocalTrust`.
fn local_trust(trust: LocalTrust) -> u8 {
    match trust {
        LocalTrust::Verified => 0,
        LocalTrust::BlackListed => 1,
        LocalTrust::Ignored => 2,
        LocalTrust::Unset => 3,
    }
}

fn local_trust_from(value: u8) -> CallResult<LocalTrust> {
    Ok(match value {
        0 => LocalTrust::Verified,
        1 => LocalTrust::BlackListed,
        2 => LocalTrust::Ignored,
        3 => LocalTrust::Unset,
        _ => return Err(CallError::invalid("unknown localState")),
    })
}

/// WASM `Device`'s getters. `signatures` is `{ signer: { keyId: MaybeSignature } }`, each
/// with `isValid` and `signature` (base64) or `invalidSignatureSource`.
fn device(device: &Device) -> Value {
    let keys: Map<String, Value> = device
        .keys()
        .iter()
        .map(|(id, key)| (id.to_string(), json!(key.to_base64())))
        .collect();
    let signatures: Map<String, Value> = device
        .signatures()
        .clone()
        .into_iter()
        .map(|(signer, signatures)| {
            let signatures: Map<String, Value> = signatures
                .into_iter()
                .map(|(id, signature)| {
                    let maybe = match signature {
                        Ok(signature) => {
                            json!({ "isValid": true, "signature": signature.to_base64() })
                        }
                        Err(invalid) => {
                            json!({ "isValid": false, "invalidSignatureSource": invalid.source })
                        }
                    };
                    (id.to_string(), maybe)
                })
                .collect();
            (signer.to_string(), Value::Object(signatures))
        })
        .collect();
    let mut snapshot = json!({
        "userId": device.user_id(),
        "deviceId": device.device_id(),
        "keys": keys,
        "algorithms": device.algorithms().iter().cloned().map(algorithm).collect::<Vec<_>>(),
        "signatures": signatures,
        "isVerified": device.is_verified(),
        "isCrossSigningTrusted": device.is_cross_signing_trusted(),
        "isCrossSignedByOwner": device.is_cross_signed_by_owner(),
        "isLocallyTrusted": device.is_locally_trusted(),
        "isBlacklisted": device.is_blacklisted(),
        "localTrustState": local_trust(device.local_trust_state()),
        "isDeleted": device.is_deleted(),
        "isDehydrated": device.is_dehydrated(),
    });
    if let Some(name) = device.display_name() {
        snapshot["displayName"] = json!(name);
    }
    snapshot
}

/// WASM `OwnUserIdentity` or `OtherUserIdentity`, told apart by `kind` (`own` | `other`).
/// The keys are JSON strings, as the WASM getters return them.
fn identity(identity: &UserIdentity) -> CallResult {
    let mut snapshot = json!({
        "isVerified": identity.is_verified(),
        "wasPreviouslyVerified": identity.was_previously_verified(),
        "hasVerificationViolation": identity.has_verification_violation(),
    });
    match identity {
        UserIdentity::Own(own) => {
            snapshot["kind"] = json!("own");
            snapshot["masterKey"] = json!(serde_json::to_string(own.master_key().as_ref())?);
            snapshot["selfSigningKey"] =
                json!(serde_json::to_string(own.self_signing_key().as_ref())?);
            snapshot["userSigningKey"] =
                json!(serde_json::to_string(own.user_signing_key().as_ref())?);
        }
        UserIdentity::Other(other) => {
            snapshot["kind"] = json!("other");
            snapshot["masterKey"] = json!(serde_json::to_string(other.master_key().as_ref())?);
            snapshot["selfSigningKey"] =
                json!(serde_json::to_string(other.self_signing_key().as_ref())?);
            snapshot["identityNeedsUserApproval"] = json!(other.identity_needs_user_approval());
        }
    }
    Ok(snapshot)
}

fn timeout(secs: Option<f64>) -> CallResult<Option<Duration>> {
    secs.map(|secs| {
        Duration::try_from_secs_f64(secs).map_err(|_| CallError::invalid("invalid timeoutSecs"))
    })
    .transpose()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceParams {
    user_id: OwnedUserId,
    device_id: OwnedDeviceId,
    timeout_secs: Option<f64>,
}

/// The device snapshot, or `null` when the device is unknown.
pub async fn get_device(machine: &OlmMachine, params: DeviceParams) -> CallResult {
    let found = machine
        .get_device(
            &params.user_id,
            &params.device_id,
            timeout(params.timeout_secs)?,
        )
        .await?;
    Ok(found.as_ref().map_or(Value::Null, device))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserParams {
    user_id: OwnedUserId,
    timeout_secs: Option<f64>,
}

/// WASM `UserDevices.devices()`: the device snapshots, in no particular order.
pub async fn get_user_devices(machine: &OlmMachine, params: UserParams) -> CallResult {
    let devices = machine
        .get_user_devices(&params.user_id, timeout(params.timeout_secs)?)
        .await?;
    Ok(Value::Array(
        devices.devices().map(|it| device(&it)).collect(),
    ))
}

/// The identity snapshot, or `null` when the user has no known cross-signing identity.
pub async fn get_identity(machine: &OlmMachine, params: IdentityParams) -> CallResult {
    match machine
        .get_identity(&params.user_id, Some(IDENTITY_TIMEOUT))
        .await?
    {
        Some(found) => identity(&found),
        None => Ok(Value::Null),
    }
}

/// Refuses a call on an object whose key is no longer `expected`: the host's object wraps an
/// older one (a device that logged in again under its ID, an identity whose master key changed).
fn check_key(what: &str, expected: Option<&str>, current: Option<String>) -> CallResult<()> {
    match expected {
        Some(expected) if current.as_deref() != Some(expected) => Err(CallError::new(
            "StaleObject",
            format!("the {what} changed since the host read it; read it again"),
        )),
        _ => Ok(()),
    }
}

/// The device a `Device` method acts on, resolved again from the machine and, given the
/// ed25519 key from the host's snapshot, refused when that is no longer its key.
async fn resolve_device(
    machine: &OlmMachine,
    user: &OwnedUserId,
    id: &OwnedDeviceId,
    ed25519_key: Option<&str>,
) -> CallResult<Device> {
    let device = machine
        .get_device(user, id, None)
        .await?
        .ok_or_else(|| CallError::new("UnknownDevice", format!("unknown device {user} {id}")))?;
    check_key(
        "device",
        ed25519_key,
        device.ed25519_key().map(|key| key.to_base64()),
    )?;
    Ok(device)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetLocalTrustParams {
    user_id: OwnedUserId,
    device_id: OwnedDeviceId,
    local_state: u8,
    ed25519_key: Option<String>,
}

/// `Device.setLocalTrust`.
pub async fn set_local_trust(machine: &OlmMachine, params: SetLocalTrustParams) -> CallResult {
    let state = local_trust_from(params.local_state)?;
    resolve_device(
        machine,
        &params.user_id,
        &params.device_id,
        params.ed25519_key.as_deref(),
    )
    .await?
    .set_local_trust(state)
    .await?;
    Ok(Value::Null)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceKeyParams {
    user_id: OwnedUserId,
    device_id: OwnedDeviceId,
    ed25519_key: Option<String>,
}

/// `Device.verify`: a `SignatureUploadRequest` without an ID, as WASM returns it.
pub async fn verify_device(machine: &OlmMachine, params: DeviceKeyParams) -> CallResult {
    let request = resolve_device(
        machine,
        &params.user_id,
        &params.device_id,
        params.ed25519_key.as_deref(),
    )
    .await?
    .verify()
    .await
    .map_err(CallError::crypto)?;
    requests::signature_upload_without_id(&request)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EncryptToDeviceParams {
    user_id: OwnedUserId,
    device_id: OwnedDeviceId,
    event_type: String,
    /// WASM takes a JavaScript object, so this is JSON, not a JSON string.
    content: Value,
    /// A WASM `CollectStrategy` constructor name; all devices when absent, as in WASM.
    share_strategy: Option<String>,
}

/// `Device.encryptToDeviceEvent`: the encrypted content as a JSON string.
pub async fn encrypt_to_device_event(
    machine: &OlmMachine,
    params: EncryptToDeviceParams,
) -> CallResult {
    let strategy = params.share_strategy.as_deref().map_or(
        Ok(matrix_sdk_crypto::CollectStrategy::AllDevices),
        collect_strategy,
    )?;
    let encrypted = resolve_device(machine, &params.user_id, &params.device_id, None)
        .await?
        .encrypt_event_raw(&params.event_type, &params.content, strategy)
        .await?;
    Ok(Value::String(encrypted.json().get().to_owned()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityParams {
    user_id: OwnedUserId,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityMethodParams {
    user_id: OwnedUserId,
    /// The public master key (base64) of the identity the host's object wraps.
    master_key: Option<String>,
}

/// The identity a method acts on, resolved again from the machine (without waiting, as the
/// WASM object already exists when its method runs) and, given the master key from the host's
/// snapshot, refused when that is no longer its master key.
async fn resolve_identity(
    machine: &OlmMachine,
    params: &IdentityMethodParams,
) -> CallResult<UserIdentity> {
    let user = &params.user_id;
    let identity = machine
        .get_identity(user, None)
        .await?
        .ok_or_else(|| CallError::new("UnknownIdentity", format!("unknown identity {user}")))?;
    let current = match &identity {
        UserIdentity::Own(own) => own.master_key().get_first_key(),
        UserIdentity::Other(other) => other.master_key().get_first_key(),
    };
    check_key(
        "identity",
        params.master_key.as_deref(),
        current.map(|key| key.to_base64()),
    )?;
    Ok(identity)
}

/// `OwnUserIdentity.verify` or `OtherUserIdentity.verify`: a `SignatureUploadRequest`
/// without an ID.
pub async fn verify_identity(machine: &OlmMachine, params: IdentityMethodParams) -> CallResult {
    let request = match resolve_identity(machine, &params).await? {
        UserIdentity::Own(own) => own.verify().await,
        UserIdentity::Other(other) => other.verify().await,
    }
    .map_err(CallError::crypto)?;
    requests::signature_upload_without_id(&request)
}

/// `withdrawVerification` on either identity.
pub async fn withdraw_verification(
    machine: &OlmMachine,
    params: IdentityMethodParams,
) -> CallResult {
    match resolve_identity(machine, &params).await? {
        UserIdentity::Own(own) => own.withdraw_verification().await?,
        UserIdentity::Other(other) => other.withdraw_verification().await?,
    }
    Ok(Value::Null)
}

/// `OtherUserIdentity.pinCurrentMasterKey`; WASM's `OwnUserIdentity` has no such method.
pub async fn pin_current_master_key(
    machine: &OlmMachine,
    params: IdentityMethodParams,
) -> CallResult {
    match resolve_identity(machine, &params).await? {
        UserIdentity::Other(other) => other.pin_current_master_key().await?,
        UserIdentity::Own(_) => {
            return Err(CallError::invalid(
                "the own identity has no pinCurrentMasterKey",
            ));
        }
    }
    Ok(Value::Null)
}

/// A `KeysQueryRequest` to send now; its response goes to `markRequestAsSent`.
pub fn query_keys_for_users(machine: &OlmMachine, params: UsersParams) -> CallResult {
    let (id, request) = machine.query_keys_for_users(params.users.iter().map(AsRef::as_ref));
    requests::keys_query(id.to_string(), &request)
}

/// The tracked users, sorted (WASM returns a `Set`).
pub async fn tracked_users(machine: &OlmMachine) -> CallResult {
    let mut users: Vec<String> = machine
        .tracked_users()
        .await?
        .into_iter()
        .map(String::from)
        .collect();
    users.sort();
    Ok(json!(users))
}

/// Marks every tracked user's device list as outdated, so the next `outgoingRequests` queries
/// them all again.
pub async fn mark_all_tracked_users_as_dirty(machine: &OlmMachine) -> CallResult {
    machine.mark_all_tracked_users_as_dirty().await?;
    Ok(Value::Null)
}

/// WASM `CrossSigningStatus`.
fn cross_signing_status(status: CrossSigningStatus) -> Value {
    json!({
        "hasMaster": status.has_master,
        "hasSelfSigning": status.has_self_signing,
        "hasUserSigning": status.has_user_signing,
    })
}

pub async fn get_cross_signing_status(machine: &OlmMachine) -> CallResult {
    Ok(cross_signing_status(machine.cross_signing_status().await))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BootstrapParams {
    reset: bool,
}

/// WASM `CrossSigningBootstrapRequests`: `uploadKeysRequest` (absent when the device keys are
/// already uploaded), `uploadSigningKeysRequest` (`{ body }`, for `/keys/device_signing/upload`)
/// and `uploadSignaturesRequest` (without an ID).
pub async fn bootstrap_cross_signing(machine: &OlmMachine, params: BootstrapParams) -> CallResult {
    let requests = machine
        .bootstrap_cross_signing(params.reset)
        .await
        .map_err(CallError::crypto)?;
    let signing = &requests.upload_signing_keys_req;
    let signing_body = serde_json::to_string(&json!({
        "master_key": signing.master_key,
        "self_signing_key": signing.self_signing_key,
        "user_signing_key": signing.user_signing_key,
    }))?;
    let mut result = json!({
        "uploadSigningKeysRequest": { "body": signing_body },
        "uploadSignaturesRequest":
            requests::signature_upload_without_id(&requests.upload_signatures_req)?,
    });
    if let Some(upload) = &requests.upload_keys_req {
        result["uploadKeysRequest"] = requests::outgoing(upload)?;
    }
    Ok(result)
}

/// WASM `CrossSigningKeyExport`, or `null` without private keys. The private keys leave the
/// crate only here, under the WASM getter names (`self_signing_key` is snake case there too).
pub async fn export_cross_signing_keys(machine: &OlmMachine) -> CallResult {
    let Some(export) = machine.export_cross_signing_keys().await? else {
        return Ok(Value::Null);
    };
    let mut result = Map::new();
    for (name, key) in [
        ("masterKey", &export.master_key),
        ("self_signing_key", &export.self_signing_key),
        ("userSigningKey", &export.user_signing_key),
    ] {
        if let Some(key) = key {
            result.insert(name.to_owned(), json!(key));
        }
    }
    Ok(Value::Object(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportCrossSigningParams {
    master_key: Option<String>,
    self_signing_key: Option<String>,
    user_signing_key: Option<String>,
}

/// `importCrossSigningKeys(masterKey, selfSigningKey, userSigningKey)`: the resulting
/// `CrossSigningStatus`. The keys are wiped when the export is dropped.
pub async fn import_cross_signing_keys(
    machine: &OlmMachine,
    params: ImportCrossSigningParams,
) -> CallResult {
    let export = CrossSigningKeyExport {
        master_key: params.master_key,
        self_signing_key: params.self_signing_key,
        user_signing_key: params.user_signing_key,
    };
    let status = machine
        .import_cross_signing_keys(export)
        .await
        .map_err(|error| match error {
            // Unlike WASM, a fixed message: the decoder's names a character of the key and its
            // offset.
            SecretImportError::Key { name, .. } => {
                CallError::crypto(format!("Error while importing {name}: invalid key"))
            }
            error => CallError::crypto(error),
        })?;
    Ok(cross_signing_status(status))
}
