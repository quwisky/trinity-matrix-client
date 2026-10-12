import type { DiagnosticNameGroup } from '../report-facts';
import {
  LiteralMatcher,
  type ProtectedSpan,
  type Replacement,
} from './literal-matcher';

/** Shorter names match too much ordinary text to be worth replacing. */
const MIN_NAME_LENGTH = 3;
/**
 * A topic longer than this is also replaced where it appears cut short: its first this many
 * units are a literal, and a match extends over as much of the topic as the text repeats.
 * A topic cut shorter than this is not recognised.
 */
export const TOPIC_PREFIX_LENGTH = 16;
/** Other names longer than this are matched the same way, from their first this many units. */
const LONG_NAME_PREFIX_LENGTH = 512;
/** Names sharing one prefix literal that are tried as its extension. */
const MAX_NAMES_PER_PREFIX = 8;
/** Display names taken from one group (one room), so one huge room cannot crowd out the rest. */
export const MAX_DISPLAY_NAMES_PER_GROUP = 1_000;
/** Names taken in all; with only names that occur in the log taken, rarely reached. */
export const MAX_NAMES = 20_000;
/** Names read between two pauses. */
const NAMES_PER_STEP = 128;
/**
 * Words a room or person may be called that are also log vocabulary or everyday words;
 * replacing them, even as whole words, would make the log unreadable and protect nobody.
 * Compared lower-cased. Placeholder words need no entry: placeholders are protected.
 */
const STOPLIST = new Set([
  'account',
  'admin',
  'alias',
  'all',
  'and',
  'are',
  'call',
  'chat',
  'client',
  'crypto',
  'debug',
  'default',
  'device',
  'devices',
  'email',
  'error',
  'event',
  'events',
  'fail',
  'failed',
  'false',
  'for',
  'from',
  'general',
  'has',
  'home',
  'http',
  'https',
  'info',
  'invite',
  'join',
  'key',
  'keys',
  'leave',
  'log',
  'login',
  'logout',
  'main',
  'matrix',
  'media',
  'member',
  'members',
  'message',
  'messages',
  'new',
  'none',
  'not',
  'null',
  'off',
  'one',
  'out',
  'request',
  'response',
  'room',
  'rooms',
  'server',
  'session',
  'space',
  'start',
  'state',
  'stop',
  'sync',
  'team',
  'test',
  'that',
  'the',
  'this',
  'timeline',
  'trace',
  'trinity',
  'true',
  'two',
  'undefined',
  'unknown',
  'user',
  'users',
  'warn',
  'warning',
  'was',
  'with',
  'you',
]);
/** A name shaped like a placeholder (`user1`, `Room 2`) would match the redacted text. */
const PLACEHOLDER_SHAPED =
  /^(?:me|user|room|alias|event|media|server|device|email|person|topic)\s?\d*$/i;
