import { scrubSecrets } from '../scrub-secrets';

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
}

// A server name: DNS name or IP literal, optional port (Matrix spec, "Server name").
const SERVER = String.raw`(?:\[[0-9A-Fa-f:.]+\]|[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*)(?::\d{1,5})?`;
const USER_LOCALPART = String.raw`[A-Za-z0-9._=\-/+]+`;
const OPAQUE = String.raw`[A-Za-z0-9._~+/=-]+`;

// The optional userinfo is bounded, so a long run of "@" or ":" cannot make the scan quadratic.
const URL_HOST =
  /\b(https?|wss?):\/\/(?:[^\s/@?#]{1,256}@)?(\[[0-9A-Fa-f:.]+\]|[\p{L}\p{N}.-]+)(?::\d{1,5})?/giu;
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
const DEVICE_KEYWORD = /device(?:s|[_ ]?ids?)?(?![A-Za-z0-9_])/gi;
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
const ALREADY_PLACEHOLDER = /^(?:DEVICE|server)\d+$/;

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
      this.redact(line);
    }
  }

  redact(input: string): string {
    let text = scrubSecrets(input);
    text = text.replace(
      URL_HOST,
      (match, scheme: string, host: string) =>
        `${scheme}://${match.includes('@') ? '<redacted>@' : ''}${this.server(host)}`,
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
   * An ID-like token (6-32 letters, digits, "_" or "-") within a few words after the word
   * "device" is a device ID. The first word after a standalone "device" may have any shape;
   * later words, and words after an embedded keyword such as `sendToDevice`, need a digit or
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
      const standalone = !/[A-Za-z0-9]/.test(text[keyword.index - 1] ?? ' ');
      let position = keyword.index + keyword[0].length;
      let words = 0;
      // Keywords skipped below count as steps, so a run of them cannot make this quadratic.
      for (
        let steps = 0;
        words < DEVICE_WORDS_AFTER_KEYWORD &&
        steps < 2 * DEVICE_WORDS_AFTER_KEYWORD;
        steps += 1
      ) {
        DEVICE_TOKEN.lastIndex = position;
        const token = DEVICE_TOKEN.exec(text);
        if (!token) {
          break;
        }
        const word = token[1];
        const start = position + token[0].length - word.length;
        position += token[0].length;
        if (/^devices?$|^device[_ ]?ids?$/i.test(word)) {
          continue;
        }
        words += 1;
        const idLike =
          word.length >= 6 &&
          word.length <= 32 &&
          !ALREADY_PLACEHOLDER.test(word) &&
          ((standalone && words === 1) ||
            /\d/.test(word) ||
            /^[A-Z_-]+$/.test(word));
        if (idLike && start >= editedUntil) {
          edits.push({ start, end: start + word.length, id: word });
          editedUntil = start + word.length;
        }
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
