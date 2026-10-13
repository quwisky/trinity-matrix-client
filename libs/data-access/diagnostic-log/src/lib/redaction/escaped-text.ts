/** A `String.prototype.replace` callback that reads only the match and its groups. */
export type Replacer = (
  match: string,
  ...groups: (string | undefined)[]
) => string;

/** Text a redaction rule can rewrite: a plain string, or a {@link TrackedText}. */
export interface Rewritable<T> {
  replace(pattern: RegExp, replacer: Replacer): T;
}

const HEX_PAIR = /^[0-9A-Fa-f]{2}$/;
/** An escape whose bytes are escaped once more (`%2540` for `%40`). */
const ESCAPED_ESCAPE = /%25[0-9A-Fa-f]{2}/;
/** An escape with a lower-case hex letter, and one with an upper-case one. */
const LOWER_CASE_ESCAPE = /%(?:[0-9a-f][a-f]|[a-f][0-9])/;
const UPPER_CASE_ESCAPE = /%(?:[0-9A-F][A-F]|[A-F][0-9])/;
/** Characters every writer leaves as they are. */
const UNRESERVED = /^[A-Za-z0-9_.~-]$/;
/** What a lone surrogate, which has no UTF-8 form, is written as. */
const REPLACEMENT_ESCAPE = '%EF%BF%BD';

/**
 * Decoded text that remembers, for each character, the index of the character in its source
 * that it was kept from, or -1 where a rewrite inserted it.
 */
export class TrackedText implements Rewritable<TrackedText> {
  constructor(
    readonly text: string,
    readonly origins: readonly number[],
  ) {}

  /** `text`, every character kept from itself. */
  static of(text: string): TrackedText {
    return new TrackedText(
      text,
      Array.from({ length: text.length }, (_, index) => index),
    );
  }

  /**
   * Like `String.prototype.replace` with a global pattern. The characters a replacement shares
   * with the start and the end of its match keep their origins; the rest are inserted.
   */
  replace(pattern: RegExp, replacer: Replacer): TrackedText {
    let text = '';
    const origins: number[] = [];
    let cursor = 0;
    let changed = false;
    const keep = (from: number, to: number): void => {
      text += this.text.slice(from, to);
      for (let index = from; index < to; index += 1) {
        origins.push(this.origins[index]);
      }
    };
    pattern.lastIndex = 0;
    for (const match of this.text.matchAll(pattern)) {
      const found = match[0];
      const start = match.index;
      const replacement = replacer(found, ...match.slice(1));
      keep(cursor, start);
      cursor = start + found.length;
      if (replacement === found) {
        keep(start, cursor);
        continue;
      }
      changed = true;
      const shortest = Math.min(found.length, replacement.length);
      let head = 0;
      while (head < shortest && found[head] === replacement[head]) {
        head += 1;
      }
      let tail = 0;
      while (
        tail < shortest - head &&
        found[found.length - 1 - tail] ===
          replacement[replacement.length - 1 - tail]
      ) {
        tail += 1;
      }
      keep(start, start + head);
      text += replacement.slice(head, replacement.length - tail);
      for (let index = head; index < replacement.length - tail; index += 1) {
        origins.push(-1);
      }
      keep(cursor - tail, cursor);
    }
    if (!changed) {
      return this;
    }
    keep(cursor, this.text.length);
    return new TrackedText(text, origins);
  }
}

/**
 * Decodes `encoded`, lets `redact` rewrite the decoded text, and writes the result back: every
 * character `redact` kept as it was written in `encoded`, and every inserted one escaped the
 * way `encoded` escapes it. Text escaped twice (`%2540`) is decoded one level further.
 */
export function rewriteEscaped(
  encoded: string,
  redact: (decoded: TrackedText) => TrackedText,
): string {
  return rewriteLevel(encoded, redact, 2).text;
}

function rewriteLevel(
  encoded: string,
  redact: (decoded: TrackedText) => TrackedText,
  levels: number,
): TrackedText {
  const { text, starts } = decodeEscapes(encoded);
  const redacted =
    levels > 1 && ESCAPED_ESCAPE.test(encoded)
      ? rewriteLevel(text, redact, levels - 1)
      : redact(TrackedText.of(text));
  return encodeAs(redacted, starts, encoded);
}

/**
 * Decodes every escape. An escape that is not part of valid UTF-8 becomes U+FFFD, so it
 * neither hides the characters beside it nor joins them into a word. `starts[i]` is where
 * the escape or character that decoded character `i` came from begins in `encoded`; the
 * last entry is the length of `encoded`.
 */
