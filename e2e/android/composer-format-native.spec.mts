import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { login, synapseSession, type SynapseSession } from '../support/app.mts';
import { registerUser } from '../support/account.mts';
import { captureScreenshot } from '../support/screenshot.mts';
import { expect, test } from './fixtures.mts';
import { testResourceId } from '../support/namespace.mts';

const session = synapseSession();

async function openComposer(
  page: Page,
  request: APIRequestContext,
  app: { touch(control: Locator): Promise<void> },
): Promise<Locator> {
  const run = testResourceId('android-format');
  const user = `${run}-user`;
  const pass = `${run}-pass`;
  const roomName = `Format ${run}`;
  await registerUser(request, user, pass);
  const hs = session.hs as string;
  const auth = (await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((response) => response.json())) as { access_token: string };
  await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers: { Authorization: `Bearer ${auth.access_token}` },
    data: { name: roomName, preset: 'private_chat' },
  });
  await login(page, { available: true, hs, user, pass } as SynapseSession);
  await app.touch(page.getByTestId('rail-rooms'));
  const room = page.locator('.channel', { hasText: roomName }).first();
  await expect(room).toBeVisible({ timeout: 30_000 });
  await app.touch(room);
  const composer = page.getByTestId('composer-input');
  await expect(composer).toBeVisible({ timeout: 20_000 });
  return composer;
}

test.describe('Android composer formatting', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.use({ viewport: null, hasTouch: true, isMobile: true });

  test('formats a selected word through Aa, restores the keyboard, and dismisses on Back', async ({
    app,
    page,
    request,
  }, testInfo) => {
    const composer = await openComposer(page, request, app);
    await composer.fill('say hello');
    await composer.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      input.focus();
      input.setSelectionRange(4, 9);
    });
    await app.touch(page.getByTestId('composer-format'));
    const menu = page.getByTestId('action-sheet-surface');
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    const viewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    // WebView rounds its CSS viewport through native device-pixel ratios.
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 0.5);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 0.5);
    await app.touch(menu.getByTestId('format-italic'));
    await expect(composer).toHaveValue('say *hello*');
    await expect(menu).toBeHidden();
    await expect(composer).toBeFocused();
    await expect(composer).toHaveJSProperty('selectionStart', 5);
    await expect(composer).toHaveJSProperty('selectionEnd', 10);
    await expect
      .poll(async () =>
        /mInputShown=true/.test(
          (await app.device.shell('dumpsys input_method')).toString('utf8'),
        ),
      )
      .toBe(true);
    await testInfo.attach('composer-format-native.png', {
      body: await captureScreenshot(page, () => app.device.screenshot()),
      contentType: 'image/png',
    });

    await app.touch(page.getByTestId('composer-format'));
    await expect(page.getByTestId('format-cancel')).toBeVisible();
    const unchanged = await composer.inputValue();
    await app.pressBack();
    await expect(page.getByTestId('format-cancel')).toHaveCount(0);
    await expect(composer).toHaveValue(unchanged);
  });
});
