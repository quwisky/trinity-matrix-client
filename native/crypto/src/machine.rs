//! One machine per (user, device), and the calls it answers.
//!
//! The calls are ported from matrix-sdk-crypto-wasm v18.9.0 `src/machine.rs` and
//! `src/store.rs` (Apache-2.0, see `LICENSE-APACHE`); argument names are the WASM ones.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use base64::Engine as _;
use matrix_sdk_common::ruma::{
    OneTimeKeyAlgorithm, OwnedDeviceId, OwnedRoomId, OwnedTransactionId, OwnedUserId, UInt,
    api::client::sync::sync_events::DeviceLists, serde::Raw,
};
use matrix_sdk_crypto::{
    DecryptionSettings, EncryptionSettings, EncryptionSyncChanges, OlmMachine, OlmMachineBuilder,
    TrustRequirement,
};
use matrix_sdk_sqlite::SqliteCryptoStore;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, MutexGuard};
use zeroize::Zeroizing;

use crate::backup;
use crate::devices;
use crate::error::{CallError, CallResult};
use crate::events;
use crate::requests::{self, RequestType};
use crate::responses;
use crate::settings::{DecryptionSettingsParams, EncryptionSettingsParams};
use crate::verification;

pub(crate) type MachineKey = (OwnedUserId, OwnedDeviceId);

/// Which store a machine was opened on; the key only as a hash.
#[derive(PartialEq, Eq)]
struct StoreIdentity {
    path: Option<PathBuf>,
    key_hash: Option<[u8; 32]>,
}

struct OpenMachine {
    machine: OlmMachine,
    store: StoreIdentity,
}

/// A device's slot. The machine mutex is held for a whole call, so calls for one device
/// never interleave; `None` means not open (never opened, closed, or dropped after a panic).
/// The event queue outlives a panic (its events are still delivered) but not a `close`.
#[derive(Default)]
struct Device {
    machine: Mutex<Option<OpenMachine>>,
    events: std::sync::Mutex<events::Queue>,
}

type Slot = Arc<Device>;

/// Held only while events move: never across an await, and nothing waits for another lock
/// while holding it (a call takes it while holding the machine lock, never the other way).
fn events(slot: &Slot) -> std::sync::MutexGuard<'_, events::Queue> {
    slot.events
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Lock order: a slot, then the registry. The registry lock is never held while waiting
/// for a slot.
static MACHINES: LazyLock<Mutex<HashMap<MachineKey, Slot>>> = LazyLock::new(Default::default);

const MACHINE_METHODS: &[&str] = &[
    "identityKeys",
    "outgoingRequests",
    "markRequestAsSent",
    "receiveSyncChanges",
    "updateTrackedUsers",
    "getMissingSessions",
    "shareRoomKey",
    "encryptRoomEvent",
    "decryptRoomEvent",
    "getRoomEventEncryptionInfo",
    "exportRoomKeys",
    "importExportedRoomKeys",
    "importBackedUpRoomKeys",
    "roomKeyCounts",
    "backupRoomKeys",
    "getBackupKeys",
    "saveBackupDecryptionKey",
    "enableBackupV1",
    "disableBackup",
    "isBackupEnabled",
    "verifyBackup",
    "sign",
    "getDevice",
    "getUserDevices",
    "getIdentity",
    "setLocalTrust",
    "verifyDevice",
    "encryptToDeviceEvent",
    "verifyIdentity",
    "withdrawVerification",
    "pinCurrentMasterKey",
    "queryKeysForUsers",
    "trackedUsers",
    "markAllTrackedUsersAsDirty",
    "crossSigningStatus",
    "bootstrapCrossSigning",
    "exportCrossSigningKeys",
    "importCrossSigningKeys",
    "getVerificationRequest",
    "getVerificationRequests",
    "getVerification",
    "receiveVerificationEvent",
    "requestDeviceVerification",
    "requestIdentityVerification",
    "verificationRequestContent",
    "acceptVerificationRequest",
    "cancelVerificationRequest",
    "startSas",
    "generateQrCode",
    "scanQrCode",
    "acceptSas",
    "confirmSas",
    "cancelSas",
    "cancelQr",
    "confirmQrScanning",
    "reciprocateQr",
    "qrCodeBytes",
    #[cfg(test)]
    "debugPanic",
    #[cfg(test)]
    "debugWatches",
    #[cfg(test)]
    "debugHold",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    method: String,
    user_id: OwnedUserId,
    device_id: OwnedDeviceId,
    #[serde(default)]
    params: Value,
}

