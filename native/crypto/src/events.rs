//! What the WASM bindings report through `register…Callback`, as a queue the host drains with
//! `pollEvents`.
//!
//! Each machine's queue subscribes to the store's broadcast streams when the machine opens.
//! Every call drains the streams into the queue before it returns, so the events a call caused
//! are queued when its response arrives; `pollEvents` drains again and hands over the queue
//! without waiting for the machine. A call takes the queue lock while it holds its machine lock;
//! `pollEvents` takes it holding none. Nothing waits for another lock while holding the queue
//! lock, and it is never held across an await, so a poll cannot deadlock with a call. Event
//! fields follow the WASM classes passed to the callbacks (ported from matrix-sdk-crypto-wasm
//! v18.9.0 `src/store.rs` and `src/machine.rs`, Apache-2.0, see `LICENSE-APACHE`).

use std::collections::{BTreeSet, VecDeque};
use std::task::{Context, Poll, Waker};

use futures_util::stream::{BoxStream, StreamExt};
use matrix_sdk_crypto::OlmMachine;
use matrix_sdk_crypto::store::types::{
    DeviceChanges, IdentityChanges, RoomKeyInfo, RoomKeyWithheldInfo, SecretsInboxItem,
};
use matrix_sdk_crypto::types::EventEncryptionAlgorithm;
use serde_json::{Value, json};

/// Events kept for a host that does not poll; past this, events are counted, not kept.
pub const CAPACITY: usize = if cfg!(test) { 8 } else { 1024 };

/// The store's streams; the broadcast channels behind them hold 16 batches each (10 rounded
/// up by tokio), so every call drains them before it returns.
struct Streams {
    room_keys_received: BoxStream<'static, Result<Vec<RoomKeyInfo>, Lagged>>,
    room_keys_withheld: BoxStream<'static, Vec<RoomKeyWithheldInfo>>,
    identities: BoxStream<'static, (IdentityChanges, DeviceChanges)>,
    secrets: BoxStream<'static, SecretsInboxItem>,
}

/// The broadcast channel skipped this many batches.
struct Lagged(u64);

#[derive(Default)]
pub struct Queue {
    events: VecDeque<Value>,
    dropped: u64,
    /// The streams of the open machine, or of the last one until a new machine opens.
    streams: Option<Streams>,
    /// The verification objects the host holds, until they are done or cancelled.
    pub(crate) watches: crate::verification::Watches,
}

/// WASM `EncryptionAlgorithm`.
pub(crate) fn algorithm(algorithm: EventEncryptionAlgorithm) -> u8 {
    match algorithm {
        EventEncryptionAlgorithm::OlmV1Curve25519AesSha2 => 0,
        EventEncryptionAlgorithm::MegolmV1AesSha2 => 1,
        _ => 2,
    }
}

/// WASM `RoomKeyInfo`.
pub(crate) fn room_key_info(info: RoomKeyInfo) -> Value {
    json!({
        "algorithm": algorithm(info.algorithm),
        "roomId": info.room_id,
        "senderKey": info.sender_key.to_base64(),
        "sessionId": info.session_id,
    })
}

/// WASM `RoomKeyWithheldInfo`.
fn room_key_withheld_info(info: RoomKeyWithheldInfo) -> Value {
    let content = &info.withheld_event.content;
    json!({
        "sender": info.withheld_event.sender,
        "algorithm": algorithm(content.algorithm()),
        "withheldCode": content.withheld_code().as_str(),
        "roomId": info.room_id,
        "sessionId": info.session_id,
    })
}

/// The next item a stream has ready, without waiting: `None` when it has none or has ended.
fn ready<T>(stream: &mut BoxStream<'static, T>) -> Option<T> {
    match stream.poll_next_unpin(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(item) => item,
        Poll::Pending => None,
    }
}

impl Queue {
    /// Listens to a newly opened machine, after taking what the previous one left.
    pub fn subscribe(&mut self, machine: &OlmMachine) {
        self.drain();
        self.watches.clear();
        let store = machine.store();
        self.streams = Some(Streams {
            room_keys_received: store
                .room_keys_received_stream()
                .map(|item| {
                    item.map_err(|error| {
                        let tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(
                            skipped,
                        ) = error;
                        Lagged(skipped)
                    })
                })
                .boxed(),
            room_keys_withheld: store.room_keys_withheld_received_stream().boxed(),
            identities: store.identities_stream_raw().boxed(),
            secrets: store.secrets_stream().boxed(),
        });
    }

    fn push(&mut self, event: Value) {
        if self.events.len() < CAPACITY {
            self.events.push_back(event);
        } else {
            self.dropped += 1;
        }
    }

    /// Moves every ready stream item into the queue.
    pub fn drain(&mut self) {
        let Some(mut streams) = self.streams.take() else {
            return;
        };
        while let Some(item) = ready(&mut streams.room_keys_received) {
            match item {
                Ok(keys) => self.push(json!({
                    "type": "roomKeysReceived",
                    "keys": keys.into_iter().map(room_key_info).collect::<Vec<_>>(),
                })),
                Err(Lagged(skipped)) => self.dropped += skipped,
            }
        }
        while let Some(keys) = ready(&mut streams.room_keys_withheld) {
            self.push(json!({
                "type": "roomKeysWithheld",
                "keys": keys.into_iter().map(room_key_withheld_info).collect::<Vec<_>>(),
            }));
        }
        // WASM reads this stream twice: one callback per changed identity, and one per batch
        // with the users whose devices changed (even none).
        while let Some((identities, devices)) = ready(&mut streams.identities) {
            for identity in identities.new.iter().chain(&identities.changed) {
                self.push(json!({ "type": "userIdentityUpdated", "userId": identity.user_id() }));
            }
            let users: BTreeSet<String> = devices
                .new
                .iter()
                .chain(&devices.changed)
                .chain(&devices.deleted)
                .map(|device| device.user_id().to_string())
                .collect();
            self.push(json!({ "type": "devicesUpdated", "userIds": users }));
        }
        // WASM's callback also gets the value; the host reads it with getSecretsFromInbox, so
        // no secret enters the queue. The item, and with it the value, is wiped on drop.
        while let Some(secret) = ready(&mut streams.secrets) {
            self.push(json!({ "type": "secretReceived", "name": secret.secret_name.as_str() }));
        }
        self.streams = Some(streams);
        for event in self.watches.drain(|changes| ready(changes).is_some()) {
            self.push(event);
        }
    }

    /// Hands over the queued events in order, and how many were dropped after them.
    pub fn take(&mut self) -> Value {
        self.drain();
        let events: Vec<Value> = self.events.drain(..).collect();
        json!({ "events": events, "dropped": std::mem::take(&mut self.dropped) })
    }
}
