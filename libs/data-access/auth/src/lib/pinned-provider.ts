import { isSameUrl, type OidcSessionBinding } from '@trinity/util/matrix';
import type { AuthMetadata } from './auth-metadata';

/**
 * Whether the metadata names the provider an account signed in with: the same issuer,
 * token endpoint and (when pinned) revocation endpoint as its pinned binding, and a
 * sign-in page on the issuer's host (the binding keeps no authorization endpoint). False
 * for a binding without pinned endpoints.
 */
export function matchesPinnedProvider(
  metadata: Pick<
    AuthMetadata,
    'issuer' | 'authorization_endpoint' | 'token_endpoint'
  > &
    Partial<Pick<AuthMetadata, 'revocation_endpoint'>>,
  binding: OidcSessionBinding,
): boolean {
  const signInHost = hostOf(metadata.authorization_endpoint);
  return (
    !!binding.tokenEndpoint &&
    isSameUrl(metadata.issuer, binding.issuer) &&
    isSameUrl(metadata.token_endpoint, binding.tokenEndpoint) &&
    (binding.revocationEndpoint === undefined ||
      isSameUrl(metadata.revocation_endpoint, binding.revocationEndpoint)) &&
    signInHost !== null &&
    signInHost === hostOf(binding.issuer)
  );
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
