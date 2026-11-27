//! Interactive verification: verification requests, SAS (emoji and decimals) and QR codes.
//!
//! Ported from matrix-sdk-crypto-wasm v18.9.0 `src/verification.rs`, `src/device.rs`,
//! `src/identities.rs` and `src/machine.rs` (Apache-2.0, see `LICENSE-APACHE`). A
//! `VerificationRequest`, `Sas` or `Qr` is returned as a snapshot of every getter; a method on
//! the WASM object is a call that takes the other user's ID and the flow ID and resolves the
//! object from the machine again. Enums are the WASM enum numbers; cancel codes are strings.
//!
//! Change events: every object the crate hands to the host is watched (its upstream change
//! stream) until it is done or cancelled; see [`Watches`].

use std::collections::BTreeMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use futures_util::stream::{BoxStream, StreamExt};
use matrix_sdk_common::ruma::events::key::verification::VerificationMethod as Method;
use matrix_sdk_common::ruma::events::{AnyMessageLikeEvent, AnySyncMessageLikeEvent};
use matrix_sdk_common::ruma::{OwnedDeviceId, OwnedEventId, OwnedRoomId, OwnedUserId};
use matrix_sdk_crypto::matrix_sdk_qrcode::QrVerificationData;
use matrix_sdk_crypto::types::requests::OutgoingVerificationRequest;
use matrix_sdk_crypto::{
    CancelInfo, OlmMachine, QrVerification, QrVerificationState, Sas, UserIdentity, Verification,
    VerificationRequest, VerificationRequestState,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::devices::{check_key, resolve_device};
use crate::error::{CallError, CallResult};
use crate::requests;

/// WASM `VerificationMethod`.
fn method_from(value: u8) -> CallResult<Method> {
    Ok(match value {
        0 => Method::SasV1,
        1 => Method::QrCodeScanV1,
        2 => Method::QrCodeShowV1,
        3 => Method::ReciprocateV1,
        _ => {
            return Err(CallError::invalid(format!(
                "Unknown verification method (received `{value}`)"
            )));
        }
    })
}

/// WASM's getters throw on a method they do not know; the snapshot leaves it out instead.
fn methods(methods: Option<Vec<Method>>) -> Option<Vec<u8>> {
    methods.map(|methods| {
        methods
            .into_iter()
            .filter_map(|method| match method {
                Method::SasV1 => Some(0),
                Method::QrCodeScanV1 => Some(1),
                Method::QrCodeShowV1 => Some(2),
                Method::ReciprocateV1 => Some(3),
                _ => None,
            })
            .collect()
    })
}

fn methods_from(values: Option<Vec<u8>>) -> CallResult<Option<Vec<Method>>> {
    values
        .map(|values| values.into_iter().map(method_from).collect())
        .transpose()
}

/// WASM `VerificationRequestPhase`.
fn phase(state: &VerificationRequestState) -> u8 {
    match state {
        VerificationRequestState::Created { .. } => 0,
        VerificationRequestState::Requested { .. } => 1,
        VerificationRequestState::Ready { .. } => 2,
        VerificationRequestState::Transitioned { .. } => 3,
        VerificationRequestState::Done => 4,
        VerificationRequestState::Cancelled(_) => 5,
    }
}

/// WASM `QrState`.
fn qr_state(state: &QrVerificationState) -> u8 {
    match state {
        QrVerificationState::Started => 0,
        QrVerificationState::Scanned => 1,
        QrVerificationState::Confirmed => 2,
        QrVerificationState::Reciprocated => 3,
        QrVerificationState::Done { .. } => 4,
        QrVerificationState::Cancelled(_) => 5,
    }
}

/// WASM `CancelInfo` (the getter really is `cancelledbyUs`).
fn cancel_info(info: CancelInfo) -> Value {
    json!({
        "cancelCode": info.cancel_code().as_str(),
        "reason": info.reason(),
        "cancelledbyUs": info.cancelled_by_us(),
    })
}

fn insert(snapshot: &mut Value, name: &str, value: Option<Value>) {
    if let Some(value) = value {
        snapshot[name] = value;
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis()
}

/// WASM `VerificationRequest`'s getters. `timeRemainingMillis` is `expiresAtMs` (milliseconds
/// since the epoch) minus now, at least 0; `verification` is what `getVerification` returns.
pub(crate) fn request(request: &VerificationRequest) -> Value {
    let state = request.state();
    let mut snapshot = json!({
        "kind": "request",
        "ownUserId": request.own_user_id(),
        "otherUserId": request.other_user(),
        "flowId": request.flow_id().as_str(),
        "phase": phase(&state),
        "isPassive": request.is_passive(),
        "isReady": request.is_ready(),
        "isDone": request.is_done(),
        "isCancelled": request.is_cancelled(),
        "isSelfVerification": request.is_self_verification(),
        "weStarted": request.we_started(),
        "timedOut": request.timed_out(),
        "expiresAtMs": now_ms() + request.time_remaining().as_millis(),
    });
    insert(
        &mut snapshot,
        "otherDeviceId",
        request.other_device_id().map(|id| json!(id)),
    );
    insert(
        &mut snapshot,
        "roomId",
        request.room_id().map(|id| json!(id)),
    );
    insert(
        &mut snapshot,
        "cancelInfo",
        request.cancel_info().map(cancel_info),
    );
    insert(
        &mut snapshot,
        "theirSupportedMethods",
        methods(request.their_supported_methods()).map(|it| json!(it)),
    );
    insert(
        &mut snapshot,
        "ourSupportedMethods",
        methods(request.our_supported_methods()).map(|it| json!(it)),
    );
    if let VerificationRequestState::Transitioned { verification, .. } = state {
        insert(
            &mut snapshot,
            "verification",
            verification_snapshot(&verification),
        );
    }
    snapshot
}

/// WASM `Sas`'s getters. Only what WASM shows leaves: emoji, their indices and decimals.
fn sas(sas: &Sas) -> Value {
    let mut snapshot = json!({
        "kind": "sas",
        "userId": sas.user_id(),
        "deviceId": sas.device_id(),
        "otherUserId": sas.other_user_id(),
        "otherDeviceId": sas.other_device_id(),
        "flowId": sas.flow_id().as_str(),
        "supportsEmoji": sas.supports_emoji(),
        "startedFromRequest": sas.started_from_request(),
        "isSelfVerification": sas.is_self_verification(),
        "haveWeConfirmed": sas.have_we_confirmed(),
        "hasBeenAccepted": sas.has_been_accepted(),
        "weStarted": sas.we_started(),
        "timedOut": sas.timed_out(),
        "canBePresented": sas.can_be_presented(),
        "isDone": sas.is_done(),
        "isCancelled": sas.is_cancelled(),
    });
    insert(&mut snapshot, "roomId", sas.room_id().map(|id| json!(id)));
    insert(
        &mut snapshot,
        "cancelInfo",
        sas.cancel_info().map(cancel_info),
    );
    insert(
        &mut snapshot,
        "emoji",
        sas.emoji().map(|emoji| {
            json!(
                emoji
                    .iter()
                    .map(|it| json!({ "symbol": it.symbol, "description": it.description }))
                    .collect::<Vec<_>>()
            )
        }),
    );
    insert(
        &mut snapshot,
        "emojiIndex",
        sas.emoji_index().map(|it| json!(it)),
    );
    insert(
        &mut snapshot,
        "decimals",
        sas.decimals().map(|(a, b, c)| json!([a, b, c])),
    );
    snapshot
}

/// WASM `Qr`'s getters. The bytes (which hold the shared secret) are not part of it: they
/// leave only through `qrCodeBytes`, as through WASM's `toBytes`.
fn qr(qr: &QrVerification) -> Value {
    let mut snapshot = json!({
        "kind": "qr",
        "state": qr_state(&qr.state()),
        "hasBeenScanned": qr.has_been_scanned(),
        "hasBeenConfirmed": qr.has_been_confirmed(),
        "userId": qr.user_id(),
        "otherUserId": qr.other_user_id(),
        "otherDeviceId": qr.other_device_id(),
        "weStarted": qr.we_started(),
        "isDone": qr.is_done(),
        "isCancelled": qr.is_cancelled(),
        "isSelfVerification": qr.is_self_verification(),
        "reciprocated": qr.reciprocated(),
        "flowId": qr.flow_id().as_str(),
    });
    insert(&mut snapshot, "roomId", qr.room_id().map(|id| json!(id)));
    insert(
        &mut snapshot,
        "cancelInfo",
        qr.cancel_info().map(cancel_info),
    );
    snapshot
}

/// A `Sas` or `Qr` snapshot; `None` for a kind WASM does not know either.
pub(crate) fn verification_snapshot(verification: &Verification) -> Option<Value> {
    match verification {
        Verification::SasV1(it) => Some(sas(it)),
        Verification::QrV1(it) => Some(qr(it)),
        _ => None,
    }
}

/// WASM `OutgoingVerificationRequest`: a `ToDeviceRequest` or a `RoomMessageRequest`.
fn outgoing(request: &OutgoingVerificationRequest) -> CallResult {
    let id = request.request_id().to_string();
    match request {
        OutgoingVerificationRequest::ToDevice(request) => requests::to_device(id, request),
        OutgoingVerificationRequest::InRoom(request) => requests::room_message(id, request),
    }
}

fn outgoing_or_null(request: Option<OutgoingVerificationRequest>) -> CallResult {
    request.as_ref().map_or(Ok(Value::Null), outgoing)
}

/// The objects a call handed to the host, so their changes become events.
#[derive(Default)]
pub struct Found(Vec<Watched>);

enum Watched {
    Request(VerificationRequest),
    Verification(Verification),
}

impl Found {
    fn request(&mut self, request: &VerificationRequest) {
        self.0.push(Watched::Request(request.clone()));
    }

    fn verification(&mut self, verification: Verification) {
        self.0.push(Watched::Verification(verification));
    }
}

fn unknown(what: &str, user: &OwnedUserId, flow: &str) -> CallError {
    CallError::new(
        "UnknownVerification",
        format!("no {what} with {user} for flow {flow}"),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowParams {
    user_id: OwnedUserId,
    flow_id: String,
}

fn resolve_request(machine: &OlmMachine, params: &FlowParams) -> CallResult<VerificationRequest> {
    machine
        .get_verification_request(&params.user_id, &params.flow_id)
        .ok_or_else(|| unknown("verification request", &params.user_id, &params.flow_id))
}

/// The SAS of a flow; a flow that has no SAS (any more) is refused, never confused with a QR.
fn resolve_sas(machine: &OlmMachine, user: &OwnedUserId, flow: &str) -> CallResult<Sas> {
    match machine.get_verification(user, flow) {
        Some(Verification::SasV1(sas)) => Ok(*sas),
        _ => Err(unknown("SAS verification", user, flow)),
    }
}

fn resolve_qr(machine: &OlmMachine, params: &FlowParams) -> CallResult<QrVerification> {
    match machine.get_verification(&params.user_id, &params.flow_id) {
        Some(Verification::QrV1(qr)) => Ok(*qr),
        _ => Err(unknown("QR verification", &params.user_id, &params.flow_id)),
    }
}

/// `getVerificationRequest`: the request snapshot, or `null`.
pub fn get_verification_request(
    machine: &OlmMachine,
    params: FlowParams,
    found: &mut Found,
) -> CallResult {
    Ok(
        match machine.get_verification_request(&params.user_id, &params.flow_id) {
            Some(it) => {
                found.request(&it);
                request(&it)
            }
            None => Value::Null,
        },
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserParams {
    user_id: OwnedUserId,
}

/// `getVerificationRequests`: the request snapshots, sorted by flow ID (WASM: no order).
pub fn get_verification_requests(
    machine: &OlmMachine,
    params: UserParams,
    found: &mut Found,
) -> CallResult {
    let mut requests = machine.get_verification_requests(&params.user_id);
    requests.sort_by(|a, b| a.flow_id().as_str().cmp(b.flow_id().as_str()));
    Ok(Value::Array(
        requests
            .iter()
            .map(|it| {
                found.request(it);
                request(it)
            })
            .collect(),
    ))
}

/// The `Sas` or `Qr` snapshot of a flow (`OlmMachine.getVerification`), or `null`.
pub fn get_verification(machine: &OlmMachine, params: FlowParams, found: &mut Found) -> CallResult {
    Ok(
        match machine.get_verification(&params.user_id, &params.flow_id) {
            Some(verification) => {
                let snapshot = verification_snapshot(&verification);
                found.verification(verification);
                snapshot.unwrap_or(Value::Null)
            }
            None => Value::Null,
        },
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiveEventParams {
    /// The event as a JSON string, as WASM takes it.
    event: String,
    room_id: OwnedRoomId,
}

/// `receiveVerificationEvent`: an in-room verification event.
pub async fn receive_verification_event(
    machine: &OlmMachine,
    params: ReceiveEventParams,
) -> CallResult {
    let event: AnySyncMessageLikeEvent = serde_json::from_str(&params.event)?;
    let event: AnyMessageLikeEvent = event.into_full_event(params.room_id);
    machine.receive_verification_event(&event).await?;
    Ok(Value::Null)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceRequestParams {
    user_id: OwnedUserId,
    device_id: OwnedDeviceId,
    methods: Option<Vec<u8>>,
    ed25519_key: Option<String>,
}

/// `Device.requestVerification`: `[request, toDeviceRequest]`.
pub async fn request_device_verification(
    machine: &OlmMachine,
    params: DeviceRequestParams,
    found: &mut Found,
) -> CallResult {
    let methods = methods_from(params.methods)?;
    let device = resolve_device(
        machine,
        &params.user_id,
        &params.device_id,
        params.ed25519_key.as_deref(),
    )
    .await?;
    let (created, outgoing_request) = match methods {
        Some(methods) => device.request_verification_with_methods(methods),
        None => device.request_verification(),
    };
    found.request(&created);
    Ok(json!([request(&created), outgoing(&outgoing_request)?]))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityRequestParams {
    user_id: OwnedUserId,
    /// The public master key (base64) of the identity the host's object wraps.
    master_key: Option<String>,
    methods: Option<Vec<u8>>,
    /// `OtherUserIdentity.requestVerification` only: the DM and the request event sent there.
    room_id: Option<OwnedRoomId>,
    request_event_id: Option<OwnedEventId>,
}

async fn resolve_identity(
    machine: &OlmMachine,
    user: &OwnedUserId,
    master_key: Option<&str>,
) -> CallResult<UserIdentity> {
    let identity = machine
        .get_identity(user, None)
        .await?
        .ok_or_else(|| CallError::new("UnknownIdentity", format!("unknown identity {user}")))?;
    let current = match &identity {
        UserIdentity::Own(own) => own.master_key().get_first_key(),
        UserIdentity::Other(other) => other.master_key().get_first_key(),
    };
    check_key("identity", master_key, current.map(|key| key.to_base64()))?;
    Ok(identity)
}

/// `OwnUserIdentity.requestVerification(methods)`: `[request, toDeviceRequest]`;
/// `OtherUserIdentity.requestVerification(roomId, requestEventId, methods)`: the request.
pub async fn request_identity_verification(
    machine: &OlmMachine,
    params: IdentityRequestParams,
    found: &mut Found,
) -> CallResult {
    let methods = methods_from(params.methods)?;
    match resolve_identity(machine, &params.user_id, params.master_key.as_deref()).await? {
        UserIdentity::Own(own) => {
            if params.room_id.is_some() || params.request_event_id.is_some() {
                return Err(CallError::invalid(
                    "the own identity is verified to-device: no roomId or requestEventId",
                ));
            }
            let (created, outgoing_request) = match methods {
                Some(methods) => own.request_verification_with_methods(methods).await?,
                None => own.request_verification().await?,
            };
            found.request(&created);
            Ok(json!([request(&created), outgoing(&outgoing_request)?]))
        }
        UserIdentity::Other(other) => {
            let (Some(room_id), Some(event_id)) = (params.room_id, params.request_event_id) else {
                return Err(CallError::invalid(
                    "another user is verified in a room: roomId and requestEventId are required",
                ));
            };
            let created = other.request_verification(&room_id, &event_id, methods);
            found.request(&created);
            Ok(request(&created))
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestContentParams {
    user_id: OwnedUserId,
    master_key: Option<String>,
    methods: Option<Vec<u8>>,
}

/// `OtherUserIdentity.verificationRequestContent`: the `m.room.message` content as a JSON
/// string; WASM's `OwnUserIdentity` has no such method.
pub async fn verification_request_content(
    machine: &OlmMachine,
    params: RequestContentParams,
) -> CallResult {
    let methods = methods_from(params.methods)?;
    match resolve_identity(machine, &params.user_id, params.master_key.as_deref()).await? {
        UserIdentity::Other(other) => Ok(Value::String(serde_json::to_string(
            &other.verification_request_content(methods),
        )?)),
        UserIdentity::Own(_) => Err(CallError::invalid(
            "the own identity has no verificationRequestContent",
        )),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptParams {
    user_id: OwnedUserId,
    flow_id: String,
    /// `acceptWithMethods(methods)`; `accept()` when absent.
    methods: Option<Vec<u8>>,
}

/// `VerificationRequest.acceptWithMethods` or `accept`: the ready event to send, or `null`.
pub fn accept_verification_request(machine: &OlmMachine, params: AcceptParams) -> CallResult {
    let methods = methods_from(params.methods)?;
    let found = resolve_request(
        machine,
        &FlowParams {
            user_id: params.user_id,
            flow_id: params.flow_id,
        },
    )?;
    outgoing_or_null(match methods {
        Some(methods) => found.accept_with_methods(methods),
        None => found.accept(),
    })
}

/// `VerificationRequest.cancel`: the cancellation to send, or `null`.
pub fn cancel_verification_request(machine: &OlmMachine, params: FlowParams) -> CallResult {
    outgoing_or_null(resolve_request(machine, &params)?.cancel())
}

/// `VerificationRequest.startSas`: `[sas, request]`, or `null`.
pub async fn start_sas(machine: &OlmMachine, params: FlowParams, found: &mut Found) -> CallResult {
    match resolve_request(machine, &params)?.start_sas().await? {
        Some((started, outgoing_request)) => {
            let snapshot = sas(&started);
            found.verification(Verification::SasV1(Box::new(started)));
            Ok(json!([snapshot, outgoing(&outgoing_request)?]))
        }
        None => Ok(Value::Null),
    }
}

/// `VerificationRequest.generateQrCode`: the `Qr` snapshot, or `null`.
pub async fn generate_qr_code(
    machine: &OlmMachine,
    params: FlowParams,
    found: &mut Found,
) -> CallResult {
    match resolve_request(machine, &params)?
        .generate_qr_code()
        .await?
    {
        Some(generated) => {
            let snapshot = qr(&generated);
            found.verification(Verification::QrV1(Box::new(generated)));
            Ok(snapshot)
        }
        None => Ok(Value::Null),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanParams {
    user_id: OwnedUserId,
    flow_id: String,
    /// The scanned QR code's bytes, base64 (`QrCodeScan.fromBytes` in WASM).
    data: String,
}

/// `VerificationRequest.scanQrCode(QrCodeScan.fromBytes(data))`: the `Qr` snapshot, or `null`.
pub async fn scan_qr_code(
    machine: &OlmMachine,
    params: ScanParams,
    found: &mut Found,
) -> CallResult {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&params.data)
        .map_err(|_| CallError::invalid("data must be base64"))?;
    let data = QrVerificationData::from_bytes(bytes).map_err(CallError::crypto)?;
    let found_request = resolve_request(
        machine,
        &FlowParams {
            user_id: params.user_id,
            flow_id: params.flow_id,
        },
    )?;
    match found_request
        .scan_qr_code(data)
        .await
        .map_err(CallError::crypto)?
    {
        Some(scanned) => {
            let snapshot = qr(&scanned);
            found.verification(Verification::QrV1(Box::new(scanned)));
            Ok(snapshot)
        }
        None => Ok(Value::Null),
    }
}

/// `Sas.accept`: the accept event to send, or `null`.
pub fn accept_sas(machine: &OlmMachine, params: FlowParams) -> CallResult {
    outgoing_or_null(resolve_sas(machine, &params.user_id, &params.flow_id)?.accept())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfirmSasParams {
    user_id: OwnedUserId,
    flow_id: String,
    /// The decimals the host showed the user: refused with `StaleObject` when the SAS on this
    /// flow now shows others (another flow under the same ID).
    decimals: Option<[u16; 3]>,
}

/// `Sas.confirm`: the requests to send, a signature upload (without an ID) last.
pub async fn confirm_sas(machine: &OlmMachine, params: ConfirmSasParams) -> CallResult {
    let found = resolve_sas(machine, &params.user_id, &params.flow_id)?;
    // Without decimals (cancelled, or keys not exchanged yet) confirming does nothing upstream.
    if let (Some(expected), Some(current)) = (params.decimals, found.decimals())
        && current != (expected[0], expected[1], expected[2])
    {
        return Err(CallError::new(
            "StaleObject",
            "the SAS on this flow is not the one the host showed; read it again",
        ));
    }
    let (outgoing_requests, signature_upload) = found.confirm().await?;
    let mut answer = outgoing_requests
        .iter()
        .map(outgoing)
        .collect::<CallResult<Vec<_>>>()?;
    if let Some(upload) = signature_upload {
        answer.push(requests::signature_upload_without_id(&upload)?);
    }
    Ok(Value::Array(answer))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelParams {
    user_id: OwnedUserId,
    flow_id: String,
    /// `cancelWithCode(code)`; `cancel()` (`m.user`) when absent.
    code: Option<String>,
}

/// `Sas.cancel` or `Sas.cancelWithCode`: the cancellation to send, or `null`.
pub fn cancel_sas(machine: &OlmMachine, params: CancelParams) -> CallResult {
    let found = resolve_sas(machine, &params.user_id, &params.flow_id)?;
    outgoing_or_null(match params.code {
        Some(code) => found.cancel_with_code(code.as_str().into()),
        None => found.cancel(),
    })
}

/// `Qr.cancel` or `Qr.cancelWithCode`: the cancellation to send, or `null`.
pub fn cancel_qr(machine: &OlmMachine, params: CancelParams) -> CallResult {
    let found = resolve_qr(
        machine,
        &FlowParams {
            user_id: params.user_id,
            flow_id: params.flow_id,
        },
    )?;
    outgoing_or_null(match params.code {
        Some(code) => found.cancel_with_code(code.as_str().into()),
        None => found.cancel(),
    })
}

/// `Qr.confirmScanning`: the done event to send, or `null`.
pub fn confirm_qr_scanning(machine: &OlmMachine, params: FlowParams) -> CallResult {
    outgoing_or_null(resolve_qr(machine, &params)?.confirm_scanning())
}

/// `Qr.reciprocate`: the start event (`m.reciprocate.v1`) to send, or `null`.
pub fn reciprocate_qr(machine: &OlmMachine, params: FlowParams) -> CallResult {
    outgoing_or_null(resolve_qr(machine, &params)?.reciprocate())
}

/// `Qr.toBytes`: the QR code's bytes, base64. They hold the flow's shared secret, as in WASM.
pub fn qr_code_bytes(machine: &OlmMachine, params: FlowParams) -> CallResult {
    let bytes = resolve_qr(machine, &params)?
        .to_bytes()
        .map_err(CallError::crypto)?;
    Ok(json!(
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// The change streams of the verification objects the host holds, keyed by (other user,
/// flow ID, whether it is the request): a stand-in for WASM's `registerChangesCallback`.
///
/// An object is watched from the first answer that hands it to the host, and dropped once it
/// is done or cancelled (an object that is already done or cancelled is never watched). Each
/// key is watched once: a later answer with the same object does not subscribe again. When a
/// request changes, the `Sas` or `Qr` it now holds is watched afresh, because a flow can
/// switch from QR to SAS, or replace its SAS, under the same key. Opening a machine (also
/// after a panic) clears the watches: verifications live only in the machine's memory.
#[derive(Default)]
pub struct Watches(BTreeMap<(String, String, bool), Watch>);

struct Watch {
    object: Watched,
    changes: BoxStream<'static, ()>,
}

fn request_final(request: &VerificationRequest) -> bool {
    request.is_done() || request.is_cancelled()
}

fn verification_final(verification: &Verification) -> bool {
    verification.is_done() || verification.is_cancelled()
}

fn watch(object: Watched) -> Option<((String, String, bool), Watch)> {
    let (key, changes) = match &object {
        Watched::Request(request) => {
            if request_final(request) {
                return None;
            }
            (
                (
                    request.other_user().to_string(),
                    request.flow_id().as_str().to_owned(),
                    true,
                ),
                request.changes().map(|_| ()).boxed(),
            )
        }
        Watched::Verification(verification) => {
            if verification_final(verification) {
                return None;
            }
            let changes = match verification {
                Verification::SasV1(sas) => sas.changes().map(|_| ()).boxed(),
                Verification::QrV1(qr) => qr.changes().map(|_| ()).boxed(),
                _ => return None,
            };
            (
                (
                    verification.other_user().to_string(),
                    verification.flow_id().to_owned(),
                    false,
                ),
                changes,
            )
        }
    };
    Some((key, Watch { object, changes }))
}

impl Watches {
    /// Watches what a call handed to the host, unless it is watched already.
    pub fn add(&mut self, found: Found) {
        for object in found.0 {
            if let Some((key, watch)) = watch(object) {
                self.0.entry(key).or_insert(watch);
            }
        }
    }

    pub fn clear(&mut self) {
        self.0.clear();
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// One event per object that changed, with its snapshot now. The `Sas` and `Qr` streams go
    /// first, so watching a request's new verification afresh cannot skip one of their items.
    pub fn drain(
        &mut self,
        mut ready: impl FnMut(&mut BoxStream<'static, ()>) -> bool,
    ) -> Vec<Value> {
        let mut events = Vec::new();
        for is_request in [false, true] {
            let keys: Vec<_> = self
                .0
                .keys()
                .filter(|key| key.2 == is_request)
                .cloned()
                .collect();
            for key in keys {
                let Some(entry) = self.0.get_mut(&key) else {
                    continue;
                };
                let mut changed = false;
                while ready(&mut entry.changes) {
                    changed = true;
                }
                if !changed {
                    continue;
                }
                match &entry.object {
                    Watched::Verification(verification) => {
                        if let Some(snapshot) = verification_snapshot(verification) {
                            events.push(
                                json!({ "type": "verificationChanged", "verification": snapshot }),
                            );
                        }
                        if verification_final(verification) {
                            self.0.remove(&key);
                        }
                    }
                    Watched::Request(found) => {
                        let found = found.clone();
                        events.push(
                            json!({ "type": "verificationRequestChanged", "request": request(&found) }),
                        );
                        if request_final(&found) {
                            self.0.remove(&key);
                        }
                        if let VerificationRequestState::Transitioned { verification, .. } =
                            found.state()
                            && let Some((key, watch)) = watch(Watched::Verification(verification))
                        {
                            self.0.insert(key, watch);
                        }
                    }
                }
            }
        }
        events
    }
}
