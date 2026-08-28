import { devices, expect, test } from './support/fixtures.mts';
import { login, synapseSession } from './support/app.mts';

process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

const session = synapseSession();
const roomName = `Mobile insert ${Date.now()}`;
const pixel = devices['Pixel 5'];

async function seedRoom(): Promise<void> {
  const loginResponse = await fetch(`${session.hs}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: session.user },
      password: session.pass,
    }),
  });
  if (!loginResponse.ok) {
    throw new Error(`Login failed while seeding: ${loginResponse.status}`);
  }
  const { access_token: token } = (await loginResponse.json()) as {
    access_token: string;
  };
  const roomResponse = await fetch(
    `${session.hs}/_matrix/client/v3/createRoom`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: roomName }),
    },
  );
  if (!roomResponse.ok) {
    throw new Error(`Room seed failed: ${roomResponse.status}`);
  }
}

async function openSeededRoom(page: import('@playwright/test').Page) {
  await login(page, session);
  await page.getByTestId('rail-rooms').click();
  const room = page.locator('button.channel', { hasText: roomName }).first();
  await room.waitFor({ state: 'visible', timeout: 30_000 });
  await room.click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
}

test.describe('Mobile composer insert sheet', () => {
  test.skip(
    process.env['TRINITY_E2E_PLATFORM'] === 'android',
    'Android has a separate installed-WebView journey',
  );
  test.skip(!session.available, 'requires the disposable Synapse homeserver');
  test.beforeAll(seedRoom);

  test.describe('Pixel 5 profile', () => {
    test.use({
      viewport: pixel.viewport,
      userAgent: pixel.userAgent,
      deviceScaleFactor: pixel.deviceScaleFactor,
      isMobile: pixel.isMobile,
      hasTouch: pixel.hasTouch,
    });

    test('uses a bounded, touch-sized action sheet and restores focus on Escape', async ({
      page,
    }) => {
      await openSeededRoom(page);
      expect(await page.evaluate(() => navigator.userAgent)).toContain(
        'Android',
      );
      expect(
        await page.evaluate(() => navigator.maxTouchPoints),
      ).toBeGreaterThan(0);

      const trigger = page.getByTestId('composer-insert');
      const triggerBox = await trigger.boundingBox();
      expect(triggerBox?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(triggerBox?.height ?? 0).toBeGreaterThanOrEqual(44);
      await trigger.click();

      const dialog = page.getByRole('dialog', { name: 'Add to message' });
      const sheet = dialog.getByTestId('action-sheet-surface');
      await expect(sheet).toBeVisible();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await expect(dialog.getByTestId('insert-attach')).toBeFocused();

      const geometry = await page.evaluate(() => {
        const surface = document.querySelector<HTMLElement>(
          '[data-testid=action-sheet-surface]',
        );
        const rows = [
          ...document.querySelectorAll<HTMLElement>('[data-testid^=insert-]'),
        ].filter((row) => row.closest('trn-action-sheet'));
        if (!surface || rows.length === 0)
          throw new Error('sheet is incomplete');
        const box = surface.getBoundingClientRect();
        return {
          documentOverflow:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
          box: {
            top: box.top,
            right: box.right,
            bottom: box.bottom,
            left: box.left,
          },
          viewport: { width: innerWidth, height: innerHeight },
          rowHeights: rows.map((row) => row.getBoundingClientRect().height),
          lastBottom: rows.at(-1)?.getBoundingClientRect().bottom ?? 0,
        };
      });
      expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
      expect(geometry.box.left).toBeGreaterThanOrEqual(0);
      expect(geometry.box.right).toBeLessThanOrEqual(geometry.viewport.width);
      expect(geometry.box.top).toBeGreaterThanOrEqual(0);
      expect(geometry.box.bottom).toBeLessThanOrEqual(geometry.viewport.height);
      expect(Math.min(...geometry.rowHeights)).toBeGreaterThanOrEqual(44);
      expect(geometry.lastBottom).toBeLessThanOrEqual(geometry.box.bottom + 1);

      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      await expect(trigger).toBeFocused();
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });
  });

  test.describe('320px containment', () => {
    test.use({
      viewport: { width: 320, height: 568 },
      userAgent: pixel.userAgent,
      deviceScaleFactor: pixel.deviceScaleFactor,
      isMobile: pixel.isMobile,
      hasTouch: pixel.hasTouch,
    });

    test('keeps the chat and sheet inside the document width', async ({
      page,
    }) => {
      await openSeededRoom(page);
      await page.getByTestId('composer-insert').click();
      await expect(page.getByTestId('action-sheet-surface')).toBeVisible();

      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(1);
    });
  });
});
