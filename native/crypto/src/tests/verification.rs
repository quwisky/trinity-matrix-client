use serde_json::{Value, json};

use super::{Homeserver, invoke, ok, unique_user};

fn error_code(response: &Value) -> &str {
    response["error"]["code"].as_str().unwrap_or("none")
}

/// Two users who know each other's devices; `bob` has a cross-signing identity.
fn two_users(server: &mut Homeserver, name: &str) -> (String, String) {
    let (alice, bob) = (
        unique_user(&format!("{name}a")),
        unique_user(&format!("{name}b")),
    );
    ok(&alice, "ALICE", "init", json!({}));
    ok(&bob, "BOB", "init", json!({}));
    server.send_outgoing(&alice, "ALICE");
    server.send_outgoing(&bob, "BOB");
    let requests = ok(
        &bob,
        "BOB",
        "bootstrapCrossSigning",
        json!({ "reset": true }),
    );
    server.upload_signing_keys(&bob, &requests["uploadSigningKeysRequest"]);
    for (user, device, other) in [(&alice, "ALICE", &bob), (&bob, "BOB", &alice)] {
        let query = ok(
            user,
            device,
            "queryKeysForUsers",
            json!({ "users": [other] }),
        );
        server.send(user, device, &query);
    }
    (alice, bob)
}

/// Sends what both devices have queued and syncs them until nothing moves.
fn settle(server: &mut Homeserver, devices: [(&str, &str); 2]) {
    for _ in 0..5 {
        for (user, device) in devices {
            server.send_outgoing(user, device);
            server.sync(user, device);
        }
    }
}

fn watched(user: &str, device: &str) -> Value {
    ok(user, device, "debugWatches", json!({}))
}

