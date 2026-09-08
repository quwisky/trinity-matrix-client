import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '../../fixtures.mts';
import {
  fillLabeledInput,
  synapseSession,
  waitForRooms,
} from '../../support/app.mts';
import { registerUser } from '../../support/account.mts';
import type { MatrixTestResources } from '../../support/test-resources.mts';

// End-to-end for concurrent multi-account (Milestones 9 + 6/10): add a second account
// from the user-panel "Add account" (routes to /login?add), switch the active account,
// confirm per-account encryption status reaches the UI, and prove the app badge sums
// unread across accounts (switch-invariant). Uses the same throwaway-user registration
// trick as unread-badges / notifications specs; needs Synapse (Docker), self-skips otherwise.
export const session = synapseSession();

export async function expectWorkspaceAccount(
  page: Page,
  localpart: string,
): Promise<void> {
  await expect
    .poll(() => new URL(page.url()).searchParams.get('account'))
    .toContain(`@${localpart}:`);
}

export interface ApiUser {
  userId: string;
  headers: { Authorization: string };
}

export async function apiLogin(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<ApiUser> {
  const res = await request.post(`${hs}/_matrix/client/v3/login`, {
    data: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password: pass,
    },
  });
  const json = await res.json();
  return {
    userId: json.user_id as string,
    headers: { Authorization: `Bearer ${json.access_token}` },
  };
}

/**
 * Register a fresh reader with `seed` unread notifications: the reader creates a room,
 * invites a sender who joins and posts `seed` messages, leaving the reader unread.
 * Returns the reader's login credentials (for adding the account in the app).
 */
export async function seedUnreadReader(
  request: APIRequestContext,
  hs: string,
  seed: number,
  resources: MatrixTestResources,
): Promise<{ user: string; pass: string }> {
  const user = resources.userLocalpart('unread-reader');
  const pass = `${user}-pass`;
  const senderUser = resources.userLocalpart('unread-sender');
  const senderPass = `${senderUser}-pass`;
  await registerUser(request, user, pass);
  await registerUser(request, senderUser, senderPass);
  const reader = await apiLogin(request, hs, user, pass);
  const sender = await apiLogin(request, hs, senderUser, senderPass);

  const roomId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: reader.headers,
      data: {
        name: resources.roomName('unread-room'),
        invite: [sender.userId],
      },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);
  await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    { headers: sender.headers },
  );
  registerRoomCleanup(resources, request, hs, roomId, [reader, sender]);
  for (let i = 0; i < seed; i++) {
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${resources.namespace.role('unread-message')}-${i}`,
      {
        headers: sender.headers,
        data: { msgtype: 'm.text', body: `msg ${i}` },
      },
    );
  }
  return { user, pass };
}

/**
 * Tick another account into the mixed view via the user panel's "Accounts in view" picker.
 * The active account is always included (its row is disabled), so this is only for others.
 *
 * **Desktop layout only.** Below the md breakpoint the picker is a dialog rather than a
 * submenu, so the menu has already closed by the time the rows appear and the two Escape
 * presses below do not apply — see the narrow-layout test at the end of this file.
 */
export async function mixInAccount(
  page: Page,
  localpart: string,
): Promise<void> {
  await page.getByTestId('user-menu-trigger').click();
  await page.getByTestId('show-accounts').click();
  await page.locator(`[data-testid^="show-account-@${localpart}:"]`).click();
  // The picker keeps the menu open for multi-select; close it to get back to the list.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
}

/** Drive the user-panel "Add account" flow through to a signed-in second account. */
export async function addAccountViaUi(
  page: Page,
  hs: string,
  user: string,
  pass: string,
): Promise<void> {
  await page.getByTestId('user-menu-trigger').click();
  await page.getByTestId('add-account').click();
  // Add mode shows a Cancel affordance (only present when ?add is set).
  await expect(page.getByTestId('cancel-add')).toBeVisible();
  await fillLabeledInput(page, 'Homeserver', hs);
  await page.getByText('Continue', { exact: true }).click();
  await page
    .getByRole('button', { name: 'Sign in' })
    .waitFor({ timeout: 30_000 });
  await fillLabeledInput(page, 'Username', user);
  await fillLabeledInput(page, 'Password', pass);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await waitForRooms(page);
}

/**
 * Register a fresh reader (destined to be added as a *background* account in the
 * UI) plus a sender, have the reader create a plain (non-DM) room and invite the
 * sender, and have the sender join it — but post NO message yet. Notifications
 * only fire for *live* timeline events (backfill from before the reader's initial
 * sync never notifies), so the message must be sent only after the reader's
 * client is up — see {@link postMessage}. The sender's display name is set
 * explicitly so the notification title (`${sender} · ${room}`) is deterministic.
 */
export async function seedLiveNotifyReader(
  request: APIRequestContext,
  hs: string,
  resources: MatrixTestResources,
): Promise<{
  user: string;
  pass: string;
  readerUserId: string;
  sender: ApiUser;
  roomId: string;
  roomName: string;
  senderName: string;
}> {
  const user = resources.userLocalpart('notify-reader');
  const pass = `${user}-pass`;
  const senderUser = resources.userLocalpart('notify-sender');
  const senderPass = `${senderUser}-pass`;
  const roomName = resources.roomName('notify-room');
  const senderName = `Multi Sender ${resources.namespace.role('notify-sender')}`;

  await registerUser(request, user, pass);
  await registerUser(request, senderUser, senderPass);

  const reader = await apiLogin(request, hs, user, pass);
  const sender = await apiLogin(request, hs, senderUser, senderPass);

  // Deterministic display name so the notification title doesn't depend on
  // Synapse's default-displayname behaviour.
  await request.put(
    `${hs}/_matrix/client/v3/profile/${encodeURIComponent(sender.userId)}/displayname`,
    { headers: sender.headers, data: { displayname: senderName } },
  );

  const roomId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: reader.headers,
      data: { name: roomName, preset: 'private_chat', invite: [sender.userId] },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);

  await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    { headers: sender.headers },
  );
  registerRoomCleanup(resources, request, hs, roomId, [reader, sender]);

  return {
    user,
    pass,
    readerUserId: reader.userId,
    sender,
    roomId,
    roomName,
    senderName,
  };
}

export function registerRoomCleanup(
  resources: MatrixTestResources,
  request: APIRequestContext,
  hs: string,
  roomId: string,
  users: readonly ApiUser[],
): void {
  for (const user of users) {
    resources.cleanup(`leave ${roomId} as ${user.userId}`, async () => {
      const response = await request.post(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`,
        { headers: user.headers },
      );
      if (!response.ok()) {
        throw new Error(
          `Matrix room cleanup failed for ${user.userId} with HTTP ${response.status()}`,
        );
      }
    });
  }
}

