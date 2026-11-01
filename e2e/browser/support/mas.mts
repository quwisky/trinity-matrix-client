import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, type APIRequestContext, type Page } from '../../fixtures.mts';
import {
  fillLabeledInput,
  settleSignIn,
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

const exec = promisify(execFile);

/**
 * A fresh account on the MAS stack, for a journey that consumes it (deletion). Seeded the
 * way start.mjs seeds the shared one: through MAS's CLI in its container
 * (`container_name` in e2e/support/homeserver/mas/docker-compose.yml).
 */
export async function registerMasUser(
  account: MasAccount,
  user: string,
): Promise<MasAccount> {
  const pass = `${user}-pass`;
  await exec('docker', [
    'exec',
    'trinity-e2e-mas',
    'mas-cli',
    'manage',
    'register-user',
    '--yes',
    '--ignore-password-complexity',
    '--password',
    pass,
    user,
  ]);
  await provisioned();
  return { ...account, user, pass };
}

/**
 * Resolve once MAS has no provisioning or device sync left to run. register-user queues
 * both: the sync deletes every homeserver device MAS has no session for, so one that
 * lands while `mas-cli manage issue-compatibility-token` is between creating its device
 * and committing its session deletes that device, and the token is "not active".
 */
async function provisioned(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { stdout } = await exec('docker', [
      'exec',
      'trinity-e2e-mas-db',
      'psql',
      '-U',
      'mas',
      '-d',
      'mas',
      '-tAc',
      // MAS 1.26's job queue (crates/storage-pg/migrations/*queue_job*.sql). Re-check the
      // queue names and statuses on a MAS upgrade: a renamed one would make this count 0.
      "SELECT count(*) FROM queue_jobs WHERE queue_name IN ('provision-user', 'sync-devices') AND status IN ('available', 'scheduled', 'running')",
    ]);
    if (stdout.trim() === '0') return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('MAS did not finish provisioning in 30 s');
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
  const metadata = (await response.json()) as Record<string, unknown>;
  const endpoint = (key: string): string => {
    const value = metadata[key];
    // An undefined endpoint would make every URL comparison below quietly never match.
    expect(
      typeof value === 'string' && value !== '',
      `${key} is advertised`,
    ).toBe(true);
    return value as string;
  };
  return {
    authorization: endpoint('authorization_endpoint'),
    token: endpoint('token_endpoint'),
    revocation: endpoint('revocation_endpoint'),
  };
}

/** From a signed-in app, open the login page that adds another account. */
export async function openAddAccount(page: Page): Promise<void> {
  await page.getByTestId('user-menu-trigger').click();
  await page.getByTestId('add-account').click();
  await expect(page.getByTestId('cancel-add')).toBeVisible();
}

/** Sign in, or add the account to a signed-in app, through MAS's login and consent pages. */
export async function signInWithMas(
  page: Page,
  authPlatform: AuthPlatform,
  account: MasAccount,
  mode: 'first' | 'add' = 'first',
): Promise<void> {
  if (mode === 'add') {
    await openAddAccount(page);
  } else {
    await webNavigate(page, '/login');
  }
  await fillLabeledInput(page, 'Homeserver', account.hs);
  await page.getByText('Continue', { exact: true }).click();
  await completeMasSignIn(page, authPlatform, account);
}

/**
 * From a page that offers the provider step (the sign-in form after discovery, or a
 * re-auth), continue to MAS, sign in and consent there, and wait for the app to settle.
 */
export async function completeMasSignIn(
  page: Page,
  authPlatform: AuthPlatform,
  account: MasAccount,
): Promise<void> {
  const start = page.getByTestId('oidc-continue');
  await expect(start).toBeVisible({ timeout: 30_000 });
  const provider = await authPlatform.waitForExternalPage(page, () =>
    start.click(),
  );
  // MAS 1.28.0 templates: pages/login.html (inputs `username`, `password`) and
  // pages/consent.html at /consent/{grant_id}; both submit with "Continue".
  await provider.locator('input[name="username"]').fill(account.user);
  await provider.locator('input[name="password"]').fill(account.pass);
  await provider.getByRole('button', { name: 'Continue' }).click();
  await provider.waitForURL(/\/consent\//, { timeout: 30_000 });
  await provider.getByRole('button', { name: 'Continue' }).click();
  await settleSignIn(page, 'skip-if-shown', 90_000);
}

export interface MasTraffic {
  /** Form bodies of the `grant_type=refresh_token` requests to the token endpoint. */
  readonly refreshGrants: URLSearchParams[];
  /** Successful token endpoint responses, in arrival order: code exchange, then refreshes. */
  readonly tokenResponses: MasTokenResponse[];
  /** `token_type_hint` of every revocation request, in request order. */
  readonly revocations: string[];
  /** Paths of any `POST /logout` or `/logout/all` sent to the homeserver. */
  readonly logoutCalls: string[];
  /** The `/sync` responses: the bearer token each request carried, and its status. */
  readonly syncs: { authorization: string | undefined; status: number }[];
  /** The OAuth client id, read from the first POST to the token endpoint. */
  readonly clientId: string | undefined;
  /** The access token MAS issued last (code exchange or refresh). */
  latestAccessToken(): Promise<string>;
}

/**
 * Record the OAuth and Matrix traffic the MAS journeys assert on. Tokens stay in memory
 * and are only ever compared, never printed.
 */
export function trackMasTraffic(
  page: Page,
  account: MasAccount,
  endpoints: MasEndpoints,
): MasTraffic {
  const refreshGrants: URLSearchParams[] = [];
  const tokenResponses: MasTokenResponse[] = [];
  const revocations: string[] = [];
  const logoutCalls: string[] = [];
  const syncs: { authorization: string | undefined; status: number }[] = [];
  let clientId: string | undefined;
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const url = request.url();
    const form = new URLSearchParams(request.postData() ?? '');
    if (url === endpoints.token)
      clientId ??= form.get('client_id') ?? undefined;
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
      // A body that is gone (the page navigated away) must not become an unhandled rejection.
      void response
        .json()
        .then((body: MasTokenResponse) => tokenResponses.push(body))
        .catch(() => undefined);
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
    get clientId() {
      return clientId;
    },
    async latestAccessToken(): Promise<string> {
      await expect.poll(() => tokenResponses.length).toBeGreaterThan(0);
      return tokenResponses[tokenResponses.length - 1].access_token;
    },
  };
}
