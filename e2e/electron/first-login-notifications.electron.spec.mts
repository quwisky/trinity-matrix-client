import { expect, test, type Page } from './fixtures.mts';

import {
  login,
  synapseSession,
  waitForRooms,
  type Navigate,
} from '../support/app.mts';
import { passwordLogin, registerUser } from '../support/account.mts';
import { createElectronProfile, launchApp } from './support/launch.mts';

const session = synapseSession();

async function installRejectedNotificationCounter(
  app: Awaited<ReturnType<typeof launchApp>>,
): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const channel = 'trinity:host:v1:notification-presentation:present';
    ipcMain.removeHandler(channel);
    (
      globalThis as typeof globalThis & { __e2eNotificationCalls?: number }
    ).__e2eNotificationCalls = 0;
    ipcMain.handle(channel, () => {
      const state = globalThis as typeof globalThis & {
        __e2eNotificationCalls?: number;
      };
      state.__e2eNotificationCalls = (state.__e2eNotificationCalls ?? 0) + 1;
      return {
        kind: 'rejected',
        diagnostic: { code: 'e2e-notification-rejected' },
      };
    });
  });
}

async function notificationCallCount(
  app: Awaited<ReturnType<typeof launchApp>>,
): Promise<number> {
  return app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __e2eNotificationCalls?: number;
    };
    return state.__e2eNotificationCalls ?? -1;
  });
}

const electronNavigate: Navigate = async (page: Page, path: string) => {
  const baseUrl = page.url() === 'about:blank' ? 'trinity://app/' : page.url();
  await page.goto(new URL(path, baseUrl).href, {
    waitUntil: 'domcontentloaded',
  });
};

test.describe('Electron first-login notifications', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('does not report historical events as host capability failures', async ({
    request,
    matrixResources,
  }) => {
    const homeserver = session.hs as string;
    const targetName = matrixResources.userLocalpart('first-login-target');
    const targetPassword = `${targetName}-pass`;
    const senderName = matrixResources.userLocalpart('first-login-sender');
    const senderPassword = `${senderName}-pass`;
    await registerUser(request, targetName, targetPassword);
    await registerUser(request, senderName, senderPassword);
    const target = await passwordLogin(
      request,
      homeserver,
      targetName,
      targetPassword,
    );
    const sender = await passwordLogin(
      request,
      homeserver,
      senderName,
      senderPassword,
    );
    const senderHeaders = { Authorization: `Bearer ${sender.accessToken}` };
    const targetHeaders = { Authorization: `Bearer ${target.accessToken}` };
    const roomName = matrixResources.roomName('first-login history');
    const created = await request.post(
      `${homeserver}/_matrix/client/v3/createRoom`,
      {
        headers: senderHeaders,
        data: {
          name: roomName,
          preset: 'private_chat',
          invite: [target.userId],
        },
      },
    );
    expect(created.ok()).toBe(true);
    const roomId = (await created.json()).room_id as string;
    const joined = await request.post(
      `${homeserver}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
      { headers: targetHeaders },
    );
    expect(joined.ok()).toBe(true);
    const sent = await request.put(
      `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${matrixResources.namespace.role('history-event')}`,
      {
        headers: senderHeaders,
        data: { msgtype: 'm.text', body: 'Sent before the first app login' },
      },
    );
    expect(sent.ok()).toBe(true);

    const userDataDir = createElectronProfile();
    let app = await launchApp(userDataDir);
    try {
      // A rejected presentation made each historical event surface as the generic
      // capability warning from #490. Keeping the rejection deterministic makes
      // this journey independent of the host OS notification service, while the
      // counter proves restored history never invokes the presenter.
      await installRejectedNotificationCounter(app);

      const page = await app.firstWindow();
      await login(
        page,
        {
          available: true,
          hs: homeserver,
          user: targetName,
          pass: targetPassword,
        },
        electronNavigate,
      );
      await expect(
        page.getByText(roomName, { exact: true }).first(),
      ).toBeVisible({ timeout: 30_000 });
      expect(await notificationCallCount(app)).toBe(0);
      await expect(page.getByTestId('app-capability-summary')).toHaveCount(0);

      await app.close();
      app = await launchApp(userDataDir);
      await installRejectedNotificationCounter(app);
      const restartedPage = await app.firstWindow();
      await waitForRooms(restartedPage);
      expect(await notificationCallCount(app)).toBe(0);
      await expect(
        restartedPage.getByTestId('app-capability-summary'),
      ).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});