fn params<T: DeserializeOwned>(params: Value) -> CallResult<T> {
    Ok(serde_json::from_value(if params.is_null() {
        json!({})
    } else {
        params
    })?)
}

fn unknown_machine() -> CallError {
    CallError::new("UnknownMachine", "call init for this user and device first")
}

/// Drops the machine if the call holding it panics: the store keeps what was written, and
/// the next `init` reloads from it instead of reusing half-updated memory.
/// The verification watches go too: they hold the dead machine's objects, store and account.
struct DropOnPanic<'a>(MutexGuard<'a, Option<OpenMachine>>, &'a Slot);

impl Drop for DropOnPanic<'_> {
    fn drop(&mut self) {
        if std::thread::panicking() {
            *self.0 = None;
            events(self.1).watches.clear();
        }
    }
}

pub async fn dispatch(request: Request) -> CallResult {
    let key = (request.user_id, request.device_id);
    let method = request.method.as_str();
    match method {
        "init" => return init(key, request.params).await,
        "close" => return close(&key).await,
        "pollEvents" => return poll_events(&key).await,
        _ if !MACHINE_METHODS.contains(&method) => {
            return Err(CallError::new(
                "UnknownMethod",
                format!("unknown method {method}"),
            ));
        }
        _ => {}
    }
    let slot = MACHINES
        .lock()
        .await
        .get(&key)
        .cloned()
        .ok_or_else(unknown_machine)?;
    #[cfg(test)]
    if method == "debugWatches" {
        return Ok(json!(events(&slot).watches.len()));
    }
    let guard = DropOnPanic(lock_slot(&key, &slot).await, &slot);
    let machine = &guard.0.as_ref().ok_or_else(unknown_machine)?.machine;
    let mut found = verification::Found::default();
    let result = run(machine, method, request.params, &mut found).await;
    // Coop budgeting could make a ready event look pending; the drain must see everything.
    tokio::task::unconstrained(async {
        let mut queue = events(&slot);
        queue.drain();
        queue.watches.add(found);
    })
    .await;
    result
}

