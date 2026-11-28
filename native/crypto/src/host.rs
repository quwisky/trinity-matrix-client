//! The call surface as a phone host reaches it: every request is for one machine, and the
//! host, not its caller, names that machine's store. `init` gets the host's store path and
//! raw key in place of whatever the caller put there; without a store from the host it is
//! refused, so a host machine never runs on a memory store.

use base64::Engine as _;
use serde_json::{Map, Value};
use zeroize::Zeroizing;

use crate::error::CallError;
use crate::{call_value, respond};

/// A machine's store as the host opens it: a directory and a raw 32-byte key.
pub(crate) struct HostStore<'a> {
    pub(crate) path: &'a str,
    pub(crate) key: &'a [u8],
}

/// Runs `request` (one request, or a JSON array of them) for the machine `user_id` and
/// `device_id`, answering in the same shape. A request for another machine fails alone.
pub(crate) fn call_for_machine(
    user_id: &str,
    device_id: &str,
    request: &str,
    store: Option<&HostStore<'_>>,
) -> String {
    let run = |item: Value| run_one(user_id, device_id, item, store);
    let response = match serde_json::from_str::<Value>(request) {
        Ok(Value::Array(items)) => Value::Array(items.into_iter().map(run).collect()),
        Ok(item @ Value::Object(_)) => run(item),
        Ok(_) => respond(Err(CallError::invalid(
            "a request is an object or an array of objects",
        ))),
        Err(error) => respond(Err(error.into())),
    };
    response.to_string()
}

fn run_one(
    user_id: &str,
    device_id: &str,
    mut item: Value,
    store: Option<&HostStore<'_>>,
) -> Value {
    let Some(fields) = item.as_object_mut() else {
        return respond(Err(CallError::invalid("a request is an object")));
    };
    if fields.get("userId").and_then(Value::as_str) != Some(user_id)
        || fields.get("deviceId").and_then(Value::as_str) != Some(device_id)
    {
        return respond(Err(CallError::invalid(
            "the request is for another machine than the host's call",
        )));
    }
    if fields.get("method").and_then(Value::as_str) == Some("init") {
        let params = fields
            .entry("params")
            .or_insert_with(|| Value::Object(Map::new()));
        if params.is_null() {
            *params = Value::Object(Map::new());
        }
        let Some(params) = params.as_object_mut() else {
            return respond(Err(CallError::invalid("init params must be an object")));
        };
        // Whatever the caller sent is dropped (a key wiped): the host's store is the only one.
        params.remove("storePath");
        if let Some(Value::String(key)) = params.remove("storeKey") {
            drop(Zeroizing::new(key));
        }
        let Some(store) = store else {
            return respond(Err(CallError::new(
                "StoreUnavailable",
                "the host opened no store for this device",
            )));
        };
        params.insert("storePath".into(), Value::String(store.path.to_owned()));
        // Moved into the request: `init` takes it out and wipes it (`take_store_key`).
        params.insert(
            "storeKey".into(),
            Value::String(base64::engine::general_purpose::STANDARD.encode(store.key)),
        );
    }
    call_value(item)
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{HostStore, call_for_machine};
    use crate::tests::unique_user;

    fn answer(user: &str, request: Value, store: Option<&HostStore<'_>>) -> Value {
        serde_json::from_str(&call_for_machine(user, "HOST", &request.to_string(), store)).unwrap()
    }

    fn request(user: &str, method: &str, params: Value) -> Value {
        json!({ "method": method, "userId": user, "deviceId": "HOST", "params": params })
    }

    #[test]
    fn init_without_a_host_store_is_refused_and_never_opens_memory() {
        let user = unique_user("hostnostore");
        let response = answer(&user, request(&user, "init", json!({})), None);
        assert_eq!(response["error"]["code"], "StoreUnavailable", "{response}");
        let after = answer(&user, request(&user, "identityKeys", Value::Null), None);
        assert_eq!(after["error"]["code"], "UnknownMachine", "{after}");
    }

    #[test]
    fn init_uses_the_host_store_and_ignores_the_callers() {
        let user = unique_user("hoststore");
        let dir = std::env::temp_dir().join(format!(
            "trinity-host-{}-{}",
            std::process::id(),
            user.trim_start_matches('@').replace(':', "_")
        ));
        let path = dir.to_str().unwrap().to_owned();
        let key = [7u8; 32];
        let store = HostStore {
            path: &path,
            key: &key,
        };
        // A caller's memory request and a caller's key are both replaced by the host's store.
        let caller = json!({ "storeKey": "AAAA", "storePath": "/elsewhere" });
        let opened = answer(&user, request(&user, "init", caller), Some(&store));
        assert!(opened.get("error").is_none(), "{opened}");
        let first = opened["result"]["identityKeys"].clone();
        answer(&user, request(&user, "close", Value::Null), None);
        // The account came from the host's store: reopening it gives the same identity.
        let reopened = answer(&user, request(&user, "init", Value::Null), Some(&store));
        assert_eq!(reopened["result"]["identityKeys"], first, "{reopened}");
        assert!(dir.join("matrix-sdk-crypto.sqlite3").exists());
        answer(&user, request(&user, "close", Value::Null), None);
        // Another key does not open it.
        let wrong = HostStore {
            path: &path,
            key: &[8u8; 32],
        };
        let refused = answer(&user, request(&user, "init", Value::Null), Some(&wrong));
        assert!(refused.get("error").is_some(), "{refused}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_request_for_another_machine_fails_alone() {
        let user = unique_user("hostother");
        let batch = json!([
            request(&user, "init", Value::Null),
            { "method": "identityKeys", "userId": "@someone:else", "deviceId": "HOST" },
            { "method": "identityKeys", "userId": user, "deviceId": "OTHER" },
        ]);
        let answers = answer(&user, batch, None);
        assert_eq!(answers[0]["error"]["code"], "StoreUnavailable");
        assert_eq!(answers[1]["error"]["code"], "InvalidRequest");
        assert_eq!(answers[2]["error"]["code"], "InvalidRequest");
    }

    #[test]
    fn single_and_batch_answer_in_their_shape() {
        let user = unique_user("hostshape");
        let single = answer(&user, request(&user, "pollEvents", Value::Null), None);
        assert!(single.is_object(), "{single}");
        let batch = answer(
            &user,
            json!([request(&user, "pollEvents", Value::Null)]),
            None,
        );
        assert_eq!(batch.as_array().map(Vec::len), Some(1), "{batch}");
        let invalid = answer(&user, json!(3), None);
        assert_eq!(invalid["error"]["code"], "InvalidRequest");
    }
}
