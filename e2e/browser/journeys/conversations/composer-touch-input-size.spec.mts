import { test, expect, testResourceId, type Page } from '../../../fixtures.mts';
import {
  fillLabeledInput,
  homeserverSession,
  login,
} from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';
import { DESIGN_VIEWPORTS } from '../../support/design-viewports.mts';
import {
  closeSettings,
  openSettingsSection,
} from '../../../support/journeys/navigation.mts';

// iOS WebKit zooms the page when a focused text field computes below 16px (#974), so on
// touch devices (`pointer: coarse`) every text-entry control resolves to at least 16px,
// while a fine pointer keeps the compact desktop sizes. Chromium reports
// `pointer: coarse` for a context that is both `isMobile` and `hasTouch`; the media query
// itself is asserted so the premise cannot silently stop holding.
const session = homeserverSession();
const FLOOR = 16;
// Tolerance for the sub-pixel rounding of a rem-derived computed size.
const EPSILON = 0.1;

/** Pick an option from one of the Appearance selects (a CDK overlay). */
async function choose(page: Page, select: string, option: string) {
  await page.getByTestId(select).locator('button').first().click();
  const item = page.getByTestId(option);
  await item.waitFor({ state: 'visible', timeout: 15_000 });
  await item.click();
  await expect(item).toHaveCount(0);
}

const sizeOf = (page: Page, label: string) =>
  page
    .getByLabel(label, { exact: true })
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

/** Sign in, reading the login fields' sizes on the way, and open a fresh room. */
async function signInAndOpenRoom(
  page: Page,
  request: Parameters<typeof registerUser>[0],
  textScale?: { rootPercent: string; option: string },
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
  // The login page has no Settings, so the root percentage the Text size setting writes is
  // applied directly; the room below uses the real Appearance control.
  if (textScale) {
    await page.evaluate((percent) => {
      document.documentElement.style.fontSize = percent;
    }, textScale.rootPercent);
  }
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
  if (textScale) {
    // On a phone the room list, and with it Settings, is behind "Back to rooms".
    await page.getByRole('button', { name: 'Back to rooms' }).click();
    await openSettingsSection(page, 'appearance');
    await choose(page, 'text-scale-select', textScale.option);
    await closeSettings(page);
    await channel.click();
    await expect(composer).toBeVisible();
  }
  const composerSize = await composer.evaluate((el) =>
    parseFloat(getComputedStyle(el).fontSize),
  );
  // The voice-recording bar sits at the resting field height; it must follow the entry size
  // so the two stay equal. Opening the bar needs a microphone, so the variable is checked
  // against the field it stands in for.
  const resting = await composer.evaluate((el) => {
    const field = el.closest('.composer__field') as HTMLElement;
    const probe = document.createElement('div');
    probe.style.height = 'var(--composer-resting-field-height)';
    field.parentElement?.append(probe);
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    return { height, field: field.getBoundingClientRect().height };
  });
  return { coarse, homeserver, username, composer: composerSize, resting };
}

test.describe('Text-entry font size', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test.describe('on a touch device', () => {
    test.use(DESIGN_VIEWPORTS['phone-pixel-5']);

    test('never computes below 16px', async ({ page, request }) => {
      const sizes = await signInAndOpenRoom(page, request);
      expect(sizes.coarse).toBe(true);
      expect(sizes.homeserver).toBeGreaterThanOrEqual(FLOOR);
      expect(sizes.username).toBeGreaterThanOrEqual(FLOOR);
      expect(sizes.composer).toBeGreaterThanOrEqual(FLOOR);
      expect(sizes.resting.height).toBeCloseTo(sizes.resting.field, 0);
    });

    test('keeps the 16px floor at Small text size', async ({
      page,
      request,
    }) => {
      const sizes = await signInAndOpenRoom(page, request, {
        rootPercent: '87.5%',
        option: 'text-scale-small',
      });
      expect(sizes.coarse).toBe(true);
      expect(sizes.homeserver).toBeGreaterThanOrEqual(FLOOR);
      expect(sizes.username).toBeGreaterThanOrEqual(FLOOR);
      expect(sizes.composer).toBeGreaterThanOrEqual(FLOOR);
      expect(sizes.resting.height).toBeCloseTo(sizes.resting.field, 0);
    });

    test('still scales up at Larger text size', async ({ page, request }) => {
      const sizes = await signInAndOpenRoom(page, request, {
        rootPercent: '125%',
        option: 'text-scale-larger',
      });
      // 125% of the 16px root is a 20px rem; the composer's own 15px (18.75px) never wins
      // over the scaled floor, and a control is no smaller than a 16px field scaled the same.
      expect(sizes.homeserver).toBeGreaterThanOrEqual(20 - EPSILON);
      expect(sizes.username).toBeGreaterThanOrEqual(20 - EPSILON);
      expect(sizes.composer).toBeGreaterThanOrEqual(18.75 - EPSILON);
      expect(sizes.resting.height).toBeCloseTo(sizes.resting.field, 0);
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
