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
use tokio::sync::Mutex;
use zeroize::Zeroizing;

use crate::error::{CallError, CallResult};
use crate::requests::{self, RequestType};
use crate::responses;
use crate::settings::{DecryptionSettingsParams, EncryptionSettingsParams};

type MachineKey = (OwnedUserId, OwnedDeviceId);

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

/// A device's slot. Its mutex is held for a whole call, so calls for one device never
/// interleave; `None` means not open (never opened, closed, or dropped after a panic).
type Slot = Arc<Mutex<Option<OpenMachine>>>;

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
    #[cfg(test)]
    "debugPanic",
    #[cfg(test)]
    "debugSleep",
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
struct DropOnPanic<'a>(tokio::sync::MutexGuard<'a, Option<OpenMachine>>);

impl Drop for DropOnPanic<'_> {
    fn drop(&mut self) {
        if std::thread::panicking() {
            *self.0 = None;
        }
    }
}

pub async fn dispatch(request: Request) -> CallResult {
    let key = (request.user_id, request.device_id);
    let method = request.method.as_str();
    match method {
        "init" => return init(key, params(request.params)?).await,
        "close" => return close(&key).await,
        _ if !MACHINE_METHODS.contains(&method) => {
            return Err(CallError::new(
                "UnknownMethod",
                format!("unknown method {method}"),
            ));
        }
        _ => {}
    }
    let slot = MACHINES.lock().await.get(&key).cloned();
    let guard = DropOnPanic(slot.as_ref().ok_or_else(unknown_machine)?.lock().await);
    let machine = &guard.0.as_ref().ok_or_else(unknown_machine)?.machine;
    let args = request.params;
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
        #[cfg(test)]
        "debugPanic" => panic!("debugPanic called"),
        #[cfg(test)]
        "debugSleep" => {
            let ms = args["ms"].as_u64().unwrap_or(0);
            std::thread::sleep(std::time::Duration::from_millis(ms));
            Ok(Value::Null)
        }
        _ => unreachable!("MACHINE_METHODS lists {method}"),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InitParams {
    store_path: Option<PathBuf>,
    /// Kept as a raw value: a typed field would quote a malformed key in its error.
    store_key: Option<Value>,
}

const STORE_KEY_ERROR: &str = "storeKey must be 32 bytes, base64-encoded";

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
async fn init(key: MachineKey, params: InitParams) -> CallResult {
    let store_key = store_key(params.store_key)?;
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
        let mut guard = slot.lock().await;
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
        let mut guard = slot.lock().await;
        *guard = None;
        unregister(key, &slot).await;
    }
    Ok(Value::Null)
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
struct UsersParams {
    users: Vec<OwnedUserId>,
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
