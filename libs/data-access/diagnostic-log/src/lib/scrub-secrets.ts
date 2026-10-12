/** What every masked value becomes. */
export const REDACTED = '<redacted>';

/** The longest text scrubbed in one piece; anything beyond is dropped before scrubbing. */
export const MAX_SCRUB_INPUT = 64 * 1024;

const CUT_NOTE = ' [rest dropped before scrubbing]';

/** Characters a token never contains: a cut backs off to the last of these. */
const SEPARATOR = /[\s"',;{}[\]()<>]/;

/**
 * Names whose value is a credential, key material, a push or TURN secret, or message
 * content. One list feeds both the field rule (JSON and object-literal text) and the
 * query/form parameter rule, so the two cannot drift apart.
 */
const SECRET_KEYS = [
  // Matrix, OIDC and registration credentials.
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'login_token',
  'loginToken',
  'id_token',
  'idToken',
  'token',
  'registration_token',
  'registrationToken',
  'client_secret',
  'clientSecret',
  'code_verifier',
  'codeVerifier',
  // User-interactive auth: the whole `auth` dict, and passwords wherever they sit.
  'auth',
  'password',
  'new_password',
  'newPassword',
  'passphrase',
  // Recovery, secret storage, pickle, backup and session keys.
  'recovery_key',
  'recoveryKey',
  'private_key',
  'privateKey',
  'secret',
  'secret_storage_key',
  'secretStorageKey',
  'pickle_key',
  'pickleKey',
  'backup_key',
  'backupKey',
  'decryption_key',
  'decryptionKey',
  'session_key',
  'sessionKey',
  'key',
  'ciphertext',
  // Push keys and device tokens (FCM, APNs).
  'pushkey',
  'pushKey',
  'push_key',
  'fcm_token',
  'fcmToken',
  'apns_token',
  'apnsToken',
  // TURN credentials (`/voip/turnServer`) pair a username with a password.
  'username',
  'credential',
  // Cookies serialised as fields.
  'cookie',
  'Cookie',
  // Message content.
  'body',
  'formatted_body',
];

/** OAuth/OIDC callback names: masked as parameters; as fields unless a known short shape. */
const OAUTH_KEYS = ['code', 'state', 'sso_state'];

/** A name with its case and separators removed, so `api_key`, `api-key` and `apiKey` agree. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[_.-]/g, '');
}

/** Words that make any name containing them secret: `userPassword`, `db_passwd`, `authToken`. */
const SECRET_WORDS = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'credential',
  'apikey',
  'authkey',
  'privatekey',
  'recoverykey',
];

const EXACT_SECRET_NAMES: ReadonlySet<string> = new Set(
  SECRET_KEYS.map(normalizeName),
);

/** Names that contain a secret word but carry no secret. */
const PUBLIC_NAMES: ReadonlySet<string> = new Set([
  'tokentype',
  'tokenendpoint',
  'tokenexpiresat',
  'tokenexpiresin',
  'accesstokenexpiresat',
  'refreshtokenexpiresat',
]);

/** Matrix error codes (`M_UNKNOWN_TOKEN`) name no secret. */
const ERROR_CODE_NAME = /^M_[A-Z_]+$/;

function isSecretName(name: string): boolean {
  if (ERROR_CODE_NAME.test(name)) {
    return false;
  }
  const normalized = normalizeName(name);
  return (
    !PUBLIC_NAMES.has(normalized) &&
    (EXACT_SECRET_NAMES.has(normalized) ||
      SECRET_WORDS.some((word) => normalized.includes(word)))
  );
}

/** A secret parameter: a secret name (`username=alice` is ordinary), or an OAuth callback value. */
function isSecretParam(name: string): boolean {
  const normalized = normalizeName(name);
  return (
    OAUTH_KEYS.some((key) => normalizeName(key) === normalized) ||
    (normalized !== 'username' && isSecretName(name))
  );
}

/**
 * A field name, quoted (`"k"`, `'k'`, `\"k\"` inside an escaped JSON string) or bare, then
 * a colon. The name cannot continue an identifier (`M_UNKNOWN_TOKEN:`, `Set-Cookie:`). Every
 * quantifier is bounded, so no input costs more than a fixed multiple of its length.
 */
const FIELD_NAME = String.raw`(?<![\w$-])(\\{0,8}["']?)([A-Za-z_][\w.-]{0,63})\1\s*:\s*`;

/** A bare `true`, `false` or `null`: no secret, unless the name is a credential itself. */
const FLAG_VALUE = /^(?:true|false|null)$/;

/**
 * Names that are a credential word and nothing more (`password`, `token`, `code`): the value
 * under one is the secret itself, so even a flag is masked. A name that only contains one,
 * such as `hasPassword`, keeps its flag readable.
 */
const CREDENTIAL_WORDS: ReadonlySet<string> = new Set([
  'password',
  'passphrase',
  'passwd',
  'secret',
  'token',
  'key',
  'code',
  'state',
  'credential',
]);

