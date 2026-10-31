//! The carrier-neutral frames between the TypeScript transport and the engine.

use std::fmt;

use matrix_sdk::ruma::serde::{Base64, base64::Standard};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

const DTO: &str = "util/matrix/src/lib/engine-transport/rust-dto/";

/// A message from TypeScript to the engine.
#[derive(PartialEq, Deserialize, TS)]
#[serde(tag = "t", rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub enum Inbound {
    Attach,
    Open {
        id: u32,
        method: String,
        #[ts(type = "Array<unknown>")]
        args: Vec<Value>,
    },
    /// `open` with Blob arguments: `args` name each Blob as a [`BlobRefDto`], an index into
    /// `bytes`. `bytes` is base64 only in this enum's JSON form, which belongs to the test host's
    /// carrier: a raw carrier builds the variant with raw bytes and must not send the JSON form.
    OpenBytes {
        id: u32,
        method: String,
        #[ts(type = "Array<unknown>")]
        args: Vec<Value>,
        #[serde(with = "base64_blobs")]
        #[ts(type = "Array<string>")]
        bytes: Vec<Vec<u8>>,
    },
    Close {
        id: u32,
    },
}

// The ids, the methods and the Blobs' lengths only: `args` hold tokens and `bytes` hold content.
impl fmt::Debug for Inbound {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Attach => f.write_str("Attach"),
            Self::Open { id, method, .. } => f
                .debug_struct("Open")
                .field("id", id)
                .field("method", method)
                .finish_non_exhaustive(),
            Self::OpenBytes {
                id, method, bytes, ..
            } => f
                .debug_struct("OpenBytes")
                .field("id", id)
                .field("method", method)
                .field("bytes", &bytes.iter().map(Vec::len).collect::<Vec<_>>())
                .finish_non_exhaustive(),
            Self::Close { id } => f.debug_struct("Close").field("id", id).finish(),
        }
    }
}

/// A Blob's place in `args`: `{ "$blob": n }`, an index into `OpenBytes::bytes`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, TS)]
#[ts(export, export_to = DTO)]
pub struct BlobRefDto {
    #[serde(rename = "$blob")]
    pub index: u32,
}

mod base64_blobs {
    use super::{Base64, Standard};
    use serde::{Deserialize, Deserializer, de::Error};

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Vec<u8>>, D::Error> {
        Vec::<String>::deserialize(d)?
            .iter()
            .map(|text| {
                let bytes: Base64<Standard, Vec<u8>> =
                    Base64::parse(text).map_err(|_| D::Error::custom("a blob is not base64"))?;
                Ok(bytes.into_inner())
            })
            .collect()
    }
}

/// A message from the engine to TypeScript about the stream `id`.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(tag = "k", rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub enum Frame {
    Next {
        id: u32,
        #[ts(type = "unknown")]
        v: Value,
    },
    Complete {
        id: u32,
    },
    Error {
        id: u32,
        e: Fault,
    },
}

/// A failure of the engine or the protocol, as opposed to an expected engine failure.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct Fault {
    pub kind: FaultKind,
    #[ts(type = "string")]
    pub code: FaultCode,
    pub diagnostic: String,
}

impl Fault {
    /// A fault of the kind `code` belongs to. The diagnostic quotes no value: faults are logged.
    pub fn new(code: FaultCode, diagnostic: impl Into<String>) -> Self {
        Self {
            kind: code.kind(),
            code,
            diagnostic: diagnostic.into(),
        }
    }
}

/// A fault's `code`, on the wire as kebab-case text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(into = "&'static str")]
pub enum FaultCode {
    Panic,
    BadArgs,
    UnknownMethod,
    StartFailed,
    ClientBuildFailed,
    StoreFailed,
    Unsupported,
    SerializeFailed,
}

impl FaultCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Panic => "panic",
            Self::BadArgs => "bad-args",
            Self::UnknownMethod => "unknown-method",
            Self::StartFailed => "start-failed",
            Self::ClientBuildFailed => "client-build-failed",
            Self::StoreFailed => "store-failed",
            Self::Unsupported => "unsupported",
            Self::SerializeFailed => "serialize-failed",
        }
    }

    fn kind(self) -> FaultKind {
        match self {
            Self::BadArgs | Self::UnknownMethod | Self::Unsupported => FaultKind::Protocol,
            Self::Panic
            | Self::StartFailed
            | Self::ClientBuildFailed
            | Self::StoreFailed
            | Self::SerializeFailed => FaultKind::Internal,
        }
    }
}

impl From<FaultCode> for &'static str {
    fn from(code: FaultCode) -> Self {
        code.as_str()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = DTO)]
pub enum FaultKind {
    Protocol,
    Internal,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn to_json(frame: Frame) -> serde_json::Value {
        serde_json::to_value(frame).unwrap()
    }

    #[test]
    fn frames_carry_their_kind_in_k() {
        assert_eq!(
            to_json(Frame::Next {
                id: 3,
                v: json!(null)
            }),
            json!({"k": "next", "id": 3, "v": null})
        );
        assert_eq!(
            to_json(Frame::Complete { id: 3 }),
            json!({"k": "complete", "id": 3})
        );
        let fault = Fault::new(FaultCode::UnknownMethod, "no method x.y");
        assert_eq!(
            to_json(Frame::Error { id: 3, e: fault }),
            json!({
                "k": "error",
                "id": 3,
                "e": {"kind": "protocol", "code": "unknown-method", "diagnostic": "no method x.y"},
            })
        );
    }

    #[test]
    fn inbound_messages_carry_their_kind_in_t() {
        let decode = |value| serde_json::from_value::<Inbound>(value).unwrap();
        assert_eq!(
            decode(json!({"t": "open", "id": 1, "method": "homeserver.probe", "args": ["@a:b"]})),
            Inbound::Open {
                id: 1,
                method: "homeserver.probe".into(),
                args: vec![json!("@a:b")],
            }
        );
        assert_eq!(decode(json!({"t": "attach"})), Inbound::Attach);
        assert_eq!(
            decode(json!({"t": "close", "id": 1})),
            Inbound::Close { id: 1 }
        );
    }

    #[test]
    fn an_open_bytes_line_decodes_each_blob() {
        let line = r#"{"t":"openBytes","id":1,"method":"m.n","args":[{"$blob":0}],"bytes":["AQID","","BA==","BA"]}"#;
        let Inbound::OpenBytes { bytes, .. } = serde_json::from_str(line).unwrap() else {
            panic!("not an openBytes");
        };
        assert_eq!(bytes, [vec![1, 2, 3], vec![], vec![4], vec![4]]);
    }

    #[test]
    fn bad_base64_fails_the_line_and_quotes_nothing() {
        let line = r#"{"t":"openBytes","id":1,"method":"m.n","args":[],"bytes":["!!secret!!"]}"#;
        let err = serde_json::from_str::<Inbound>(line).unwrap_err();
        assert!(!err.to_string().contains("secret"), "{err}");
    }

    #[test]
    fn a_blob_ref_reads_its_index_from_the_dollar_key() {
        let blob: BlobRefDto = serde_json::from_str(r#"{"$blob":2}"#).unwrap();
        assert_eq!(blob, BlobRefDto { index: 2 });
    }
}
