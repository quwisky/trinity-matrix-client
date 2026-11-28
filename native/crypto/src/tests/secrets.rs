use serde_json::{Value, json};

use super::{invoke, ok, unique_user};

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
