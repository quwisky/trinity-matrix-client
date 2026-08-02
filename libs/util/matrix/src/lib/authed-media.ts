import { ConnectionError, HTTPError, type MatrixClient } from 'matrix-js-sdk';
import {
  Observable,
  catchError,
  defer,
  from,
  of,
  switchMap,
  throwError,
} from 'rxjs';
import { retryTransient } from './transient-errors';

/** Server-thumbnail dimensions, or null to fetch the resource as-is. */
export type MediaResize = { w: number; h: number } | null;

/** Build the http(s) URL for an `mxc://` (authenticated or legacy endpoint). */
export function mediaHttpUrl(
  client: MatrixClient,
  mxc: string,
  resize: MediaResize,
  useAuthentication: boolean,
): string {
  const url = resize
    ? client.mxcUrlToHttp(
        mxc,
        resize.w,
        resize.h,
        'scale',
        false,
        true,
        useAuthentication,
      )
    : client.mxcUrlToHttp(
        mxc,
        undefined,
        undefined,
        undefined,
        false,
        true,
        useAuthentication,
      );
  if (!url) {
    throw new Error('Could not resolve media URL');
  }
  return url;
}

/**
 * Statuses that mean "this homeserver does not serve authenticated media", and so are
 * worth re-trying against the legacy endpoint: an older server that advertises v1.11 but
 * does not route `/_matrix/client/v1/media/download` answers the unknown endpoint with
 * `M_UNRECOGNIZED` as a 404 (some as a 400).
 *
 * Deliberately narrow. A 429 or 5xx means the server is there and struggling, and falling
 * back on those is actively harmful: on a homeserver that has *disabled* legacy media
 * (Synapse's default since 1.120) the legacy attempt answers 404, and that terminal status
 * is what reaches {@link retryTransient} — so a retryable hiccup became a hard failure and
 * the caller rendered its placeholder.
 */
function isUnsupportedEndpoint(status: number): boolean {
  return (
    status === 404 || // M_UNRECOGNIZED, the spec'd answer for an unknown endpoint
    status === 400 || // some servers answer M_UNRECOGNIZED as 400
    status === 405 || // a reverse proxy that does not route the v1 media path
    status === 501 // a gateway reporting the method as unimplemented
  );
}

/**
 * Re-tag a network-level failure as the SDK's own ConnectionError.
 *
 * A dropped connection surfaces as a bare TypeError carrying no status, which
 * {@link isTransientMatrixError} cannot recognise and so treats as terminal. Tagging it
 * here — rather than widening that predicate — keeps a plain TypeError non-transient
 * everywhere else, which is what its spec pins and what the global error handler wants.
 */
function asConnectionError(cause: unknown): Observable<never> {
  return throwError(
    () =>
      new ConnectionError(
        'Media fetch failed',
        cause instanceof Error ? cause : undefined,
      ),
  );
}

/**
 * Fetch raw media bytes for an `mxc://`, using authenticated media (Bearer token)
 * when the homeserver supports it, and falling back to the legacy unauthenticated
 * endpoint if that endpoint turns out to be unsupported — older servers advertise
 * v1.11 but still serve legacy. Shared by {@link MediaService} (attachments) and the
 * avatar resolver.
 *
 * Every request is built inside a `defer`, so {@link retryTransient} genuinely re-issues
 * it. Calling `fetch()` eagerly (to hand `from()` a promise) would look identical but
 * silently defeat the retry: re-subscribing to an already-settled promise replays its
 * result, so the request would be made exactly once however many times it was retried.
 */
export function fetchMediaBytes(
  client: MatrixClient,
  mxc: string,
  resize: MediaResize,
  authed: boolean,
): Observable<ArrayBuffer> {
  const token = client.getAccessToken();
  const useAuthedEndpoint = authed && !!token;

  const doFetch = (useAuthentication: boolean): Observable<Response> =>
    defer(() => {
      const url = mediaHttpUrl(client, mxc, resize, useAuthentication);
      const bearer = useAuthentication ? token : null;
      return from(
        fetch(
          url,
          bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {},
        ),
      ).pipe(
        // A rejected `fetch` is a network-level failure (offline, DNS/TLS, a CORS
        // rejection) rather than an answer from the server. Without the re-tag an
        // offline blip lasting a few hundred ms is terminal for every avatar in flight.
        catchError(asConnectionError),
      );
    });

  return doFetch(useAuthedEndpoint).pipe(
    switchMap((res) =>
      !res.ok && useAuthedEndpoint && isUnsupportedEndpoint(res.status)
        ? doFetch(false)
        : of(res),
    ),
    switchMap((res) =>
      res.ok
        ? // Reading the body can fail on its own — the connection dropping after the
          // headers arrived aborts the stream — and that rejection is a bare TypeError
          // just like a rejected `fetch`. Re-tag it the same way, or the very blip this
          // retries would still be terminal one line further down the pipeline.
          from(res.arrayBuffer()).pipe(catchError(asConnectionError))
        : // Throw an HTTPError carrying the status so retryTransient recognises a
          // transient 503/5xx/429 and retries with backoff before the caller's
          // catchError falls back (a plain Error would be treated as terminal).
          throwError(
            () =>
              new HTTPError(`Media fetch failed (${res.status})`, res.status),
          ),
    ),
    // Retry a flaky homeserver a few times before the avatar/media services'
    // existing catchError renders the placeholder.
    retryTransient(),
  );
}
