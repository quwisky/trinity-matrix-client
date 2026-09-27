import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import { HARNESS_SECRETS } from './synapse/credentials.mjs';

/**
 * Published Android diagnostics never carry a raw Matrix Room or event
 * identifier, whether or not a suite registered it as protected, nor a Matrix
 * access or refresh token or secure-storage payload. These shapes are
 * recognised independently of any registered value; a suite's own
 * digest-based checks remain responsible for the identifiers it knows.
 */
export const MATRIX_IDENTIFIER_REDACTION = '[REDACTED]';

/** `%24`, `%2524`, …: one percent-encoded byte at any nesting depth. */
const encoded = (hex: string): string =>
  `%(?:25)*${hex.replace(/[A-F]/gu, (digit) => `[${digit}${digit.toLowerCase()}]`)}`;

/**
 * A room-version 3+ event id: `$` and 43 URL-safe base64 characters, raw or
 * percent-encoded. Forty is the floor so a truncated capture still matches.
 */
const EVENT_ID = `(?:\\$|${encoded('24')})[A-Za-z0-9_-]{40,}`;

/**
 * A Room id (`!localpart:server`, optionally with a port), raw or
 * percent-encoded; `encodeURIComponent` keeps `!` and encodes only the colon.
 * The whole identifier is redacted, like a registered Room id would be.
 */
const COLON = `(?::|${encoded('3A')})`;
const ROOM_ID = `(?:!|${encoded('21')})[A-Za-z0-9_=-]{8,}${COLON}(?:\\[[0-9A-Fa-f:.]+\\]|[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*)(?:${COLON}[0-9]{1,5}(?![0-9]))?`;

/** A base64url token long enough to hold `!localpart:server`, as in `/rooms/<segment>`. */
const BASE64URL_TOKEN =
  /(?<![A-Za-z0-9_-])I[A-Za-z0-9_-]{15,}(?![A-Za-z0-9_-])/gu;
const ENCODED_ROOM_ID = /^![A-Za-z0-9_=-]{8,}:[A-Za-z0-9.[\]:-]+$/u;

const identifierPattern = (): RegExp =>
  new RegExp(`${EVENT_ID}|${ROOM_ID}`, 'gu');

/*
 * Matrix credentials. Published diagnostics never carry one either: the debug
 * APK's Capacitor bridge logs every secure-storage call with its payload, for
 * example `pluginId: SecureStorage, methodName: internalSetItem, methodData:
 * {"prefixedKey":"capacitor-storage_matrix.accessToken:@user:server","data":
 * "\"syt_…\""}`, and that logcat reached the retained Android upload.
 */

/** Characters of an access or refresh token, and its minimum length. */
const TOKEN_VALUE = '[A-Za-z0-9._~+/=-]{8,}';

/**
 * Synapse (`syt_`, `syr_`) and Matrix Authentication Service (`mat_`, `mar_`)
 * access and refresh tokens. The word boundary keeps `…format_` from matching.
 */
const TOKEN_SHAPE = /\b(?:syt|syr|mat|mar)_[A-Za-z0-9_]{16,}/gu;

/** `Bearer <token>`, with a raw or percent-encoded space. */
const BEARER = new RegExp(
  `((?<![A-Za-z])Bearer(?:\\s+|${encoded('20')}|\\+))${TOKEN_VALUE}`,
  'giu',
);

/**
 * The value of an `accessToken`/`access_token`/`refreshToken`/`refresh_token`
 * field, whether JSON (raw or escaped), a query parameter or a header, with any
 * of its delimiters percent-encoded.
 */
const DELIMITER = `(?:\\s|\\\\|"|:|=|${encoded('22')}|${encoded('3A')}|${encoded('3D')}|${encoded('5C')}|${encoded('20')})`;
const TOKEN_FIELD = new RegExp(
  `((?:access|refresh)_?[Tt]oken${DELIMITER}+)${TOKEN_VALUE}`,
  'gu',
);

