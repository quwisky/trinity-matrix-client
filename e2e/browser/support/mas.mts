import { expect, type APIRequestContext, type Page } from '../../fixtures.mts';
import {
  fillLabeledInput,
  waitForRooms,
  webNavigate,
} from '../../support/app.mts';
import type { AuthPlatform } from '../../support/platform-contracts.mts';
import type { HomeserverSessionDescriptor } from '../../support/session.mts';

/** The seeded account on the opt-in MAS stack (TRINITY_E2E_MAS=1). */
export type MasAccount = NonNullable<HomeserverSessionDescriptor['mas']>;

export interface MasEndpoints {
  readonly authorization: string;
  readonly token: string;
  readonly revocation: string;
}

export interface MasTokenResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
}

/** The provider endpoints, read the way the app reads them: from the homeserver. */
export async function masEndpoints(
  request: APIRequestContext,
  account: MasAccount,
): Promise<MasEndpoints> {
  const response = await request.get(
    `${account.hs}/_matrix/client/v1/auth_metadata`,
  );
  expect(response.ok()).toBe(true);
  const metadata = (await response.json()) as Record<string, string>;
  return {
    authorization: metadata['authorization_endpoint'],
    token: metadata['token_endpoint'],
    revocation: metadata['revocation_endpoint'],
  };
}

/** Sign in, or add the account to a signed-in app, through MAS's login and consent pages. */
export async function signInWithMas(
  page: Page,
  authPlatform: AuthPlatform,
  account: MasAccount,
  mode: 'first' | 'add' = 'first',
): Promise<void> {
  if (mode === 'add') {
    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('add-account').click();
    await expect(page.getByTestId('cancel-add')).toBeVisible();
  } else {
    await webNavigate(page, '/login');
  }
  await fillLabeledInput(page, 'Homeserver', account.hs);
  await page.getByText('Continue', { exact: true }).click();
  const start = page.getByTestId('oidc-continue');
  await expect(start).toBeVisible({ timeout: 30_000 });
  const provider = await authPlatform.waitForExternalPage(page, () =>
    start.click(),
  );
  // MAS 1.26.0 templates: pages/login.html (inputs `username`, `password`) and
  // pages/consent.html at /consent/{grant_id}; both submit with "Continue".
  await provider.locator('input[name="username"]').fill(account.user);
  await provider.locator('input[name="password"]').fill(account.pass);
  await provider.getByRole('button', { name: 'Continue' }).click();
  await provider.waitForURL(/\/consent\//, { timeout: 30_000 });
  await provider.getByRole('button', { name: 'Continue' }).click();
  await waitForRooms(page, 90_000);
}

/**
 * Record the OAuth and Matrix traffic the MAS journeys assert on. Tokens stay in memory
 * and are only ever compared, never printed.
 */
export function trackMasTraffic(
  page: Page,
  account: MasAccount,
  endpoints: MasEndpoints,
) {
  const refreshGrants: URLSearchParams[] = [];
  const tokenResponses: MasTokenResponse[] = [];
  const revocations: string[] = [];
  const logoutCalls: string[] = [];
  const syncs: { authorization: string | undefined; status: number }[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const url = request.url();
    const form = new URLSearchParams(request.postData() ?? '');
    if (url === endpoints.token && form.get('grant_type') === 'refresh_token') {
      refreshGrants.push(form);
    }
    if (url === endpoints.revocation) {
      revocations.push(form.get('token_type_hint') ?? '');
    }
    if (url.startsWith(`${account.hs}/_matrix/client/`)) {
      const path = new URL(url).pathname;
      if (/\/logout(\/all)?$/.test(path)) logoutCalls.push(path);
    }
  });
  page.on('response', (response) => {
    const request = response.request();
    if (
      request.method() === 'POST' &&
      request.url() === endpoints.token &&
      response.ok()
    ) {
      void response
        .json()
        .then((body: MasTokenResponse) => tokenResponses.push(body));
    }
    if (request.url().startsWith(`${account.hs}/_matrix/client/v3/sync`)) {
      syncs.push({
        authorization: request.headers()['authorization'],
        status: response.status(),
      });
    }
  });
  return {
    refreshGrants,
    tokenResponses,
    revocations,
    logoutCalls,
    syncs,
    /** The access token MAS issued last (code exchange or refresh). */
    async latestAccessToken(): Promise<string> {
      await expect.poll(() => tokenResponses.length).toBeGreaterThan(0);
      return tokenResponses[tokenResponses.length - 1].access_token;
    },
  };
}
