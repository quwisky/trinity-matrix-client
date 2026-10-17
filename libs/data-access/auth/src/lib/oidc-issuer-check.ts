import type { ValidatedAuthMetadata } from 'matrix-js-sdk';
import type { OidcGrantContext } from './oidc-client.service';

/** Shown when the callback or the homeserver names a provider other than the one signed in with. */
const PROVIDER_MISMATCH =
  "Sign-in could not be completed with this server's sign-in provider. Try again.";
/** The issuer's own discovery is a side check; an unresponsive host must not hold the callback. */
const DISCOVERY_TIMEOUT_MS = 8_000;

/**
 * Check that the sign-in response comes from the provider it started with (RFC 9207).
 *
 * An `iss` on the callback must equal the issuer the sign-in started with, by simple string
 * comparison, and a provider that says it always sends `iss` must have sent one. The
 * metadata fetched again for the exchange must still name that issuer too, or the token
 * endpoint it gives is not that provider's.
 */
export function checkIssuer(
  metadata: ValidatedAuthMetadata,
  context: OidcGrantContext,
): void {
  const issRequired =
    'authorization_response_iss_parameter_supported' in metadata &&
    metadata.authorization_response_iss_parameter_supported === true;
  if (
    metadata.issuer !== context.issuer ||
    (context.iss === undefined ? issRequired : context.iss !== context.issuer)
  ) {
    throw new Error(PROVIDER_MISMATCH);
  }
}

/**
 * Check the homeserver's provider endpoints against the issuer's own discovery document.
 *
 * Matrix makes the homeserver the metadata source and does not require the issuer to
 * publish a document of its own, so when none can be fetched this passes and
 * {@link checkIssuer} is the whole check.
 *
 * Limit: the homeserver picks the issuer, so this stops only a verbatim issuer copy;
 * a provider that sends RFC 9207 `iss` closes the rest.
 */
export async function checkIssuerDiscovery(
  metadata: ValidatedAuthMetadata,
): Promise<void> {
  const own = await issuerDiscovery(metadata.issuer);
  if (
    own &&
    (!sameUrl(own['authorization_endpoint'], metadata.authorization_endpoint) ||
      !sameUrl(own['token_endpoint'], metadata.token_endpoint) ||
      (own['revocation_endpoint'] !== undefined &&
        !sameUrl(own['revocation_endpoint'], metadata.revocation_endpoint)))
  ) {
    throw new Error(PROVIDER_MISMATCH);
  }
}

/**
 * Whether two endpoint values name the same URL once parsed, so scheme and host case and
 * a default port do not count as a difference. Anything that does not parse is a
 * mismatch. The issuer is not compared this way: RFC 8414 section 3.3 and RFC 9207
 * section 2.4 require it to match exactly.
 */
function sameUrl(a: unknown, b: string): boolean {
  if (typeof a !== 'string') {
    return false;
  }
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

/**
 * The issuer's own metadata: RFC 8414 first, then OpenID Connect Discovery. A document
 * that names another issuer is not used (RFC 8414 section 3.3). Null when neither is usable.
 */
async function issuerDiscovery(
  issuer: string,
): Promise<Record<string, unknown> | null> {
  for (const url of discoveryUrls(issuer)) {
    const doc = await getJson(url);
    if (doc?.['issuer'] === issuer) {
      return doc;
    }
  }
  return null;
}

/**
 * RFC 8414 section 3.1 inserts the well-known segment between host and path, dropping a
 * terminating "/"; OpenID Connect Discovery 1.0 section 4 appends it to the issuer.
 */
function discoveryUrls(issuer: string): string[] {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return [];
  }
  const path = url.pathname.replace(/\/$/, '');
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      credentials: 'omit',
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    const body: unknown = res.ok ? await res.json() : null;
    return body !== null && typeof body === 'object'
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