async fn run(
    machine: &OlmMachine,
    method: &str,
    args: Value,
    found: &mut verification::Found,
) -> CallResult {
    match method {
        "identityKeys" => Ok(identity_keys(machine)),
        "outgoingRequests" => outgoing_requests(machine).await,
        "markRequestAsSent" => mark_request_as_sent(machine, params(args)?).await,
        "receiveSyncChanges" => receive_sync_changes(machine, params(args)?).await,
        "updateTrackedUsers" => update_tracked_users(machine, params(args)?).await,
        "getMissingSessions" => get_missing_sessions(machine, params(args)?).await,
        "shareRoomKey" => share_room_key(machine, params(args)?).await,
        "encryptRoomEvent" => encrypt_room_event(machine, params(args)?).await,
        "decryptRoomEvent" => decrypt_room_event(machine, params(args)?).await,
        "getRoomEventEncryptionInfo" => {
            get_room_event_encryption_info(machine, params(args)?).await
        }
        "exportRoomKeys" => backup::export_room_keys(machine).await,
        "importExportedRoomKeys" => backup::import_exported_room_keys(machine, params(args)?).await,
        "importBackedUpRoomKeys" => {
            backup::import_backed_up_room_keys(machine, params(args)?).await
        }
        "roomKeyCounts" => backup::room_key_counts(machine).await,
        "backupRoomKeys" => backup::backup_room_keys(machine).await,
        "getBackupKeys" => backup::get_backup_keys(machine).await,
        "saveBackupDecryptionKey" => {
            backup::save_backup_decryption_key(machine, params(args)?).await
        }
        "enableBackupV1" => backup::enable_backup_v1(machine, params(args)?).await,
        "disableBackup" => backup::disable_backup(machine).await,
        "isBackupEnabled" => backup::is_backup_enabled(machine).await,
        "verifyBackup" => backup::verify_backup(machine, params(args)?).await,
        "sign" => backup::sign(machine, params(args)?).await,
        "getDevice" => devices::get_device(machine, params(args)?).await,
        "getUserDevices" => devices::get_user_devices(machine, params(args)?).await,
        "getIdentity" => devices::get_identity(machine, params(args)?).await,
        "setLocalTrust" => devices::set_local_trust(machine, params(args)?).await,
        "verifyDevice" => devices::verify_device(machine, params(args)?).await,
        "encryptToDeviceEvent" => devices::encrypt_to_device_event(machine, params(args)?).await,
        "verifyIdentity" => devices::verify_identity(machine, params(args)?).await,
        "withdrawVerification" => devices::withdraw_verification(machine, params(args)?).await,
        "pinCurrentMasterKey" => devices::pin_current_master_key(machine, params(args)?).await,
        "queryKeysForUsers" => devices::query_keys_for_users(machine, params(args)?),
        "trackedUsers" => devices::tracked_users(machine).await,
        "markAllTrackedUsersAsDirty" => devices::mark_all_tracked_users_as_dirty(machine).await,
        "crossSigningStatus" => devices::get_cross_signing_status(machine).await,
        "bootstrapCrossSigning" => devices::bootstrap_cross_signing(machine, params(args)?).await,
        "exportCrossSigningKeys" => devices::export_cross_signing_keys(machine).await,
        "importCrossSigningKeys" => {
            devices::import_cross_signing_keys(machine, params(args)?).await
        }
        "getVerificationRequest" => {
            verification::get_verification_request(machine, params(args)?, found)
        }
        "getVerificationRequests" => {
            verification::get_verification_requests(machine, params(args)?, found)
        }
        "getVerification" => verification::get_verification(machine, params(args)?, found),
        "receiveVerificationEvent" => {
            verification::receive_verification_event(machine, params(args)?).await
        }
        "requestDeviceVerification" => {
            verification::request_device_verification(machine, params(args)?, found).await
        }
        "requestIdentityVerification" => {
            verification::request_identity_verification(machine, params(args)?, found).await
        }
        "verificationRequestContent" => {
            verification::verification_request_content(machine, params(args)?).await
        }
        "acceptVerificationRequest" => {
            verification::accept_verification_request(machine, params(args)?)
        }
        "cancelVerificationRequest" => {
            verification::cancel_verification_request(machine, params(args)?)
        }
        "startSas" => verification::start_sas(machine, params(args)?, found).await,
        "generateQrCode" => verification::generate_qr_code(machine, params(args)?, found).await,
        "scanQrCode" => verification::scan_qr_code(machine, params(args)?, found).await,
        "acceptSas" => verification::accept_sas(machine, params(args)?),
        "confirmSas" => verification::confirm_sas(machine, params(args)?).await,
        "cancelSas" => verification::cancel_sas(machine, params(args)?),
        "cancelQr" => verification::cancel_qr(machine, params(args)?),
        "confirmQrScanning" => verification::confirm_qr_scanning(machine, params(args)?),
        "reciprocateQr" => verification::reciprocate_qr(machine, params(args)?),
        "qrCodeBytes" => verification::qr_code_bytes(machine, params(args)?),
        #[cfg(test)]
        "debugPanic" => panic!("debugPanic called"),
        #[cfg(test)]
        "debugHold" => {
            crate::tests::hooks::hold();
            Ok(Value::Null)
        }
        _ => unreachable!("MACHINE_METHODS lists {method}"),
    }
}

