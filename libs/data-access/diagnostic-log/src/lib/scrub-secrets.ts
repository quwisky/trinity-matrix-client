/** What every masked value becomes. */
export const REDACTED = '<redacted>';

/** The longest text scrubbed in one piece; anything beyond is dropped before scrubbing. */
export const MAX_SCRUB_INPUT = 64 * 1024;

const CUT_NOTE = ' [rest dropped before scrubbing]';

/** Characters a token never contains: a cut backs off to the last of these. */
const SEPARATOR = /[\s"',;{}[\]()<>]/;

/**
 * JSON fields whose value is a credential, key material, a push or TURN secret, or message
 * content. The value is masked whether it is a string (even one cut off at the end), an object
 * nested one level deep (the UIA `auth` dict), or an array.
 */
const SECRET_FIELDS = [
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

const JSON_VALUE = String.raw`(?:"(?:[^"\\]|\\.)*(?:"|$)|\{(?:[^{}]|\{[^{}]*\})*\}|\[(?:[^[\]]|\[[^[\]]*\])*\])`;

/** Query and form parameters that carry a credential; always masked. */
const SECRET_PARAMS = [
  'access_token',
  'refresh_token',
  'login_token',
  'loginToken',
  'id_token',
  'token',
  'code',
  'code_verifier',
  'state',
  'sso_state',
  'client_secret',
  'registration_token',
  'password',
  'passphrase',
  'pushkey',
];

/**
 * Patterns for values that must never be stored, applied in order. Matrix identifiers are
 * deliberately left alone: the on-device log keeps them, and the export redactor replaces
 * them (spec §2). Each rule is covered by `scrub-secrets.spec.ts`.
 */
const SECRET_RULES: readonly (readonly [RegExp, string])[] = [
  // Bearer credentials, then whatever an Authorization header or field still carries, under
  // any scheme (Bearer, Basic, …), then cookies.
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  [
    /("?\bauthorization"?\s*[:=]\s*"?)(?:[A-Za-z][\w-]*\s+)?[^",}\s]+/gi,
    `$1${REDACTED}`,
  ],
  [/("?\b(?:set-)?cookie"?\s*[:=]\s*"?)[^"\r\n}]+/gi, `$1${REDACTED}`],
  // Credential query, fragment and form parameters. matrix-js-sdk masks its own request URLs
  // (`sanitizeUrlForLogs`); URLs in errors, callbacks, widgets and form bodies are not masked.
  [
    new RegExp(
      String.raw`((?:^|[\s?&#;])(?:${SECRET_PARAMS.join('|')})=)[^&#\s"']*`,
      'gi',
    ),
    `$1${REDACTED}`,
  ],
  // OAuth `code` and `state` in JSON: kept only when clearly a diagnostic code (`M_FORBIDDEN`,
  // `active-account-unavailable`) or a sync state (`SYNCING`); anything opaque is masked.
  [
    /("(?:code|state|sso_state)"\s*:\s*)"(?!(?:M_[A-Z_]+|[A-Z][A-Z_]{2,}|[a-z][a-z0-9]*(?:-[a-z0-9]+)+)")(?:[^"\\]|\\.)*(?:"|$)/g,
    `$1"${REDACTED}"`,
  ],
  // JSON fields that hold credentials, key material or message content.
  [
    new RegExp(
      String.raw`("(?:${SECRET_FIELDS.join('|')})"\s*:\s*)${JSON_VALUE}`,
      'g',
    ),
    `$1"${REDACTED}"`,
  ],
  // Synapse (syt_/syr_) and MAS (mat_/mar_/mct_) tokens, and JWTs.
  [/\b(?:syt|syr|mat|mar|mct)_[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // Recovery keys: base58 starting "Es", twelve groups of four, spaces optional.
  [
    /\bEs[1-9A-HJ-NP-Za-km-z]{2}(?:\s?[1-9A-HJ-NP-Za-km-z]{4}){11}\b/g,
    REDACTED,
  ],
  // Precise locations (m.location geo: URIs).
  [/\bgeo:[-+]?\d[^\s"']*/gi, `geo:${REDACTED}`],
  // APNs device tokens and other long hex secrets.
  [/\b[0-9A-Fa-f]{64,}\b/g, REDACTED],
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
  for (const [pattern, replacement] of SECRET_RULES) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  return scrubbed;
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

/** The text up to `limit`, backed off to the last separator so no token is cut in half. */
function cutAtSeparator(text: string, limit: number): string {
  let end = limit;
  while (end > 0 && !SEPARATOR.test(text[end - 1])) {
    end -= 1;
  }
  return text.slice(0, end);
}
