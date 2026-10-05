import { test, expect, testResourceId, type Page } from '../../../fixtures.mts';
import {
  fillLabeledInput,
  homeserverSession,
  login,
} from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';

// iOS WebKit zooms the page when a focused text field computes below 16px (#974), so on
// touch devices (`pointer: coarse`) every text-entry control resolves to at least 16px,
// while a fine pointer keeps the compact desktop sizes. Chromium reports
// `pointer: coarse` for a context that is both `isMobile` and `hasTouch`; the media query
// itself is asserted so the premise cannot silently stop holding.
const session = homeserverSession();
const FLOOR = 16;

const sizeOf = (page: Page, label: string) =>
  page
    .getByLabel(label, { exact: true })
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

/** Sign in, reading the login fields' sizes on the way, and open a fresh room. */
async function signInAndOpenRoom(
  page: Page,
  request: Parameters<typeof registerUser>[0],
) {
  const hs = session.hs as string;
  const user = `entry-size-${testResourceId('run')}`;
  const pass = `${user}-pass`;
  await registerUser(request, user, pass);
  const account = await passwordLogin(request, hs, user, pass);
  const roomName = `Entry size ${user}`;
  await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers: { Authorization: `Bearer ${account.accessToken}` },
    data: { name: roomName },
  });

  await page.goto('/login');
  const coarse = await page.evaluate(
    () => matchMedia('(pointer: coarse)').matches,
  );
  await fillLabeledInput(page, 'Homeserver', hs);
  const homeserver = await sizeOf(page, 'Homeserver');
  await page.getByText('Continue', { exact: true }).click();
  await fillLabeledInput(page, 'Username', user);
  const username = await sizeOf(page, 'Username');

  await login(page, { ...session, user, pass });
  const channel = page.locator('.channel', { hasText: roomName }).first();
  await channel.click();
  const composer = page.getByTestId('composer-input');
  await composer.waitFor({ timeout: 30_000 });
  const composerSize = await composer.evaluate((el) =>
    parseFloat(getComputedStyle(el).fontSize),
  );
  return { coarse, homeserver, username, composer: composerSize };
}

test.describe('Text-entry font size', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test.describe('on a touch device', () => {
    test.use({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });

    test('never computes below 16px', async ({ page, request }) => {
      const sizes = await signInAndOpenRoom(page, request);
      expect(sizes.coarse).toBe(true);
      expect(sizes.homeserver).toBeGreaterThanOrEqual(FLOOR);
      expect(sizes.username).toBeGreaterThanOrEqual(FLOOR);
      expect(sizes.composer).toBeGreaterThanOrEqual(FLOOR);
    });
  });

  test.describe('with a fine pointer', () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test('keeps the compact desktop sizes', async ({ page, request }) => {
      const sizes = await signInAndOpenRoom(page, request);
      expect(sizes.coarse).toBe(false);
      expect(sizes.homeserver).toBeLessThan(FLOOR);
      expect(sizes.username).toBeLessThan(FLOOR);
      expect(sizes.composer).toBe(15);
    });
  });
});
