import { HTTPError, MatrixError, createClient } from 'matrix-js-sdk';
import { Observable, catchError, defer, from, map, of } from 'rxjs';
import type { AccountServerApi } from './account-server-api';

/**
 * The server answered without offering OAuth 2.0 metadata: `M_UNRECOGNIZED`, or a client
 * error or 501 from it or its proxy. A timeout, rate limiting, a 5xx, no connection or a
 * body that isn't valid metadata (a captive portal) leave the answer unknown.
 */
export function lacksAuthMetadata(err: unknown): boolean {
  if (err instanceof MatrixError && err.errcode === 'M_UNRECOGNIZED') {
    return true;
  }
  if (!(err instanceof HTTPError)) return false;
  const status = err.httpStatus ?? 0;
  return (
    status === 501 ||
    (status >= 400 && status < 500 && status !== 408 && status !== 429)
  );
}

/**
 * The URL comes from homeserver-controlled metadata, so it is validated as https before
 * it is surfaced; a non-https value is rejected, not opened.
 */
export function serverApi(baseUrl: string): Observable<AccountServerApi> {
  return defer(() => from(createClient({ baseUrl }).getAuthMetadata())).pipe(
    map((config): AccountServerApi => {
      const url = config.account_management_uri;
      return {
        kind: 'oauth',
        management:
          url && /^https:\/\//i.test(url)
            ? {
                url,
                actionsSupported:
                  config.account_management_actions_supported ?? [],
              }
            : null,
      };
    }),
    catchError((err: unknown) =>
      of<AccountServerApi>(
        lacksAuthMetadata(err) ? { kind: 'legacy' } : { kind: 'unknown' },
      ),
    ),
  );
}
