use matrix_sdk_crypto::store::types::BackupDecryptionKey;
use serde_json::{Map, Value, json};

use super::{Homeserver, body, invoke, ok, two_devices_sharing_a_room, unique_user};

const KEYS_BACKUP: u64 = 6;

/// Alice with a room key shared to Bob, and Bob having received it.
fn bob_with_a_room_key() -> (String, String) {
    let (alice, bob) = (unique_user("alice"), unique_user("bob"));
    let mut server = Homeserver::default();
    two_devices_sharing_a_room(&mut server, &alice, &bob, "!backup:localhost");
    server.sync(&bob, "BOB");
    (alice, bob)
}

#[test]
fn room_keys_export_and_import_into_another_machine() {
    let (_, bob) = bob_with_a_room_key();
    let exported = ok(&bob, "BOB", "exportRoomKeys", json!({}));
    let keys: Vec<Value> = serde_json::from_str(exported.as_str().unwrap()).unwrap();
    assert_eq!(keys.len(), 1, "{keys:?}");
    let session = keys[0]["session_id"].as_str().unwrap();

    let carol = unique_user("carol");
    ok(&carol, "CAROL", "init", json!({}));
    let imported = ok(
        &carol,
        "CAROL",
        "importExportedRoomKeys",
        json!({ "exportedRoomKeys": exported }),
    );
    assert_eq!(imported["importedCount"], json!(1));
    assert_eq!(imported["totalCount"], json!(1));
    let sender_key = keys[0]["sender_key"].as_str().unwrap();
    assert_eq!(
        imported["keys"]["!backup:localhost"][sender_key],
        json!([session])
    );
    let again = ok(
        &carol,
        "CAROL",
        "importExportedRoomKeys",
        json!({ "exportedRoomKeys": exported }),
    );
    assert_eq!(again["importedCount"], json!(0));
    assert_eq!(
        ok(&carol, "CAROL", "roomKeyCounts", json!({})),
        json!({ "total": 1, "backedUp": 0 })
    );
}

/// Bob's backup request after enabling a backup with a fresh key, and the key.
fn backed_up(bob: &str) -> (BackupDecryptionKey, Value) {
    let key = BackupDecryptionKey::new();
    let public = key.megolm_v1_public_key().to_base64();
    assert_eq!(ok(bob, "BOB", "isBackupEnabled", json!({})), json!(false));
    ok(
        bob,
        "BOB",
        "enableBackupV1",
        json!({ "publicKeyBase64": public, "version": "1" }),
    );
    assert_eq!(ok(bob, "BOB", "isBackupEnabled", json!({})), json!(true));
    let request = ok(bob, "BOB", "backupRoomKeys", json!({}));
    (key, request)
}