fn events_of(user: &str, device: &str, kind: &str) -> Vec<Value> {
    ok(user, device, "pollEvents", json!({}))["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["type"] == kind)
        .cloned()
        .collect()
}

/// Alice asks to verify Bob's device; Bob accepts and Alice starts SAS. Returns the flow ID.
fn sas_until_emoji(server: &mut Homeserver, alice: &str, bob: &str) -> String {
    let [request, outgoing] = ok(
        alice,
        "ALICE",
        "requestDeviceVerification",
        json!({ "userId": bob, "deviceId": "BOB" }),
    )
    .as_array()
    .unwrap()
    .clone()
    .try_into()
    .unwrap();
    server.send(alice, "ALICE", &outgoing);
    let flow = request["flowId"].as_str().unwrap().to_owned();
    server.sync(bob, "BOB");
    let flow_of = |user: &str| json!({ "userId": user, "flowId": flow });
    assert_eq!(
        ok(bob, "BOB", "getVerificationRequest", flow_of(alice))["phase"],
        json!(1)
    );
    let ready = ok(bob, "BOB", "acceptVerificationRequest", flow_of(alice));
    server.send(bob, "BOB", &ready);
    server.sync(alice, "ALICE");
    let [_, start] = ok(alice, "ALICE", "startSas", flow_of(bob))
        .as_array()
        .unwrap()
        .clone()
        .try_into()
        .unwrap();
    server.send(alice, "ALICE", &start);
    server.sync(bob, "BOB");
    let accept = ok(bob, "BOB", "acceptSas", flow_of(alice));
    server.send(bob, "BOB", &accept);
    settle(server, [(alice, "ALICE"), (bob, "BOB")]);
    flow
}

#[test]
fn a_sas_flow_reports_its_changes_and_stops_watching_when_done() {
    let mut server = Homeserver::default();
    let (alice, bob) = two_users(&mut server, "sas");
    let flow = sas_until_emoji(&mut server, &alice, &bob);
    let alice_sas = ok(
        &alice,
        "ALICE",
        "getVerification",
        json!({ "userId": bob, "flowId": flow }),
    );
    let bob_sas = ok(
        &bob,
        "BOB",
        "getVerification",
        json!({ "userId": alice, "flowId": flow }),
    );
    assert_eq!(alice_sas["kind"], json!("sas"));
    assert_eq!(alice_sas["decimals"], bob_sas["decimals"]);
    assert_eq!(alice_sas["emoji"].as_array().unwrap().len(), 7);
    assert_eq!(
        watched(&alice, "ALICE"),
        json!(2),
        "the request and its SAS"
    );

    let phases: Vec<Value> = events_of(&bob, "BOB", "verificationRequestChanged")
        .iter()
        .map(|event| event["request"]["phase"].clone())
        .collect();
    assert_eq!(phases, [json!(2), json!(3)], "ready, then transitioned");
    let sas_events = events_of(&alice, "ALICE", "verificationChanged");
    assert!(
        sas_events
            .last()
            .is_some_and(|event| event["verification"]["decimals"] == alice_sas["decimals"]),
        "the last SAS event carries the decimals: {sas_events:?}"
    );

    for (user, device, other, sas) in [
        (&alice, "ALICE", &bob, &alice_sas),
        (&bob, "BOB", &alice, &bob_sas),
    ] {
        let confirmed = ok(
            user,
            device,
            "confirmSas",
            json!({ "userId": other, "flowId": flow, "decimals": sas["decimals"] }),
        );
        for request in confirmed.as_array().unwrap() {
            server.send(user, device, request);
        }
    }
    settle(&mut server, [(&alice, "ALICE"), (&bob, "BOB")]);
    let device = ok(
        &alice,
        "ALICE",
        "getDevice",
        json!({ "userId": bob, "deviceId": "BOB" }),
    );
    assert_eq!(device["isVerified"], json!(true));
    let done = events_of(&alice, "ALICE", "verificationRequestChanged");
    assert_eq!(done.last().unwrap()["request"]["phase"], json!(4));
    assert_eq!(
        watched(&alice, "ALICE"),
        json!(0),
        "done objects are dropped"
    );
    assert_eq!(watched(&bob, "BOB"), json!(0));

    // Syncs collect a done flow, after which it is unknown.
    assert_eq!(
        ok(
            &alice,
            "ALICE",
            "getVerificationRequest",
            json!({ "userId": bob, "flowId": flow }),
        ),
        Value::Null
    );
}

#[test]
fn unknown_replaced_and_stale_flows_are_refused_without_effect() {
    let mut server = Homeserver::default();
    let (alice, bob) = two_users(&mut server, "stale");
    let unknown = json!({ "userId": bob, "flowId": "no-such-flow", "decimals": [1, 2, 3] });
    let flow_only = |method: &str| {
        let mut params = unknown.clone();
        if method != "confirmSas" {
            params.as_object_mut().unwrap().remove("decimals");
        }
        params
    };
    for method in [
        "acceptVerificationRequest",
        "cancelVerificationRequest",
        "startSas",
        "generateQrCode",
        "acceptSas",
        "confirmSas",
        "cancelSas",
        "cancelQr",
        "confirmQrScanning",
        "reciprocateQr",
        "qrCodeBytes",
    ] {
        assert_eq!(
            error_code(&invoke(&alice, "ALICE", method, flow_only(method))),
            "UnknownVerification",
            "{method}"
        );
    }
    assert_eq!(
        ok(
            &alice,
            "ALICE",
            "getVerificationRequests",
            json!({ "userId": bob })
        ),
        json!([])
    );

    let flow = sas_until_emoji(&mut server, &alice, &bob);
    let on_flow = json!({ "userId": bob, "flowId": flow });
    // The flow is a SAS: QR calls on it are refused, not applied to the SAS.
    for method in [
        "confirmQrScanning",
        "reciprocateQr",
        "cancelQr",
        "qrCodeBytes",
    ] {
        assert_eq!(
            error_code(&invoke(&alice, "ALICE", method, on_flow.clone())),
            "UnknownVerification",
            "{method}"
        );
    }
    // Confirming needs the decimals the host showed.
    assert_eq!(
        error_code(&invoke(&alice, "ALICE", "confirmSas", on_flow.clone())),
        "InvalidRequest"
    );
    // Decimals the host did not show: a SAS of another flow under the same ID.
    let sas = ok(&alice, "ALICE", "getVerification", on_flow.clone());
    let mut other = sas["decimals"].clone();
    other[0] = json!((other[0].as_u64().unwrap() + 1) % 8192 + 1000);
    let mut stale = on_flow.clone();
    stale["decimals"] = other;
    assert_eq!(
        error_code(&invoke(&alice, "ALICE", "confirmSas", stale)),
        "StaleObject"
    );
    let after = ok(&alice, "ALICE", "getVerification", on_flow.clone());
    assert_eq!(after["haveWeConfirmed"], json!(false), "nothing changed");
    assert_eq!(
        ok(&alice, "ALICE", "outgoingRequests", json!({})),
        json!([])
    );

    // Cancelled: confirming answers no request, as in WASM, and verifies nothing.
    let cancel = ok(&alice, "ALICE", "cancelSas", on_flow.clone());
    server.send(&alice, "ALICE", &cancel);
    let mut confirm = on_flow.clone();
    confirm["decimals"] = sas["decimals"].clone();
    assert_eq!(
        ok(&alice, "ALICE", "confirmSas", confirm.clone()),
        json!([])
    );
    // Two syncs collect the cancelled flow; then it is unknown.
    server.sync(&alice, "ALICE");
    server.sync(&alice, "ALICE");
    assert_eq!(
        ok(&alice, "ALICE", "getVerificationRequest", on_flow.clone()),
        Value::Null
    );
    assert_eq!(
        error_code(&invoke(&alice, "ALICE", "confirmSas", confirm)),
        "UnknownVerification"
    );
    let device = ok(
        &alice,
        "ALICE",
        "getDevice",
        json!({ "userId": bob, "deviceId": "BOB" }),
    );
    assert_eq!(device["isVerified"], json!(false));
    assert_eq!(watched(&alice, "ALICE"), json!(0));
}

#[test]
fn verification_from_a_changed_device_or_identity_is_refused() {
    let mut server = Homeserver::default();
    let (alice, bob) = two_users(&mut server, "key");
    let device = ok(
        &alice,
        "ALICE",
        "getDevice",
        json!({ "userId": bob, "deviceId": "BOB" }),
    );
    let old_key = device["keys"]["ed25519:BOB"].as_str().unwrap().to_owned();
    let master_of = |identity: &Value| -> Value {
        let key: Value = serde_json::from_str(identity["masterKey"].as_str().unwrap()).unwrap();
        key["keys"]
            .as_object()
            .unwrap()
            .values()
            .next()
            .unwrap()
            .clone()
    };
    let old_master = master_of(&ok(
        &alice,
        "ALICE",
        "getIdentity",
        json!({ "userId": bob }),
    ));

    // Bob logs out, logs in again under the same device ID with new keys, and resets his
    // identity.
    let query_bob = |server: &mut Homeserver| {
        let query = ok(
            &alice,
            "ALICE",
            "queryKeysForUsers",
            json!({ "users": [bob] }),
        );
        server.send(&alice, "ALICE", &query);
    };
    server.forget_devices(&bob);
    query_bob(&mut server);
    ok(&bob, "BOB", "close", json!({}));
    ok(&bob, "BOB", "init", json!({}));
    server.send_outgoing(&bob, "BOB");
    let requests = ok(
        &bob,
        "BOB",
        "bootstrapCrossSigning",
        json!({ "reset": true }),
    );
    server.upload_signing_keys(&bob, &requests["uploadSigningKeysRequest"]);
    query_bob(&mut server);
    let device = ok(
        &alice,
        "ALICE",
        "getDevice",
        json!({ "userId": bob, "deviceId": "BOB" }),
    );
    let key = device["keys"]["ed25519:BOB"].as_str().unwrap().to_owned();
    assert_ne!(key, old_key);
    let master = master_of(&ok(
        &alice,
        "ALICE",
        "getIdentity",
        json!({ "userId": bob }),
    ));
    assert_ne!(master, old_master);

    let stale = [
        (
            "requestDeviceVerification",
            json!({ "userId": bob, "deviceId": "BOB", "ed25519Key": old_key }),
        ),
        (
            "requestIdentityVerification",
            json!({ "userId": bob, "masterKey": old_master, "roomId": "!dm:localhost", "requestEventId": "$request" }),
        ),
        (
            "verificationRequestContent",
            json!({ "userId": bob, "masterKey": old_master }),
        ),
    ];
    for (method, params) in stale {
        assert_eq!(
            error_code(&invoke(&alice, "ALICE", method, params)),
            "StaleObject",
            "{method}"
        );
    }
    assert_eq!(
        ok(
            &alice,
            "ALICE",
            "getVerificationRequests",
            json!({ "userId": bob })
        ),
        json!([]),
        "a refused call starts nothing"
    );
    assert_eq!(watched(&alice, "ALICE"), json!(0));

    let content = ok(
        &alice,
        "ALICE",
        "verificationRequestContent",
        json!({ "userId": bob, "masterKey": master }),
    );
    let content: Value = serde_json::from_str(content.as_str().unwrap()).unwrap();
    assert_eq!(content["to"], json!(bob));
    let started = ok(
        &alice,
        "ALICE",
        "requestDeviceVerification",
        json!({ "userId": bob, "deviceId": "BOB", "ed25519Key": key, "methods": [0] }),
    );
    assert_eq!(started[0]["ourSupportedMethods"], json!([0]));
    assert_eq!(started[1]["type"], json!(3));
    assert_eq!(
        error_code(&invoke(
            &alice,
            "ALICE",
            "requestDeviceVerification",
            json!({ "userId": bob, "deviceId": "BOB", "methods": [9] }),
        )),
        "InvalidRequest"
    );
}

#[test]
fn a_panic_and_a_new_init_drop_the_watches() {
    let mut server = Homeserver::default();
    let (alice, bob) = two_users(&mut server, "panic");
    ok(
        &alice,
        "ALICE",
        "requestDeviceVerification",
        json!({ "userId": bob, "deviceId": "BOB" }),
    );
    assert_eq!(watched(&alice, "ALICE"), json!(1));
    assert_eq!(
        error_code(&invoke(&alice, "ALICE", "debugPanic", json!({}))),
        "Panic"
    );
    ok(&alice, "ALICE", "init", json!({}));
    assert_eq!(watched(&alice, "ALICE"), json!(0));
    // The memory store went with the machine: fetch Bob's keys again.
    server.send_outgoing(&alice, "ALICE");
    let query = ok(
        &alice,
        "ALICE",
        "queryKeysForUsers",
        json!({ "users": [bob] }),
    );
    server.send(&alice, "ALICE", &query);
    assert_eq!(
        ok(
            &alice,
            "ALICE",
            "getVerificationRequests",
            json!({ "userId": bob })
        ),
        json!([]),
        "verifications live in the dropped machine's memory only"
    );
    ok(
        &alice,
        "ALICE",
        "requestDeviceVerification",
        json!({ "userId": bob, "deviceId": "BOB" }),
    );
    assert_eq!(
        watched(&alice, "ALICE"),
        json!(1),
        "watched once, not twice"
    );
}

#[test]
fn the_qr_secret_leaves_only_through_qr_code_bytes() {
    use base64::Engine as _;
    let mut server = Homeserver::default();
    let (alice, bob) = two_users(&mut server, "qr");
    // A QR code between two users needs both identities.
    let requests = ok(
        &alice,
        "ALICE",
        "bootstrapCrossSigning",
        json!({ "reset": true }),
    );
    server.upload_signing_keys(&alice, &requests["uploadSigningKeysRequest"]);
    let query = ok(
        &bob,
        "BOB",
        "queryKeysForUsers",
        json!({ "users": [alice] }),
    );
    server.send(&bob, "BOB", &query);
    let all = json!([0, 1, 2, 3]);
    let [request, outgoing] = ok(
        &alice,
        "ALICE",
        "requestDeviceVerification",
        json!({ "userId": bob, "deviceId": "BOB", "methods": all }),
    )
    .as_array()
    .unwrap()
    .clone()
    .try_into()
    .unwrap();
    server.send(&alice, "ALICE", &outgoing);
    let flow = request["flowId"].as_str().unwrap().to_owned();
    server.sync(&bob, "BOB");
    let on_alice = json!({ "userId": alice, "flowId": flow });
    ok(&bob, "BOB", "getVerificationRequest", on_alice.clone());
    let mut accept = on_alice.clone();
    accept["methods"] = all;
    let ready = ok(&bob, "BOB", "acceptVerificationRequest", accept);
    server.send(&bob, "BOB", &ready);
    server.sync(&alice, "ALICE");

    let mut seen = vec![ok(&bob, "BOB", "generateQrCode", on_alice.clone())];
    assert_eq!(seen[0]["kind"], json!("qr"));
    seen.push(ok(&bob, "BOB", "getVerification", on_alice.clone()));
    seen.push(ok(&bob, "BOB", "getVerificationRequest", on_alice.clone()));
    seen.push(ok(&bob, "BOB", "pollEvents", json!({})));
    let bytes = ok(&bob, "BOB", "qrCodeBytes", on_alice);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes.as_str().unwrap())
        .unwrap();
    // MATRIX, version, mode, flow ID length and flow ID, two keys, then the secret.
    let flow_length = usize::from(u16::from_be_bytes([bytes[8], bytes[9]]));
    let secret = &bytes[10 + flow_length + 64..];
    assert!(secret.len() >= 8, "a shared secret: {} bytes", secret.len());
    let encoded = [
        base64::engine::general_purpose::STANDARD.encode(secret),
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(secret),
        base64::engine::general_purpose::STANDARD.encode(&bytes),
    ];
    for answer in seen {
        let text = answer.to_string();
        for leaked in &encoded {
            assert!(!text.contains(leaked.trim_end_matches('=')), "{text}");
        }
    }
}

