//! The list updates a stream sends, mirroring `VectorDiff` in
//! `libs/util/matrix/src/lib/vector-diff.ts`.

use serde::Serialize;
use ts_rs::TS;

const DTO: &str = "util/matrix/src/lib/rust-dto/";

const MAX_BATCH: usize = 256;

/// Every op of `VectorDiff`. The room list emits four.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "op", rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub enum VectorDiffDto<T> {
    Append { values: Vec<T> },
    Clear,
    PushFront { value: T },
    PushBack { value: T },
    PopFront,
    PopBack,
    Insert { index: u32, value: T },
    Set { index: u32, value: T },
    Remove { index: u32 },
    Truncate { length: u32 },
    Reset { values: Vec<T> },
}

/// At most `MAX_BATCH` diffs per frame, in order (O8: a reset counts as one and is never split).
pub(crate) fn frames<T>(diffs: Vec<VectorDiffDto<T>>) -> Vec<Vec<VectorDiffDto<T>>> {
    let mut diffs = diffs.into_iter().peekable();
    let mut frames = Vec::new();
    while diffs.peek().is_some() {
        frames.push(diffs.by_ref().take(MAX_BATCH).collect());
    }
    frames
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn every_op_serialises_as_the_typescript_union_names_it() {
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
        assert_eq!(
            to_json(VectorDiffDto::Append { values: vec![1] }),
            json!({"op": "append", "values": [1]})
        );
        assert_eq!(to_json(VectorDiffDto::Clear), json!({"op": "clear"}));
        assert_eq!(
            to_json(VectorDiffDto::PushFront { value: 1 }),
            json!({"op": "pushFront", "value": 1})
        );
        assert_eq!(to_json(VectorDiffDto::PopFront), json!({"op": "popFront"}));
        assert_eq!(to_json(VectorDiffDto::PopBack), json!({"op": "popBack"}));
        assert_eq!(
            to_json(VectorDiffDto::Insert { index: 2, value: 1 }),
            json!({"op": "insert", "index": 2, "value": 1})
        );
        assert_eq!(
            to_json(VectorDiffDto::Truncate { length: 3 }),
            json!({"op": "truncate", "length": 3})
        );
    }

    #[test]
    fn frames_hold_at_most_256_diffs_in_order() {
        let diffs: Vec<_> = (0..600)
            .map(|n| VectorDiffDto::Set { index: n, value: n })
            .collect();
        let framed = frames(diffs.clone());
        let lengths: Vec<_> = framed.iter().map(Vec::len).collect();
        assert_eq!(lengths, [256, 256, 88]);
        assert_eq!(framed.concat(), diffs);
    }

    #[test]
    fn a_reset_is_one_item_whatever_its_length() {
        let framed = frames(vec![VectorDiffDto::Reset {
            values: vec![0u32; 600],
        }]);
        assert_eq!(framed.len(), 1);
        assert_eq!(framed[0].len(), 1);
    }

    #[test]
    fn no_diffs_make_no_frames() {
        assert!(frames::<u8>(vec![]).is_empty());
    }
}