#[test]
fn a_backup_request_is_wire_ready_and_marked_as_sent() {
    let (_, bob) = bob_with_a_room_key();
    let (_, request) = backed_up(&bob);
    assert_eq!(request["type"], json!(KEYS_BACKUP));
    assert_eq!(request["version"], json!("1"));
    assert!(body(&request)["rooms"]["!backup:localhost"]["sessions"].is_object());
    assert_eq!(
        ok(&bob, "BOB", "roomKeyCounts", json!({})),
        json!({ "total": 1, "backedUp": 0 })
    );

    ok(
        &bob,
        "BOB",
        "markRequestAsSent",
        json!({ "requestId": request["id"], "requestType": KEYS_BACKUP, "response": r#"{"etag":"1","count":1}"# }),
    );
    assert_eq!(
        ok(&bob, "BOB", "roomKeyCounts", json!({})),
        json!({ "total": 1, "backedUp": 1 })
    );
    assert_eq!(ok(&bob, "BOB", "backupRoomKeys", json!({})), Value::Null);

    ok(&bob, "BOB", "disableBackup", json!({}));
    assert_eq!(ok(&bob, "BOB", "isBackupEnabled", json!({})), json!(false));
    assert_eq!(
        ok(&bob, "BOB", "roomKeyCounts", json!({})),
        json!({ "total": 1, "backedUp": 0 })
    );
}

#[test]
fn a_backup_restores_on_another_machine() {
    let (_, bob) = bob_with_a_room_key();
    let (key, request) = backed_up(&bob);
    let mut rooms = Map::new();
    for (room, data) in body(&request)["rooms"].as_object().unwrap() {
        let mut sessions = Map::new();
        for (id, session) in data["sessions"].as_object().unwrap() {
            let encrypted = &session["session_data"];
            let decrypted = key
                .decrypt_v1(
                    encrypted["ephemeral"].as_str().unwrap(),
                    encrypted["mac"].as_str().unwrap(),
                    encrypted["ciphertext"].as_str().unwrap(),
                )
                .unwrap();
            sessions.insert(id.clone(), serde_json::from_str(&decrypted).unwrap());
        }
        rooms.insert(room.clone(), sessions.into());
    }
    rooms["!backup:localhost"]
        .as_object_mut()
        .unwrap()
        .insert("broken".into(), json!({ "algorithm": "nope" }));

    let carol = unique_user("carol");
    ok(&carol, "CAROL", "init", json!({}));
    let imported = ok(
        &carol,
        "CAROL",
        "importBackedUpRoomKeys",
        json!({ "backedUpRoomKeys": rooms, "backupVersion": "1" }),
    );
    // The session that does not parse is skipped, as in WASM.
    assert_eq!(imported["importedCount"], json!(1), "{imported}");
    assert_eq!(imported["totalCount"], json!(1));
}

#[test]
fn backup_keys_are_saved_and_a_wrong_key_is_rejected() {
    let user = unique_user("keys");
    ok(&user, "K", "init", json!({}));
    assert_eq!(ok(&user, "K", "getBackupKeys", json!({})), json!({}));
    let key = BackupDecryptionKey::new().to_base64();
    ok(
        &user,
        "K",
        "saveBackupDecryptionKey",
        json!({ "decryptionKeyBase64": key, "version": "7" }),
    );
    assert_eq!(
        ok(&user, "K", "getBackupKeys", json!({})),
        json!({ "decryptionKeyBase64": key, "backupVersion": "7" })
    );

    let wrong = "not a key".to_owned();
    for (method, params) in [
        (
            "saveBackupDecryptionKey",
            json!({ "decryptionKeyBase64": wrong, "version": "8" }),
        ),
        (
            "enableBackupV1",
            json!({ "publicKeyBase64": wrong, "version": "8" }),
        ),
    ] {
        let response = invoke(&user, "K", method, params);
        assert_eq!(
            response["error"]["code"],
            json!("CryptoError"),
            "{response}"
        );
        assert!(!response.to_string().contains(&wrong));
    }
    assert_eq!(ok(&user, "K", "isBackupEnabled", json!({})), json!(false));
}

#[test]
fn a_tampered_backup_signature_is_invalid() {
    let user = unique_user("signer");
    ok(&user, "SIG", "init", json!({}));
    let public = BackupDecryptionKey::new()
        .megolm_v1_public_key()
        .to_base64();
    let auth_data = json!({ "public_key": public });
    let signatures = ok(
        &user,
        "SIG",
        "sign",
        json!({ "message": auth_data.to_string() }),
    );
    assert!(signatures[&user]["ed25519:SIG"].is_string(), "{signatures}");
    let info = |public_key: &str, signatures: &Value| {
        json!({
            "algorithm": "m.megolm_backup.v1.curve25519-aes-sha2",
            "auth_data": { "public_key": public_key, "signatures": signatures },
        })
    };
    let verify = |info: Value| ok(&user, "SIG", "verifyBackup", json!({ "backupInfo": info }));

    assert_eq!(
        verify(info(&public, &signatures)),
        json!({ "deviceState": 3, "userState": 0, "trusted": true })
    );
    let other = BackupDecryptionKey::new()
        .megolm_v1_public_key()
        .to_base64();
    assert_eq!(
        verify(info(&other, &signatures)),
        json!({ "deviceState": 1, "userState": 0, "trusted": false })
    );
    assert_eq!(
        verify(info(&public, &json!({}))),
        json!({ "deviceState": 0, "userState": 0, "trusted": false })
    );
}