#[derive(Deserialize)]
/// `storeKey` is taken out first (see [`take_store_key`]): kept raw, never parsed by serde.
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InitParams {
    store_path: Option<PathBuf>,
}

const STORE_KEY_ERROR: &str = "storeKey must be 32 bytes, base64-encoded";

/// Takes the raw key out of the `init` parameters before anything else parses them, so it
/// is wiped even when another parameter is invalid.
pub(crate) fn take_store_key(params: &mut Value) -> Option<Value> {
    params.as_object_mut()?.remove("storeKey")
}

/// Takes the key out of the parameters, wiped on every path once it is no longer needed.
fn store_key(value: Option<Value>) -> CallResult<Option<Zeroizing<Vec<u8>>>> {
    let encoded = match value {
        None => return Ok(None),
        Some(Value::String(encoded)) => Zeroizing::new(encoded),
        Some(_) => return Err(CallError::invalid(STORE_KEY_ERROR)),
    };
    let key = base64::engine::general_purpose::STANDARD
        .decode(encoded.as_bytes())
        .map(Zeroizing::new)
        .map_err(|_| CallError::invalid(STORE_KEY_ERROR))?;
    if key.len() != 32 {
        return Err(CallError::invalid(STORE_KEY_ERROR));
    }
    Ok(Some(key))
}

#[cfg(not(test))]
async fn lock_slot<'a>(_key: &MachineKey, slot: &'a Slot) -> MutexGuard<'a, Option<OpenMachine>> {
    slot.machine.lock().await
}

/// Tells the close-race test when a call has to queue behind another one.
#[cfg(test)]
async fn lock_slot<'a>(key: &MachineKey, slot: &'a Slot) -> MutexGuard<'a, Option<OpenMachine>> {
    use std::future::Future as _;
    let mut lock = std::pin::pin!(slot.machine.lock());
    let mut first = true;
    std::future::poll_fn(|cx| {
        let polled = lock.as_mut().poll(cx);
        if std::mem::take(&mut first) && polled.is_pending() {
            crate::tests::hooks::queued(key);
        }
        polled
    })
    .await
}

/// The registered slot for `key`, a new empty one if there is none.
async fn slot(key: &MachineKey) -> Slot {
    MACHINES
        .lock()
        .await
        .entry(key.clone())
        .or_default()
        .clone()
}

/// Removes `slot` from the registry unless another slot has replaced it.
async fn unregister(key: &MachineKey, slot: &Slot) {
    let mut machines = MACHINES.lock().await;
    if machines
        .get(key)
        .is_some_and(|current| Arc::ptr_eq(current, slot))
    {
        machines.remove(key);
    }
}

/// Opens the store (SQLite with a raw key, or memory when `storePath` is absent) and
/// creates or loads the account. Again with the same store it returns the open machine;
/// with another store it fails with `AlreadyOpen`.
async fn init(key: MachineKey, mut raw: Value) -> CallResult {
    let store_key = store_key(take_store_key(&mut raw))?;
    let params: InitParams = params(raw)?;
    if params.store_path.is_some() != store_key.is_some() {
        return Err(CallError::invalid(
            "storePath and storeKey go together: both for SQLite, neither for memory",
        ));
    }
    let identity = StoreIdentity {
        key_hash: store_key
            .as_ref()
            .map(|key| Sha256::digest(key.as_slice()).into()),
        path: params.store_path,
    };
    loop {
        let slot = slot(&key).await;
        let mut guard = lock_slot(&key, &slot).await;
        if let Some(open) = guard.as_ref() {
            if open.store != identity {
                return Err(CallError::new(
                    "AlreadyOpen",
                    "this device is open on another store; close it first",
                ));
            }
            return Ok(describe(&open.machine));
        }
        // A close or a failed init removed this slot while we waited for it.
        if !MACHINES
            .lock()
            .await
            .get(&key)
            .is_some_and(|current| Arc::ptr_eq(current, &slot))
        {
            continue;
        }
        let opened = open(&key, identity.path.as_deref(), store_key.as_deref()).await;
        return match opened {
            Ok(machine) => {
                events(&slot).subscribe(&machine);
                let description = describe(&machine);
                *guard = Some(OpenMachine {
                    machine,
                    store: identity,
                });
                Ok(description)
            }
            Err(error) => {
                unregister(&key, &slot).await;
                Err(error)
            }
        };
    }
}