/** A flag that may be kept under `name`: see {@link CREDENTIAL_WORDS}. */
function isReadableFlag(name: string, value: string): boolean {
  return FLAG_VALUE.test(value) && !CREDENTIAL_WORDS.has(normalizeName(name));
}

/** A parameter name and its value; the name may start after any non-alphanumeric character. */
const PARAM = /(?<![A-Za-z0-9])([A-Za-z_][\w.-]{0,63})=([^&#\s"']*)/g;

/** `code` and `state` values that are diagnostics, not OAuth secrets. */
const KEPT_OAUTH_VALUE =
  /^(?:M_[A-Z][A-Z_]*|PREPARED|SYNCING|CATCHUP|RECONNECTING|ERROR|STOPPED|[a-z]{2,}(?:-[a-z]{2,})+)$/;

/**
 * Patterns for values that must never be stored, applied in order. Matrix identifiers are
 * deliberately left alone: the on-device log keeps them, and the export redactor replaces
 * them (spec §2). Each rule is covered by `scrub-secrets.spec.ts`.
 */
const HEADER_RULES: readonly (readonly [RegExp, string])[] = [
  // Bearer credentials, then whatever an Authorization header or field still carries, under
  // any scheme (Bearer, Basic, …), then cookies.
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  [
    /("?\bauthorization"?\s*[:=]\s*"?)(?:[A-Za-z][\w-]*\s+)?[^",}\s]+/gi,
    `$1${REDACTED}`,
  ],
  [/("?\b(?:set-)?cookie"?\s*[:=]\s*"?)[^"\r\n}]+/gi, `$1${REDACTED}`],
];

