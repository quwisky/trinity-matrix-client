import { Observable, catchError, defer, from, of, switchMap } from 'rxjs';
import type {
  HomeserverCapabilities,
  ServerSoftware,
} from './homeserver-info.model';

/**
 * The three read-only probes behind the Server settings section, as plain functions over
 * `fetch`. DI-free and client-free so they can be tested against real fixtures without a
 * TestBed; `HomeserverInfoService` owns the per-account fan-out and cache.
 *
 * **Everything here resolves — nothing throws.** The whole surface is best-effort by
 * requirement (#155: "show unknown or hide the row — never an error toast"), so a failure
 * is a `null` value rather than an error the caller has to remember to catch. That is what
 * makes the section's error branch provably dead rather than merely unused.
 *
 * **Every request is built inside `defer()`.** Calling `fetch()` eagerly to hand `from()` a
 * promise looks identical and silently breaks two things: the observable stops being cold,
 * so merely *building* one issues a request nobody subscribed to, and a re-subscribe replays
 * the settled promise rather than re-asking. Same trap documented at `@trinity/util/matrix`'s
 * `fetchMediaBytes`.
 */

/**
 * Per-request budget. Short on purpose: the software probe alone is up to three SEQUENTIAL
 * hops, so this is the per-hop budget and 3x it is the per-account ceiling — the section is
 * a glance, and a homeserver that has not answered in this long is "unknown" for the
 * reader's purposes anyway. Without it a hung connection leaves the block spinning and the
 * "Check again" button disabled indefinitely.
 */
const TIMEOUT_MS = 8_000;

/** `GET /_matrix/federation/v1/version` — what the server says it is running. */
const FEDERATION_VERSION_PATH = '/_matrix/federation/v1/version';

/**
 * The server's software and version, best-effort, in two attempts.
 *
 * 1. The account's own client base URL.
 * 2. The federation host named by `https://<serverName>/.well-known/matrix/server`.
 *
 * The issue that asked for this called attempt 2 "a reasonable second attempt". Measured,
 * it is the attempt that works on the largest homeserver in the network: matrix.org's
 * client base URL is `matrix-client.matrix.org`, which answers **404 with an HTML body and
 * no CORS header** — so a browser does not even see the status, it sees a rejected fetch —
 * while `matrix.org/.well-known/matrix/server` points at `matrix-federation.matrix.org`,
 * which answers correctly. Single-host deployments are the ones attempt 1 covers.
 *
 * Note attempt 2 keys on the **server name from the mxid**, not on the base URL: in exactly
 * the delegating case those are different hosts, and the base URL is the wrong one.
 */
export function probeServerSoftware(
  baseUrl: string,
  serverName: string,
): Observable<ServerSoftware | null> {
  const tried = safeUrl(baseUrl)?.origin ?? null;
  return fetchFederationVersion(baseUrl, 'base-url').pipe(
    switchMap((direct) =>
      direct ? of(direct) : probeDelegatedSoftware(serverName, tried),
    ),
  );
}

/**
 * Attempt 2: resolve the federation host from `.well-known`, then ask it.
 *
 * `alreadyTried` is the origin attempt 1 used. The common single-host shape publishes
 * `m.server: "example.org:443"` for base URL `https://example.org`, which resolves to the
 * identical origin — re-asking it would spend a second request (and, against a host that
 * hangs, a second timeout) to get the same answer, and would label the result `delegated`
 * for a server that is not delegating.
 */
function probeDelegatedSoftware(
  serverName: string,
  alreadyTried: string | null,
): Observable<ServerSoftware | null> {
  // Validated on the same rule as `m.server`, rather than interpolated raw. It is derived
  // from the account's own mxid, which comes from the homeserver's login response and is
  // stored unvalidated — so `@u:good.example@evil.example` would otherwise address
  // `evil.example`. No credentials ride on this request, but the asymmetry with the
  // `m.server` path is not worth keeping.
  const origin = federationOrigin(serverName);
  const wellKnown = origin && safeUrl(`${origin}/.well-known/matrix/server`);
  if (!wellKnown) {
    return of(null);
  }
  return getJson(wellKnown).pipe(
    switchMap((body) => {
      const server = readString(body, 'm.server');
      const federation = server ? federationOrigin(server) : null;
      return federation && federation !== alreadyTried
        ? fetchFederationVersion(federation, 'delegated')
        : of(null);
    }),
  );
}

