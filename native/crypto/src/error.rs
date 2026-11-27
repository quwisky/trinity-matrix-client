//! The `{ "error": { "code", "message", "details"? } }` half of every response.

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
pub struct CallError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl CallError {
    pub fn new(code: &'static str, message: impl ToString) -> Self {
        Self {
            code,
            message: message.to_string(),
            details: None,
        }
    }

    pub fn invalid(message: impl ToString) -> Self {
        Self::new("InvalidRequest", message)
    }

    pub fn crypto(error: impl ToString) -> Self {
        Self::new("CryptoError", error)
    }
}

impl From<serde_json::Error> for CallError {
    fn from(error: serde_json::Error) -> Self {
        Self::invalid(error)
    }
}

impl From<matrix_sdk_crypto::CryptoStoreError> for CallError {
    fn from(error: matrix_sdk_crypto::CryptoStoreError) -> Self {
        Self::new("StoreError", error)
    }
}

impl From<matrix_sdk_crypto::OlmError> for CallError {
    fn from(error: matrix_sdk_crypto::OlmError) -> Self {
        Self::crypto(error)
    }
}

impl From<matrix_sdk_crypto::MegolmError> for CallError {
    fn from(error: matrix_sdk_crypto::MegolmError) -> Self {
        Self::crypto(error)
    }
}

pub type CallResult<T = Value> = Result<T, CallError>;
