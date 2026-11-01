import { expect, test, type Page } from './fixtures.mts';

import {
  login,
  homeserverSession,
  waitForRooms,
  type Navigate,
} from '../support/app.mts';
import { passwordLogin, registerUser } from '../support/account.mts';
import { createElectronProfile, launchApp } from './support/launch.mts';
import {
  grantNotifications,
  installNotificationCounter,
  notificationBodies,
} from './support/notifications.mts';

const session = homeserverSession();

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
      // The counter keeps this journey independent of the host OS notification service
      // and proves restored history never invokes the presenter.
      await installNotificationCounter(app);

      const page = await app.firstWindow();
      await grantNotifications(page);
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
      expect(await notificationBodies(app)).toEqual([]);
      await expect(page.getByTestId('app-capability-summary')).toHaveCount(0);

      await app.close();
      // Sent while the app is closed: the next start's catch-up sync brings it in as a
      // live event, but it must only raise the unread badge, never a notification.
      const missed = await request.put(
        `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${matrixResources.namespace.role('closed-event')}`,
        {
          headers: senderHeaders,
          data: { msgtype: 'm.text', body: 'Sent while the app was closed' },
        },
      );
      expect(missed.ok()).toBe(true);
      app = await launchApp(userDataDir);
      // Hold /sync until presentation is ready, or the catch-up batch would be dropped for
      // lack of a presenter and the 0 below would prove nothing. The route is set before
      // the reload, so every /sync the app sends afterwards waits here; the room list
      // renders from the stored cache without it.
      let releaseSync!: () => void;
      const syncHeld = new Promise<void>((resolve) => (releaseSync = resolve));
      await app
        .context()
        .route(/\/_matrix\/client\/v3\/sync\?/, async (route) => {
          await syncHeld;
          await route.continue().catch(() => undefined);
        });
      await installNotificationCounter(app);
      const restartedPage = await app.firstWindow();
      await grantNotifications(restartedPage);
      await waitForRooms(restartedPage);
      releaseSync();
      await expect(
        restartedPage.getByText(roomName, { exact: true }).first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        restartedPage.getByTestId('app-capability-summary'),
      ).toHaveCount(0);

      const live = await request.put(
        `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${matrixResources.namespace.role('live-event')}`,
        {
          headers: senderHeaders,
          data: { msgtype: 'm.text', body: 'Sent after startup' },
        },
      );
      expect(live.ok()).toBe(true);
      // The catch-up batch is processed before this message's sync, so a catch-up
      // notification would still be in the list next to this one.
      await expect
        .poll(() => notificationBodies(app), { timeout: 45_000 })
        .toContain('Sent after startup');
      expect(await notificationBodies(app)).toEqual(['Sent after startup']);
    } finally {
      await app.close();
    }
  });
});
