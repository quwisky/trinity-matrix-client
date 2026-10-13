/**
 * `value` without its trailing run of characters from `set`.
 *
 * Walks back from the end one character at a time, so it is linear in the length of the
 * run. An anchored regex such as `/[…]+$/` is not: on a long run followed by another
 * character the engine retries the run from every start position, which is quadratic and
 * lets one long message stall rendering. `set` holds single UTF-16 code units.
 */
export function trimTrailing(value: string, set: string): string {
  let end = value.length;
  while (end > 0 && set.includes(value[end - 1])) {
    end--;
  }
  return end === value.length ? value : value.slice(0, end);
}
