//! JNI entry points for the Android debug plugin: the static native methods `call` and
//! `callBatch` of `dev.trinityproject.trinity.cryptodebug.TrinityCryptoNative`.
//!
//! They block the calling thread (see "For the JNI wrapper" in README.md).

use jni::EnvUnowned;
use jni::errors::ThrowRuntimeExAndDefault;
use jni::objects::{JClass, JString};
use zeroize::Zeroizing;

fn run<'caller>(
    mut env: EnvUnowned<'caller>,
    request: JString<'caller>,
    call: fn(&str) -> String,
) -> JString<'caller> {
    env.with_env(|env| -> jni::errors::Result<_> {
        // Decodes modified UTF-8; the copy may hold a store key, so it is wiped after the call.
        let request = Zeroizing::new(request.try_to_string(env)?);
        JString::new(env, call(&request))
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
