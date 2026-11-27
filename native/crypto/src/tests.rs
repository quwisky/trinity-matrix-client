use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Value, json};

use crate::{call, call_batch};

static NEXT_ID: AtomicUsize = AtomicUsize::new(0);

/// Tests share the process-wide registry, so each one uses its own users.
fn unique_user(name: &str) -> String {
    format!(
        "@{name}{}:localhost",
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn invoke(user: &str, device: &str, method: &str, params: Value) -> Value {
    let request = json!({ "method": method, "userId": user, "deviceId": device, "params": params });
    serde_json::from_str(&call(&request.to_string())).unwrap()
}

fn ok(user: &str, device: &str, method: &str, params: Value) -> Value {
    let response = invoke(user, device, method, params);
    assert!(
        response.get("error").is_none(),
        "{method} failed: {response}"
    );
    response["result"].clone()
}

fn body(request: &Value) -> Value {
    serde_json::from_str(request["body"].as_str().unwrap()).unwrap()
}

const KEYS_UPLOAD: u64 = 0;
const KEYS_QUERY: u64 = 1;
const KEYS_CLAIM: u64 = 2;
const TO_DEVICE: u64 = 3;

/// Just enough of a homeserver for two devices: published keys and to-device queues.
#[derive(Default)]
struct Homeserver {
    device_keys: BTreeMap<String, Value>,
    one_time_keys: BTreeMap<String, Vec<(String, Value)>>,
    inbox: BTreeMap<String, VecDeque<Value>>,
}

impl Homeserver {
    fn respond(&mut self, user: &str, device: &str, request: &Value) -> Value {
        let body = body(request);
        match request["type"].as_u64().unwrap() {
            KEYS_UPLOAD => {
                let me = format!("{user}|{device}");
                if let Some(keys) = body.get("device_keys") {
                    self.device_keys
                        .insert(user.to_owned(), json!({ device: keys }));
                }
                let otks = self.one_time_keys.entry(me).or_default();
                for (id, key) in body["one_time_keys"].as_object().into_iter().flatten() {
                    otks.push((id.clone(), key.clone()));
                }
                json!({ "one_time_key_counts": { "signed_curve25519": otks.len() } })
            }
            KEYS_QUERY => {
                let mut device_keys = serde_json::Map::new();
                for queried in body["device_keys"].as_object().unwrap().keys() {
                    if let Some(keys) = self.device_keys.get(queried) {
                        device_keys.insert(queried.clone(), keys.clone());
                    }
                }
                json!({ "device_keys": device_keys, "failures": {} })
            }
            KEYS_CLAIM => {
                let mut claimed = serde_json::Map::new();
                for (target_user, devices) in body["one_time_keys"].as_object().unwrap() {
                    for target_device in devices.as_object().unwrap().keys() {
                        let queue = self
                            .one_time_keys
                            .get_mut(&format!("{target_user}|{target_device}"));
                        if let Some((id, key)) = queue.and_then(|q| q.pop()) {
                            claimed
                                .insert(target_user.clone(), json!({ target_device: { id: key } }));
                        }
                    }
                }
                json!({ "one_time_keys": claimed, "failures": {} })
            }
            TO_DEVICE => {
                let event_type = request["event_type"].as_str().unwrap();
                for (target_user, devices) in body["messages"].as_object().unwrap() {
                    for (target_device, content) in devices.as_object().unwrap() {
                        let event =
                            json!({ "type": event_type, "sender": user, "content": content });
                        self.inbox
                            .entry(format!("{target_user}|{target_device}"))
                            .or_default()
                            .push_back(event);
                    }
                }
                json!({})
            }
            other => panic!("unexpected request type {other}"),
        }
    }

    fn send_outgoing(&mut self, user: &str, device: &str) {
        let requests = ok(user, device, "outgoingRequests", json!({}));
        for request in requests.as_array().unwrap() {
            self.send(user, device, request);
        }
    }

    fn send(&mut self, user: &str, device: &str, request: &Value) {
        let response = self.respond(user, device, request);
        let marked = ok(
            user,
            device,
            "markRequestAsSent",
            json!({ "requestId": request["id"], "requestType": request["type"], "response": response.to_string() }),
        );
        assert_eq!(marked, json!(true));
    }

    fn sync(&mut self, user: &str, device: &str) -> Value {
        let events: Vec<Value> = self
            .inbox
            .remove(&format!("{user}|{device}"))
            .unwrap_or_default()
            .into();
        ok(
            user,
            device,
            "receiveSyncChanges",
            json!({
                "toDeviceEvents": Value::from(events).to_string(),
                "changedDevices": { "changed": [], "left": [] },
                "oneTimeKeysCounts": { "signed_curve25519": 50 },
            }),
        )
    }
}

fn room_event(sender: &str, room_id: &str, content: &str) -> String {
    json!({
        "type": "m.room.encrypted",
        "event_id": "$event:localhost",
        "sender": sender,
        "origin_server_ts": 1,
        "room_id": room_id,
        "content": serde_json::from_str::<Value>(content).unwrap(),
    })
    .to_string()
}

/// Brings two devices to the point where `alice` has shared a room key with `bob`.
fn two_devices_sharing_a_room(
    server: &mut Homeserver,
    alice: &str,
    bob: &str,
    room: &str,
) -> Value {
    ok(alice, "ALICE", "init", json!({}));
    ok(bob, "BOB", "init", json!({}));
    server.send_outgoing(alice, "ALICE");
    server.send_outgoing(bob, "BOB");

    for (user, device) in [(alice, "ALICE"), (bob, "BOB")] {
        ok(
            user,
            device,
            "updateTrackedUsers",
            json!({ "users": [alice, bob] }),
        );
        server.send_outgoing(user, device);
    }

    let claim = ok(
        alice,
        "ALICE",
        "getMissingSessions",
        json!({ "users": [bob] }),
    );
    assert_eq!(claim["type"], json!(KEYS_CLAIM));
    server.send(alice, "ALICE", &claim);
    assert_eq!(
        ok(
            alice,
            "ALICE",
            "getMissingSessions",
            json!({ "users": [bob] })
        ),
        Value::Null
    );

    let shares = ok(
        alice,
        "ALICE",
        "shareRoomKey",
        json!({ "roomId": room, "users": [alice, bob], "encryptionSettings": {} }),
    );
    for share in shares.as_array().unwrap() {
        server.send(alice, "ALICE", share);
    }
    shares
}

#[test]
fn two_machines_exchange_keys_and_messages_through_the_json_surface() {
    let (alice, bob, room) = (unique_user("alice"), unique_user("bob"), "!room:localhost");
    let mut server = Homeserver::default();
    let shares = two_devices_sharing_a_room(&mut server, &alice, &bob, room);

    let share = &shares[0];
    assert_eq!(share["type"], json!(TO_DEVICE));
    assert_eq!(share["event_type"], json!("m.room.encrypted"));
    assert_eq!(share["id"], share["txn_id"]);

    let received = server.sync(&bob, "BOB");
    let room_key = &received[0];
    assert_eq!(
        room_key["type"],
        json!(0),
        "decrypted to-device event: {received}"
    );
    assert_eq!(room_key["encryptionInfo"]["sender"], json!(alice));

    let plaintext = json!({ "msgtype": "m.text", "body": "hello bob" }).to_string();
    let encrypted = ok(
        &alice,
        "ALICE",
        "encryptRoomEvent",
        json!({ "roomId": room, "eventType": "m.room.message", "content": plaintext }),
    );
    let event = room_event(&alice, room, encrypted.as_str().unwrap());

    let decrypted = ok(
        &bob,
        "BOB",
        "decryptRoomEvent",
        json!({ "event": event, "roomId": room, "decryptionSettings": { "sender_device_trust_requirement": 0 } }),
    );
    let clear: Value = serde_json::from_str(decrypted["event"].as_str().unwrap()).unwrap();
    assert_eq!(clear["content"]["body"], json!("hello bob"));
    assert_eq!(decrypted["sender"], json!(alice));
    assert_eq!(decrypted["senderDevice"], json!("ALICE"));
    let alice_keys = ok(&alice, "ALICE", "identityKeys", json!({}));
    assert_eq!(decrypted["senderCurve25519Key"], alice_keys["curve25519"]);
    assert_eq!(decrypted["senderClaimedEd25519Key"], alice_keys["ed25519"]);
    assert_eq!(decrypted["forwardingCurve25519KeyChain"], json!([]));
    assert!(decrypted["shieldState"]["strict"]["color"].is_u64());

    let info = ok(
        &bob,
        "BOB",
        "getRoomEventEncryptionInfo",
        json!({ "event": event, "roomId": room }),
    );
    assert_eq!(info["sender"], json!(alice));
    assert_eq!(info["shieldState"]["lax"], decrypted["shieldState"]["lax"]);

    ok(&alice, "ALICE", "close", json!({}));
    ok(&bob, "BOB", "close", json!({}));
}

#[test]
fn outgoing_requests_are_wire_ready() {
    let user = unique_user("wire");
    let identity = ok(&user, "WIRE", "init", json!({}));
    assert_eq!(identity["userId"], json!(user));
    assert!(identity["identityKeys"]["ed25519"].is_string());
    assert!(identity["deviceCreationTimeMs"].is_u64());

    let requests = ok(&user, "WIRE", "outgoingRequests", json!({}));
    let upload = &requests[0];
    assert_eq!(upload["type"], json!(KEYS_UPLOAD));
    let upload_body = body(upload);
    assert!(upload_body["device_keys"].is_object(), "{upload_body}");
    assert!(upload_body["one_time_keys"].is_object());

    // A key upload without device keys leaves the field out rather than sending `null`.
    let mut server = Homeserver::default();
    server.send(&user, "WIRE", upload);
    ok(
        &user,
        "WIRE",
        "receiveSyncChanges",
        json!({ "toDeviceEvents": "[]", "changedDevices": {}, "oneTimeKeysCounts": {} }),
    );
    let refill = ok(&user, "WIRE", "outgoingRequests", json!({}));
    let refill = refill
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["type"] == json!(KEYS_UPLOAD))
        .expect("one-time key refill");
    assert!(body(refill).get("device_keys").is_none(), "{refill}");

    ok(
        &user,
        "WIRE",
        "updateTrackedUsers",
        json!({ "users": [user] }),
    );
    let query = ok(&user, "WIRE", "outgoingRequests", json!({}));
    let query = query
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["type"] == json!(KEYS_QUERY))
        .unwrap();
    let timeout = body(query).get("timeout").cloned();
    assert!(
        timeout.is_none_or(|t| t.is_u64()),
        "timeout is a number or absent: {query}"
    );
    ok(&user, "WIRE", "close", json!({}));
}

