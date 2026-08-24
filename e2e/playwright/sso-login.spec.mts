import { test, expect } from '@playwright/test';
import { fillLabeledInput, synapseSession } from './support/app.mts';
import { redeemLoginToken, ssoLoginToken } from './support/sso.mts';

// End-to-end for signing in through an identity provider, against the harness's own Dex
// (see e2e/synapse/dex.yaml) rather than a mocked one.
//
// `oidc-login.spec.mts` covers the MSC3861 "next-gen auth" screens with page.route stubs
// and needs no homeserver. This is the other half: the legacy SSO round-trip that a
// homeserver with an `oidc_provider` actually performs — Synapse owns the session and
// hands the app a single-use `loginToken` — plus the checks the callback route makes on
// that token before it will spend it. None of that had coverage; the reset specs drive
// the login only incidentally, so a break in it surfaced as a confusing failure in a
// spec about something else.
//
// Needs Docker; self-skips otherwise like the other web specs.
const session = synapseSession();

/** The callback the app routes, with whatever query a caller wants to arrive with. */
const callback = (query: string): string => `/sso-callback?${query}`;

test.describe('SSO sign-in', () => {
  test.skip(!session.available, 'needs the Synapse + Dex harness (Docker)');

  test('signs in through the provider and keeps the session', async ({
    page,
  }) => {
    const hs = session.hs as string;
    const sso = session.sso;
    if (!sso) {
      throw new Error('harness came up without an SSO account');
    }

    await page.goto('/login', { waitUntil: 'networkidle' });
    await fillLabeledInput(page, 'Homeserver', hs);
    await page.getByText('Continue', { exact: true }).click();

    // A homeserver that merely has an identity provider behind it is NOT a delegated-auth
    // homeserver: it must still offer password and SSO, and must not be mistaken for one
    // that owns credentials at the provider. Worth asserting against a real Synapse —
    // the mocked spec can only assert it against its own fixture.
    const ssoButton = page.getByRole('button', { name: 'Continue with SSO' });
    await expect(ssoButton).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByTestId('oidc-continue')).toHaveCount(0);

    await ssoButton.click();

    // Dex's own form — our provider, pinned to one image, so its ids are a contract.
    await page.locator('#login').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('#login').fill(sso.email);
    await page.locator('#password').fill(sso.pass);
    await page.locator('#submit-login').click();

    await page.waitForURL('**/rooms', { timeout: 60_000 });

    // The session is real and persisted, not just a routing side effect: a reload has to
    // land back in the app rather than at /login.
    await page.reload();
    await page.waitForURL('**/rooms', { timeout: 60_000 });
    await expect(page.getByTestId('rail-rooms')).toBeVisible({
      timeout: 30_000,
    });
  });

  test('refuses a callback it cannot verify, and does not spend the token', async ({
    page,
    browser,
    request,
  }) => {
    // Anyone can navigate to the callback route — and on native, any app can fire the
    // shared `eu.qwky.trinity://` deep link. A token arriving without a sign-in this app
    // started must not become a session.
    const hs = session.hs as string;
    const stolen = await ssoLoginToken(browser, session);

    await page.goto(
      callback(`loginToken=${encodeURIComponent(stolen)}&sso_state=forged`),
      { waitUntil: 'domcontentloaded' },
    );

    await expect(page.getByText('could not be verified')).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByRole('button', { name: 'Back to sign in' }),
    ).toBeVisible();
    expect(page.url()).not.toContain('/rooms');

    // The assertion that makes this more than a copy check: the token is still good, so
    // the app did not quietly exchange one it had just said it could not verify.
    const session2 = await redeemLoginToken(request, hs, stolen);
    expect(session2.userId).toBe(`@${session.sso?.user}:localhost`);
  });

  test('ignores a forged callback mid-sign-in without breaking the real one', async ({
    page,
    browser,
  }) => {
    // The subtle half of the rule: when a sign-in IS in flight, a mismatched callback has
    // to be met with silence rather than an error, and must not consume the stash — the
    // genuine callback is still coming. Getting this wrong turns any forged deep link
    // into a denial of service on a legitimate login.
    const hs = session.hs as string;
    const sso = session.sso;
    if (!sso) {
      throw new Error('harness came up without an SSO account');
    }
    const stolen = await ssoLoginToken(browser, session);

    // Start a real sign-in, which stashes the state, and stop at the provider.
    await page.goto('/login', { waitUntil: 'networkidle' });
    await fillLabeledInput(page, 'Homeserver', hs);
    await page.getByText('Continue', { exact: true }).click();
    await page.getByRole('button', { name: 'Continue with SSO' }).click();
    await page.locator('#login').waitFor({ state: 'visible', timeout: 30_000 });

    // A forged callback lands while that stash is live.
    await page.goto(
      callback(`loginToken=${encodeURIComponent(stolen)}&sso_state=forged`),
      { waitUntil: 'domcontentloaded' },
    );
    // The visible paragraph, not the sr-only <h1> that carries the same words.
    await expect(page.getByText('Completing sign in…')).toBeVisible({
      timeout: 30_000,
    });

    // And it lands on the SAME surface the sign-in started from. This leg used to be a
    // bare spinner on a centred <main> — no card, no wordmark, on the app's own
    // background — so coming back from a homeserver's SSO page looked like arriving
    // somewhere else, at the one moment a reader is unsure the redirect worked. jsdom
    // cannot see any of that, so the card's geometry is measured here.
    await expect(page.getByRole('heading', { name: 'Trinity' })).toBeVisible();
    const card = page.locator('.login-card');
    const cardBox = await card.boundingBox();
    expect(cardBox?.width).toBe(420);
    await expect(page.getByText('could not be verified')).toHaveCount(0);
    expect(page.url()).not.toContain('/rooms');

    // …and the sign-in the user actually started still completes. It could not, if the
    // forged callback had consumed or cleared the stash.
    await page.goto('/login', { waitUntil: 'networkidle' });
    await fillLabeledInput(page, 'Homeserver', hs);
    await page.getByText('Continue', { exact: true }).click();
    await page.getByRole('button', { name: 'Continue with SSO' }).click();
    await page.locator('#login').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('#login').fill(sso.email);
    await page.locator('#password').fill(sso.pass);
    await page.locator('#submit-login').click();

    await page.waitForURL('**/rooms', { timeout: 60_000 });
  });
});
