use serde_json::{Value, json};

use super::{invoke, ok, unique_user};

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
