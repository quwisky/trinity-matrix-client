//! Outgoing requests as wire-ready JSON.
//!
//! Ported from matrix-sdk-crypto-wasm v18.9.0 `src/requests.rs` (Apache-2.0, see
//! `LICENSE-APACHE`). Each request keeps the WASM object's fields: `id`, `type` (the
//! WASM `RequestType` number) and `body`, the HTTP body as a JSON string.

use std::time::Duration;

use matrix_sdk_common::ruma::api::client::keys::{
    claim_keys::v3::Request as KeysClaimRequest, upload_keys::v3::Request as KeysUploadRequest,
    upload_signatures::v3::Request as SignatureUploadRequest,
};
use matrix_sdk_common::ruma::events::MessageLikeEventContent;
use matrix_sdk_crypto::types::requests::{
    AnyOutgoingRequest, KeysQueryRequest, OutgoingRequest, RoomMessageRequest, ToDeviceRequest,
};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::error::CallResult;

/// `RequestType` in matrix-sdk-crypto-wasm, in the same order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestType {
    KeysUpload = 0,
    KeysQuery = 1,
    KeysClaim = 2,
    ToDevice = 3,
    SignatureUpload = 4,
    RoomMessage = 5,
    KeysBackup = 6,
}

impl TryFrom<u8> for RequestType {
    type Error = ();

    fn try_from(value: u8) -> Result<Self, ()> {
        use RequestType::*;
        [
            KeysUpload,
            KeysQuery,
            KeysClaim,
            ToDevice,
            SignatureUpload,
            RoomMessage,
            KeysBackup,
        ]
        .get(usize::from(value))
        .copied()
        .ok_or(())
    }
}

/// Builds a body from `(field, value)` pairs, leaving out the ones that are `None`.
fn body(fields: &[(&str, Option<Value>)]) -> CallResult<String> {
    let map: Map<String, Value> = fields
        .iter()
        .filter_map(|(name, value)| Some(((*name).to_owned(), value.clone()?)))
        .collect();
    Ok(serde_json::to_string(&map)?)
}

fn to_value(value: impl Serialize) -> CallResult<Option<Value>> {
    Ok(Some(serde_json::to_value(value)?))
}

fn timeout_ms(timeout: Option<Duration>) -> Option<Value> {
    timeout.map(|timeout| json!(u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX)))
}

fn keys_upload(id: String, request: &KeysUploadRequest) -> CallResult {
    let body = body(&[
        (
            "device_keys",
            request
                .device_keys
                .as_ref()
                .map(serde_json::to_value)
                .transpose()?,
        ),
        ("one_time_keys", to_value(&request.one_time_keys)?),
        ("fallback_keys", to_value(&request.fallback_keys)?),
    ])?;
    Ok(json!({ "id": id, "type": RequestType::KeysUpload as u8, "body": body }))
}

pub fn keys_query(id: String, request: &KeysQueryRequest) -> CallResult {
    let body = body(&[
        ("timeout", timeout_ms(request.timeout)),
        ("device_keys", to_value(&request.device_keys)?),
    ])?;
    Ok(json!({ "id": id, "type": RequestType::KeysQuery as u8, "body": body }))
}

pub fn keys_claim(id: String, request: &KeysClaimRequest) -> CallResult {
    let body = body(&[
        ("timeout", timeout_ms(request.timeout)),
        ("one_time_keys", to_value(&request.one_time_keys)?),
    ])?;
    Ok(json!({ "id": id, "type": RequestType::KeysClaim as u8, "body": body }))
}

/// `share_room_key` returns bare to-device requests, whose ID is their transaction ID.
pub fn to_device(id: String, request: &ToDeviceRequest) -> CallResult {
    Ok(json!({
        "id": id,
        "type": RequestType::ToDevice as u8,
        "event_type": request.event_type.to_string(),
        "txn_id": request.txn_id.to_string(),
        "body": body(&[("messages", to_value(&request.messages)?)])?,
    }))
}

fn signature_upload(id: String, request: &SignatureUploadRequest) -> CallResult {
    let body = serde_json::to_string(&request.signed_keys)?;
    Ok(json!({ "id": id, "type": RequestType::SignatureUpload as u8, "body": body }))
}

/// A signature upload a call returns directly (`Device.verify`, `bootstrapCrossSigning`):
/// WASM gives it no ID, as it is not marked as sent.
pub fn signature_upload_without_id(request: &SignatureUploadRequest) -> CallResult {
    let body = serde_json::to_string(&request.signed_keys)?;
    Ok(json!({ "type": RequestType::SignatureUpload as u8, "body": body }))
}

pub fn room_message(id: String, request: &RoomMessageRequest) -> CallResult {
    Ok(json!({
        "id": id,
        "type": RequestType::RoomMessage as u8,
        "room_id": request.room_id.to_string(),
        "txn_id": request.txn_id.to_string(),
        "event_type": request.content.event_type().to_string(),
        "body": serde_json::to_string(&request.content)?,
    }))
}

pub fn outgoing(request: &OutgoingRequest) -> CallResult {
    let id = request.request_id().to_string();
    match request.request() {
        AnyOutgoingRequest::KeysUpload(request) => keys_upload(id, request),
        AnyOutgoingRequest::KeysQuery(request) => keys_query(id, request),
        AnyOutgoingRequest::KeysClaim(request) => keys_claim(id, request),
        AnyOutgoingRequest::ToDeviceRequest(request) => to_device(id, request),
        AnyOutgoingRequest::SignatureUpload(request) => signature_upload(id, request),
        AnyOutgoingRequest::RoomMessage(request) => room_message(id, request),
    }
}
