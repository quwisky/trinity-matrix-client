import type { DiagnosticKnownNames } from '../report-facts';
import { LiteralMatcher } from './literal-matcher';

/** Shorter names match too much ordinary text to be worth replacing. */
const MIN_NAME_LENGTH = 3;
/**
 * The longest stretch of one name that is matched. A longer name (a topic, usually) is
 * replaced by its first part, so a hostile room cannot make the matcher large.
 */
const MAX_NAME_LENGTH = 512;
/**
 * Words a room or person may be called that are also log vocabulary or placeholder words;
 * replacing them would make the log unreadable and protect nobody. Compared lower-cased.
 */
const STOPLIST = new Set([
  'account',
  'admin',
  'alias',
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
  'example',
  'fail',
  'failed',
  'false',
  'general',
  'home',
  'http',
  'https',
  'info',
  'invalid',
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
  'none',
  'null',
  'person',
  'redacted',
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
  'timeline',
  'topic',
  'trace',
  'trinity',
  'true',
  'undefined',
  'unknown',
  'user',
  'users',
  'warn',
  'warning',
]);
/** A name shaped like a placeholder (`user1`, `Room 2`) would match the redacted text. */
const PLACEHOLDER_SHAPED =
  /^(?:me|user|room|alias|event|media|server|device|email|person|topic)\s?\d*$/i;
const HAS_LETTER = /\p{L}/u;

type NameKind = 'room' | 'topic' | 'person';

const LABELS: Readonly<Record<NameKind, string>> = {
  room: 'Room',
  topic: 'Topic',
  person: 'Person',
};

/**
 * Replaces known names with `Room 1`, `Topic 1` and `Person 1`, numbered per kind in the
 * order they are first seen, so a placeholder means one name throughout a file.
 */
export class KnownNameRedactor {
  private readonly placeholders = new Map<string, string>();
  private readonly counts: Record<NameKind, number> = {
    room: 0,
    topic: 0,
    person: 0,
  };

  private constructor(
    private readonly kinds: ReadonlyMap<string, NameKind>,
    private readonly matcher: LiteralMatcher,
  ) {}

  /** Build the redactor, pausing (`yield`) while a large set of names is indexed. */
  static *build(
    names: DiagnosticKnownNames,
  ): Generator<void, KnownNameRedactor> {
    const kinds = new Map<string, NameKind>();
    // A string known as more than one kind keeps the first: rooms, then topics, then people.
    addAll(kinds, names.roomNames, 'room');
    addAll(kinds, names.roomTopics, 'topic');
    addAll(kinds, names.displayNames, 'person');
    const matcher = yield* LiteralMatcher.build(kinds.keys());
    return new KnownNameRedactor(kinds, matcher);
  }

  redact(text: string): string {
    return this.matcher.replace(text, (name) => this.placeholder(name));
  }

  private placeholder(name: string): string {
    const known = this.placeholders.get(name);
    if (known) {
      return known;
    }
    const kind = this.kinds.get(name) ?? 'person';
    this.counts[kind] += 1;
    const placeholder = `${LABELS[kind]} ${this.counts[kind]}`;
    this.placeholders.set(name, placeholder);
    return placeholder;
  }
}

function addAll(
  kinds: Map<string, NameKind>,
  names: readonly string[],
  kind: NameKind,
): void {
  for (const name of names) {
    // A multi-line topic is also matched line by line: a log line may quote one line.
    const lines = name.includes('\n') ? [name, ...name.split('\n')] : [name];
    for (const line of lines) {
      const literal = line.trim().slice(0, MAX_NAME_LENGTH);
      if (isReplaceable(literal) && !kinds.has(literal)) {
        kinds.set(literal, kind);
      }
    }
  }
}

function isReplaceable(name: string): boolean {
  return (
    name.length >= MIN_NAME_LENGTH &&
    HAS_LETTER.test(name) &&
    !STOPLIST.has(name.toLowerCase()) &&
    !PLACEHOLDER_SHAPED.test(name)
  );
}
