import { SPACED_WORD, wordUnitClass } from './word-units';

/** One string to find, and which of its edges must fall on a word boundary. */
export interface MatcherLiteral {
  readonly text: string;
  /** If it starts with a letter or digit, the unit before it must not be one. */
  readonly checkStart: boolean;
  /** If it ends with a letter or digit, the unit after it must not be one. */
  readonly checkEnd: boolean;
}

/** A `[start, end)` range of the text that a match may contain whole but never cut. */
export type ProtectedSpan = readonly [start: number, end: number];

/**
 * What replaces a match: text for the literal alone, or text for a longer stretch that
 * begins with the literal (a name of which the literal is the start). The stretch is
 * shortened so that it never ends strictly inside a protected span.
 */
export type Replacement =
  string | { readonly text: string; readonly length: number };

/** How many characters or states one build step handles before it may pause. */
const BUILD_STEP = 4_096;
/** Shorter literals tried at one position after the longest fails a boundary check. */
const MAX_FALLBACKS = 32;
const UNIT_RANGE = 0x10000;
const TERMINAL = 1;
const CHECK_START = 2;
const CHECK_END = 4;

/**
 * Finds known literal strings in text by exact substring, leftmost first and, at each
 * position, longest first, where a literal that starts or ends with a letter or digit of a
 * space-separated script must do so on a word boundary. An Aho–Corasick automaton over the
 * reversed literals, run from the end of the text, gives every literal starting at each
 * position, longest first through its output links; a forward walk takes the first that
 * passes its checks. No pattern is built from the literals, so neither their content nor
 * their number can make a line slow to scan.
 *
 * Transitions are stored compactly once built: a table for the root and, for every other
 * state, its children's code units and targets in two typed arrays, sorted for binary search.
 */
export class LiteralMatcher {
  // Per-line buffers, reused: the automaton state at each position and the protected edges.
  private states = new Int32Array(0);
  private noStart = new Uint8Array(0);
  private noEnd = new Uint8Array(0);

  private constructor(
    private readonly rootNext: Int32Array,
    private readonly edgeStart: Int32Array,
    private readonly edgeUnit: Uint16Array,
    private readonly edgeTarget: Int32Array,
    private readonly fail: Int32Array,
    /** The nearest state on the failure chain that ends a literal, or 0. */
    private readonly outLink: Int32Array,
    private readonly depth: Int32Array,
    private readonly flags: Uint8Array,
  ) {}

  /**
   * Build a matcher over `literals`, pausing (`yield`) every few thousand characters or
   * states so a caller running in slices never holds the main thread for a large set. A
   * literal given twice keeps the boundary checks both copies ask for.
   */
  static *build(
    literals: Iterable<MatcherLiteral>,
  ): Generator<void, LiteralMatcher> {
    const trie = new TrieBuilder();
    let work = 0;
    for (const literal of literals) {
      trie.insertReversed(literal);
      work += literal.text.length;
      if (work >= BUILD_STEP) {
        work = 0;
        yield;
      }
    }
    yield* trie.link();
    const compiled = yield* trie.compile();
    return new LiteralMatcher(
      compiled.rootNext,
      compiled.edgeStart,
      compiled.edgeUnit,
      compiled.edgeTarget,
      compiled.fail,
      compiled.outLink,
      compiled.depth,
      compiled.flags,
    );
  }

  /**
   * Replace every match with `replace(literal, start)`, leftmost first, longest first. A
   * match never starts or ends strictly inside a protected span.
   */
  replace(
    text: string,
    replace: (literal: string, start: number) => Replacement,
    protectedSpans: readonly ProtectedSpan[] = [],
  ): string {
    if (this.fail.length === 1 || text.length === 0) {
      return text;
    }
    const states = this.scan(text);
    const guarded = this.protect(text.length, protectedSpans);
    let output = '';
    let copied = 0;
    for (let position = 0; position < text.length;) {
      const length = this.matchAt(text, position, states, guarded);
      if (length === 0) {
        position += 1;
        continue;
      }
      const replacement = replace(
        text.slice(position, position + length),
        position,
      );
      const extended = typeof replacement !== 'string';
      let end = position + length;
      if (extended) {
        end = Math.min(
          text.length,
          position + Math.max(length, replacement.length),
        );
        while (end > position + length && guarded && this.noEnd[end - 1]) {
          end -= 1;
        }
      }
      output +=
        text.slice(copied, position) +
        (extended ? replacement.text : replacement);
      position = end;
      copied = position;
    }
    return copied === 0 ? text : output + text.slice(copied);
  }

  /** The length of the literal taken at `position`, or 0. */
  private matchAt(
    text: string,
    position: number,
    states: Int32Array,
    guarded: boolean,
  ): number {
    const state = states[position];
    let output = this.flags[state] & TERMINAL ? state : this.outLink[state];
    if (output === 0 || (guarded && this.noStart[position])) {
      return 0;
    }
    const startCut =
      position > 0 &&
      isSpacedWord(text.charCodeAt(position)) &&
      isSpacedWord(text.charCodeAt(position - 1));
    for (
      let tries = 0;
      output !== 0 && tries < MAX_FALLBACKS;
      tries += 1, output = this.outLink[output]
    ) {
      const flags = this.flags[output];
      const last = position + this.depth[output] - 1;
      const endCut =
        last + 1 < text.length &&
        isSpacedWord(text.charCodeAt(last)) &&
        isSpacedWord(text.charCodeAt(last + 1));
      if (
        (flags & CHECK_START && startCut) ||
        (flags & CHECK_END && endCut) ||
        (guarded && this.noEnd[last])
      ) {
        continue;
      }
      return this.depth[output];
    }
    return 0;
  }

