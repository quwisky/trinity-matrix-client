import { randomBytes } from 'node:crypto';
import {
  expect,
  type APIRequestContext,
  type Browser,
  type Page,
} from '@playwright/test';
import {
  fillLabeledInput,
  type SsoAccount,
  type SynapseSession,
} from './app.mts';

// Helpers for the harness's SSO account — a Matrix user Synapse created through the
// throwaway Dex provider (e2e/synapse/dex.yaml), and which therefore has no password.
//
// That is the point of it. Trinity's password user-interactive auth can never be
// satisfied by such an account, which is the only way to drive the "your identity
// provider has to do this" path against a real homeserver instead of a mock.

/** Where the app under test is served; must stay in step with `playwright.config.mts`. */
const APP_ORIGIN = process.env['BASE_URL'] ?? 'http://localhost:4200';

/**
 * Answer Dex's own login form.
 *
 * Selecting on Dex's element ids rather than on labels is deliberate: this is our
 * provider, pinned to one image tag, so its markup is a fixed contract — and unlike the
 * app's own screens, its copy is not ours to keep in step.
 */
async function answerDexForm(page: Page, sso: SsoAccount): Promise<void> {
  const email = page.locator('#login');
  await email.waitFor({ state: 'visible', timeout: 30_000 });
  await email.fill(sso.email);
  await page.locator('#password').fill(sso.pass);
  await page.locator('#submit-login').click();
}

/** Sign in to the app as the SSO account: homeserver → Continue with SSO → Dex → /rooms. */
export async function ssoLogin(page: Page, s: SynapseSession): Promise<void> {
  await page.goto('/login', { waitUntil: 'networkidle' });
  await fillLabeledInput(page, 'Homeserver', s.hs as string);
  await page.getByText('Continue', { exact: true }).click();
  const ssoButton = page.getByRole('button', { name: 'Continue with SSO' });
  await ssoButton.waitFor({ state: 'visible', timeout: 30_000 });
  await ssoButton.click();
  await answerDexForm(page, s.sso as SsoAccount);
  // The Dex round-trip adds a provider page and two redirects to an already slow first
  // login (Rust-crypto init + first /sync), so this gets more room than a password one.
  await page.waitForURL('**/rooms', { timeout: 60_000 });
}

/**
 * A single-use `loginToken` for the SSO account, obtained the only way one can be: by
 * completing a real SSO round-trip in a throwaway browser context.
 *
 * Returned unspent, so a caller can hand it to the app and then check whether the app
 * consumed it. The redirect target is a path the app does not route
 * (`/sso-harness-callback`) rather than the real callback, so nothing exchanges it on the
 * way past. It still has to sit under the app's origin — Synapse refuses to hand a login
 * token to any URL outside `sso.client_whitelist`.
 */
export async function ssoLoginToken(
  browser: Browser,
  s: SynapseSession,
): Promise<string> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    // Held on an object rather than in a local: the assignment happens inside a listener,
    // which control-flow analysis cannot see, so a bare `let` reads as permanently null.
    const captured: { token: string | null } = { token: null };
    page.on('request', (req) => {
      const match = /[?&]loginToken=([^&]+)/.exec(req.url());
      if (match) {
        captured.token = decodeURIComponent(match[1]);
      }
    });
    const redirectUrl = encodeURIComponent(
      `${APP_ORIGIN}/sso-harness-callback`,
    );
    await page.goto(
      `${s.hs}/_matrix/client/v3/login/sso/redirect?redirectUrl=${redirectUrl}`,
      { waitUntil: 'domcontentloaded' },
    );
    await answerDexForm(page, s.sso as SsoAccount);
    await expect.poll(() => captured.token, { timeout: 60_000 }).not.toBeNull();
    if (!captured.token) {
      throw new Error('the provider round-trip produced no login token');
    }
    return captured.token;
  } finally {
    await context.close();
  }
}

/** Exchange a `loginToken` for a session, as the app's callback route does. */
export async function redeemLoginToken(
  request: APIRequestContext,
  hs: string,
  loginToken: string,
): Promise<{ userId: string; accessToken: string }> {
  const res = await request.post(`${hs}/_matrix/client/v3/login`, {
    data: { type: 'm.login.token', token: loginToken },
  });
  if (!res.ok()) {
    throw new Error(`sso token login → ${res.status()} ${await res.text()}`);
  }
  const body = await res.json();
  return {
    userId: body.user_id as string,
    accessToken: body.access_token as string,
  };
}

export async function ssoApiSession(
  browser: Browser,
  request: APIRequestContext,
  s: SynapseSession,
): Promise<{ userId: string; accessToken: string }> {
  return redeemLoginToken(
    request,
    s.hs as string,
    await ssoLoginToken(browser, s),
  );
}

/**
 * Make sure the account has a cross-signing identity, creating one if it has none.
 *
 * Without this the reset under test proves nothing. Synapse skips user-interactive auth
 * for a user's *first* cross-signing upload (MSC3967, unconditional in the pinned
 * v1.119.0 — read the servlet, not the changelog), so a reset on a virgin account
 * succeeds outright and never reaches the branch the spec exists to cover. Once an
 * identity exists, replacing it needs UIA, and a password-less account is offered only
 * `m.login.sso` — which is the whole scenario.
 *
 * Idempotent, because it has to survive a Playwright retry against an account the
 * previous attempt already seeded: the key it uploads is never replaced, only created.
 */
export async function ensureCrossSigning(
  request: APIRequestContext,
  hs: string,
  { userId, accessToken }: { userId: string; accessToken: string },
): Promise<void> {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const existing = await request
    .post(`${hs}/_matrix/client/v3/keys/query`, {
      headers,
      data: { device_keys: { [userId]: [] } },
    })
    .then((r) => r.json());
  if (existing.master_keys?.[userId]) {
    return;
  }

  // A well-formed master key nobody holds the private half of. Nothing here signs
  // anything — the account only has to *have* an identity for UIA to start applying.
  const key = randomBytes(32).toString('base64').replace(/=+$/, '');
  const res = await request.post(
    `${hs}/_matrix/client/v3/keys/device_signing/upload`,
    {
      headers,
      data: {
        master_key: {
          user_id: userId,
          usage: ['master'],
          keys: { [`ed25519:${key}`]: key },
        },
      },
    },
  );
  if (!res.ok()) {
    throw new Error(
      `seeding cross-signing → ${res.status()} ${await res.text()}`,
    );
  }
}
