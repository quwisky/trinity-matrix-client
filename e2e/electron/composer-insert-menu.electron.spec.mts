import { testResourceId, expect, test, type Page } from './fixtures.mts';

import { login, synapseSession, type Navigate } from '../support/app.mts';
import { launchApp } from './support/launch.mts';

const session = synapseSession();

const electronNavigate: Navigate = async (page: Page, path: string) => {
  const baseUrl = page.url() === 'about:blank' ? 'trinity://app/' : page.url();
  await page.goto(new URL(path, baseUrl).href, {
    waitUntil: 'domcontentloaded',
  });
};

test.describe('Electron composer insert menu', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('retains the anchored desktop menu instead of a mobile sheet', async ({
    request,
  }) => {
    const loginResponse = await request.post(
      `${session.hs}/_matrix/client/v3/login`,
      {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: session.user },
          password: session.pass,
        },
      },
    );
    expect(loginResponse.ok()).toBe(true);
    const { access_token: token } = (await loginResponse.json()) as {
      access_token: string;
    };
    const roomName = `Electron insert ${testResourceId('room')}`;
    const roomResponse = await request.post(
      `${session.hs}/_matrix/client/v3/createRoom`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { name: roomName },
      },
    );
    expect(roomResponse.ok()).toBe(true);

    const app = await launchApp();
    try {
      const page = await app.firstWindow();
      await login(page, session, electronNavigate);
      await page.getByTestId('rail-rooms').click();
      const room = page
        .locator('button.channel', { hasText: roomName })
        .first();
      await room.waitFor({ state: 'visible', timeout: 30_000 });
      await room.click();

      const trigger = page.getByTestId('composer-insert');
      await trigger.click();
      await expect(page.getByTestId('insert-attach')).toBeVisible();
      await expect(page.getByTestId('action-sheet-surface')).toHaveCount(0);
      await expect(trigger).not.toHaveAttribute('aria-haspopup', 'dialog');
    } finally {
      await app.close();
    }
  });
});