const HAS_LETTER = /\p{L}/u;
/** Placeholders the identifier rules wrote; a name never cuts into one. */
const PLACEHOLDER_SPAN =
  /@(?:me\d*|user\d+):server\d+|[!#](?:room|alias)\d+(?::server\d+)?|\$event\d+|mxc:\/\/server\d+\/media\d+|email\d+@example\.invalid|<redacted>|(?<![\p{L}\p{N}_])(?:server|DEVICE)\d+(?![\p{L}\p{N}_])/gu;

type NameKind = 'room' | 'topic' | 'person';

const LABELS: Readonly<Record<NameKind, string>> = {
  room: 'Room',
  topic: 'Topic',
  person: 'Person',
};

/** What the name index needs from the redactor that has learned the file. */
export interface NameContext {
  /**
   * False only when `literal` cannot occur in the learned log. With `cutEnd`, the literal is
   * the start of a longer text, so its last word may be cut short.
   */
  mayOccur(literal: string, cutEnd: boolean): boolean;
  /** `text` with the identifier rules applied, as a redacted log line would carry it. */
  redactIdentifiers(text: string): string;
  /** False only when the identifier rules would leave `text` unchanged. */
  mayCarryIdentifier(text: string): boolean;
}

/** What one literal stands for: a whole name, or the start of longer names. */
interface NameLiteral {
  /** The name this literal spells whole, or -1. */
  whole: number;
  /** Names that begin with this literal, each with the full spelling a match extends over. */
  readonly prefixOf: { readonly name: number; readonly spelling: string }[];
}

/** How a name source was read. */
export interface NameReading {
  /**
   * False when some names that occur in the log may still be there in clear: a cap was
   * reached, or the source failed part-way.
   */
  readonly complete: boolean;
}

/**
 * Replaces known names with `Room 1`, `Topic 1` and `Person 1`, numbered per kind in the
 * order they are first written, so a placeholder means one name throughout a file. Every
 * spelling of a name (NFC and NFD, escaped for JSON or a URL, with its identifiers already
 * redacted, line by line) maps to the name's one placeholder.
 */
export class KnownNameRedactor {
  private readonly placeholders: string[] = [];
  private readonly counts: Record<NameKind, number> = {
    room: 0,
    topic: 0,
    person: 0,
  };

  private constructor(
    private readonly kinds: readonly NameKind[],
    private readonly literals: ReadonlyMap<string, NameLiteral>,
    private readonly matcher: LiteralMatcher,
    readonly reading: NameReading,
  ) {}

  /**
   * Read the groups and index the names whose spellings may occur in the learned log,
   * pausing (`yield`) every few names and while the matcher is built. Every room name and
   * topic is read before any display name, so the caps only ever leave display names out.
   * A source that fails part-way keeps the names read before it failed.
   */
  static *build(
    groups: Iterable<DiagnosticNameGroup>,
    context: NameContext,
  ): Generator<void, KnownNameRedactor> {
    const index = new NameIndex(context);
    const members: Iterable<string>[] = [];
    let complete = true;
    try {
      for (const group of groups) {
        for (const name of group.roomNames) {
          index.add(name, 'room');
        }
        for (const topic of group.roomTopics) {
          index.add(topic, 'topic');
        }
        members.push(group.displayNames);
        yield;
      }
      let read = 0;
      for (const names of members) {
        let taken = 0;
        for (const name of names) {
          read += 1;
          if (read % NAMES_PER_STEP === 0) {
            yield;
          }
          if (index.full() || taken >= MAX_DISPLAY_NAMES_PER_GROUP) {
            // A cap is reached: the reading is incomplete only if this name was needed.
            if (index.wouldTake(name, 'person')) {
              complete = false;
              break;
            }
          } else if (index.add(name, 'person')) {
            taken += 1;
          }
        }
        if (!complete && index.full()) {
          break;
        }
      }
    } catch {
      // The names read so far are kept; the identifiers are redacted regardless.
      complete = false;
    }
    const matcher = yield* LiteralMatcher.build(
      [...index.literals.keys()].map((text) => {
        const literal = index.literals.get(text);
        return {
          text,
          checkStart: true,
          checkEnd: literal ? literal.whole !== -1 : true,
        };
      }),
    );
    return new KnownNameRedactor(index.kinds, index.literals, matcher, {
      complete,
    });
  }

  redact(text: string): string {
    return this.matcher.replace(
      text,
      (match, start) => this.replacement(text, match, start),
      placeholderSpans(text),
    );
  }

  private replacement(text: string, match: string, start: number): Replacement {
    const literal = this.literals.get(match);
    if (!literal) {
      return match;
    }
    let best: { name: number; length: number } | null = null;
    for (const { name, spelling } of literal.prefixOf) {
      const length = sharedLength(text, start, spelling);
      if (!best || length > best.length) {
        best = { name, length };
      }
    }
    if (best && (literal.whole === -1 || best.length > match.length)) {
      return { text: this.placeholder(best.name), length: best.length };
    }
    return literal.whole === -1 ? match : this.placeholder(literal.whole);
  }

  private placeholder(name: number): string {
    const known = this.placeholders[name];
    if (known) {
      return known;
    }
    const kind = this.kinds[name];
    this.counts[kind] += 1;
    const placeholder = `${LABELS[kind]} ${this.counts[kind]}`;
    this.placeholders[name] = placeholder;
    return placeholder;
  }
}

/** The names taken so far and every literal that stands for one of them. */
class NameIndex {
  readonly kinds: NameKind[] = [];
  readonly literals = new Map<string, NameLiteral>();

  constructor(private readonly context: NameContext) {}

  full(): boolean {
    return this.kinds.length >= MAX_NAMES;
  }

  /**
   * Take `raw` if it is worth replacing and some spelling of it may occur in the log; true
   * when taken. Each line and spelling is checked on its own, so a log line that quotes one
   * line of a topic, or the topic cut short, is enough.
   */
  add(raw: string, kind: NameKind): boolean {
    return !this.full() && this.consider(raw, kind, true);
  }

  /** Whether `raw` would be taken, without taking it. */
  wouldTake(raw: string, kind: NameKind): boolean {
    return this.consider(raw, kind, false);
  }

  private consider(raw: string, kind: NameKind, take: boolean): boolean {
    const name = raw.normalize('NFC').trim();
    if (!isReplaceable(name)) {
      return false;
    }
    // A multi-line topic is also matched line by line: a log line may quote one line.
    const pieces = name.includes('\n')
      ? [name, ...name.split('\n').map((line) => line.trim())]
      : [name];
    const id = this.kinds.length;
    let taken = false;
    for (const piece of pieces) {
      if (!isReplaceable(piece)) {
        continue;
      }
      for (const spelling of this.candidateSpellings(piece, kind)) {
        taken = this.addSpelling(spelling, id, kind, take) || taken;
        if (taken && !take) {
          return true;
        }
      }
    }
    if (taken && take) {
      this.kinds.push(kind);
    }
    return taken;
  }

  /**
   * The spellings of `piece` worth checking one by one. The log's words are also taken
   * URL- and JSON-decoded and in NFC, so an escaped or decomposed spelling can occur only
   * if the plain piece's words do (for a long piece, the words of its start): when they
   * don't, only the spelling with IDs replaced is left, whose ID words the log no longer
   * holds, and only for a piece that may carry an ID.
   */
  private candidateSpellings(piece: string, kind: NameKind): Iterable<string> {
    const start = piece.slice(0, prefixLengthOf(kind));
    if (this.context.mayOccur(start, start.length < piece.length)) {
      return spellings(piece, this.context);
    }
    return this.context.mayCarryIdentifier(piece)
      ? [this.context.redactIdentifiers(piece)]
      : [];
  }

  /** Register one spelling if it may occur; a long one by its start, extended at match time. */
  private addSpelling(
    spelling: string,
    name: number,
    kind: NameKind,
    take: boolean,
  ): boolean {
    const prefixLength = prefixLengthOf(kind);
    if (spelling.length <= prefixLength) {
      if (!this.context.mayOccur(spelling, false)) {
        return false;
      }
      if (!take) {
        // Needed only if no name already covers this spelling.
        return (this.literals.get(spelling)?.whole ?? -1) === -1;
      }
      const literal = this.literal(spelling);
      if (literal.whole === -1) {
        literal.whole = name;
      }
      return true;
    }
    let end = prefixLength;
    if (isHighSurrogate(spelling.charCodeAt(end - 1))) {
      end -= 1;
    }
    const prefix = spelling.slice(0, end);
    if (!this.context.mayOccur(prefix, true)) {
      return false;
    }
    if (!take) {
      return !this.literals
        .get(prefix)
        ?.prefixOf.some((known) => known.spelling === spelling);
    }
    const literal = this.literal(prefix);
    if (literal.prefixOf.length < MAX_NAMES_PER_PREFIX) {
      literal.prefixOf.push({ name, spelling });
    }
    return true;
  }

  private literal(text: string): NameLiteral {
    let literal = this.literals.get(text);
    if (!literal) {
      literal = { whole: -1, prefixOf: [] };
      this.literals.set(text, literal);
    }
    return literal;
  }
}

function prefixLengthOf(kind: NameKind): number {
  return kind === 'topic' ? TOPIC_PREFIX_LENGTH : LONG_NAME_PREFIX_LENGTH;
}

/** The ways a log line may spell `name`. */
function spellings(name: string, context: NameContext): Set<string> {
  const decomposed = name.normalize('NFD');
  const forms = new Set<string>();
  for (const form of [name, decomposed]) {
    const json = JSON.stringify(form).slice(1, -1);
    forms.add(form);
    forms.add(json);
    // Serialisers that escape everything outside ASCII write \u00e9 or \u00E9.
    forms.add(json.replace(NON_ASCII, (unit) => unicodeEscape(unit, false)));
    forms.add(json.replace(NON_ASCII, (unit) => unicodeEscape(unit, true)));
  }
  forms.add(encodeURIComponent(name));
  forms.add(context.redactIdentifiers(name));
  return forms;
}

const NON_ASCII = /[^\x20-\x7e]/g;

function unicodeEscape(unit: string, upper: boolean): string {
  const hex = unit.charCodeAt(0).toString(16).padStart(4, '0');
  return `\\u${upper ? hex.toUpperCase() : hex}`;
}

/** How many units of `spelling` the text repeats from `start`, ending between code points. */
function sharedLength(text: string, start: number, spelling: string): number {
  const limit = Math.min(spelling.length, text.length - start);
  let length = 0;
  while (
    length < limit &&
    text.charCodeAt(start + length) === spelling.charCodeAt(length)
  ) {
    length += 1;
  }
  if (
    length < spelling.length &&
    length > 0 &&
    isHighSurrogate(spelling.charCodeAt(length - 1))
  ) {
    length -= 1;
  }
  return length;
}

function isReplaceable(name: string): boolean {
  return (
    name.length >= MIN_NAME_LENGTH &&
    HAS_LETTER.test(name) &&
    !STOPLIST.has(name.toLowerCase()) &&
    !PLACEHOLDER_SHAPED.test(name)
  );
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function placeholderSpans(text: string): ProtectedSpan[] {
  const spans: ProtectedSpan[] = [];
  for (const match of text.matchAll(PLACEHOLDER_SPAN)) {
    spans.push([match.index, match.index + match[0].length]);
  }
  return spans;
}