/** One federation-version request against a known-good origin. */
function fetchFederationVersion(
  origin: string,
  source: ServerSoftware['source'],
): Observable<ServerSoftware | null> {
  const url = safeUrl(FEDERATION_VERSION_PATH, origin);
  if (!url) {
    return of(null);
  }
  return getJson(url).pipe(
    switchMap((body) => of(toSoftware(body, source, url.origin))),
  );
}

/**
 * The spec versions and enabled unstable features this server advertises.
 *
 * A raw request rather than `client.getVersions()`, and that is load-bearing rather than
 * stylistic: the SDK memoises that call on the client forever and already awaited it inside
 * `startClient()`, so a "Check again" routed through it would re-issue **no HTTP** and
 * replay the value fetched at login — defeating the one requirement the button exists for.
 */
export function fetchSpecVersions(
  baseUrl: string,
  accessToken: string | null,
): Observable<{
  versions: readonly string[];
  unstableFeatures: readonly string[];
} | null> {
  const url = clientApiUrl(baseUrl, '/_matrix/client/versions');
  if (!url) {
    return of(null);
  }
  return getJson(url, accessToken).pipe(
    switchMap((body) => {
      const versions = readStringArray(body, 'versions');
      if (!versions) {
        return of(null);
      }
      return of({ versions, unstableFeatures: readEnabledFlags(body) });
    }),
  );
}

/**
 * The two capabilities worth showing. Authenticated, unlike the other two probes.
 *
 * Raw, like {@link fetchSpecVersions}, but for a weaker reason worth stating precisely:
 * `client.getCapabilities()` reads a six-hour poller cache, and while `fetchCapabilities()`
 * *does* force a refetch, routing through either would give up the two properties the rest
 * of this module is built on — it resolves rather than throwing, and it carries a timeout.
 * Keeping all three probes on one code path is worth more here than reusing the SDK call.
 */
export function fetchCapabilities(
  baseUrl: string,
  accessToken: string | null,
): Observable<HomeserverCapabilities | null> {
  const url = clientApiUrl(baseUrl, '/_matrix/client/v3/capabilities');
  if (!url || !accessToken) {
    return of(null);
  }
  return getJson(url, accessToken).pipe(
    switchMap((body) => of(toCapabilities(body))),
  );
}

/**
 * One GET that resolves `unknown` on success and `null` on every kind of failure.
 *
 * The three failures are deliberately collapsed because a browser cannot tell them apart
 * anyway: a non-2xx **without** a CORS header (which is what both measured failing servers
 * return) arrives as a rejected fetch carrying no status, indistinguishable from being
 * offline. Reading the body is a second, separate failure — an HTML error page under a 200,
 * or a truncated stream — so it gets its own guard rather than riding on `res.ok`.
 *
 * `credentials: 'omit'` and `redirect: 'error'` are the security posture: the well-known and
 * federation hosts are named by data the *server* controls, so no cookie, no token and no
 * redirect may follow the request there. The bearer token is passed only by the two callers
 * that address the account's own base URL.
 */
function getJson(url: URL, accessToken?: string | null): Observable<unknown> {
  return defer(() =>
    from(
      fetch(url, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        // The whole surface exists to answer "has this changed?", and a CDN-cached
        // `.well-known/matrix/server` would let the HTTP cache answer "Check again" from
        // before the change. Costs nothing on responses that are not cacheable anyway.
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: accessToken
          ? { Authorization: `Bearer ${accessToken}` }
          : undefined,
      }),
    ),
  ).pipe(
    switchMap((res) => (res.ok ? from(res.json()) : of(null))),
    catchError(() => of(null)),
  );
}

/**
 * The origin to ask for a delegated federation version, or null if `m.server` is not a bare
 * host.
 *
 * Per the spec `m.server` is `host` or `host:port` — never a URL — and it is a value the
 * *server* chose, so it is validated rather than coerced.
 *
 * A host with no port is taken as 443, which is NOT the spec default: S2S "Resolving server
 * names" 3.3-3.5 says resolve `_matrix-fed._tcp` and otherwise use 8448. Deliberate — a
 * browser cannot do SRV, and a 8448 listener essentially never sends CORS headers, so the
 * spec-correct guess would cost a request and a timeout to arrive at the same "Unknown".
 * Deployments that want to be reachable here publish the port (matrix.org sends `:443`). Prefixing `https://` and trusting
 * `new URL` is not enough: `https://` + `http://evil.example` parses perfectly happily into
 * the host `http` with `//evil.example` as its path, which would spend a request on a host
 * nobody named. Requiring an empty path, no query, no fragment and no userinfo is what
 * turns those into "no answer" instead.
 */
