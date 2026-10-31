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

/// Where the read marker sits among the rows. The SDK puts it right after the fully-read item;
/// js puts it before the first unread message, past any state items. So the fold drops the SDK's
/// marker like a divider, and this one places its own among the rows a client holds.
#[derive(Debug, Default)]
pub(super) struct Marker {
    /// The marker's row, and how many rows the client holds with it.
    at: Option<usize>,
    len: usize,
}

impl Marker {
    /// `diffs` over the rows without the marker, as diffs over the rows with it.
    pub(super) fn apply<T: Clone>(
        &mut self,
        diffs: Vec<VectorDiffDto<T>>,
    ) -> Vec<VectorDiffDto<T>> {
        let before = |at: Option<usize>, index: usize| at.is_none_or(|at| index < at);
        let mut out = Vec::with_capacity(diffs.len());
        for diff in diffs {
            match diff {
                VectorDiffDto::Append { values } => {
                    self.len += values.len();
                    out.push(VectorDiffDto::Append { values });
                }
                VectorDiffDto::PushBack { value } => {
                    self.len += 1;
                    out.push(VectorDiffDto::PushBack { value });
                }
                VectorDiffDto::PushFront { value } => {
                    self.len += 1;
                    self.at = self.at.map(|at| at + 1);
                    out.push(VectorDiffDto::PushFront { value });
                }
                VectorDiffDto::Insert { index, value } => {
                    let index = usize::try_from(index).unwrap_or(usize::MAX);
                    // At the marker's own place the row goes before it.
                    let client = if self.at.is_none_or(|at| index <= at) {
                        index
                    } else {
                        index + 1
                    };
                    if self.at.is_some_and(|at| index <= at) {
                        self.at = self.at.map(|at| at + 1);
                    }
                    self.len += 1;
                    out.push(VectorDiffDto::Insert {
                        index: saturated(client),
                        value,
                    });
                }
                VectorDiffDto::Set { index, value } => {
                    let index = usize::try_from(index).unwrap_or(usize::MAX);
                    let client = if before(self.at, index) {
                        index
                    } else {
                        index + 1
                    };
                    out.push(VectorDiffDto::Set {
                        index: saturated(client),
                        value,
                    });
                }
                VectorDiffDto::Remove { index } => {
                    let index = usize::try_from(index).unwrap_or(usize::MAX);
                    let client = if before(self.at, index) {
                        index
                    } else {
                        index + 1
                    };
                    if self.at.is_some_and(|at| index < at) {
                        self.at = self.at.map(|at| at - 1);
                    }
                    self.len -= 1;
                    out.push(VectorDiffDto::Remove {
                        index: saturated(client),
                    });
                }
                VectorDiffDto::PopFront => {
                    self.len -= 1;
                    match self.at {
                        Some(0) => out.push(VectorDiffDto::Remove { index: 1 }),
                        _ => {
                            self.at = self.at.map(|at| at - 1);
                            out.push(VectorDiffDto::PopFront);
                        }
                    }
                }
                VectorDiffDto::PopBack => {
                    self.len -= 1;
                    if self.at == Some(self.len) {
                        // The marker was last: the row before it goes.
                        out.push(VectorDiffDto::Remove {
                            index: saturated(self.len - 1),
                        });
                        self.at = Some(self.len - 1);
                    } else {
                        out.push(VectorDiffDto::PopBack);
                    }
                }
                VectorDiffDto::Truncate { length } => {
                    let length = usize::try_from(length).unwrap_or(usize::MAX);
                    match self.at {
                        Some(at) if at < length => {
                            self.len = length + 1;
                            out.push(VectorDiffDto::Truncate {
                                length: saturated(length + 1),
                            });
                        }
                        _ => {
                            self.at = None;
                            self.len = length.min(self.len);
                            out.push(VectorDiffDto::Truncate {
                                length: saturated(length),
                            });
                        }
                    }
                }
                VectorDiffDto::Reset { values } => {
                    self.at = None;
                    self.len = values.len();
                    out.push(VectorDiffDto::Reset { values });
                }
                VectorDiffDto::Clear => {
                    (self.at, self.len) = (None, 0);
                    out.push(VectorDiffDto::Clear);
                }
            }
        }
        out
    }

    /// The diffs that put the marker before the row at `target` of the rows without it (the
    /// end for the row count), or remove it for `None`.
    pub(super) fn place<T>(&mut self, target: Option<(usize, T)>) -> Vec<VectorDiffDto<T>> {
        let mut out = Vec::new();
        if let Some(at) = self.at
            && target.as_ref().map(|(index, _)| *index) != Some(at)
        {
            out.push(VectorDiffDto::Remove {
                index: saturated(at),
            });
            (self.at, self.len) = (None, self.len - 1);
        }
        if let (None, Some((index, marker))) = (self.at, target) {
            out.push(VectorDiffDto::Insert {
                index: saturated(index),
                value: marker,
            });
            (self.at, self.len) = (Some(index), self.len + 1);
        }
        out
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

    const MARKER: u8 = 99;

    fn marked(rows: &[u8], at: Option<usize>) -> (Marker, Vec<u8>) {
        let mut client = rows.to_vec();
        if let Some(at) = at {
            client.insert(at, MARKER);
        }
        (
            Marker {
                at,
                len: client.len(),
            },
            client,
        )
    }

    #[test]
    fn every_op_keeps_the_marker_among_the_rows() {
        let ops = [
            VectorDiffDto::Append { values: vec![5, 6] },
            VectorDiffDto::Clear,
            VectorDiffDto::PushFront { value: 7 },
            VectorDiffDto::PushBack { value: 7 },
            VectorDiffDto::PopFront,
            VectorDiffDto::PopBack,
            VectorDiffDto::Insert { index: 0, value: 7 },
            VectorDiffDto::Insert { index: 2, value: 7 },
            VectorDiffDto::Insert { index: 4, value: 7 },
            VectorDiffDto::Set { index: 1, value: 7 },
            VectorDiffDto::Set { index: 2, value: 7 },
            VectorDiffDto::Remove { index: 1 },
            VectorDiffDto::Remove { index: 2 },
            VectorDiffDto::Remove { index: 3 },
            VectorDiffDto::Truncate { length: 1 },
            VectorDiffDto::Truncate { length: 2 },
            VectorDiffDto::Truncate { length: 3 },
            VectorDiffDto::Reset { values: vec![8, 9] },
        ];
        for op in ops {
            for at in [None, Some(0), Some(2), Some(4)] {
                let label = format!("{op:?} with the marker at {at:?}");
                let mut base = vec![1, 2, 3, 4];
                let (mut marker, mut client) = marked(&base, at);
                rows_apply(&mut base, op.clone());
                for diff in marker.apply(vec![op.clone()]) {
                    rows_apply(&mut client, diff);
                }
                let without: Vec<u8> = client.iter().copied().filter(|r| *r != MARKER).collect();
                assert_eq!(without, base, "{label}");
                assert_eq!(client.len(), marker.len, "{label}");
                assert_eq!(
                    client.iter().position(|r| *r == MARKER),
                    marker.at,
                    "{label}"
                );
            }
        }
    }

    #[test]
    fn the_marker_moves_to_its_target_and_goes() {
        let rows = [1, 2, 3, 4];
        let (mut marker, mut client) = marked(&rows, Some(1));
        for target in [Some(3), Some(0), Some(4), Some(4), None, None, Some(2)] {
            for diff in marker.place(target.map(|index| (index, MARKER))) {
                rows_apply(&mut client, diff);
            }
            let (_, expected) = marked(&rows, target);
            assert_eq!(client, expected, "{target:?}");
        }
    }
}
