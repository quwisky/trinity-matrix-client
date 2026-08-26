import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { fillLabeledInput, login, synapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// End-to-end for concurrent multi-account (Milestones 9 + 6/10): add a second account
// from the user-panel "Add account" (routes to /login?add), switch the active account,
// confirm per-account encryption status reaches the UI, and prove the app badge sums
// unread across accounts (switch-invariant). Uses the same throwaway-user registration
// trick as unread-badges / notifications specs; needs Synapse (Docker), self-skips otherwise.
const session = synapseSession();

interface ApiUser {
  userId: string;
  headers: { Authorization: string };
}

async function apiLogin(
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
async function seedUnreadReader(
  request: APIRequestContext,
  hs: string,
  runId: string,
  seed: number,
): Promise<{ user: string; pass: string }> {
  const user = `multi-rdr-${runId}`;
  const pass = `multi-rdr-pass-${runId}`;
  const senderUser = `multi-snd-${runId}`;
  const senderPass = `multi-snd-pass-${runId}`;
  await registerUser(request, user, pass);
  await registerUser(request, senderUser, senderPass);
  const reader = await apiLogin(request, hs, user, pass);
  const sender = await apiLogin(request, hs, senderUser, senderPass);

  const roomId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: reader.headers,
      data: { name: `Unread ${runId}`, invite: [sender.userId] },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);
  await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    { headers: sender.headers },
  );
  for (let i = 0; i < seed; i++) {
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/multi-${runId}-${i}`,
      {
        headers: sender.headers,
        data: { msgtype: 'm.text', body: `msg ${i}` },
      },
    );
  }
  return { user, pass };
}

/** Stub the W3C Badging API before boot so AppBadgeService's web sink is recorded. */
async function installBadgeRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __appBadgeCalls: unknown[][] };
    w.__appBadgeCalls = [];
    const nav = navigator as Navigator & {
      setAppBadge?: (n?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    nav.setAppBadge = (n?: number) => {
      w.__appBadgeCalls.push(['set', n]);
      return Promise.resolve();
    };
    nav.clearAppBadge = () => {
      w.__appBadgeCalls.push(['clear']);
      return Promise.resolve();
    };
  });
}

/**
 * Tick another account into the mixed view via the user panel's "Show accounts" picker.
 * The active account is always included (its row is disabled), so this is only for others.
 *
 * **Desktop layout only.** Below the md breakpoint the picker is a dialog rather than a
 * submenu, so the menu has already closed by the time the rows appear and the two Escape
 * presses below do not apply — see the narrow-layout test at the end of this file.
 */
async function mixInAccount(page: Page, localpart: string): Promise<void> {
  await page.getByTestId('user-menu-trigger').click();
  await page.getByTestId('show-accounts').click();
  await page.locator(`[data-testid^="show-account-@${localpart}:"]`).click();
  // The picker keeps the menu open for multi-select; close it to get back to the list.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
}

/** Drive the user-panel "Add account" flow through to a signed-in second account. */
async function addAccountViaUi(
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
  await page.waitForURL('**/rooms', { timeout: 30_000 });
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
async function seedLiveNotifyReader(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{
  user: string;
  pass: string;
  readerUserId: string;
  sender: ApiUser;
  roomId: string;
  roomName: string;
  senderName: string;
}> {
  const user = `multi-nrdr-${runId}`;
  const pass = `multi-nrdr-pass-${runId}`;
  const senderUser = `multi-nsnd-${runId}`;
  const senderPass = `multi-nsnd-pass-${runId}`;
  const roomName = `Multi Notify ${runId}`;
  const senderName = `Multi Sender ${runId}`;

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

/** Have the sender post one live message via the CS API. */
async function postMessage(
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
async function installNotificationRecorder(page: Page): Promise<void> {
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

test.describe('Multiple accounts', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  // Two full UI logins plus switches — give it headroom over the 30s default.
  test.describe.configure({ timeout: 120_000 });

  test('adds a second account and switches the active account between them', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}m`;
    const userB = `multi-b-${runId}`;
    const passB = `multi-b-pass-${runId}`;
    await registerUser(request, userB, passB);

    // 1. Sign in as account A (the default seeded session user).
    await login(page, session);
    const handleA = `@${session.user}:`;
    await expect(page.locator('.userbar__handle')).toContainText(handleA);

    // 2. Add account B from the user panel.
    await addAccountViaUi(page, hs, userB, passB);

    // 3. Account B is now the active account.
    await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);

    // 3b. Per-account encryption status reaches the UI: account B is brand new with
    // no encryption set up, so its setup banner shows — proof the crypto status
    // (its own per-account store) projected onto the newly-active account. Scope to
    // the visible <trn-banner>: the banner also mirrors its message in an off-screen
    // sr-only live region, so a bare getByText would match two elements.
    await expect(
      page.locator('trn-banner').getByText('Set up encryption'),
    ).toBeVisible({
      timeout: 20_000,
    });

    // 4. The switcher lists both accounts.
    await page.getByTestId('user-menu-trigger').click();
    const rows = page.getByTestId('account-row');
    await expect(rows).toHaveCount(2);

    // 5. Switch back to account A from the menu.
    await rows.filter({ hasText: handleA }).click();
    await expect(page.locator('.userbar__handle')).toContainText(handleA);
  });

  test('the app badge sums unread across accounts, invariant to which is active', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}u`;
    const SEED = 2;

    // Account A: fresh, zero unread. Account B: seeded with SEED unread messages.
    const userA = `multi-a-${runId}`;
    const passA = `multi-a-pass-${runId}`;
    await registerUser(request, userA, passA);
    const b = await seedUnreadReader(request, hs, runId, SEED);

    await installBadgeRecorder(page);

    // Sign in as A (0 unread), then add B (SEED unread) — B becomes active.
    await login(page, { available: true, hs, user: userA, pass: passA });
    await addAccountViaUi(page, hs, b.user, b.pass);
    await expect(page.locator('.userbar__handle')).toContainText(`@${b.user}:`);

    // The badge reflects the cross-account total: A(0) + B(SEED) = SEED.
    await page.waitForFunction(
      (seed) => {
        const w = window as unknown as { __appBadgeCalls?: unknown[][] };
        return (w.__appBadgeCalls ?? []).some(
          (call) => call[0] === 'set' && call[1] === seed,
        );
      },
      SEED,
      { timeout: 30_000, polling: 300 },
    );

    // Switch to account A (0 unread of its own). Because the total is aggregated
    // across every account, B's unread still counts — the badge must NOT clear or
    // drop to A's zero (active-only aggregation would). The switch is confirmed by
    // the user-bar handle, after which no further badge update should have fired.
    await page.getByTestId('user-menu-trigger').click();
    await page
      .getByTestId('account-row')
      .filter({ hasText: `@${userA}:` })
      .click();
    await expect(page.locator('.userbar__handle')).toContainText(`@${userA}:`);

    const calls = await page.evaluate(
      () =>
        (window as unknown as { __appBadgeCalls: unknown[][] }).__appBadgeCalls,
    );
    const lastSet = [...calls].reverse().find((call) => call[0] === 'set');
    expect(lastSet?.[1]).toBe(SEED); // still B's unread, not A's zero
    expect(calls[calls.length - 1]).not.toEqual(['clear']);
  });

  test('signs one account out while the other keeps running', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}o`;
    const userB = `multi-b-${runId}`;
    const passB = `multi-b-pass-${runId}`;
    await registerUser(request, userB, passB);

    const handleA = `@${session.user}:`;
    await login(page, session);
    await addAccountViaUi(page, hs, userB, passB);
    await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);

    // Sign out the active account (B) from the user panel, confirming the dialog.
    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('logout').click();
    await page.getByTestId('alert-confirm').click();

    // Account A survives and becomes active; the shell stays put (no redirect).
    await expect(page.locator('.userbar__handle')).toContainText(handleA);
    await expect(page).toHaveURL(/\/rooms/);

    // The switcher now lists only account A.
    await page.getByTestId('user-menu-trigger').click();
    await expect(page.getByTestId('account-row')).toHaveCount(1);
  });

  test('re-adds a signed-out account without a crypto-store mismatch', async ({
    page,
    request,
  }) => {
    // Regression for the sign-out → sign-in crypto bug: signing an account out then
    // logging it back in used to fail with the Rust-crypto error "the account in the
    // store doesn't match the account in the constructor". Sign-out deleted the wrong
    // encryption store (leaving the account's real one orphaned) and the store was keyed
    // only by user, so the re-login — on a NEW server-issued device — reopened that
    // stale store, initRustCrypto threw, and the client never started. Needs real crypto
    // + persistent IndexedDB across the logout/login cycle, so it lives here, not in a unit.
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}x`;
    const userB = `multi-b-${runId}`;
    const passB = `multi-b-pass-${runId}`;
    await registerUser(request, userB, passB);

    const handleA = `@${session.user}:`;
    // Sign in as A, add B (B becomes active).
    await login(page, session);
    await addAccountViaUi(page, hs, userB, passB);
    await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);

    // Sign B out — its stores are wiped; A survives and becomes active.
    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('logout').click();
    await page.getByTestId('alert-confirm').click();
    await expect(page.locator('.userbar__handle')).toContainText(handleA);

    // Re-add B (the exact reported flow). It logs in fresh on a new device; the add must
    // reach /rooms — addAccountViaUi waits for **/rooms, so a clean crypto start IS the
    // assertion (a mismatch would leave the add spinning on the login screen).
    await addAccountViaUi(page, hs, userB, passB);
    await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);

    // Both accounts are signed in again.
    await page.getByTestId('user-menu-trigger').click();
    await expect(page.getByTestId('account-row')).toHaveCount(2);
  });

  test('signs the only account out and back in without a crypto-store mismatch', async ({
    page,
  }) => {
    // The single-account variant of the same bug, exercising the full-reset + replace-login
    // path (last-account sign-out wipes everything and returns to /login).
    const handleA = `@${session.user}:`;
    // Sign in — creates and persists this account's encryption store.
    await login(page, session);
    await expect(page.locator('.userbar__handle')).toContainText(handleA);

    // Sign the only account out → the shell returns to /login and the stores are wiped.
    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('logout').click();
    await page.getByTestId('alert-confirm').click();
    await page.waitForURL('**/login', { timeout: 30_000 });

    // Sign back in on a new device. Before the fix this reopened the previous device's
    // orphaned crypto store and initRustCrypto threw, so /rooms was never reached; login()
    // waits for **/rooms, so reaching it proves the encryption store started clean.
    await login(page, session);
    await expect(page.locator('.userbar__handle')).toContainText(handleA);
  });

  test('cancels adding an account and returns to the app', async ({ page }) => {
    const handleA = `@${session.user}:`;
    await login(page, session);

    // Start adding an account, then cancel out of the add-mode login.
    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('add-account').click();
    await expect(page.getByTestId('cancel-add')).toBeVisible();
    await page.getByTestId('cancel-add').click();

    // Back in the app on account A — still the only signed-in account.
    await expect(page).toHaveURL(/\/rooms/);
    await expect(page.locator('.userbar__handle')).toContainText(handleA);
    await page.getByTestId('user-menu-trigger').click();
    await expect(page.getByTestId('account-row')).toHaveCount(1);
  });

  test('re-authenticates an account from the /login?reauth prefill', async ({
    page,
  }) => {
    const handleA = `@${session.user}:`;
    await login(page, session);
    await expect(page.locator('.userbar__handle')).toContainText(handleA);
    const userId = (
      (await page.locator('.userbar__handle').textContent()) ?? ''
    ).trim();

    // Go straight to the re-auth login for the account (as the switcher's re-auth row
    // does). The homeserver step is skipped and the username is prefilled + locked.
    await page.goto(`/login?reauth=${encodeURIComponent(userId)}`, {
      waitUntil: 'networkidle',
    });
    await expect(
      page.getByText('Sign in again to reconnect this account'),
    ).toBeVisible({ timeout: 15_000 });
    const username = page.getByLabel('Username');
    await expect(username).toHaveValue(userId);
    await expect(username).toBeDisabled();

    // Complete the re-auth → back in the app on the same account.
    await fillLabeledInput(page, 'Password', session.pass as string);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('**/rooms', { timeout: 30_000 });
    await expect(page.locator('.userbar__handle')).toContainText(handleA);
  });

  test('raises a notification for a live message to a background account, tagged for that account', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}n`;

    // Account B: a fresh reader in a plain room with a sender who has joined but
    // not yet spoken. The message is posted *live*, after B's client is up.
    const b = await seedLiveNotifyReader(request, hs, runId);

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

  test('mixed view shows both accounts’ rooms, badged, and opening one switches account', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}mx`;
    const userA = `mixed-a-${runId}`;
    const passA = `mixed-a-pass-${runId}`;
    const userB = `mixed-b-${runId}`;
    const passB = `mixed-b-pass-${runId}`;
    const roomA = `Room A ${runId}`;
    const roomB = `Room B ${runId}`;

    await registerUser(request, userA, passA);
    await registerUser(request, userB, passB);
    const a = await apiLogin(request, hs, userA, passA);
    const b = await apiLogin(request, hs, userB, passB);
    for (const [who, name] of [
      [a, roomA],
      [b, roomB],
    ] as const) {
      await request.post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: who.headers,
        data: { name, preset: 'private_chat' },
      });
    }

    // Sign in A, then add B (B becomes the active account) — both now signed in.
    await login(page, { available: true, hs, user: userA, pass: passA });
    await addAccountViaUi(page, hs, userB, passB);
    await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);

    // Recent is the default view. Only the active account (B) is shown until A is
    // ticked into the mix via the user panel's account picker.
    const roomARow = page.locator('.channel', { hasText: roomA });
    const roomBRow = page.locator('.channel', { hasText: roomB });
    await expect(roomBRow).toBeVisible({ timeout: 20_000 });
    await expect(roomARow).toHaveCount(0); // A's room is on the other account
    await mixInAccount(page, userA);

    // Now both accounts' rooms are listed, each carrying an account badge.
    await expect(roomARow).toBeVisible({ timeout: 20_000 });
    await expect(roomBRow).toBeVisible();
    await expect(
      roomARow.locator('[data-testid="account-badge"]'),
    ).toBeVisible();

    // Opening A's room switches the active account to A and opens it.
    await roomARow.click();
    await expect(page.locator('.userbar__handle')).toContainText(`@${userA}:`, {
      timeout: 20_000,
    });
    await expect(
      page.locator('trn-channel-sidebar .channel.active', { hasText: roomA }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('mixed view shows both accounts’ space pills, badged, and opening one switches account', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}sp`;
    const userA = `msp-a-${runId}`;
    const passA = `msp-a-pass-${runId}`;
    const userB = `msp-b-${runId}`;
    const passB = `msp-b-pass-${runId}`;
    const spaceA = `Space A ${runId}`;
    const spaceB = `Space B ${runId}`;

    await registerUser(request, userA, passA);
    await registerUser(request, userB, passB);
    const a = await apiLogin(request, hs, userA, passA);
    const b = await apiLogin(request, hs, userB, passB);
    // Each account creates a space (a room with creation_content.type: m.space).
    for (const [who, name] of [
      [a, spaceA],
      [b, spaceB],
    ] as const) {
      await request.post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: who.headers,
        data: {
          name,
          preset: 'private_chat',
          creation_content: { type: 'm.space' },
        },
      });
    }

    await login(page, { available: true, hs, user: userA, pass: passA });
    await addAccountViaUi(page, hs, userB, passB);
    await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);

    const railPill = (name: string) =>
      page.locator('trn-server-rail').getByRole('button', { name });

    // Only the active account (B) is mixed in by default, so only its pill is in the rail.
    await expect(railPill(spaceB)).toBeVisible({ timeout: 20_000 });
    await expect(railPill(spaceA)).toHaveCount(0);

    // Tick A into the mix → both accounts' space pills show, each badged.
    await mixInAccount(page, userA);
    await expect(railPill(spaceA)).toBeVisible({ timeout: 20_000 });
    await expect(
      railPill(spaceA).locator('[data-testid="account-badge"]'),
    ).toBeVisible();

    // Opening A's space switches the active account to A.
    await railPill(spaceA).click();
    await expect(page.locator('.userbar__handle')).toContainText(`@${userA}:`, {
      timeout: 20_000,
    });
  });
  // The picker's headline promises: the mix survives a restart, the account you're acting
  // as can't be dropped, and unticking really puts the view back to one account. Those are
  // all persisted/stateful behaviours that unit tests can only assert against a mock.
  test('the account mix persists across a reload, locks the active account, and can be turned off', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}pk`;
    const userA = `pick-a-${runId}`;
    const passA = `pick-a-pass-${runId}`;
    const userB = `pick-b-${runId}`;
    const passB = `pick-b-pass-${runId}`;
    const roomA = `Room A ${runId}`;
    const roomB = `Room B ${runId}`;

    await registerUser(request, userA, passA);
    await registerUser(request, userB, passB);
    const a = await apiLogin(request, hs, userA, passA);
    const b = await apiLogin(request, hs, userB, passB);
    for (const [who, name] of [
      [a, roomA],
      [b, roomB],
    ] as const) {
      await request.post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: who.headers,
        data: { name, preset: 'private_chat' },
      });
    }

    await login(page, { available: true, hs, user: userA, pass: passA });
    await addAccountViaUi(page, hs, userB, passB);
    await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);

    const roomARow = page.locator('.channel', { hasText: roomA });
    const roomBRow = page.locator('.channel', { hasText: roomB });
    await expect(roomBRow).toBeVisible({ timeout: 20_000 });

    await mixInAccount(page, userA);
    await expect(roomARow).toBeVisible({ timeout: 20_000 });
    // While mixing, the footer states the mix size and stacks the accounts' avatars.
    await expect(page.getByTestId('account-stack')).toBeVisible();
    await expect(page.getByTestId('account-stack-count')).toContainText(
      '2 accounts',
    );

    // The selection is persisted, so a cold reload comes back mixed rather than resetting.
    await page.reload();
    await expect(roomARow).toBeVisible({ timeout: 30_000 });
    await expect(roomBRow).toBeVisible();

    // The account being acted as is always shown: its picker row is present but disabled,
    // so it cannot be unticked.
    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('show-accounts').click();
    const activeRow = page.locator(`[data-testid^="show-account-@${userB}:"]`);
    await expect(activeRow).toHaveAttribute('aria-checked', 'true');
    await expect(activeRow).toHaveAttribute('data-disabled', '');

    // Unticking the other account returns the view to a single account.
    await page.locator(`[data-testid^="show-account-@${userA}:"]`).click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(roomARow).toHaveCount(0);
    await expect(roomBRow).toBeVisible();
    await expect(page.getByTestId('account-stack')).toHaveCount(0);
  });
  // The quick switcher shares the picker's scope, so it must find another account's rooms
  // and switch to that account on the jump — the same contract as clicking a sidebar row.
  // Issue #28. Below the md breakpoint a submenu has nowhere to fly out to — it would land
  // back on top of the account menu — so the picker is a dialog there instead. The suite runs
  // a single desktop project, so this test resizes rather than adding a whole project.
  test('narrow layout picks accounts in a dialog rather than a submenu', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}nrw`;
    const userA = `narrow-a-${runId}`;
    const passA = `narrow-a-pass-${runId}`;
    const userB = `narrow-b-${runId}`;
    const passB = `narrow-b-pass-${runId}`;
    const roomA = `Narrow A ${runId}`;

    await registerUser(request, userA, passA);
    await registerUser(request, userB, passB);
    const a = await apiLogin(request, hs, userA, passA);
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: a.headers,
      data: { name: roomA, preset: 'private_chat' },
    });

    await login(page, { available: true, hs, user: userA, pass: passA });
    await addAccountViaUi(page, hs, userB, passB);
    await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);

    // A phone-sized viewport. With no room open the sidebar is the full-screen page, so the
    // user panel is a bar across the bottom — the worst case for a flyout.
    await page.setViewportSize({ width: 390, height: 844 });

    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('show-accounts').click();

    // A dialog, not a submenu: the account menu is gone by now.
    const picker = page.getByTestId('account-picker');
    await expect(picker).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('user-menu-trigger')).toBeVisible();

    // The same row contract the desktop submenu carries.
    const activeRow = page.locator(`[data-testid^="show-account-@${userB}:"]`);
    await expect(activeRow).toHaveAttribute('aria-checked', 'true');
    await expect(activeRow).toHaveAttribute('data-disabled', '');

    // Ticking applies immediately and does NOT close the picker — it is a multi-select.
    const otherRow = page.locator(`[data-testid^="show-account-@${userA}:"]`);
    await otherRow.click();
    await expect(otherRow).toHaveAttribute('aria-checked', 'true');
    await expect(picker).toBeVisible();

    await page.getByTestId('account-picker-done').click();
    await expect(picker).toHaveCount(0);

    // The mix took effect: A's room is now listed alongside B's.
    await expect(page.locator('.channel', { hasText: roomA })).toBeVisible({
      timeout: 20_000,
    });
  });

  test('the quick switcher finds a mixed-in account’s room and switches to it', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}qs`;
    const userA = `qs-a-${runId}`;
    const passA = `qs-a-pass-${runId}`;
    const userB = `qs-b-${runId}`;
    const passB = `qs-b-pass-${runId}`;
    // A distinctive name so the switcher query cannot match anything else.
    const roomA = `Zephyr ${runId}`;

    await registerUser(request, userA, passA);
    await registerUser(request, userB, passB);
    const a = await apiLogin(request, hs, userA, passA);
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: a.headers,
      data: { name: roomA, preset: 'private_chat' },
    });

    await login(page, { available: true, hs, user: userA, pass: passA });
    await addAccountViaUi(page, hs, userB, passB);
    await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);
    await expect(page.locator('.channel', { hasText: roomA })).toHaveCount(0);

    // Not mixed yet: the switcher searches the active account only, so A's room is absent.
    await page.getByTestId('open-switcher').click();
    await page.getByTestId('switcher-input').fill('Zephyr');
    await expect(page.getByTestId('switcher-result')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Tick A in, and the same query now finds its room, badged with the owning account.
    await mixInAccount(page, userA);
    await page.getByTestId('open-switcher').click();
    await page.getByTestId('switcher-input').fill('Zephyr');
    const hit = page.getByTestId('switcher-result').filter({ hasText: roomA });
    await expect(hit).toBeVisible({ timeout: 20_000 });
    await expect(hit.locator('[data-testid="account-badge"]')).toBeVisible();

    // Jumping to it switches the active account to A and opens the room.
    await hit.click();
    await expect(page.locator('.userbar__handle')).toContainText(`@${userA}:`, {
      timeout: 20_000,
    });
    await expect(
      page.locator('trn-channel-sidebar .channel.active', { hasText: roomA }),
    ).toBeVisible({ timeout: 15_000 });
  });

  // Two things unit tests cannot reach: an invite addressed to an account you are only
  // SHOWING (it must be visible and answerable without switching), and the header chip that
  // names the identity you are acting as after a cross-account open.
  test('shows a mixed-in account’s invite and names the acting identity in the header', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}iv`;
    const userA = `inv-a-${runId}`;
    const passA = `inv-a-pass-${runId}`;
    const userB = `inv-b-${runId}`;
    const passB = `inv-b-pass-${runId}`;
    const host = `inv-h-${runId}`;
    const passH = `inv-h-pass-${runId}`;
    const roomA = `Room A ${runId}`;
    const invited = `Invited ${runId}`;

    await registerUser(request, userA, passA);
    await registerUser(request, userB, passB);
    await registerUser(request, host, passH);
    const a = await apiLogin(request, hs, userA, passA);
    const b = await apiLogin(request, hs, userB, passB);
    const h = await apiLogin(request, hs, host, passH);

    // Display names deliberately NOT substrings of the mxids. Every profile assertion in
    // this file used the localpart, which IS a substring of `@localpart:localhost` — so it
    // passed against an account whose profile never hydrated, which is exactly what the
    // account-profile projection exists to prevent.
    const nameA = `Alpha ${runId}`;
    const nameB = `Bravo ${runId}`;
    for (const [who, name] of [
      [a, nameA],
      [b, nameB],
    ] as const) {
      await request.put(
        `${hs}/_matrix/client/v3/profile/${encodeURIComponent(who.userId)}/displayname`,
        { headers: who.headers, data: { displayname: name } },
      );
    }

    // A owns a room (so the mixed list has something of A's), and a third party invites A
    // to another room — the invite therefore belongs to an account that will NOT be active.
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: a.headers,
      data: { name: roomA, preset: 'private_chat' },
    });
    // B needs a room of its own for its profile to reach the client at all: the SDK
    // hydrates `getUser()` from presence, and an account in no rooms receives none — so
    // without this the panel would show B's mxid however well the projection works, and
    // the assertion below would be testing the SDK rather than this code.
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: b.headers,
      data: { name: `Room B ${runId}`, preset: 'private_chat' },
    });
    const created = await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: h.headers,
      data: { name: invited, preset: 'private_chat' },
    });
    const invitedRoomId = (await created.json()).room_id as string;
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(invitedRoomId)}/invite`,
      { headers: h.headers, data: { user_id: `@${userA}:localhost` } },
    );

    await login(page, { available: true, hs, user: userA, pass: passA });
    // A's OWN profile, hydrated from its own sync. The client seeds its own user with a
    // plain `new User(id)` and no re-emitter, so nothing but the sync tick can deliver
    // this — without it the panel shows the raw mxid for the whole session.
    await expect(page.locator('.userbar__name')).toHaveText(nameA, {
      timeout: 20_000,
    });

    await addAccountViaUi(page, hs, userB, passB);
    await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);
    // B's profile arrives through B's OWN client — one listener per account, not one on
    // whichever account happens to be active.
    await expect(page.locator('.userbar__name')).toHaveText(nameB, {
      timeout: 20_000,
    });

    // Active account is B, so A's invite is invisible until A is mixed in.
    await expect(page.locator('.invite', { hasText: invited })).toHaveCount(0);

    await mixInAccount(page, userA);
    const inviteRow = page.locator('.invite', { hasText: invited });
    await expect(inviteRow).toBeVisible({ timeout: 20_000 });
    await expect(
      inviteRow.locator('[data-testid="account-badge"]'),
    ).toBeVisible();

    // Opening one of A's rooms switches the acting identity — and says so in the header.
    await page.locator('.channel', { hasText: roomA }).click();
    await expect(page.locator('.userbar__handle')).toContainText(`@${userA}:`, {
      timeout: 20_000,
    });
    const chip = page.getByTestId('active-account-chip');
    await expect(chip).toBeVisible();
    // Scoped to the name span (the chip also renders an avatar initial), and paired with a
    // negative: `toHaveText` alone still passes if the chip names the WRONG account, while
    // the `not.toContainText` is what rules out the mxid fallback.
    await expect(chip.locator('.title-account__name')).toHaveText(nameA, {
      timeout: 20_000,
    });
    await expect(chip).not.toContainText(`@${userA}:`);
  });
});
