//! The carrier-neutral frames between the TypeScript transport and the engine.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

const DTO: &str = "util/matrix/src/lib/engine-transport/rust-dto/";

/// A message from TypeScript to the engine.
#[derive(Debug, PartialEq, Deserialize, TS)]
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
    Close {
        id: u32,
    },
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
    pub code: String,
    pub diagnostic: String,
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
        let fault = Fault {
            kind: FaultKind::Protocol,
            code: "unknown-method".into(),
            diagnostic: "no method x.y".into(),
        };
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
}
