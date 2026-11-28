use serde_json::{Value, json};

use super::{Homeserver, invoke, ok, unique_user};

/// The secrets bundle of a device with cross-signing keys and a backup key.
fn bundle(user: &str) -> Value {
    ok(user, "EXPORTER", "init", json!({}));
    let missing = invoke(user, "EXPORTER", "exportSecretsBundle", json!({}));
    assert_eq!(missing["error"]["code"], "CryptoError", "{missing}");
    ok(
        user,
        "EXPORTER",
        "bootstrapCrossSigning",
        json!({ "reset": true }),
    );
    let without_backup = ok(user, "EXPORTER", "exportSecretsBundle", json!({}));
    assert!(without_backup.get("backup").is_none(), "{without_backup}");
    let key = matrix_sdk_crypto::store::types::BackupDecryptionKey::new().to_base64();
    ok(
        user,
        "EXPORTER",
        "saveBackupDecryptionKey",
        json!({ "decryptionKeyBase64": key, "version": "3" }),
    );
    let bundle = ok(user, "EXPORTER", "exportSecretsBundle", json!({}));
    assert_eq!(bundle["backup"]["key"], json!(key));
    bundle
}

#[test]
fn a_secrets_bundle_imports_into_another_device_of_the_user() {
    let user = unique_user("bundle");
    let bundle = bundle(&user);
    ok(&user, "IMPORTER", "init", json!({}));
    assert_eq!(
        ok(
            &user,
            "IMPORTER",
            "importSecretsBundle",
            json!({ "bundle": bundle })
        ),
        Value::Null
    );
    assert_eq!(
        ok(&user, "IMPORTER", "crossSigningStatus", json!({})),
        json!({ "hasMaster": true, "hasSelfSigning": true, "hasUserSigning": true })
    );
    assert_eq!(
        ok(&user, "IMPORTER", "exportSecretsBundle", json!({})),
        bundle
    );
}

#[test]
fn an_unreadable_secrets_bundle_is_refused_without_quoting_it() {
    let user = unique_user("unreadable");
    let mut bundle = bundle(&user);
    let seed = bundle["cross_signing"]["master_key"].clone();
    // A seed as the backup algorithm: serde's own message would quote it as an unknown variant.
    bundle["backup"]["algorithm"] = seed.clone();
    ok(&user, "IMPORTER", "init", json!({}));
    let refused = invoke(
        &user,
        "IMPORTER",
        "importSecretsBundle",
        json!({ "bundle": bundle }),
    );
    assert_eq!(
        refused["error"],
        json!({ "code": "InvalidRequest", "message": "invalid secrets bundle" })
    );
    assert!(!refused.to_string().contains(seed.as_str().unwrap()));
    assert_eq!(
        ok(&user, "IMPORTER", "crossSigningStatus", json!({})),
        json!({ "hasMaster": false, "hasSelfSigning": false, "hasUserSigning": false })
    );
}

#[test]
fn the_inbox_answers_an_empty_set_for_an_unknown_name() {
    let user = unique_user("inbox");
    ok(&user, "DEVICE", "init", json!({}));
    assert_eq!(
        ok(
            &user,
            "DEVICE",
            "getSecretsFromInbox",
            json!({ "secretName": "m.megolm_backup.v1" })
        ),
        json!([])
    );
    let missing = invoke(
        &user,
        "DEVICE",
        "pushSecretToVerifiedDevices",
        json!({ "secretName": "m.megolm_backup.v1" }),
    );
    assert_eq!(missing["error"]["code"], "CryptoError", "{missing}");
}

