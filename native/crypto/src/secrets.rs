//! The secrets inbox, pushing a secret to the other verified own devices, and the secrets bundle.
//!
//! Ported from matrix-sdk-crypto-wasm v18.9.0 `src/machine.rs` and `src/store.rs` (Apache-2.0,
//! see `LICENSE-APACHE`). Secret values leave the crate only in the answers of
//! `getSecretsFromInbox` and `exportSecretsBundle`, where WASM returns them too; the
//! `secretReceived` event carries the name only (see `events.rs`).

use std::collections::BTreeSet;

use matrix_sdk_common::ruma::events::secret::request::SecretName;
use matrix_sdk_crypto::OlmMachine;
use matrix_sdk_crypto::types::SecretsBundle;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::error::{CallError, CallResult};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretNameParams {
    secret_name: String,
}

/// WASM's `Set<string>` of the inbox values, as a sorted array without repeats.
pub async fn get_secrets_from_inbox(machine: &OlmMachine, params: SecretNameParams) -> CallResult {
    let name = SecretName::from(params.secret_name);
    let secrets = machine.store().get_secrets_from_inbox(&name).await?;
    let values: BTreeSet<&str> = secrets.iter().map(|secret| secret.as_str()).collect();
    Ok(json!(values))
}

pub async fn delete_secrets_from_inbox(
    machine: &OlmMachine,
    params: SecretNameParams,
) -> CallResult {
    let name = SecretName::from(params.secret_name);
    machine.store().delete_secrets_from_inbox(&name).await?;
    Ok(Value::Null)
}

/// Queues an encrypted push to every other verified own device; WASM drops the per-device
/// failures, as does this call.
pub async fn push_secret_to_verified_devices(
    machine: &OlmMachine,
    params: SecretNameParams,
) -> CallResult {
    machine
        .push_secret_to_verified_devices(SecretName::from(params.secret_name))
        .await
        .map_err(CallError::crypto)?;
    Ok(Value::Null)
}

/// What WASM's `SecretsBundle.to_json()` gives: the bundle's serde form, without `backup` when
/// there is none (WASM's is `undefined` there).
pub async fn export_secrets_bundle(machine: &OlmMachine) -> CallResult {
    let bundle = machine
        .store()
        .export_secrets_bundle()
        .await
        .map_err(CallError::crypto)?;
    let mut value = serde_json::to_value(&bundle)?;
    if let Some(fields) = value.as_object_mut()
        && fields.get("backup").is_some_and(Value::is_null)
    {
        fields.remove("backup");
    }
    Ok(value)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportSecretsBundleParams {
    /// What WASM's `SecretsBundle.from_json()` takes; parsed in the call, see below.
    bundle: Value,
}

pub async fn import_secrets_bundle(
    machine: &OlmMachine,
    params: ImportSecretsBundleParams,
) -> CallResult {
    // A fixed message: serde's would quote the value it could not read, which may be a key.
    let bundle: SecretsBundle = serde_json::from_value(params.bundle)
        .map_err(|_| CallError::invalid("invalid secrets bundle"))?;
    machine
        .store()
        .import_secrets_bundle(&bundle)
        .await
        .map_err(CallError::crypto)?;
    Ok(Value::Null)
}