#[test]
fn a_replayed_room_key_is_not_decrypted_twice() {
    let (alice, bob, room) = (
        unique_user("alice"),
        unique_user("bob"),
        "!replay:localhost",
    );
    let mut server = Homeserver::default();
    two_devices_sharing_a_room(&mut server, &alice, &bob, room);
    let copy = server.inbox[&format!("{bob}|BOB")].clone();

    assert_eq!(server.sync(&bob, "BOB")[0]["type"], json!(0));
    server.inbox.insert(format!("{bob}|BOB"), copy);
    let replayed = server.sync(&bob, "BOB");
    assert_eq!(
        replayed[0]["type"],
        json!(1),
        "replayed message: {replayed}"
    );
    assert!(replayed[0]["utdInfo"]["reason"].is_u64());
}

#[test]
fn decrypting_without_the_room_key_returns_a_megolm_error() {
    let (alice, bob, room) = (unique_user("alice"), unique_user("bob"), "!utd:localhost");
    ok(&alice, "ALICE", "init", json!({}));
    ok(&bob, "BOB", "init", json!({}));
    ok(
        &alice,
        "ALICE",
        "shareRoomKey",
        json!({ "roomId": room, "users": [alice] }),
    );
    let encrypted = ok(
        &alice,
        "ALICE",
        "encryptRoomEvent",
        json!({ "roomId": room, "eventType": "m.room.message", "content": "{}" }),
    );
    let event = room_event(&alice, room, encrypted.as_str().unwrap());

    let response = invoke(
        &bob,
        "BOB",
        "decryptRoomEvent",
        json!({ "event": event, "roomId": room, "decryptionSettings": { "sender_device_trust_requirement": 0 } }),
    );
    assert_eq!(
        response["error"]["code"],
        json!("MegolmDecryptionError"),
        "{response}"
    );
    assert_eq!(
        response["error"]["details"]["code"],
        json!(0),
        "MissingRoomKey: {response}"
    );
}