/// `user`'s `SENDER` pushes its backup key to `RECEIVER`, which it trusts; the sync's answers.
fn pushed_backup_key(user: &str) -> (String, Value) {
    let mut server = Homeserver::default();
    for device in ["SENDER", "RECEIVER"] {
        ok(user, device, "init", json!({}));
        server.send_outgoing(user, device);
    }
    let query = ok(
        user,
        "SENDER",
        "queryKeysForUsers",
        json!({ "users": [user] }),
    );
    server.send(user, "SENDER", &query);
    ok(
        user,
        "SENDER",
        "setLocalTrust",
        json!({ "userId": user, "deviceId": "RECEIVER", "localState": 0 }),
    );
    let key = matrix_sdk_crypto::store::types::BackupDecryptionKey::new().to_base64();
    ok(
        user,
        "SENDER",
        "saveBackupDecryptionKey",
        json!({ "decryptionKeyBase64": key, "version": "1" }),
    );
    let claim = ok(
        user,
        "SENDER",
        "getMissingSessions",
        json!({ "users": [user] }),
    );
    server.send(user, "SENDER", &claim);
    ok(
        user,
        "SENDER",
        "pushSecretToVerifiedDevices",
        json!({ "secretName": "m.megolm_backup.v1" }),
    );
    server.send_outgoing(user, "SENDER");
    (key, server.sync(user, "RECEIVER"))
}

#[test]
fn a_decrypted_secret_leaves_the_sync_answer_without_its_value() {
    let user = unique_user("stripped");
    let (key, synced) = pushed_backup_key(&user);
    let events = synced.as_array().unwrap();
    assert_eq!(events.len(), 1, "{synced}");
    assert_eq!(events[0]["type"], json!(0), "{synced}");
    let raw: Value = serde_json::from_str(events[0]["rawEvent"].as_str().unwrap()).unwrap();
    assert_eq!(raw["type"], "io.element.msc4385.secret.push");
    assert_eq!(raw["content"]["name"], "m.megolm_backup.v1");
    assert!(raw["content"].get("secret").is_none(), "{raw}");
    assert!(!synced.to_string().contains(&key), "{synced}");
}

#[test]
fn a_bundle_with_one_malformed_seed_imports_nothing() {
    let user = unique_user("partial");
    let mut bundle = bundle(&user);
    // A valid master key, then a user-signing key that is not one: upstream would store the
    // master key before failing on the second.
    bundle["cross_signing"]["user_signing_key"] = json!("AAAA");
    ok(&user, "IMPORTER", "init", json!({}));
    ok(
        &user,
        "IMPORTER",
        "bootstrapCrossSigning",
        json!({ "reset": true }),
    );
    let status = ok(&user, "IMPORTER", "crossSigningStatus", json!({}));
    let keys = ok(&user, "IMPORTER", "exportCrossSigningKeys", json!({}));
    let refused = invoke(
        &user,
        "IMPORTER",
        "importSecretsBundle",
        json!({ "bundle": bundle }),
    );
    assert_eq!(
        refused["error"],
        json!({ "code": "InvalidRequest", "message": "invalid secrets bundle" })
    );
    assert_eq!(
        ok(&user, "IMPORTER", "crossSigningStatus", json!({})),
        status
    );
    assert_eq!(
        ok(&user, "IMPORTER", "exportCrossSigningKeys", json!({})),
        keys
    );
    assert_ne!(keys["masterKey"], bundle["cross_signing"]["master_key"]);
}

#[test]
fn unreadable_bundle_material_is_refused_without_quoting_it() {
    let user = unique_user("media");
    ok(&user, "DEVICE", "init", json!({}));
    // A file key given as a string where its JWK belongs: serde would quote it.
    let info = json!({ "v": "v2", "key": "AAAAfilekeyAAAA", "iv": "x", "hashes": {} }).to_string();
    let refused = invoke(
        &user,
        "DEVICE",
        "shareRoomKeyBundleData",
        json!({
            "userId": user,
            "roomId": "!room:localhost",
            "url": "mxc://localhost/x",
            "mediaEncryptionInfo": info,
            "sharingStrategy": "allDevices",
        }),
    );
    assert_eq!(
        refused["error"],
        json!({ "code": "CryptoError", "message": "Unable to validate room key media encryption info" })
    );
    assert!(!refused.to_string().contains("filekey"));
}
