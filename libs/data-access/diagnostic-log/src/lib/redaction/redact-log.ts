import type { DiagnosticNameGroup } from '../report-facts';
import { scrubSecrets } from '../scrub-secrets';
import { KnownNameRedactor } from './known-names';
import { LogWords } from './log-words';

/** What the redactor knows about this installation before it reads a line. */
export interface RedactionContext {
  /** Signed-in accounts, active first; they become `@me:…`, `@me2:…`. */
  readonly selfUserIds: readonly string[];
  /** Device IDs of the signed-in sessions, replaced wherever they appear. */
  readonly selfDeviceIds: readonly string[];
  /** Homeserver base URLs of the signed-in accounts. */
  readonly homeserverUrls: readonly string[];
}

/** Replaces identifiers with placeholders that stay the same for the life of one redactor. */
export interface LogRedactor {
  redact(text: string): string;
  /**
   * Registers every identifier and server name in `text` without producing output, so a
   * later `redact` of an earlier line already knows them. The bundle builder calls this over
   * the whole file before redacting line by line; otherwise a bare server name that appears
   * before any user, room or URL carrying it would survive.
   */
  learn(text: string): void;
  /**
   * Once the whole file is learned, reads room names, topics and display names and replaces
   * from then on those that occur in it, whole words only and after the identifier rules.
   * Pauses (`yield`) every few names, so a sliced build never holds the main thread long.
   */
  learnNames(groups: Iterable<DiagnosticNameGroup>): Generator<void, void>;
}

// A server name: DNS name or IP literal, optional port (Matrix spec, "Server name").
const SERVER = String.raw`(?:\[[0-9A-Fa-f:.]+\]|[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*)(?::\d{1,5})?`;
const USER_LOCALPART = String.raw`[A-Za-z0-9._=\-/+]+`;
const OPAQUE = String.raw`[A-Za-z0-9._~+/=-]+`;

