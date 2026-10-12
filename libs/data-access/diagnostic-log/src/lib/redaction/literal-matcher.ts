/** How many characters or states one build step handles before it may pause. */
const BUILD_STEP = 4_096;
/** Transitions are keyed by `state * UNIT_RANGE + UTF-16 code unit`. */
const UNIT_RANGE = 0x10000;

/**
 * Finds known literal strings in text by exact substring, leftmost first and, at each
 * position, longest first. An Aho–Corasick automaton over the reversed literals, run from
 * the end of the text, gives the longest literal starting at every position in one linear
 * pass; a forward walk then takes them left to right. No pattern is built from the
 * literals, so neither their content nor their number can make a line slow to scan.
 */
export class LiteralMatcher {
  private readonly next = new Map<number, number>();
  private readonly fail: number[] = [0];
  /** The longest literal ending a path through this state, or 0. */
  private readonly longest: number[] = [0];
  // Each state's children as a linked list, for the breadth-first linking pass.
  private readonly firstChild: number[] = [0];
  private readonly nextSibling: number[] = [0];
  private readonly unit: number[] = [0];
  /** Reused across lines: the longest literal starting at each position of the last line. */
  private lengths = new Int32Array(0);

  private constructor() {
    // Built through `build`.
  }

  /**
   * Build a matcher over `literals`, pausing (`yield`) every few thousand characters so a
   * caller running in slices never holds the main thread for a whole large set.
   */
  static *build(literals: Iterable<string>): Generator<void, LiteralMatcher> {
    const matcher = new LiteralMatcher();
    let work = 0;
    for (const literal of literals) {
      matcher.insertReversed(literal);
      work += literal.length;
      if (work >= BUILD_STEP) {
        work = 0;
        yield;
      }
    }
    yield* matcher.link();
    return matcher;
  }

  /** Replace every match with `replace(literal)`, leftmost first, longest first. */
  replace(text: string, replace: (literal: string) => string): string {
    if (this.fail.length === 1 || text.length === 0) {
      return text;
    }
    const lengths = this.longestFrom(text);
    let output = '';
    let copied = 0;
    for (let position = 0; position < text.length;) {
      const length = lengths[position];
      if (length === 0) {
        position += 1;
        continue;
      }
      output +=
        text.slice(copied, position) +
        replace(text.slice(position, position + length));
      position += length;
      copied = position;
    }
    return copied === 0 ? text : output + text.slice(copied);
  }

  private insertReversed(literal: string): void {
    let state = 0;
    for (let index = literal.length - 1; index >= 0; index -= 1) {
      const unit = literal.charCodeAt(index);
      const key = state * UNIT_RANGE + unit;
      let child = this.next.get(key);
      if (child === undefined) {
        child = this.fail.length;
        this.fail.push(0);
        this.longest.push(0);
        this.unit.push(unit);
        this.firstChild.push(0);
        this.nextSibling.push(this.firstChild[state]);
        this.firstChild[state] = child;
        this.next.set(key, child);
      }
      state = child;
    }
    this.longest[state] = Math.max(this.longest[state], literal.length);
  }

  /** Failure links, breadth first, and with them the longest literal reachable by failing. */
  private *link(): Generator<void, void> {
    const queue: number[] = [0];
    for (let head = 0; head < queue.length; head += 1) {
      const state = queue[head];
      for (
        let child = this.firstChild[state];
        child !== 0;
        child = this.nextSibling[child]
      ) {
        if (state !== 0) {
          const unit = this.unit[child];
          let fallback = this.fail[state];
          let target = this.next.get(fallback * UNIT_RANGE + unit);
          while (target === undefined && fallback !== 0) {
            fallback = this.fail[fallback];
            target = this.next.get(fallback * UNIT_RANGE + unit);
          }
          this.fail[child] = target ?? 0;
        }
        this.longest[child] = Math.max(
          this.longest[child],
          this.longest[this.fail[child]],
        );
        queue.push(child);
      }
      if (head % BUILD_STEP === BUILD_STEP - 1) {
        yield;
      }
    }
  }

  /** For each position, the length of the longest literal that starts there. */
  private longestFrom(text: string): Int32Array {
    if (this.lengths.length < text.length) {
      this.lengths = new Int32Array(
        Math.max(text.length, 2 * this.lengths.length),
      );
    }
    const lengths = this.lengths;
    let state = 0;
    for (let index = text.length - 1; index >= 0; index -= 1) {
      const unit = text.charCodeAt(index);
      let child = this.next.get(state * UNIT_RANGE + unit);
      while (child === undefined && state !== 0) {
        state = this.fail[state];
        child = this.next.get(state * UNIT_RANGE + unit);
      }
      state = child ?? 0;
      lengths[index] = this.longest[state];
    }
    return lengths;
  }
}
