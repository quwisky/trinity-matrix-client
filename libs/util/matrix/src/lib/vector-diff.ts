/** One step of a list update, in the shape the SDK's room-list stream emits. */
export type VectorDiff<T> =
  | { op: 'append'; values: readonly T[] }
  | { op: 'clear' }
  | { op: 'pushFront' | 'pushBack'; value: T }
  | { op: 'popFront' | 'popBack' }
  | { op: 'insert' | 'set'; index: number; value: T }
  | { op: 'remove'; index: number }
  | { op: 'truncate'; length: number }
  | { op: 'reset'; values: readonly T[] };

function checkIndex(index: number, length: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new RangeError(`Index ${index} is out of range for length ${length}`);
  }
}

/** Folds `diffs` over `list`; copies once per call and returns `list` itself when `diffs` is empty. */
export function applyVectorDiffs<T>(
  list: readonly T[],
  diffs: readonly VectorDiff<T>[],
): readonly T[] {
  if (diffs.length === 0) return list;
  let out = [...list];
  for (const diff of diffs) {
    switch (diff.op) {
      case 'append':
        out.push(...diff.values);
        break;
      case 'clear':
        out = [];
        break;
      case 'pushFront':
        out.unshift(diff.value);
        break;
      case 'pushBack':
        out.push(diff.value);
        break;
      case 'popFront':
        out.shift();
        break;
      case 'popBack':
        out.pop();
        break;
      case 'insert':
        if (diff.index !== out.length) checkIndex(diff.index, out.length);
        out.splice(diff.index, 0, diff.value);
        break;
      case 'set':
        checkIndex(diff.index, out.length);
        out[diff.index] = diff.value;
        break;
      case 'remove':
        checkIndex(diff.index, out.length);
        out.splice(diff.index, 1);
        break;
      case 'truncate':
        out.length = Math.min(out.length, diff.length);
        break;
      case 'reset':
        out = [...diff.values];
        break;
    }
  }
  return out;
}
