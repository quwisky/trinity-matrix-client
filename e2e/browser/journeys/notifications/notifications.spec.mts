import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
} from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import {
  registerUser,
  apiLogin,
  type ApiUser,
} from '../../../support/account.mts';
import { createRoom } from '../../support/space-journey.mts';
import {
  installNotificationRecorder,
  postMessage,
} from '../../support/notification-journey.mts';

// Covers NotificationService's core rule end to end: a live message fires an OS
// notification unless the user is actually looking at that room — i.e. the window
// is focused AND the message's room is the one open in the timeline. A message to
// a room you AREN'T viewing must notify even while the app itself is focused
// (Playwright pages always report `document.hasFocus() === true`, so "not
// viewing that room" — not unfocusing the window — is what drives the suppressed
// case here).
//
// Registers a throwaway reader/sender pair per test via Synapse's shared-secret
// admin endpoint, same trick as unread-badges.spec.mts. Needs a Synapse
// homeserver (Docker) and self-skips otherwise, like the other authenticated web
// e2e specs (see timeline-virtualization.spec.mts).
const session = homeserverSession();

/**
 * Register a fresh reader + sender pair, have the reader create a plain
 * (non-DM) room and invite the sender, and have the sender join it — but send
 * NO message yet. Notifications only fire for *live* timeline events (backfill
 * from before the reader's initial sync never notifies), so the message must be
 * posted only after the reader's client is up and live — see `postMessage`.
 *
 * The sender's display name is set explicitly so the notification title
 * (`${sender} · ${room}`) is deterministic to assert on.
 */
async function seedNotifyRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{
  reader: HomeserverSession;
  readerUserId: string;
  sender: ApiUser;
  roomId: string;
  roomName: string;
  senderName: string;
}> {
  const readerUser = `notify-reader-${runId}`;
  const readerPass = `reader-pass-${runId}`;
  const senderUser = `notify-sender-${runId}`;
  const senderPass = `sender-pass-${runId}`;
  const roomName = `Notify E2E ${runId}`;
  const senderName = `Notify Sender ${runId}`;

  await registerUser(request, readerUser, readerPass);
  await registerUser(request, senderUser, senderPass);

  const reader = await apiLogin(request, hs, readerUser, readerPass);
  const sender = await apiLogin(request, hs, senderUser, senderPass);

  // Give the sender a deterministic display name so the notification title
  // (`${sender} · ${room}`) doesn't depend on Synapse's default-displayname
  // behaviour.
  await request.put(
    `${hs}/_matrix/client/v3/profile/${encodeURIComponent(sender.userId)}/displayname`,
    { headers: sender.headers, data: { displayname: senderName } },
  );

  const roomId = await createRoom(request, hs, reader, roomName, {
    invite: [sender.userId],
  });

  await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    { headers: sender.headers },
  );

  return {
    reader: { available: true, hs, user: readerUser, pass: readerPass },
    readerUserId: reader.userId,
    sender,
    roomId,
    roomName,
    senderName,
  };
}

test.describe('Message notifications', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.use({ permissions: ['notifications'] });

  test('notifies for a live message in a room you are not viewing', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}n`;

    const { reader, readerUserId, sender, roomId, roomName, senderName } =
      await seedNotifyRoom(request, hs, runId);

    await installNotificationRecorder(page);
    await login(page, reader); // lands on /rooms (Home) — the seeded room isn't open

    // Home shows direct messages only (RoomsPage.visibleRooms()); our seeded room
    // is a plain (non-DM) room, so simply staying put after login already means
    // it is not the room open in the timeline. But wait for the room's own state
    // (name included) to have actually landed client-side before sending the live
    // message — peeking at the Rooms rail (without opening the channel, so the
    // room still isn't "viewed") gives a real signal to wait on instead of a
    // fixed sleep; sending too early raced the initial sync and the notification
    // title fell back to the SDK's synthesized "Empty room" placeholder.
    await page.getByTestId('rail-rooms').click();
    await expect(
      page.locator('.channel', { hasText: roomName }).first(),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Direct messages' }).click();

    const body = `hello from notify e2e ${runId}`;
    await postMessage(request, hs, sender, roomId, `notify-${runId}`, body);

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
    // Title reflects the sender + room: `${sender} · ${room}`.
    expect(match?.title).toBe(`${senderName} · ${roomName}`);
    // tag = `${userId} ${roomId}` — collapses repeats from the same room per
    // account, so the same room on two accounts stays two distinct toasts.
    expect(match?.options?.tag).toBe(`${readerUserId} ${roomId}`);
  });

  test('suppresses a live message in the room you are currently viewing', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}s`;

    const { reader, sender, roomId, roomName } = await seedNotifyRoom(
      request,
      hs,
      runId,
    );

    await installNotificationRecorder(page);
    await login(page, reader);

    // Open the seeded room so it becomes TimelineService.openRoomId — Playwright
    // pages are focused, so this is the "actually looking at it" state that
    // should suppress the notification (see notification.service.ts maybeNotify).
    await page.getByTestId('rail-rooms').click();
    await page.locator('.channel', { hasText: roomName }).first().click();
    // Confirm the room's timeline actually mounted before sending — otherwise a
    // message sent too early could land as part of the initial sync/backfill
    // rather than the live event this suppression rule is about.
    await expect(page.locator('.scroll')).toBeVisible({ timeout: 15_000 });

    const before = await page.evaluate(
      () =>
        (window as unknown as { __notifications: unknown[] }).__notifications
          .length,
    );

    const body = `hello focused e2e ${runId}`;
    await postMessage(request, hs, sender, roomId, `focused-${runId}`, body);

    // Tie the "no notification" assertion to real app state: wait for the live
    // message to actually render in the open timeline (proof the event was
    // processed), then assert the notification count didn't move. Scoped to
    // the open timeline (`.scroll`) rather than the whole page — the sidebar's
    // `.channel__preview` row (ChannelSidebarComponent's last-message preview)
    // mirrors the same body text, which would otherwise make this locator
    // strict-mode-ambiguous.
    await expect(
      page.locator('.scroll').getByText(body, { exact: true }),
    ).toBeVisible({
      timeout: 15_000,
    });

    const after = await page.evaluate(
      () =>
        (window as unknown as { __notifications: unknown[] }).__notifications
          .length,
    );
    expect(after).toBe(before);
  });
});
