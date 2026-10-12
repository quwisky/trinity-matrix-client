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
}

// A server name: DNS name or IP literal, optional port (Matrix spec, "Server name").
const SERVER = String.raw`(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)(?::\d{1,5})?`;
const USER_LOCALPART = String.raw`[A-Za-z0-9._=\-/+]+`;
const OPAQUE = String.raw`[A-Za-z0-9._~+/=-]+`;

const URL_HOST =
  /\b(https?|wss?):\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?/gi;
const MXC = /\bmxc:\/\/([A-Za-z0-9.-]+(?::\d{1,5})?)\/([A-Za-z0-9_-]+)/g;
// An identifier inside a request path. matrix-js-sdk builds paths with encodeURIComponent
// (`encodeUri` in utils.js), which escapes "@", "#", "$" and ":" but leaves "!" alone, so a
// room ID arrives as `!opaque%3Aserver`; other writers escape "!" as %21.
const ENCODED_ID =
  /(?:%(?:40|21|23|24)|!(?=[A-Za-z0-9._~-]+%3A))[A-Za-z0-9._~%-]+/gi;
const USER = new RegExp(
  String.raw`(?<![A-Za-z0-9._%+-])@(${USER_LOCALPART}):(${SERVER})`,
  'g',
);
const ROOM = new RegExp(String.raw`!${OPAQUE}:(${SERVER})`, 'g');
// Room version 12 room IDs carry no server name: "!" and 43 unpadded base64url characters.
const ROOM_V12 = /![A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;
const ALIAS = new RegExp(
  String.raw`(?<![A-Za-z0-9&])#[A-Za-z0-9._=\-]+:(${SERVER})`,
  'g',
);
const EVENT_V1 = new RegExp(String.raw`\$${OPAQUE}:${SERVER}`, 'g');
const EVENT = /\$[A-Za-z0-9+/_-]{43,44}(?![A-Za-z0-9+/_=-])/g;
const DEVICE_FIELD =
  /(\bdevice(?:[_ ]?id)?["']?\s*[:=]\s*["']?)([A-Za-z0-9_-]{6,})/gi;
const DEVICE_AFTER_USER =
  /(@(?:me\d*|user\d+):server\d+(?::| \(|\|))([A-Za-z0-9_-]{6,})/g;
// Synapse's own device ID shape; other servers' IDs are caught by context or by name.
const DEVICE_SHAPE = /\b[A-Z]{10}\b/g;
// A bare server name: dot-separated labels. Labels and dots cannot overlap, so matching is linear.
const NAME_TOKEN =
  /(?<![A-Za-z0-9.-])[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?![A-Za-z0-9-])/g;
// A run of device-ID characters, looked up in the known devices.
const WORD = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g;
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
      this.users.set(userId, `@me${index === 0 ? '' : index + 1}:${server}`);
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

  redact(input: string): string {
    let text = scrubSecrets(input);
    text = text.replace(
      URL_HOST,
      (_match, scheme: string, host: string) =>
        `${scheme}://${this.server(host)}`,
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
    return text.replace(NAME_TOKEN, (token) =>
      token.length >= 3
        ? (this.servers.get(token.toLowerCase()) ?? token)
        : token,
    );
  }

  private redactDevices(text: string): string {
    return text
      .replace(WORD, (word) => this.devices.get(word) ?? word)
      .replace(
        DEVICE_FIELD,
        (_match, prefix: string, id: string) => prefix + this.device(id),
      )
      .replace(
        DEVICE_AFTER_USER,
        (_match, prefix: string, id: string) => prefix + this.device(id),
      )
      .replace(DEVICE_SHAPE, (id) => this.device(id));
  }

  private user(userId: string, server: string): string {
    const known = this.users.get(userId);
    if (known) {
      return known;
    }
    this.otherUsers += 1;
    const placeholder = `@user${this.otherUsers}:${this.server(server)}`;
    this.users.set(userId, placeholder);
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
