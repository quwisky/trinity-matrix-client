import { captureScreenshot } from '../../../support/screenshot.mts';
import {
  devices,
  expect,
  test,
  testResourceId,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// System Status is an application surface, but its entry point follows the shell's navigation:
// an icon left of Settings on desktop and in the room header's mobile overflow when the sidebar page is
// not present. These checks need a real conversation because a login-page status button can hide
// both placement and composer regressions.
const session = synapseSession();

async function openRoom(
  page: Page,
  request: APIRequestContext,
  tag: string,
): Promise<void> {
  const hs = session.hs as string;
  const runId = `${testResourceId('run')}${tag}`;
  const user = `status-${runId}`;
  const pass = `${user}-pass`;
  const roomName = `Status ${runId}`;

  await registerUser(request, user, pass);
  const loginResponse = await request.post(`${hs}/_matrix/client/v3/login`, {
    data: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password: pass,
    },
  });
  expect(loginResponse.ok()).toBe(true);
  const { access_token: token } = await loginResponse.json();
  const roomResponse = await request.post(
    `${hs}/_matrix/client/v3/createRoom`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: roomName, preset: 'private_chat' },
    },
  );
  expect(roomResponse.ok()).toBe(true);

  await login(page, { available: true, hs, user, pass } as SynapseSession);
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName }).first();
  await channel.waitFor({ state: 'visible', timeout: 30_000 });
  await channel.click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

function statusButton(page: Page) {
  return page
    .locator('trn-sidebar-user-panel')
    .getByTestId('open-system-status');
}

async function expectComposerUsable(page: Page, body: string): Promise<void> {
  const composer = page.getByTestId('composer-input');
  const send = page.getByTestId('composer-send');
  await composer.fill(body);
  await expect(send).toBeEnabled();
  await send.click();
  await expect(
    page.locator('trn-message-row').getByText(body, { exact: true }),
  ).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('System Status navigation placement', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('sits as an icon left of Settings on desktop and leaves the composer usable', async ({
    page,
    request,
  }, testInfo) => {
    await openRoom(page, request, 'desktop');

    const sidebarStatus = statusButton(page);
    const settings = page.getByTestId('open-settings');
    await expect(page.getByTestId('system-status-access')).toHaveCount(0);
    await expect(sidebarStatus).toBeVisible();
    await expect(sidebarStatus).toHaveText('');
    await expect(sidebarStatus).toHaveAccessibleName('System Status');
    await expect(settings).toBeVisible();
    const statusBox = await sidebarStatus.boundingBox();
    const settingsBox = await settings.boundingBox();
    const sendBox = await page.getByTestId('composer-send').boundingBox();
    expect(statusBox).not.toBeNull();
    expect(settingsBox).not.toBeNull();
    expect(sendBox).not.toBeNull();
    const verticallyBeside =
      statusBox!.y < settingsBox!.y + settingsBox!.height &&
      settingsBox!.y < statusBox!.y + statusBox!.height;
    expect(verticallyBeside).toBe(true);
    expect(statusBox!.x + statusBox!.width <= settingsBox!.x + 1).toBe(true);
    expect(
      statusBox!.x + statusBox!.width <= sendBox!.x + 1 ||
        sendBox!.x + sendBox!.width <= statusBox!.x + 1 ||
        statusBox!.y + statusBox!.height <= sendBox!.y + 1 ||
        sendBox!.y + sendBox!.height <= statusBox!.y + 1,
    ).toBe(true);

    await testInfo.attach('system-status-placement-desktop', {
      body: await captureScreenshot(page, () =>
        page.screenshot({ animations: 'disabled' }),
      ),
      contentType: 'image/png',
    });
    await sidebarStatus.click();
    const dialog = page.getByRole('dialog', { name: 'System Status' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close System Status' }).click();
    await expect(dialog).toBeHidden();
    await expect(sidebarStatus).toBeFocused();

    await expectComposerUsable(page, `desktop status ${testResourceId('msg')}`);
  });

  test.describe('on a Pixel 5', () => {
    const profile = devices['Pixel 5'];
    test.use({
      viewport: profile.viewport,
      userAgent: profile.userAgent,
      deviceScaleFactor: profile.deviceScaleFactor,
      isMobile: profile.isMobile,
      hasTouch: profile.hasTouch,
    });

    test('hides the sidebar and restores focus to the mobile overflow entry', async ({
      page,
      request,
    }, testInfo) => {
      await openRoom(page, request, 'mobile');

      await expect(page.locator('trn-channel-sidebar')).toBeHidden();
      await expect(page.getByTestId('system-status-access')).toHaveCount(0);
      const overflow = page.getByTestId('room-actions-overflow');
      await expect(overflow).toBeVisible();
      await overflow.click();
      const mobileStatus = page.getByTestId('overflow-open-system-status');
      await expect(mobileStatus).toBeVisible();
      await expect
        .poll(() =>
          mobileStatus.evaluate(
            (element) =>
              element.previousElementSibling?.getAttribute('role') ===
                'separator' &&
              element.parentElement?.lastElementChild === element,
          ),
        )
        .toBe(true);
      await testInfo.attach('system-status-placement-mobile-menu', {
        body: await captureScreenshot(page, () =>
          page.screenshot({ animations: 'disabled' }),
        ),
        contentType: 'image/png',
      });
      await mobileStatus.click();

      const dialog = page.getByRole('dialog', { name: 'System Status' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Close System Status' }).click();
      await expect(dialog).toBeHidden();
      await expect(overflow).toBeFocused();

      await expectComposerUsable(
        page,
        `mobile status ${testResourceId('msg')}`,
      );
    });
  });
});