/** Have the sender post one live message via the CS API. */
export async function postMessage(
  request: APIRequestContext,
  hs: string,
  sender: ApiUser,
  roomId: string,
  txnId: string,
  body: string,
): Promise<void> {
  await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
    { headers: sender.headers, data: { msgtype: 'm.text', body } },
  );
}

/**
 * Record every Web `Notification` the app raises into `window.__notifications`
 * (as `{ title, options }`), from either delivery path NotificationService can
 * take (the renderer `new Notification(...)` constructor, or the service worker
 * `registration.showNotification(...)`). Installed via `page.addInitScript` so
 * it's in place before the app's first script runs — same recorder as
 * notifications.spec.mts. Also stubs `Notification.permission = 'granted'` so the
 * service's Web permission gate passes without a browser prompt.
 */
export async function installNotificationRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __notifications: Array<{ title: string; options: unknown }>;
    };
    w.__notifications = [];

    class RecordingNotification {
      static permission = 'granted';
      static requestPermission = async (): Promise<string> => 'granted';
      onclick: (() => void) | null = null;
      constructor(title: string, options?: unknown) {
        w.__notifications.push({ title, options });
      }
      close(): void {
        /* no-op */
      }
    }
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      writable: true,
      value: RecordingNotification,
    });

    // Neutralize the service-worker path so the constructor above is always the
    // one taken, AND record through it too in case a SW ever does control the
    // page (e2e's development build never registers one).
    if (
      typeof navigator !== 'undefined' &&
      'serviceWorker' in navigator &&
      navigator.serviceWorker
    ) {
      try {
        Object.defineProperty(navigator.serviceWorker, 'controller', {
          configurable: true,
          get: () => null,
        });
      } catch {
        /* some engines make `controller` non-configurable — ignore */
      }
      void navigator.serviceWorker.ready
        .then((registration) => {
          const original = registration.showNotification?.bind(registration);
          registration.showNotification = ((
            title: string,
            options?: unknown,
          ) => {
            w.__notifications.push({ title, options });
            return original
              ? original(title, options as NotificationOptions)
              : Promise.resolve();
          }) as typeof registration.showNotification;
        })
        .catch(() => {
          /* no SW registration in this build — nothing to wrap */
        });
    }
  });
}

/** Register the shared availability and timeout policy in each focused spec. */
export function configureMultiAccountSuite(): void {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.describe.configure({ timeout: 120_000 });
}
