import { APP_ORIGIN } from './scheme';

/**
 * Main-process CORS shim for Matrix homeserver traffic.
 *
 * The renderer is served from the privileged scheme `trinity://app` (see scheme.ts), so
 * every matrix-js-sdk request to a homeserver is cross-origin. Many homeservers and
 * reverse proxies don't reliably emit `Access-Control-Allow-Origin`, so Chromium blocks
 * those responses (net::ERR_FAILED), intermittently breaking `/sync`, relations,
 * account-data, cross-signing and more.
 *
 * The desktop renderer is trusted first-party code, so the shim injects CORS response
 * headers on the app session's outbound remote http(s) responses only (the Element
 * Desktop approach). `webSecurity`, `contextIsolation`, `sandbox` and
 * `nodeIntegration: false` stay untouched, and `trinity://app` itself is never rewritten.
 *
 * SCOPE: the rewrite is narrowed to the origins the renderer declared over IPC
 * ({@link setAllowedCorsOrigins} / {@link allowCorsOrigin}): the signed-in homeservers
 * plus whatever `.well-known` discovery and login are probing. Main cannot know those
 * itself (the renderer picks the homeserver at login, multi-account means several, each
 * may use a separate media/identity host, and discovery probes an origin typed before any
 * account exists), so the renderer publishes its live set and {@link isAllowed} gates on it.
 *
 * RESIDUAL: the renderer can still read cross-origin response bodies from its declared
 * homeservers. That is inherent, and it bounds the XSS amplification: a future sanitizer
 * bypass on untrusted federated message HTML gains reads against the declared homeservers,
 * not arbitrary https origins. Undeclared origins pass through with the server's own
 * headers, which costs nothing: the Matrix spec requires CS API and `.well-known`
 * responses to send `Access-Control-Allow-Origin: *`, so only proxies that strip it need
 * this shim at all.
 */

// The pattern deliberately does not match the `trinity://app` scheme.
const REMOTE_URLS = ['https://*/*', 'http://*/*'] as const;

// Electron keys response headers however the origin server cased them, so matching and
// removal below lowercase.
const ACAO = 'access-control-allow-origin';
const ACAM = 'access-control-allow-methods';
const ACAH = 'access-control-allow-headers';
const ACMA = 'access-control-max-age';
const ACAC = 'access-control-allow-credentials';

// The CORS keys we own: any the server already sent are stripped before we set ours, since
// Chromium rejects a response carrying two ACAO values. ACAC is managed and never re-set,
// so an origin cannot opt itself into credentialed cross-origin reads by returning
// `access-control-allow-credentials: true` next to our ACAO. matrix-js-sdk authenticates
// with a bearer header, not cookies, so nothing needs credentialed CORS.
const MANAGED = [ACAO, ACAM, ACAH, ACMA, ACAC];

/**
 * Origins the renderer declared it talks to: the signed-in homeservers plus any origin
 * `.well-known` discovery is probing. Populated over IPC ({@link setAllowedCorsOrigins});
 * empty until the renderer says otherwise, which is the safe direction.
 *
 * Anything not in here passes through untouched. That is safe, not lax: the Matrix spec
 * requires CS API and `.well-known` responses to carry `Access-Control-Allow-Origin: *`,
 * so a compliant server needs no help, and for a proxy that strips it the renderer names
 * the origin.
 */
const allowedOrigins = new Set<string>();

/**
 * Replace the set of origins the shim will rewrite for. Invalid entries are dropped
 * rather than throwing: this is a trust boundary, and a malformed payload must not take
 * the shim (or the main process) down.
 */
export function setAllowedCorsOrigins(origins: readonly string[]): void {
  allowedOrigins.clear();
  for (const raw of origins) {
    if (typeof raw !== 'string') {
      continue;
    }
    try {
      // Normalise so 'https://hs.example/' and 'https://hs.example:443/foo' reduce to the
      // same origin the interceptor compares against.
      allowedOrigins.add(new URL(raw).origin);
    } catch {
      // Not a URL — ignore it.
    }
  }
}

/**
 * Additively allow one origin. Discovery and login talk to a homeserver before any
 * account exists to declare it; the next {@link setAllowedCorsOrigins} (fired whenever
 * the account set changes) replaces the whole set, so a probe of a server never signed
 * into is dropped rather than lingering.
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
 * Register an `onHeadersReceived` interceptor that makes declared Matrix homeservers
 * respond CORS-clean to the `trinity://app` renderer. Call once, on the session the main
 * window uses, before the window loads its URL.
 */
export function installMatrixCors(session: Electron.Session): void {
  session.webRequest.onHeadersReceived(
    { urls: [...REMOTE_URLS] },
    (details, callback) => {
      // Undeclared origins keep the server's own headers, so a sanitizer bypass in the
      // renderer cannot borrow this shim as a read-anywhere primitive.
      if (!isAllowed(details.url)) {
        callback({});
        return;
      }
      const responseHeaders: Record<string, string[]> = {
        ...(details.responseHeaders ?? {}),
      };

      deleteHeaders(responseHeaders, MANAGED);

      // Exact origin (never `*`) so credentialed requests are permitted.
      responseHeaders[ACAO] = [APP_ORIGIN];

      // Preflight: `Authorization` must be listed explicitly, as the `*` wildcard never
      // covers it. onHeadersReceived details carry no request headers to echo; this
      // allow-list suffices since matrix-js-sdk only sends Authorization + Content-Type.
      if (details.method === 'OPTIONS') {
        responseHeaders[ACAM] = ['GET, POST, PUT, DELETE, PATCH, OPTIONS'];
        responseHeaders[ACAH] = ['Authorization, Content-Type'];
        responseHeaders[ACMA] = ['86400'];
      }

      callback({ responseHeaders });
    },
  );
}