/// Alice asks to verify Bob's device and Bob accepts; both know each other's identity.
fn ready_with_identities(server: &mut Homeserver, name: &str) -> (String, String, String) {
    let (alice, bob) = two_users(server, name);
    let requests = ok(
        &alice,
        "ALICE",
        "bootstrapCrossSigning",
        json!({ "reset": true }),
    );
    server.upload_signing_keys(&alice, &requests["uploadSigningKeysRequest"]);
    let query = ok(
        &bob,
        "BOB",
        "queryKeysForUsers",
        json!({ "users": [alice] }),
    );
    server.send(&bob, "BOB", &query);
    let all = json!([0, 1, 2, 3]);
    let started = ok(
        &alice,
        "ALICE",
        "requestDeviceVerification",
        json!({ "userId": bob, "deviceId": "BOB", "methods": all }),
    );
    server.send(&alice, "ALICE", &started[1]);
    let flow = started[0]["flowId"].as_str().unwrap().to_owned();
    server.sync(&bob, "BOB");
    ok(
        &bob,
        "BOB",
        "getVerificationRequest",
        json!({ "userId": alice, "flowId": flow }),
    );
    let ready = ok(
        &bob,
        "BOB",
        "acceptVerificationRequest",
        json!({ "userId": alice, "flowId": flow, "methods": all }),
    );
    server.send(&bob, "BOB", &ready);
    server.sync(&alice, "ALICE");
    (alice, bob, flow)
}

