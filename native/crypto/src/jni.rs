//! JNI entry point for the Android plugin: the static native method `call` of
//! `dev.trinityproject.trinity.crypto.TrinityCryptoNative`.
//!
//! It blocks the calling thread (see "For the JNI wrapper" in README.md).

use std::borrow::Cow;

use jni::EnvUnowned;
use jni::errors::ThrowRuntimeExAndDefault;
use jni::objects::{JByteArray, JClass, JString};
use simd_cesu8::mutf8;
use zeroize::Zeroizing;

use crate::host::{HostStore, call_for_machine};

/// Decodes text from the JVM's modified UTF-8. Invalid input is refused instead of replaced.
/// A converted copy may hold plaintext, so it is wiped; the JVM's own buffer cannot be.
fn decoded<R>(text: &[u8], run: impl FnOnce(&str) -> R) -> Option<R> {
    match mutf8::decode(text) {
        Ok(Cow::Borrowed(text)) => Some(run(text)),
        Ok(Cow::Owned(text)) => Some(run(&Zeroizing::new(text))),
        Err(_) => None,
    }
}

fn respond(
    user_id: &[u8],
    device_id: &[u8],
    request: &[u8],
    store: Option<&HostStore<'_>>,
) -> String {
    let invalid = || crate::error_response("request is not valid modified UTF-8");
    decoded(user_id, |user_id| {
        decoded(device_id, |device_id| {
            decoded(request, |request| {
                call_for_machine(user_id, device_id, request, store)
            })
            .unwrap_or_else(invalid)
        })
        .unwrap_or_else(invalid)
    })
    .unwrap_or_else(invalid)
}

/// Runs one request or a JSON array of them for one machine. `storePath` and `storeKey` (a
/// raw 32-byte key, or null) are the machine's store, which `init` opens in place of any the
/// request names; the key is copied out of the Java array, used and wiped here, and the
/// caller wipes its array.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_trinityproject_trinity_crypto_TrinityCryptoNative_call<'caller>(
    mut env: EnvUnowned<'caller>,
    _class: JClass<'caller>,
    user_id: JString<'caller>,
    device_id: JString<'caller>,
    request: JString<'caller>,
    store_path: JString<'caller>,
    store_key: JByteArray<'caller>,
) -> JString<'caller> {
    env.with_env(|env| -> jni::errors::Result<_> {
        let key = if store_key.is_null() {
            None
        } else {
            Some(Zeroizing::new(env.convert_byte_array(&store_key)?))
        };
        let path = if store_path.is_null() {
            None
        } else {
            // An undecodable path opens no store, and `init` is refused.
            mutf8::decode(store_path.mutf8_chars(env)?.to_bytes())
                .ok()
                .map(Cow::into_owned)
        };
        let store = match (&path, &key) {
            (Some(path), Some(key)) => Some(HostStore { path, key }),
            _ => None,
        };
        let response = respond(
            user_id.mutf8_chars(env)?.to_bytes(),
            device_id.mutf8_chars(env)?.to_bytes(),
            request.mutf8_chars(env)?.to_bytes(),
            store.as_ref(),
        );
        JString::new(env, response)
    })
    .resolve::<ThrowRuntimeExAndDefault>()
}

#[cfg(test)]
mod tests {
    use super::respond;

    #[test]
    fn invalid_modified_utf8_fails_the_request() {
        let response: serde_json::Value =
            serde_json::from_str(&respond(b"@a:b", b"D", &[b'{', 0xff, b'}'], None)).unwrap();
        assert_eq!(response["error"]["code"], "InvalidRequest", "{response}");
        let response: serde_json::Value =
            serde_json::from_str(&respond(&[0xff], b"D", b"{}", None)).unwrap();
        assert_eq!(response["error"]["code"], "InvalidRequest", "{response}");
    }

    #[test]
    fn modified_utf8_is_decoded_before_the_call() {
        // NUL as C0 80: a user ID that differs from plain UTF-8 still reaches the check.
        let request = br#"{"method":"pollEvents","userId":"@a\u0000:b","deviceId":"D"}"#;
        let response: serde_json::Value = serde_json::from_str(&respond(
            &[b'@', b'a', 0xc0, 0x80, b':', b'b'],
            b"D",
            request,
            None,
        ))
        .unwrap();
        // The machine matched (decoded NUL equals the JSON's \u0000), so the crate answered.
        assert_ne!(
            response["error"]["message"], "the request is for another machine than the host's call",
            "{response}"
        );
    }
}
