/**
 * Validation + normalisation for a user-entered push gateway URL.
 *
 * Pure and DI-free so the settings form can check keystrokes without touching the
 * push stack. The rules below are not invented — they were probed against Synapse by
 * POSTing pushers and recording what it accepts:
 *
 * | input                                    | Synapse            |
 * | ---------------------------------------- | ------------------ |
 * | `https://host/_matrix/push/v1/notify`    | accepted           |
 * | bare origin, wrong path, sub-path prefix | 400 `M_MISSING_PARAM` |
 * | the same path with a trailing slash      | 400 `M_MISSING_PARAM` |
 * | `http://…`, embedded credentials, loopback, query string | accepted |
 *
 * So the path is an exact match — a gateway cannot be mounted under a sub-path — and
 * everything else the homeserver waves through. We therefore normalise the two shapes
 * a person actually types (a bare origin, and a stray trailing slash) rather than
 * bouncing them, reject what the homeserver would reject anyway with an opaque error,
 * and merely *warn* about `http:` instead of blocking it, since Synapse permits it and
 * a LAN gateway is exactly this feature's audience.
 *
 * None of this is a security control. The client never fetches this URL — the
 * homeserver does — and any user can POST to `/pushers/set` directly, so these checks
 * exist to catch typos, not to constrain a determined operator. See docs/reference/push-notifications.md.
 */

/** The one path Synapse accepts on a pusher URL (exact match, no trailing slash). */
export const GATEWAY_NOTIFY_PATH = '/_matrix/push/v1/notify';

/**
 * Upper bound on the raw input. Well past any real gateway URL; guards the settings
 * blob and the pusher payload against a paste of something that is not a URL at all.
 */
const MAX_LENGTH = 2048;

/** Why a candidate URL was rejected. Codes, not prose — the UI owns the wording. */
export type GatewayUrlProblem =
  | 'empty'
  | 'too-long'
  | 'malformed'
  | 'unsupported-scheme'
  | 'embedded-credentials'
  | 'wrong-path';

/**
 * Outcome of {@link normalizeGatewayUrl}. On success `url` is the canonical form to
 * store and send — which may differ from what was typed — and `insecure` flags an
 * `http:` gateway so the form can warn without blocking.
 */
export type GatewayUrlCheck =
  | { readonly ok: true; readonly url: string; readonly insecure: boolean }
  | { readonly ok: false; readonly problem: GatewayUrlProblem };

/**
 * Normalise a user-entered gateway URL, or explain why it cannot be used.
 *
 * Accepts a bare origin (`https://push.example`) and appends the notify path, trims a
 * trailing slash off an otherwise-correct path, and drops any fragment — a `#hash` is
 * meaningless to a server-to-server POST and would be sent verbatim. A query string is
 * preserved: Synapse accepts one and multi-tenant gateways use it.
 */
export function normalizeGatewayUrl(raw: string): GatewayUrlCheck {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, problem: 'empty' };
  }
  if (trimmed.length > MAX_LENGTH) {
    return { ok: false, problem: 'too-long' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Relative input ("push.example/…") lands here too: a pusher URL must be absolute,
    // and guessing a scheme would silently pick the user's trust level for them.
    return { ok: false, problem: 'malformed' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, problem: 'unsupported-scheme' };
  }
  if (!parsed.hostname) {
    return { ok: false, problem: 'malformed' };
  }
  if (parsed.username || parsed.password) {
    // Synapse accepts these, but they would be persisted in plain text on the device
    // and handed to the homeserver, which stores and re-serves them via GET /pushers.
    return { ok: false, problem: 'embedded-credentials' };
  }

  // `new URL()` normalises a missing path to '/', so both spellings of a bare origin
  // arrive here identically.
  const path =
    parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  if (path && path !== GATEWAY_NOTIFY_PATH) {
    return { ok: false, problem: 'wrong-path' };
  }
  parsed.pathname = GATEWAY_NOTIFY_PATH;
  parsed.hash = '';

  return {
    ok: true,
    url: parsed.toString(),
    insecure: parsed.protocol === 'http:',
  };
}
