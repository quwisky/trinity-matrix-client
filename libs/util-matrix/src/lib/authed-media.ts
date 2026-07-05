import { HTTPError, type MatrixClient } from 'matrix-js-sdk';
import { Observable, from, of, switchMap, throwError } from 'rxjs';
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
 * Fetch raw media bytes for an `mxc://`, using authenticated media (Bearer token)
 * when the homeserver supports it, and falling back to the legacy unauthenticated
 * endpoint if that fails — older servers advertise v1.11 but still serve legacy.
 * Shared by {@link MediaService} (attachments) and the avatar resolver.
 */
export function fetchMediaBytes(
  client: MatrixClient,
  mxc: string,
  resize: MediaResize,
  authed: boolean,
): Observable<ArrayBuffer> {
  const token = client.getAccessToken();
  const doFetch = (url: string, bearer: string | null): Observable<Response> =>
    from(
      fetch(
        url,
        bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {},
      ),
    );
  return doFetch(
    mediaHttpUrl(client, mxc, resize, authed && !!token),
    authed ? token : null,
  ).pipe(
    switchMap((res) =>
      !res.ok && authed
        ? doFetch(mediaHttpUrl(client, mxc, resize, false), null)
        : of(res),
    ),
    switchMap((res) =>
      res.ok
        ? from(res.arrayBuffer())
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