async fn open(
    key: &MachineKey,
    path: Option<&std::path::Path>,
    store_key: Option<&Vec<u8>>,
) -> CallResult<OlmMachine> {
    let builder = OlmMachineBuilder::new(&key.0, &key.1);
    let builder = match (path, store_key) {
        (Some(path), Some(store_key)) => {
            let store = SqliteCryptoStore::open_with_key(path, Some(store_key))
                .await
                .map_err(|error| CallError::new("StoreError", error))?;
            builder.with_crypto_store(store)
        }
        _ => builder,
    };
    Ok(builder.build().await?)
}

/// Waits for a call in flight, then drops the machine and with it the store connection.
/// Calls queued behind it find no machine.
async fn close(key: &MachineKey) -> CallResult {
    let slot = MACHINES.lock().await.get(key).cloned();
    if let Some(slot) = slot {
        let mut guard = lock_slot(key, &slot).await;
        *guard = None;
        unregister(key, &slot).await;
    }
    Ok(Value::Null)
}

/// The events queued since the last poll, without waiting for a call in flight. Works after a
/// panic dropped the machine, so its last events still arrive; a `close` discards them.
async fn poll_events(key: &MachineKey) -> CallResult {
    let slot = MACHINES
        .lock()
        .await
        .get(key)
        .cloned()
        .ok_or_else(unknown_machine)?;
    Ok(tokio::task::unconstrained(async { events(&slot).take() }).await)
}

fn describe(machine: &OlmMachine) -> Value {
    json!({
        "userId": machine.user_id(),
        "deviceId": machine.device_id(),
        "identityKeys": identity_keys(machine),
        "deviceCreationTimeMs": machine.device_creation_time().get(),
    })
}

fn identity_keys(machine: &OlmMachine) -> Value {
    let keys = machine.identity_keys();
    json!({ "ed25519": keys.ed25519.to_base64(), "curve25519": keys.curve25519.to_base64() })
}