function decodeEscapes(encoded: string): {
  readonly text: string;
  readonly starts: readonly number[];
} {
  let text = '';
  const starts: number[] = [];
  let index = 0;
  while (index < encoded.length) {
    const byte = escapedByte(encoded, index);
    if (byte < 0) {
      starts.push(index);
      text += encoded[index];
      index += 1;
      continue;
    }
    const length = utf8Length(byte);
    let char = '�';
    let bytes = 1;
    if (length === 1) {
      char = String.fromCharCode(byte);
    } else if (length > 1) {
      let next = 1;
      while (
        next < length &&
        (escapedByte(encoded, index + 3 * next) & 0xc0) === 0x80
      ) {
        next += 1;
      }
      if (next === length) {
        try {
          char = decodeURIComponent(encoded.slice(index, index + 3 * length));
          bytes = length;
        } catch {
          // An overlong form or a surrogate: the lead byte alone is invalid.
        }
      }
    }
    for (let unit = 0; unit < char.length; unit += 1) {
      starts.push(index);
    }
    text += char;
    index += 3 * bytes;
  }
  starts.push(encoded.length);
  return { text, starts };
}

/** The byte `%XX` at `index` stands for, or -1 when no escape starts there. */
function escapedByte(text: string, index: number): number {
  if (text[index] !== '%') {
    return -1;
  }
  const hex = text.slice(index + 1, index + 3);
  return HEX_PAIR.test(hex) ? Number.parseInt(hex, 16) : -1;
}

/** How many bytes a UTF-8 sequence that starts with `byte` has; 0 when it cannot start one. */
function utf8Length(byte: number): number {
  if (byte < 0x80) {
    return 1;
  }
  if (byte >= 0xc2 && byte <= 0xdf) {
    return 2;
  }
  if (byte >= 0xe0 && byte <= 0xef) {
    return 3;
  }
  return byte >= 0xf0 && byte <= 0xf4 ? 4 : 0;
}

/**
 * Writes `redacted` (decoded from `encoded`) back: each run it kept is copied from `encoded`,
 * so its escapes, valid or not, stay exactly as they were; each inserted run is escaped like
 * `encoded`. The result's origins point into `encoded`.
 */
function encodeAs(
  redacted: TrackedText,
  starts: readonly number[],
  encoded: string,
): TrackedText {
  const { text, origins } = redacted;
  const style = escapeStyle(encoded);
  let output = '';
  const outputOrigins: number[] = [];
  let index = 0;
  while (index < text.length) {
    let end = index + 1;
    if (origins[index] >= 0) {
      while (end < text.length && origins[end] === origins[end - 1] + 1) {
        end += 1;
      }
      const from = origins[index];
      const to = origins[end - 1] + 1;
      if (isBoundary(starts, from) && isBoundary(starts, to)) {
        for (let at = starts[from]; at < starts[to]; at += 1) {
          outputOrigins.push(at);
        }
        output += encoded.slice(starts[from], starts[to]);
        index = end;
        continue;
      }
    } else {
      while (end < text.length && origins[end] < 0) {
        end += 1;
      }
    }
    const written = escapeLike(text.slice(index, end), style);
    output += written;
    for (let at = 0; at < written.length; at += 1) {
      outputOrigins.push(-1);
    }
    index = end;
  }
  return new TrackedText(output, outputOrigins);
}

/** Whether a decoded index falls between two escapes, not inside one character's escapes. */
function isBoundary(starts: readonly number[], index: number): boolean {
  return (
    index === 0 ||
    index === starts.length - 1 ||
    starts[index] !== starts[index - 1]
  );
}

interface EscapeStyle {
  /** Characters `encoded` writes as they are. */
  readonly literal: ReadonlySet<string>;
  /** ASCII characters `encoded` escapes. */
  readonly escaped: ReadonlySet<string>;
  readonly lowerCase: boolean;
}

function escapeStyle(encoded: string): EscapeStyle {
  const literal = new Set<string>();
  const escaped = new Set<string>();
  for (let index = 0; index < encoded.length;) {
    const byte = escapedByte(encoded, index);
    if (byte < 0) {
      literal.add(encoded[index]);
      index += 1;
    } else {
      if (byte < 0x80) {
        escaped.add(String.fromCharCode(byte));
      }
      index += 3;
    }
  }
  return {
    literal,
    escaped,
    lowerCase:
      LOWER_CASE_ESCAPE.test(encoded) && !UPPER_CASE_ESCAPE.test(encoded),
  };
}

/**
 * Escapes inserted text: a character stays literal where the source writes it literally and
 * never escapes it (the SDK keeps "!" literal), and is escaped otherwise.
 */
function escapeLike(text: string, style: EscapeStyle): string {
  let output = '';
  for (const char of text) {
    if (
      UNRESERVED.test(char) ||
      (style.literal.has(char) && !style.escaped.has(char))
    ) {
      output += char;
      continue;
    }
    const escape = escapeChar(char);
    output += style.lowerCase ? escape.toLowerCase() : escape;
  }
  return output;
}

function escapeChar(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  if (code < 0x80) {
    return `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  try {
    return encodeURIComponent(char);
  } catch {
    return REPLACEMENT_ESCAPE;
  }
}
