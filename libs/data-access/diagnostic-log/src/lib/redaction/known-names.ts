import type { DiagnosticNameGroup } from '../report-facts';
import { LiteralMatcher, type ProtectedSpan } from './literal-matcher';

/** Shorter names match too much ordinary text to be worth replacing. */
const MIN_NAME_LENGTH = 3;
/** Longer names (topics, usually) are matched as consecutive chunks of at most this many units. */
export const NAME_CHUNK_LENGTH = 512;
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
  /** False only when `name` cannot occur in the learned log. */
  mayOccur(name: string): boolean;
  /** `text` with the identifier rules applied, as a redacted log line would carry it. */
  redactIdentifiers(text: string): string;
}

/** One literal: the name it stands for, and where it sits in a chunked name. */
interface NameLiteral {
  readonly name: number;
  /** A chunk after the first: written as nothing when it follows its name's previous chunk. */
  readonly continuation: boolean;
  readonly checkStart: boolean;
  readonly checkEnd: boolean;
}

/**
 * Replaces known names with `Room 1`, `Topic 1` and `Person 1`, numbered per kind in the
 * order they are first written, so a placeholder means one name throughout a file. Every
 * spelling of a name (NFC and NFD, escaped for JSON or a URL, with its identifiers already
 * redacted, line by line, chunk by chunk) maps to the name's one placeholder.
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
  ) {}

  /**
   * Read the groups, keep the names that may occur in the learned log, and index them,
   * pausing (`yield`) every few names and while the matcher is built. A source that fails
   * part-way keeps the names read before it failed.
   */
  static *build(
    groups: Iterable<DiagnosticNameGroup>,
    context: NameContext,
  ): Generator<void, KnownNameRedactor> {
    const index = new NameIndex(context);
    let read = 0;
    try {
      for (const group of groups) {
        for (const name of group.roomNames) {
          index.add(name, 'room');
        }
        for (const topic of group.roomTopics) {
          index.add(topic, 'topic');
        }
        let taken = 0;
        for (const name of group.displayNames) {
          if (index.full() || taken >= MAX_DISPLAY_NAMES_PER_GROUP) {
            break;
          }
          if (index.add(name, 'person')) {
            taken += 1;
          }
          read += 1;
          if (read % NAMES_PER_STEP === 0) {
            yield;
          }
        }
        yield;
      }
    } catch {
      // The names read so far are kept; the identifiers are redacted regardless.
    }
    const matcher = yield* LiteralMatcher.build(
      [...index.literals].map(([text, literal]) => ({
        text,
        checkStart: literal.checkStart,
        checkEnd: literal.checkEnd,
      })),
    );
    return new KnownNameRedactor(index.kinds, index.literals, matcher);
  }

  redact(text: string): string {
    let previousEnd = -1;
    let previousName = -1;
    return this.matcher.replace(
      text,
      (match, start) => {
        const literal = this.literals.get(match);
        if (!literal) {
          return match;
        }
        const glued =
          literal.continuation &&
          start === previousEnd &&
          literal.name === previousName;
        previousEnd = start + match.length;
        previousName = literal.name;
        return glued ? '' : this.placeholder(literal.name);
      },
      placeholderSpans(text),
    );
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

  /** Take `raw` if it is worth replacing and may occur in the log; true when taken. */
  add(raw: string, kind: NameKind): boolean {
    const name = raw.normalize('NFC').trim();
    if (
      this.full() ||
      !isReplaceable(name) ||
      this.literals.has(name) ||
      !this.context.mayOccur(name)
    ) {
      return false;
    }
    const id = this.kinds.push(kind) - 1;
    // A multi-line topic is also matched line by line: a log line may quote one line.
    const pieces = name.includes('\n')
      ? [name, ...name.split('\n').map((line) => line.trim())]
      : [name];
    for (const piece of pieces) {
      if (!isReplaceable(piece)) {
        continue;
      }
      for (const form of spellings(piece, this.context)) {
        this.addChunks(form, id);
      }
    }
    return true;
  }

  /** `text` as consecutive chunks, cut between code points, all standing for `name`. */
  private addChunks(text: string, name: number): void {
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + NAME_CHUNK_LENGTH, text.length);
      if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) {
        end -= 1;
      }
      const chunk = text.slice(start, end);
      if (!this.literals.has(chunk)) {
        this.literals.set(chunk, {
          name,
          continuation: start > 0,
          checkStart: start === 0,
          checkEnd: end === text.length,
        });
      }
      start = end;
    }
  }
}

/** The ways a log line may spell `name`. */
function spellings(name: string, context: NameContext): Set<string> {
  const decomposed = name.normalize('NFD');
  return new Set([
    name,
    decomposed,
    JSON.stringify(name).slice(1, -1),
    JSON.stringify(decomposed).slice(1, -1),
    encodeURIComponent(name),
    context.redactIdentifiers(name),
  ]);
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
