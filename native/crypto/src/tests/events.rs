use std::collections::BTreeSet;
use std::sync::mpsc::channel;
use std::thread::spawn;
use std::time::Duration;

use serde_json::{Value, json};

use super::{Homeserver, hooks, invoke, ok, two_devices_sharing_a_room, unique_user};
use crate::events::CAPACITY;

fn poll(user: &str, device: &str) -> Value {
    ok(user, device, "pollEvents", json!({}))
}

/// The session IDs of the `roomKeysReceived` events in a poll.
fn received_sessions(polled: &Value) -> Vec<String> {
    polled["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["type"] == "roomKeysReceived")
        .flat_map(|event| event["keys"].as_array().unwrap().clone())
        .map(|key| key["sessionId"].as_str().unwrap().to_owned())
        .collect()
}

/// One exported room key from a fresh outbound session of `user` in `room`.
fn exported_key(user: &str, device: &str, room: &str) -> Value {
    ok(
        user,
        device,
        "shareRoomKey",
        json!({ "roomId": room, "users": [user] }),
    );
    let export: Vec<Value> = serde_json::from_str(
        ok(user, device, "exportRoomKeys", json!({}))
            .as_str()
            .unwrap(),
    )
    .unwrap();
    export
        .into_iter()
        .find(|key| key["room_id"] == room)
        .unwrap()
}

fn import(user: &str, device: &str, keys: &[Value]) -> Value {
    ok(
        user,
        device,
        "importExportedRoomKeys",
        json!({ "exportedRoomKeys": Value::from(keys.to_vec()).to_string() }),
    )
}

#[test]
fn a_received_room_key_is_queued_before_the_sync_returns_and_delivered_once() {
    let (alice, bob, room) = (unique_user("alice"), unique_user("bob"), "!ev:localhost");
    let mut server = Homeserver::default();
    two_devices_sharing_a_room(&mut server, &alice, &bob, room);
    assert_eq!(received_sessions(&poll(&bob, "BOB")), Vec::<String>::new());

    server.sync(&bob, "BOB");
    let polled = poll(&bob, "BOB");
    assert_eq!(polled["dropped"], json!(0));
    let event = &polled["events"][0];
    assert_eq!(event["type"], json!("roomKeysReceived"), "{polled}");
    let key = &event["keys"][0];
    assert_eq!(key["roomId"], json!(room));
    assert_eq!(key["algorithm"], json!(1), "MegolmV1AesSha2");
    let alice_keys = ok(&alice, "ALICE", "identityKeys", json!({}));
    assert_eq!(key["senderKey"], alice_keys["curve25519"]);
    assert!(key["sessionId"].is_string());

    assert_eq!(poll(&bob, "BOB"), json!({ "events": [], "dropped": 0 }));
}

#[test]
fn a_withheld_room_key_is_queued() {
    let (alice, bob, room) = (unique_user("alice"), unique_user("bob"), "!wh:localhost");
    let mut server = Homeserver::default();
    two_devices_sharing_a_room(&mut server, &alice, &bob, room);
    server.sync(&bob, "BOB");
    poll(&bob, "BOB");

    let other_room = "!wh-trusted:localhost";
    let shares = ok(
        &alice,
        "ALICE",
        "shareRoomKey",
        json!({
            "roomId": other_room,
            "users": [alice, bob],
            "encryptionSettings": { "sharingStrategy": "onlyTrustedDevices" },
        }),
    );
    for share in shares.as_array().unwrap() {
        server.send(&alice, "ALICE", share);
    }
    server.send_outgoing(&alice, "ALICE");
    server.sync(&bob, "BOB");

    let polled = poll(&bob, "BOB");
    let withheld = polled["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| event["type"] == "roomKeysWithheld")
        .unwrap_or_else(|| panic!("no withheld event: {polled}"));
    let info = &withheld["keys"][0];
    assert_eq!(info["sender"], json!(alice));
    assert_eq!(info["roomId"], json!(other_room));
    assert_eq!(info["withheldCode"], json!("m.unverified"));
    assert_eq!(info["algorithm"], json!(1));
    assert!(info["sessionId"].is_string());
}

#[test]
fn events_from_concurrent_calls_are_neither_lost_nor_repeated() {
    let source = unique_user("source");
    ok(&source, "S", "init", json!({}));
    let keys: Vec<Value> = (0..12)
        .map(|index| exported_key(&source, "S", &format!("!c{index}:localhost")))
        .collect();
    let target = unique_user("target");
    ok(&target, "T", "init", json!({}));

    let importers: Vec<_> = keys
        .chunks(3)
        .map(|chunk| {
            let (target, chunk) = (target.clone(), chunk.to_vec());
            spawn(move || {
                for key in chunk {
                    import(&target, "T", &[key]);
                }
            })
        })
        .collect();
    let mut seen = Vec::new();
    while importers.iter().any(|importer| !importer.is_finished()) {
        seen.extend(received_sessions(&poll(&target, "T")));
    }
    for importer in importers {
        importer.join().unwrap();
    }
    seen.extend(received_sessions(&poll(&target, "T")));

    let expected: BTreeSet<_> = keys
        .iter()
        .map(|key| key["session_id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(seen.len(), expected.len(), "no event twice: {seen:?}");
    assert_eq!(seen.into_iter().collect::<BTreeSet<_>>(), expected);
}

#[test]
fn polling_does_not_wait_for_a_call_in_flight() {
    let _serial = hooks::SERIAL.lock().unwrap();
    let user = unique_user("poll");
    ok(&user, "P", "init", json!({}));
    let (held_tx, held) = channel();
    let (release, release_rx) = channel();
    *hooks::HOLD.lock().unwrap() = Some((held_tx, release_rx));
    let holder = {
        let user = user.clone();
        spawn(move || invoke(&user, "P", "debugHold", json!({})))
    };
    held.recv_timeout(Duration::from_secs(10)).unwrap();

    let (polled_tx, polled) = channel();
    let poller = {
        let user = user.clone();
        spawn(move || polled_tx.send(poll(&user, "P")).unwrap())
    };
    let answer = polled.recv_timeout(Duration::from_secs(10));
    release.send(()).unwrap();
    assert_eq!(answer, Ok(json!({ "events": [], "dropped": 0 })));
    poller.join().unwrap();
    assert_eq!(holder.join().unwrap(), json!({ "result": null }));
}

#[test]
fn events_survive_a_panic_and_a_new_init_listens_again() {
    let source = unique_user("source");
    ok(&source, "S", "init", json!({}));
    let first = exported_key(&source, "S", "!p1:localhost");
    let second = exported_key(&source, "S", "!p2:localhost");
    let user = unique_user("panicky");
    ok(&user, "Q", "init", json!({}));

    import(&user, "Q", std::slice::from_ref(&first));
    let panicked = invoke(&user, "Q", "debugPanic", json!({}));
    assert_eq!(panicked["error"]["code"], json!("Panic"));
    assert_eq!(
        received_sessions(&poll(&user, "Q")),
        vec![first["session_id"].as_str().unwrap().to_owned()]
    );

    ok(&user, "Q", "init", json!({}));
    import(&user, "Q", std::slice::from_ref(&second));
    assert_eq!(
        received_sessions(&poll(&user, "Q")),
        vec![second["session_id"].as_str().unwrap().to_owned()]
    );

    ok(&user, "Q", "close", json!({}));
    let closed = invoke(&user, "Q", "pollEvents", json!({}));
    assert_eq!(closed["error"]["code"], json!("UnknownMachine"));
}

/// More calls than the store's broadcast channels hold (10, which tokio rounds up to 16): only
/// a drain at the end of each call keeps the oldest events.
#[test]
fn a_full_queue_counts_what_it_drops_and_keeps_the_oldest() {
    let source = unique_user("source");
    ok(&source, "S", "init", json!({}));
    let keys: Vec<Value> = (0..CAPACITY + 12)
        .map(|index| exported_key(&source, "S", &format!("!f{index}:localhost")))
        .collect();
    let user = unique_user("slow");
    ok(&user, "F", "init", json!({}));
    for key in &keys {
        import(&user, "F", std::slice::from_ref(key));
    }

    let polled = poll(&user, "F");
    assert_eq!(polled["dropped"], json!(12));
    let kept: Vec<_> = keys[..CAPACITY]
        .iter()
        .map(|key| key["session_id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(received_sessions(&polled), kept);
    assert_eq!(poll(&user, "F"), json!({ "events": [], "dropped": 0 }));
}
