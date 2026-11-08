/** What every masked value becomes. */
export const REDACTED = '<redacted>';

/** The longest text scrubbed in one piece; anything beyond is dropped before scrubbing. */
export const MAX_SCRUB_INPUT = 64 * 1024;

const CUT_NOTE = ' [rest dropped before scrubbing]';

/** Characters a token never contains: the input cut backs off to the last of these. */
const TOKEN_SEPARATOR = /[\s"',;{}[\]()<>]/;

/**
 * Characters no Matrix ID contains either, for cuts of scrubbed text: historical user IDs
 * and aliases may hold "'", ";" and brackets.
 */
export const ID_SEPARATOR = /[\s",<>]/;

/**
 * How far a cut backs off looking for a separator. Longer than any Matrix ID (255 bytes);
 * with no separator that close, the cut falls at the limit rather than dropping everything.
 */
const CUT_WINDOW = 256;

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

/**
 * A parameter name and its "="; the name may start after any non-alphanumeric character.
 * Spaces around the "=" are allowed, and then "==" is a comparison.
 */
const PARAM =
  /(?<![A-Za-z0-9])([A-Za-z_][\w.-]{0,63})(=(?![ \t])|[ \t]{0,8}=(?!=)[ \t]{0,8})/g;

/** Where a bare parameter value ends; a spaced one (`if (token = x)`) also ends at ")". */
const PARAM_VALUE_END = /[&#\s"']/;
const SPACED_PARAM_VALUE_END = /[&#\s"')]/;
const ESCAPED_QUOTE = /^\\+["']/;
/** An escaped apostrophe inside a word (`hunt\\'er2`), part of a bare value. */
const ESCAPED_APOSTROPHE = /^\\+'[\p{L}\p{N}]/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** The most passes {@link scrubSecrets} makes before it masks a text whole. */
const MAX_PASSES = 4;

/**
 * Whether the quote at `at`, after `run` backslashes, is an apostrophe inside a word
 * (`it's`, `hunt\\'er2`). With `masks`, the edge of a masked value counts as a letter, as
 * the value it replaced did, so quotes count the same on a second pass.
 */
function isApostrophe(
  text: string,
  at: number,
  run: number,
  masks = false,
): boolean {
  const isWord = (index: number): boolean =>
    WORD_CHAR.test(text[index] ?? '') ||
    (masks &&
      ((text[index] === '>' && text.endsWith(REDACTED, index + 1)) ||
        (text[index] === '<' && text.startsWith(REDACTED, index))));
  return text[at] === "'" && isWord(at - run - 1) && isWord(at + 1);
}

/** The most backslashes before a quote that opens a parameter value, as in `readValue`. */
const MAX_ESCAPE = 8;

/**
 * A name whose spaced assignment (`password = x`) holds a secret: one with a secret word in
 * it. Short names such as `state`, `code`, `key` or `body` are ordinary words in prose and
 * code (`state = SYNCING`), so they count only when written as a parameter, without spaces.
 */
function isSpacedSecretName(name: string): boolean {
  const normalized = normalizeName(name);
  return (
    !PUBLIC_NAMES.has(normalized) &&
    SECRET_WORDS.some((word) => normalized.includes(word))
  );
}

/** `code` and `state` values that are diagnostics, not OAuth secrets. */
const KEPT_OAUTH_VALUE =
  /^(?:M_[A-Z][A-Z_]*|PREPARED|SYNCING|CATCHUP|RECONNECTING|ERROR|STOPPED|[a-z]{2,}(?:-[a-z]{2,})+)$/;

/**
 * Patterns for values that must never be stored, applied in order. Matrix identifiers are
 * deliberately left alone: the on-device log keeps them, and the export redactor replaces
 * them.
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

const BASE58 = '[1-9A-HJ-NP-Za-km-z]';

/**
 * A recovery key: base58 starting "Es", twelve groups of four, each `gap` optional between
 * them. The only secret shape that crosses spaces.
 */
function recoveryKey(gap: string): string {
  return `Es${BASE58}{2}(?:${gap}?${BASE58}{4}){11}`;
}

const RECOVERY_KEY = new RegExp(recoveryKey(String.raw`\s`), 'g');
const RECOVERY_KEY_AT = new RegExp(recoveryKey(String.raw`\s`), 'y');

/**
 * What stands for a space inside a recovery key while the rules run (see `scrubOnce`); never
 * in the output. The first Unicode noncharacter (U+FDD0 to U+FDEF, kept for internal use)
 * that the text lacks, so none of its own characters is taken for one; null if it has them
 * all, and then the text is masked whole.
 */
function keyMarker(text: string): string | null {
  for (let code = 0xfdd0; code <= 0xfdef; code += 1) {
    const marker = String.fromCharCode(code);
    if (!text.includes(marker)) {
      return marker;
    }
  }
  return null;
}

interface MarkedKeyRules {
  /** A recovery key standing as a whole token, its spaces marked or not. */
  readonly whole: RegExp;
  /** A marked key, or what is left of one: its groups and masks, joined by marked spaces. */
  readonly marked: RegExp;
}

const markedKeyRules = new Map<string, MarkedKeyRules>();

function keyRules(marker: string): MarkedKeyRules {
  let rules = markedKeyRules.get(marker);
  if (!rules) {
    rules = {
      whole: new RegExp(String.raw`\b${recoveryKey(`[\\s${marker}]`)}\b`, 'g'),
      marked: new RegExp(
        `(?:${REDACTED}|${BASE58}+)?(?:${marker}(?:${REDACTED}|${BASE58}+)?)+`,
        'g',
      ),
    };
    markedKeyRules.set(marker, rules);
  }
  return rules;
}

/** Patterns for token-shaped values, applied after the header and name-based rules. */
const SECRET_RULES: readonly (readonly [RegExp, string])[] = [
  // Synapse (syt_/syr_) and MAS (mat_/mar_/mct_) tokens, and JWTs.
  [/\b(?:syt|syr|mat|mar|mct)_[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // FCM registration tokens, prefix included.
  [/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{8,64}:APA91[A-Za-z0-9_-]{16,}/g, REDACTED],
  // Precise locations (m.location geo: URIs).
  [/\bgeo:[-+]?\d[^\s"']*/gi, `geo:${REDACTED}`],
  // APNs device tokens and other long hex secrets (not after "@", "!" or "$": Matrix IDs).
  [/(?<![@!$])\b[0-9A-Fa-f]{32,}\b/g, REDACTED],
];

/**
 * Long runs mixing digits, lower and upper case: keys, session IDs, opaque tokens, FCM tokens.
 * A run straight after a %-escape is masked too (see {@link maskRunsAfterEscapes}), unless the
 * escape is %21 ("!") or %24 ("$"), which start an encoded room or event ID…
 */
const KEY_AFTER_ESCAPE =
  /(%(?!2[14])[0-9A-Fa-f]{2})(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])[A-Za-z0-9+/_-]{32,}={0,2}/g;
/** …and a run after "$" or "!" is an event or room ID, left for the export redactor. */
const KEY_RUN =
  /(?<![$!%A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])[A-Za-z0-9+/_-]{32,}={0,2}/g;
/** The same run as a whole text, after the separators that may lead it. */
const WHOLE_KEY_RUN =
  /^([+/_-]*)(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])[A-Za-z0-9+/_-]{32,}={0,2}$/;
/**
 * An event or room version 12 ID escaped once or twice: "$" as %24 (%2524) and 43 or 44
 * base64 characters whose "+" and "/" may be escaped as well, or "!" as %21 (%2521) and 43
 * URL-safe ones. Its escapes must not start a key run, or part of the ID would be masked and
 * part kept. Neither is padded, so a run that goes on with "=" is a key. Bounded, so each "%"
 * costs a fixed amount.
 */
const ENCODED_HASH_ID =
  /%(?:25)?(?:24(?:[A-Za-z0-9_+-]|%(?:25)?2[BF]){43,44}|21[A-Za-z0-9_-]{43})(?![A-Za-z0-9_+=-]|%(?:25)?(?:2[BF]|3D))/gi;

/**
 * Mask every secret-shaped value in one log message. Runs at capture, through
 * {@link scrubMessage}, and again at export as a second line of defence.
 */
export function scrubSecrets(text: string): string {
  // A pass can uncover more: a field or parameter name glued to a token (`…abcdef"passwd":`)
  // reads as one once the token is masked. Passes repeat until one changes nothing, so
  // scrubbed text scrubs to itself; a line without secrets takes one pass. A text still
  // changing after a few (a chain read one link further each pass) is masked whole, which is
  // final, so the work stays a few passes long however long the chain.
  let scrubbed = text;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const next = scrubOnce(scrubbed);
    if (next === scrubbed) {
      return next;
    }
    scrubbed = next;
  }
  return REDACTED;
}

/** One pass of every rule; see {@link scrubSecrets}. */
function scrubOnce(text: string): string {
  let scrubbed = text;
  for (const [pattern, replacement] of HEADER_RULES) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  // The spaces inside a recovery key are marked, so every rule reads the key's groups as the
  // tokens they are while a parameter value runs through all of them; the marked key and
  // whatever rule took a part of it are masked whole at the end.
  const marker = keyMarker(text);
  if (marker === null) {
    // The text holds every marker: its keys cannot be marked, so none of it is kept.
    return REDACTED;
  }
  const rules = keyRules(marker);
  scrubbed = markKeys(scrubbed, marker);
  // Credential query, fragment and form parameters. matrix-js-sdk masks its own request URLs
  // (`sanitizeUrlForLogs`); URLs in errors, callbacks, widgets and form bodies are not masked.
  // Before the token rules, so each value is read whole, as written.
  scrubbed = applyEdits(scrubbed, paramEdits(scrubbed));
  for (const [pattern, replacement] of SECRET_RULES) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  // A recovery key standing as a whole token. One glued into a longer token is that token's
  // middle: the long-run rule masks the whole token, and `/path/to/KEY/file` keeps its path.
  scrubbed = scrubbed.replace(rules.whole, REDACTED);
  scrubbed = maskRunsAfterEscapes(scrubbed).replace(KEY_RUN, REDACTED);
  // A key the long-run rule could not take (no digit or no capital) is masked alone.
  scrubbed = scrubbed.replace(RECOVERY_KEY, REDACTED);
  // Last, so a field name glued to a token (`…abcdef"passwd":`) reads as one once it is masked.
  scrubbed = maskFields(scrubbed, isSecretName, false);
  scrubbed = maskFields(scrubbed, isOAuthName, true);
  return scrubbed.replace(rules.marked, REDACTED);
}

/**
 * `text` with the spaces of every recovery key marked. Every place a key starts is read, so
 * a key-shaped run that overlaps a real key (`Es12\nEs12 3456 …`) cannot leave part of it
 * unmarked; each check reads at most one key's length.
 */
function markKeys(text: string, marker: string): string {
  let out = '';
  let marked = 0;
  for (
    let at = text.indexOf('Es');
    at !== -1;
    at = text.indexOf('Es', at + 1)
  ) {
    RECOVERY_KEY_AT.lastIndex = at;
    const key = RECOVERY_KEY_AT.exec(text);
    const end = key === null ? -1 : at + key[0].length;
    if (end > marked) {
      const from = Math.max(at, marked);
      out +=
        text.slice(marked, from) + text.slice(from, end).replace(/\s/g, marker);
      marked = end;
    }
  }
  return out + text.slice(marked);
}

/** A masked span of the text: `masked` replaces `text.slice(start, end)`. */
interface Edit {
  readonly start: number;
  readonly end: number;
  readonly masked: string;
}

/** `text` with every edit applied; one that overlaps an earlier one widens it. */
function applyEdits(text: string, edits: Edit[]): string {
  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = '';
  let position = 0;
  for (const edit of edits) {
    if (edit.start < position) {
      position = Math.max(position, edit.end);
      continue;
    }
    out += text.slice(position, edit.start) + edit.masked;
    position = edit.end;
  }
  return out + text.slice(position);
}

/**
 * Masks the value of every secret parameter: a quoted one, its quotes escaped or not, through
 * its closing quote (a cut-off one to the end), a bare one up to a separator. The value of
 * any other parameter is read on, so `url="https://…?access_token=…"` is masked too.
 */
function paramEdits(text: string): Edit[] {
  const pattern = new RegExp(PARAM);
  const isOpen = openStrings(text);
  const edits: Edit[] = [];
  for (
    let match = pattern.exec(text);
    match !== null;
    match = pattern.exec(text)
  ) {
    const spaced = match[2] !== '=';
    if (!isSecretParam(match[1]) || (spaced && !isSpacedSecretName(match[1]))) {
      continue;
    }
    const start = match.index + match[0].length;
    let value = paramValue(text, start, spaced, isOpen);
    // `token= passwd:= …`, `token='key:'…`: a secret field named in the value, whose own
    // value runs on past it, is masked with it.
    const fieldEnd = secretFieldEnd(text, start, value.end, start, !value.bare);
    if (fieldEnd !== -1) {
      value = bareValue(text, start, fieldEnd);
    }
    // An empty value has nothing to mask, and one masked already (by an earlier rule or
    // pass) stays as it is.
    if (
      value.end === start ||
      value.content === REDACTED ||
      (value.bare && isReadableFlag(match[1], value.content ?? ''))
    ) {
      continue;
    }
    edits.push({ start, end: value.end, masked: value.masked });
    pattern.lastIndex = value.end;
  }
  return edits;
}

/** Where the line holding `at` ends. */
function lineEnd(text: string, at: number): number {
  const ends = [text.indexOf('\n', at), text.indexOf('\r', at), text.length];
  return Math.min(...ends.filter((end) => end !== -1));
}

/** How far past a value a field name starting inside it may run. */
const NAME_MARGIN = 80;
/**
 * A field name inside a value: as {@link FIELD_NAME}, or quoted and glued to the text before
 * it (`…Wx"passwd":`), since its quotes set it apart.
 */
const INNER_FIELD_NAME = String.raw`(?:(?<![\w$-])(\\{0,8}["']?)([A-Za-z_][\w.-]{0,63})\1|(\\{0,8}["'])([A-Za-z_][\w.-]{0,63})\3)\s*:\s*`;

/**
 * Where a value from `start` to `end` must end so that every secret field named in it is
 * masked with its own value, which may run on past `end` (`token= passwd:= x`,
 * `token='key:'x`), and so on along a chain of them; -1 when `end` already does. A bare
 * value read from inside another ends where it does, so `bareEnd` (the end of the value
 * being read, when bare) saves reading it again and keeps the scan linear. Inside a quoted
 * value (`inString`), "," "}" and "]" are the string's text, so a bare field value named in
 * it runs to the end of the line.
 */
function secretFieldEnd(
  text: string,
  start: number,
  end: number,
  bareEnd: number,
  inString: boolean,
): number {
  let reach = end;
  let bareTo = bareEnd;
  // An object or array read from inside another ends inside it, and so does a bare value:
  // neither is read again, so a run of nested values costs one read.
  let objectTo = start;
  // Each search runs over the value and a margin for a name that runs past it, so a value
  // with no field in it costs its own length, not the rest of the text's.
  for (let from = start; from < reach;) {
    const window = text.slice(from, reach + NAME_MARGIN);
    const pattern = new RegExp(INNER_FIELD_NAME, 'g');
    let grownFrom = -1;
    for (
      let match = pattern.exec(window);
      match !== null && from + match.index < reach;
      match = pattern.exec(window)
    ) {
      const name = match[2] ?? match[4] ?? '';
      const valueStart = from + match.index + match[0].length;
      const lead = /^\\*(["'{[])/.exec(
        text.slice(valueStart, valueStart + 10),
      )?.[1];
      const quoted = lead !== undefined;
      const nested = lead === '{' || lead === '[';
      if (
        !(isSecretName(name) || isOAuthName(name)) ||
        (!quoted && valueStart < Math.max(bareTo, objectTo)) ||
        (nested && valueStart < objectTo)
      ) {
        continue;
      }
      const value =
        inString && !quoted && valueStart < end
          ? bareValue(text, valueStart, lineEnd(text, valueStart))
          : readValue(text, valueStart, false);
      if (value === null) {
        continue;
      }
      if (value.bare) {
        bareTo = value.end;
      } else if (nested) {
        objectTo = Math.max(objectTo, value.end);
      }
      if (value.end > reach) {
        reach = value.end;
        grownFrom = valueStart;
        break;
      }
    }
    if (grownFrom === -1) {
      break;
    }
    from = grownFrom;
  }
  return reach > end ? reach : -1;
}

/**
 * The parameter value at `start`. A quoted one is masked inside its quotes, as fields are, so
 * the text after it still reads as text after a value when the export scrubs it again.
 */
function paramValue(
  text: string,
  start: number,
  spaced: boolean,
  isOpen: (at: number, quote: string, slashes: number) => boolean,
): FieldValue {
  let run = 0;
  while (text[start + run] === '\\' && run < MAX_ESCAPE) {
    run += 1;
  }
  const quote = text[start + run];
  if (quote === '"' || quote === "'") {
    // `\\"` is a backslash, then a bare quote: the backslashes the quote's level leaves
    // over are part of the value.
    const level = quoteLevel(run);
    const opener = start + run - level;
    // A quote that closes the string the parameter sits in (`{"u":"?code=","next":…}`)
    // leaves its value empty: read as an opener, it would run over the text after it.
    if (isOpen(start + run, quote, level)) {
      return bareValue(text, start, opener);
    }
    const string = readString(text, opener, `${'\\'.repeat(level)}${quote}`);
    // An escaped string ends with the string around it, closed or not.
    const end =
      level === 0
        ? string.end
        : shallowerQuote(text, start + run + 1, string.end, quote, level);
    return {
      ...string,
      end,
      masked:
        text.slice(start, opener) +
        (end === string.end
          ? string.masked
          : `${'\\'.repeat(level)}${quote}${REDACTED}`),
    };
  }
  const valueEnd = spaced ? SPACED_PARAM_VALUE_END : PARAM_VALUE_END;
  let end = start;
  // The backslashes escaping a quote belong to the quote, which ends the value, unless it
  // is an apostrophe inside a word.
  while (end < text.length && !valueEnd.test(text[end])) {
    if (text[end] === '\\') {
      const escape = text.slice(end, end + MAX_ESCAPE + 2);
      const quoteAt = end + escape.search(/[^\\]/);
      if (
        ESCAPED_APOSTROPHE.test(escape) &&
        isApostrophe(text, quoteAt, quoteAt - end)
      ) {
        end = quoteAt + 1;
        continue;
      }
      if (ESCAPED_QUOTE.test(escape)) {
        break;
      }
    }
    end += 1;
  }
  // A "." or "-" ending the value before a space or the end closes the sentence.
  const closesSentence =
    end > start + 1 &&
    (text[end - 1] === '.' || text[end - 1] === '-') &&
    (end === text.length || /\s/.test(text[end]));
  return bareValue(text, start, closesSentence ? end - 1 : end);
}

function bareValue(text: string, start: number, end: number): FieldValue {
  return {
    end,
    masked: REDACTED,
    content: text.slice(start, end),
    bare: true,
  };
}

/** The level of a quote after `run` backslashes: the lowest one whose escape it can be. */
function quoteLevel(run: number): number {
  let level = 0;
  while (level < MAX_ESCAPE && run % (2 * level + 2) !== level) {
    level += 1;
  }
  return level;
}

/** Where the first `quote` of a level below `level` between `from` and `end` starts, or `end`. */
function shallowerQuote(
  text: string,
  from: number,
  end: number,
  quote: string,
  level: number,
): number {
  let run = 0;
  for (let at = from; at < end; at += 1) {
    if (text[at] === '\\') {
      run += 1;
      continue;
    }
    if (text[at] === quote && quoteLevel(run) < level) {
      return at - run;
    }
    run = 0;
  }
  return end;
}

/**
 * Reads `text` left to right, once, and answers whether a string opened by `quote` behind
 * `slashes` backslashes is open just before `at`: an odd number of such quotes lies before
 * it. A quote belongs to a level when its backslash run unescapes to a bare quote there (see
 * `readString`). An apostrophe inside a word (`it's`, `it\\'s`) is no quote. Ask in order.
 */
function openStrings(
  text: string,
): (at: number, quote: string, slashes: number) => boolean {
  const counts = {
    '"': new Array<number>(MAX_ESCAPE + 1).fill(0),
    "'": new Array<number>(MAX_ESCAPE + 1).fill(0),
  };
  let read = 0;
  let run = 0;
  return (at, quote, slashes) => {
    for (; read < at; read += 1) {
      const char = text[read];
      if (char === '\\') {
        run += 1;
        continue;
      }
      if (
        (char === '"' || char === "'") &&
        !isApostrophe(text, read, run, true)
      ) {
        for (let level = 0; level <= MAX_ESCAPE; level += 1) {
          if (run % (2 * level + 2) === level) {
            counts[char][level] += 1;
          }
        }
      }
      run = 0;
    }
    return counts[quote === '"' ? '"' : "'"][slashes] % 2 === 1;
  };
}

/**
 * Masks each key run that starts at a %-escape, except inside an encoded event or room ID:
 * there only what runs on past the ID's end is masked, when it is a key run by itself.
 */
function maskRunsAfterEscapes(text: string): string {
  const ids = Array.from(
    text.matchAll(ENCODED_HASH_ID),
    (match) => [match.index, match.index + match[0].length] as const,
  );
  let next = 0;
  return text.replace(
    KEY_AFTER_ESCAPE,
    (run: string, escape: string, offset: number) => {
      while (next < ids.length && ids[next][1] <= offset) {
        next += 1;
      }
      const id = ids[next];
      if (id === undefined || id[0] > offset) {
        return `${escape}${REDACTED}`;
      }
      const inside = id[1] - offset;
      return (
        run.slice(0, inside) +
        run.slice(inside).replace(WHOLE_KEY_RUN, `$1${REDACTED}`)
      );
    },
  );
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
        ? `${cutAtSeparator(text, MAX_SCRUB_INPUT, TOKEN_SEPARATOR)}${CUT_NOTE}`
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
 * The text up to `limit`, backed off to the last `separator` within {@link CUT_WINDOW} so no
 * token or ID is cut in half, and without anything that could be a recovery key's leading
 * groups, which the full-key rule would no longer match. With no separator that close the
 * cut falls at the limit: what it splits is a run longer than any ID, and a secret that long
 * is still long enough for the token rules.
 */
export function cutAtSeparator(
  text: string,
  limit: number,
  separator: RegExp,
): string {
  const floor = Math.max(0, limit - CUT_WINDOW);
  let end = limit;
  while (end > floor && !separator.test(text[end - 1])) {
    end -= 1;
  }
  return text.slice(0, end > floor ? end : limit).replace(CUT_RECOVERY_KEY, '');
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
 * `code` and `state`. A secret field named inside a value is masked with it.
 */
function maskFields(
  text: string,
  isTarget: (name: string) => boolean,
  oauth: boolean,
): string {
  return applyEdits(text, fieldEdits(text, isTarget, oauth));
}

function fieldEdits(
  text: string,
  isTarget: (name: string) => boolean,
  oauth: boolean,
): Edit[] {
  const pattern = new RegExp(FIELD_NAME, 'g');
  const edits: Edit[] = [];
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
    // A secret field named inside this value (`x:"token":…`), or glued to its closing quote
    // (`"<redacted>"token":…`), is masked with it, even when the value is masked already.
    const reach =
      value.content === undefined
        ? -1
        : secretFieldEnd(
            text,
            start,
            value.end,
            value.bare ? value.end : start,
            !value.bare,
          );
    if ((alreadyMasked || flag || kept) && reach === -1) {
      continue;
    }
    const end = reach === -1 ? value.end : reach;
    edits.push({ start, end, masked: value.masked });
    pattern.lastIndex = end;
  }
  return edits;
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
    const slashes = opener.length - 1;
    for (
      let at = text.indexOf(opener, from);
      at !== -1;
      at = text.indexOf(opener, at + 1)
    ) {
      let run = slashes;
      while (text[at - run + slashes - 1] === '\\') {
        run += 1;
      }
      // The quote closes this string only when its backslash run, unescaped level by level,
      // leaves it bare: a run of `slashes` modulo 2(slashes + 1). Inside `\"`, `\\\"` is a
      // deeper quote and `\\\\\"` a backslash followed by the close.
      if (
        run % (2 * slashes + 2) === slashes &&
        !isApostrophe(text, at + slashes, run)
      ) {
        close = at;
        break;
      }
    }
  } else {
    for (let i = from; i < text.length; i += text[i] === '\\' ? 2 : 1) {
      if (text[i] === opener && !isApostrophe(text, i, 0)) {
        close = i;
        break;
      }
    }
  }
  const contentEnd = close === -1 ? text.length : close;
  return {
    end: close === -1 ? text.length : close + opener.length,
    // Only the quotes that are there: a closing one added to a cut-off string would change
    // how the quotes after it pair up.
    masked: `${opener}${REDACTED}${close === -1 ? '' : opener}`,
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
