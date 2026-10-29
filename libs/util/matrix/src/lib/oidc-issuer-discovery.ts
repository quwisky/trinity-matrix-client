/** Shown when the callback or the homeserver names a provider other than the one signed in with. */
export const OIDC_PROVIDER_MISMATCH =
  "Sign-in could not be completed with this server's sign-in provider. Try again.";
/** The issuer's own discovery is a side check; an unresponsive host must not hold the callback. */
const DISCOVERY_TIMEOUT_MS = 8_000;

/** The provider fields of a homeserver's auth metadata that these checks compare. */
export interface OidcProviderMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly revocation_endpoint: string;
  readonly device_authorization_endpoint?: string;
}

/** The token endpoint, and the revocation and device endpoints when they are usable. */
export interface VerifiedEndpoints {
  tokenEndpoint: string;
  revocationEndpoint?: string;
  deviceAuthorizationEndpoint?: string;
}

/**
 * Check the homeserver's provider endpoints against the issuer's own discovery document,
 * and return the endpoints it confirms. A revocation or device endpoint it omits is the
 * homeserver's when that is on the issuer's own origin, else none.
 *
 * Matrix makes the homeserver the metadata source and does not require the issuer to
 * publish a document of its own, so when none can be fetched (none published, or the
 * fetch failed) this passes, returns null and {@link checkIssuer} is the whole check.
 *
 * Limit: the homeserver picks the issuer, so this stops only a verbatim issuer copy;
 * a provider that sends RFC 9207 `iss` closes the rest.
 */
export async function checkIssuerDiscovery(
  metadata: OidcProviderMetadata,
): Promise<VerifiedEndpoints | null> {
  const own = await issuerDiscovery(metadata.issuer);
  if (!own) {
    return null;
  }
  const tokenEndpoint = own['token_endpoint'];
  const revocationEndpoint = own['revocation_endpoint'];
  const deviceEndpoint = own['device_authorization_endpoint'];
  const servedDeviceEndpoint = metadata.device_authorization_endpoint;
  if (
    !isSameUrl(
      own['authorization_endpoint'],
      metadata.authorization_endpoint,
    ) ||
    !isSameUrl(tokenEndpoint, metadata.token_endpoint) ||
    (revocationEndpoint !== undefined &&
      !isSameUrl(revocationEndpoint, metadata.revocation_endpoint))
  ) {
    throw new Error(OIDC_PROVIDER_MISMATCH);
  }
  let deviceAuthorizationEndpoint: string | undefined;
  if (servedDeviceEndpoint !== undefined) {
    if (deviceEndpoint === undefined) {
      deviceAuthorizationEndpoint = onIssuerOrigin(
        servedDeviceEndpoint,
        metadata,
      );
    } else if (isSameUrl(deviceEndpoint, servedDeviceEndpoint)) {
      deviceAuthorizationEndpoint = deviceEndpoint;
    } else {
      throw new Error(OIDC_PROVIDER_MISMATCH);
    }
  }
  return endpoints({
    tokenEndpoint,
    revocationEndpoint:
      revocationEndpoint ??
      onIssuerOrigin(metadata.revocation_endpoint, metadata),
    deviceAuthorizationEndpoint,
  });
}

/**
 * The endpoints the issuer's own document confirms when it serves one. Otherwise, unless
 * `requireDocument`, the homeserver's, accepted only on the issuer's own origin: the token
 * endpoint must be, and a revocation or device endpoint elsewhere is left out. Throws
 * when the document disagrees, or when a required or unconfirmed token endpoint is missing.
 */
export async function verifiedEndpoints(
  metadata: OidcProviderMetadata,
  requireDocument = false,
): Promise<VerifiedEndpoints> {
  const confirmed = await checkIssuerDiscovery(metadata);
  if (confirmed) {
    return confirmed;
  }
  const tokenEndpoint = onIssuerOrigin(metadata.token_endpoint, metadata);
  if (requireDocument || !tokenEndpoint) {
    throw new Error(OIDC_PROVIDER_MISMATCH);
  }
  return endpoints({
    tokenEndpoint,
    revocationEndpoint: onIssuerOrigin(metadata.revocation_endpoint, metadata),
    deviceAuthorizationEndpoint: onIssuerOrigin(
      metadata.device_authorization_endpoint,
      metadata,
    ),
  });
}

/**
 * The homeserver's metadata with the token and device endpoints the device grant may use.
 * Throws when either is not verified, so neither the device code request nor the token
 * poll goes to an endpoint the issuer has not confirmed.
 */
export async function verifiedDeviceGrantMetadata<
  M extends OidcProviderMetadata,
>(metadata: M): Promise<M> {
  const { tokenEndpoint, deviceAuthorizationEndpoint } =
    await verifiedEndpoints(metadata);
  if (!deviceAuthorizationEndpoint) {
    throw new Error(OIDC_PROVIDER_MISMATCH);
  }
  return {
    ...metadata,
    token_endpoint: tokenEndpoint,
    device_authorization_endpoint: deviceAuthorizationEndpoint,
  };
}

/** Leaves out the endpoints that are not usable. */
function endpoints({
  tokenEndpoint,
  revocationEndpoint,
  deviceAuthorizationEndpoint,
}: {
  tokenEndpoint: string;
  revocationEndpoint: string | undefined;
  deviceAuthorizationEndpoint: string | undefined;
}): VerifiedEndpoints {
  return {
    tokenEndpoint,
    ...(revocationEndpoint ? { revocationEndpoint } : {}),
    ...(deviceAuthorizationEndpoint ? { deviceAuthorizationEndpoint } : {}),
  };
}

/** `url` when its scheme, host and port are the issuer's, else undefined. */
function onIssuerOrigin(
  url: string | undefined,
  metadata: OidcProviderMetadata,
): string | undefined {
  try {
    const origin = url === undefined ? undefined : new URL(url).origin;
    // A URL without a host has the opaque origin "null", which equals every other.
    return origin !== undefined &&
      origin !== 'null' &&
      origin === new URL(metadata.issuer).origin
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether two endpoint values name the same URL once parsed, so scheme and host case and
 * a default port do not count as a difference. Anything that does not parse is a
 * mismatch. The issuer is not compared this way: RFC 8414 section 3.3 and RFC 9207
 * section 2.4 require it to match exactly.
 */
export function isSameUrl(a: unknown, b: string): a is string {
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
