import type { APIRequestContext, Locator, Page } from '@playwright/test';
import {
  login,
  synapseSession,
  type SynapseSession,
  waitForRooms,
} from '../support/app.mts';
import { registerUser } from '../support/account.mts';
import { expect, test } from './fixtures.mts';

process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

const session = synapseSession();
let composerUser = '';
let composerPass = '';
let composerSession: SynapseSession;
let composerRoomName = '';

async function openNativeSettingsFromRooms(
  page: Page,
  activate: (control: Locator) => Promise<void>,
): Promise<void> {
  await expect(page).toHaveURL(
    (url) =>
      url.pathname.startsWith('/rooms') && url.searchParams.has('account'),
    { timeout: 20_000 },
  );

  await activate(page.getByTestId('open-settings'));
  await page.waitForURL(
    (url) =>
      url.pathname === '/settings' || url.pathname.startsWith('/settings/'),
    { timeout: 20_000 },
  );
  await expect(
    page.getByRole('heading', { name: 'Settings', exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByRole('navigation', { name: 'Settings sections' }),
  ).toBeVisible();
}

async function seedComposerRoom(request: APIRequestContext): Promise<void> {
  await registerUser(request, composerUser, composerPass);
  const loginResponse = await request.post(
    `${composerSession.hs}/_matrix/client/v3/login`,
    {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: composerUser },
        password: composerPass,
      },
    },
  );
  if (!loginResponse.ok()) {
    throw new Error(
      `Android room-seed login failed: ${loginResponse.status()} ${await loginResponse.text()}`,
    );
  }
  const { access_token: token } = (await loginResponse.json()) as {
    access_token: string;
  };
  const roomResponse = await request.post(
    `${composerSession.hs}/_matrix/client/v3/createRoom`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: composerRoomName },
    },
  );
  if (!roomResponse.ok()) {
    throw new Error(
      `Android room seed failed: ${roomResponse.status()} ${await roomResponse.text()}`,
    );
  }
}

test.describe('Android navigation', () => {
  test('@renderer-smoke logs in, opens settings by touch, and handles hardware Back', async ({
    app,
    page,
  }) => {
    await login(page, session, app.navigate);
    await openNativeSettingsFromRooms(page, (control) => app.touch(control));

    await app.pressBack();
    await waitForRooms(page, 20_000);
    await expect(page.locator('trn-rooms')).toBeVisible({ timeout: 20_000 });
  });

  test('restores the authenticated route after a native process restart', async ({
    app,
    page,
  }) => {
    await login(page, session, app.navigate);

    const relaunchedPage = await app.relaunch();
    await waitForRooms(relaunchedPage, 30_000);
    await expect(relaunchedPage.locator('trn-rooms')).toBeVisible({
      timeout: 30_000,
    });
  });

  test.describe('phone-sized Settings', () => {
    test.use({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });

    test('drills into a section and restores its directory link on hardware Back', async ({
      app,
      page,
    }) => {
      await login(page, session, app.navigate);
      await openNativeSettingsFromRooms(page, (control) => app.touch(control));

      const appearance = page.getByTestId('settings-nav-appearance');
      await expect(appearance).toBeVisible({ timeout: 20_000 });
      const target = await appearance.boundingBox();
      expect(target?.height ?? 0).toBeGreaterThanOrEqual(44);
      await app.touch(appearance);
      await page.waitForURL(/\/settings\/appearance$/, { timeout: 20_000 });
      await expect(
        page.getByRole('heading', { name: 'Appearance' }),
      ).toBeFocused();

      await app.pressBack();
      await page.waitForURL(/\/settings$/, { timeout: 20_000 });
      await expect(appearance).toBeFocused();
      const horizontalOverflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(horizontalOverflow).toBeLessThanOrEqual(1);

      await app.pressBack();
      await waitForRooms(page, 20_000);
    });
  });

  test.describe('phone-sized composer', () => {
    test.use({
      // Preserve the WebView's native viewport so Android's adjustResize can change
      // visualViewport when the IME opens. A CDP device-metrics override pins it at the
      // emulated height and hides the exact native behaviour this journey verifies.
      viewport: null,
      hasTouch: true,
      isMobile: true,
    });
    test.beforeAll(async ({ request, workerResourceNamespace }) => {
      const runId = workerResourceNamespace.role('android-navigation');
      composerUser = `android-insert-${runId}`;
      composerPass = `${composerUser}-pass`;
      composerSession = {
        available: session.available,
        hs: session.hs,
        user: composerUser,
        pass: composerPass,
      };
      composerRoomName = `Android insert ${runId}`;
      await seedComposerRoom(request);
    });

    test('dismisses the native keyboard before opening a bounded sheet and handles hardware Back', async ({
      app,
      page,
    }) => {
      await login(page, composerSession, app.navigate);
      await page.getByTestId('rail-rooms').click();
      await expect(page.getByTestId('rail-rooms')).toHaveAttribute(
        'aria-current',
        'true',
      );
      const room = page
        .locator('button.channel', { hasText: composerRoomName })
        .first();
      await room.waitFor({ state: 'visible', timeout: 30_000 });
      await room.click();

      const composer = page.getByTestId('composer-input');
      await expect(composer).toBeVisible();
      const fullViewportHeight = await page.evaluate(
        () => window.visualViewport?.height ?? window.innerHeight,
      );
      await app.touch(composer);
      await expect
        .poll(
          () =>
            page.evaluate(
              () => window.visualViewport?.height ?? window.innerHeight,
            ),
          { timeout: 10_000 },
        )
        .toBeLessThan(fullViewportHeight - 100);
      // Keep the native-IME proof as one uncommitted token. Sending Space commits
      // the composing word to the emulator dictionary, whose autocorrect result is
      // host-image dependent and unrelated to whether Android input reached WebView.
      await app.inputText('trinity42');
      await expect(composer).toHaveValue(/trinity42/i);
      const trigger = page.getByTestId('composer-insert');
      await app.touch(trigger);
      const sheet = page.getByTestId('action-sheet-surface');
      await expect(sheet).toBeVisible();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');

      // Moving from the editor to the non-input `+` deliberately dismisses Android's IME.
      // Prove that transition before measuring the sheet; otherwise the geometry assertion
      // could silently switch between keyboard and full viewports.
      await expect
        .poll(
          () =>
            page.evaluate(
              () => window.visualViewport?.height ?? window.innerHeight,
            ),
          { timeout: 10_000 },
        )
        .toBeGreaterThan(fullViewportHeight - 20);

      const geometry = await page.evaluate(() => {
        const surface = document.querySelector<HTMLElement>(
          '[data-testid=action-sheet-surface]',
        );
        if (!surface) throw new Error('action sheet surface is missing');
        const box = surface.getBoundingClientRect();
        const viewport = window.visualViewport;
        return {
          top: box.top,
          bottom: box.bottom,
          viewportTop: viewport?.offsetTop ?? 0,
          viewportBottom:
            (viewport?.offsetTop ?? 0) +
            (viewport?.height ?? window.innerHeight),
        };
      });
      expect(geometry.top).toBeGreaterThanOrEqual(geometry.viewportTop - 1);
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportBottom + 1);
      await app.pressBack();
      await expect(sheet).toBeHidden();
      await expect(trigger).toBeFocused();
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByTestId('composer-input')).toBeVisible();
    });
  });
});
