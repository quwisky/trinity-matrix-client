use serde_json::{Value, json};

use super::{Homeserver, invoke, ok, unique_user};

fn error_code(response: &Value) -> &str {
    response["error"]["code"].as_str().unwrap()
}

#[test]
fn own_cross_signing_keys_leave_only_through_the_export() {
    let user = unique_user("cs");
    ok(&user, "CS", "init", json!({}));
    assert_eq!(
        ok(&user, "CS", "exportCrossSigningKeys", json!({})),
        Value::Null
    );
    ok(&user, "CS", "pollEvents", json!({}));

    let requests = ok(
        &user,
        "CS",
        "bootstrapCrossSigning",
        json!({ "reset": true }),
    );
    assert_eq!(requests["uploadSignaturesRequest"]["type"], json!(4));
    assert!(requests["uploadSignaturesRequest"].get("id").is_none());
    let signing: Value = serde_json::from_str(
        requests["uploadSigningKeysRequest"]["body"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(signing["master_key"]["user_id"], json!(user));

    let exported = ok(&user, "CS", "exportCrossSigningKeys", json!({}));
    let keys: Vec<&str> = ["masterKey", "self_signing_key", "userSigningKey"]
        .iter()
        .map(|name| exported[name].as_str().unwrap())
        .collect();
    assert_eq!(
        ok(&user, "CS", "crossSigningStatus", json!({})),
        json!({ "hasMaster": true, "hasSelfSigning": true, "hasUserSigning": true })
    );

    let events = ok(&user, "CS", "pollEvents", json!({}));
    assert!(
        events["events"]
            .as_array()
            .unwrap()
            .contains(&json!({ "type": "userIdentityUpdated", "userId": user })),
        "{events}"
    );
    let identity = ok(&user, "CS", "getIdentity", json!({ "userId": user }));
    assert_eq!(identity["kind"], json!("own"));
    assert_eq!(identity["isVerified"], json!(true));

    // No other answer carries a private key.
    let others = [
        requests.to_string(),
        events.to_string(),
        identity.to_string(),
        invoke(
            &user,
            "CS",
            "pinCurrentMasterKey",
            json!({ "userId": user }),
        )
        .to_string(),
    ];
    for key in keys {
        assert!(others.iter().all(|answer| !answer.contains(key)));
    }
}

#[test]
fn a_malformed_private_key_is_not_echoed_in_the_error() {
    let user = unique_user("bad");
    ok(&user, "BAD", "init", json!({}));
    ok(
        &user,
        "BAD",
        "bootstrapCrossSigning",
        json!({ "reset": true }),
    );
    let secret = "s3cr3t-!!-not-base64";
    let response = invoke(
        &user,
        "BAD",
        "importCrossSigningKeys",
        json!({ "masterKey": secret }),
    );
    assert_eq!(
        response["error"],
        json!({
            "code": "CryptoError",
            "message": "Error while importing m.cross_signing.master: invalid key",
        })
    );
}

#[test]
fn object_methods_refuse_what_wasm_could_not_call() {
    let user = unique_user("obj");
    ok(&user, "OBJ", "init", json!({}));
    let unknown = json!({ "userId": user, "deviceId": "NOPE" });
    assert_eq!(ok(&user, "OBJ", "getDevice", unknown.clone()), Value::Null);
    let mut trust = unknown.clone();
    trust["localState"] = json!(0);
    assert_eq!(
        error_code(&invoke(&user, "OBJ", "setLocalTrust", trust)),
        "UnknownDevice"
    );
    assert_eq!(
        error_code(&invoke(&user, "OBJ", "verifyDevice", unknown)),
        "UnknownDevice"
    );
    let own = json!({ "userId": user, "deviceId": "OBJ", "localState": 9 });
    assert_eq!(
        error_code(&invoke(&user, "OBJ", "setLocalTrust", own)),
        "InvalidRequest"
    );
    let stranger = json!({ "userId": "@stranger:localhost" });
    assert_eq!(
        ok(&user, "OBJ", "getIdentity", stranger.clone()),
        Value::Null
    );
    assert_eq!(
        error_code(&invoke(&user, "OBJ", "withdrawVerification", stranger)),
        "UnknownIdentity"
    );

    ok(
        &user,
        "OBJ",
        "bootstrapCrossSigning",
        json!({ "reset": true }),
    );
    // WASM's OwnUserIdentity has no pinCurrentMasterKey.
    assert_eq!(
        error_code(&invoke(
            &user,
            "OBJ",
            "pinCurrentMasterKey",
            json!({ "userId": user })
        )),
        "InvalidRequest"
    );
    let me = ok(
        &user,
        "OBJ",
        "getDevice",
        json!({ "userId": user, "deviceId": "OBJ" }),
    );
    // The own device is locally trusted (WASM `LocalTrust.Verified`).
    assert_eq!(me["localTrustState"], json!(0));
}

/// Asks `alice`'s machine to download `user`'s keys now.
fn query(server: &mut Homeserver, alice: &str, user: &str) {
    let request = ok(
        alice,
        "ALICE",
        "queryKeysForUsers",
        json!({ "users": [user] }),
    );
    server.send(alice, "ALICE", &request);
}

/// The public master key in an identity snapshot.
fn master_key(identity: &Value) -> String {
    let key: Value = serde_json::from_str(identity["masterKey"].as_str().unwrap()).unwrap();
    let (_, public) = key["keys"].as_object().unwrap().iter().next().unwrap();
    public.as_str().unwrap().to_owned()
}

#[test]
fn a_device_the_host_did_not_see_is_refused_and_left_unchanged() {
    let mut server = Homeserver::default();
    let (alice, bob) = (unique_user("stalea"), unique_user("staleb"));
    ok(&alice, "ALICE", "init", json!({}));
    ok(&bob, "BOB", "init", json!({}));
    server.send_outgoing(&alice, "ALICE");
    server.send_outgoing(&bob, "BOB");
    query(&mut server, &alice, &bob);
    let device = json!({ "userId": bob, "deviceId": "BOB" });
    let seen = ok(&alice, "ALICE", "getDevice", device.clone());
    let old_key = seen["keys"]["ed25519:BOB"].as_str().unwrap().to_owned();

    // Bob logs out, then logs in again under the same device ID with new keys.
    server.forget_devices(&bob);
    query(&mut server, &alice, &bob);
    assert_eq!(
        ok(&alice, "ALICE", "getDevice", device.clone()),
        Value::Null
    );
    ok(&bob, "BOB", "close", json!({}));
    ok(&bob, "BOB", "init", json!({}));
    server.send_outgoing(&bob, "BOB");
    query(&mut server, &alice, &bob);
    let current = ok(&alice, "ALICE", "getDevice", device.clone());
    let new_key = current["keys"]["ed25519:BOB"].as_str().unwrap().to_owned();
    assert_ne!(new_key, old_key);

    let mut stale = device.clone();
    stale["ed25519Key"] = json!(old_key);
    let mut trust = stale.clone();
    trust["localState"] = json!(0);
    for (method, params) in [("setLocalTrust", trust), ("verifyDevice", stale)] {
        assert_eq!(
            error_code(&invoke(&alice, "ALICE", method, params)),
            "StaleObject",
            "{method}"
        );
    }
    assert_eq!(
        ok(&alice, "ALICE", "getDevice", device.clone())["localTrustState"],
        json!(3),
        "a refused call changes nothing"
    );

    let mut fresh = device.clone();
    fresh["ed25519Key"] = json!(new_key);
    fresh["localState"] = json!(0);
    assert_eq!(ok(&alice, "ALICE", "setLocalTrust", fresh), Value::Null);
    assert_eq!(
        ok(&alice, "ALICE", "getDevice", device)["isLocallyTrusted"],
        json!(true)
    );
}

#[test]
fn an_identity_the_host_did_not_see_is_refused_and_left_unchanged() {
    let mut server = Homeserver::default();
    let (alice, bob) = (unique_user("stalei"), unique_user("staleo"));
    ok(&alice, "ALICE", "init", json!({}));
    ok(&bob, "BOB", "init", json!({}));
    server.send_outgoing(&alice, "ALICE");
    server.send_outgoing(&bob, "BOB");
    let reset = |server: &mut Homeserver| {
        let requests = ok(
            &bob,
            "BOB",
            "bootstrapCrossSigning",
            json!({ "reset": true }),
        );
        server.upload_signing_keys(&bob, &requests["uploadSigningKeysRequest"]);
    };
    reset(&mut server);
    query(&mut server, &alice, &bob);
    let user = json!({ "userId": bob });
    let old_key = master_key(&ok(&alice, "ALICE", "getIdentity", user.clone()));

    reset(&mut server);
    query(&mut server, &alice, &bob);
    let changed = ok(&alice, "ALICE", "getIdentity", user.clone());
    assert_eq!(changed["identityNeedsUserApproval"], json!(true));
    let new_key = master_key(&changed);
    assert_ne!(new_key, old_key);

    let mut stale = user.clone();
    stale["masterKey"] = json!(old_key);
    for method in [
        "pinCurrentMasterKey",
        "verifyIdentity",
        "withdrawVerification",
    ] {
        assert_eq!(
            error_code(&invoke(&alice, "ALICE", method, stale.clone())),
            "StaleObject",
            "{method}"
        );
    }
    assert_eq!(
        ok(&alice, "ALICE", "getIdentity", user.clone())["identityNeedsUserApproval"],
        json!(true),
        "a refused call changes nothing"
    );

    let mut fresh = user.clone();
    fresh["masterKey"] = json!(new_key);
    assert_eq!(
        ok(&alice, "ALICE", "pinCurrentMasterKey", fresh),
        Value::Null
    );
    assert_eq!(
        ok(&alice, "ALICE", "getIdentity", user)["identityNeedsUserApproval"],
        json!(false)
    );
}