#[test]
fn malformed_calls_return_errors() {
    let user = unique_user("errors");
    let error = |raw: &str| serde_json::from_str::<Value>(&call(raw)).unwrap()["error"].clone();

    assert_eq!(error("not json")["code"], json!("InvalidRequest"));
    assert_eq!(
        error(r#"{"method":"nope","userId":"@a:b","deviceId":"D"}"#)["code"],
        json!("UnknownMethod")
    );
    assert_eq!(
        invoke(&user, "NONE", "identityKeys", json!({}))["error"]["code"],
        json!("UnknownMachine")
    );
    assert_eq!(
        invoke("not a user id", "D", "init", json!({}))["error"]["code"],
        json!("InvalidRequest")
    );

    ok(&user, "E", "init", json!({}));
    let bad_params = invoke(&user, "E", "encryptRoomEvent", json!({ "roomId": 5 }));
    assert_eq!(bad_params["error"]["code"], json!("InvalidRequest"));
    let bad_settings = invoke(
        &user,
        "E",
        "shareRoomKey",
        json!({ "roomId": "!r:l", "users": [], "encryptionSettings": { "algorithm": 9 } }),
    );
    assert_eq!(
        bad_settings["error"]["code"],
        json!("InvalidRequest"),
        "{bad_settings}"
    );
}

/// A fresh SQLite store directory and a base64 key for it.
fn temp_store(name: &str, key_byte: u8) -> (std::path::PathBuf, String) {
    use base64::Engine as _;
    let dir = std::env::temp_dir().join(format!(
        "trinity-crypto-{name}-{}-{}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    (
        dir,
        base64::engine::general_purpose::STANDARD.encode([key_byte; 32]),
    )
}

#[test]
fn a_panic_drops_the_machine_until_it_is_initialised_again() {
    let user = unique_user("panic");
    let (dir, key) = temp_store("panic", 1);
    let params = json!({ "storePath": dir, "storeKey": key });
    let opened = ok(&user, "P", "init", params.clone());

    let response = invoke(&user, "P", "debugPanic", json!({}));
    assert_eq!(response["error"]["code"], json!("Panic"), "{response}");
    let after = invoke(&user, "P", "identityKeys", json!({}));
    assert_eq!(after["error"]["code"], json!("UnknownMachine"), "{after}");

    let reopened = ok(&user, "P", "init", params);
    assert_eq!(reopened["identityKeys"], opened["identityKeys"]);
    ok(&user, "P", "close", json!({}));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn close_waits_for_the_call_in_flight_and_no_second_machine_opens_meanwhile() {
    use std::thread::{sleep, spawn};
    use std::time::{Duration, Instant};
    let user = unique_user("close");
    let (dir, key) = temp_store("close", 2);
    let params = json!({ "storePath": dir, "storeKey": key });
    let opened = ok(&user, "C", "init", params.clone());
    let run = |method: &'static str, params: Value| {
        let user = user.clone();
        spawn(move || (invoke(&user, "C", method, params), Instant::now()))
    };

    let in_flight = run("debugSleep", json!({ "ms": 500 }));
    sleep(Duration::from_millis(100));
    let closing = run("close", json!({}));
    sleep(Duration::from_millis(100));
    let queued = run("identityKeys", json!({}));
    sleep(Duration::from_millis(100));
    let reopening = run("init", params);

    let (in_flight, in_flight_done) = in_flight.join().unwrap();
    assert_eq!(in_flight, json!({ "result": null }));
    assert_eq!(closing.join().unwrap().0, json!({ "result": null }));
    let queued = queued.join().unwrap().0;
    assert_eq!(queued["error"]["code"], json!("UnknownMachine"), "{queued}");
    // The store is opened again only after the old machine let go of it.
    let (reopened, reopened_done) = reopening.join().unwrap();
    assert!(reopened_done >= in_flight_done);
    assert_eq!(reopened["result"]["identityKeys"], opened["identityKeys"]);
    ok(&user, "C", "close", json!({}));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn init_on_an_open_device_needs_the_same_store() {
    let user = unique_user("again");
    let (dir, key) = temp_store("again", 3);
    let (other_dir, other_key) = temp_store("again-other", 4);
    let params = json!({ "storePath": dir, "storeKey": key });
    let opened = ok(&user, "A", "init", params.clone());
    assert_eq!(
        ok(&user, "A", "init", params)["identityKeys"],
        opened["identityKeys"]
    );

    for other in [
        json!({ "storePath": dir, "storeKey": other_key }),
        json!({ "storePath": other_dir, "storeKey": key }),
        json!({}),
    ] {
        let response = invoke(&user, "A", "init", other);
        assert_eq!(
            response["error"]["code"],
            json!("AlreadyOpen"),
            "{response}"
        );
        assert!(!response.to_string().contains(&other_key));
    }
    ok(&user, "A", "close", json!({}));
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&other_dir);
}

#[test]
fn a_batch_with_a_failing_item_returns_the_others() {
    let user = unique_user("batch");
    ok(&user, "B", "init", json!({}));
    let item =
        |method: &str| json!({ "method": method, "userId": user, "deviceId": "B", "params": {} });
    let batch = json!([item("identityKeys"), item("nope"), item("identityKeys")]);
    let responses: Value = serde_json::from_str(&call_batch(&batch.to_string())).unwrap();

    assert_eq!(responses.as_array().unwrap().len(), 3);
    assert!(responses[0]["result"]["ed25519"].is_string());
    assert_eq!(responses[1]["error"]["code"], json!("UnknownMethod"));
    assert_eq!(responses[2]["result"], responses[0]["result"]);

    let not_a_list: Value = serde_json::from_str(&call_batch("{}")).unwrap();
    assert_eq!(not_a_list["error"]["code"], json!("InvalidRequest"));
}

#[test]
fn the_store_opens_with_a_raw_key_and_keeps_the_account() {
    use base64::Engine as _;
    let base64 = base64::engine::general_purpose::STANDARD;
    let dir = std::env::temp_dir().join(format!("trinity-crypto-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let user = unique_user("store");
    let key = base64.encode([7u8; 32]);
    let params = json!({ "storePath": dir, "storeKey": key });

    let first = ok(&user, "S", "init", params.clone());
    ok(&user, "S", "close", json!({}));
    let second = ok(&user, "S", "init", params);
    assert_eq!(first["identityKeys"], second["identityKeys"]);
    ok(&user, "S", "close", json!({}));

    let wrong_key = base64.encode([8u8; 32]);
    let wrong = invoke(
        &user,
        "S",
        "init",
        json!({ "storePath": dir, "storeKey": wrong_key }),
    );
    assert_eq!(wrong["error"]["code"], json!("StoreError"), "{wrong}");
    assert!(!wrong.to_string().contains(&wrong_key));

    let short_key = base64.encode([9u8; 31]);
    let short = invoke(
        &user,
        "S",
        "init",
        json!({ "storePath": dir, "storeKey": short_key }),
    );
    assert_eq!(short["error"]["code"], json!("InvalidRequest"));
    assert!(!short.to_string().contains(&short_key));
    let missing = invoke(&user, "S", "init", json!({ "storePath": dir }));
    assert_eq!(missing["error"]["code"], json!("InvalidRequest"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_c_abi_round_trips_and_rejects_null() {
    use std::ffi::{CStr, CString};
    let request = CString::new(r#"{"method":"nope","userId":"@a:b","deviceId":"D"}"#).unwrap();
    // SAFETY: valid NUL-terminated strings in, and every returned pointer is freed once.
    unsafe {
        let response = crate::trinity_crypto_call(request.as_ptr());
        assert!(
            CStr::from_ptr(response)
                .to_str()
                .unwrap()
                .contains("UnknownMethod")
        );
        crate::trinity_crypto_free(response);

        let response = crate::trinity_crypto_call_batch(std::ptr::null());
        assert!(
            CStr::from_ptr(response)
                .to_str()
                .unwrap()
                .contains("InvalidRequest")
        );
        crate::trinity_crypto_free(response);
    }
}