async fn outgoing_requests(machine: &OlmMachine) -> CallResult {
    let requests = machine.outgoing_requests().await?;
    Ok(Value::Array(
        requests
            .iter()
            .map(requests::outgoing)
            .collect::<CallResult<_>>()?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MarkRequestAsSentParams {
    request_id: OwnedTransactionId,
    request_type: u8,
    response: String,
}

async fn mark_request_as_sent(machine: &OlmMachine, params: MarkRequestAsSentParams) -> CallResult {
    let request_type = RequestType::try_from(params.request_type)
        .map_err(|()| CallError::invalid("unknown requestType"))?;
    responses::mark_request_as_sent(machine, &params.request_id, request_type, &params.response)
        .await?;
    Ok(json!(true))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReceiveSyncChangesParams {
    to_device_events: String,
    #[serde(default)]
    changed_devices: DeviceLists,
    one_time_keys_counts: BTreeMap<OneTimeKeyAlgorithm, UInt>,
    unused_fallback_keys: Option<Vec<OneTimeKeyAlgorithm>>,
    decryption_settings: Option<DecryptionSettingsParams>,
}

/// Sync v2 semantics: a missing one-time key count means zero keys on the server.
async fn receive_sync_changes(
    machine: &OlmMachine,
    params: ReceiveSyncChangesParams,
) -> CallResult {
    let decryption_settings = match params.decryption_settings {
        Some(settings) => DecryptionSettings::try_from(settings)?,
        None => DecryptionSettings {
            sender_device_trust_requirement: TrustRequirement::Untrusted,
        },
    };
    let changes = EncryptionSyncChanges {
        to_device_events: serde_json::from_str(&params.to_device_events)?,
        changed_devices: &params.changed_devices,
        one_time_keys_counts: &params.one_time_keys_counts,
        unused_fallback_keys: params.unused_fallback_keys.as_deref(),
        next_batch_token: None,
    };
    // Room key updates are dropped as in WASM; callers learn about them through callbacks.
    let (events, _) = machine
        .receive_sync_changes(changes, &decryption_settings)
        .await?;
    Ok(Value::Array(
        events
            .into_iter()
            .filter_map(responses::processed_to_device_event)
            .collect(),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct UsersParams {
    pub(crate) users: Vec<OwnedUserId>,
}

async fn update_tracked_users(machine: &OlmMachine, params: UsersParams) -> CallResult {
    machine
        .update_tracked_users(params.users.iter().map(AsRef::as_ref))
        .await?;
    Ok(Value::Null)
}

async fn get_missing_sessions(machine: &OlmMachine, params: UsersParams) -> CallResult {
    match machine
        .get_missing_sessions(params.users.iter().map(AsRef::as_ref))
        .await?
    {
        Some((id, request)) => requests::keys_claim(id.to_string(), &request),
        None => Ok(Value::Null),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShareRoomKeyParams {
    room_id: OwnedRoomId,
    users: Vec<OwnedUserId>,
    #[serde(default)]
    encryption_settings: EncryptionSettingsParams,
}

async fn share_room_key(machine: &OlmMachine, params: ShareRoomKeyParams) -> CallResult {
    let settings = EncryptionSettings::try_from(params.encryption_settings)?;
    let shares = machine
        .share_room_key(
            &params.room_id,
            params.users.iter().map(AsRef::as_ref),
            settings,
        )
        .await?;
    let shares = shares
        .iter()
        .map(|request| requests::to_device(request.txn_id.to_string(), request));
    Ok(Value::Array(shares.collect::<CallResult<_>>()?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncryptRoomEventParams {
    room_id: OwnedRoomId,
    event_type: String,
    content: String,
}

/// Returns the encrypted content as a JSON string, dropping the encryption info as WASM does.
async fn encrypt_room_event(machine: &OlmMachine, params: EncryptRoomEventParams) -> CallResult {
    let content = serde_json::from_str(&params.content)?;
    let encrypted = machine
        .encrypt_room_event_raw(&params.room_id, &params.event_type, &content)
        .await?;
    Ok(Value::String(encrypted.content.json().get().to_owned()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DecryptRoomEventParams {
    event: String,
    room_id: OwnedRoomId,
    decryption_settings: DecryptionSettingsParams,
}

async fn decrypt_room_event(machine: &OlmMachine, params: DecryptRoomEventParams) -> CallResult {
    let event: Raw<_> = serde_json::from_str(&params.event)?;
    let settings = DecryptionSettings::try_from(params.decryption_settings)?;
    let decrypted = machine
        .decrypt_room_event(&event, &params.room_id, &settings)
        .await
        .map_err(responses::decryption_error)?;
    responses::decrypted_room_event(&decrypted)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EventParams {
    event: String,
    room_id: OwnedRoomId,
}

async fn get_room_event_encryption_info(machine: &OlmMachine, params: EventParams) -> CallResult {
    let event: Raw<_> = serde_json::from_str(&params.event)?;
    let info = machine
        .get_room_event_encryption_info(&event, &params.room_id)
        .await?;
    responses::room_encryption_info_value(info)
}
