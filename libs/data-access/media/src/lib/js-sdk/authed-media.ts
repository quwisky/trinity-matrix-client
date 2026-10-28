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
import { retryTransient } from '@trinity/util/matrix';

/** Server-thumbnail dimensions, or null to fetch the resource as-is. */
export type MediaResize = {
  w: number;
  h: number;
  method?: 'scale' | 'crop';
} | null;

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
        resize.method ?? 'scale',
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
 * Deliberately narrow. A 429 or 5xx means the server is there and struggling; falling back
 * on those is harmful, because a homeserver that *disabled* legacy media (Synapse's default
 * since 1.120) answers the legacy attempt with a terminal 404 that reaches
 * {@link retryTransient} in place of the retryable status.
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
 * Re-tag a network-level failure as the SDK's own ConnectionError. A dropped connection
 * surfaces as a bare TypeError with no status, which {@link isTransientMatrixError} treats
 * as terminal; tagging it here keeps a plain TypeError non-transient everywhere else.
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
 * Fetch raw media bytes for an `mxc://`, using authenticated media (Bearer token) when the
 * homeserver supports it, and falling back to the legacy unauthenticated endpoint if that
 * endpoint turns out to be unsupported.
 *
 * Every request is built inside a `defer`, so {@link retryTransient} genuinely re-issues it:
 * an eager `fetch()` promise would be replayed, not re-sent, on each retry.
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
        // A rejected `fetch` is a network-level failure (offline, DNS/TLS, CORS), not a
        // server answer; without the re-tag a brief offline blip is terminal.
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
        ? // Reading the body can fail after the headers arrived (connection dropped), with a
          // bare TypeError like a rejected `fetch`; re-tag it the same way.
          from(res.arrayBuffer()).pipe(catchError(asConnectionError))
        : // An HTTPError carries the status so retryTransient recognises a transient
          // 503/5xx/429 (a plain Error would be terminal).
          throwError(
            () =>
              new HTTPError(`Media fetch failed (${res.status})`, res.status),
          ),
    ),
    // Retry a flaky homeserver before the callers' catchError renders the placeholder.
    retryTransient(),
  );
}
