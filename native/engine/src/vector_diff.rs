//! The list updates a stream sends, mirroring `VectorDiff` in
//! `libs/util/matrix/src/lib/vector-diff.ts`.

use serde::Serialize;
use ts_rs::TS;

const DTO: &str = "util/matrix/src/lib/rust-dto/";

/// The ops the room list emits; the timeline adds the rest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "op", rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub enum VectorDiffDto<T> {
    Reset { values: Vec<T> },
    PushBack { value: T },
    Set { index: u32, value: T },
    Remove { index: u32 },
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn room_list_diffs_serialise_with_op_tags() {
        let to_json = |diff: VectorDiffDto<u8>| serde_json::to_value(diff).unwrap();
        assert_eq!(
            to_json(VectorDiffDto::Reset { values: vec![] }),
            json!({"op": "reset", "values": []})
        );
        assert_eq!(
            to_json(VectorDiffDto::PushBack { value: 1 }),
            json!({"op": "pushBack", "value": 1})
        );
        assert_eq!(
            to_json(VectorDiffDto::Set { index: 2, value: 1 }),
            json!({"op": "set", "index": 2, "value": 1})
        );
        assert_eq!(
            to_json(VectorDiffDto::Remove { index: 0 }),
            json!({"op": "remove", "index": 0})
        );
    }
}
