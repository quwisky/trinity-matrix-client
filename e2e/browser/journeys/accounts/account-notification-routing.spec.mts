import { expect, test, testResourceId } from '../../../fixtures.mts';
import { isAndroidE2E, login } from '../../../support/app.mts';
import {
  addAccountViaUi,
  configureMultiAccountSuite,
  installNotificationRecorder,
  postMessage,
  seedLiveNotifyReader,
  session,
} from '../../support/multi-account-journey.mts';

test.describe('Multiple accounts', () => {
  configureMultiAccountSuite();

  test('raises a notification for a live message to a background account, tagged for that account', async ({
    matrixResources,
    page,
    request,
  }) => {
    test.skip(
      isAndroidE2E,
      'native notification delivery and collapse tags need an FCM integration environment; renderer notification assertions are web-only',
    );
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}n`;

    // Account B: a fresh reader in a plain room with a sender who has joined but
    // not yet spoken. The message is posted *live*, after B's client is up.
    const b = await seedLiveNotifyReader(request, hs, matrixResources);

    await installNotificationRecorder(page);

    // Sign in as A (active), then add B — B becomes the active account on add.
    const handleA = `@${session.user}:`;
    await login(page, session);
    await addAccountViaUi(page, hs, b.user, b.pass);
    await expect(page.locator('.userbar__handle')).toContainText(`@${b.user}:`);

    // Wait for B's room state (name included) to land client-side before going
    // live, so the notification title is deterministic — peeking at the Rooms
    // rail is a real signal to wait on and doesn't "view" the room (same trick as
    // notifications.spec.mts; sending too early races the initial sync and the
    // title falls back to the SDK's "Empty room" placeholder).
    await page.getByTestId('rail-rooms').click();
    await expect(
      page.locator('.channel', { hasText: b.roomName }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Switch back to A so B is now a *background* account. B keeps syncing —
    // NotificationService attaches to every signed-in account, not just the
    // active one.
    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('account-row').filter({ hasText: handleA }).click();
    await expect(page.locator('.userbar__handle')).toContainText(handleA);

    // Live message to B's room while A is foregrounded. Because B is not the
    // active account, the "you're viewing that room" suppression can't apply, so
    // the notification fires — and its collapse tag is namespaced by B's own user
    // id, keeping accounts isolated.
    const body = `multi-account notify ${runId}`;
    await postMessage(
      request,
      hs,
      b.sender,
      b.roomId,
      `multi-notify-${runId}`,
      body,
    );

    // Wait on the app's own recorded state, not a fixed sleep.
    await page.waitForFunction(
      (expectedBody) => {
        const w = window as unknown as {
          __notifications?: Array<{ title: string; options: unknown }>;
        };
        return (w.__notifications ?? []).some(
          (n) =>
            (n.options as { body?: string } | undefined)?.body === expectedBody,
        );
      },
      body,
      { timeout: 20_000, polling: 300 },
    );

    const notifications = await page.evaluate(
      () =>
        (
          window as unknown as {
            __notifications: Array<{
              title: string;
              options: { body?: string; tag?: string };
            }>;
          }
        ).__notifications,
    );
    const match = notifications.find((n) => n.options?.body === body);
    expect(match).toBeTruthy();
    // Title reflects the sender + B's room: `${sender} · ${room}`.
    expect(match?.title).toBe(`${b.senderName} · ${b.roomName}`);
    // tag = `${bUserId} ${roomId}` — namespaced by the *background* account's own
    // user id (not the active account A's), so the same room on two accounts stays
    // two distinct toasts.
    expect(match?.options?.tag).toBe(`${b.readerUserId} ${b.roomId}`);
  });
});