  /** The automaton state after reading the text backwards from its end to each position. */
  private scan(text: string): Int32Array {
    if (this.states.length < text.length) {
      this.states = new Int32Array(
        Math.max(text.length, 2 * this.states.length),
      );
    }
    const states = this.states;
    let state = 0;
    for (let index = text.length - 1; index >= 0; index -= 1) {
      const unit = text.charCodeAt(index);
      let next = this.transition(state, unit);
      while (next === 0 && state !== 0) {
        state = this.fail[state];
        next = this.transition(state, unit);
      }
      state = next;
      states[index] = state;
    }
    return states;
  }

  /** The child of `state` on `unit`, or 0 (the root is never a child). */
  private transition(state: number, unit: number): number {
    if (state === 0) {
      return this.rootNext[unit];
    }
    let low = this.edgeStart[state];
    let high = this.edgeStart[state + 1] - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const found = this.edgeUnit[middle];
      if (found === unit) {
        return this.edgeTarget[middle];
      }
      if (found < unit) {
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return 0;
  }

  /** Mark where a match may not start or end; false when nothing is protected. */
  private protect(length: number, spans: readonly ProtectedSpan[]): boolean {
    if (spans.length === 0) {
      return false;
    }
    if (this.noStart.length < length) {
      const size = Math.max(length, 2 * this.noStart.length);
      this.noStart = new Uint8Array(size);
      this.noEnd = new Uint8Array(size);
    } else {
      this.noStart.fill(0, 0, length);
      this.noEnd.fill(0, 0, length);
    }
    for (const [start, end] of spans) {
      this.noStart.fill(1, start + 1, end);
      this.noEnd.fill(1, start, end - 1);
    }
    return true;
  }
}

function isSpacedWord(unit: number): boolean {
  return wordUnitClass(unit) === SPACED_WORD;
}

/** The automaton while it is built: a map for transitions, lists for the breadth-first pass. */
class TrieBuilder {
  private readonly fail: number[] = [0];
  private readonly outLink: number[] = [0];
  private readonly depth: number[] = [0];
  private readonly flags: number[] = [0];
  private next = new Map<number, number>();
  private readonly firstChild: number[] = [0];
  private readonly nextSibling: number[] = [0];
  private readonly unit: number[] = [0];

  insertReversed(literal: MatcherLiteral): void {
    const { text } = literal;
    if (text.length === 0) {
      return;
    }
    let state = 0;
    for (let index = text.length - 1; index >= 0; index -= 1) {
      const unit = text.charCodeAt(index);
      const key = state * UNIT_RANGE + unit;
      let child = this.next.get(key);
      if (child === undefined) {
        child = this.fail.length;
        this.fail.push(0);
        this.outLink.push(0);
        this.depth.push(this.depth[state] + 1);
        this.flags.push(0);
        this.unit.push(unit);
        this.firstChild.push(0);
        this.nextSibling.push(this.firstChild[state]);
        this.firstChild[state] = child;
        this.next.set(key, child);
      }
      state = child;
    }
    const checks =
      (literal.checkStart ? CHECK_START : 0) |
      (literal.checkEnd ? CHECK_END : 0);
    const existing = this.flags[state];
    this.flags[state] =
      TERMINAL | (existing & TERMINAL ? existing & checks : checks);
  }

  /** Failure and output links, breadth first. */
  *link(): Generator<void, void> {
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
        const fail = this.fail[child];
        this.outLink[child] =
          this.flags[fail] & TERMINAL ? fail : this.outLink[fail];
        queue.push(child);
      }
      if (head % BUILD_STEP === BUILD_STEP - 1) {
        yield;
      }
    }
  }

  /** The compact tables, a few thousand states per step; the build lists are released. */
  *compile(): Generator<void, CompiledTrie> {
    const states = this.fail.length;
    const fail = new Int32Array(states);
    const outLink = new Int32Array(states);
    const depth = new Int32Array(states);
    const flags = new Uint8Array(states);
    const rootNext = new Int32Array(UNIT_RANGE);
    const edgeStart = new Int32Array(states + 1);
    const edgeUnit = new Uint16Array(Math.max(states - 1, 0));
    const edgeTarget = new Int32Array(Math.max(states - 1, 0));
    const children: number[] = [];
    let edge = 0;
    for (let state = 0; state < states; state += 1) {
      fail[state] = this.fail[state];
      outLink[state] = this.outLink[state];
      depth[state] = this.depth[state];
      flags[state] = this.flags[state];
      edgeStart[state] = edge;
      children.length = 0;
      for (
        let child = this.firstChild[state];
        child !== 0;
        child = this.nextSibling[child]
      ) {
        children.push(child);
      }
      if (state === 0) {
        for (const child of children) {
          rootNext[this.unit[child]] = child;
        }
      } else {
        children.sort((left, right) => this.unit[left] - this.unit[right]);
        for (const child of children) {
          edgeUnit[edge] = this.unit[child];
          edgeTarget[edge] = child;
          edge += 1;
        }
      }
      if (state % BUILD_STEP === BUILD_STEP - 1) {
        yield;
      }
    }
    edgeStart[states] = edge;
    // Dropped by reference, for the collector to reclaim in its own time.
    this.next = new Map();
    return {
      rootNext,
      edgeStart,
      edgeUnit,
      edgeTarget,
      fail,
      outLink,
      depth,
      flags,
    };
  }
}

interface CompiledTrie {
  readonly rootNext: Int32Array;
  readonly edgeStart: Int32Array;
  readonly edgeUnit: Uint16Array;
  readonly edgeTarget: Int32Array;
  readonly fail: Int32Array;
  readonly outLink: Int32Array;
  readonly depth: Int32Array;
  readonly flags: Uint8Array;
}
