//! Routes an `"engine.member"` call with positional args to the engine method that serves it.

use std::any::type_name;

use matrix_sdk::SendOutsideWasm;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::{
    engines::homeserver,
    wire::{Fault, FaultKind},
};

/// An engine method's output: a `BoxStream`, but a `LocalBoxStream` on wasm, where the SDK's
/// futures and `Client` are not `Send`. [`stream`] is the one place that asks for `Send`, and only
/// outside wasm. The carrier runs it with `matrix_sdk::executor::spawn`, which also needs `Send`
/// only outside wasm, so nothing else ties an engine method to `Send`.
pub type Stream = matrix_sdk::stream::BoxStream<'static, Result<Value, Fault>>;

/// Boxes `s` as a [`Stream`].
pub fn stream(
    s: impl futures_util::Stream<Item = Result<Value, Fault>> + SendOutsideWasm + 'static,
) -> Stream {
    matrix_sdk::stream::StreamExt::boxed(s)
}

/// Defines `dispatch` over `"engine.member" => function(arg: Type, ..)` entries. Each function
/// takes the engine, then the decoded positional args, and returns a [`Stream`].
macro_rules! methods {
    ($($name:literal => $($serve:ident)::+ ( $($arg:ident : $ty:ty),* $(,)? )),* $(,)?) => {
        pub fn dispatch(
            engine: &std::sync::Arc<$crate::accounts::Engine>,
            method: &str,
            args: Vec<serde_json::Value>,
        ) -> Result<$crate::dispatch::Stream, $crate::wire::Fault> {
            match method {
                $($name => {
                    let args = &mut $crate::dispatch::Args::new(method, args);
                    $(let $arg: $ty = args.decode()?;)*
                    args.finish()?;
                    Ok($($serve)::+(std::sync::Arc::clone(engine), $($arg),*))
                })*
                _ => {
                    let _ = (engine, args);
                    Err($crate::dispatch::protocol("unknown-method", format!("no method {method}")))
                }
            }
        }
    };
}

methods! {
    "homeserver.probe" => homeserver::probe(account_id: String),
}

/// Decodes positional args in order. Its `bad-args` faults name the position and the type
/// classes but never quote a value: args carry access tokens and passwords.
pub struct Args<'a> {
    method: &'a str,
    values: std::vec::IntoIter<Value>,
    position: usize,
}

impl<'a> Args<'a> {
    pub fn new(method: &'a str, args: Vec<Value>) -> Self {
        Self {
            method,
            values: args.into_iter(),
            position: 0,
        }
    }

    pub fn decode<T: DeserializeOwned>(&mut self) -> Result<T, Fault> {
        let position = self.position;
        self.position += 1;
        let value = self
            .values
            .next()
            .ok_or_else(|| self.bad(format!("arg {position}: missing")))?;
        let found = type_class(&value);
        serde_json::from_value(value).map_err(|_| {
            let expected = type_name::<T>();
            self.bad(format!(
                "arg {position}: expected {expected}, found {found}"
            ))
        })
    }

    /// Fails if args are left over.
    pub fn finish(&self) -> Result<(), Fault> {
        match self.values.len() {
            0 => Ok(()),
            extra => Err(self.bad(format!(
                "expected {} args, found {}",
                self.position,
                self.position + extra
            ))),
        }
    }

    fn bad(&self, detail: String) -> Fault {
        protocol("bad-args", format!("{}: {detail}", self.method))
    }
}

fn type_class(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

pub fn protocol(code: &str, diagnostic: String) -> Fault {
    Fault {
        kind: FaultKind::Protocol,
        code: code.into(),
        diagnostic,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures_util::{FutureExt, StreamExt, future::ready, stream};
    use serde_json::json;

    use super::*;
    use crate::{accounts::Engine, config::EngineConfig};

    fn pair(_: Arc<Engine>, text: String, count: u32) -> Stream {
        stream(stream::once(ready(Ok(json!([text, count])))))
    }

    fn none(_: Arc<Engine>) -> Stream {
        stream(stream::once(ready(Ok(json!(null)))))
    }

    mod table {
        use super::{none, pair};

        methods! {
            "test.pair" => pair(text: String, count: u32),
            "test.none" => none(),
        }
    }

    fn code(result: Result<Stream, Fault>) -> String {
        let fault = result.err().expect("a fault");
        assert_eq!(fault.kind, FaultKind::Protocol);
        fault.code
    }

    #[test]
    fn methods_decode_positional_args_in_order() {
        let engine = Engine::new(EngineConfig::default());
        let mut stream = table::dispatch(&engine, "test.pair", vec![json!("x"), json!(2)]).unwrap();
        let first = stream.next().now_or_never().flatten().unwrap().unwrap();
        assert_eq!(first, json!(["x", 2]));
    }

    #[test]
    fn methods_reject_a_wrong_count_or_type_as_bad_args() {
        let engine = Engine::new(EngineConfig::default());
        for args in [
            vec![json!("x")],
            vec![json!("x"), json!(2), json!(3)],
            vec![json!(2), json!("x")],
        ] {
            assert_eq!(
                code(table::dispatch(&engine, "test.pair", args)),
                "bad-args"
            );
        }
    }

    #[test]
    fn zero_arg_method_accepts_empty_args() {
        let engine = Engine::new(EngineConfig::default());
        assert!(table::dispatch(&engine, "test.none", vec![]).is_ok());
        assert_eq!(
            code(table::dispatch(&engine, "test.none", vec![json!(1)])),
            "bad-args"
        );
    }

    #[test]
    fn an_unknown_method_is_a_protocol_fault() {
        let engine = Engine::new(EngineConfig::default());
        assert_eq!(
            code(dispatch(&engine, "nope.nothing", vec![])),
            "unknown-method"
        );
        assert_eq!(
            code(table::dispatch(&engine, "nope.nothing", vec![])),
            "unknown-method"
        );
    }
}
