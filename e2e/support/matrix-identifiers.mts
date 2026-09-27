import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';

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

/**
 * Redact every Matrix event-id and Room-id shape, raw, percent-encoded or as
 * a base64url Room route segment. Colour sequences are kept unless they hide
 * an identifier, in which case the text is uncoloured and then redacted.
 */
export function redactMatrixIdentifiers(text: string): string {
  const redacted = redactShapes(text);
  const plain = redacted.replace(ANSI_SEQUENCE, '');
  return plain !== redacted && hasShape(plain) ? redactShapes(plain) : redacted;
}

/** Whether text still carries any Matrix event-id or Room-id shape, even between colour sequences. */
export function hasMatrixIdentifier(text: string): boolean {
  return hasShape(text) || hasShape(text.replace(ANSI_SEQUENCE, ''));
}

/**
 * Redact a text stream by whole lines, so an identifier split across two
 * chunks is still recognised. A line longer than `maxPending` is released
 * except for a tail that can still hold the start of an identifier.
 */
export class MatrixIdentifierLineRedactor {
  private pending = '';

  private readonly maxPending: number;

  constructor(maxPending = 64 * 1024) {
    this.maxPending = maxPending;
  }

  write(chunk: string): string {
    const text = this.pending + chunk;
    const end = text.lastIndexOf('\n');
    if (end >= 0) {
      this.pending = text.slice(end + 1);
      return redactMatrixIdentifiers(text.slice(0, end + 1)) + this.overflow();
    }
    this.pending = text;
    return this.overflow();
  }

  flush(): string {
    const rest = this.pending;
    this.pending = '';
    return redactMatrixIdentifiers(rest);
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
    return redactMatrixIdentifiers(released);
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
 * Redact one diagnostic in place and rescan it. Media files are skipped; any
 * other file with a NUL byte is binary and cannot be verified, so it is unsafe
 * like a file that still carries an identifier after the scrub.
 */
export async function scrubMatrixIdentifierFile(
  path: string,
): Promise<MatrixIdentifierFileState> {
  if (MEDIA_EXTENSIONS.has(extname(path).toLowerCase())) return 'media';
  const bytes = await readFile(path);
  if (bytes.includes(0)) return 'unsafe';
  const text = bytes.toString('utf8');
  const scrubbed = redactMatrixIdentifiers(text);
  if (scrubbed !== text) await writeFile(path, scrubbed, 'utf8');
  if (hasMatrixIdentifier(await readFile(path, 'utf8'))) return 'unsafe';
  return scrubbed === text ? 'clean' : 'redacted';
}

/** Redact every text diagnostic below `directory` in place, then rescan it. */
export async function scrubMatrixIdentifierArtifacts(
  directory: string,
): Promise<MatrixIdentifierScanResult> {
  const redacted: string[] = [];
  const unsafe: string[] = [];
  for await (const path of regularFiles(directory)) {
    const state = await scrubMatrixIdentifierFile(path);
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
    redacted: result.redacted.map(redactMatrixIdentifiers),
    unsafe: result.unsafe.map(redactMatrixIdentifiers),
  };
}
