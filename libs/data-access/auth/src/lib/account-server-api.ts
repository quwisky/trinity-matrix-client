import { HTTPError, MatrixError, createClient } from 'matrix-js-sdk';
import { Observable, catchError, defer, from, map, of } from 'rxjs';

/** The active OIDC account's provider-hosted account-management surface. */
export interface AccountManagement {
  /** The provider's account-management URL (validated https). */
  url: string;
  /** MSC2965 actions the provider supports deep-linking to (e.g. session management). */
  actionsSupported: string[];
}

/**
 * Which Matrix API a server uses for accounts: the legacy API (in-app password and deletion
 * forms) or OAuth 2.0, whose provider owns credentials and deletion.
 */
export type AccountServerApi =
  | { readonly kind: 'legacy' }
  /** The server could not be asked, so neither API can be offered. */
  | { readonly kind: 'unknown' }
  | {
      readonly kind: 'oauth';
      /** Null when the provider publishes no usable account page. */
      readonly management: AccountManagement | null;
    };

const ACCOUNT_DEACTIVATE_ACTION = 'org.matrix.account_deactivate';

/**
 * The provider page to delete an account at. The action is added only when advertised:
 * MAS rejects actions it does not list, and its account home page holds Delete account.
 */
export function deletionLink(management: AccountManagement): string {
  if (!management.actionsSupported.includes(ACCOUNT_DEACTIVATE_ACTION)) {
    return management.url;
  }
  try {
    const url = new URL(management.url);
    url.searchParams.set('action', ACCOUNT_DEACTIVATE_ACTION);
    return url.toString();
  } catch {
    return management.url;
  }
}

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
