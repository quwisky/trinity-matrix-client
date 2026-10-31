//! Rewrites the SDK's timeline diffs to `TimelineEngine`'s: the SDK inserts date dividers with no
//! off switch, and the interface has none, so every index past one must move.

use matrix_sdk_ui::eyeball_im::VectorDiff;

use crate::{engines::room_list::rows::saturated, vector_diff::VectorDiffDto};

/// Which of the SDK's indexes are dividers.
#[derive(Debug, Default)]
pub(super) struct Fold {
    dividers: Vec<bool>,
}

impl Fold {
    /// The diffs that bring the rows without dividers up to date with `diff`.
    pub(super) fn apply<T: Clone>(
        &mut self,
        diff: VectorDiff<T>,
        is_divider: impl Fn(&T) -> bool,
    ) -> Vec<VectorDiffDto<T>> {
        let shown = |dividers: &[bool], index: usize| {
            saturated(
                dividers[..index]
                    .iter()
                    .filter(|divider| !**divider)
                    .count(),
            )
        };
        let kept = |values: &mut dyn Iterator<Item = T>, dividers: &mut Vec<bool>| {
            let mut rows = Vec::new();
            for value in values {
                let divider = is_divider(&value);
                dividers.push(divider);
                if !divider {
                    rows.push(value);
                }
            }
            rows
        };
        let diff = match diff {
            VectorDiff::Append { values } => {
                let values = kept(&mut values.into_iter(), &mut self.dividers);
                (!values.is_empty()).then_some(VectorDiffDto::Append { values })
            }
            VectorDiff::PushFront { value } => {
                let divider = is_divider(&value);
                self.dividers.insert(0, divider);
                (!divider).then_some(VectorDiffDto::PushFront { value })
            }
            VectorDiff::PushBack { value } => {
                let divider = is_divider(&value);
                self.dividers.push(divider);
                (!divider).then_some(VectorDiffDto::PushBack { value })
            }
            VectorDiff::Insert { index, value } => {
                let at = shown(&self.dividers, index);
                let divider = is_divider(&value);
                self.dividers.insert(index, divider);
                (!divider).then_some(VectorDiffDto::Insert { index: at, value })
            }
            VectorDiff::Set { index, value } => {
                let at = shown(&self.dividers, index);
                let divider = is_divider(&value);
                match (
                    std::mem::replace(&mut self.dividers[index], divider),
                    divider,
                ) {
                    (false, false) => Some(VectorDiffDto::Set { index: at, value }),
                    (false, true) => Some(VectorDiffDto::Remove { index: at }),
                    (true, false) => Some(VectorDiffDto::Insert { index: at, value }),
                    (true, true) => None,
                }
            }
            VectorDiff::Remove { index } => {
                let at = shown(&self.dividers, index);
                let divider = self.dividers.remove(index);
                (!divider).then_some(VectorDiffDto::Remove { index: at })
            }
            VectorDiff::Reset { values } => {
                self.dividers.clear();
                let values = kept(&mut values.into_iter(), &mut self.dividers);
                Some(VectorDiffDto::Reset { values })
            }
            VectorDiff::Clear => {
                self.dividers.clear();
                Some(VectorDiffDto::Clear)
            }
            VectorDiff::PopFront => {
                let divider = self.dividers.remove(0);
                (!divider).then_some(VectorDiffDto::PopFront)
            }
            VectorDiff::PopBack => {
                let divider = self.dividers.pop();
                (divider == Some(false)).then_some(VectorDiffDto::PopBack)
            }
            VectorDiff::Truncate { length } => {
                let gone = self.dividers.split_off(length);
                let length = shown(&self.dividers, length);
                gone.contains(&false)
                    .then_some(VectorDiffDto::Truncate { length })
            }
        };
        diff.into_iter().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A row, or a divider at `0`.
    fn folded(fold: &mut Fold, diff: VectorDiff<u8>) -> Vec<VectorDiffDto<u8>> {
        fold.apply(diff, |item| *item == 0)
    }

    fn sdk_apply(list: &mut Vec<u8>, diff: VectorDiff<u8>) {
        match diff {
            VectorDiff::Append { values } => list.extend(values),
            VectorDiff::Clear => list.clear(),
            VectorDiff::PushFront { value } => list.insert(0, value),
            VectorDiff::PushBack { value } => list.push(value),
            VectorDiff::PopFront => drop(list.remove(0)),
            VectorDiff::PopBack => drop(list.pop()),
            VectorDiff::Insert { index, value } => list.insert(index, value),
            VectorDiff::Set { index, value } => list[index] = value,
            VectorDiff::Remove { index } => drop(list.remove(index)),
            VectorDiff::Truncate { length } => list.truncate(length),
            VectorDiff::Reset { values } => *list = values.into_iter().collect(),
        }
    }

    fn rows_apply(rows: &mut Vec<u8>, diff: VectorDiffDto<u8>) {
        let at = |index: u32| usize::try_from(index).unwrap();
        match diff {
            VectorDiffDto::Append { values } => rows.extend(values),
            VectorDiffDto::Clear => rows.clear(),
            VectorDiffDto::PushFront { value } => rows.insert(0, value),
            VectorDiffDto::PushBack { value } => rows.push(value),
            VectorDiffDto::PopFront => drop(rows.remove(0)),
            VectorDiffDto::PopBack => drop(rows.pop()),
            VectorDiffDto::Insert { index, value } => rows.insert(at(index), value),
            VectorDiffDto::Set { index, value } => rows[at(index)] = value,
            VectorDiffDto::Remove { index } => drop(rows.remove(at(index))),
            VectorDiffDto::Truncate { length } => rows.truncate(at(length)),
            VectorDiffDto::Reset { values } => *rows = values,
        }
    }

    fn shown(list: &[u8]) -> Vec<u8> {
        list.iter().copied().filter(|item| *item != 0).collect()
    }

    /// `[0, 1, 2, 0, 3, 4, 0, 5]`, applied to a fold that has seen it.
    fn seeded() -> (Fold, Vec<u8>, Vec<u8>) {
        let list = vec![0, 1, 2, 0, 3, 4, 0, 5];
        let mut fold = Fold::default();
        let mut rows = Vec::new();
        let values = list.iter().copied().collect();
        for diff in folded(&mut fold, VectorDiff::Reset { values }) {
            rows_apply(&mut rows, diff);
        }
        (fold, list, rows)
    }

    #[test]
    fn every_sdk_op_rewrites_past_the_dividers() {
        let values = |items: &[u8]| items.iter().copied().collect();
        let table = [
            VectorDiff::Append {
                values: values(&[0, 6, 0, 7]),
            },
            VectorDiff::Clear,
            VectorDiff::PushFront { value: 9 },
            VectorDiff::PushBack { value: 9 },
            VectorDiff::PopFront,
            VectorDiff::PopBack,
            VectorDiff::Insert { index: 3, value: 9 },
            VectorDiff::Insert { index: 8, value: 9 },
            VectorDiff::Set { index: 4, value: 9 },
            VectorDiff::Set { index: 4, value: 0 },
            VectorDiff::Set { index: 3, value: 9 },
            VectorDiff::Remove { index: 7 },
            VectorDiff::Remove { index: 1 },
            VectorDiff::Truncate { length: 5 },
            VectorDiff::Truncate { length: 3 },
            VectorDiff::Reset {
                values: values(&[0, 8, 0]),
            },
        ];
        for diff in table {
            let label = format!("{diff:?}");
            let (mut fold, mut list, mut rows) = seeded();
            sdk_apply(&mut list, diff.clone());
            for row_diff in folded(&mut fold, diff) {
                rows_apply(&mut rows, row_diff);
            }
            assert_eq!(rows, shown(&list), "{label}");
        }
    }

    #[test]
    fn a_sequence_keeps_the_indexes_true() {
        let (mut fold, mut list, mut rows) = seeded();
        let script = [
            VectorDiff::Remove { index: 3 },
            VectorDiff::PushFront { value: 0 },
            VectorDiff::Insert { index: 1, value: 6 },
            VectorDiff::Set { index: 2, value: 7 },
            VectorDiff::PopBack,
            VectorDiff::Truncate { length: 5 },
            VectorDiff::Set { index: 4, value: 8 },
        ];
        for diff in script {
            sdk_apply(&mut list, diff.clone());
            for row_diff in folded(&mut fold, diff) {
                rows_apply(&mut rows, row_diff);
            }
            assert_eq!(rows, shown(&list));
        }
    }

    #[test]
    fn a_divider_op_yields_no_diff() {
        let (mut fold, ..) = seeded();
        let quiet = [
            VectorDiff::Append {
                values: [0].into_iter().collect(),
            },
            VectorDiff::PushBack { value: 0 },
            VectorDiff::PopBack,
            VectorDiff::Insert { index: 1, value: 0 },
            VectorDiff::Remove { index: 1 },
            VectorDiff::Set { index: 3, value: 0 },
            VectorDiff::PushFront { value: 0 },
            VectorDiff::PopFront,
            VectorDiff::PopFront,
        ];
        for diff in quiet {
            let label = format!("{diff:?}");
            assert_eq!(folded(&mut fold, diff), [], "{label}");
        }
    }

    #[test]
    fn a_reset_keeps_only_events() {
        let mut fold = Fold::default();
        let values = [0, 1, 0, 2].into_iter().collect();
        assert_eq!(
            folded(&mut fold, VectorDiff::Reset { values }),
            [VectorDiffDto::Reset { values: vec![1, 2] }]
        );
        assert_eq!(
            folded(&mut fold, VectorDiff::Remove { index: 3 }),
            [VectorDiffDto::Remove { index: 1 }]
        );
    }

    #[test]
    fn truncate_counts_only_shown_rows() {
        let (mut fold, ..) = seeded();
        assert_eq!(
            folded(&mut fold, VectorDiff::Truncate { length: 7 }),
            [VectorDiffDto::Truncate { length: 4 }]
        );
        assert_eq!(
            folded(&mut fold, VectorDiff::Truncate { length: 6 }),
            [],
            "only a divider went"
        );
        assert_eq!(
            folded(&mut fold, VectorDiff::Remove { index: 5 }),
            [VectorDiffDto::Remove { index: 3 }],
            "the dividers past the length are forgotten"
        );
    }
}
