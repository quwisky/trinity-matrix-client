import { test, expect } from '../fixtures.mts';
import {
  fillLabeledInput,
  synapseSession,
  waitForRooms,
} from '../support/app.mts';
import { redeemLoginToken, ssoLoginToken } from './support/sso.mts';

// End-to-end for signing in through an identity provider, against the harness's own Dex
// (see e2e/support/synapse/dex.yaml) rather than a mocked one.
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
    authPlatform,
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

    const providerPage = await authPlatform.waitForExternalPage(page, () =>
      ssoButton.click(),
    );

    // Dex's own form — our provider, pinned to one image, so its ids are a contract.
    await providerPage
      .locator('#login')
      .waitFor({ state: 'visible', timeout: 30_000 });
    await providerPage.locator('#login').fill(sso.email);
    await providerPage.locator('#password').fill(sso.pass);
    await providerPage.locator('#submit-login').click();

    await waitForRooms(page, 60_000);

    // The session is real and persisted, not just a routing side effect: a reload has to
    // land back in the app rather than at /login.
    await page.reload();
    await waitForRooms(page, 60_000);
    await expect(page.getByTestId('rail-rooms')).toBeVisible({
      timeout: 30_000,
    });
  });

  test('refuses a callback it cannot verify, and does not spend the token', async ({
    page,
    authPlatform,
    request,
  }) => {
    // Anyone can navigate to the callback route — and on native, any app can fire the
    // shared `eu.qwky.trinity://` deep link. A token arriving without a sign-in this app
    // started must not become a session.
    const hs = session.hs as string;
    const stolen = await ssoLoginToken(authPlatform, session);

    await authPlatform.navigateCallback(
      page,
      callback(`loginToken=${encodeURIComponent(stolen)}&sso_state=forged`),
      'sso',
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
    authPlatform,
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
    const stolen = await ssoLoginToken(authPlatform, session);

    // Start a real sign-in, which stashes the state, and stop at the provider.
    await page.goto('/login', { waitUntil: 'networkidle' });
    await fillLabeledInput(page, 'Homeserver', hs);
    await page.getByText('Continue', { exact: true }).click();
    const firstProviderPage = await authPlatform.waitForExternalPage(page, () =>
      page.getByRole('button', { name: 'Continue with SSO' }).click(),
    );
    await firstProviderPage
      .locator('#login')
      .waitFor({ state: 'visible', timeout: 30_000 });

    // A forged callback lands while that stash is live.
    await authPlatform.navigateCallback(
      page,
      callback(`loginToken=${encodeURIComponent(stolen)}&sso_state=forged`),
      'sso',
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
    const wordmark = page.locator('.login-card__wordmark');
    await expect(wordmark).toBeVisible();
    await expect(wordmark).toHaveText('Trinity');
    await expect(page.getByRole('heading')).toHaveCount(1);
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Completing sign in',
      }),
    ).toHaveCount(1);
    const card = page.locator('.login-card');
    const cardBox = await card.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(cardBox!.width).toBeGreaterThanOrEqual(400);
    expect(cardBox!.width).toBeLessThanOrEqual(480);
    expect(cardBox!.x).toBeGreaterThanOrEqual(0);
    expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerWidth),
    );

    // Exactly one `main` landmark, and the body actually inset from the card's edge. The
    // first version of this page had neither: it projected past `trnCardContent`, so its
    // error text and button ran edge to edge, and the `<main>` the old bare page carried
    // was lost when the card took over the host.
    await expect(page.locator('main')).toHaveCount(1);
    const bodyBox = await page.getByTestId('sso-callback-body').boundingBox();
    expect(bodyBox).not.toBeNull();
    expect(bodyBox!.x).toBeGreaterThan(cardBox!.x + 8);
    await expect(page.getByText('could not be verified')).toHaveCount(0);
    expect(page.url()).not.toContain('/rooms');

    // …and the sign-in the user actually started still completes. It could not, if the
    // forged callback had consumed or cleared the stash.
    await page.goto('/login', { waitUntil: 'networkidle' });
    await fillLabeledInput(page, 'Homeserver', hs);
    await page.getByText('Continue', { exact: true }).click();
    const providerPage = await authPlatform.waitForExternalPage(page, () =>
      page.getByRole('button', { name: 'Continue with SSO' }).click(),
    );
    await providerPage
      .locator('#login')
      .waitFor({ state: 'visible', timeout: 30_000 });
    await providerPage.locator('#login').fill(sso.email);
    await providerPage.locator('#password').fill(sso.pass);
    await providerPage.locator('#submit-login').click();

    await waitForRooms(page, 60_000);
  });
});