#[test]
fn a_sas_that_replaces_a_shown_qr_code_is_watched_instead() {
    let mut server = Homeserver::default();
    let (alice, bob, flow) = ready_with_identities(&mut server, "swap");
    let on_alice = json!({ "userId": alice, "flowId": flow });
    assert_eq!(
        ok(&bob, "BOB", "generateQrCode", on_alice.clone())["kind"],
        json!("qr")
    );
    assert_eq!(
        watched(&bob, "BOB"),
        json!(2),
        "the request and its QR code"
    );
    ok(&bob, "BOB", "pollEvents", json!({}));

    // Alice starts SAS instead: it replaces Bob's QR code, which nobody scanned.
    let started = ok(
        &alice,
        "ALICE",
        "startSas",
        json!({ "userId": bob, "flowId": flow }),
    );
    server.send(&alice, "ALICE", &started[1]);
    server.sync(&bob, "BOB");
    let replaced = events_of(&bob, "BOB", "verificationRequestChanged");
    assert_eq!(
        replaced.last().unwrap()["request"]["verification"]["kind"],
        json!("sas")
    );
    assert_eq!(watched(&bob, "BOB"), json!(2), "the request and its SAS");
    let accept = ok(&bob, "BOB", "acceptSas", on_alice.clone());
    server.send(&bob, "BOB", &accept);
    let changed = events_of(&bob, "BOB", "verificationChanged");
    assert_eq!(
        changed.last().unwrap()["verification"]["kind"],
        json!("sas"),
        "the new SAS is watched: {changed:?}"
    );
    assert_eq!(
        error_code(&invoke(&bob, "BOB", "confirmQrScanning", on_alice.clone())),
        "UnknownVerification",
        "the replaced QR code is gone"
    );
    // Before keys are exchanged the new SAS shows no decimals: any the host has are stale.
    let mut confirm = on_alice.clone();
    confirm["decimals"] = json!([1000, 2000, 3000]);
    assert_eq!(
        error_code(&invoke(&bob, "BOB", "confirmSas", confirm)),
        "StaleObject"
    );
}

