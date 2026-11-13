import { probeMatrixOrigin } from './cors-probe';
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
 * SCOPE: the rewrite needs two things of an origin. The renderer must have named it over
 * IPC ({@link setAllowedCorsOrigins} / {@link allowCorsOrigin}): the signed-in homeservers
 * plus whatever `.well-known` discovery and login are asking. Main cannot know those
 * itself (the renderer picks the homeserver at login, multi-account means several, and
 * discovery asks an origin typed before any account exists). And main must have confirmed
 * it with its own request ({@link probeMatrixOrigin}): naming an origin is only a request,
 * because the renderer is the party this list bounds. Only https origins qualify.
 *
 * A response from a named origin that main has not confirmed yet is held until the probe
 * answers, so the renderer's first requests to a new homeserver cannot lose the race. An
 * origin that could not be reached is asked again when a response from it next arrives
 * (an offline start), and one that answered as something else is asked again no sooner
 * than {@link REFUSAL_RETRY_MS} later.
 *
 * RESIDUAL: script injected into the renderer (a sanitizer bypass on untrusted federated
 * message HTML) can read response bodies, without cookies or other credentials, from any
 * https host this machine can reach that answers `/_matrix/client/versions` like a
 * homeserver, and the `.well-known/matrix/` documents of any host that publishes a Matrix
 * client well-known. That includes such hosts on an intranet. It cannot read a host that
 * answers as neither. Unnamed and unconfirmed origins pass through with the server's own
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
 * Origins the renderer named: the signed-in homeservers plus any origin `.well-known`
 * discovery is asking. Empty until the renderer says otherwise, which is the safe
 * direction. Being named is necessary, not sufficient: see {@link confirmed}.
 */
const allowedOrigins = new Set<string>();

/**
 * What main's own probe found, kept for the session so a republished set costs no
 * request. A `well-known` host is not a homeserver, so only those documents are rewritten.
 */
const confirmed = new Map<string, 'homeserver' | 'well-known'>();
const probing = new Map<string, Promise<void>>();
const refusedAt = new Map<string, number>();

const REFUSAL_RETRY_MS = 30_000;
// Bounds how many hosts injected script can make main contact. A session signs in to a
// handful of homeservers; past this, a new origin is simply never confirmed.
const MAX_PROBED_ORIGINS = 100;
const probedOrigins = new Set<string>();

/** The probe a not-yet-confirmed origin is waiting on, started if it may be. */
function confirmation(origin: string): Promise<void> | undefined {
  if (confirmed.has(origin)) {
    return undefined;
  }
  const running = probing.get(origin);
  if (running) {
    return running;
  }
  const refused = refusedAt.get(origin);
  if (refused !== undefined && Date.now() - refused < REFUSAL_RETRY_MS) {
    return undefined;
  }
  if (!probedOrigins.has(origin) && probedOrigins.size >= MAX_PROBED_ORIGINS) {
    return undefined;
  }
  probedOrigins.add(origin);
  const probe = probeMatrixOrigin(origin)
    .then((result) => {
      if (result === 'refused') {
        refusedAt.set(origin, Date.now());
      } else if (result !== 'unreachable') {
        confirmed.set(origin, result);
      }
    })
    .catch(() => undefined)
    .finally(() => probing.delete(origin));
  probing.set(origin, probe);
  return probe;
}

/** `raw` as a bare https origin, or `null`: junk and http are dropped, never thrown on. */
function httpsOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  try {
    // Normalise so 'https://hs.example/' and 'https://hs.example:443/foo' reduce to the
    // same origin the interceptor compares against.
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Additively name one origin. Discovery and login talk to a homeserver before any
 * account exists to declare it; the next {@link setAllowedCorsOrigins} (fired whenever
 * the account set changes) replaces the whole set, so an origin never signed into is
 * dropped rather than lingering.
 */
export function allowCorsOrigin(raw: string): void {
  const origin = httpsOrigin(raw);
  if (origin) {
    allowedOrigins.add(origin);
    void confirmation(origin);
  }
}

/**
 * Replace the set of origins the renderer names. Invalid entries are dropped rather than
 * throwing: this is a trust boundary, and a malformed payload must not take the shim (or
 * the main process) down.
 */
export function setAllowedCorsOrigins(origins: readonly string[]): void {
  allowedOrigins.clear();
  for (const raw of origins) {
    allowCorsOrigin(raw);
  }
}

/** The origins the renderer currently names (test seam / diagnostics). */
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

/** Whether a response from `url` gets the CORS headers, as things stand right now. */
function rewrites(url: URL): boolean {
  if (!allowedOrigins.has(url.origin)) {
    return false;
  }
  const kind = confirmed.get(url.origin);
  return (
    kind === 'homeserver' ||
    (kind === 'well-known' && url.pathname.startsWith('/.well-known/matrix/'))
  );
}

function corsHeaders(
  details: Electron.OnHeadersReceivedListenerDetails,
): Record<string, string[]> {
  const responseHeaders: Record<string, string[]> = {
    ...(details.responseHeaders ?? {}),
  };

  deleteHeaders(responseHeaders, MANAGED);

  // Exact origin, never `*`.
  responseHeaders[ACAO] = [APP_ORIGIN];

  // Preflight: `Authorization` must be listed explicitly, as the `*` wildcard never
  // covers it. onHeadersReceived details carry no request headers to echo; this
  // allow-list suffices since matrix-js-sdk only sends Authorization + Content-Type.
  if (details.method === 'OPTIONS') {
    responseHeaders[ACAM] = ['GET, POST, PUT, DELETE, PATCH, OPTIONS'];
    responseHeaders[ACAH] = ['Authorization, Content-Type'];
    responseHeaders[ACMA] = ['86400'];
  }
  return responseHeaders;
}

/**
 * Register an `onHeadersReceived` interceptor that makes named and confirmed Matrix servers
 * respond CORS-clean to the `trinity://app` renderer. Call once, on the session the main
 * window uses, before the window loads its URL.
 */
export function installMatrixCors(session: Electron.Session): void {
  session.webRequest.onHeadersReceived(
    { urls: [...REMOTE_URLS] },
    (details, callback) => {
      // Everything else keeps the server's own headers, so a sanitizer bypass in the
      // renderer cannot borrow this shim as a read-anywhere primitive.
      const url = URL.parse(details.url);
      if (!url || !allowedOrigins.has(url.origin)) {
        callback({});
        return;
      }
      // Decided after the wait: the origin may have been withdrawn meanwhile.
      const respond = (): void =>
        callback(
          rewrites(url) ? { responseHeaders: corsHeaders(details) } : {},
        );
      const pending = confirmation(url.origin);
      if (pending) {
        void pending.then(respond);
      } else {
        respond();
      }
    },
  );
}
