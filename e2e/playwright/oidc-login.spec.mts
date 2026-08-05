import { test, expect, type Page, type Route } from '@playwright/test';

// OIDC-native ("next-gen auth", MSC3861/MSC2965) login, against a FULLY MOCKED
// homeserver + provider. Unlike the other app-journey specs this needs no Synapse/MAS,
// so it does NOT self-skip on Docker absence — page.route stubs the homeserver's
// discovery + auth-metadata and the provider's registration + authorize endpoints, so
// the whole delegated login journey is deterministic and offline. The token exchange
// itself (a signed id_token bound to a runtime nonce) can't be mocked usefully, so the
// happy path is exercised up to the provider redirect; the callback is driven end-to-end
// via the provider-error path (which needs no id_token).

const HS_DOMAIN = 'oidc.example';
const HS_BASE = 'https://hs.oidc.example';
const REGISTRATION_ENDPOINT = 'https://provider.oidc.example/register';

// Valid MSC2965 metadata. No `jwks_uri`, so the SDK skips the JWKS fetch (see
// discovery.js) — keeping the mock minimal while still passing validation.
const AUTH_METADATA = {
  issuer: 'https://provider.oidc.example/',
  authorization_endpoint: 'https://provider.oidc.example/authorize',
  token_endpoint: 'https://provider.oidc.example/token',
  revocation_endpoint: 'https://provider.oidc.example/revoke',
  registration_endpoint: REGISTRATION_ENDPOINT,
  account_management_uri: 'https://provider.oidc.example/account',
  // Required by matrix-js-sdk 42's isValidAuthMetadata, which needs BOTH values. Omitting
  // it makes getAuthMetadata throw, so the app decides this homeserver is not OIDC at all
  // and this whole spec silently tests the password form instead.
  response_modes_supported: ['query', 'fragment'],
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  prompt_values_supported: ['create'],
};

// The app fetches these cross-origin; the DCR POST (Content-Type: application/json)
// triggers a CORS preflight, so answer OPTIONS and send permissive CORS on every reply.
const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': '*',
  'access-control-allow-headers': '*',
};

function json(route: Route, body: unknown, status = 200): Promise<void> {
  if (route.request().method() === 'OPTIONS') {
    return route.fulfill({ status: 204, headers: CORS });
  }
  return route.fulfill({
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Stub an OIDC-native homeserver's discovery + auth-metadata endpoints. */
async function mockOidcHomeserver(page: Page): Promise<void> {
  await page.route(/\/\.well-known\/matrix\/client/, (r) =>
    json(r, { 'm.homeserver': { base_url: HS_BASE } }),
  );
  await page.route(/hs\.oidc\.example\/_matrix\/client\/versions/, (r) =>
    json(r, { versions: ['v1.1', 'v1.15'], unstable_features: {} }),
  );
  // An OIDC-native server may not serve the legacy /login flows at all.
  await page.route(/hs\.oidc\.example\/_matrix\/client\/v3\/login/, (r) =>
    json(r, { flows: [] }),
  );
  await page.route(
    /hs\.oidc\.example\/_matrix\/client\/v1\/auth_metadata/,
    (r) => json(r, AUTH_METADATA),
  );
}

/** Enter a homeserver and run step-1 discovery. */
async function discover(page: Page, domain = HS_DOMAIN): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Homeserver').fill(domain);
  await page.getByText('Continue', { exact: true }).click();
}

test.describe('OIDC-native login', () => {
  test('offers the provider Continue + Create account and hides password/SSO', async ({
    page,
  }) => {
    await mockOidcHomeserver(page);
    await discover(page);

    // Delegated auth detected → the OIDC "Continue" + "Create account" buttons appear…
    await expect(page.getByTestId('oidc-continue')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId('oidc-register')).toBeVisible();
    // …and the legacy password/SSO options are suppressed (the provider owns credentials).
    await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /SSO/ })).toHaveCount(0);
  });

  test('builds a PKCE authorize request and surfaces a provider error on the callback', async ({
    page,
  }) => {
    await mockOidcHomeserver(page);
    // Dynamic client registration → issue a client id.
    await page.route(/provider\.oidc\.example\/register/, (r) =>
      json(r, { client_id: 'e2e-client-id' }, 201),
    );

    // Intercept the redirect to the provider's authorize endpoint: capture the PKCE
    // params, then send the browser back to the app as if the user declined consent.
    let authorizeUrl: URL | null = null;
    await page.route(/provider\.oidc\.example\/authorize/, async (route) => {
      authorizeUrl = new URL(route.request().url());
      const state = authorizeUrl.searchParams.get('state') ?? '';
      // Redirect back to the app's OWN registered callback (from the request), not an
      // origin derived from page.url() (which is the provider during this navigation).
      const redirectUri = authorizeUrl.searchParams.get('redirect_uri') ?? '';
      const back = `${redirectUri}?error=access_denied&error_description=${encodeURIComponent('E2E declined')}&state=${encodeURIComponent(state)}`;
      await route.fulfill({ status: 302, headers: { location: back } });
    });

    await discover(page);
    await page.getByTestId('oidc-continue').click();

    // Back on the callback with the provider error surfaced — reached only because the
    // returned OAuth state matched the durably-stashed one (CSRF check).
    await expect(page.getByText('E2E declined')).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByRole('button', { name: 'Back to sign in' }),
    ).toBeVisible();

    // The authorize request carried the expected PKCE + client params.
    expect(authorizeUrl).not.toBeNull();
    const params = (authorizeUrl as unknown as URL).searchParams;
    expect(params.get('client_id')).toBe('e2e-client-id');
    expect(params.get('response_type')).toBe('code');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toBeTruthy();
    expect(params.get('state')).toBeTruthy();
    expect(params.get('redirect_uri')).toContain('/sso-callback');
    // matrix-js-sdk 42 requests stable Matrix URNs and no longer asks for `openid`
    // (v41 sent `openid urn:matrix:org.matrix.msc2967.client:api:*`).
    expect(params.get('scope') ?? '').toContain('urn:matrix:client:api:*');
    expect(params.get('scope') ?? '').toContain('urn:matrix:client:device:');
    // Load-bearing: v42 defaults response_mode to `fragment`, and every callback reader in
    // this app parses query params only. Without this the code lands in the URL fragment
    // and login hangs on "Missing sign-in details".
    expect(params.get('response_mode')).toBe('query');
  });

  test('a non-OIDC homeserver still shows the password form', async ({
    page,
  }) => {
    await page.route(/\/\.well-known\/matrix\/client/, (r) =>
      json(r, { 'm.homeserver': { base_url: HS_BASE } }),
    );
    await page.route(/hs\.oidc\.example\/_matrix\/client\/versions/, (r) =>
      json(r, { versions: ['v1.1'], unstable_features: {} }),
    );
    await page.route(/hs\.oidc\.example\/_matrix\/client\/v3\/login/, (r) =>
      json(r, { flows: [{ type: 'm.login.password' }] }),
    );
    // No delegated auth: auth_metadata + the older auth_issuer both 404 (M_UNRECOGNIZED)
    // → getAuthMetadata throws → the detector resolves null.
    const unrecognized = (r: Route): Promise<void> =>
      json(
        r,
        { errcode: 'M_UNRECOGNIZED', error: 'Unrecognized request' },
        404,
      );
    await page.route(
      /hs\.oidc\.example\/_matrix\/client\/v1\/auth_metadata/,
      unrecognized,
    );
    await page.route(
      /_matrix\/client\/unstable\/org\.matrix\.msc2965/,
      unrecognized,
    );

    await discover(page);

    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId('oidc-continue')).toHaveCount(0);
  });
});
