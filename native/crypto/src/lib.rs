//! Trinity's native end-to-end encryption: matrix-sdk-crypto behind one JSON call surface.
//!
//! A request is `{ "method", "userId", "deviceId", "params" }`; the response is
//! `{ "result": … }` or `{ "error": { "code", "message", "details"? } }`. See README.md.

use std::ffi::{CStr, CString, c_char};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::LazyLock;

use serde_json::{Value, json};

mod backup;
mod devices;
mod error;
mod events;
#[cfg(feature = "jni")]
mod jni;
mod machine;
mod requests;
mod responses;
mod settings;
#[cfg(test)]
mod tests;

use error::{CallError, CallResult};

/// One long-lived runtime; every call blocks its calling thread until the call is done.
static RUNTIME: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("trinity-crypto")
        .enable_all()
        .build()
        .expect("the crypto runtime starts")
});

fn respond(result: CallResult) -> Value {
    match result {
        Ok(result) => json!({ "result": result }),
        Err(error) => json!({ "error": error }),
    }
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    let message = payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str));
    format!("panic in the crypto call: {}", message.unwrap_or("unknown"))
}

fn call_value(request: Value) -> Value {
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        let request: machine::Request = serde_json::from_value(request)?;
        RUNTIME.block_on(machine::dispatch(request))
    }));
    respond(
        outcome.unwrap_or_else(|payload| Err(CallError::new("Panic", panic_message(&*payload)))),
    )
}

/// Runs one request.
pub fn call(request_json: &str) -> String {
    let response = match serde_json::from_str(request_json) {
        Ok(request) => call_value(request),
        Err(error) => respond(Err(error.into())),
    };
    response.to_string()
}

/// Runs a JSON array of requests in order; one failing item does not stop the others.
pub fn call_batch(requests_json: &str) -> String {
    let response = match serde_json::from_str::<Vec<Value>>(requests_json) {
        Ok(requests) => Value::Array(requests.into_iter().map(call_value).collect()),
        Err(error) => respond(Err(error.into())),
    };
    response.to_string()
}

/// The response to a request that could not be read.
fn error_response(message: &str) -> String {
    respond(Err(CallError::invalid(message))).to_string()
}

fn call_c(request: *const c_char, run: fn(&str) -> String) -> *mut c_char {
    let response = if request.is_null() {
        error_response("request is null")
    } else {
        // SAFETY: the caller passes a valid NUL-terminated string (see the exported functions).
        match unsafe { CStr::from_ptr(request) }.to_str() {
            Ok(request) => run(request),
            Err(_) => error_response("request is not UTF-8"),
        }
    };
    // serde_json escapes NUL, so the response never contains one.
    CString::new(response)
        .expect("JSON has no NUL byte")
        .into_raw()
}

/// C entry point for [`call`]. Free the result with [`trinity_crypto_free`].
///
/// # Safety
///
/// `request` is null or a valid NUL-terminated string that outlives the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn trinity_crypto_call(request: *const c_char) -> *mut c_char {
    call_c(request, call)
}

/// C entry point for [`call_batch`]. Free the result with [`trinity_crypto_free`].
///
/// # Safety
///
/// `requests` is null or a valid NUL-terminated string that outlives the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn trinity_crypto_call_batch(requests: *const c_char) -> *mut c_char {
    call_c(requests, call_batch)
}

/// Frees a response returned by this library.
///
/// # Safety
///
/// `response` is null or a pointer returned by this library that was not freed yet.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn trinity_crypto_free(response: *mut c_char) {
    if !response.is_null() {
        // SAFETY: the pointer came from `CString::into_raw` in `call_c`.
        drop(unsafe { CString::from_raw(response) });
    }
}
