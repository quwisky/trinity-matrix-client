//! JNI entry points for the Android debug plugin: the static native methods `call` and
//! `callBatch` of `dev.trinityproject.trinity.cryptodebug.TrinityCryptoNative`.
//!
//! They block the calling thread (see "For the JNI wrapper" in README.md).

use std::borrow::Cow;

use jni::EnvUnowned;
use jni::errors::ThrowRuntimeExAndDefault;
use jni::objects::{JClass, JString};
use simd_cesu8::mutf8;
use zeroize::Zeroizing;

/// Decodes a request from the JVM's modified UTF-8 and runs it. Invalid input fails the
/// request instead of being replaced. A converted copy may hold a store key, so it is wiped;
/// the JVM's own buffer cannot be.
fn respond(request: &[u8], call: fn(&str) -> String) -> String {
    match mutf8::decode(request) {
        Ok(Cow::Borrowed(request)) => call(request),
        Ok(Cow::Owned(request)) => call(&Zeroizing::new(request)),
        Err(_) => crate::error_response("request is not valid modified UTF-8"),
    }
}

fn run<'caller>(
    mut env: EnvUnowned<'caller>,
    request: JString<'caller>,
    call: fn(&str) -> String,
) -> JString<'caller> {
    env.with_env(|env| -> jni::errors::Result<_> {
        let response = respond(request.mutf8_chars(env)?.to_bytes(), call);
        JString::new(env, response)
    })
    .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_trinityproject_trinity_cryptodebug_TrinityCryptoNative_call<
    'caller,
>(
    env: EnvUnowned<'caller>,
    _class: JClass<'caller>,
    request: JString<'caller>,
) -> JString<'caller> {
    run(env, request, crate::call)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_trinityproject_trinity_cryptodebug_TrinityCryptoNative_callBatch<
    'caller,
>(
    env: EnvUnowned<'caller>,
    _class: JClass<'caller>,
    requests: JString<'caller>,
) -> JString<'caller> {
    run(env, requests, crate::call_batch)
}

#[cfg(test)]
mod tests {
    use super::respond;

    fn echo(request: &str) -> String {
        format!("echo {request}")
    }

    #[test]
    fn invalid_modified_utf8_fails_the_request() {
        let response: serde_json::Value =
            serde_json::from_str(&respond(&[b'{', 0xff, b'}'], echo)).unwrap();
        assert_eq!(response["error"]["code"], "InvalidRequest", "{response}");
    }

    #[test]
    fn modified_utf8_is_decoded_before_the_call() {
        assert_eq!(respond(b"{}", echo), "echo {}");
        // NUL as C0 80 and U+1F600 as a surrogate pair: both differ from plain UTF-8.
        let mutf8 = [0xc0, 0x80, 0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80];
        assert_eq!(respond(&mutf8, echo), "echo \0\u{1F600}");
    }
}
