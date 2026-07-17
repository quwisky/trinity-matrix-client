import { APP_ORIGIN } from './scheme';

/**
 * Main-process CORS shim for Matrix homeserver traffic.
 *
 * The renderer is served from the privileged custom scheme `trinity://app`
 * (see scheme.ts), so every request matrix-js-sdk makes to a homeserver at
 * `https://<host>` is cross-origin. Many homeservers / reverse-proxies don't
 * reliably emit `Access-Control-Allow-Origin`, so Chromium blocks those
 * responses (`No 'Access-Control-Allow-Origin' header` -> net::ERR_FAILED),
 * intermittently breaking `/sync`, relations, account-data, cross-signing, etc.
 *
 * Because the desktop renderer is TRUSTED first-party native code (not an
 * arbitrary web page), we inject permissive CORS response headers on the app
 * session's OUTBOUND REMOTE http(s) responses only — the Element-Desktop
 * approach. This does NOT weaken the renderer's security posture: `webSecurity`,
 * `contextIsolation`, `sandbox`, and `nodeIntegration: false` are all untouched,
 * and the shim is scoped to remote http(s) URLs so it never touches the
 * `trinity://app` scheme itself.
 *
 * KNOWN LIMITATION — this is scoped to *remote* origins, NOT to the homeserver.
 * The renderer can therefore read cross-origin response bodies from any https origin.
 * That is not reachable by web content (nothing but our own code runs on this origin),
 * so it is not directly exploitable — but it is an XSS amplifier: the app renders
 * untrusted federated message HTML, so any future sanitizer bypass would gain a
 * read-anywhere primitive. `connect-src 'self' https: wss:` in the CSP already blocks
 * the `http://` half (no intranet/localhost reads).
 *
 * Narrowing it to a homeserver allowlist is NOT a simple edit, which is why it hasn't
 * been done here: the main process doesn't know the homeserver (the renderer picks it at
 * login), multi-account means several at once, each may use a separate media/identity
 * host, and `.well-known` discovery deliberately probes an arbitrary origin the user has
 * typed *before* any login exists to allowlist. A naive allowlist would break sign-in.
 * Doing it properly needs the renderer to publish its live origin set over IPC —
 * tracked as follow-up, deliberately not attempted as a drive-by.
 */

// Only remote http(s) responses are rewritten — never the `trinity://app`
// scheme (which this pattern deliberately does not match).
const REMOTE_URLS = ['https://*/*', 'http://*/*'] as const;

// Response headers Electron hands us are keyed however the origin server cased
// them, so all matching/removal below is case-insensitive (lowercased).
const ACAO = 'access-control-allow-origin';
const ACAM = 'access-control-allow-methods';
const ACAH = 'access-control-allow-headers';
const ACMA = 'access-control-max-age';
const ACAC = 'access-control-allow-credentials';

// The CORS keys we own: any of these the server already sent are stripped
// before we set ours, so a duplicate Access-Control-Allow-Origin can never be
// emitted (Chromium rejects a response that carries two ACAO values).
// ACAC is managed (and never re-set) so a third-party origin cannot opt ITSELF into
// credentialed cross-origin reads by returning `access-control-allow-credentials: true`
// alongside the ACAO we inject. matrix-js-sdk authenticates with a bearer header, not
// cookies, so nothing here needs credentialed CORS.
const MANAGED = [ACAO, ACAM, ACAH, ACMA, ACAC];

/**
 * Origins the renderer has declared it legitimately talks to — the signed-in
 * homeservers, plus any origin currently being probed by `.well-known` discovery.
 * Populated over IPC ({@link setAllowedCorsOrigins}); empty until the renderer says
 * otherwise, which is the safe direction (see below).
 *
 * Anything NOT in here is passed through untouched rather than rewritten. That is a
 * safe default, not a lax one: the Matrix spec REQUIRES CS API and `.well-known`
 * responses to carry `Access-Control-Allow-Origin: *`, so a compliant server needs no
 * help from us. This shim exists only for deployments whose reverse proxy strips it —
 * and for those, the renderer names the origin.
 */