/** A Capacitor secure-storage bridge call: its whole payload is secret. */
const SECURE_STORAGE_PAYLOAD =
  /(\bpluginId:[ \t]*SecureStorage\b[^\r\n]*?\bmethodData:[ \t]*)([^\r\n]*)/gu;

function redactCredentials(text: string): string {
  return text
    .replace(SECURE_STORAGE_PAYLOAD, `$1${MATRIX_IDENTIFIER_REDACTION}`)
    .replace(TOKEN_SHAPE, MATRIX_IDENTIFIER_REDACTION)
    .replace(BEARER, `$1${MATRIX_IDENTIFIER_REDACTION}`)
    .replace(TOKEN_FIELD, `$1${MATRIX_IDENTIFIER_REDACTION}`);
}

function hasCredential(text: string): boolean {
  for (const match of text.matchAll(SECURE_STORAGE_PAYLOAD))
    if (match[2]?.trim() !== MATRIX_IDENTIFIER_REDACTION) return true;
  return [TOKEN_SHAPE, BEARER, TOKEN_FIELD].some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

const isEncodedRoomId = (token: string): boolean =>
  ENCODED_ROOM_ID.test(Buffer.from(token, 'base64url').toString('latin1'));

/**
 * Terminal colour sequences, raw or JSON-escaped. Node colours the character
 * diff of an assertion message when colour is forced (as under Nx), which
 * splits an identifier into single characters between escape sequences.
 */
const ANSI_SEQUENCE = /(?:\u001b|\\u001[bB])\[[0-9;]*[A-Za-z]/gu;

/**
 * Redact every Matrix access or refresh token, bearer value, token field and
 * secure-storage payload, leaving Room and event identifiers intact. This is
 * the boundary for published browser and desktop diagnostics, which keep
 * identifiers for debugging but never a credential.
 */
export function redactMatrixCredentials(text: string): string {
  const redacted = redactCredentials(text);
  const plain = redacted.replace(ANSI_SEQUENCE, '');
  return plain !== redacted && hasCredential(plain)
    ? redactCredentials(plain)
    : redacted;
}

/** Whether text still carries a Matrix credential, even between colour sequences. */
export function hasMatrixCredential(text: string): boolean {
  return hasCredential(text) || hasCredential(text.replace(ANSI_SEQUENCE, ''));
}

/*
 * Test-account passwords. Playwright serializes every one it handles: request
 * bodies (`"password":"…"`) in traces and API step parameters, `Fill "…"`
 * step titles, the `value` parameter and `fill("…")` log line of a fill, and
 * the `__playwright_value_` of each snapshotted input. Structured rules find a
 * password by its context; the values they find are then redacted wherever
 * else they appear, together with any secret the caller registers.
 */

/** A password field name: `password`, `new_password`, `newPassword`, `passphrase`, `pass`. */
const PASSWORD_KEY = String.raw`(?<![A-Za-z_-])(?:[A-Za-z_]*[Pp]ass(?:word|phrase)|pass)(?![A-Za-z0-9_])`;
/** A quote at any JSON escape depth, as an XML entity, percent-encoded, or a JS quote. */
const QUOTE = String.raw`\\*"|&quot;|%(?:25)*22|'|${'`'}`;
const SEPARATOR = String.raw`\s*(?::|=|%(?:25)*3[Aa]|%(?:25)*3[Dd])\s*`;
const PASSWORD_FIELD = new RegExp(
  String.raw`(${PASSWORD_KEY}(?:${QUOTE})?${SEPARATOR})(?:(${QUOTE})(.*?)\2|(\[REDACTED\]|[^\s"'${'`'}\\&,;)}\]<>%]+))`,
  'gu',
);
/**
 * A double quote at any escape depth: with a bare form field (`password=…`),
 * the only quoting whose values are harvested. Source text quotes a password
 * variable or template with single quotes or backticks instead.
 */
const DOUBLE_QUOTE = /^(?:\\*"|&quot;|%(?:25)*22)$/u;
/** A `Fill "…"` or `Type "…"` step title, raw or JSON-escaped. */
const FILL_TITLE = /\b(?:Fill|Type)\s+(\\*"|&quot;)/gu;
/** A flat JSON object: fill parameters and snapshotted input attributes. */
const FLAT_OBJECT = /\{[^{}]*\}/gu;
const OBJECT_VALUE =
  /((\\*)"(?:value|__playwright_value_)\2"\s*:\s*\2")(.*?)(?<!\\)\2"/gu;
const MENTIONS_PASSWORD = /pass(?:word|phrase)/iu;
/** Harvested values shorter than this are redacted only in their context. */
const MIN_SECRET_LENGTH = 6;

interface PasswordMatch {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

/** Where a `Fill "…"` title's value ends, and whether its target is a password field. */
function fillTitles(text: string): PasswordMatch[] {
  const matches: PasswordMatch[] = [];
  for (const match of text.matchAll(FILL_TITLE)) {
    const quote = match[1] ?? '"';
    const start = (match.index ?? 0) + match[0].length;
    const end = text.indexOf(quote, start);
    if (end < 0) continue;
    // The title is a string one escape level up: it ends at the first quote
    // of that level, or at the end of the line for an unescaped title.
    const depth = quote.startsWith('\\') ? (quote.length - 2) / 2 : -1;
    const rest = text.slice(end + quote.length, end + quote.length + 400);
    const terminator =
      depth < 0
        ? /[\r\n]/u
        : new RegExp(String.raw`(?<!\\)${'\\\\'.repeat(depth)}"`, 'u');
    const close = rest.search(terminator);
    const title = close < 0 ? rest : rest.slice(0, close);
    if (MENTIONS_PASSWORD.test(title))
      matches.push({ start, end, value: text.slice(start, end) });
  }
  return matches;
}

/** Fill `value` parameters and input snapshots of an object that names a password. */
function passwordObjects(text: string): PasswordMatch[] {
  const matches: PasswordMatch[] = [];
  for (const object of text.matchAll(FLAT_OBJECT)) {
    const body = object[0];
    const outside = body.replace(OBJECT_VALUE, '$1');
    if (!MENTIONS_PASSWORD.test(outside)) continue;
    for (const field of body.matchAll(OBJECT_VALUE)) {
      const start = (object.index ?? 0) + (field.index ?? 0) + field[1]!.length;
      matches.push({ start, end: start + field[3]!.length, value: field[3]! });
    }
  }
  return matches;
}

function passwordFields(text: string): PasswordMatch[] {
  const matches: PasswordMatch[] = [];
  for (const field of text.matchAll(PASSWORD_FIELD)) {
    const quote = field[2];
    const value = quote === undefined ? field[4]! : field[3]!;
    const start =
      (field.index ?? 0) +
      field[1]!.length +
      (quote === undefined ? 0 : quote.length);
    matches.push({ start, end: start + value.length, value });
  }
  return matches;
}

const secretPatterns = new Map<string, RegExp>();

/**
 * An exact secret, raw, JSON-escaped at any depth or percent-encoded. The
 * harness's fixed passwords and registration secret are always included.
 */
function secretPattern(secrets: Iterable<string>): RegExp {
  const forms = new Set<string>();
  for (const secret of new Set([...HARNESS_SECRETS, ...secrets])) {
    if (secret.length < MIN_SECRET_LENGTH) continue;
    let escaped = secret;
    for (let depth = 0; depth < 4; depth += 1) {
      forms.add(escaped);
      escaped = JSON.stringify(escaped).slice(1, -1);
    }
    forms.add(encodeURIComponent(secret));
    forms.add(encodeURIComponent(encodeURIComponent(secret)));
  }
  const alternatives = [...forms]
    .sort(
      (left, right) => right.length - left.length || (left < right ? -1 : 1),
    )
    .map((form) => form.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  // With no secret at all the pattern must match nothing, not the empty string.
  const source = alternatives.join('|') || '(?!)';
  let pattern = secretPatterns.get(source);
  if (!pattern) {
    if (secretPatterns.size > 64) secretPatterns.clear();
    pattern = new RegExp(source, 'gu');
    secretPatterns.set(source, pattern);
  }
  pattern.lastIndex = 0;
  return pattern;
}

function replaceRanges(text: string, ranges: readonly PasswordMatch[]): string {
  let output = '';
  let cursor = 0;
  for (const { start, end } of [...ranges].sort((a, b) => a.start - b.start)) {
    if (start < cursor) continue;
    output += text.slice(cursor, start) + MATRIX_IDENTIFIER_REDACTION;
    cursor = end;
  }
  return output + text.slice(cursor);
}

/**
 * Values that are never a secret: already redacted, empty, a flag such as
 * Android accessibility's `password: false`, or a source template such as
 * `${user}-pass` in an error context's code frame.
 */
const isRedacted = (value: string): boolean =>
  value === MATRIX_IDENTIFIER_REDACTION ||
  value.includes('${') ||
  /^(?:|true|false|null|undefined)$/u.test(value);

export interface AccountPasswordOptions {
  /**
   * Apply the context rules. Off for bundled viewer code, where a password
   * field of a minified library is not a test account's password; registered
   * and harvested secrets are still redacted there.
   */
  readonly structured?: boolean;
}

/**
 * Every password value the context rules find in text, long enough to be
 * redacted wherever else it appears: a double-quoted or form-encoded password
 * field, a fill of a password field (its title, `value` parameter and input
 * snapshot).
 */
export function collectAccountPasswords(text: string): string[] {
  const values = new Set<string>();
  for (const field of text.matchAll(PASSWORD_FIELD)) {
    const quote = field[2];
    if (quote === undefined) {
      // Only a form or query field (`?password=…`, `&password=…`): a log's
      // `isPassword=disabled` is a setting, not a password.
      const before = text[(field.index ?? 0) - 1] ?? '';
      if (
        /^(?:new_|old_)?pass(?:word|phrase)?=$/u.test(field[1]!) &&
        /^[?&\s]?$/u.test(before)
      )
        values.add(field[4]!);
    } else if (DOUBLE_QUOTE.test(quote)) values.add(field[3]!);
  }
  for (const { value } of [...fillTitles(text), ...passwordObjects(text)])
    values.add(value);
  return [...values].filter(
    (value) => value.length >= MIN_SECRET_LENGTH && !isRedacted(value),
  );
}

/** Redact test-account passwords by context and every registered or harvested secret. */
export function redactAccountPasswords(
  text: string,
  secrets: Iterable<string> = [],
  { structured = true }: AccountPasswordOptions = {},
): string {
  let redacted = text;
  if (structured) {
    redacted = replaceRanges(redacted, fillTitles(redacted));
    redacted = replaceRanges(redacted, passwordObjects(redacted));
    redacted = replaceRanges(
      redacted,
      passwordFields(redacted).filter(({ value }) => !isRedacted(value)),
    );
  }
  return redacted.replace(secretPattern(secrets), MATRIX_IDENTIFIER_REDACTION);
}

/** Whether text still carries a test-account password by context or a known secret. */
export function hasAccountPassword(
  text: string,
  secrets: Iterable<string> = [],
  { structured = true }: AccountPasswordOptions = {},
): boolean {
  if (secretPattern(secrets).test(text)) return true;
  if (!structured) return false;
  return [
    ...fillTitles(text),
    ...passwordObjects(text),
    ...passwordFields(text),
  ].some(({ value }) => !isRedacted(value));
}

function redactShapes(text: string): string {
  return redactCredentials(text)
    .replace(identifierPattern(), MATRIX_IDENTIFIER_REDACTION)
    .replace(BASE64URL_TOKEN, (token) =>
      isEncodedRoomId(token) ? MATRIX_IDENTIFIER_REDACTION : token,
    );
}

function hasShape(text: string): boolean {
  if (hasCredential(text)) return true;
  if (identifierPattern().test(text)) return true;
  for (const [token] of text.matchAll(BASE64URL_TOKEN))
    if (isEncodedRoomId(token)) return true;
  return false;
}

export interface MatrixIdentifierOptions extends AccountPasswordOptions {
  /**
   * Passwords already known to the caller: registered by a suite or harvested
   * from other diagnostics of the same upload. Values the context rules find
   * in the text itself are always added.
   */
  readonly secrets?: Iterable<string>;
}

/**
 * The strict Android scrub: every Matrix event-id and Room-id shape (raw,
 * percent-encoded or as a base64url Room route segment), every credential and
 * every test-account password. Colour sequences are kept unless they hide a
 * shape, in which case the text is uncoloured and then redacted.
 */
export function redactMatrixIdentifiers(
  text: string,
  { secrets = [], structured = true }: MatrixIdentifierOptions = {},
): string {
  const known = new Set(secrets);
  if (structured)
    for (const value of collectAccountPasswords(text)) known.add(value);
  const redact = (value: string): string =>
    redactAccountPasswords(redactShapes(value), known, { structured });
  const has = (value: string): boolean =>
    hasShape(value) || hasAccountPassword(value, known, { structured });
  const redacted = redact(text);
  const plain = redacted.replace(ANSI_SEQUENCE, '');
  return plain !== redacted && has(plain) ? redact(plain) : redacted;
}

/**
 * Whether text still carries a Matrix event-id or Room-id shape, a credential
 * or a test-account password, even between colour sequences.
 */
export function hasMatrixIdentifier(
  text: string,
  { secrets = [], structured = true }: MatrixIdentifierOptions = {},
): boolean {
  const has = (value: string): boolean =>
    hasShape(value) || hasAccountPassword(value, secrets, { structured });
  return has(text) || has(text.replace(ANSI_SEQUENCE, ''));
}

/**
 * Redact a text stream by whole lines, so an identifier split across two
 * chunks is still recognised. A line longer than `maxPending` is released
 * except for a tail that can still hold the start of an identifier.
 */
export class MatrixIdentifierLineRedactor {
  private pending = '';

  /** Passwords seen so far, redacted in every later line too. */
  private readonly secrets = new Set<string>();

  private readonly maxPending: number;

  constructor(maxPending = 64 * 1024) {
    this.maxPending = maxPending;
  }

  private redact(text: string): string {
    for (const value of collectAccountPasswords(text)) this.secrets.add(value);
    return redactMatrixIdentifiers(text, { secrets: this.secrets });
  }

  write(chunk: string): string {
    const text = this.pending + chunk;
    const end = text.lastIndexOf('\n');
    if (end >= 0) {
      this.pending = text.slice(end + 1);
      return this.redact(text.slice(0, end + 1)) + this.overflow();
    }
    this.pending = text;
    return this.overflow();
  }

  flush(): string {
    const rest = this.pending;
    this.pending = '';
    return this.redact(rest);
  }

  private overflow(): string {
    if (this.pending.length <= this.maxPending) return '';
    // Release up to a delimiter: identifier shapes contain none, so no shape
    // can straddle the cut. The unterminated remainder stays pending.
    const limit = this.pending.length - 512;
    const run = this.pending.slice(0, limit).search(/[^\s"'`<>(){},;]*$/u);
    const cut = run > 0 ? run : limit;
    const released = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    return this.redact(released);
  }
}

/** Raster and video proof carries no text diagnostic; it is left untouched. */
const MEDIA_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.mp4',
  '.png',
  '.tif',
  '.tiff',
  '.webm',
  '.webp',
]);

export interface MatrixIdentifierScanResult {
  /** Relative paths of text diagnostics the scrub rewrote. */
  readonly redacted: readonly string[];
  /** Relative paths that still carry an identifier or cannot be verified as text. */
  readonly unsafe: readonly string[];
}

async function* regularFiles(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* regularFiles(path);
    else if (entry.isFile()) yield path;
    else
      throw new Error('Diagnostics contain only regular files and directories');
  }
}

export type MatrixIdentifierFileState =
  'clean' | 'redacted' | 'unsafe' | 'media';

/**
 * Bundled code (a report or trace viewer, snapshotted page styles and
 * scripts) is not a diagnostic: a minified library's `password:e` is not a
 * test account's password, so only known secrets are checked there.
 */
const CODE_EXTENSIONS = new Set([
  '.css',
  '.htm',
  '.html',
  '.js',
  '.map',
  '.mjs',
  '.svg',
  '.webmanifest',
]);

/** Whether the context rules apply to a file or archive member of this name. */
export const isStructuredDiagnostic = (name: string): boolean =>
  !CODE_EXTENSIONS.has(extname(name).toLowerCase());

/**
 * Every password the context rules find in these text diagnostics, so each
 * is redacted wherever else it appears in the same publication.
 */
export async function harvestAccountPasswords(
  paths: Iterable<string>,
): Promise<Set<string>> {
  const secrets = new Set<string>(HARNESS_SECRETS);
  for (const path of paths) {
    if (!isStructuredDiagnostic(path)) continue;
    if (MEDIA_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    const bytes = await readFile(path);
    if (bytes.includes(0)) continue;
    for (const value of collectAccountPasswords(bytes.toString('utf8')))
      secrets.add(value);
  }
  return secrets;
}

/**
 * Redact one diagnostic in place and rescan it. Media files are skipped; any
 * other file with a NUL byte is binary and cannot be verified, so it is unsafe
 * like a file that still carries an identifier after the scrub.
 */
export async function scrubMatrixIdentifierFile(
  path: string,
  secrets: Iterable<string> = [],
): Promise<MatrixIdentifierFileState> {
  if (MEDIA_EXTENSIONS.has(extname(path).toLowerCase())) return 'media';
  const bytes = await readFile(path);
  if (bytes.includes(0)) return 'unsafe';
  const text = bytes.toString('utf8');
  const options = { secrets, structured: isStructuredDiagnostic(path) };
  const scrubbed = redactMatrixIdentifiers(text, options);
  if (scrubbed !== text) await writeFile(path, scrubbed, 'utf8');
  if (hasMatrixIdentifier(await readFile(path, 'utf8'), options))
    return 'unsafe';
  return scrubbed === text ? 'clean' : 'redacted';
}

/**
 * Redact every text diagnostic below `directory` in place, then rescan it.
 * Passwords found in any file are redacted in all of them.
 */
export async function scrubMatrixIdentifierArtifacts(
  directory: string,
): Promise<MatrixIdentifierScanResult> {
  const redacted: string[] = [];
  const unsafe: string[] = [];
  const paths: string[] = [];
  for await (const path of regularFiles(directory)) paths.push(path);
  const secrets = await harvestAccountPasswords(paths);
  for (const path of paths) {
    const state = await scrubMatrixIdentifierFile(path, secrets);
    if (state === 'redacted') redacted.push(relative(directory, path));
    else if (state === 'unsafe') unsafe.push(relative(directory, path));
  }
  return { redacted, unsafe };
}

/**
 * Fail closed: scrub, remove each file that is still unsafe together with
 * every `publication-safe` marker, and report what was withheld. Paths are
 * redacted too, so the report itself can be printed.
 */
export async function enforceMatrixIdentifierFreeArtifacts(
  directory: string,
): Promise<MatrixIdentifierScanResult> {
  const result = await scrubMatrixIdentifierArtifacts(directory);
  if (result.unsafe.length === 0) return result;
  for (const name of result.unsafe)
    await rm(join(directory, name), { force: true });
  for await (const path of regularFiles(directory))
    if (basename(path) === 'publication-safe') await rm(path, { force: true });
  return {
    redacted: result.redacted.map((name) => redactMatrixIdentifiers(name)),
    unsafe: result.unsafe.map((name) => redactMatrixIdentifiers(name)),
  };
}