#[test]
fn a_shown_qr_code_replaced_by_a_cancelled_sas_is_not_watched() {
    let mut server = Homeserver::default();
    let (alice, bob, flow) = ready_with_identities(&mut server, "gone");
    ok(
        &bob,
        "BOB",
        "generateQrCode",
        json!({ "userId": alice, "flowId": flow }),
    );
    assert_eq!(watched(&bob, "BOB"), json!(2));
    let on_bob = json!({ "userId": bob, "flowId": flow });
    let started = ok(&alice, "ALICE", "startSas", on_bob.clone());
    server.send(&alice, "ALICE", &started[1]);
    let cancel = ok(&alice, "ALICE", "cancelSas", on_bob);
    server.send(&alice, "ALICE", &cancel);
    // Bob gets the start and the cancel in one sync: the SAS replaces the QR code and ends.
    server.sync(&bob, "BOB");
    assert_eq!(
        watched(&bob, "BOB"),
        json!(0),
        "neither the QR code nor the SAS"
    );
}

#[test]
fn a_panic_drops_the_watches_at_once() {
    let mut server = Homeserver::default();
    let (alice, bob) = two_users(&mut server, "dead");
    ok(
        &alice,
        "ALICE",
        "requestDeviceVerification",
        json!({ "userId": bob, "deviceId": "BOB" }),
    );
    assert_eq!(watched(&alice, "ALICE"), json!(1));
    invoke(&alice, "ALICE", "debugPanic", json!({}));
    assert_eq!(
        watched(&alice, "ALICE"),
        json!(0),
        "the dead machine's objects are not kept until the next init"
    );
}