// The optional userinfo is bounded, so a long run of "@" or ":" cannot make the scan quadratic.
const URL_HOST =
  /\b(https?|wss?):\/\/(?:[^\s/@?#]{1,256}@)?(\[[0-9A-Fa-f:.]+\]|[\p{L}\p{N}.-]+)(?::\d{1,5})?/giu;
// An email address. The local part starts a run (no ID or URL character before it) and every
// part is bounded, so a long run of address characters cannot make the scan quadratic. A
// Matrix ID has nothing before its "@"; a URL's userinfo is already gone when this runs.
const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,63}(?![A-Za-z0-9-])/g;
const MXC = /\bmxc:\/\/([\p{L}\p{N}.-]+(?::\d{1,5})?)\/([A-Za-z0-9_-]+)/gu;
// An identifier inside a request path. matrix-js-sdk builds paths with encodeURIComponent
// (`encodeUri` in utils.js), which escapes "@", "#", "$" and ":" but leaves "!" alone, so a
// room ID arrives as `!opaque%3Aserver`; other writers escape "!" as %21.
const ENCODED_ID =
  /(?:%(?:40|21|23|24)|!(?=[A-Za-z0-9._~-]+%3A))[A-Za-z0-9._~%-]+/gi;
const USER = new RegExp(
  String.raw`(?<![A-Za-z0-9._%+-])@(${USER_LOCALPART}):(${SERVER})`,
  'gu',
);
const ROOM = new RegExp(String.raw`!${OPAQUE}:(${SERVER})`, 'gu');
// Room version 12 room IDs carry no server name: "!" and 43 unpadded base64url characters.
const ROOM_V12 = /![A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;
const ALIAS = new RegExp(
  String.raw`(?<![A-Za-z0-9&])#[A-Za-z0-9._=\-]+:(${SERVER})`,
  'gu',
);
const EVENT_V1 = new RegExp(String.raw`\$${OPAQUE}:${SERVER}`, 'gu');
const EVENT = /\$[A-Za-z0-9+/_-]{43,44}(?![A-Za-z0-9+/_=-])/g;
// "device", "devices", "deviceId", "device_id", "device id": the words that introduce an ID.
const DEVICE_KEYWORD = /device(?:s|[_ -]?ids?)?(?![A-Za-z0-9_])/gi;
// "device:", "device=", optionally closed and opened by quotes.
const DEVICE_ASSIGNMENT = /^["']?\s*[:=]/;
// Between two items of a device list: a comma, or quotes, with optional spaces.
const DEVICE_LIST_SEPARATOR = /^\s*(?:["']?\s*,\s*["']?|["']\s*["'])\s*$/;
const DEVICE_TOKEN = /[^A-Za-z0-9_\n-]{0,6}([A-Za-z0-9_-]{1,64})/y;
const DEVICE_AFTER_USER =
  /(@(?:me\d*|user\d+):server\d+(?::| \(|\|))([A-Za-z0-9_-]{6,})/g;
// A bare server name: dot-separated labels. Labels and dots cannot overlap, so matching is linear.
const NAME_TOKEN =
  /(?<![\p{L}\p{N}.-])[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*(?![\p{L}\p{N}-])/gu;
// A run of device-ID characters, looked up in the known devices.
const WORD = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g;
// Longest bare name tried against known servers (a DNS name is at most 253 characters).
const MAX_NAME = 253;
const DEVICE_WORDS_AFTER_KEYWORD = 4;
// Ordinary words that follow "device" in crypto log lines and are long enough to look opaque.
const DEVICE_STOPWORDS = new Set([
  'verification',
  'verifications',
  'information',
  'announcement',
  'announcements',
  'tracking',
  'signing',
  'signatures',
  'initialising',
  'initializing',
  'deleted',
  'upload',
  'uploaded',
  'management',
  'notification',
  'notifications',
  'registration',
  'authentication',
  'configuration',
  'synchronisation',
  'synchronization',
]);
const ENGLISH_SUFFIX = /(?:ing|tions?|ments?|ed|ures?|ity|ies|al|ness)$/;

/**
 * The first word after a standalone "device" is an ID when it has a digit, is all capitals
 * or has an interior capital (6+ characters, the caller checks), or is a long lowercase run
 * that is neither a known log word nor shaped like an English word.
 */
function isFirstWordDeviceId(word: string): boolean {
  if (/\d/.test(word) || /^[A-Z_-]+$/.test(word) || /[a-z].*[A-Z]/.test(word)) {
    return true;
  }
  return (
    /^[a-z]{12,}$/.test(word) &&
    !DEVICE_STOPWORDS.has(word) &&
    !ENGLISH_SUFFIX.test(word)
  );
}
const ALREADY_PLACEHOLDER = /^(?:DEVICE|server)\d+$/;

/**
 * How the words after a device keyword are read:
 * - `field`: `deviceId`, `device_id`, `device:` hold one ID of any shape;
 * - `list`: `devices:`, `devices=` or a quoted "devices" hold a list of IDs of any shape;
 * - `prose`: `device <word>` or `devices <word>`, whose first word needs an ID's shape;
 * - `embedded`: a keyword inside a name such as `sendToDevice`, a digit or capitals only.
 */
type DeviceKeywordContext = 'field' | 'list' | 'prose' | 'embedded';

function classifyDeviceKeyword(
  text: string,
  index: number,
  keyword: string,
): DeviceKeywordContext {
  const before = text[index - 1] ?? ' ';
  const after = text.slice(index + keyword.length, index + keyword.length + 4);
  if (/ids?$/i.test(keyword)) {
    return 'field';
  }
  if (/[A-Za-z0-9]/.test(before)) {
    return 'embedded';
  }
  const assignment = DEVICE_ASSIGNMENT.test(after);
  if (/^devices$/i.test(keyword)) {
    const quoted =
      (before === '"' || before === "'") && after.startsWith(before);
    return assignment || quoted ? 'list' : 'prose';
  }
  return assignment ? 'field' : 'prose';
}

/** A redactor for one exported file. */
export function createLogRedactor(context: RedactionContext): LogRedactor {
  return new IdentifierRedactor(context);
}

class IdentifierRedactor implements LogRedactor {
  private readonly servers = new Map<string, string>();
  private readonly users = new Map<string, string>();
  private readonly rooms = new Map<string, string>();
  private readonly aliases = new Map<string, string>();
  private readonly events = new Map<string, string>();
  private readonly devices = new Map<string, string>();
  private readonly media = new Map<string, string>();
  private readonly emails = new Map<string, string>();
  /** The words of the learned file, until the names are read; never the text itself. */
  private words: LogWords | null = new LogWords();
  private names: KnownNameRedactor | null = null;
  private otherUsers = 0;

  constructor(context: RedactionContext) {
    context.selfUserIds.forEach((userId, index) => {
      const server = this.server(userId.slice(userId.indexOf(':') + 1));
      this.users.set(
        userKey(userId),
        `@me${index === 0 ? '' : index + 1}:${server}`,
      );
    });
    for (const url of context.homeserverUrls) {
      const host = hostOf(url);
      if (host) {
        this.server(host);
      }
    }
    for (const deviceId of context.selfDeviceIds) {
      this.device(deviceId);
    }
  }

  learn(text: string): void {
    // Line by line, as the capture path stores them: scrubSecrets bounds its input.
    for (const line of text.split('\n')) {
      this.words?.add(line);
      this.redactAllButNames(line);
    }
  }

  *learnNames(groups: Iterable<DiagnosticNameGroup>): Generator<void, void> {
    const words = this.words ?? new LogWords();
    this.names = yield* KnownNameRedactor.build(groups, {
      mayOccur: (name) => words.mayContain(name),
      redactIdentifiers: (text) => this.redactAllButNames(text),
    });
    this.words = null;
  }

  redact(input: string): string {
    const text = this.redactAllButNames(input);
    // Last, so a display name equal to a localpart cannot break the ID that carries it.
    return this.names ? this.names.redact(text) : text;
  }

  /** Every rule but the names. */
  private redactAllButNames(input: string): string {
    let text = scrubSecrets(input);
    text = text.replace(
      URL_HOST,
      (match, scheme: string, host: string) =>
        `${scheme}://${match.includes('@') ? '<redacted>@' : ''}${this.server(host)}`,
    );
    text = text.replace(EMAIL, (match) =>
      this.placeholder(
        this.emails,
        match.toLowerCase(),
        (n) => `email${n}@example.invalid`,
      ),
    );
    text = text.replace(
      MXC,
      (_match, host: string, mediaId: string) =>
        `mxc://${this.server(host)}/${this.placeholder(
          this.media,
          `${hostKey(host)}/${mediaId}`,
          (n) => `media${n}`,
        )}`,
    );
    text = text.replace(ENCODED_ID, (match) => this.redactEncoded(match));
    text = this.redactIdentifiers(text);
    text = this.redactServerNames(text);
    return this.redactDevices(text);
  }

  private redactEncoded(match: string): string {
    let decoded: string;
    try {
      decoded = decodeURIComponent(match);
    } catch {
      return match;
    }
    const redacted = this.redactIdentifiers(decoded);
    if (redacted === decoded) {
      return match;
    }
    // Re-encode the way the original was written: encodeURIComponent keeps "!" literal,
    // which matches the SDK; a match that arrived as %21 keeps its escape.
    const encoded = encodeURIComponent(redacted);
    return match.startsWith('%') ? encoded.replace(/!/g, '%21') : encoded;
  }

  private redactIdentifiers(text: string): string {
    return text
      .replace(USER, (match, _localpart: string, server: string) =>
        this.user(match, server),
      )
      .replace(ROOM, (match, server: string) =>
        this.placeholder(
          this.rooms,
          match,
          (n) => `!room${n}:${this.server(server)}`,
        ),
      )
      .replace(ROOM_V12, (match) =>
        this.placeholder(this.rooms, match, (n) => `!room${n}`),
      )
      .replace(ALIAS, (match, server: string) =>
        this.placeholder(
          this.aliases,
          match,
          (n) => `#alias${n}:${this.server(server)}`,
        ),
      )
      .replace(EVENT_V1, (match) =>
        this.placeholder(this.events, match, (n) => `$event${n}`),
      )
      .replace(EVENT, (match) =>
        this.placeholder(this.events, match, (n) => `$event${n}`),
      );
  }

  private redactServerNames(text: string): string {
    // One linear pass over name-shaped tokens with a map lookup: no alternation built from
    // the names seen, so a hostile line cannot grow the pattern or slow later lines.
    return text.replace(NAME_TOKEN, (token) => {
      if (token.length < 3) {
        return token;
      }
      const lower = token.toLowerCase();
      const known = this.servers.get(lower);
      if (known) {
        return known;
      }
      // A sub-host of a known server is the same operator: it gets a placeholder of its own.
      if (token.length <= MAX_NAME) {
        for (
          let dot = lower.indexOf('.');
          dot !== -1;
          dot = lower.indexOf('.', dot + 1)
        ) {
          if (this.servers.has(lower.slice(dot + 1))) {
            return this.server(lower);
          }
        }
      }
      return token;
    });
  }

  private redactDevices(text: string): string {
    const known = text.replace(WORD, (word) => this.devices.get(word) ?? word);
    return this.redactDeviceContext(known).replace(
      DEVICE_AFTER_USER,
      (_match, prefix: string, id: string) => prefix + this.device(id),
    );
  }

  /**
   * An ID-like token (6-32 letters, digits, "_" or "-") within a few words after a device
   * keyword is a device ID when its keyword context says so (see `classifyDeviceKeyword`).
   * Every item of a device list is an ID; the list ends at the first gap that is not a
   * comma or quotes, and the words after it are prose. Any other word needs a digit or
   * capitals so that ordinary prose is left alone.
   */
  private redactDeviceContext(text: string): string {
    const edits: { start: number; end: number; id: string }[] = [];
    let editedUntil = 0;
    DEVICE_KEYWORD.lastIndex = 0;
    for (
      let keyword = DEVICE_KEYWORD.exec(text);
      keyword;
      keyword = DEVICE_KEYWORD.exec(text)
    ) {
      const context = classifyDeviceKeyword(text, keyword.index, keyword[0]);
      let position = keyword.index + keyword[0].length;
      let inList = context === 'list';
      let words = 0;
      // A list is read to its end, but keywords inside it are not read again (see below);
      // elsewhere, skipped keywords count as steps, so a run of them stays linear.
      for (
        let steps = 0;
        inList ||
        (words < DEVICE_WORDS_AFTER_KEYWORD &&
          steps < 2 * DEVICE_WORDS_AFTER_KEYWORD);
        steps += 1
      ) {
        DEVICE_TOKEN.lastIndex = position;
        const token = DEVICE_TOKEN.exec(text);
        if (!token) {
          break;
        }
        const word = token[1];
        const gap = token[0].slice(0, token[0].length - word.length);
        const start = position + gap.length;
        if (inList && steps > 0 && !DEVICE_LIST_SEPARATOR.test(gap)) {
          inList = false;
          DEVICE_KEYWORD.lastIndex = Math.max(
            DEVICE_KEYWORD.lastIndex,
            position,
          );
        }
        position += token[0].length;
        if (/^devices?$|^device[_-]?ids?$/i.test(word)) {
          continue;
        }
        words += 1;
        const anyShape = inList || (context === 'field' && words === 1);
        const idLike =
          word.length >= 6 &&
          word.length <= 32 &&
          !ALREADY_PLACEHOLDER.test(word) &&
          (anyShape ||
            (context === 'prose' && words === 1 && isFirstWordDeviceId(word)) ||
            /\d/.test(word) ||
            /^[A-Z_-]+$/.test(word));
        if (idLike && start >= editedUntil) {
          edits.push({ start, end: start + word.length, id: word });
          editedUntil = start + word.length;
        }
      }
      if (inList) {
        DEVICE_KEYWORD.lastIndex = Math.max(DEVICE_KEYWORD.lastIndex, position);
      }
    }
    let output = '';
    let cursor = 0;
    for (const edit of edits) {
      output += text.slice(cursor, edit.start) + this.device(edit.id);
      cursor = edit.end;
    }
    return output + text.slice(cursor);
  }

  private user(userId: string, server: string): string {
    const key = userKey(userId);
    const known = this.users.get(key);
    if (known) {
      return known;
    }
    this.otherUsers += 1;
    const placeholder = `@user${this.otherUsers}:${this.server(server)}`;
    this.users.set(key, placeholder);
    return placeholder;
  }

  private server(name: string): string {
    return this.placeholder(this.servers, hostKey(name), (n) => `server${n}`);
  }

  private device(id: string): string {
    return ALREADY_PLACEHOLDER.test(id)
      ? id
      : this.placeholder(this.devices, id, (n) => `DEVICE${n}`);
  }

  private placeholder(
    map: Map<string, string>,
    key: string,
    make: (n: number) => string,
  ): string {
    const known = map.get(key);
    if (known) {
      return known;
    }
    const placeholder = make(map.size + 1);
    map.set(key, placeholder);
    return placeholder;
  }
}

/** A user ID's identity: its server's port is not part of who the user is. */
function userKey(userId: string): string {
  const separator = userId.indexOf(':');
  return separator === -1
    ? userId
    : `${userId.slice(0, separator)}:${hostKey(userId.slice(separator + 1))}`;
}

/** A server's identity for numbering: lower-cased, without its port. */
function hostKey(server: string): string {
  const lower = server.toLowerCase();
  return lower.startsWith('[')
    ? lower.slice(0, lower.indexOf(']') + 1)
    : lower.replace(/:\d+$/, '');
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