function federationOrigin(mServer: string): string | null {
  const url = safeUrl(`https://${mServer}`);
  if (
    !url ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    return null;
  }
  return url.origin;
}

/**
 * A client-server API URL under `baseUrl`, built by **concatenation**.
 *
 * Not `new URL(path, baseUrl)`: an absolute path REPLACES the base's path, and a homeserver
 * may legitimately publish a base URL that carries one —
 * `{"m.homeserver":{"base_url":"https://example.org/matrix"}}`. `AutoDiscovery` preserves
 * that path, the SDK concatenates the same way (`MatrixHttpApi.getUrl`), and
 * `AuthService.discoverHomeserver` stores it verbatim, so such a deployment syncs normally —
 * while a resolved URL would silently address the apex instead, permanently answering
 * "Unknown" and putting the account's bearer token on a path its homeserver does not own.
 *
 * {@link fetchFederationVersion} deliberately does the opposite and resolves against the
 * origin: the federation API is served at the root, never under the client path.
 */
function clientApiUrl(baseUrl: string, path: string): URL | null {
  return safeUrl(`${baseUrl.replace(/\/+$/, '')}${path}`);
}

/** `https://` URLs only, and only ones that parse. Anything else is not requested. */
function safeUrl(input: string, base?: string): URL | null {
  try {
    const url = new URL(input, base);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** Project the federation response, or null when it is not the shape we expect. */
function toSoftware(
  body: unknown,
  source: ServerSoftware['source'],
  host: string,
): ServerSoftware | null {
  const server = readRecord(body, 'server');
  const name = server && readString(server, 'name');
  const version = server && readString(server, 'version');
  // Both halves required: a server that names itself but not its version answers nothing
  // useful for "is my deploy live?", and rendering "Synapse undefined" would be worse than
  // the honest "Unknown".
  return name && version ? { name, version, source, host } : null;
}

/** Project `/capabilities`, keeping null for anything the server did not state. */
function toCapabilities(body: unknown): HomeserverCapabilities | null {
  const capabilities = readRecord(body, 'capabilities');
  if (!capabilities) {
    return null;
  }
  const roomVersions = readRecord(capabilities, 'm.room_versions');
  const changePassword = readRecord(capabilities, 'm.change_password');
  const enabled = changePassword?.['enabled'];
  const info: HomeserverCapabilities = {
    defaultRoomVersion: roomVersions
      ? readString(roomVersions, 'default')
      : null,
    // Absent means "supported" per the spec, but absent ALSO covers a server that never
    // mentioned the capability at all — so null (unstated) rather than a confident `true`.
    canChangePassword: typeof enabled === 'boolean' ? enabled : null,
  };
  return info.defaultRoomVersion === null && info.canChangePassword === null
    ? null
    : info;
}

/** The unstable feature flags the server advertises as ON, sorted for a stable render. */
function readEnabledFlags(body: unknown): readonly string[] {
  const flags = readRecord(body, 'unstable_features');
  if (!flags) {
    return [];
  }
  return Object.keys(flags)
    .filter((key) => flags[key] === true)
    .sort();
}

function readRecord(
  value: unknown,
  key: string,
): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === 'object' && nested !== null
    ? (nested as Record<string, unknown>)
    : null;
}

function readString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const field = (value as Record<string, unknown>)[key];
  // Trimmed, not just guarded on `.trim()`: a server that echoes a version file keeps its
  // trailing newline, and the caller renders this verbatim into a one-line heading.
  return typeof field === 'string' && field.trim() ? field.trim() : null;
}

function readStringArray(
  value: unknown,
  key: string,
): readonly string[] | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const field = (value as Record<string, unknown>)[key];
  if (!Array.isArray(field)) {
    return null;
  }
  const strings = field.filter(
    (item): item is string => typeof item === 'string',
  );
  return strings.length ? strings : null;
}