const allowedOrigins = new Set<string>();

/**
 * Replace the set of origins the shim will rewrite for. Called by the renderer (over
 * IPC) whenever its live origin set changes: sign-in, sign-out, account switch, and
 * around a `.well-known` probe of a server it has not yet joined.
 *
 * Invalid entries are dropped rather than throwing — this is a trust boundary, and a
 * malformed payload must not take the shim (or the main process) down.
 */
export function setAllowedCorsOrigins(origins: readonly string[]): void {
  allowedOrigins.clear();
  for (const raw of origins) {
    if (typeof raw !== 'string') {
      continue;
    }
    try {
      // Normalise via URL so 'https://hs.example/' and 'https://hs.example:443/foo'
      // both reduce to the same origin the interceptor will compare against.
      allowedOrigins.add(new URL(raw).origin);
    } catch {
      // Not a URL — ignore it.
    }
  }
}

/**
 * Additively allow one origin, without disturbing the rest.
 *
 * Discovery and login both talk to a homeserver BEFORE any account exists to declare
 * it: `.well-known` probes the domain the user typed, then login POSTs to the resolved
 * base URL. Those origins are allowed as they come into play, and the next
 * {@link setAllowedCorsOrigins} (fired whenever the account set changes) replaces the
 * whole set — so a probe of a server never signed into is dropped rather than lingering.
 */
export function allowCorsOrigin(origin: string): void {
  try {
    allowedOrigins.add(new URL(origin).origin);
  } catch {
    // Not a URL — ignore it.
  }
}

/** The current allowlist (test seam / diagnostics). */
export function allowedCorsOrigins(): readonly string[] {
  return [...allowedOrigins];
}

/** Delete every entry whose (lowercased) key is in `names`, mutating `headers`. */
function deleteHeaders(
  headers: Record<string, string[]>,
  names: readonly string[],
): void {
  for (const key of Object.keys(headers)) {
    if (names.includes(key.toLowerCase())) {
      delete headers[key];
    }
  }
}

/** Whether `url`'s origin is one the renderer declared. Unparseable URLs are not. */
function isAllowed(url: string): boolean {
  try {
    return allowedOrigins.has(new URL(url).origin);
  } catch {
    return false;
  }
}

/**
 * Register an `onHeadersReceived` interceptor that makes any Matrix homeserver
 * respond CORS-clean to the `trinity://app` renderer. Call ONCE, on the session
 * the main window uses, BEFORE the window loads its URL.
 */
export function installMatrixCors(session: Electron.Session): void {
  session.webRequest.onHeadersReceived(
    { urls: [...REMOTE_URLS] },
    (details, callback) => {
      // Only rewrite for origins the renderer has declared. Everything else passes
      // through with the server's own headers intact — so a sanitizer bypass in the
      // renderer cannot borrow this shim as a read-anywhere primitive against
      // arbitrary https origins.
      if (!isAllowed(details.url)) {
        callback({});
        return;
      }
      const responseHeaders: Record<string, string[]> = {
        ...(details.responseHeaders ?? {}),
      };

      // Strip whatever CORS headers the origin sent, then set exactly one of
      // each of ours — never a duplicate.
      deleteHeaders(responseHeaders, MANAGED);

      // Exact origin (never `*`) so credentialed requests are permitted.
      responseHeaders[ACAO] = [APP_ORIGIN];

      // Preflight: answer the OPTIONS probe with the verbs + request headers
      // matrix-js-sdk uses. `Authorization` MUST be listed explicitly — the
      // `*` wildcard never covers it. onHeadersReceived details carry no
      // request headers, so there's nothing to echo; this allow-list suffices
      // (matrix-js-sdk only sends Authorization + Content-Type).
      if (details.method === 'OPTIONS') {
        responseHeaders[ACAM] = ['GET, POST, PUT, DELETE, PATCH, OPTIONS'];
        responseHeaders[ACAH] = ['Authorization, Content-Type'];
        responseHeaders[ACMA] = ['86400'];
      }

      callback({ responseHeaders });
    },
  );
}
