use matrix_sdk_crypto::store::types::DehydratedDeviceKey;
use serde_json::{Value, json};

use super::{body, invoke, ok, unique_user};

/// A dehydrated device made by `user`'s `CREATOR` (cross-signed locally), and its key.
fn dehydrated_device(user: &str) -> (String, Value, String) {
    ok(user, "CREATOR", "init", json!({}));
    ok(
        user,
        "CREATOR",
        "bootstrapCrossSigning",
        json!({ "reset": true }),
    );
    let key = DehydratedDeviceKey::new().to_base64();
    let request = ok(
        user,
        "CREATOR",
        "createDehydratedDevice",
        json!({ "initialDeviceDisplayName": "Dehydrated device", "dehydratedDeviceKey": key }),
    );
    let body = body(&request);
    let id = body["device_id"].as_str().unwrap().to_owned();
    (id, body["device_data"].clone(), key)
}

fn rehydrate(user: &str, id: &str, data: &Value, key: &str) -> Value {
    invoke(
        user,
        "REHYDRATOR",
        "rehydrateDevice",
        json!({ "dehydratedDeviceKey": key, "deviceId": id, "deviceData": data.to_string() }),
    )
}

fn held(user: &str) -> Value {
    ok(user, "REHYDRATOR", "debugRehydration", json!({}))
}

#[test]
fn a_rehydrated_device_is_held_until_dropped_and_goes_on_close_init_and_panic() {
    let user = unique_user("dehydrator");
    let (id, data, key) = dehydrated_device(&user);
    ok(&user, "REHYDRATOR", "init", json!({}));
    let own_keys = ok(&user, "REHYDRATOR", "identityKeys", json!({}));

    // The wrong key leaves nothing held.
    let wrong = rehydrate(&user, &id, &data, &DehydratedDeviceKey::new().to_base64());
    assert_eq!(wrong["error"]["code"], "CryptoError", "{wrong}");
    assert_eq!(held(&user), Value::Null);

    assert_eq!(
        rehydrate(&user, &id, &data, &key),
        json!({ "result": null })
    );
    assert_eq!(held(&user), json!(id));
    let none = ok(
        &user,
        "REHYDRATOR",
        "receiveRehydratedEvents",
        json!({ "deviceId": id, "toDeviceEvents": "[]" }),
    );
    assert_eq!(none, json!([]));
    let other = invoke(
        &user,
        "REHYDRATOR",
        "receiveRehydratedEvents",
        json!({ "deviceId": "OTHER", "toDeviceEvents": "[]" }),
    );
    assert_eq!(other["error"]["code"], "UnknownRehydration");
    // The machine's own device stays what it was.
    assert_eq!(ok(&user, "REHYDRATOR", "identityKeys", json!({})), own_keys);
    assert_eq!(
        ok(&user, "REHYDRATOR", "exportRoomKeys", json!({})),
        json!("[]")
    );

    // dropRehydratedDevice of another ID keeps it; of its ID drops it.
    ok(
        &user,
        "REHYDRATOR",
        "dropRehydratedDevice",
        json!({ "deviceId": "OTHER" }),
    );
    assert_eq!(held(&user), json!(id));
    ok(
        &user,
        "REHYDRATOR",
        "dropRehydratedDevice",
        json!({ "deviceId": id }),
    );
    assert_eq!(held(&user), Value::Null);

    // init on the open machine drops it.
    rehydrate(&user, &id, &data, &key);
    ok(&user, "REHYDRATOR", "init", json!({}));
    assert_eq!(held(&user), Value::Null);

    // A panic drops it with the machine.
    rehydrate(&user, &id, &data, &key);
    assert_eq!(
        invoke(&user, "REHYDRATOR", "debugPanic", json!({}))["error"]["code"],
        "Panic"
    );
    ok(&user, "REHYDRATOR", "init", json!({}));
    assert_eq!(held(&user), Value::Null);

    // So does close.
    rehydrate(&user, &id, &data, &key);
    ok(&user, "REHYDRATOR", "close", json!({}));
    ok(&user, "REHYDRATOR", "init", json!({}));
    assert_eq!(held(&user), Value::Null);
}

#[test]
fn dehydration_keys_are_cached_and_malformed_ones_name_no_key() {
    let user = unique_user("cache");
    ok(&user, "DEVICE", "init", json!({}));
    assert_eq!(
        ok(&user, "DEVICE", "getDehydratedDeviceKey", json!({})),
        Value::Null
    );
    let key = DehydratedDeviceKey::new().to_base64();
    ok(
        &user,
        "DEVICE",
        "saveDehydratedDeviceKey",
        json!({ "dehydratedDeviceKey": key }),
    );
    assert_eq!(
        ok(&user, "DEVICE", "getDehydratedDeviceKey", json!({})),
        json!(key)
    );
    // Padded base64 is the same key.
    let padded = format!("{key}=");
    ok(
        &user,
        "DEVICE",
        "saveDehydratedDeviceKey",
        json!({ "dehydratedDeviceKey": padded }),
    );
    assert_eq!(
        ok(&user, "DEVICE", "getDehydratedDeviceKey", json!({})),
        json!(key)
    );

    for (bad, code) in [
        ("not base64 !".to_owned(), "InvalidRequest"),
        ("AAAA".to_owned(), "CryptoError"),
    ] {
        let response = invoke(
            &user,
            "DEVICE",
            "saveDehydratedDeviceKey",
            json!({ "dehydratedDeviceKey": bad }),
        );
        assert_eq!(response["error"]["code"], code, "{response}");
        assert!(!response.to_string().contains(&bad), "{response}");
    }
    // Without the self-signing key there is nothing to sign the device with.
    let unsigned = invoke(
        &user,
        "DEVICE",
        "createDehydratedDevice",
        json!({ "initialDeviceDisplayName": "x", "dehydratedDeviceKey": key }),
    );
    assert_eq!(unsigned["error"]["code"], "CryptoError", "{unsigned}");
}
