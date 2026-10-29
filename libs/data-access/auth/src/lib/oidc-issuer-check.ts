import { OIDC_PROVIDER_MISMATCH, isSameUrl } from '@trinity/util/matrix';
import type { AuthMetadata } from './auth-metadata';
import type { OidcGrantContext } from './oidc-client.service';

/**
 * Check that the sign-in response comes from the provider it started with (RFC 9207).
 *
 * An `iss` on the callback must equal the issuer the sign-in started with, by simple string
 * comparison, and a provider that says it always sends `iss` must have sent one. The
 * metadata fetched again for the exchange must still name that issuer too, or the token
 * endpoint it gives is not that provider's.
 */
export function checkIssuer(
  metadata: AuthMetadata,
  context: OidcGrantContext,
): void {
  const issRequired =
    'authorization_response_iss_parameter_supported' in metadata &&
    metadata.authorization_response_iss_parameter_supported === true;
  if (
    metadata.issuer !== context.issuer ||
    (context.iss === undefined ? issRequired : context.iss !== context.issuer)
  ) {
    throw new Error(OIDC_PROVIDER_MISMATCH);
  }
}

/**
 * Check that the homeserver's metadata still names the endpoints that were checked before
 * the redirect, so the code goes to the token endpoint the sign-in was started with.
 */
export function checkSavedEndpoints(
  metadata: AuthMetadata,
  context: OidcGrantContext,
): void {
  if (
    !isSameUrl(
      metadata.authorization_endpoint,
      context.authorizationEndpoint,
    ) ||
    !isSameUrl(metadata.token_endpoint, context.tokenEndpoint) ||
    (context.revocationEndpoint !== undefined &&
      !isSameUrl(metadata.revocation_endpoint, context.revocationEndpoint))
  ) {
    throw new Error(OIDC_PROVIDER_MISMATCH);
  }
}
