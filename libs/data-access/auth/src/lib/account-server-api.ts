import type { EngineResult } from '@trinity/util/matrix';
import type { AuthMetadata } from './auth-metadata';

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
 * Which account API the server's auth-metadata answer means. The account page comes from
 * homeserver-controlled metadata, so it is surfaced only when it is https; a non-https value
 * is rejected, not opened.
 */
export function accountServerApi(
  answer: EngineResult<AuthMetadata | null>,
): AccountServerApi {
  if (!answer.ok) return { kind: 'unknown' };
  if (!answer.value) return { kind: 'legacy' };
  const url = answer.value.account_management_uri;
  return {
    kind: 'oauth',
    management:
      url && /^https:\/\//i.test(url)
        ? {
            url,
            actionsSupported: [
              ...(answer.value.account_management_actions_supported ?? []),
            ],
          }
        : null,
  };
}