/** Patterns for token-shaped values, applied after the header and name-based rules. */
const SECRET_RULES: readonly (readonly [RegExp, string])[] = [
  // Synapse (syt_/syr_) and MAS (mat_/mar_/mct_) tokens, and JWTs.
  [/\b(?:syt|syr|mat|mar|mct)_[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // FCM registration tokens, prefix included.
  [/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{8,64}:APA91[A-Za-z0-9_-]{16,}/g, REDACTED],
  // Recovery keys: base58 starting "Es", twelve groups of four, spaces optional.
  [
    /\bEs[1-9A-HJ-NP-Za-km-z]{2}(?:\s?[1-9A-HJ-NP-Za-km-z]{4}){11}\b/g,
    REDACTED,
  ],
  // Precise locations (m.location geo: URIs).
  [/\bgeo:[-+]?\d[^\s"']*/gi, `geo:${REDACTED}`],
  // APNs device tokens and other long hex secrets (not after "@", "!" or "$": Matrix IDs).
  [/(?<![@!$])\b[0-9A-Fa-f]{32,}\b/g, REDACTED],
  // Long runs mixing digits, lower and upper case: keys, session IDs, opaque tokens, FCM
  // tokens. A run straight after a %-escape is masked too, unless the escape is %21 ("!") or
  // %24 ("$"), which start an encoded room or event ID…
  [
    /(%(?!2[14])[0-9A-Fa-f]{2})(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])[A-Za-z0-9+/_-]{32,}={0,2}/g,
    `$1${REDACTED}`,
  ],
  // …and a run after "$" or "!" is an event or room ID, left for the export redactor.
  [
    /(?<![$!%A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])[A-Za-z0-9+/_-]{32,}={0,2}/g,
    REDACTED,
  ],
];

/**
 * Mask every secret-shaped value in one log message. Runs at capture, through
 * {@link scrubMessage}, and again at export as a second line of defence.
 */
export function scrubSecrets(text: string): string {
  let scrubbed = text;
  for (const [pattern, replacement] of HEADER_RULES) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  // Credential query, fragment and form parameters. matrix-js-sdk masks its own request URLs
  // (`sanitizeUrlForLogs`); URLs in errors, callbacks, widgets and form bodies are not masked.
  scrubbed = scrubbed.replace(PARAM, (whole, name: string, value: string) =>
    isSecretParam(name) && !isReadableFlag(name, value)
      ? `${name}=${REDACTED}`
      : whole,
  );
  for (const [pattern, replacement] of SECRET_RULES) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  scrubbed = maskFields(scrubbed, isSecretName, false);
  return maskFields(scrubbed, isOAuthName, true);
}

/**
 * Scrub one captured message, failing closed. Text past {@link MAX_SCRUB_INPUT} is dropped,
 * together with the token the cut runs through, so no secret is kept in part; a scrub that
 * throws returns {@link REDACTED}. Nothing unscrubbed is ever returned. Cut the result to
 * length afterwards, never before.
 */
export function scrubMessage(text: string): string {
  try {
    return scrubSecrets(
      text.length > MAX_SCRUB_INPUT
        ? `${cutAtSeparator(text, MAX_SCRUB_INPUT)}${CUT_NOTE}`
        : text,
    );
  } catch {
    return REDACTED;
  }
}

/**
 * Anything that could be a recovery key's start left at the end of a cut: "Es", its first
 * group and up to ten more. Its groups are separated by spaces, so backing off to a
 * separator can stop inside the key. Fail-closed: a word like "Esto" at the cut is dropped
 * too, since it is indistinguishable from a key's first group.
 */
const CUT_RECOVERY_KEY =
  /\bEs(?:[1-9A-HJ-NP-Za-km-z]{2}(?:\s?[1-9A-HJ-NP-Za-km-z]{4}){0,10})?\s*$/;

/**
 * The text up to `limit`, backed off to the last separator so no token is cut in half, and
 * without anything that could be a recovery key's leading groups, which the full-key rule
 * would no longer match.
 */
function cutAtSeparator(text: string, limit: number): string {
  let end = limit;
  while (end > 0 && !SEPARATOR.test(text[end - 1])) {
    end -= 1;
  }
  return text.slice(0, end).replace(CUT_RECOVERY_KEY, '');
}

interface FieldValue {
  /** Index just past the value. */
  readonly end: number;
  /** What replaces the value: the original quoting around the redaction marker. */
  readonly masked: string;
  /** The value's text for strings and bare scalars; `undefined` for objects and arrays. */
  readonly content: string | undefined;
  /** Whether the value was written without quotes (a number, flag or bare word). */
  readonly bare: boolean;
}

/**
 * Mask the value after every field the pattern finds. A value is a quoted string (a cut-off
 * one runs to the end), a bare scalar (up to a comma, bracket or line end), or an object or
 * array, masked through its balanced end. `oauth` keeps the short diagnostic shapes of
 * `code` and `state`. Fields inside a masked value are skipped.
 */
function maskFields(
  text: string,
  isTarget: (name: string) => boolean,
  oauth: boolean,
): string {
  const pattern = new RegExp(FIELD_NAME, 'g');
  let out = '';
  let position = 0;
  for (
    let match = pattern.exec(text);
    match !== null;
    match = pattern.exec(text)
  ) {
    if (!isTarget(match[2])) {
      continue;
    }
    const start = match.index + match[0].length;
    const value = readValue(text, start, oauth);
    if (value === null) {
      continue;
    }
    pattern.lastIndex = value.end;
    const alreadyMasked = value.content === REDACTED;
    const flag = value.bare && isReadableFlag(match[2], value.content ?? '');
    const kept =
      oauth &&
      value.content !== undefined &&
      KEPT_OAUTH_VALUE.test(value.content);
    if (alreadyMasked || flag || kept) {
      continue;
    }
    out += text.slice(position, start) + value.masked;
    position = value.end;
  }
  return out + text.slice(position);
}

function isOAuthName(name: string): boolean {
  return OAUTH_KEYS.includes(name.toLowerCase());
}

function readValue(
  text: string,
  start: number,
  stopAtSpace: boolean,
): FieldValue | null {
  let slashes = 0;
  while (text[start + slashes] === '\\') {
    slashes += 1;
  }
  const quote = text[start + slashes];
  if (quote === '"' || quote === "'") {
    return readString(text, start, `${'\\'.repeat(slashes)}${quote}`);
  }
  const first = text[start];
  if (first === '{' || first === '[') {
    return {
      end: balancedEnd(text, start),
      masked: `"${REDACTED}"`,
      content: undefined,
      bare: false,
    };
  }
  let end = start;
  while (end < text.length && !isScalarEnd(text[end], stopAtSpace)) {
    end += 1;
  }
  const content = text.slice(start, end).trimEnd();
  if (content === '') {
    return null;
  }
  return {
    end: start + content.length,
    masked: `"${REDACTED}"`,
    content,
    bare: true,
  };
}

function isScalarEnd(char: string, stopAtSpace: boolean): boolean {
  return (
    char === ',' ||
    char === '}' ||
    char === ']' ||
    char === '\r' ||
    char === '\n' ||
    (stopAtSpace && /\s/.test(char))
  );
}

/** A quoted string; escaped quotes (`\\"`) close only on the same escape. Cut-off runs to the end. */
function readString(text: string, start: number, opener: string): FieldValue {
  const from = start + opener.length;
  let close = -1;
  if (opener.length > 1) {
    close = text.indexOf(opener, from);
  } else {
    for (let i = from; i < text.length; i += text[i] === '\\' ? 2 : 1) {
      if (text[i] === opener) {
        close = i;
        break;
      }
    }
  }
  const contentEnd = close === -1 ? text.length : close;
  return {
    end: close === -1 ? text.length : close + opener.length,
    masked: `${opener}${REDACTED}${opener}`,
    content: text.slice(from, contentEnd),
    bare: false,
  };
}

/**
 * Index just past the `{`/`[` group starting at `start`, skipping quoted strings and escaped
 * characters. When the group never balances, the whole rest of the text counts as inside it.
 */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const char = text[i];
    if (char === '\\') {
      i += 2;
    } else if (char === '"' || char === "'") {
      i += 1;
      while (i < text.length && text[i] !== char) {
        i += text[i] === '\\' ? 2 : 1;
      }
      i += 1;
    } else {
      if (char === '{' || char === '[') {
        depth += 1;
      } else if ((char === '}' || char === ']') && (depth -= 1) === 0) {
        return i + 1;
      }
      i += 1;
    }
  }
  return text.length;
}
